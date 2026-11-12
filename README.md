# CCD Voice Automation: Inbound Utility Service

Inbound voice bot backend for CCD (Card & Consignment Delivery). It serves Twilio voice webhooks and the AutomationEdge workflow REST endpoints from one Node.js (Express) service, backed by PostgreSQL. A browser dashboard gives you a call simulator and live KPIs.

## Quick start

```bash
npm install
# 1. Put the real PostgreSQL password in .env (DB_PASSWORD and DATABASE_URL)
npm run db:init          # creates ccd_logistics_db, applies db/schema.sql + db/seed.sql
npm start                # prints the endpoint banner, serves http://localhost:8001/
npm run test:scenarios   # in a second terminal: runs all 13 test scenarios end to end
```

For real phone calls, expose the service over HTTPS (ngrok or the Nginx config in `nginx/ccd-voice.conf`). Set `BASE_URL` to that public origin, restart, and paste the banner URLs into Twilio:

| Twilio number setting      | URL                                   |
|----------------------------|---------------------------------------|
| A Call Comes In (POST)     | `{BASE_URL}/api/telephony/inbound-call` |
| Call Status Changes (POST) | `{BASE_URL}/api/telephony/status-callback` |

## Project layout

```
server.js                     Express app + startup banner
config/index.js               .env loader (single source of configuration)
routes/telephony.js           Twilio webhooks + make-call / call-status / terminate-call
routes/workflow.js            Workflow endpoints returning { ...data, twiml }
routes/dashboard.js           KPI + audit-log JSON for the dashboard
services/databaseService.js   pg Pool, parameterised queries, audit writes, analytics
services/conversationService.js  Call state machine shared by telephony + workflow routes
services/responseBuilder.js   Plain-language answers + masked JSON views
services/sessionManager.js    In-memory call sessions keyed by CallSid (TTL)
utils/twilioHelper.js         TwiML builder (Polly voice, barge-in Gather, Dial)
utils/speech.js               Intent detection, DTMF map, consignment/DOB parsing
utils/formatters.js           Date/time phrasing, masking helpers
public/                       Dashboard (index.html, dashboard.js, Chart.js)
db/schema.sql, db/seed.sql    DDL + UAT fixtures for the 13 scenarios
scripts/initDb.js             Database bootstrap
scripts/runScenarios.js       End-to-end scenario runner
nginx/ccd-voice.conf          Reverse proxy
```

## Call flow

| Stage | Caller input | Result |
|---|---|---|
| Inbound | ANI matches 1 active consignment | Welcome + main menu |
| Inbound | ANI matches 2+ | "Press 1 for … press 2 for …" (digit or speech, e.g. "the SIM") |
| Inbound | ANI unknown | Ask for consignment number (`CCD1008` or just `1008` on the keypad) or DOB `DDMMYYYY` |
| Main menu / follow-up | `1` / "status" | Current status |
| | `2` / "when will it arrive" | Expected delivery date |
| | `3` / "why wasn't it delivered" | Attempt history + next attempt + ID requirement |
| | `4` / "what documents do I need" | Next steps / photo ID |
| | `9` / "agent", "representative", "human" | Transfer (`<Dial timeout="25">`) |
| | "reschedule" | Transfer (reason `RESCHEDULE_REQUEST`) |
| | `0` / "no", "that's all" | Goodbye + `<Hangup>` (bot resolved) |

Escalation rules:
- 2 failed verifications → `2X_VERIFICATION_FAILURE`
- 2 unclear or low-confidence turns → `LOW_CONFIDENCE_OR_OUT_OF_SCOPE`
- 2 silent turns → `NO_INPUT_TWICE` (in the follow-up stage, 2 silences end the call politely instead)

If the agent line is busy or unanswered, `agent-dial-status` plays the "All agents are currently busy" message and hangs up.

## Test fixtures (db/seed.sql)

| # | Caller number | Expected |
|---|---|---|
| 1 | +919800000001 | Dispatched (HDFC credit card ••4821) |
| 2 | +919800000003 | In transit (Airtel SIM) |
| 3 | +919800000004 | Out for delivery (SBI debit card) |
| 4, 10 | +919800000002 | Delivery attempted: premises locked yesterday 2:30 PM |
| 5 | +919800000005 | Delivered |
| 6 | any unknown number | Enter `1008` / say "CCD 1008" |
| 7 | any unknown number | Enter `15081990` / say "15th August 1990" |
| 8 | +919800000006 | Two consignments: disambiguation |
| 9 | +919800000010 | Two failed attempts: history spoken |
| 11 | any recognised number | Press 9 |
| 12 | any unknown number | Two wrong entries → agent |
| 13 | any recognised number | Silence / gibberish / low confidence → reprompt → escalate |

Seed dates are relative to `CURRENT_DATE`. Re-run `npm run db:init` any day to refresh them.

## API documentation (Swagger)

- **Swagger UI:** `{BASE_URL}/api-docs`. It documents all 22 endpoints, with request and response schemas, examples and "Try it out". No login is needed. For the Dashboard endpoints, sign in to the dashboard in the same browser first.
- **OpenAPI 3 JSON:** `{BASE_URL}/api-docs.json`. Import it into Postman, AutomationEdge or any code generator.
- **Source:** `docs/openapi.js`. The server URL comes from `BASE_URL`.

## Postman collection

`postman/CCD Voice Automation.postman_collection.json` holds 35 requests with assertions, and `postman/CCD Voice - Local.postman_environment.json` is the matching environment. Import both into Postman (**Import → files**) and select the **CCD Voice - Local** environment.

Folders:
0. Health and dashboard login
1. Workflow APIs
2. Simulated Twilio webhooks (run these in order; they form one call)
3. Twilio REST call management
4. Dashboard APIs

Every value is a variable (`baseUrl`, `callerPhone`, `agentNumber`, `voice` …), so you can change it in the environment. Run the whole collection from the command line with:

```bash
npx newman run "postman/CCD Voice Automation.postman_collection.json" -e "postman/CCD Voice - Local.postman_environment.json"
```

## Workflow API examples

```bash
curl -X POST localhost:8001/api/workflow/validate-caller -H "Content-Type: application/json" \
  -d '{"callerPhone":"+919800000001","callSid":"CA123"}'
curl -X POST localhost:8001/api/workflow/verify-secondary -H "Content-Type: application/json" \
  -d '{"callSid":"CA123","identifier":"15081990","type":"DOB","attemptCount":1}'
curl -X POST localhost:8001/api/workflow/status -H "Content-Type: application/json" \
  -d '{"consignmentId":"CCD1001","intent":"EDD"}'
curl -X POST localhost:8001/api/workflow/exception -H "Content-Type: application/json" \
  -d '{"consignmentId":"CCD1002"}'
curl -X POST localhost:8001/api/workflow/agent-transfer -H "Content-Type: application/json" \
  -d '{"callSid":"CA123","callerPhone":"+919800000001","reason":"CUSTOMER_REQUEST"}'
```

When a workflow passes the live Twilio `callSid`, the service binds the consignment to that call's session, so the next `<Gather>` posted by Twilio continues the conversation.

### Call settings you can pass in any request

Every call setting can be passed in a workflow JSON body, in the `make-call` body, or in the query string of a Twilio webhook URL (`/api/telephony/inbound-call?voice=Polly.Aditi&agentNumber=%2B919876543210`). `.env` is only the fallback for fields you leave out. Settings passed with a `callSid` are remembered for that call, so later Twilio callbacks in the same call keep using them. Invalid values return `400` with the reason.

| Field (aliases) | Example | Used for |
|---|---|---|
| `voice` (`voiceName`) | `Polly.Kajal-Neural` | `<Say voice>` |
| `language` (`voiceLanguage`) | `en-IN` | `<Say language>` and speech recognition |
| `agentNumber` (`destination`, `liveAgentNumber`) | `+919876543210` or `sip:agent@pbx` | `<Dial>` target |
| `callerId` (`twilioPhoneNumber`) | `+1555…` | `<Dial callerId>` |
| `dialTimeout` | `25` (5-600) | `<Dial timeout>` |
| `gatherTimeout` / `verifyTimeout` | `4` / `6` (1-60) | Silence timeout for menu / verification |
| `confidenceThreshold` | `0.4` (0-1) | Speech below this counts as unclear |
| `deliveryWindow` | `10:00 AM and 6:00 PM` | Spoken delivery window |
| `baseUrl` | `https://xxxx.ngrok-free.app` | Host used in TwiML callback URLs |
| `menuActionUrl` / `verifyActionUrl` / `dialStatusUrl` | `https://ae.example.com/flow/menu` or `/api/...` | Where Twilio posts `<Gather>` / `<Dial>` results |

Request-specific fields:

- **validate-caller:** `callerPhone`, `callSid`
- **verify-secondary:** `callSid`, `identifier`, `type` (`CONSIGNMENT` / `DOB` / `AUTO`), `attemptCount`, `callerPhone`
- **status:** `consignmentId`, `intent` (`STATUS` / `EDD` / `EXCEPTION` / `ACTION`), `callSid`
- **exception:** `consignmentId`, `callSid`
- **agent-transfer:**
  - `callSid`, `callerPhone`
  - `reason`: any code; it's stored upper-case in the audit log
  - `message`: an optional announcement spoken before the transfer
- **make-call:**
  - `to` (required), `from`, `actionUrl`, `method`
  - `statusCallback`, `statusCallbackMethod`, `statusCallbackEvent[]`
  - `timeout` (ring time), `record`, `machineDetection`

Twilio account credentials (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`), database credentials and the dashboard login are always read from `.env`. They never go in a request body.

## Optional settings (.env)

| Key | Default | Purpose |
|---|---|---|
| `TWILIO_VALIDATE_SIGNATURE` | `false` | Reject webhooks without a valid `X-Twilio-Signature`. The dashboard simulator can't sign requests, so it stops working when this is on. |
| `SPEECH_CONFIDENCE_THRESHOLD` | `0.4` | Below this, speech counts as unclear |
| `GATHER_TIMEOUT_SECONDS` / `VERIFY_TIMEOUT_SECONDS` | `4` / `6` | Silence timeouts |
| `AGENT_DIAL_TIMEOUT_SECONDS` | `25` | `<Dial timeout>` |
| `DELIVERY_WINDOW` | `10:00 AM and 6:00 PM` | Spoken delivery window |
| `COST_PER_AGENT_CALL_INR` / `COST_PER_BOT_CALL_INR` | `45` / `6` | Cost-savings KPI |

## Compliance notes

- Spoken text and JSON only ever carry the last 4 digits of a card or SIM. DOB and the full customer phone number are never returned by the API.
- Each call upserts one row in `call_audit_logs`. Each turn appends to `call_events`, which records verification outcomes but never the digits entered.
- The dashboard masks caller numbers and requires sign-in at `/login.html` (`DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` in `.env`). A successful sign-in sets an HttpOnly session cookie, signed with `SECRET_KEY`, that lasts `DASHBOARD_SESSION_HOURS` (default 8). Five wrong passwords from one IP lock sign-in for 5 minutes. Sign out from the header or visit `/logout`. The login covers `/` and `/api/dashboard/*`. The Twilio webhooks, workflow endpoints and `/health` stay open because Twilio and AutomationEdge can't log in. Outside localhost, serve the dashboard over HTTPS (Nginx) so the cookie gets the `Secure` flag.

## Real-time dashboard

The dashboard shows only records stored in PostgreSQL, and updates the moment they change:

- Triggers in `db/app_extensions.sql` send a PostgreSQL `NOTIFY ccd_changes` on every insert, update, delete or truncate. They cover `call_audit_logs`, `call_events`, `consignments` and `delivery_attempts`, whichever program makes the change (the app, psql, pgAdmin, an ETL job…).
- The server keeps one `LISTEN` connection open and pushes each change to the browser over Server-Sent Events (`GET /api/dashboard/stream`). The page then reloads the KPIs, charts and logs, typically within half a second.
- If PostgreSQL is unreachable, the dashboard clears to "Database not connected" rather than showing stale numbers. The server reconnects automatically, and the dashboard repopulates by itself.
- If the live stream can't be used (for example, a proxy blocks it), the page falls back to polling every 5 seconds.

## Dashboard tabs

- **Home**: KPI cards, charts, the virtual phone and the latest 25 audit rows.
- **Logs**: the full `call_audit_logs` table, with search, date range, disposition and validation filters, and pagination. **Download CSV** exports every row that matches the current filters (up to 50,000), with caller numbers masked. The same export is available at `GET /api/dashboard/audit-logs/export.csv?q=&from=YYYY-MM-DD&to=YYYY-MM-DD&disposition=&validation=` when signed in.

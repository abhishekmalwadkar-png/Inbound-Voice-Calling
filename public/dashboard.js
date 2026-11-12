/* CCD Voice Console - simulator, KPIs, charts, logs */
(function () {
  'use strict';

  const REFRESH_MS = 5000;
  const HOME_PAGE_SIZE = 10;

  const INTENT_LABELS = {
    STATUS: 'Current status',
    EDD: 'Delivery date',
    EXCEPTION: 'Attempt history',
    ACTION: 'Next steps / ID',
    RESCHEDULE: 'Reschedule',
  };

  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const fmtInt = new Intl.NumberFormat('en-IN');
  const fmtInr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

  // ===========================================================================
  // Session handling
  // ===========================================================================

  function toLogin() {
    location.replace(`/login.html?next=${encodeURIComponent(location.pathname + location.hash)}`);
  }

  /** fetch wrapper for dashboard APIs: a 401 means the session expired. */
  async function apiFetch(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (res.status === 401) {
      toLogin();
      throw new Error('Session expired');
    }
    return res;
  }

  async function loadUser() {
    try {
      const res = await apiFetch('/api/auth/me');
      if (!res.ok) return;
      const { username } = await res.json();
      $('userName').textContent = username;
      $('userAvatar').textContent = username.charAt(0);
    } catch (e) {
      /* redirected */
    }
  }

  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } finally {
      location.replace('/login.html');
    }
  }

  // ===========================================================================
  // Virtual phone
  // ===========================================================================

  const call = { active: false, callSid: null, from: null, startedAt: 0, action: null, numDigits: null, awaiting: false, busy: false };
  let digitBuffer = '';

  function newCallSid() {
    const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    return `CASIM${hex.slice(0, 29)}`; // 34 chars like a real CallSid, never valid for the Twilio REST API
  }

  function addMessage(kind, text, who) {
    const box = $('transcript');
    if (!box) return;
    const el = document.createElement('div');
    el.className = `msg ${kind}`;
    if (who) {
      const w = document.createElement('span');
      w.className = 'who';
      w.textContent = who;
      el.appendChild(w);
    }
    el.appendChild(document.createTextNode(text));
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
  }

  function setState(html, short) {
    if ($('stateChip')) $('stateChip').innerHTML = html;
    if ($('phoneState')) $('phoneState').textContent = short || 'Idle';
  }

  function setControls() {
    if (!$('btnCall')) return;
    const canInput = call.active && call.awaiting && !call.busy;
    $('btnCall').disabled = call.active;
    $('btnHangup').disabled = !call.active;
    if ($('callerPhone')) $('callerPhone').disabled = call.active;
    if ($('speechInput')) $('speechInput').disabled = !canInput;
    if ($('btnSpeak')) $('btnSpeak').disabled = !canInput;
    if ($('btnSilence')) $('btnSilence').disabled = !canInput;
    if ($('btnSendDigits')) $('btnSendDigits').disabled = !canInput || !digitBuffer;
    if ($('btnClearDigits')) $('btnClearDigits').disabled = !digitBuffer;
    document.querySelectorAll('#dialpad button').forEach((b) => (b.disabled = !canInput));
  }

  function renderDigits() {
    $('digitBuffer').textContent = digitBuffer;
    setControls();
  }

  // --- Speech synthesis (barge-in demo) -------------------------------------
  let speaking = false;
  function speak(text) {
    if (!$('optVoice').checked || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-IN';
    u.rate = 1.05;
    u.onstart = () => (speaking = true);
    u.onend = () => (speaking = window.speechSynthesis.speaking);
    window.speechSynthesis.speak(u);
  }
  function bargeIn() {
    if ('speechSynthesis' in window && (speaking || window.speechSynthesis.speaking)) {
      window.speechSynthesis.cancel();
      speaking = false;
      addMessage('sys', 'Caller interrupted the prompt (barge-in)');
    }
  }

  // --- Webhook transport -----------------------------------------------------
  function pathOf(url) {
    try {
      const u = new URL(url, window.location.origin);
      return u.pathname + u.search;
    } catch (e) {
      return url;
    }
  }

  async function postForm(path, fields) {
    const body = new URLSearchParams();
    Object.entries(fields).forEach(([k, v]) => {
      if (v !== undefined && v !== null) body.append(k, v);
    });
    const res = await fetch(pathOf(path), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const text = await res.text();
    if (!res.ok && !text.trim().startsWith('<')) throw new Error(`${res.status} ${text.slice(0, 160)}`);
    return text;
  }

  function baseFields() {
    return { CallSid: call.callSid, AccountSid: 'ACSIMULATOR', From: call.from, To: 'CCD-HELPLINE', Direction: 'inbound', CallStatus: 'in-progress' };
  }

  // --- TwiML interpreter -----------------------------------------------------
  async function runTwiml(xml) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const root = doc.documentElement;
    if (!root || root.nodeName !== 'Response') {
      addMessage('sys', 'Unexpected response from server');
      return endCall(false);
    }
    call.awaiting = false;

    for (const node of Array.from(root.children)) {
      switch (node.nodeName) {
        case 'Say':
          addMessage('bot', node.textContent, 'Bot');
          speak(node.textContent);
          break;
        case 'Gather': {
          Array.from(node.children).forEach((child) => {
            if (child.nodeName === 'Say') {
              addMessage('bot', child.textContent, 'Bot');
              speak(child.textContent);
            }
          });
          call.action = node.getAttribute('action');
          call.numDigits = node.getAttribute('numDigits') ? parseInt(node.getAttribute('numDigits'), 10) : null;
          call.awaiting = true;
          const endpoint = pathOf(call.action).replace('/api/telephony/', '');
          const keyMode = call.numDigits ? `${call.numDigits} key` : 'digits + #';
          setState(`Listening &middot; <strong>${endpoint}</strong> &middot; speech or ${keyMode} &middot; barge-in on`, 'Listening');
          setControls();
          return;
        }
        case 'Dial': {
          const target = node.textContent.trim();
          const action = node.getAttribute('action');
          const outcome = $('optAgentOutcome').value;
          addMessage('sys', `Dialing live agent ${target} (timeout ${node.getAttribute('timeout') || 30}s)…`);
          setState('Transferring to live agent…', 'Transferring');
          call.busy = true;
          setControls();
          await new Promise((r) => setTimeout(r, 1200));
          addMessage('sys', outcome === 'completed' ? 'Agent answered. Conversation continues with a human.' : `Agent line result: ${outcome}`);
          call.busy = false;
          if (action) {
            const next = await postForm(action, { ...baseFields(), DialCallStatus: outcome, DialCallDuration: outcome === 'completed' ? '45' : '0' });
            return runTwiml(next);
          }
          return endCall(true);
        }
        case 'Redirect':
          return runTwiml(await postForm(node.textContent.trim(), baseFields()));
        case 'Hangup':
          return endCall(true);
        default:
          break;
      }
    }
    // No Gather / Hangup: Twilio ends the call when the document runs out.
    return endCall(true);
  }

  async function sendInput(fields, display) {
    if (!call.active || !call.awaiting || call.busy) return;
    bargeIn();
    if (display) addMessage('user', display, 'Caller');
    call.awaiting = false;
    call.busy = true;
    setControls();
    try {
      const xml = await postForm(call.action, { ...baseFields(), ...fields });
      call.busy = false;
      await runTwiml(xml);
    } catch (err) {
      call.busy = false;
      addMessage('sys', `Request failed: ${err.message}`);
      endCall(false);
    }
  }

  async function startCall() {
    const from = $('callerPhone').value.trim();
    if (!/^\+?\d{10,15}$/.test(from)) {
      addMessage('sys', 'Enter the caller number in E.164 format, e.g. +91XXXXXXXXXX');
      return;
    }
    $('transcript').innerHTML = '';
    Object.assign(call, { active: true, callSid: newCallSid(), from, startedAt: Date.now(), action: null, awaiting: false, busy: true });
    digitBuffer = '';
    renderDigits();
    addMessage('sys', `Incoming call from ${from} · ${call.callSid}`);
    setState('Ringing…', 'Ringing');
    try {
      const xml = await postForm('/api/telephony/inbound-call', { ...baseFields(), CallStatus: 'ringing' });
      call.busy = false;
      await runTwiml(xml);
    } catch (err) {
      call.busy = false;
      addMessage('sys', `Could not reach the inbound-call webhook: ${err.message}`);
      endCall(false);
    }
    refresh();
  }

  async function endCall(notify) {
    if (!call.active) return;
    const duration = Math.round((Date.now() - call.startedAt) / 1000);
    const sid = call.callSid;
    Object.assign(call, { active: false, awaiting: false, busy: false, action: null });
    digitBuffer = '';
    renderDigits();
    addMessage('sys', `Call ended · ${duration}s`);
    setState('Idle', 'Idle');
    if (notify && sid) {
      try {
        await postForm('/api/telephony/status-callback', { CallSid: sid, From: call.from, CallStatus: 'completed', CallDuration: String(duration), Direction: 'inbound' });
      } catch (e) {
        /* status callback is best-effort */
      }
    }
    refresh();
  }

  function pressKey(key) {
    bargeIn();
    if (key === '#') return flushDigits();
    digitBuffer += key;
    renderDigits();
    if (call.numDigits && digitBuffer.length >= call.numDigits) flushDigits();
  }

  function flushDigits() {
    if (!digitBuffer) return;
    const digits = digitBuffer;
    digitBuffer = '';
    renderDigits();
    sendInput({ Digits: digits }, `Pressed ${digits.split('').join(' ')}`);
  }

  function sendSpeech() {
    const text = $('speechInput').value.trim();
    if (!text) return;
    $('speechInput').value = '';
    const low = $('optLowConfidence').checked;
    sendInput({ SpeechResult: text, Confidence: low ? '0.20' : '0.92' }, low ? `"${text}" (low confidence)` : `"${text}"`);
  }

  function buildPhone() {
    const pad = $('dialpad');
    if (!pad) return;
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].forEach((key) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = key;
      b.addEventListener('click', () => pressKey(key));
      pad.appendChild(b);
    });

    $('btnCall').addEventListener('click', startCall);
    $('btnHangup').addEventListener('click', () => {
      bargeIn();
      addMessage('sys', 'Caller hung up');
      endCall(true);
    });
    $('btnSpeak').addEventListener('click', sendSpeech);
    $('speechInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendSpeech();
      else if (e.key.length === 1) bargeIn();
    });
    $('btnSilence').addEventListener('click', () => sendInput({}, '(silence)'));
    $('btnSendDigits').addEventListener('click', () => flushDigits());
    $('btnClearDigits').addEventListener('click', () => {
      digitBuffer = '';
      renderDigits();
    });
    setControls();
  }

  // ===========================================================================
  // Shared table helpers
  // ===========================================================================

  function cell(text, cls) {
    const td = document.createElement('td');
    td.textContent = text === null || text === undefined || text === '' ? '–' : text;
    if (cls) td.className = cls;
    if (td.textContent === '–' && !cls) td.className = 'muted';
    return td;
  }

  function emptyRow(body, cols, message) {
    body.innerHTML = '';
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    const td = document.createElement('td');
    td.colSpan = cols;
    td.textContent = message;
    tr.appendChild(td);
    body.appendChild(tr);
  }

  const DISPOSITIONS = {
    BOT_RESOLVED: ['resolved', 'Bot resolved'],
    CALLER_ENDED: ['resolved', 'Caller ended'],
    AGENT_TRANSFERRED: ['transferred', 'Agent transferred'],
    AGENT_UNAVAILABLE: ['transferred', 'Agent unavailable'],
    ABANDONED: ['abandoned', 'Abandoned'],
    IN_PROGRESS: ['progress', 'In progress'],
  };

  function dispositionCell(d) {
    const [cls, label] = DISPOSITIONS[d] || ['progress', d || '–'];
    const td = document.createElement('td');
    const span = document.createElement('span');
    span.className = `badge ${cls}`;
    span.textContent = label;
    td.appendChild(span);
    return td;
  }

  const VERIFY_META = {
    VERIFIED: ['\u2713', 'Verified'],
    NOT_VERIFIED: ['\u2715', 'Not verified'],
    PENDING: ['\u2026', 'Pending'],
  };

  /** Verification badge cell; optionally shows how many ID attempts were made. */
  function verificationCell(status, attempts, { showAttempts = false } = {}) {
    const td = document.createElement('td');
    if (!status) {
      td.textContent = '\u2013';
      td.className = 'muted';
      return td;
    }
    const [icon, label] = VERIFY_META[status] || ['', status];
    const span = document.createElement('span');
    span.className = `verify ${status}`;
    span.innerHTML = '<span class="ico" aria-hidden="true"></span><span class="lbl"></span>';
    span.querySelector('.ico').textContent = icon;
    span.querySelector('.lbl').textContent = label;
    td.appendChild(span);
    if (showAttempts && attempts) {
      const small = document.createElement('span');
      small.className = 'verify-attempts';
      small.textContent = `${attempts} ID attempt${attempts === 1 ? '' : 's'}`;
      td.appendChild(small);
    }
    return td;
  }

  function formatTime(ts) {
    if (!ts) return '–';
    const m = String(ts).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : String(ts);
  }

  function duration(s) {
    return s === null || s === undefined ? '–' : `${s}s`;
  }

  /**
   * Numbered pager: « ‹ 1 … 4 5 6 … 20 › »
   * @param {HTMLElement} nav container
   * @param {{total:number, limit:number, offset:number}} page
   * @param {(offset:number)=>void} go
   */
  function renderPager(nav, page, go) {
    nav.innerHTML = '';
    const pages = Math.max(1, Math.ceil(page.total / page.limit));
    const current = Math.floor(page.offset / page.limit) + 1;

    const add = (label, target, opts = {}) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = label;
      if (opts.title) b.title = opts.title;
      if (opts.current) b.setAttribute('aria-current', 'page');
      b.disabled = Boolean(opts.disabled);
      if (!opts.disabled && !opts.current) b.addEventListener('click', () => go((target - 1) * page.limit));
      nav.appendChild(b);
    };
    const gap = () => {
      const s = document.createElement('span');
      s.className = 'gap';
      s.textContent = '…';
      nav.appendChild(s);
    };

    add('&laquo;', 1, { disabled: current === 1, title: 'First page' });
    add('&lsaquo;', current - 1, { disabled: current === 1, title: 'Previous page' });

    const windowSize = 1;
    const shown = new Set([1, pages]);
    for (let p = current - windowSize; p <= current + windowSize; p++) if (p >= 1 && p <= pages) shown.add(p);
    if (current <= 3) [2, 3].forEach((p) => p <= pages && shown.add(p));
    if (current >= pages - 2) [pages - 1, pages - 2].forEach((p) => p >= 1 && shown.add(p));
    let last = 0;
    [...shown].sort((a, b) => a - b).forEach((p) => {
      if (p - last > 1) gap();
      add(String(p), p, { current: p === current });
      last = p;
    });

    add('&rsaquo;', current + 1, { disabled: current >= pages, title: 'Next page' });
    add('&raquo;', pages, { disabled: current >= pages, title: 'Last page' });
  }

  function summary(page, rowsOnPage, noun) {
    if (!page.total) return `No ${noun}`;
    const first = page.offset + 1;
    const last = page.offset + rowsOnPage;
    return `Showing ${fmtInt.format(first)}–${fmtInt.format(last)} of ${fmtInt.format(page.total)} ${noun}`;
  }

  // ===========================================================================
  // Home: KPIs, charts, live audit log
  // ===========================================================================

  const charts = {};
  const home = { offset: 0 };

  function chartTheme() {
    return {
      surface: css('--surface'),
      text: css('--text-2'),
      muted: css('--muted'),
      grid: css('--border'),
      series: [css('--series-1'), css('--series-2'), css('--series-3'), css('--series-4'), css('--series-5')],
      neutral: css('--neutral-mark'),
      ink: css('--text'),
    };
  }

  function baseOptions(t) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 700, easing: 'easeOutQuart' },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: t.text, boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 3, padding: 14, font: { size: 12, weight: '500' } },
        },
        tooltip: {
          backgroundColor: '#ffffff',
          titleColor: t.ink,
          bodyColor: t.text,
          borderColor: css('--orange-200'),
          borderWidth: 1,
          padding: 10,
          cornerRadius: 10,
          boxPadding: 5,
          titleFont: { weight: '700' },
        },
      },
    };
  }

  function initCharts() {
    if (typeof window.Chart === 'undefined') {
      ['emptyResolution', 'emptyIntents', 'emptyStatus'].forEach((id) => {
        $(id).lastChild.textContent = 'Chart library could not load (offline?). KPIs and logs still update.';
        $(id).classList.add('show');
      });
      return;
    }
    const t = chartTheme();
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.color = t.text;

    charts.resolution = new Chart($('chartResolution'), {
      type: 'doughnut',
      data: {
        labels: ['Bot resolved', 'Agent transferred', 'Abandoned', 'In progress'],
        datasets: [{ data: [0, 0, 0, 0], backgroundColor: [t.series[0], t.series[1], t.series[2], t.neutral], borderColor: t.surface, borderWidth: 3, hoverOffset: 10, borderRadius: 4 }],
      },
      options: { ...baseOptions(t), cutout: '64%' },
    });

    charts.intents = new Chart($('chartIntents'), {
      type: 'bar',
      data: {
        labels: [],
        datasets: [{
          label: 'Questions', data: [], backgroundColor: t.series[0], hoverBackgroundColor: css('--orange-700'),
          borderRadius: 6, borderSkipped: 'start', maxBarThickness: 24,
        }],
      },
      options: {
        ...baseOptions(t),
        indexAxis: 'y',
        plugins: { ...baseOptions(t).plugins, legend: { display: false } },
        scales: {
          x: { beginAtZero: true, ticks: { precision: 0, color: t.muted }, grid: { color: t.grid }, border: { display: false } },
          y: { ticks: { color: t.text, font: { weight: '500' } }, grid: { display: false }, border: { color: t.grid } },
        },
      },
    });

    charts.status = new Chart($('chartStatus'), {
      type: 'pie',
      data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderColor: t.surface, borderWidth: 3, hoverOffset: 10 }] },
      options: baseOptions(t),
    });
  }

  const STATUS_ORDER = ['DISPATCHED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERY_ATTEMPTED', 'DELIVERED'];

  function updateCharts(data) {
    if (!charts.resolution) return;
    const t = chartTheme();

    const r = data.resolution;
    const resValues = [r.botResolved, r.agentTransferred, r.abandoned, r.inProgress];
    charts.resolution.data.datasets[0].data = resValues;
    charts.resolution.update();
    $('emptyResolution').classList.toggle('show', resValues.every((v) => !v));

    // Sorted largest first so the bars read top-down.
    const intents = [...data.intents].sort((a, b) => b.count - a.count);
    charts.intents.data.labels = intents.map((i) => INTENT_LABELS[i.intent] || i.intent);
    charts.intents.data.datasets[0].data = intents.map((i) => i.count);
    charts.intents.update();
    $('emptyIntents').classList.toggle('show', intents.length === 0);

    // Lifecycle order; colour follows the status, not its rank.
    const statuses = [...data.consignmentStatuses].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
    charts.status.data.labels = statuses.map((s) => `${s.label} (${s.count})`);
    charts.status.data.datasets[0].data = statuses.map((s) => s.count);
    charts.status.data.datasets[0].backgroundColor = statuses.map((s) => {
      const idx = STATUS_ORDER.indexOf(s.status);
      return idx >= 0 ? t.series[idx] : t.neutral;
    });
    charts.status.update();
    $('emptyStatus').classList.toggle('show', statuses.length === 0);
  }

  // Smoothly count KPI numbers up to their new value.
  function animateValue(el, target, format) {
    const prev = Number(el.dataset.value || 0);
    el.dataset.value = String(target);
    if (prev === target || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.textContent = format(target);
      return;
    }
    const start = performance.now();
    const dur = 600;
    const step = (now) => {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = format(prev + (target - prev) * eased);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function updateKpis(k) {
    const pct = (v) => `${(Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '')}%`;
    if (k.completedCalls) animateValue($('kpiContainment'), k.containmentRate, pct);
    else $('kpiContainment').textContent = '–';
    animateValue($('kpiTotal'), k.totalCalls, (v) => fmtInt.format(Math.round(v)));
    $('kpiTotalSub').textContent = `${fmtInt.format(k.completedCalls)} completed · ${fmtInt.format(k.activeCalls)} live`;
    if (k.averageHandlingTimeSeconds) animateValue($('kpiAht'), k.averageHandlingTimeSeconds, (v) => `${Math.round(v)}s`);
    else $('kpiAht').textContent = '–';
    if (k.totalCalls) animateValue($('kpiValidation'), k.validationAccuracy, pct);
    else $('kpiValidation').textContent = '–';
    $('kpiValidationSub').textContent = k.totalCalls
      ? `${fmtInt.format(k.verifiedCalls || 0)} verified \u00b7 ${fmtInt.format(k.notVerifiedCalls || 0)} not verified`
      : 'Callers verified successfully';
    if (k.completedCalls) animateValue($('kpiEscalation'), k.escalationRate, pct);
    else $('kpiEscalation').textContent = '–';
    animateValue($('kpiSavings'), k.estimatedCostSavingsInr, (v) => fmtInr.format(Math.round(v)));
    const a = k.costAssumptions;
    $('kpiSavingsSub').textContent = `₹${a.costPerAgentCallInr} agent vs ₹${a.costPerBotCallInr} bot per call`;
  }

  function renderHomeAudit(page) {
    const body = $('auditBody');
    if (!page.rows.length) {
      emptyRow(body, 7, 'No calls logged yet. Place a call from the virtual phone.');
    } else {
      body.innerHTML = '';
      page.rows.forEach((r) => {
        const tr = document.createElement('tr');
        tr.title = `Call SID ${r.callSid}${r.escalationReason ? ` · ${r.escalationReason}` : ''}`;
        tr.appendChild(cell(formatTime(r.updatedAt || r.createdAt)));
        tr.appendChild(cell(r.callerPhone));
        tr.appendChild(verificationCell(r.verificationStatus, r.verificationAttempts));
        tr.appendChild(cell(r.consignmentId));
        tr.appendChild(cell(r.intentDetected));
        tr.appendChild(cell(duration(r.durationSeconds)));
        tr.appendChild(dispositionCell(r.disposition));
        body.appendChild(tr);
      });
    }
    $('auditSummary').textContent = summary(page, page.rows.length, 'calls');
    renderPager($('auditPager'), page, (offset) => {
      home.offset = offset;
      loadHomeAudit();
    });
  }

  async function loadHomeAudit() {
    const res = await apiFetch(`/api/dashboard/audit-logs?limit=${HOME_PAGE_SIZE}&offset=${home.offset}`);
    if (res.ok) renderHomeAudit(await res.json());
  }

  // ===========================================================================
  // Logs tab: filters, sorting, pagination, CSV
  // ===========================================================================

  const logs = { offset: 0, total: 0, sort: 'updatedAt', dir: 'desc', loading: false };

  function logFilters() {
    const params = new URLSearchParams();
    const add = (key, value) => value && params.set(key, value);
    add('q', $('fSearch').value.trim());
    add('from', $('fFrom').value);
    add('to', $('fTo').value);
    add('disposition', $('fDisposition').value);
    add('validation', $('fValidation').value);
    add('verification', $('fVerification').value);
    params.set('sort', logs.sort);
    params.set('dir', logs.dir);
    return params;
  }

  function renderSortHeaders() {
    document.querySelectorAll('#logsHead th.sortable').forEach((th) => {
      const active = th.dataset.sort === logs.sort;
      th.setAttribute('aria-sort', active ? (logs.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    });
  }

  function renderLogs(page) {
    const body = $('logsBody');
    if (!page.rows.length) {
      emptyRow(body, 11, 'No calls match these filters.');
    } else {
      body.innerHTML = '';
      page.rows.forEach((r) => {
        const tr = document.createElement('tr');
        tr.appendChild(cell(formatTime(r.createdAt)));
        tr.appendChild(cell(formatTime(r.updatedAt)));
        tr.appendChild(cell(r.callSid, 'mono'));
        tr.appendChild(cell(r.callerPhone));
        tr.appendChild(verificationCell(r.verificationStatus, r.verificationAttempts, { showAttempts: true }));
        tr.appendChild(cell(r.consignmentId));
        tr.appendChild(cell(r.validationMethod));
        tr.appendChild(cell(r.intentDetected));
        tr.appendChild(cell(duration(r.durationSeconds)));
        tr.appendChild(dispositionCell(r.disposition));
        tr.appendChild(cell(r.escalationReason));
        body.appendChild(tr);
      });
    }
    logs.total = page.total;
    $('logsSummary').textContent = summary(page, page.rows.length, 'calls');
    $('btnDownloadCsv').disabled = page.total === 0;
    renderPager($('logsPager'), page, (offset) => {
      logs.offset = offset;
      loadLogs();
    });
  }

  async function loadLogs() {
    if (logs.loading) return;
    logs.loading = true;
    const params = logFilters();
    params.set('limit', $('pageSize').value);
    params.set('offset', String(logs.offset));
    try {
      const res = await apiFetch(`/api/dashboard/audit-logs?${params}`);
      if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
      const page = await res.json();
      // If filters shrank the result set past the current page, jump back to the last page.
      if (page.total && page.offset >= page.total) {
        logs.offset = Math.floor((page.total - 1) / page.limit) * page.limit;
        logs.loading = false;
        return loadLogs();
      }
      renderLogs(page);
    } catch (err) {
      if (err.message !== 'Session expired') {
        emptyRow($('logsBody'), 11, `Could not load logs: ${err.message}`);
        $('logsSummary').textContent = ' ';
        $('logsPager').innerHTML = '';
      }
    } finally {
      logs.loading = false;
    }
  }

  async function downloadCsv() {
    const btn = $('btnDownloadCsv');
    btn.disabled = true;
    try {
      const res = await apiFetch(`/api/dashboard/audit-logs/export.csv?${logFilters()}`);
      if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
      const blob = await res.blob();
      const match = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = match ? match[1] : 'ccd-call-audit.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (err) {
      if (err.message !== 'Session expired') alert(`CSV download failed: ${err.message}`);
    } finally {
      btn.disabled = logs.total === 0;
    }
  }

  function wireLogs() {
    $('btnDownloadCsv').addEventListener('click', downloadCsv);
    $('logFilters').addEventListener('submit', (e) => {
      e.preventDefault();
      logs.offset = 0;
      loadLogs();
    });
    $('btnResetFilters').addEventListener('click', () => {
      $('logFilters').reset();
      logs.offset = 0;
      logs.sort = 'updatedAt';
      logs.dir = 'desc';
      renderSortHeaders();
      loadLogs();
    });
    $('pageSize').addEventListener('change', () => {
      logs.offset = 0;
      loadLogs();
    });
    document.querySelectorAll('#logsHead th.sortable').forEach((th) => {
      th.tabIndex = 0;
      const toggle = () => {
        if (logs.sort === th.dataset.sort) logs.dir = logs.dir === 'asc' ? 'desc' : 'asc';
        else {
          logs.sort = th.dataset.sort;
          logs.dir = /At$|duration/.test(th.dataset.sort) ? 'desc' : 'asc';
        }
        logs.offset = 0;
        renderSortHeaders();
        loadLogs();
      };
      th.addEventListener('click', toggle);
      th.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
    });
    renderSortHeaders();
  }

  // ===========================================================================
  // Tabs + refresh loop
  // ===========================================================================

  // ===========================================================================
  // Deliveries tab: status tiles, filters, sorting, pagination, detail drawer, CSV
  // ===========================================================================

  const STATUS_META = [
    ['DISPATCHED', 'Dispatched', 'Left the hub'],
    ['IN_TRANSIT', 'In Transit', 'Moving through network'],
    ['OUT_FOR_DELIVERY', 'Out for Delivery', 'With delivery agent'],
    ['DELIVERY_ATTEMPTED', 'Delivery Attempted', 'Needs another attempt'],
    ['DELIVERED', 'Delivered', 'Handed to customer'],
  ];
  const ICON_CARD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>';
  const ICON_SIM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><rect x="8" y="11" width="8" height="7" rx="1"/></svg>';

  // This view is scoped to SIM card consignments only.
  const DELIVERY_KIND = 'SIM';
  const deliveries = { offset: 0, total: 0, sort: 'status', dir: 'asc', loading: false, openId: null };

  function deliveryFilters({ includeStatus = true } = {}) {
    const params = new URLSearchParams();
    const add = (key, value) => value && params.set(key, value);
    add('q', $('dSearch').value.trim());
    add('issuer', $('dIssuer').value);
    if (includeStatus) add('status', $('dStatus').value);
    params.set('kind', DELIVERY_KIND);
    params.set('active', $('dActive').value);
    params.set('sort', deliveries.sort);
    params.set('dir', deliveries.dir);
    return params;
  }

  function formatDate(value) {
    if (!value) return '–';
    const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return String(value);
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    const today = new Date();
    const diff = Math.round((d - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
    const label = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    if (diff === 0) return `Today · ${label}`;
    if (diff === 1) return `Tomorrow · ${label}`;
    if (diff === -1) return `Yesterday · ${label}`;
    return label;
  }

  function statusBadge(status, label) {
    const span = document.createElement('span');
    span.className = `status-badge ${status}`;
    span.textContent = label || status;
    return span;
  }

  function renderStatusTiles(summary) {
    const active = $('dStatus').value;
    const wrap = $('statusTiles');
    wrap.innerHTML = '';
    const tiles = [['ALL', 'All SIM cards', 'Matching current filters', summary.total], ...STATUS_META.map(([s, l, sub]) => [s, l, sub, (summary.statuses.find((x) => x.status === s) || {}).count || 0])];
    tiles.forEach(([status, label, sub, count], i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `status-tile float st-${status}`;
      b.setAttribute('aria-pressed', String((status === 'ALL' && !active) || status === active));
      b.innerHTML = `<span class="st-label"><span class="st-dot"></span></span><span class="st-count"></span><span class="st-sub"></span>`;
      b.querySelector('.st-label').append(label);
      b.querySelector('.st-count').textContent = fmtInt.format(count);
      b.querySelector('.st-sub').textContent = sub;
      b.style.animationDelay = `${i * 0.04}s`;
      b.addEventListener('click', () => {
        $('dStatus').value = status === 'ALL' ? '' : status;
        deliveries.offset = 0;
        loadDeliveries();
      });
      wrap.appendChild(b);
    });

    // Keep the issuer dropdown in sync with what is in the database.
    const sel = $('dIssuer');
    const current = sel.value;
    const existing = [...sel.options].slice(1).map((o) => o.value).join('|');
    if (existing !== summary.issuers.join('|')) {
      sel.length = 1;
      summary.issuers.forEach((name) => sel.add(new Option(name, name)));
      sel.value = summary.issuers.includes(current) ? current : '';
    }
  }

  function renderDeliveries(page) {
    const body = $('deliveriesBody');
    if (!page.rows.length) {
      emptyRow(body, 10, 'No SIM consignments match these filters.');
    } else {
      body.innerHTML = '';
      page.rows.forEach((r) => {
        const tr = document.createElement('tr');
        tr.className = 'clickable';
        tr.tabIndex = 0;
        tr.title = 'Open attempt history and calls';
        tr.addEventListener('click', () => openDrawer(r.consignmentId));
        tr.addEventListener('keydown', (e) => e.key === 'Enter' && openDrawer(r.consignmentId));

        const idCell = cell(r.consignmentId, 'mono');
        if (!r.isActive) {
          const tag = document.createElement('span');
          tag.className = 'inactive-tag';
          tag.textContent = 'INACTIVE';
          idCell.appendChild(tag);
        }
        tr.appendChild(idCell);

        const item = document.createElement('td');
        item.innerHTML = `<div class="item-cell"><span class="item-icon">${r.itemKind === 'SIM' ? ICON_SIM : ICON_CARD}</span><div><strong></strong><span></span></div></div>`;
        item.querySelector('strong').textContent = r.issuer;
        item.querySelector('div > div > span').textContent = `${r.itemLabel} · •••• ${r.last4}`;
        tr.appendChild(item);

        tr.appendChild(cell(r.customerPhone));
        const st = document.createElement('td');
        st.appendChild(statusBadge(r.status, r.statusLabel));
        tr.appendChild(st);
        tr.appendChild(cell(formatDate(r.expectedDeliveryDate)));
        tr.appendChild(cell(r.lastLocation));
        tr.appendChild(cell(r.attemptCount ? String(r.attemptCount) : '0'));
        tr.appendChild(cell(r.lastAttemptAt ? formatTime(r.lastAttemptAt) : null));
        const reason = r.lastFailureReason ? r.lastFailureReason.charAt(0).toUpperCase() + r.lastFailureReason.slice(1) : null;
        const fail = cell(reason, 'fail-text');
        if (!r.lastFailureReason) fail.className = 'muted';
        if (r.lastFailureReason) fail.title = r.lastFailureReason;
        tr.appendChild(fail);
        tr.appendChild(cell(r.status === 'DELIVERED' ? null : r.nextAttemptDate ? formatDate(r.nextAttemptDate) : null));
        body.appendChild(tr);
      });
    }
    deliveries.total = page.total;
    $('deliveriesSummary').textContent = summary(page, page.rows.length, 'SIM consignments');
    $('btnDeliveriesCsv').disabled = page.total === 0;
    renderPager($('deliveriesPager'), page, (offset) => {
      deliveries.offset = offset;
      loadDeliveries();
    });
  }

  function renderDeliverySortHeaders() {
    document.querySelectorAll('#deliveriesHead th.sortable').forEach((th) => {
      const isActive = th.dataset.sort === deliveries.sort;
      th.setAttribute('aria-sort', isActive ? (deliveries.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    });
  }

  async function loadDeliveries() {
    if (deliveries.loading) return;
    deliveries.loading = true;
    const params = deliveryFilters();
    params.set('limit', $('deliveriesPageSize').value);
    params.set('offset', String(deliveries.offset));
    try {
      const [listRes, sumRes] = await Promise.all([
        apiFetch(`/api/dashboard/consignments?${params}`),
        apiFetch(`/api/dashboard/consignments/summary?${deliveryFilters({ includeStatus: false })}`),
      ]);
      if (!listRes.ok) throw new Error((await listRes.json()).detail || listRes.statusText);
      if (!sumRes.ok) throw new Error((await sumRes.json()).detail || sumRes.statusText);
      const page = await listRes.json();
      if (page.total && page.offset >= page.total) {
        deliveries.offset = Math.floor((page.total - 1) / page.limit) * page.limit;
        deliveries.loading = false;
        return loadDeliveries();
      }
      renderStatusTiles(await sumRes.json());
      renderDeliveries(page);
      if (deliveries.openId) openDrawer(deliveries.openId, { quiet: true });
    } catch (err) {
      if (err.message === 'Session expired') return;
      throw err;
    } finally {
      deliveries.loading = false;
    }
  }

  async function downloadDeliveriesCsv() {
    const btn = $('btnDeliveriesCsv');
    btn.disabled = true;
    try {
      const res = await apiFetch(`/api/dashboard/consignments/export.csv?${deliveryFilters()}`);
      if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
      const blob = await res.blob();
      const match = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = match ? match[1] : 'ccd-sim-deliveries.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (err) {
      if (err.message !== 'Session expired') alert(`CSV download failed: ${err.message}`);
    } finally {
      btn.disabled = deliveries.total === 0;
    }
  }

  // --- Detail drawer ---------------------------------------------------------
  function infoItem(label, value) {
    const div = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value === null || value === undefined || value === '' ? '–' : value;
    div.append(dt, dd);
    return div;
  }

  function section(title, content) {
    const wrap = document.createElement('section');
    const h = document.createElement('h4');
    h.textContent = title;
    wrap.append(h, content);
    return wrap;
  }

  function emptyNote(text) {
    const p = document.createElement('div');
    p.className = 'drawer-empty';
    p.textContent = text;
    return p;
  }

  async function openDrawer(id, { quiet = false } = {}) {
    deliveries.openId = id;
    if (!quiet) {
      $('drawerTitle').textContent = id;
      $('drawerSubtitle').textContent = 'Loading…';
      $('drawerBody').innerHTML = '';
      $('drawer').classList.add('open');
      $('drawerBackdrop').classList.add('open');
      $('drawer').setAttribute('aria-hidden', 'false');
    }
    try {
      const res = await apiFetch(`/api/dashboard/consignments/${encodeURIComponent(id)}`);
      if (res.status === 404) {
        $('drawerSubtitle').textContent = 'This consignment no longer exists.';
        $('drawerBody').innerHTML = '';
        return;
      }
      if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
      if (deliveries.openId !== id) return;
      const { consignment: c, attempts, calls } = await res.json();

      $('drawerTitle').textContent = c.consignmentId;
      $('drawerSubtitle').textContent = `${c.issuer} ${c.itemLabel} · •••• ${c.last4}${c.isActive ? '' : ' · inactive'}`;
      const body = $('drawerBody');
      body.innerHTML = '';

      const grid = document.createElement('dl');
      grid.className = 'info-grid';
      const statusDiv = infoItem('Status', '');
      statusDiv.querySelector('dd').textContent = '';
      statusDiv.querySelector('dd').appendChild(statusBadge(c.status, c.statusLabel));
      grid.append(
        statusDiv,
        infoItem('Expected delivery', formatDate(c.expectedDeliveryDate)),
        infoItem('Last location', c.lastLocation),
        infoItem('Customer', c.customerPhone),
        infoItem('Item', `${c.itemLabel} (${c.maskedNumber})`),
        infoItem('Created', formatTime(c.createdAt))
      );
      body.appendChild(section('Consignment', grid));

      if (attempts.length) {
        const ul = document.createElement('ul');
        ul.className = 'timeline';
        attempts.forEach((a, i) => {
          const li = document.createElement('li');
          li.innerHTML = '<div class="when"></div><div class="what"></div><div class="note"></div>';
          li.querySelector('.when').textContent = `Attempt ${attempts.length - i} · ${formatTime(a.attemptTimestamp)}`;
          li.querySelector('.what').textContent = a.failureReason.charAt(0).toUpperCase() + a.failureReason.slice(1);
          const notes = [a.courierNotes ? `Courier: ${a.courierNotes}` : '', a.nextAttemptDate ? `Next attempt: ${formatDate(a.nextAttemptDate)}` : ''].filter(Boolean).join(' · ');
          li.querySelector('.note').textContent = notes;
          ul.appendChild(li);
        });
        body.appendChild(section(`Delivery attempts (${attempts.length})`, ul));
      } else {
        body.appendChild(section('Delivery attempts', emptyNote('No failed delivery attempts recorded.')));
      }

      if (calls.length) {
        const list = document.createElement('div');
        list.className = 'mini-calls';
        calls.forEach((call) => {
          const row = document.createElement('div');
          row.className = 'mini-call';
          row.innerHTML = '<div><div class="what"></div><div class="meta"></div></div>';
          row.querySelector('.what').textContent = `${call.intentDetected || 'Call'} · ${call.validationMethod || '–'}`;
          row.querySelector('.meta').textContent = `${formatTime(call.updatedAt || call.createdAt)} · ${call.callerPhone || '–'} · ${(VERIFY_META[call.verificationStatus] || ['', 'Verification unknown'])[1]}${call.durationSeconds ? ` · ${call.durationSeconds}s` : ''}`;
          const badgeTd = dispositionCell(call.disposition);
          row.appendChild(badgeTd.firstChild);
          list.appendChild(row);
        });
        body.appendChild(section(`Customer calls (${calls.length})`, list));
      } else {
        body.appendChild(section('Customer calls', emptyNote('No calls about this consignment yet.')));
      }
    } catch (err) {
      if (err.message !== 'Session expired') $('drawerSubtitle').textContent = `Could not load: ${err.message}`;
    }
  }

  function closeDrawer() {
    deliveries.openId = null;
    $('drawer').classList.remove('open');
    $('drawerBackdrop').classList.remove('open');
    $('drawer').setAttribute('aria-hidden', 'true');
  }

  function wireDeliveries() {
    $('btnDeliveriesCsv').addEventListener('click', downloadDeliveriesCsv);
    $('deliveryFilters').addEventListener('submit', (e) => {
      e.preventDefault();
      deliveries.offset = 0;
      loadDeliveries();
    });
    ['dIssuer', 'dStatus', 'dActive'].forEach((id) =>
      $(id).addEventListener('change', () => {
        deliveries.offset = 0;
        loadDeliveries();
      })
    );
    $('btnResetDeliveries').addEventListener('click', () => {
      $('deliveryFilters').reset();
      deliveries.offset = 0;
      deliveries.sort = 'status';
      deliveries.dir = 'asc';
      renderDeliverySortHeaders();
      loadDeliveries();
    });
    $('deliveriesPageSize').addEventListener('change', () => {
      deliveries.offset = 0;
      loadDeliveries();
    });
    document.querySelectorAll('#deliveriesHead th.sortable').forEach((th) => {
      th.tabIndex = 0;
      const toggle = () => {
        if (deliveries.sort === th.dataset.sort) deliveries.dir = deliveries.dir === 'asc' ? 'desc' : 'asc';
        else {
          deliveries.sort = th.dataset.sort;
          deliveries.dir = /attemptCount|lastAttemptAt/.test(th.dataset.sort) ? 'desc' : 'asc';
        }
        deliveries.offset = 0;
        renderDeliverySortHeaders();
        loadDeliveries();
      };
      th.addEventListener('click', toggle);
      th.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
    });
    $('drawerClose').addEventListener('click', closeDrawer);
    $('drawerBackdrop').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => e.key === 'Escape' && deliveries.openId && closeDrawer());
    renderDeliverySortHeaders();
  }

  // ===========================================================================
  // Tabs
  // ===========================================================================

  const TABS = ['home', 'deliveries', 'logs'];
  let activeTab = 'home';

  function showTab(name) {
    activeTab = TABS.includes(name) ? name : 'home';
    $('tabHome').hidden = activeTab !== 'home';
    $('tabDeliveries').hidden = activeTab !== 'deliveries';
    $('tabLogs').hidden = activeTab !== 'logs';
    $('tabBtnHome').setAttribute('aria-selected', String(activeTab === 'home'));
    $('tabBtnDeliveries').setAttribute('aria-selected', String(activeTab === 'deliveries'));
    $('tabBtnLogs').setAttribute('aria-selected', String(activeTab === 'logs'));
    try {
      history.replaceState(null, '', `#${activeTab}`);
    } catch (e) {
      /* sandboxed */
    }
    if (activeTab === 'logs') loadLogs();
    else if (activeTab === 'deliveries') loadDeliveries().catch(() => {});
    else Object.values(charts).forEach((c) => c.resize());
  }

  // ===========================================================================
  // Database-only data: clear everything when PostgreSQL is unreachable
  // ===========================================================================

  let dbConnected = null; // null = unknown yet

  function setDbIndicator(state, detail) {
    const live = state === 'live';
    $('dbDot').className = `dot ${state === 'down' ? 'bad' : 'ok'}`;
    $('dbStatus').textContent = state === 'down' ? 'Database disconnected' : live ? 'Live · PostgreSQL' : 'PostgreSQL connected';
    if (detail !== undefined) $('lastRefresh').textContent = detail;
  }

  /** Never show stale numbers: wipe KPIs, charts and tables while the DB is down. */
  function showDisconnected(reason) {
    dbConnected = false;
    setDbIndicator('down', reason ? reason.slice(0, 80) : 'Waiting for PostgreSQL…');
    ['kpiContainment', 'kpiTotal', 'kpiAht', 'kpiValidation', 'kpiEscalation', 'kpiSavings'].forEach((id) => {
      $(id).textContent = '–';
      $(id).dataset.value = '0';
    });
    $('kpiTotalSub').textContent = 'No data';
    $('kpiSavingsSub').textContent = 'No data';
    Object.entries(charts).forEach(([, chart]) => {
      chart.data.labels = chart.config.type === 'doughnut' ? chart.data.labels : [];
      chart.data.datasets.forEach((d) => (d.data = []));
      chart.update('none');
    });
    ['emptyResolution', 'emptyIntents', 'emptyStatus'].forEach((id) => {
      $(id).lastChild.textContent = 'Database not connected. No records to show.';
      $(id).classList.add('show');
    });
    emptyRow($('auditBody'), 7, 'Database not connected. Records will appear as soon as PostgreSQL is reachable.');
    $('auditSummary').textContent = ' ';
    $('auditPager').innerHTML = '';
    emptyRow($('logsBody'), 11, 'Database not connected. Records will appear as soon as PostgreSQL is reachable.');
    $('logsSummary').textContent = ' ';
    $('logsPager').innerHTML = '';
    $('btnDownloadCsv').disabled = true;
    emptyRow($('deliveriesBody'), 10, 'Database not connected. Records will appear as soon as PostgreSQL is reachable.');
    $('deliveriesSummary').textContent = ' ';
    $('deliveriesPager').innerHTML = '';
    $('statusTiles').innerHTML = '';
    $('btnDeliveriesCsv').disabled = true;
  }

  const EMPTY_TEXT = {
    emptyResolution: 'No calls yet. Place one from the virtual phone.',
    emptyIntents: 'No intents recorded yet.',
    emptyStatus: 'No consignments found.',
  };

  async function refresh() {
    try {
      const metricsRes = await apiFetch('/api/dashboard/metrics');
      if (!metricsRes.ok) throw new Error((await metricsRes.json()).detail || metricsRes.statusText);
      const metrics = await metricsRes.json();
      if (dbConnected === false) Object.entries(EMPTY_TEXT).forEach(([id, text]) => ($(id).lastChild.textContent = text));
      dbConnected = true;
      updateKpis(metrics.kpis);
      updateCharts(metrics);
      await loadHomeAudit();
      if (activeTab === 'logs') await loadLogs();
      if (activeTab === 'deliveries') await loadDeliveries();
      setDbIndicator(stream.live ? 'live' : 'ok', `Updated ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      if (err.message === 'Session expired') return;
      showDisconnected(err.message);
    }
  }

  // Coalesce bursts of change events (one call writes several rows) into one refresh.
  let refreshTimer = null;
  let refreshRunning = false;
  function scheduleRefresh(delay = 150) {
    if (refreshTimer) return;
    refreshTimer = setTimeout(async () => {
      refreshTimer = null;
      if (refreshRunning) return scheduleRefresh(300);
      refreshRunning = true;
      try {
        await refresh();
      } finally {
        refreshRunning = false;
      }
    }, delay);
  }

  // ===========================================================================
  // Real-time stream (PostgreSQL LISTEN/NOTIFY -> SSE), with polling fallback
  // ===========================================================================

  const SAFETY_POLL_MS = 60000; // while live: a slow re-sync in case an event was missed
  const stream = { source: null, live: false, pollTimer: null };

  function startPolling(ms) {
    clearInterval(stream.pollTimer);
    stream.pollTimer = setInterval(() => scheduleRefresh(0), ms);
  }

  function connectStream() {
    if (!('EventSource' in window)) {
      startPolling(REFRESH_MS);
      return;
    }
    const source = new EventSource('/api/dashboard/stream', { withCredentials: true });
    stream.source = source;

    source.addEventListener('open', () => {
      stream.live = true;
      startPolling(SAFETY_POLL_MS);
    });

    source.addEventListener('status', (e) => {
      const { connected, error } = JSON.parse(e.data);
      if (connected) {
        stream.live = true;
        scheduleRefresh(0);
      } else {
        showDisconnected(error || 'Waiting for PostgreSQL…');
      }
    });

    source.addEventListener('change', () => scheduleRefresh());

    source.addEventListener('error', async () => {
      // Stream dropped (server restart, network, or expired session): poll until it reconnects.
      stream.live = false;
      startPolling(REFRESH_MS);
      if (dbConnected) setDbIndicator('ok');
      try {
        await apiFetch('/api/auth/me'); // redirects to login on 401
      } catch (e) {
        if (e.message !== 'Session expired') showDisconnected('Server unreachable');
      }
    });
  }

  function init() {
    buildPhone();
    wireLogs();
    wireDeliveries();
    $('tabBtnHome').addEventListener('click', () => showTab('home'));
    $('tabBtnDeliveries').addEventListener('click', () => showTab('deliveries'));
    $('tabBtnLogs').addEventListener('click', () => showTab('logs'));
    $('btnViewLogs').addEventListener('click', () => showTab('logs'));
    $('btnLogout').addEventListener('click', logout);
    initCharts();
    loadUser();
    showTab(location.hash.replace('#', ''));
    refresh();
    startPolling(REFRESH_MS); // until the live stream is confirmed
    connectStream();
  }

  init();
})();

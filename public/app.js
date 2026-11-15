const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let token = localStorage.getItem('qm_token');
let user = JSON.parse(localStorage.getItem('qm_user') || 'null');
let queues = [], activeId = null, tab = 'queue', registerMode = false, busy = false;
const charts = {};

/* ---------- helpers ---------- */
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { logout(); throw new Error('Your session expired. Please log in again.'); }
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

let toastTimer;
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), 3000);
}

function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}
const clock = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

async function act(fn) {           // run one action at a time, surface errors as toasts
  if (busy) return;
  busy = true;
  try { await fn(); } catch (e) { toast(e.message, true); }
  busy = false;
}

/* ---------- auth ---------- */
function showAuth() {
  $('#app').hidden = true; $('#auth').hidden = false;
}
function showApp() {
  $('#auth').hidden = true; $('#app').hidden = false;
  $('#userName').textContent = user.name;
  loadQueues();
}
function logout() {
  token = null; user = null; activeId = null;
  localStorage.removeItem('qm_token'); localStorage.removeItem('qm_user');
  showAuth();
}
function setMode(reg) {
  registerMode = reg;
  $('#nameRow').hidden = !reg;
  $('#authLead').textContent = reg ? 'Create a manager account.' : 'Log in to manage your queues.';
  $('#authSubmit').textContent = reg ? 'Create account' : 'Log in';
  $('#authSwitchText').textContent = reg ? 'Already have an account?' : 'New manager?';
  $('#authSwitch').textContent = reg ? 'Log in' : 'Create an account';
  $('#authPass').autocomplete = reg ? 'new-password' : 'current-password';
  $('#authError').textContent = '';
}
$('#authSwitch').onclick = () => setMode(!registerMode);
$('#fillDemo').onclick = () => { setMode(false); $('#authEmail').value = 'demo@lineup.test'; $('#authPass').value = 'demo1234'; };
$('#authForm').onsubmit = async e => {
  e.preventDefault();
  $('#authError').textContent = '';
  const btn = $('#authSubmit'); btn.disabled = true;
  try {
    const body = { email: $('#authEmail').value, password: $('#authPass').value };
    if (registerMode) body.name = $('#authName').value;
    const data = await api(registerMode ? '/auth/register' : '/auth/login', { method: 'POST', body });
    token = data.token; user = data.user;
    localStorage.setItem('qm_token', token); localStorage.setItem('qm_user', JSON.stringify(user));
    $('#authForm').reset();
    showApp();
  } catch (err) { $('#authError').textContent = err.message; }
  btn.disabled = false;
};
$('#logout').onclick = logout;

/* ---------- queues ---------- */
async function loadQueues() {
  try {
    queues = await api('/queues');
    if (!queues.some(q => q.id === activeId)) activeId = queues[0] ? queues[0].id : null;
    renderQueues();
    await refreshActive();
  } catch (e) { if (token) toast(e.message, true); }
}

function renderQueues() {
  $('#queueList').innerHTML = queues.map(q => `
    <li><button class="qitem ${q.id === activeId ? 'on' : ''}" data-id="${q.id}">
      <b>${esc(q.name)}</b><span>${q.waiting} waiting</span></button></li>`).join('');
}
$('#queueList').onclick = e => {
  const b = e.target.closest('.qitem'); if (!b) return;
  activeId = Number(b.dataset.id); renderQueues(); refreshActive();
};

$('#queueForm').onsubmit = e => {
  e.preventDefault();
  act(async () => {
    const q = await api('/queues', { method: 'POST', body: { name: $('#queueName').value } });
    $('#queueName').value = ''; activeId = q.id; tab = 'queue'; syncTabs();
    toast('Queue created.'); await loadQueues();
  });
};

$('#delQueue').onclick = () => {
  const q = queues.find(q => q.id === activeId); if (!q) return;
  if (!confirm(`Delete “${q.name}” and all its tokens? This cannot be undone.`)) return;
  act(async () => { await api('/queues/' + q.id, { method: 'DELETE' }); toast('Queue deleted.'); activeId = null; await loadQueues(); });
};

/* ---------- active queue ---------- */
async function refreshActive() {
  const id = activeId;
  $('#empty').hidden = id !== null; $('#queueView').hidden = id === null;
  if (id === null) return;
  try {
    const d = await api('/queues/' + id);
    if (id !== activeId) return;       // user switched queues while loading
    renderQueue(d);
    if (tab === 'dash') await loadAnalytics(id);
  } catch (e) { toast(e.message, true); }
}

function tokenRow(t, i, total) {
  return `<li class="token ${i === 0 ? 'first' : ''}">
    <div class="stub">${esc(t.label)}</div>
    <div class="info"><b>${esc(t.name)}</b><small>${i === 0 ? 'Next up · ' : `#${i + 1} · `}waiting ${dur(Date.now() - t.createdAt)}</small></div>
    <div class="acts">
      <button class="ibtn" data-act="up" data-id="${t.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(t.name)} up" title="Move up">↑</button>
      <button class="ibtn" data-act="down" data-id="${t.id}" ${i === total - 1 ? 'disabled' : ''} aria-label="Move ${esc(t.name)} down" title="Move down">↓</button>
      <button class="ibtn x" data-act="cancel" data-id="${t.id}" aria-label="Cancel ${esc(t.name)}" title="Cancel token">✕</button>
    </div></li>`;
}

function renderQueue(d) {
  $('#qTitle').textContent = d.queue.name;
  $('#waitCount').textContent = d.waiting.length;
  $('#serveBtn').disabled = d.waiting.length === 0;
  $('#waitList').innerHTML = d.waiting.length
    ? d.waiting.map((t, i) => tokenRow(t, i, d.waiting.length)).join('')
    : '<li class="none">Nobody is waiting. Add a person above to create a token.</li>';
  $('#servingList').innerHTML = d.serving.length
    ? d.serving.map(t => `<li class="token serving"><div class="stub">${esc(t.label)}</div>
        <div class="info"><b>${esc(t.name)}</b><small>Serving for ${dur(Date.now() - t.servedAt)}</small></div>
        <div class="acts"><button class="tbtn" data-act="complete" data-id="${t.id}">Mark done</button></div></li>`).join('')
    : '<li class="none">No one is being served. Click “Serve next” to call the first token.</li>';
  $('#recentList').innerHTML = d.recent.length
    ? d.recent.map(t => `<li class="token ${t.status}"><div class="stub">${esc(t.label)}</div>
        <div class="info"><b>${esc(t.name)}</b><small>${t.status === 'cancelled' ? 'Cancelled' : 'Served'} at ${clock(t.completedAt || t.cancelledAt)}</small></div></li>`).join('')
    : '<li class="none">Served and cancelled tokens appear here.</li>';
}

$('#tokenForm').onsubmit = e => {
  e.preventDefault();
  act(async () => {
    const t = await api(`/queues/${activeId}/tokens`, { method: 'POST', body: { name: $('#personName').value } });
    $('#personName').value = ''; $('#personName').focus();
    toast(`Token ${t.label} created.`); await loadQueues();
  });
};
$('#serveBtn').onclick = () => act(async () => {
  const t = await api(`/queues/${activeId}/serve`, { method: 'POST' });
  toast(`Now serving ${t.label} – ${t.name}.`); await loadQueues();
});
$('#queueView').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const id = b.dataset.id, a = b.dataset.act;
  act(async () => {
    if (a === 'up' || a === 'down') await api(`/tokens/${id}/move`, { method: 'POST', body: { direction: a } });
    else if (a === 'cancel') {
      if (!confirm('Cancel this token? The person will be removed from the queue.')) return;
      await api(`/tokens/${id}/cancel`, { method: 'POST' }); toast('Token cancelled.');
    } else if (a === 'complete') { await api(`/tokens/${id}/complete`, { method: 'POST' }); toast('Marked as done.'); }
    await loadQueues();
  });
});

/* ---------- tabs & dashboard ---------- */
function syncTabs() {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('#tabQueue').hidden = tab !== 'queue'; $('#tabDash').hidden = tab !== 'dash';
}
document.querySelectorAll('.tab').forEach(b => b.onclick = () => { tab = b.dataset.tab; syncTabs(); if (tab === 'dash') loadAnalytics(activeId); });

function draw(id, type, labels, data, label, color, opts = {}) {
  const ctx = $('#' + id);
  const grid = getComputedStyle(document.body).getPropertyValue('--line').trim();
  const text = getComputedStyle(document.body).getPropertyValue('--muted').trim();
  if (charts[id]) {
    charts[id].data.labels = labels; charts[id].data.datasets[0].data = data; charts[id].update(); return;
  }
  charts[id] = new Chart(ctx, {
    type,
    data: { labels, datasets: [{ label, data, borderColor: color, backgroundColor: type === 'line' ? color + '33' : color, fill: type === 'line', tension: .25, stepped: opts.stepped, pointRadius: 2, borderRadius: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: text, maxTicksLimit: 8 }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: text, precision: opts.integer ? 0 : undefined }, grid: { color: grid } }
      }
    }
  });
}

async function loadAnalytics(id) {
  const a = await api(`/queues/${id}/analytics`);
  if (id !== activeId) return;
  const s = a.summary;
  $('#stats').innerHTML = [
    [s.waiting, 'Waiting now'], [s.serving, 'Being served'], [s.served, 'Served'], [s.cancelled, 'Cancelled'],
    [s.served || s.serving ? dur(s.avgWaitMs) : '–', 'Average wait'], [s.served || s.serving ? dur(s.maxWaitMs) : '–', 'Longest wait'],
    [s.served ? dur(s.avgServiceMs) : '–', 'Average service time']
  ].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
  draw('cTrend', 'line', a.trend.map(p => clock(p.t)), a.trend.map(p => p.length), 'Waiting', '#0f4c5c', { stepped: true, integer: true });
  draw('cWait', 'bar', a.waitTimes.map(w => w.label), a.waitTimes.map(w => +(w.waitMs / 60000).toFixed(2)), 'Wait (min)', '#f2a900');
  draw('cArrivals', 'bar', a.arrivals.map(h => new Date(h.hourStart).toLocaleTimeString([], { hour: 'numeric' })), a.arrivals.map(h => h.count), 'Arrivals', '#2c8aa1', { integer: true });
}

/* ---------- boot ---------- */
setInterval(() => { if (token && !document.hidden && !busy) loadQueues(); }, 5000);
if (token && user) showApp(); else showAuth();

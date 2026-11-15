const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

/* ---------- tiny JSON-file datastore ---------- */
let db = { users: [], queues: [], tokens: [], snapshots: [], seq: 1 };
if (fs.existsSync(DATA_FILE)) {
  try { db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; }
  catch (e) { console.error('Could not read data file, starting fresh:', e.message); }
}
let saving = false, dirty = false;
function save() {
  dirty = true;
  if (saving) return;
  saving = true;
  const tmp = DATA_FILE + '.tmp';
  fs.writeFile(tmp, JSON.stringify(db), err => {
    if (!err) fs.rename(tmp, DATA_FILE, () => {});
    saving = false;
    if (dirty) { dirty = false; save(); }
  });
  dirty = false;
}
const nextId = () => db.seq++;

/* ---------- helpers ---------- */
const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const clean = s => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ') : '');
const waitingOf = qid => db.tokens.filter(t => t.queueId === qid && t.status === 'waiting').sort((a, b) => a.order - b.order);

function snapshot(qid) {
  db.snapshots.push({ queueId: qid, t: Date.now(), length: waitingOf(qid).length });
  if (db.snapshots.length > 20000) db.snapshots.splice(0, db.snapshots.length - 20000);
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  try {
    const payload = jwt.verify(h.replace('Bearer ', ''), SECRET);
    const user = db.users.find(u => u.id === payload.id);
    if (!user) throw new Error('no user');
    req.user = user;
    next();
  } catch { bad(res, 'Please log in again.', 401); }
}

function ownQueue(req, res, next) {
  const q = db.queues.find(q => q.id === Number(req.params.id) && q.ownerId === req.user.id);
  if (!q) return bad(res, 'Queue not found.', 404);
  req.queue = q;
  next();
}

function ownToken(req, res, next) {
  const t = db.tokens.find(t => t.id === Number(req.params.id));
  const q = t && db.queues.find(q => q.id === t.queueId && q.ownerId === req.user.id);
  if (!t || !q) return bad(res, 'Token not found.', 404);
  req.token = t; req.queue = q;
  next();
}

const publicToken = t => ({ id: t.id, label: t.label, name: t.name, status: t.status, createdAt: t.createdAt, servedAt: t.servedAt, completedAt: t.completedAt, cancelledAt: t.cancelledAt });

/* ---------- auth ---------- */
const sign = u => jwt.sign({ id: u.id }, SECRET, { expiresIn: '7d' });

app.post('/api/auth/register', (req, res) => {
  const name = clean(req.body.name), email = clean(req.body.email).toLowerCase(), password = req.body.password;
  if (!name) return bad(res, 'Enter your name.');
  if (!/^\S+@\S+\.\S+$/.test(email)) return bad(res, 'Enter a valid email address.');
  if (typeof password !== 'string' || password.length < 6) return bad(res, 'Password must be at least 6 characters.');
  if (db.users.some(u => u.email === email)) return bad(res, 'An account with this email already exists.', 409);
  const user = { id: nextId(), name, email, passwordHash: bcrypt.hashSync(password, 10) };
  db.users.push(user); save();
  res.status(201).json({ token: sign(user), user: { id: user.id, name, email } });
});

app.post('/api/auth/login', (req, res) => {
  const email = clean(req.body.email).toLowerCase();
  const user = db.users.find(u => u.email === email);
  if (!user || typeof req.body.password !== 'string' || !bcrypt.compareSync(req.body.password, user.passwordHash))
    return bad(res, 'Wrong email or password.', 401);
  res.json({ token: sign(user), user: { id: user.id, name: user.name, email } });
});

/* ---------- queues ---------- */
app.get('/api/queues', auth, (req, res) => {
  const list = db.queues.filter(q => q.ownerId === req.user.id).map(q => ({
    id: q.id, name: q.name, createdAt: q.createdAt,
    waiting: waitingOf(q.id).length,
    serving: db.tokens.filter(t => t.queueId === q.id && t.status === 'serving').length
  }));
  res.json(list);
});

app.post('/api/queues', auth, (req, res) => {
  const name = clean(req.body.name);
  if (!name) return bad(res, 'Give the queue a name.');
  if (name.length > 60) return bad(res, 'Queue name can be up to 60 characters.');
  if (db.queues.some(q => q.ownerId === req.user.id && q.name.toLowerCase() === name.toLowerCase()))
    return bad(res, 'You already have a queue with this name.', 409);
  const q = { id: nextId(), ownerId: req.user.id, name, prefix: (name[0] || 'Q').toUpperCase(), counter: 0, createdAt: Date.now() };
  db.queues.push(q); snapshot(q.id); save();
  res.status(201).json({ id: q.id, name: q.name, createdAt: q.createdAt, waiting: 0, serving: 0 });
});

app.delete('/api/queues/:id', auth, ownQueue, (req, res) => {
  const id = req.queue.id;
  db.queues = db.queues.filter(q => q.id !== id);
  db.tokens = db.tokens.filter(t => t.queueId !== id);
  db.snapshots = db.snapshots.filter(s => s.queueId !== id);
  save(); res.json({ ok: true });
});

app.get('/api/queues/:id', auth, ownQueue, (req, res) => {
  const q = req.queue, all = db.tokens.filter(t => t.queueId === q.id);
  const recent = all.filter(t => t.status === 'served' || t.status === 'cancelled')
    .sort((a, b) => (b.completedAt || b.cancelledAt) - (a.completedAt || a.cancelledAt)).slice(0, 8);
  res.json({
    queue: { id: q.id, name: q.name },
    waiting: waitingOf(q.id).map(publicToken),
    serving: all.filter(t => t.status === 'serving').sort((a, b) => a.servedAt - b.servedAt).map(publicToken),
    recent: recent.map(publicToken)
  });
});

/* ---------- tokens ---------- */
app.post('/api/queues/:id/tokens', auth, ownQueue, (req, res) => {
  const name = clean(req.body.name);
  if (!name) return bad(res, 'Enter the person\'s name.');
  if (name.length > 60) return bad(res, 'Name can be up to 60 characters.');
  const q = req.queue;
  q.counter += 1;
  const last = waitingOf(q.id).pop();
  const t = {
    id: nextId(), queueId: q.id, label: `${q.prefix}-${String(q.counter).padStart(3, '0')}`, name,
    status: 'waiting', order: last ? last.order + 1 : 1, createdAt: Date.now(),
    servedAt: null, completedAt: null, cancelledAt: null
  };
  db.tokens.push(t); snapshot(q.id); save();
  res.status(201).json(publicToken(t));
});

app.post('/api/queues/:id/serve', auth, ownQueue, (req, res) => {
  const top = waitingOf(req.queue.id)[0];
  if (!top) return bad(res, 'No one is waiting.');
  top.status = 'serving'; top.servedAt = Date.now();
  snapshot(req.queue.id); save();
  res.json(publicToken(top));
});

app.post('/api/tokens/:id/complete', auth, ownToken, (req, res) => {
  if (req.token.status !== 'serving') return bad(res, 'This token is not being served.', 409);
  req.token.status = 'served'; req.token.completedAt = Date.now(); save();
  res.json(publicToken(req.token));
});

app.post('/api/tokens/:id/cancel', auth, ownToken, (req, res) => {
  if (req.token.status !== 'waiting') return bad(res, 'Only waiting tokens can be cancelled.', 409);
  req.token.status = 'cancelled'; req.token.cancelledAt = Date.now();
  snapshot(req.queue.id); save();
  res.json(publicToken(req.token));
});

app.post('/api/tokens/:id/move', auth, ownToken, (req, res) => {
  const dir = req.body.direction;
  if (dir !== 'up' && dir !== 'down') return bad(res, 'Direction must be "up" or "down".');
  if (req.token.status !== 'waiting') return bad(res, 'Only waiting tokens can be moved.', 409);
  const list = waitingOf(req.queue.id), i = list.findIndex(t => t.id === req.token.id);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j >= 0 && j < list.length) {
    const tmp = list[i].order; list[i].order = list[j].order; list[j].order = tmp; save();
  }
  res.json({ ok: true });
});

/* ---------- analytics ---------- */
app.get('/api/queues/:id/analytics', auth, ownQueue, (req, res) => {
  const qid = req.queue.id, all = db.tokens.filter(t => t.queueId === qid);
  const served = all.filter(t => t.servedAt).sort((a, b) => a.servedAt - b.servedAt);
  const waits = served.map(t => t.servedAt - t.createdAt);
  const svc = all.filter(t => t.completedAt).map(t => t.completedAt - t.servedAt);
  const avg = a => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
  const hour = 3600000, nowHour = Math.floor(Date.now() / hour) * hour;
  const arrivals = Array.from({ length: 12 }, (_, k) => {
    const start = nowHour - (11 - k) * hour;
    return { hourStart: start, count: all.filter(t => t.createdAt >= start && t.createdAt < start + hour).length };
  });
  res.json({
    summary: {
      totalTokens: all.length,
      waiting: all.filter(t => t.status === 'waiting').length,
      serving: all.filter(t => t.status === 'serving').length,
      served: all.filter(t => t.status === 'served').length,
      cancelled: all.filter(t => t.status === 'cancelled').length,
      avgWaitMs: avg(waits), maxWaitMs: waits.length ? Math.max(...waits) : 0, avgServiceMs: avg(svc)
    },
    trend: db.snapshots.filter(s => s.queueId === qid).slice(-60).map(s => ({ t: s.t, length: s.length })),
    waitTimes: served.slice(-20).map(t => ({ label: t.label, waitMs: t.servedAt - t.createdAt })),
    arrivals
  });
});

app.use('/api', (req, res) => bad(res, 'Not found.', 404));
app.use((err, req, res, next) => bad(res, err.type === 'entity.parse.failed' ? 'Invalid JSON.' : 'Something went wrong.', err.status || 500));

if (!db.users.some(u => u.email === 'demo@lineup.test')) {
  db.users.push({ id: nextId(), name: 'Demo Manager', email: 'demo@lineup.test', passwordHash: bcrypt.hashSync('demo1234', 10) });
  save();
}

if (require.main === module) app.listen(PORT, () => console.log(`Queue manager running at http://localhost:${PORT}`));
module.exports = app;

'use strict';
/**
 * خادم تطبيق الرسائل — عملية واحدة تقدّم:
 *  - الواجهة الثابتة (public/)
 *  - REST API تحت /api
 *  - WebSocket تحت /ws (حضور + توصيل لحظي + إشعارات قراءة)
 */
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const store = require('./store');

const PORT = process.env.PORT || 3000;
const USERNAME_RE = /^[\p{L}\p{N}_.-]{3,32}$/u;

// ---------- أدوات التشفير والجلسات ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, expectedHash) {
  const hash = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}
function publicUser(u) {
  return { id: u.id, username: u.username, createdAt: u.createdAt };
}
function publicMessage(m) {
  const from = store.getUserById(m.fromId);
  const to = store.getUserById(m.toId);
  return {
    id: m.id,
    from: from ? from.username : null,
    to: to ? to.username : null,
    text: m.text,
    ts: m.ts,
    deliveredAt: m.deliveredAt || null,
    readAt: m.readAt || null,
  };
}

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => res.json({ ok: true }));

function authUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  const userId = store.getUserIdByToken(token);
  return userId ? store.getUserById(userId) : null;
}
function requireAuth(req, res, next) {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: 'غير مصرح — سجّل الدخول أولاً' });
  req.user = user;
  next();
}

// ---------- المصادقة ----------
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !USERNAME_RE.test(String(username).trim())) {
    return res.status(400).json({ error: 'اسم المستخدم يجب أن يكون 3 أحرف على الأقل (أحرف وأرقام و _ . -)' });
  }
  if (!password || String(password).length < 4) {
    return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 4 أحرف على الأقل' });
  }
  const name = String(username).trim();
  if (store.getUserByUsername(name)) {
    return res.status(409).json({ error: 'اسم المستخدم مستخدم من قبل' });
  }
  const { salt, hash } = hashPassword(String(password));
  const user = { id: crypto.randomUUID(), username: name, salt, hash, createdAt: Date.now() };
  store.createUser(user);
  const token = newToken();
  store.createSession(token, user.id);
  res.status(201).json({ token, user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = username ? store.getUserByUsername(String(username).trim()) : null;
  if (!user || !password || !verifyPassword(String(password), user.salt, user.hash)) {
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }
  const token = newToken();
  store.createSession(token, user.id);
  res.json({ token, user: publicUser(user) });
});

app.post('/api/logout', requireAuth, (req, res) => {
  const token = (req.headers.authorization || '').slice(7);
  store.deleteSession(token);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

// ---------- دليل المستخدمين ----------
app.get('/api/users', requireAuth, (req, res) => {
  res.json({ users: store.listUsers(req.user.id, req.query.q || '') });
});

// ---------- المحادثات والرسائل ----------
app.get('/api/conversations', requireAuth, (req, res) => {
  const mine = store.getAllConversationsFor(req.user.id);
  const byOther = new Map();
  for (const m of mine) {
    const otherId = m.fromId === req.user.id ? m.toId : m.fromId;
    if (!byOther.has(otherId)) byOther.set(otherId, { messages: [], unread: 0 });
    const entry = byOther.get(otherId);
    entry.messages.push(m);
    if (m.toId === req.user.id && !m.readAt) entry.unread += 1;
  }
  const conversations = [];
  for (const [otherId, entry] of byOther) {
    const other = store.getUserById(otherId);
    if (!other) continue;
    entry.messages.sort((a, b) => a.ts - b.ts);
    const last = entry.messages[entry.messages.length - 1];
    conversations.push({
      username: other.username,
      lastMessage: last ? publicMessage(last) : null,
      unread: entry.unread,
    });
  }
  conversations.sort((a, b) => (b.lastMessage?.ts || 0) - (a.lastMessage?.ts || 0));
  res.json({ conversations });
});

app.get('/api/messages/:username', requireAuth, (req, res) => {
  const other = store.getUserByUsername(req.params.username);
  if (!other) return res.status(404).json({ error: 'المستخدم غير موجود' });
  const messages = store.getConversation(req.user.id, other.id).map(publicMessage);
  res.json({ with: other.username, messages });
});

app.post('/api/messages/:username/read', requireAuth, (req, res) => {
  const other = store.getUserByUsername(req.params.username);
  if (!other) return res.status(404).json({ error: 'المستخدم غير موجود' });
  const changed = store.markConversationRead(req.user.id, other.id);
  if (changed.length) notifyReadReceipt(other.id, req.user.username, changed.map((m) => m.id));
  res.json({ ok: true, marked: changed.length });
});

app.post('/api/messages/:username', requireAuth, (req, res) => {
  const other = store.getUserByUsername(req.params.username);
  if (!other) return res.status(404).json({ error: 'المستخدم غير موجود' });
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'الرسالة فارغة' });
  const msg = deliverMessage(req.user, other, text);
  res.status(201).json({ message: publicMessage(msg) });
});

// ---------- WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const connections = new Map(); // userId -> Set<ws>

function wsSend(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
function sendToUser(userId, obj) {
  const set = connections.get(userId);
  if (!set) return 0;
  let n = 0;
  for (const ws of set) { wsSend(ws, obj); n += 1; }
  return n;
}
function broadcastPresence() {
  const online = [];
  for (const [userId, set] of connections) {
    if (set.size) {
      const u = store.getUserById(userId);
      if (u) online.push(u.username);
    }
  }
  const payload = { type: 'presence', online };
  for (const set of connections.values()) for (const ws of set) wsSend(ws, payload);
}
function notifyReadReceipt(senderId, readerUsername, messageIds) {
  sendToUser(senderId, { type: 'read_receipt', with: readerUsername, messageIds });
}

/** إنشاء رسالة وحفظها وتوصيلها لحظياً إن كان المستقبِل متصلاً. */
function deliverMessage(fromUser, toUser, text) {
  const msg = {
    id: crypto.randomUUID(),
    fromId: fromUser.id,
    toId: toUser.id,
    text,
    ts: Date.now(),
    deliveredAt: null,
    readAt: null,
  };
  store.addMessage(msg);
  const delivered = sendToUser(toUser.id, { type: 'message', message: publicMessage(msg) });
  if (delivered > 0) store.markDelivered(msg);
  // تأكيد للمرسِل بالحالة النهائية (مرسلة/تم التسليم)
  sendToUser(fromUser.id, { type: 'sent', message: publicMessage(msg) });
  return msg;
}

wss.on('connection', (ws) => {
  ws.isAuthed = false;
  ws.userId = null;
  const authTimeout = setTimeout(() => { if (!ws.isAuthed) ws.close(); }, 10000);

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    if (!ws.isAuthed) {
      if (data.type === 'auth' && data.token) {
        const userId = store.getUserIdByToken(data.token);
        const user = userId ? store.getUserById(userId) : null;
        if (!user) { wsSend(ws, { type: 'error', error: 'جلسة غير صالحة' }); ws.close(); return; }
        ws.isAuthed = true;
        ws.userId = user.id;
        clearTimeout(authTimeout);
        if (!connections.has(user.id)) connections.set(user.id, new Set());
        connections.get(user.id).add(ws);
        wsSend(ws, { type: 'authed', user: publicUser(user) });
        // أي رسائل وصلت أثناء غيابه تُعلَّم «تم التسليم» ويُشعَر مرسلوها
        const pending = store.getUndeliveredFor(user.id);
        if (pending.length) {
          store.markManyDelivered(pending);
          const bySender = new Map();
          for (const m of pending) {
            if (!bySender.has(m.fromId)) bySender.set(m.fromId, []);
            bySender.get(m.fromId).push(m.id);
          }
          for (const [senderId, ids] of bySender) {
            sendToUser(senderId, { type: 'delivered', with: user.username, messageIds: ids });
          }
        }
        broadcastPresence();
      }
      return;
    }

    const me = store.getUserById(ws.userId);
    if (!me) return;

    if (data.type === 'send') {
      const to = data.to ? store.getUserByUsername(String(data.to)) : null;
      const text = String(data.text || '').trim();
      if (!to || !text) { wsSend(ws, { type: 'error', error: 'رسالة غير صالحة' }); return; }
      deliverMessage(me, to, text);
    } else if (data.type === 'read') {
      const other = data.with ? store.getUserByUsername(String(data.with)) : null;
      if (!other) return;
      const changed = store.markConversationRead(me.id, other.id);
      if (changed.length) notifyReadReceipt(other.id, me.username, changed.map((m) => m.id));
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (ws.userId && connections.has(ws.userId)) {
      connections.get(ws.userId).delete(ws);
      if (connections.get(ws.userId).size === 0) connections.delete(ws.userId);
      broadcastPresence();
    }
  });
});

server.listen(PORT, () => {
  console.log(`messages-app listening on http://localhost:${PORT}`);
});

'use strict';
/**
 * خادم تطبيق الرسائل — عملية واحدة تقدّم:
 *  - الواجهة الثابتة (public/)
 *  - REST API تحت /api
 *  - WebSocket تحت /ws (حضور + توصيل لحظي + إشعارات قراءة)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const store = require('./store');

const PORT = process.env.PORT || 3000;
// اسم المستخدم: يبدأ بحرف أو رقم، ثم حروف/أرقام و _ . - — الطول الكلي 1–24
// (حرف واحد مثل "A" أو "7" صالح). الفرادة بمطابقة دقيقة لحالة الأحرف:
// «omer» و«Omer» اسمان مختلفان يمكن أن يتعايشا كحسابين منفصلين.
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,23}$/;
const USERNAME_ERROR = 'اسم المستخدم يجب أن يبدأ بحرف أو رقم، ويمكن أن يحتوي على حروف وأرقام و _ . - فقط';
const USERNAME_TAKEN_ERROR = 'اسم المستخدم هذا مستخدم من قبل، اختر اسماً آخر';
const USERNAME_RESERVED_ERROR = 'هذا الاسم محجوز مؤقتاً لصاحبه السابق، يصبح متاحاً بعد انتهاء الحجز (٣ أيام من تغييره)';
const NAME_HOLD_MS = 3 * 24 * 60 * 60 * 1000; // حجز الاسم المُخلى: ٣ أيام

// قوة كلمة المرور (عند التسجيل فقط): 4 حروف على الأقل + رقم + رمز
function passwordError(password) {
  const pw = String(password || '');
  const letters = (pw.match(/[A-Za-z]/g) || []).length;
  const missing = [];
  if (letters < 4) missing.push('٤ حروف على الأقل');
  if (!/\d/.test(pw)) missing.push('رقم');
  if (!/[^A-Za-z0-9]/.test(pw)) missing.push('رمز (مثل ! أو #)');
  return missing.length ? 'كلمة المرور يجب أن تحتوي على: ' + missing.join(' + ') : null;
}

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
  return { id: u.id, username: u.username, createdAt: u.createdAt, avatar: store.avatarUrl(u) };
}
function publicMessage(m) {
  const from = store.getUserById(m.fromId);
  const to = store.getUserById(m.toId);
  const out = {
    id: m.id,
    from: from ? from.username : null,
    to: to ? to.username : null,
    text: m.text,
    kind: m.kind || 'text',
    ts: m.ts,
    deliveredAt: m.deliveredAt || null,
    readAt: m.readAt || null,
    deleted: !!m.deleted,
  };
  // حقول الوسائط تُعرض فقط ما دامت الرسالة غير محذوفة لدى الجميع
  if (m.fileId && !m.deleted) {
    out.fileId = m.fileId;
    out.fileUrl = '/files/' + m.fileId;
    out.mime = m.mime || null;
    out.size = m.size || null;
    out.durationSec = m.durationSec || null;
  }
  return out;
}

// ---------- الملفات المرفوعة ----------
// تُحفظ البايتات الأصلية كما هي (دون أي إعادة ترميز أو ضغط) في DATA_DIR/uploads،
// والبيانات الوصفية في مخزن JSON عبر store.addUpload.
const UPLOADS_DIR = path.join(store.DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const ALLOWED_UPLOAD_MIMES = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
  'image/gif': '.gif', 'image/heic': '.heic', 'image/heif': '.heif',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'audio/webm': '.webm', 'audio/mp4': '.m4a', 'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/aac': '.aac',
};
function kindFromMime(mime) {
  if (!mime) return 'text';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'voice';
  return 'text';
}
function clampDuration(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 86400) : 0;
}
function removeUploadFile(fileId) {
  const meta = store.getUpload(fileId);
  if (!meta) return;
  try { fs.unlinkSync(path.join(UPLOADS_DIR, meta.file)); } catch {}
  store.removeUpload(fileId);
}
function isHiddenFor(m, userId) {
  return Array.isArray(m.hiddenFor) && m.hiddenFor.includes(userId);
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
    return res.status(400).json({ error: USERNAME_ERROR });
  }
  const pwErr = passwordError(password);
  if (pwErr) {
    return res.status(400).json({ error: pwErr });
  }
  const name = String(username).trim();
  if (store.getUserByUsername(name)) {
    return res.status(409).json({ error: USERNAME_TAKEN_ERROR });
  }
  // اسم مُخلى حديثاً وما زال محجوزاً لصاحبه السابق (٣ أيام) — لا يُسجَّل به حساب جديد
  if (store.getNameReservation(name)) {
    return res.status(409).json({ error: USERNAME_RESERVED_ERROR });
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

// ---------- الملف الشخصي: الصورة وتغيير الاسم ----------
// الصورة الشخصية: ملف صورة رفعه المستخدم نفسه عبر /api/upload — يُحفظ مرجعه على سجلّه.
app.post('/api/me/avatar', requireAuth, (req, res) => {
  const fileId = String((req.body || {}).fileId || '');
  const up = fileId ? store.getUpload(fileId) : null;
  if (!up) return res.status(400).json({ error: 'ملف غير صالح' });
  if (up.ownerId !== req.user.id) return res.status(403).json({ error: 'لا يمكنك استخدام ملف لا يخصّك صورةً شخصية' });
  if (!String(up.mime || '').startsWith('image/')) {
    return res.status(400).json({ error: 'الصورة الشخصية يجب أن تكون ملف صورة' });
  }
  req.user.avatarFileId = fileId;
  store.saveUser();
  res.json({ user: publicUser(req.user) });
});

// تغيير اسم المستخدم: نفس قواعد التسجيل (1–24، يبدأ بحرف/رقم، فرادة دقيقة لحالة الأحرف).
// الاسم القديم يُحجز لصاحبه ٣ أيام: لا يستطيع غيره أخذه (تسجيلاً أو تغييراً) قبل انتهاء
// الحجز، ويستطيع صاحبه الرجوع إليه في أي وقت خلالها. الهوية ثابتة بالمعرّف (id) —
// الرسائل والمحادثات والجلسة مرتبطة بالمعرّف لا بالاسم، فتتبع المستخدم اسمه الجديد
// تلقائياً في كل مكان دون أي ترحيل للبيانات.
app.post('/api/me/username', requireAuth, (req, res) => {
  const name = String((req.body || {}).username || '').trim();
  if (!USERNAME_RE.test(name)) {
    return res.status(400).json({ error: USERNAME_ERROR });
  }
  const me = req.user;
  if (name === me.username) {
    return res.json({ user: publicUser(me) }); // نفس الاسم الحالي — لا تغيير
  }
  const existing = store.getUserByUsername(name);
  if (existing && existing.id !== me.id) {
    return res.status(409).json({ error: USERNAME_TAKEN_ERROR });
  }
  const reservation = store.getNameReservation(name);
  if (reservation && reservation.ownerId !== me.id) {
    return res.status(409).json({ error: USERNAME_RESERVED_ERROR });
  }
  const oldName = me.username;
  if (reservation) store.removeNameReservation(name); // استرجاع اسمي المحجوز لي — يُستهلك الحجز
  me.username = name;
  store.saveUser();
  store.addNameReservation(oldName, me.id, Date.now() + NAME_HOLD_MS);
  // إعادة بثّ الحضور بالأسماء الجديدة حتى تتحدث القوائم عند الجميع
  broadcastPresence();
  res.json({ user: publicUser(me) });
});

// ---------- دليل المستخدمين ----------
app.get('/api/users', requireAuth, (req, res) => {
  res.json({ users: store.listUsers(req.user.id, req.query.q || '') });
});

// ---------- المحادثات والرسائل ----------
app.get('/api/conversations', requireAuth, (req, res) => {
  // الرسائل المخفية لدى هذا المستخدم (حذف «لديّ») لا تظهر في القائمة ولا في المعاينة
  const mine = store.getAllConversationsFor(req.user.id).filter((m) => !isHiddenFor(m, req.user.id));
  const byOther = new Map();
  for (const m of mine) {
    const otherId = m.fromId === req.user.id ? m.toId : m.fromId;
    if (!byOther.has(otherId)) byOther.set(otherId, { messages: [], unread: 0 });
    const entry = byOther.get(otherId);
    entry.messages.push(m);
    // غير المقروء لا يحسب الرسائل المحذوفة لدى الجميع
    if (m.toId === req.user.id && !m.readAt && !m.deleted) entry.unread += 1;
  }
  const conversations = [];
  for (const [otherId, entry] of byOther) {
    const other = store.getUserById(otherId);
    if (!other) continue;
    entry.messages.sort((a, b) => a.ts - b.ts);
    const last = entry.messages[entry.messages.length - 1];
    conversations.push({
      username: other.username,
      avatar: store.avatarUrl(other),
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
  const messages = store.getConversation(req.user.id, other.id)
    .filter((m) => !isHiddenFor(m, req.user.id))
    .map(publicMessage);
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
  const body = req.body || {};
  // رسالة وسائط: تشير إلى ملف رُفع مسبقاً عبر /api/upload
  if (body.fileId) {
    const up = store.getUpload(String(body.fileId));
    if (!up || up.ownerId !== req.user.id) return res.status(400).json({ error: 'ملف غير صالح' });
    const kind = ['image', 'video', 'voice'].includes(body.kind) ? body.kind : kindFromMime(up.mime);
    const msg = deliverMessage(req.user, other, { kind, fileId: String(body.fileId), durationSec: clampDuration(body.durationSec) });
    return res.status(201).json({ message: publicMessage(msg) });
  }
  const text = String(body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'الرسالة فارغة' });
  const msg = deliverMessage(req.user, other, { text });
  res.status(201).json({ message: publicMessage(msg) });
});

// ---------- حذف رسالة ----------
// scope=everyone: للمرسِل فقط — تتحول الرسالة إلى نص بديل (tombstone) ويُحذف ملفها إن وُجد.
// scope=me: لأي طرف — تُخفى عنه وحده (hiddenFor) وتبقى عند الطرف الآخر كما هي.
app.delete('/api/messages/:id', requireAuth, (req, res) => {
  const msg = store.getMessageById(req.params.id);
  if (!msg) return res.status(404).json({ error: 'الرسالة غير موجودة' });
  if (msg.fromId !== req.user.id && msg.toId !== req.user.id) {
    return res.status(403).json({ error: 'غير مسموح بحذف هذه الرسالة' });
  }
  const scope = (req.body || {}).scope === 'everyone' ? 'everyone' : 'me';
  if (scope === 'everyone') {
    if (msg.fromId !== req.user.id) {
      return res.status(403).json({ error: 'حذف الرسالة لدى الجميع متاح لمرسِلها فقط' });
    }
    if (!msg.deleted) {
      const fileId = msg.fileId;
      msg.deleted = true;
      msg.text = '';
      delete msg.fileId;
      delete msg.mime;
      delete msg.size;
      delete msg.durationSec;
      store.saveMessage();
      if (fileId) removeUploadFile(fileId);
    }
  } else {
    if (!Array.isArray(msg.hiddenFor)) msg.hiddenFor = [];
    if (!msg.hiddenFor.includes(req.user.id)) {
      msg.hiddenFor.push(req.user.id);
      store.saveMessage();
    }
  }
  // بثّ للطرفين: المحادثات المفتوحة تُحدَّث لحظياً (العميل يطبّق «me» على صاحب الحذف فقط)
  const evt = { type: 'message_deleted', id: msg.id, scope, by: req.user.username };
  sendToUser(msg.fromId, evt);
  if (msg.toId !== msg.fromId) sendToUser(msg.toId, evt);
  res.json({ ok: true });
});

// ---------- رفع الملفات وتقديمها ----------
// الجسم الخام كما هو (حتى 100MB) — تُحفظ البايتات الأصلية دون أي معالجة.
app.post('/api/upload', requireAuth, express.raw({ type: () => true, limit: '100mb' }), (req, res) => {
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = ALLOWED_UPLOAD_MIMES[mime];
  if (!ext) return res.status(400).json({ error: 'نوع الملف غير مدعوم' });
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  if (!buf || !buf.length) return res.status(400).json({ error: 'الملف فارغ' });
  const id = crypto.randomBytes(16).toString('hex'); // 32 hex chars
  const fileName = id + ext;
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOADS_DIR, fileName), buf);
  const rawName = String(req.headers['x-file-name'] || '');
  let name = rawName;
  try { name = decodeURIComponent(rawName); } catch {}
  store.addUpload(id, { file: fileName, mime, size: buf.length, name: name.slice(0, 200), ownerId: req.user.id, ts: Date.now() });
  res.status(201).json({ fileId: id, url: '/files/' + id, mime, size: buf.length });
});

// تقديم الملف الأصلي كما رُفع، مع دعم Range الأساسي لتشغيل الفيديو والتنقل فيه.
app.get('/files/:id', (req, res) => {
  const id = req.params.id;
  if (!/^[a-f0-9]{32}$/.test(id)) return res.status(404).json({ error: 'الملف غير موجود' });
  const meta = store.getUpload(id);
  if (!meta) return res.status(404).json({ error: 'الملف غير موجود' });
  const filePath = path.join(UPLOADS_DIR, meta.file);
  fs.stat(filePath, (err, st) => {
    if (err) return res.status(404).json({ error: 'الملف غير موجود' });
    const total = st.size;
    res.setHeader('Content-Type', meta.mime);
    res.setHeader('Accept-Ranges', 'bytes');
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if (m && (m[1] !== '' || m[2] !== '')) {
        let start, end;
        if (m[1] === '') { // لاحقة: آخر N بايت
          start = Math.max(0, total - parseInt(m[2], 10));
          end = total - 1;
        } else {
          start = parseInt(m[1], 10);
          end = m[2] === '' ? total - 1 : Math.min(parseInt(m[2], 10), total - 1);
        }
        if (start > end || start >= total) {
          res.setHeader('Content-Range', `bytes */${total}`);
          return res.status(416).end();
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
        res.setHeader('Content-Length', end - start + 1);
        return fs.createReadStream(filePath, { start, end }).pipe(res);
      }
    }
    res.setHeader('Content-Length', total);
    fs.createReadStream(filePath).pipe(res);
  });
});

// أخطاء رفع الملفات تُرجع JSON عربياً بدل صفحة الخطأ الافتراضية
app.use((err, req, res, next) => {
  if (req.path === '/api/upload') {
    const tooLarge = err && (err.type === 'entity.too.large' || err.status === 413);
    return res.status(tooLarge ? 413 : (err.status || 500)).json({
      error: tooLarge ? 'الملف أكبر من الحد الأقصى (100MB)' : 'فشل رفع الملف',
    });
  }
  next(err);
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

/** إنشاء رسالة وحفظها وتوصيلها لحظياً إن كان المستقبِل متصلاً.
 *  payload: { text } لرسالة نصية، أو { kind, fileId, durationSec } لرسالة وسائط
 *  (نوع الملف وحجمه يؤخذان من بيانات الرفع الوصفية — لا من العميل). */
function deliverMessage(fromUser, toUser, payload) {
  const msg = {
    id: crypto.randomUUID(),
    fromId: fromUser.id,
    toId: toUser.id,
    text: payload.text || '',
    ts: Date.now(),
    deliveredAt: null,
    readAt: null,
  };
  if (payload.kind && payload.kind !== 'text' && payload.fileId) {
    msg.kind = payload.kind;
    msg.fileId = payload.fileId;
    const up = store.getUpload(payload.fileId);
    if (up) { msg.mime = up.mime; msg.size = up.size; }
    const dur = clampDuration(payload.durationSec);
    if (dur) msg.durationSec = dur;
  }
  store.addMessage(msg);
  const delivered = sendToUser(toUser.id, { type: 'message', message: publicMessage(msg) });
  if (delivered > 0) store.markDelivered(msg);
  // تأكيد للمرسِل بالحالة النهائية (مرسلة/تم التسليم)
  sendToUser(fromUser.id, { type: 'sent', message: publicMessage(msg) });
  return msg;
}

// ---------- إشارات المكالمات (WebRTC Signaling) ----------
// الخادم يمرّر رسائل الإشارة بين الطرفين المعنيين فقط، ولا يخزّن SDP/ICE أبداً.
// الصوت/الفيديو نفسه ينتقل مباشرة بين المتصفحين (Peer-to-Peer) عبر WebRTC.
const activeCalls = new Map(); // callId -> { id, callerId, calleeId, callType, state, connectedAt, logged }
const callByUser = new Map(); // userId -> callId
let callSeq = 0;

function fmtDuration(totalSec) {
  const sec = Math.max(0, Math.floor(Number(totalSec) || 0));
  return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
}
function callLabel(callType) {
  return callType === 'video' ? '📹 مكالمة فيديو' : '📞 مكالمة صوتية';
}
function getCallBetween(aId, bId) {
  const id = callByUser.get(aId);
  if (!id) return null;
  const call = activeCalls.get(id);
  return call && (call.callerId === bId || call.calleeId === bId) ? call : null;
}
function clearCallState(call) {
  activeCalls.delete(call.id);
  if (callByUser.get(call.callerId) === call.id) callByUser.delete(call.callerId);
  if (callByUser.get(call.calleeId) === call.id) callByUser.delete(call.calleeId);
}
/** كتابة سجل مكالمة (kind: 'call') في سجل المحادثة — مرة واحدة فقط لكل مكالمة. */
function logCallRecord(call, text) {
  if (call.logged) return;
  call.logged = true;
  const from = store.getUserById(call.callerId);
  const to = store.getUserById(call.calleeId);
  if (!from || !to) return;
  const msg = {
    id: crypto.randomUUID(),
    fromId: from.id,
    toId: to.id,
    text,
    kind: 'call',
    ts: Date.now(),
    deliveredAt: null,
    readAt: null,
  };
  store.addMessage(msg);
  const delivered = sendToUser(to.id, { type: 'message', message: publicMessage(msg) });
  if (delivered > 0) store.markDelivered(msg);
  sendToUser(from.id, { type: 'message', message: publicMessage(msg) });
}

/** معالجة رسائل إشارة المكالمة الواردة من مستخدم موثّق. */
function handleCallSignal(ws, me, data) {
  if (data.type === 'call_invite') {
    const callType = data.callType === 'video' ? 'video' : 'voice';
    const to = data.to ? store.getUserByUsername(String(data.to)) : null;
    if (!to || to.id === me.id) {
      wsSend(ws, { type: 'call_unavailable', with: data.to || null });
      return;
    }
    if (callByUser.has(me.id)) return; // المتصل نفسه في مكالمة أصلاً — تجاهل
    const calleeOnline = connections.has(to.id) && connections.get(to.id).size > 0;
    if (!calleeOnline) {
      wsSend(ws, { type: 'call_unavailable', with: to.username });
      logCallRecord(
        { callerId: me.id, calleeId: to.id, callType, logged: false },
        callLabel(callType) + ' فائتة'
      );
      return;
    }
    if (callByUser.has(to.id)) {
      wsSend(ws, { type: 'call_busy', with: to.username });
      return;
    }
    const call = {
      id: `call-${++callSeq}-${Date.now()}`,
      callerId: me.id,
      calleeId: to.id,
      callType,
      state: 'ringing',
      connectedAt: null,
      logged: false,
    };
    activeCalls.set(call.id, call);
    callByUser.set(me.id, call.id);
    callByUser.set(to.id, call.id);
    sendToUser(to.id, { type: 'call_invite', from: me.username, callType, avatar: store.avatarUrl(me) });
    return;
  }

  if (
    data.type === 'call_accept' || data.type === 'call_reject' ||
    data.type === 'call_end' || data.type === 'call_offer' ||
    data.type === 'call_answer' || data.type === 'call_ice'
  ) {
    const to = data.to ? store.getUserByUsername(String(data.to)) : null;
    if (!to) return;
    const call = getCallBetween(me.id, to.id);
    if (!call) {
      // لا مكالمة نشطة (أُنهيت من الطرف الآخر مثلاً) — مرّر الإنهاء فقط ليغلق الطرف الآخر واجهته
      if (data.type === 'call_end') sendToUser(to.id, { type: 'call_end', from: me.username });
      return;
    }
    const otherId = call.callerId === me.id ? call.calleeId : call.callerId;

    if (data.type === 'call_accept') {
      if (call.calleeId === me.id && call.state === 'ringing') {
        call.state = 'connected';
        call.connectedAt = Date.now();
        sendToUser(call.callerId, { type: 'call_accept', from: me.username });
      }
    } else if (data.type === 'call_reject') {
      const text = call.calleeId === me.id
        ? callLabel(call.callType) + ' مرفوضة'
        : callLabel(call.callType) + ' فائتة';
      logCallRecord(call, text);
      sendToUser(otherId, { type: 'call_reject', from: me.username });
      clearCallState(call);
    } else if (data.type === 'call_end') {
      let text;
      if (call.state === 'connected') {
        const dur = typeof data.duration === 'number'
          ? data.duration
          : Math.round((Date.now() - call.connectedAt) / 1000);
        text = `${callLabel(call.callType)} — ${fmtDuration(dur)}`;
      } else {
        text = callLabel(call.callType) + ' فائتة';
      }
      logCallRecord(call, text);
      sendToUser(otherId, { type: 'call_end', from: me.username });
      clearCallState(call);
    } else {
      // call_offer / call_answer / call_ice — تمرير فقط بين الطرفين، دون أي تخزين
      const out = { type: data.type, from: me.username };
      if (data.type === 'call_ice') out.candidate = data.candidate;
      else out.sdp = data.sdp;
      sendToUser(otherId, out);
    }
  }
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
      if (!to) { wsSend(ws, { type: 'error', error: 'رسالة غير صالحة' }); return; }
      if (data.fileId) {
        // رسالة وسائط: الملف يجب أن يكون مرفوعاً من هذا المستخدم نفسه
        const up = store.getUpload(String(data.fileId));
        if (!up || up.ownerId !== me.id) { wsSend(ws, { type: 'error', error: 'ملف غير صالح' }); return; }
        const kind = ['image', 'video', 'voice'].includes(data.kind) ? data.kind : kindFromMime(up.mime);
        deliverMessage(me, to, { kind, fileId: String(data.fileId), durationSec: clampDuration(data.durationSec) });
        return;
      }
      const text = String(data.text || '').trim();
      if (!text) { wsSend(ws, { type: 'error', error: 'رسالة غير صالحة' }); return; }
      deliverMessage(me, to, { text });
    } else if (data.type === 'read') {
      const other = data.with ? store.getUserByUsername(String(data.with)) : null;
      if (!other) return;
      const changed = store.markConversationRead(me.id, other.id);
      if (changed.length) notifyReadReceipt(other.id, me.username, changed.map((m) => m.id));
    }

    // إشارات المكالمات (call_invite / call_accept / call_reject / call_offer / call_answer / call_ice / call_end)
    if (typeof data.type === 'string' && data.type.startsWith('call_')) {
      handleCallSignal(ws, me, data);
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (ws.userId && connections.has(ws.userId)) {
      connections.get(ws.userId).delete(ws);
      if (connections.get(ws.userId).size === 0) {
        connections.delete(ws.userId);
        // انقطع اتصاله نهائياً وهو في مكالمة: سجّل المكالمة وأنهِها عند الطرف الآخر
        const callId = callByUser.get(ws.userId);
        const call = callId ? activeCalls.get(callId) : null;
        if (call) {
          const goneUser = store.getUserById(ws.userId);
          const otherId = call.callerId === ws.userId ? call.calleeId : call.callerId;
          const text = call.state === 'connected'
            ? `${callLabel(call.callType)} — ${fmtDuration(Math.round((Date.now() - call.connectedAt) / 1000))}`
            : callLabel(call.callType) + ' فائتة';
          logCallRecord(call, text);
          sendToUser(otherId, { type: 'call_end', from: goneUser ? goneUser.username : null });
          clearCallState(call);
        }
      }
      broadcastPresence();
    }
  });
});

server.listen(PORT, () => {
  console.log(`messages-app listening on http://localhost:${PORT}`);
});

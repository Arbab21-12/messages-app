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
const mailer = require('./mailer');
// Web Push اختياري: غياب الحزمة أو مفاتيح VAPID يعطّل الإشعارات بهدوء (503)
// دون أن يمسّ أي وظيفة أخرى في الخادم.
let webpush = null;
try { webpush = require('web-push'); } catch { webpush = null; }

const PORT = process.env.PORT || 3000;
// اسم المستخدم: يبدأ بحرف أو رقم، ثم حروف/أرقام و _ . - — الطول الكلي 1–24
// (حرف واحد مثل "A" أو "7" صالح). الفرادة بمطابقة دقيقة لحالة الأحرف:
// «omer» و«Omer» اسمان مختلفان يمكن أن يتعايشا كحسابين منفصلين.
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,23}$/;
const USERNAME_ERROR = 'اسم المستخدم يجب أن يبدأ بحرف أو رقم، ويمكن أن يحتوي على حروف وأرقام و _ . - فقط';
const USERNAME_TAKEN_ERROR = 'اسم المستخدم هذا مستخدم من قبل، اختر اسماً آخر';
// اسم مستخدم المالك (Admin) — يُضبط من البيئة فقط. عند فراغه تُعطَّل لوحة البيانات
// كلّياً (نقاط /api/admin/* ترجع 404). المطابقة دقيقة لحالة الأحرف.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';

// ---------- إشعارات Push (VAPID) ----------
// المفاتيح من البيئة فقط. عند غيابها (أو فشل ضبطها) تُعطَّل نقاط /api/push/*
// بـ 503 ولا يتعطّل أي شيء آخر. PUSH_TEST_CAPTURE=1 وضع اختبار فقط: تُسجَّل
// الحمولات في DATA_DIR/push-capture.jsonl بدل الإرسال الفعلي عبر الشبكة.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:arbab5000000@gmail.com';
const PUSH_TEST_CAPTURE = process.env.PUSH_TEST_CAPTURE === '1';
const PUSH_CAPTURE_FILE = path.join(store.DATA_DIR, 'push-capture.jsonl');
let PUSH_ENABLED = false;
if (webpush && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    PUSH_ENABLED = true;
  } catch { PUSH_ENABLED = false; }
}

/** إرسال إشعار Push لكل اشتراكات مستخدم. لا يرمي أبداً: أي فشل (شبكة/مفتاح/
 *  خدمة) يُبتلع بصمت حتى لا يكسر الإشعاراتُ الرسائلَ أو المكالمات. الاشتراك
 *  الذي تردّ خدمته بـ 404/410 (انتهى/أُلغي) يُحذف من سجل المستخدم. */
async function sendPush(userId, payload) {
  try {
    const subs = store.getPushSubscriptions(userId);
    if (!subs.length) return;
    if (PUSH_TEST_CAPTURE) {
      // وضع الاختبار: سطر JSON واحد لكل حمولة — وبلا أي إرسال شبكي فعلي
      try {
        const user = store.getUserById(userId);
        fs.appendFileSync(PUSH_CAPTURE_FILE, JSON.stringify({ userId, username: user ? user.username : null, ...payload }) + '\n', 'utf8');
      } catch {}
      return;
    }
    if (!PUSH_ENABLED) return;
    const body = JSON.stringify(payload);
    await Promise.all(subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, body);
      } catch (err) {
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          store.removePushSubscription(userId, sub.endpoint);
        }
      }
    }));
  } catch {}
}

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
  return {
    id: u.id,
    username: u.username,
    createdAt: u.createdAt,
    avatar: store.avatarUrl(u),
    isAdmin: !!ADMIN_USERNAME && u.username === ADMIN_USERNAME,
  };
}
/** مسلسِل «نفسي» لاستجابات المستخدم عن حسابه هو فقط (/api/me والتسجيل والدخول
 *  وتعديلات الملف): يضيف حقول البريد الخاصة — لا تُعرض لأي مستخدم آخر أبداً. */
function selfUser(u) {
  return {
    ...publicUser(u),
    email: u.emailVerified && u.email ? u.email : null,
    emailVerified: !!u.emailVerified,
    pendingEmail: u.pendingEmail || null,
  };
}
function publicMessage(m) {
  const from = store.getUserById(m.fromId);
  const to = store.getUserById(m.toId);
  const out = {
    id: m.id,
    from: from ? from.username : null,
    to: to ? to.username : null,
    // المحذوفة لدى الجميع تُجرَّد من كل محتواها هنا (النص يُحتفَظ به في السجل
    // للمالك وحده عبر adminMessage) — فلا يتسرب أي محتوى لأي عميل عادي
    text: m.deleted ? '' : m.text,
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
  const { salt, hash } = hashPassword(String(password));
  const user = { id: crypto.randomUUID(), username: name, salt, hash, createdAt: Date.now() };
  store.createUser(user);
  const token = newToken();
  store.createSession(token, user.id);
  res.status(201).json({ token, user: selfUser(user) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = username ? store.getUserByUsername(String(username).trim()) : null;
  if (!user || !password || !verifyPassword(String(password), user.salt, user.hash)) {
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }
  const token = newToken();
  store.createSession(token, user.id);
  res.json({ token, user: selfUser(user) });
});

app.post('/api/logout', requireAuth, (req, res) => {
  const token = (req.headers.authorization || '').slice(7);
  store.deleteSession(token);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: selfUser(req.user) }));

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
  res.json({ user: selfUser(req.user) });
});

// تغيير اسم المستخدم: نفس قواعد التسجيل (1–24، يبدأ بحرف/رقم، فرادة دقيقة لحالة الأحرف).
// لا مهلة حجز على الاسم القديم: بمجرد تغييره يصبح متاحاً فوراً لأي شخص آخر (تسجيلاً
// أو تغييراً). الهوية ثابتة بالمعرّف (id) — الرسائل والمحادثات والجلسة مرتبطة
// بالمعرّف لا بالاسم، فتتبع المستخدم اسمه الجديد تلقائياً في كل مكان دون ترحيل بيانات.
app.post('/api/me/username', requireAuth, (req, res) => {
  const name = String((req.body || {}).username || '').trim();
  if (!USERNAME_RE.test(name)) {
    return res.status(400).json({ error: USERNAME_ERROR });
  }
  const me = req.user;
  if (name === me.username) {
    return res.json({ user: selfUser(me) }); // نفس الاسم الحالي — لا تغيير
  }
  const existing = store.getUserByUsername(name);
  if (existing && existing.id !== me.id) {
    return res.status(409).json({ error: USERNAME_TAKEN_ERROR });
  }
  me.username = name;
  store.saveUser();
  // إعادة بثّ الحضور بالأسماء الجديدة حتى تتحدث القوائم عند الجميع
  broadcastPresence();
  res.json({ user: selfUser(me) });
});

// ---------- أمان الحساب: تغيير كلمة المرور + البريد المؤكد + الاستعادة ----------
// رموز البريد: ٦ أرقام، تُخزَّن مجزّأة فقط (sha256 للرمز + معرّف المستخدم + الغرض)،
// صلاحيتها ١٠ دقائق، وتُبطَل بعد ٥ محاولات خاطئة، وبين كل إرسالين لنفس الغرض
// مهلة ٦٠ ثانية. الرمز نفسه لا يُخزَّن ولا يُسجَّل في أي مكان.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
const EMAIL_CODE_MAX_ATTEMPTS = 5;
const EMAIL_CODE_COOLDOWN_MS = 60 * 1000;
const MAIL_DISABLED_ERROR = 'إرسال البريد غير مفعّل بعد';

function hashEmailCode(code, userId, purpose) {
  return crypto.createHash('sha256').update(`${code}:${userId}:${purpose}`, 'utf8').digest('hex');
}
function newEmailCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
/** إنشاء رمز جديد (يستبدل أي رمز فعّال لنفس الغرض) وإرساله بالبريد.
 *  يرمي {status, error} عند مهلة إعادة الإرسال أو فشل الإرسال (ويحذف الرمز عندها). */
async function issueEmailCode(user, email, purpose, subject) {
  const last = store.getEmailCodeLastSentAt(user.id, purpose);
  if (Date.now() - last < EMAIL_CODE_COOLDOWN_MS) {
    throw { status: 429, error: 'طلبت رمزاً قبل قليل — انتظر دقيقة ثم حاول مجدداً' };
  }
  const code = newEmailCode();
  store.createEmailCode({
    userId: user.id,
    email,
    purpose,
    codeHash: hashEmailCode(code, user.id, purpose),
    expiresAt: Date.now() + EMAIL_CODE_TTL_MS,
    attempts: 0,
    createdAt: Date.now(),
  });
  try {
    await mailer.sendMail({
      to: email,
      subject,
      text: `رمزك في تطبيق «رسائلي» هو: ${code}\nالرمز صالح لمدة ١٠ دقائق فقط. إن لم تطلب هذا الرمز فتجاهل هذه الرسالة.`,
    });
  } catch {
    store.deleteEmailCode(user.id, purpose);
    throw { status: 502, error: 'تعذّر إرسال البريد الإلكتروني، حاول مرة أخرى لاحقاً' };
  }
}
/** فحص رمز دون استهلاكه: { rec } عند الصحة، أو { status, error } عند الخطأ.
 *  المحاولة الخاطئة تزيد العدّاد، وعند بلوغ الحد يُبطَل الرمز. الوضع generic
 *  يوحّد رسائل الخطأ فلا تكشف سبب الفشل (مسار الاستعادة — منع التعداد). */
function checkEmailCode(user, purpose, code, generic) {
  const wrongMsg = generic ? 'الرمز غير صحيح أو منتهٍ' : 'الرمز غير صحيح';
  const rec = store.getEmailCode(user.id, purpose);
  if (!rec) return { status: 400, error: wrongMsg };
  if (Date.now() > rec.expiresAt) {
    store.deleteEmailCode(user.id, purpose);
    return { status: 400, error: generic ? wrongMsg : 'انتهت صلاحية الرمز' };
  }
  const given = Buffer.from(hashEmailCode(String(code || ''), user.id, purpose), 'hex');
  const expected = Buffer.from(rec.codeHash, 'hex');
  const match = given.length === expected.length && crypto.timingSafeEqual(given, expected);
  if (!match) {
    const updated = store.bumpEmailCodeAttempts(user.id, purpose);
    if (updated && updated.attempts >= EMAIL_CODE_MAX_ATTEMPTS) store.deleteEmailCode(user.id, purpose);
    return { status: 400, error: wrongMsg };
  }
  return { rec };
}

// تغيير كلمة المرور: تحقق من الحالية، فرض قاعدة القوة على الجديدة، تحديث
// التجزئة، وإلغاء كل جلسات المستخدم الأخرى (تبقى جلسة المُغيِّر صالحة).
app.post('/api/me/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !verifyPassword(String(currentPassword), req.user.salt, req.user.hash)) {
    return res.status(401).json({ error: 'كلمة المرور الحالية غير صحيحة' });
  }
  const pwErr = passwordError(newPassword);
  if (pwErr) return res.status(400).json({ error: pwErr });
  const { salt, hash } = hashPassword(String(newPassword));
  req.user.salt = salt;
  req.user.hash = hash;
  store.saveUser();
  const myToken = (req.headers.authorization || '').slice(7);
  store.deleteSessionsForUser(req.user.id, myToken);
  res.json({ ok: true });
});

// ربط بريد إلكتروني بالحساب: يُحفَظ معلّقاً (pendingEmail) ويُرسَل إليه رمز
// تأكيد — ولا يصبح «البريد المؤكد» إلا بعد إدخال الرمز الصحيح.
app.post('/api/me/email', requireAuth, async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'صيغة البريد الإلكتروني غير صحيحة' });
  }
  if (!mailer.mailEnabled()) return res.status(503).json({ error: MAIL_DISABLED_ERROR });
  try {
    await issueEmailCode(req.user, email, 'link', 'رمز تأكيد البريد — رسائلي');
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.error || 'حدث خطأ' });
  }
  req.user.pendingEmail = email;
  store.saveUser();
  res.json({ ok: true });
});

app.post('/api/me/email/verify', requireAuth, (req, res) => {
  const user = req.user;
  if (!user.pendingEmail) return res.status(400).json({ error: 'لا يوجد بريد بانتظار التأكيد' });
  const result = checkEmailCode(user, 'link', (req.body || {}).code, false);
  if (!result.rec) return res.status(result.status).json({ error: result.error });
  user.email = user.pendingEmail;
  user.emailVerified = true;
  user.pendingEmail = null;
  store.deleteEmailCode(user.id, 'link');
  store.saveUser();
  res.json({ ok: true, email: user.email });
});

// نسيت كلمة السر: الرد 200 دائماً (منع تعداد الحسابات) — يُرسَل رمز الاستعادة
// فعلياً فقط إن وُجد الحساب وله بريد مؤكد، وأي فشل إرسال/مهلة يُبتلع بصمت.
app.post('/api/password/forgot', async (req, res) => {
  if (!mailer.mailEnabled()) return res.status(503).json({ error: MAIL_DISABLED_ERROR });
  const username = String((req.body || {}).username || '').trim();
  const user = username ? store.getUserByUsername(username) : null;
  if (user && user.emailVerified && user.email) {
    try { await issueEmailCode(user, user.email, 'reset', 'رمز استعادة كلمة السر — رسائلي'); } catch {}
  }
  res.json({ ok: true });
});

// تعيين كلمة سر جديدة برمز الاستعادة: بعد نجاحه تُحدَّث التجزئة وتُلغى كل
// جلسات المستخدم ويُستهلك الرمز. كل أخطاء الرمز/المستخدم برسالة موحّدة.
app.post('/api/password/reset', (req, res) => {
  const { username, code, newPassword } = req.body || {};
  const user = username ? store.getUserByUsername(String(username).trim()) : null;
  if (!user) return res.status(400).json({ error: 'الرمز غير صحيح أو منتهٍ' });
  const result = checkEmailCode(user, 'reset', code, true);
  if (!result.rec) return res.status(result.status).json({ error: result.error });
  const pwErr = passwordError(newPassword);
  if (pwErr) return res.status(400).json({ error: pwErr });
  const { salt, hash } = hashPassword(String(newPassword));
  user.salt = salt;
  user.hash = hash;
  store.saveUser();
  store.deleteEmailCode(user.id, 'reset');
  store.deleteSessionsForUser(user.id, null);
  res.json({ ok: true });
});

// ---------- إشعارات Push: المفتاح العام والاشتراك/إلغاؤه ----------
// كلها بمصادقة. عند غياب مفاتيح VAPID ترجع 503 (الإشعارات غير مفعّلة بعد).
const PUSH_DISABLED_ERROR = 'إشعارات Push غير مفعّلة بعد';
function validPushSubscription(sub) {
  return !!sub && typeof sub === 'object'
    && typeof sub.endpoint === 'string' && sub.endpoint.length > 0
    && !!sub.keys && typeof sub.keys === 'object'
    && typeof sub.keys.p256dh === 'string' && sub.keys.p256dh.length > 0
    && typeof sub.keys.auth === 'string' && sub.keys.auth.length > 0;
}

app.get('/api/push/public-key', requireAuth, (req, res) => {
  if (!PUSH_ENABLED) return res.status(503).json({ error: PUSH_DISABLED_ERROR });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', requireAuth, (req, res) => {
  if (!PUSH_ENABLED) return res.status(503).json({ error: PUSH_DISABLED_ERROR });
  const sub = (req.body || {}).subscription;
  if (!validPushSubscription(sub)) {
    return res.status(400).json({ error: 'اشتراك Push غير صالح' });
  }
  // يُحفَظ نسخة مُنقّاة فقط (endpoint + المفتاحان + انتهاء اختياري)
  store.addPushSubscription(req.user.id, {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    expirationTime: typeof sub.expirationTime === 'number' ? sub.expirationTime : null,
  });
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  if (!PUSH_ENABLED) return res.status(503).json({ error: PUSH_DISABLED_ERROR });
  const endpoint = String((req.body || {}).endpoint || '');
  if (endpoint) store.removePushSubscription(req.user.id, endpoint);
  res.json({ ok: true });
});

// ---------- دليل المستخدمين ----------
app.get('/api/users', requireAuth, (req, res) => {
  res.json({ users: store.listUsers(req.user.id, req.query.q || '') });
});

// عرض ملف مستخدم واحد: الاسم + رابط الصورة الشخصية (أو null) + حالة الاتصال الآن
app.get('/api/users/:username', requireAuth, (req, res) => {
  const u = store.getUserByUsername(req.params.username);
  if (!u) return res.status(404).json({ error: 'المستخدم غير موجود' });
  res.json({ username: u.username, avatar: store.avatarUrl(u), online: isUserOnline(u.id) });
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
// scope=everyone: للمرسِل فقط — تختفي الرسالة عن الطرفين وتظهر كنص بديل (tombstone)،
//   لكن محتواها الأصلي كاملاً (النص وملف الوسائط) يبقى محفوظاً للمالك وحده في لوحة
//   البيانات: يُضبط deleted/deletedAt ويبقى سجل الرسالة وملفها كما هما، ويُعلَّم
//   الملف كمُحتجَز (retained) فلا يُقدَّم بعدها إلا بجلسة المالك.
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
      msg.deleted = true;
      msg.deletedAt = Date.now();
      store.saveMessage();
      if (msg.fileId) store.markUploadRetained(msg.fileId);
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

// ---------- لوحة بيانات المالك (Admin) ----------
// متاحة فقط عندما يُضبط ADMIN_USERNAME في البيئة ويطابق اسم مستخدم الجلسة بدقّة.
// بدون الضبط ترجع كل النقاط 404 (كأنها غير موجودة)، ولغير المالك 403.
function requireAdmin(req, res, next) {
  if (!ADMIN_USERNAME) return res.status(404).json({ error: 'غير موجود' });
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: 'غير مصرح — سجّل الدخول أولاً' });
  if (user.username !== ADMIN_USERNAME) return res.status(403).json({ error: 'صلاحيات غير كافية' });
  req.user = user;
  next();
}
// نص معاينة لآخر رسالة — يطابق منطق الواجهة (previewText)
function previewTextOf(m) {
  if (!m) return '';
  if (m.deleted) return '🚫 تم حذف هذه الرسالة';
  if (m.kind === 'image') return '📷 صورة';
  if (m.kind === 'video') return '🎥 فيديو';
  if (m.kind === 'voice') return '🎤 رسالة صوتية';
  return m.text || ''; // سجلات المكالمات (kind=call) نصّها جاهز كعنوان
}
// مسلسِل رسالة للمالك: كل الحقول — بما فيها المحذوفة لدى الجميع ومعلومات الإخفاء،
// وروابط ملفات الوسائط ما دامت الرسالة تحتفظ بمرجع ملفها.
function adminMessage(m) {
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
    deletedAt: m.deletedAt || null,
    hiddenFor: (Array.isArray(m.hiddenFor) ? m.hiddenFor : []).map((id) => {
      const u = store.getUserById(id);
      return u ? u.username : id;
    }),
  };
  if (m.fileId) {
    out.fileId = m.fileId;
    out.fileUrl = '/files/' + m.fileId;
    out.mime = m.mime || null;
    out.size = m.size || null;
    out.durationSec = m.durationSec || null;
  }
  return out;
}

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const uploads = store.listUploads();
  res.json({
    users: store.listAllUsers().length,
    messages: store.getAllMessages().length,
    uploads: uploads.length,
    uploadBytes: uploads.reduce((sum, u) => sum + (u.size || 0), 0),
  });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = store.listAllUsers()
    .map((u) => ({ username: u.username, avatar: store.avatarUrl(u), online: isUserOnline(u.id), createdAt: u.createdAt, email: u.emailVerified && u.email ? u.email : null }))
    .sort((a, b) => a.username.localeCompare(b.username));
  res.json({ users });
});

app.get('/api/admin/conversations', requireAdmin, (req, res) => {
  const byPair = new Map(); // "idA|idB" (مرتبة) -> { aId, bId, count, last }
  for (const m of store.getAllMessages()) {
    const [aId, bId] = [m.fromId, m.toId].sort();
    const key = aId + '|' + bId;
    if (!byPair.has(key)) byPair.set(key, { aId, bId, count: 0, last: null });
    const row = byPair.get(key);
    row.count += 1; // يشمل سجلات المكالمات (kind=call) كأي رسالة
    if (!row.last || m.ts >= row.last.ts) row.last = m;
  }
  const conversations = [];
  for (const row of byPair.values()) {
    const a = store.getUserById(row.aId);
    const b = store.getUserById(row.bId);
    if (!a || !b) continue;
    conversations.push({
      a: a.username,
      b: b.username,
      count: row.count,
      lastText: previewTextOf(row.last),
      lastAt: row.last ? row.last.ts : null,
    });
  }
  conversations.sort((x, y) => (y.lastAt || 0) - (x.lastAt || 0));
  res.json({ conversations });
});

app.get('/api/admin/messages', requireAdmin, (req, res) => {
  const a = req.query.a ? store.getUserByUsername(String(req.query.a)) : null;
  const b = req.query.b ? store.getUserByUsername(String(req.query.b)) : null;
  if (!a || !b) return res.status(404).json({ error: 'المستخدم غير موجود' });
  const messages = store.getConversation(a.id, b.id).map(adminMessage);
  res.json({ a: a.username, b: b.username, messages });
});

app.get('/api/admin/uploads', requireAdmin, (req, res) => {
  const uploads = store.listUploads()
    .map((u) => {
      const owner = store.getUserById(u.ownerId);
      return {
        id: u.id,
        owner: owner ? owner.username : null,
        mime: u.mime,
        size: u.size,
        createdAt: u.ts || null,
        url: '/files/' + u.id,
        retained: !!u.retained,
      };
    })
    .sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
  res.json({ uploads });
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

// هل يحمل الطلب جلسة مالك صالحة؟ الرمز إما في ترويسة Authorization أو في
// الاستعلام ?t= (حتى تستطيع لوحة البيانات تحميل الملف عبر <img>/<video>).
// المطابقة دقيقة: اسم مستخدم الجلسة يجب أن يساوي ADMIN_USERNAME تماماً.
function hasAdminToken(req) {
  if (!ADMIN_USERNAME) return false;
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.t ? String(req.query.t) : null);
  if (!token) return false;
  const userId = store.getUserIdByToken(token);
  const user = userId ? store.getUserById(userId) : null;
  return !!user && user.username === ADMIN_USERNAME;
}

// تقديم الملف الأصلي كما رُفع، مع دعم Range الأساسي لتشغيل الفيديو والتنقل فيه.
// الملفات المُحتجَزة (رسالتها حُذفت لدى الجميع) لا تُقدَّم إلا للمالك — 404 لغيره.
app.get('/files/:id', (req, res) => {
  const id = req.params.id;
  if (!/^[a-f0-9]{32}$/.test(id)) return res.status(404).json({ error: 'الملف غير موجود' });
  const meta = store.getUpload(id);
  if (!meta) return res.status(404).json({ error: 'الملف غير موجود' });
  if (meta.retained && !hasAdminToken(req)) {
    return res.status(404).json({ error: 'الملف غير موجود' });
  }
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
function isUserOnline(userId) {
  const set = connections.get(userId);
  return !!set && set.size > 0;
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
  else {
    // المستقبِل غير متصل الآن: إشعار Push (إن كان مشتركاً) — بلا أي نص من الرسالة
    sendPush(toUser.id, {
      type: 'message',
      from: fromUser.username,
      title: fromUser.username,
      body: 'أرسل لك رسالة جديدة',
    });
  }
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
      // المدعو غير متصل: إشعار Push بالمكالمة الواردة (إن كان مشتركاً)
      sendPush(to.id, {
        type: 'call',
        from: me.username,
        title: me.username,
        body: 'مكالمة واردة',
      });
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

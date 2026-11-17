'use strict';
/**
 * إرسال البريد — دون أي اعتماديات خارجية (مكتبات Node المدمجة فقط).
 * اختيار وسيلة الإرسال (بالأولوية):
 *  أ) MAIL_OUTBOX مضبوط (اختبار/تطوير): تُلحق كل رسالة كسطر JSON
 *     {to, subject, text} في ذلك الملف وتُعدّ مُرسلة.
 *  ب) SMTP2GO_API_KEY مضبوط: إرسال عبر واجهة SMTP2GO البرمجية (HTTPS —
 *     المنفذ 443 لا تحجبه بيئات الاستضافة التي تحجب منافذ SMTP الصادرة).
 *     المُرسِل: MAIL_FROM، أو SMTP_USER عند غيابه.
 *  ج) MAILJET_API_KEY + MAILJET_API_SECRET مضبوطان: إرسال عبر واجهة Mailjet
 *     البرمجية (HTTPS). المُرسِل: MAIL_FROM، أو SMTP_USER عند غيابه.
 *  د) BREVO_API_KEY مضبوط: إرسال عبر واجهة Brevo البرمجية (HTTPS).
 *     المُرسِل: MAIL_FROM، أو SMTP_USER عند غيابه.
 *  هـ) SMTP_USER + SMTP_PASS مضبوطان: إرسال SMTP حقيقي (Gmail افتراضياً) —
 *     TLS ضمني على المنفذ 465، أو STARTTLS على 587 عند ضبط SMTP_PORT=587.
 *  و) غير ذلك: البريد معطّل — mailEnabled() ترجع false.
 */
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_OUTBOX = process.env.MAIL_OUTBOX || '';
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const BREVO_API_URL = process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email';
const MAILJET_API_KEY = process.env.MAILJET_API_KEY || '';
const MAILJET_API_SECRET = process.env.MAILJET_API_SECRET || '';
const MAILJET_API_URL = process.env.MAILJET_API_URL || 'https://api.mailjet.com/v3.1/send';
const SMTP2GO_API_KEY = process.env.SMTP2GO_API_KEY || '';
const SMTP2GO_API_URL = process.env.SMTP2GO_API_URL || 'https://api.smtp2go.com/v3/email/send';
const MAIL_FROM = process.env.MAIL_FROM || '';

function mailEnabled() {
  return !!MAIL_OUTBOX || !!SMTP2GO_API_KEY || !!(MAILJET_API_KEY && MAILJET_API_SECRET) || !!BREVO_API_KEY || !!(SMTP_USER && SMTP_PASS);
}

// ---------- عميل SMTP مصغّر ----------
class SmtpConn {
  constructor() {
    this.buf = '';
    this.lines = [];       // أسطر كاملة بانتظار قارئ
    this.lineWaiters = []; // وعود تنتظر سطراً
    this.dead = null;      // خطأ قاتل (إغلاق/مهلة) يفشل كل الانتظارات
  }
  attach(sock) {
    this.sock = sock;
    sock.setTimeout(20000, () => {
      this._fail(new Error('انتهت مهلة اتصال SMTP'));
      sock.destroy();
    });
    sock.on('data', (chunk) => {
      this.buf += chunk.toString('utf8');
      let idx;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx).replace(/\r$/, '');
        this.buf = this.buf.slice(idx + 1);
        const w = this.lineWaiters.shift();
        if (w) w.resolve(line);
        else this.lines.push(line);
      }
    });
    sock.on('error', (err) => this._fail(err));
    sock.on('close', () => this._fail(new Error('أُغلق اتصال SMTP')));
  }
  _fail(err) {
    if (this.dead) return;
    this.dead = err;
    // تشخيص: يُسجَّل سبب فشل الاتصال فقط (لا بيانات اعتماد إطلاقاً)
    console.error('[mail] connection failed:', (err && (err.code || err.message)) || err);
    for (const w of this.lineWaiters.splice(0)) w.reject(err);
  }
  readLine() {
    if (this.dead) return Promise.reject(this.dead);
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    return new Promise((resolve, reject) => this.lineWaiters.push({ resolve, reject }));
  }
  /** قراءة ردّ كامل: أسطر «NNN-...» متابعة، وسطر «NNN ...» (أو «NNN») أخير. */
  async readResponse() {
    const lines = [];
    for (;;) {
      const line = await this.readLine();
      lines.push(line);
      const m = /^(\d{3})([ -]?)/.exec(line);
      if (m && m[2] !== '-') return { code: Number(m[1]), lines };
      if (!m) return { code: 0, lines }; // سطر غير متوقع — نعيده كما هو ليفشل الفحص أعلاه
    }
  }
  send(line) {
    this.sock.write(line + '\r\n');
  }
  async cmd(line, expected, what) {
    if (line != null) this.send(line);
    const res = await this.readResponse();
    const ok = Array.isArray(expected) ? expected.includes(res.code) : res.code === expected;
    if (!ok) throw new Error(`فشل خطوة SMTP (${what}): ردّ ${res.code}`);
    return res;
  }
  close() {
    try { this.sock.destroy(); } catch {}
  }
}

function encodeWord(text) {
  // ترويسة Subject: ASCII كما هي، وغير ذلك Encoded-Word بترميز UTF-8/Base64
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return '=?UTF-8?B?' + Buffer.from(text, 'utf8').toString('base64') + '?=';
}
function base64Wrap(text) {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  return (b64.match(/.{1,76}/g) || []).join('\r\n');
}

async function sendViaSmtp({ to, subject, text }) {
  const startTls = SMTP_PORT === 587;
  const conn = new SmtpConn();
  try {
    if (startTls) {
      const plain = await new Promise((resolve, reject) => {
        const s = net.connect(SMTP_PORT, SMTP_HOST);
        s.once('connect', () => resolve(s));
        s.once('error', reject);
      });
      conn.attach(plain);
      await conn.cmd(null, 220, 'الترحيب');
      await conn.cmd(`EHLO ${SMTP_HOST}`, 250, 'EHLO');
      await conn.cmd('STARTTLS', 220, 'STARTTLS');
      plain.removeAllListeners('data');
      const secure = await new Promise((resolve, reject) => {
        const s = tls.connect({ socket: plain, servername: SMTP_HOST });
        s.once('secureConnect', () => resolve(s));
        s.once('error', reject);
      });
      conn.attach(secure);
      await conn.cmd(`EHLO ${SMTP_HOST}`, 250, 'EHLO بعد STARTTLS');
    } else {
      const secure = await new Promise((resolve, reject) => {
        const s = tls.connect({ port: SMTP_PORT, host: SMTP_HOST, servername: SMTP_HOST });
        s.once('secureConnect', () => resolve(s));
        s.once('error', reject);
      });
      conn.attach(secure);
      await conn.cmd(null, 220, 'الترحيب');
      await conn.cmd(`EHLO ${SMTP_HOST}`, 250, 'EHLO');
    }
    await conn.cmd('AUTH LOGIN', 334, 'بدء المصادقة');
    await conn.cmd(Buffer.from(SMTP_USER, 'utf8').toString('base64'), 334, 'اسم مستخدم SMTP');
    await conn.cmd(Buffer.from(SMTP_PASS, 'utf8').toString('base64'), 235, 'كلمة سر SMTP');
    await conn.cmd(`MAIL FROM:<${SMTP_USER}>`, 250, 'المُرسِل');
    await conn.cmd(`RCPT TO:<${to}>`, [250, 251], 'المستقبِل');
    await conn.cmd('DATA', 354, 'بدء البيانات');
    const message = [
      `From: ${SMTP_USER}`,
      `To: ${to}`,
      `Subject: ${encodeWord(subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Wrap(text),
    ].join('\r\n');
    await conn.cmd(message + '\r\n.', 250, 'جسم الرسالة');
    try { await conn.cmd('QUIT', [221, 250], 'الإنهاء'); } catch {}
  } finally {
    conn.close();
  }
}

// ---------- إرسال عبر واجهة SMTP2GO البرمجية (HTTPS) ----------
// POST JSON إلى SMTP2GO_API_URL بترويسة X-Smtp2go-Api-Key. يُختار بروتوكول
// الطلب من رابط الواجهة نفسه (https افتراضياً؛ http مسموح لاختبار وهمي محلي
// فقط). النجاح: HTTP 200 و data.succeeded >= 1 في الردّ، بلا data.failed
// وبلا حقل خطأ. لا يُسجَّل مفتاح API ولا نص الرسالة/الرمز في أي مكان.
async function sendViaSmtp2go({ to, subject, text }) {
  const from = MAIL_FROM || SMTP_USER;
  if (!from) {
    const err = new Error('بريد المُرسِل غير مضبوط: اضبط MAIL_FROM (أو SMTP_USER) لاستخدام SMTP2GO');
    console.error('[mail] smtp2go failed:', err.message);
    throw err;
  }
  const payload = JSON.stringify({
    sender: from,
    to: [to],
    subject,
    text_body: text,
  });
  const url = new URL(SMTP2GO_API_URL);
  const lib = url.protocol === 'http:' ? http : https;
  const { status, body } = await new Promise((resolve, reject) => {
    const req = lib.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: url.pathname + url.search,
      headers: {
        'X-Smtp2go-Api-Key': SMTP2GO_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('انتهت مهلة اتصال SMTP2GO')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
  // استخراج نتيجة الإرسال وملخص الخطأ من الردّ (حقول الخطأ لا أسرار فيها)
  let succeeded = 0;
  let failedCount = 0;
  let errText = '';
  try {
    const parsed = JSON.parse(body || '{}');
    const data = parsed.data || {};
    if (typeof data.succeeded === 'number') succeeded = data.succeeded;
    if (typeof data.failed === 'number') failedCount = data.failed;
    const failMsgs = Array.isArray(data.failures)
      ? data.failures.map((f) => (typeof f === 'string' ? f : f && (f.error || f.message))).filter(Boolean)
      : [];
    errText = failMsgs.join('; ') || data.error || parsed.error || '';
    if (!errText && status !== 200) errText = parsed.message || '';
  } catch {}
  if (status === 200 && succeeded >= 1 && failedCount === 0 && !errText) return;
  const detail = errText || (body || '').slice(0, 200);
  console.error('[mail] smtp2go failed:', status, detail);
  throw new Error(`فشل إرسال SMTP2GO: HTTP ${status}${detail ? ' — ' + detail : ''}`);
}

// ---------- إرسال عبر واجهة Mailjet البرمجية (HTTPS) ----------
// POST JSON إلى MAILJET_API_URL بمصادقة Basic (مفتاح API + سرّه). يُختار
// بروتوكول الطلب من رابط الواجهة نفسه (https افتراضياً؛ http مسموح لاختبار
// وهمي محلي فقط). النجاح: HTTP 200/201 و — عند وجود حقل Status في الردّ —
// قيمته 'success'. لا تُسجَّل المفاتيح ولا ترويسة المصادقة ولا نص الرسالة.
async function sendViaMailjet({ to, subject, text }) {
  const from = MAIL_FROM || SMTP_USER;
  if (!from) {
    const err = new Error('بريد المُرسِل غير مضبوط: اضبط MAIL_FROM (أو SMTP_USER) لاستخدام Mailjet');
    console.error('[mail] mailjet failed:', err.message);
    throw err;
  }
  const payload = JSON.stringify({
    Messages: [{
      From: { Email: from, Name: 'رسائلي' },
      To: [{ Email: to }],
      Subject: subject,
      TextPart: text,
    }],
  });
  const url = new URL(MAILJET_API_URL);
  const lib = url.protocol === 'http:' ? http : https;
  const auth = 'Basic ' + Buffer.from(`${MAILJET_API_KEY}:${MAILJET_API_SECRET}`, 'utf8').toString('base64');
  const { status, body } = await new Promise((resolve, reject) => {
    const req = lib.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: url.pathname + url.search,
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('انتهت مهلة اتصال Mailjet')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
  // استخراج حالة الرسالة وملخص الخطأ من الردّ (حقول ErrorMessage لا أسرار فيها)
  let msgStatus = null;
  let detail = '';
  try {
    const parsed = JSON.parse(body || '{}');
    const m0 = Array.isArray(parsed.Messages) ? parsed.Messages[0] : null;
    if (m0 && typeof m0.Status === 'string') msgStatus = m0.Status;
    const errs = m0 && Array.isArray(m0.Errors) ? m0.Errors : [];
    detail = errs.map((e) => e && e.ErrorMessage).filter(Boolean).join('; ')
      || (parsed.ErrorMessage || '');
  } catch {}
  if ((status === 200 || status === 201) && (msgStatus === null || msgStatus === 'success')) return;
  if (!detail) detail = (body || '').slice(0, 200);
  console.error('[mail] mailjet failed:', status, detail);
  throw new Error(`فشل إرسال Mailjet: HTTP ${status}${detail ? ' — ' + detail : ''}`);
}

// ---------- إرسال عبر واجهة Brevo البرمجية (HTTPS) ----------
// POST JSON إلى BREVO_API_URL بترويسة api-key. يُختار بروتوكول الطلب من
// رابط الواجهة نفسه (https افتراضياً؛ http مسموح لاختبار وهمي محلي فقط).
// لا يُسجَّل مفتاح API ولا نص الرسالة/الرمز في أي مكان.
async function sendViaBrevo({ to, subject, text }) {
  const from = MAIL_FROM || SMTP_USER;
  if (!from) {
    const err = new Error('بريد المُرسِل غير مضبوط: اضبط MAIL_FROM (أو SMTP_USER) لاستخدام Brevo');
    console.error('[mail] brevo failed:', err.message);
    throw err;
  }
  const payload = JSON.stringify({
    sender: { email: from, name: 'رسائلي' },
    to: [{ email: to }],
    subject,
    textContent: text,
  });
  const url = new URL(BREVO_API_URL);
  const lib = url.protocol === 'http:' ? http : https;
  const { status, body } = await new Promise((resolve, reject) => {
    const req = lib.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: url.pathname + url.search,
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('انتهت مهلة اتصال Brevo')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
  if (status >= 200 && status < 300) return;
  // ردّ الخطأ من Brevo: حقول code/message فقط (لا أسرار فيها)
  let detail = '';
  try {
    const parsed = JSON.parse(body || '{}');
    detail = [parsed.code, parsed.message].filter(Boolean).join(': ');
  } catch {}
  if (!detail) detail = (body || '').slice(0, 200);
  console.error('[mail] brevo failed:', status, detail);
  throw new Error(`فشل إرسال Brevo: HTTP ${status}${detail ? ' — ' + detail : ''}`);
}

/** إرسال رسالة بريد — ترمي خطأً نظيفاً عند أي فشل (لا يتضمن أي بيانات حساسة). */
async function sendMail({ to, subject, text }) {
  if (MAIL_OUTBOX) {
    fs.appendFileSync(MAIL_OUTBOX, JSON.stringify({ to, subject, text }) + '\n', 'utf8');
    return;
  }
  if (!SMTP2GO_API_KEY && !(MAILJET_API_KEY && MAILJET_API_SECRET) && !BREVO_API_KEY && !(SMTP_USER && SMTP_PASS)) {
    throw new Error('إرسال البريد غير مفعّل');
  }
  try {
    if (SMTP2GO_API_KEY) await sendViaSmtp2go({ to, subject, text });
    else if (MAILJET_API_KEY && MAILJET_API_SECRET) await sendViaMailjet({ to, subject, text });
    else if (BREVO_API_KEY) await sendViaBrevo({ to, subject, text });
    else await sendViaSmtp({ to, subject, text });
  } catch (err) {
    // تشخيص: خطوة الفشل وردّ الخادم فقط — لا كلمات سر ولا رموز في السجل
    console.error('[mail] send failed:', (err && err.message) || err);
    throw err;
  }
}

module.exports = { mailEnabled, sendMail };

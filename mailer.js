'use strict';
/**
 * إرسال البريد — دون أي اعتماديات خارجية (node:net / node:tls فقط).
 * اختيار وسيلة الإرسال:
 *  أ) MAIL_OUTBOX مضبوط (اختبار/تطوير): تُلحق كل رسالة كسطر JSON
 *     {to, subject, text} في ذلك الملف وتُعدّ مُرسلة.
 *  ب) SMTP_USER + SMTP_PASS مضبوطان: إرسال SMTP حقيقي (Gmail افتراضياً) —
 *     TLS ضمني على المنفذ 465، أو STARTTLS على 587 عند ضبط SMTP_PORT=587.
 *  ج) غير ذلك: البريد معطّل — mailEnabled() ترجع false.
 */
const fs = require('fs');
const net = require('net');
const tls = require('tls');

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_OUTBOX = process.env.MAIL_OUTBOX || '';

function mailEnabled() {
  return !!MAIL_OUTBOX || !!(SMTP_USER && SMTP_PASS);
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

/** إرسال رسالة بريد — ترمي خطأً نظيفاً عند أي فشل (لا يتضمن أي بيانات حساسة). */
async function sendMail({ to, subject, text }) {
  if (MAIL_OUTBOX) {
    fs.appendFileSync(MAIL_OUTBOX, JSON.stringify({ to, subject, text }) + '\n', 'utf8');
    return;
  }
  if (!SMTP_USER || !SMTP_PASS) throw new Error('إرسال البريد غير مفعّل');
  await sendViaSmtp({ to, subject, text });
}

module.exports = { mailEnabled, sendMail };

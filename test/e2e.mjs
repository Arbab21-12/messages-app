// اختبار شامل (End-to-End) — يشغّل الخادم على منفذ اختبار مع مجلد بيانات مؤقت،
// ثم يتحقق من: التسجيل، رفض التكرار وكلمة المرور الخاطئة، الإرسال اللحظي عبر
// WebSocket، سجل المحادثة، إشعار القراءة، والرسائل أثناء عدم الاتصال، وقواعد
// الحساب الجديد (بداية اسم المستخدم وقوة كلمة المرور عند التسجيل فقط)، وطول
// الاسم 1–24 وحساسية حالة الأحرف، والصورة الشخصية، وعرض ملف مستخدم
// (GET /api/users/:username)، وتغيير اسم المستخدم (الاسم المُخلى متاح فوراً —
// لا مهلة حجز)، وإعادة التفاوض (عرض/جواب ثانٍ) أثناء مكالمة قائمة، ولوحة
// بيانات المالك (ADMIN_USERNAME=admin_test في بيئة خادم الاختبار)، واحتجاز
// المحتوى المحذوف لدى الجميع للمالك وحده (يبقى كاملاً في لوحة البيانات،
// وملفه لا يُقدَّم إلا بجلسة المالك)، وأمان الحساب: تغيير كلمة المرور (مع
// إلغاء بقية الجلسات)، وربط بريد مؤكد برمز من ٦ أرقام يُقرأ من صندوق الصادر
// (MAIL_OUTBOX)، واستعادة كلمة السر بالبريد، وتعطّل نقاط البريد (503) على
// خادم ثانٍ بلا أي إعداد بريد.
// التشغيل: npm test
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3219;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msgtest-'));
const outboxPath = path.join(dataDir, 'outbox.jsonl');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${extra}`); }
}
const api = async (p, { method = 'GET', token, body } = {}) => {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
function connectWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const inbox = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      inbox.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(msg)) { waiters[i].resolve(msg); waiters.splice(i, 1); }
      }
      if (msg.type === 'authed') resolve(api2);
    });
    ws.on('error', reject);
    const api2 = {
      ws, inbox,
      send: (o) => ws.send(JSON.stringify(o)),
      waitFor: (pred, ms = 5000) => new Promise((res, rej) => {
        const found = inbox.find(pred);
        if (found) return res(found);
        const w = { pred, resolve: res };
        waiters.push(w);
        setTimeout(() => rej(new Error('timeout waiting for WS event')), ms);
      }),
      close: () => ws.close(),
    };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(extraEnv = {}) {
  const s = spawn('node', ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  return s;
}
let server = startServer({ ADMIN_USERNAME: 'admin_test', MAIL_OUTBOX: outboxPath });

// صندوق الصادر (MAIL_OUTBOX): سطر JSON لكل رسالة — تُستخرج منه رموز التأكيد
function readOutbox() {
  try {
    return fs.readFileSync(outboxPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
function lastMailTo(email) {
  const all = readOutbox().filter((m) => m.to === email);
  return all.length ? all[all.length - 1] : null;
}
function codeFromMail(mail) {
  const m = mail && /(?<!\d)(\d{6})(?!\d)/.exec(mail.text || '');
  return m ? m[1] : null;
}
function wrongCodeFor(code) { return code === '000000' ? '111111' : '000000'; }
async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch { await wait(200); }
  }
  return false;
}

try {
  // انتظار إقلاع الخادم
  const up = await waitUp();
  if (!up) throw new Error('الخادم لم يقلع');
  console.log('الخادم أقلع — بدء الفحوصات:');

  // 1) التسجيل
  const regA = await api('/api/register', { method: 'POST', body: { username: 'omar_test', password: 'Pass1234!' } });
  check('تسجيل omar_test', regA.status === 201 && !!regA.data.token);
  const regB = await api('/api/register', { method: 'POST', body: { username: 'sara_test', password: 'Pass5678!' } });
  check('تسجيل sara_test', regB.status === 201 && !!regB.data.token);

  // 2) الرفض
  const dup = await api('/api/register', { method: 'POST', body: { username: 'omar_test', password: 'Whatever1!' } });
  check('رفض تسجيل مكرر', dup.status === 409, `status=${dup.status}`);
  const badLogin = await api('/api/login', { method: 'POST', body: { username: 'omar_test', password: 'wrong-pass' } });
  check('رفض كلمة مرور خاطئة', badLogin.status === 401, `status=${badLogin.status}`);
  const loginA = await api('/api/login', { method: 'POST', body: { username: 'omar_test', password: 'Pass1234!' } });
  check('دخول omar_test بكلمة المرور الصحيحة', loginA.status === 200 && !!loginA.data.token);
  const tokA = loginA.data.token, tokB = regB.data.token;

  // 3) البحث في الدليل
  const dir = await api('/api/users?q=sara', { token: tokA });
  check('البحث يجد sara_test ولا يعرض النفس', dir.data.users?.some((u) => u.username === 'sara_test') && !dir.data.users?.some((u) => u.username === 'omar_test'));

  // 4) اتصال WebSocket للطرفين + الحضور
  const A = await connectWs(tokA);
  const B = await connectWs(tokB);
  const presence = await A.waitFor((m) => m.type === 'presence' && m.online.includes('sara_test') && m.online.includes('omar_test')).catch(() => null);
  check('الحضور: الطرفان متصلان', !!presence);

  // 5) رسالة لحظية من A إلى B
  A.send({ type: 'send', to: 'sara_test', text: 'مرحبا سارة، هذه رسالة اختبار' });
  const live = await B.waitFor((m) => m.type === 'message' && m.message.text.includes('رسالة اختبار')).catch(() => null);
  check('B يستلم الرسالة لحظياً عبر WebSocket', !!live);

  // 6) السجل عند B
  await wait(200);
  const histB = await api('/api/messages/omar_test', { token: tokB });
  check('سجل B يحتوي الرسالة', histB.data.messages?.some((m) => m.text.includes('رسالة اختبار')));
  const unread = await api('/api/conversations', { token: tokB });
  check('عدّاد غير المقروء عند B = 1', unread.data.conversations?.find((c) => c.username === 'omar_test')?.unread === 1);

  // 7) B يعلّم كمقروء — A يستلم إشعار القراءة
  B.send({ type: 'read', with: 'omar_test' });
  const receipt = await A.waitFor((m) => m.type === 'read_receipt' && m.with === 'sara_test').catch(() => null);
  check('A يستلم إشعار القراءة عبر WebSocket', !!receipt && receipt.messageIds.length >= 1);
  const histA = await api('/api/messages/sara_test', { token: tokA });
  check('الرسالة في سجل A أصبحت مقروءة (readAt)', histA.data.messages?.find((m) => m.text.includes('رسالة اختبار'))?.readAt != null);

  // 8) رسالة أثناء غياب B — تُحفظ وتظهر بعد عودته
  B.close();
  await wait(400);
  A.send({ type: 'send', to: 'sara_test', text: 'رسالة أثناء غيابك' });
  await wait(300);
  const loginB2 = await api('/api/login', { method: 'POST', body: { username: 'sara_test', password: 'Pass5678!' } });
  const histB2 = await api('/api/messages/omar_test', { token: loginB2.data.token });
  check('الرسالة المرسلة أثناء الغياب محفوظة وتظهر في سجل B بعد عودته',
    histB2.data.messages?.some((m) => m.text.includes('أثناء غيابك')));

  // 9) المكالمات — إشارات WebRTC عبر الخادم
  const B2 = await connectWs(loginB2.data.token);
  await wait(200);

  A.send({ type: 'call_invite', to: 'sara_test', callType: 'video' });
  const invite = await B2.waitFor((m) => m.type === 'call_invite' && m.from === 'omar_test').catch(() => null);
  check('B يستلم دعوة مكالمة فيديو من A', !!invite && invite.callType === 'video');

  B2.send({ type: 'call_accept', to: 'omar_test' });
  const accepted = await A.waitFor((m) => m.type === 'call_accept' && m.from === 'sara_test').catch(() => null);
  check('A يستلم قبول المكالمة من B', !!accepted);

  A.send({ type: 'call_offer', to: 'sara_test', sdp: { type: 'offer', sdp: 'FAKE_OFFER_SDP' } });
  const offer = await B2.waitFor((m) => m.type === 'call_offer').catch(() => null);
  check('العرض SDP يصل إلى B سليماً', !!offer && offer.from === 'omar_test' && offer.sdp?.sdp === 'FAKE_OFFER_SDP');

  B2.send({ type: 'call_answer', to: 'omar_test', sdp: { type: 'answer', sdp: 'FAKE_ANSWER_SDP' } });
  const answer = await A.waitFor((m) => m.type === 'call_answer').catch(() => null);
  check('الجواب SDP يصل إلى A سليماً', !!answer && answer.from === 'sara_test' && answer.sdp?.sdp === 'FAKE_ANSWER_SDP');

  const iceCand = { candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 };
  A.send({ type: 'call_ice', to: 'sara_test', candidate: iceCand });
  const iceB = await B2.waitFor((m) => m.type === 'call_ice').catch(() => null);
  check('مرشح ICE من A يصل إلى B سليماً', !!iceB && iceB.candidate?.candidate === iceCand.candidate);
  B2.send({ type: 'call_ice', to: 'omar_test', candidate: iceCand });
  const iceA = await A.waitFor((m) => m.type === 'call_ice').catch(() => null);
  check('مرشح ICE من B يصل إلى A سليماً', !!iceA && iceA.candidate?.candidate === iceCand.candidate);

  // إعادة تفاوض أثناء مكالمة قائمة (ترقية صوت→فيديو): عرض/جواب ثانٍ يُمرَّر بين الطرفين
  A.send({ type: 'call_offer', to: 'sara_test', sdp: { type: 'offer', sdp: 'FAKE_RENEGO_OFFER' } });
  const renegoOffer = await B2.waitFor((m) => m.type === 'call_offer' && m.sdp?.sdp === 'FAKE_RENEGO_OFFER').catch(() => null);
  check('عرض إعادة التفاوض أثناء المكالمة يصل إلى B سليماً', !!renegoOffer && renegoOffer.from === 'omar_test');
  B2.send({ type: 'call_answer', to: 'omar_test', sdp: { type: 'answer', sdp: 'FAKE_RENEGO_ANSWER' } });
  const renegoAnswer = await A.waitFor((m) => m.type === 'call_answer' && m.sdp?.sdp === 'FAKE_RENEGO_ANSWER').catch(() => null);
  check('جواب إعادة التفاوض أثناء المكالمة يصل إلى A سليماً', !!renegoAnswer && renegoAnswer.from === 'sara_test');

  // إنهاء مكالمة متصلة مع مدة 125 ثانية → سجل واحد فقط يذكر «02:05»
  A.send({ type: 'call_end', to: 'sara_test', duration: 125 });
  const ended = await B2.waitFor((m) => m.type === 'call_end' && m.from === 'omar_test').catch(() => null);
  check('B يستلم إنهاء المكالمة', !!ended);
  await wait(300);
  const histCallsA = await api('/api/messages/sara_test', { token: tokA });
  const callRecsA = (histCallsA.data.messages || []).filter((m) => m.kind === 'call');
  check('سجل المكالمات عند A يحتوي سجلاً واحداً فقط', callRecsA.length === 1, `count=${callRecsA.length}`);
  check('سجل المكالمة يذكر المدة 02:05', callRecsA.length === 1 && callRecsA[0].text.includes('02:05'), callRecsA[0]?.text || '');
  const histCallsB = await api('/api/messages/omar_test', { token: loginB2.data.token });
  const callRecsB = (histCallsB.data.messages || []).filter((m) => m.kind === 'call');
  check('نفس سجل المكالمة ظاهر في سجل B', callRecsB.length === 1 && callRecsB[0].text.includes('02:05'));

  // مسار الرفض: دعوة صوتية جديدة ثم رفض من B
  A.send({ type: 'call_invite', to: 'sara_test', callType: 'voice' });
  const invite2 = await B2.waitFor((m) => m.type === 'call_invite' && m.callType === 'voice').catch(() => null);
  check('B يستلم دعوة المكالمة الصوتية الثانية', !!invite2);
  B2.send({ type: 'call_reject', to: 'omar_test' });
  const rejected = await A.waitFor((m) => m.type === 'call_reject' && m.from === 'sara_test').catch(() => null);
  check('A يستلم رفض المكالمة من B', !!rejected);
  await wait(300);
  const histCallsA2 = await api('/api/messages/sara_test', { token: tokA });
  const callRecsA2 = (histCallsA2.data.messages || []).filter((m) => m.kind === 'call');
  check('سجل الرفض أُضيف مرة واحدة (مرفوضة)', callRecsA2.length === 2 && callRecsA2[1].text.includes('مرفوضة'), `count=${callRecsA2.length}`);

  // مسار عدم الاتصال: مستخدم مسجّل لكنه غير متصل → call_unavailable + سجل «فائتة»
  const regC = await api('/api/register', { method: 'POST', body: { username: 'carol_test', password: 'Pass9999!' } });
  check('تسجيل carol_test (غير متصلة)', regC.status === 201);
  A.send({ type: 'call_invite', to: 'carol_test', callType: 'voice' });
  const unavail = await A.waitFor((m) => m.type === 'call_unavailable' && m.with === 'carol_test').catch(() => null);
  check('A يستلم call_unavailable عند الاتصال بمستخدم غير متصل', !!unavail);
  await wait(300);
  const histCarol = await api('/api/messages/carol_test', { token: tokA });
  const carolRecs = (histCarol.data.messages || []).filter((m) => m.kind === 'call');
  check('سجل مكالمة فائتة محفوظ في محادثة carol_test', carolRecs.length === 1 && carolRecs[0].text.includes('فائتة'), `count=${carolRecs.length}`);

  // 10) رفع الملفات + رسائل الوسائط + حذف الرسائل
  const uploadRaw = async (bytes, { token, mime, name = 'file' } = {}) => {
    const res = await fetch(BASE + '/api/upload', {
      method: 'POST',
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': mime, 'X-File-Name': name },
      body: bytes,
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  const getFileRaw = async (url) => {
    const res = await fetch(BASE + url);
    return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || '' };
  };
  const tokB2 = loginB2.data.token;
  const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

  const upNoAuth = await uploadRaw(PNG_BYTES, { mime: 'image/png', name: 'x.png' });
  check('الرفع بدون مصادقة يُرفض 401', upNoAuth.status === 401, `status=${upNoAuth.status}`);
  const upBadMime = await uploadRaw(Buffer.from('<html>hi</html>'), { token: tokA, mime: 'text/html', name: 'x.html' });
  check('الرفع بنوع MIME غير مسموح يُرفض 400', upBadMime.status === 400, `status=${upBadMime.status}`);
  const upPng = await uploadRaw(PNG_BYTES, { token: tokA, mime: 'image/png', name: 'pixel.png' });
  check('رفع PNG ناجح ويعيد fileId', upPng.status === 201 && !!upPng.data.fileId, `status=${upPng.status}`);
  const gotFile = await getFileRaw('/files/' + upPng.data.fileId);
  check('GET /files يعيد نفس البايتات ونوع المحتوى الصحيح',
    gotFile.status === 200 && gotFile.buf.equals(PNG_BYTES) && gotFile.type.includes('image/png'),
    `status=${gotFile.status} type=${gotFile.type}`);

  // رسالة صورة لحظياً عبر WebSocket
  A.send({ type: 'send', to: 'sara_test', kind: 'image', fileId: upPng.data.fileId });
  const imgLive = await B2.waitFor((m) => m.type === 'message' && m.message.kind === 'image').catch(() => null);
  check('B يستلم رسالة الصورة لحظياً (kind=image + fileId)', !!imgLive && imgLive.message.fileId === upPng.data.fileId);
  await wait(200);
  const histImgB = await api('/api/messages/omar_test', { token: tokB2 });
  check('سجل B يحتوي رسالة الصورة', histImgB.data.messages?.some((m) => m.kind === 'image' && m.fileId === upPng.data.fileId));

  // رسالة صوتية: رفع + إرسال عبر REST بنفس مسار الوسائط
  const upVoice = await uploadRaw(Buffer.from('FAKE_WEBM_AUDIO_BYTES'), { token: tokA, mime: 'audio/webm', name: 'voice.webm' });
  check('رفع ملف صوتي ناجح', upVoice.status === 201 && !!upVoice.data.fileId, `status=${upVoice.status}`);
  const voiceMsg = await api('/api/messages/sara_test', { method: 'POST', token: tokA, body: { kind: 'voice', fileId: upVoice.data.fileId, durationSec: 7 } });
  check('إرسال رسالة صوتية (REST) بنوع voice والمدة 7',
    voiceMsg.status === 201 && voiceMsg.data.message?.kind === 'voice' && voiceMsg.data.message?.durationSec === 7,
    `status=${voiceMsg.status}`);

  // حذف لدى الجميع: غير المرسل يُرفض 403 — المرسل ينجح — B يستلم الحدث ويرى النص البديل
  A.send({ type: 'send', to: 'sara_test', text: 'رسالة اختبار الحذف للجميع' });
  const delTarget = await B2.waitFor((m) => m.type === 'message' && m.message.text.includes('اختبار الحذف للجميع')).catch(() => null);
  check('B استلم رسالة اختبار الحذف', !!delTarget);
  const delId = delTarget?.message?.id;
  const delByB = await api('/api/messages/' + delId, { method: 'DELETE', token: tokB2, body: { scope: 'everyone' } });
  check('حذف لدى الجميع من غير المرسل يُرفض 403', delByB.status === 403, `status=${delByB.status}`);
  const delByA = await api('/api/messages/' + delId, { method: 'DELETE', token: tokA, body: { scope: 'everyone' } });
  check('المرسل يحذف رسالته لدى الجميع (200)', delByA.status === 200, `status=${delByA.status}`);
  const delEvent = await B2.waitFor((m) => m.type === 'message_deleted' && m.id === delId && m.scope === 'everyone').catch(() => null);
  check('B يستلم حدث message_deleted', !!delEvent);
  await wait(200);
  const histDelB = await api('/api/messages/omar_test', { token: tokB2 });
  const tomb = histDelB.data.messages?.find((m) => m.id === delId);
  check('سجل B يعرض النص البديل (deleted وبدون نص)', !!tomb && tomb.deleted === true && !tomb.text, JSON.stringify(tomb || {}));

  // حذف لديّ: تختفي من سجل B وتبقى عند A
  A.send({ type: 'send', to: 'sara_test', text: 'رسالة للحذف لدى المستلم فقط' });
  const meTarget = await B2.waitFor((m) => m.type === 'message' && m.message.text.includes('للحذف لدى المستلم فقط')).catch(() => null);
  check('B استلم رسالة الحذف الشخصي', !!meTarget);
  const meId = meTarget?.message?.id;
  const delMe = await api('/api/messages/' + meId, { method: 'DELETE', token: tokB2, body: { scope: 'me' } });
  check('B يحذف الرسالة لديه فقط (200)', delMe.status === 200, `status=${delMe.status}`);
  await wait(200);
  const histMeB = await api('/api/messages/omar_test', { token: tokB2 });
  check('الرسالة اختفت من سجل B', !histMeB.data.messages?.some((m) => m.id === meId));
  const histMeA = await api('/api/messages/sara_test', { token: tokA });
  check('الرسالة ما زالت في سجل A', histMeA.data.messages?.some((m) => m.id === meId));

  // 11) قواعد الحساب الجديد: اسم مستخدم يبدأ بحرف/رقم + كلمة مرور قوية (عند التسجيل فقط)
  const STRONG = 'Test1234!';
  const badStart1 = await api('/api/register', { method: 'POST', body: { username: '_baduser', password: STRONG } });
  check('اسم يبدأ بـ _ يُرفض 400 مع رسالة البداية', badStart1.status === 400 && (badStart1.data.error || '').includes('يبدأ بحرف أو رقم'), `status=${badStart1.status}`);
  const badStart2 = await api('/api/register', { method: 'POST', body: { username: '.baduser', password: STRONG } });
  check('اسم يبدأ بـ . يُرفض 400', badStart2.status === 400, `status=${badStart2.status}`);
  const digitStart = await api('/api/register', { method: 'POST', body: { username: '9user_x', password: STRONG } });
  check('اسم يبدأ برقم (9user_x) مع كلمة قوية ينجح', digitStart.status === 201 && !!digitStart.data.token, `status=${digitStart.status}`);
  const twoChars = await api('/api/register', { method: 'POST', body: { username: 'ab', password: STRONG } });
  check('اسم من حرفين (ab) صالح الآن وينجح', twoChars.status === 201 && !!twoChars.data.token, `status=${twoChars.status}`);
  const dupMsg = await api('/api/register', { method: 'POST', body: { username: 'omar_test', password: STRONG } });
  check('اسم مكرر يُرفض مع رسالة «مستخدم من قبل، اختر اسماً آخر»',
    dupMsg.status === 409 && (dupMsg.data.error || '').includes('مستخدم من قبل، اختر اسماً آخر'),
    `status=${dupMsg.status} err=${dupMsg.data.error || ''}`);

  // كلمات مرور ضعيفة على اسم جديد واحد (الرفض لا يُنشئ حساباً، فيُعاد استخدام الاسم)
  const pwUser = 'pw_user1';
  const weak1 = await api('/api/register', { method: 'POST', body: { username: pwUser, password: 'ab1!' } });
  check('كلمة «ab1!» (حروف أقل من ٤) تُرفض 400 مع رسالة كلمة المرور', weak1.status === 400 && (weak1.data.error || '').includes('كلمة المرور'), `status=${weak1.status}`);
  const weak2 = await api('/api/register', { method: 'POST', body: { username: pwUser, password: 'abcd1234' } });
  check('كلمة «abcd1234» (بدون رمز) تُرفض 400', weak2.status === 400, `status=${weak2.status}`);
  const weak3 = await api('/api/register', { method: 'POST', body: { username: pwUser, password: 'abcd!@#$' } });
  check('كلمة «abcd!@#$» (بدون رقم) تُرفض 400', weak3.status === 400, `status=${weak3.status}`);
  const strongReg = await api('/api/register', { method: 'POST', body: { username: pwUser, password: 'abcd123!' } });
  check('كلمة «abcd123!» (٤ حروف + رقم + رمز) تنجح', strongReg.status === 201 && !!strongReg.data.token, `status=${strongReg.status}`);
  const strongLogin = await api('/api/login', { method: 'POST', body: { username: pwUser, password: 'abcd123!' } });
  check('الدخول بالحساب ذي الكلمة القوية يعمل', strongLogin.status === 200 && !!strongLogin.data.token, `status=${strongLogin.status}`);

  // 12) طول الاسم 1–24 + حساسية حالة الأحرف في الهوية (مطابقة دقيقة)
  const oneCharA = await api('/api/register', { method: 'POST', body: { username: 'A', password: STRONG } });
  check('اسم من حرف واحد (A) ينجح', oneCharA.status === 201 && !!oneCharA.data.token, `status=${oneCharA.status}`);
  const oneChar7 = await api('/api/register', { method: 'POST', body: { username: '7', password: STRONG } });
  check('اسم من رقم واحد (7) ينجح', oneChar7.status === 201 && !!oneChar7.data.token, `status=${oneChar7.status}`);
  const tooLong = await api('/api/register', { method: 'POST', body: { username: 'a'.repeat(25), password: STRONG } });
  check('اسم من ٢٥ حرفاً يُرفض 400', tooLong.status === 400, `status=${tooLong.status}`);
  const caseLow = await api('/api/register', { method: 'POST', body: { username: 'caseuser', password: 'Case1111!' } });
  check('تسجيل caseuser ينجح', caseLow.status === 201, `status=${caseLow.status}`);
  const caseUp = await api('/api/register', { method: 'POST', body: { username: 'CaseUser', password: 'Case2222!' } });
  check('تسجيل CaseUser (حالة مختلفة) ينجح كحساب منفصل', caseUp.status === 201 && !!caseUp.data.token, `status=${caseUp.status}`);
  const caseLogin = await api('/api/login', { method: 'POST', body: { username: 'CaseUser', password: 'Case2222!' } });
  check('الدخول كـ CaseUser بنفس حالة الأحرف وكلمته يعمل', caseLogin.status === 200 && caseLogin.data.user?.username === 'CaseUser', `status=${caseLogin.status}`);
  const caseCross = await api('/api/login', { method: 'POST', body: { username: 'caseuser', password: 'Case2222!' } });
  check('كلمة CaseUser لا تفتح حساب caseuser (حسابان منفصلان)', caseCross.status === 401, `status=${caseCross.status}`);
  const caseWrongCase = await api('/api/login', { method: 'POST', body: { username: 'CASEUSER', password: 'Case1111!' } });
  check('الدخول بحالة أحرف غير المسجّلة (CASEUSER) يُرفض 401', caseWrongCase.status === 401, `status=${caseWrongCase.status}`);

  // 13) الصورة الشخصية: رفع + تعيين + ظهورها في /api/me والدليل والمحادثات
  const upAvatar = await uploadRaw(PNG_BYTES, { token: tokA, mime: 'image/png', name: 'avatar.png' });
  check('رفع صورة للصورة الشخصية ناجح', upAvatar.status === 201 && !!upAvatar.data.fileId, `status=${upAvatar.status}`);
  const avatarUrl = '/files/' + upAvatar.data.fileId;
  const setAvatar = await api('/api/me/avatar', { method: 'POST', token: tokA, body: { fileId: upAvatar.data.fileId } });
  check('تعيين الصورة الشخصية ينجح ويعيد رابطها', setAvatar.status === 200 && setAvatar.data.user?.avatar === avatarUrl, `status=${setAvatar.status} avatar=${setAvatar.data.user?.avatar}`);
  const meAfterAvatar = await api('/api/me', { token: tokA });
  check('/api/me يعرض الصورة الشخصية', meAfterAvatar.data.user?.avatar === avatarUrl, `avatar=${meAfterAvatar.data.user?.avatar}`);
  const dirAvatar = await api('/api/users?q=omar_test', { token: tokB2 });
  check('الدليل يعرض صورة omar_test للمستخدمين الآخرين', dirAvatar.data.users?.find((u) => u.username === 'omar_test')?.avatar === avatarUrl);
  const convsAvatar = await api('/api/conversations', { token: tokB2 });
  check('قائمة المحادثات تتضمن صورة الطرف الآخر', convsAvatar.data.conversations?.find((c) => c.username === 'omar_test')?.avatar === avatarUrl);
  const gotAvatar = await getFileRaw(avatarUrl);
  check('رابط الصورة الشخصية يعيد نفس بايتات PNG', gotAvatar.status === 200 && gotAvatar.buf.equals(PNG_BYTES), `status=${gotAvatar.status}`);
  const avatarSteal = await api('/api/me/avatar', { method: 'POST', token: tokB2, body: { fileId: upAvatar.data.fileId } });
  check('تعيين ملف شخص آخر صورةً شخصية يُرفض 403', avatarSteal.status === 403, `status=${avatarSteal.status}`);
  const upAudio = await uploadRaw(Buffer.from('FAKE_WEBM_AUDIO_BYTES'), { token: tokA, mime: 'audio/webm', name: 'v.webm' });
  const avatarNonImage = await api('/api/me/avatar', { method: 'POST', token: tokA, body: { fileId: upAudio.data.fileId } });
  check('تعيين ملف غير صورة (صوت) صورةً شخصية يُرفض 400', avatarNonImage.status === 400, `status=${avatarNonImage.status}`);

  // عرض ملف مستخدم: الاسم + الصورة + حالة الاتصال (A متصل عبر WebSocket الآن)
  const profView = await api('/api/users/omar_test', { token: tokB2 });
  check('GET /api/users/:username يعرض الاسم والصورة وحالة الاتصال',
    profView.status === 200 && profView.data.username === 'omar_test' && profView.data.avatar === avatarUrl && profView.data.online === true,
    `status=${profView.status} data=${JSON.stringify(profView.data)}`);
  const prof404 = await api('/api/users/no_such_user_x', { token: tokB2 });
  check('GET /api/users/:username لمستخدم غير موجود يُرجع 404', prof404.status === 404, `status=${prof404.status}`);

  // 14) تغيير اسم المستخدم — الاسم المُخلى متاح فوراً لأي شخص (لا مهلة حجز)
  const rename1 = await api('/api/me/username', { method: 'POST', token: tokB2, body: { username: 'sara_new' } });
  check('sara_test تغيّر اسمها إلى sara_new', rename1.status === 200 && rename1.data.user?.username === 'sara_new', `status=${rename1.status}`);
  const meRenamed = await api('/api/me', { token: tokB2 });
  check('جلسة sara ما زالت صالحة و/api/me يعرض الاسم الجديد', meRenamed.data.user?.username === 'sara_new', `username=${meRenamed.data.user?.username}`);
  const convsAfterRename = await api('/api/conversations', { token: tokA });
  const convRenamed = convsAfterRename.data.conversations?.find((c) => c.username === 'sara_new');
  check('محادثات omar تعرض المحادثة بالاسم الجديد sara_new', !!convRenamed && !!convRenamed.lastMessage);
  const histRenamed = await api('/api/messages/sara_new', { token: tokA });
  check('السجل القديم سليم تحت الاسم الجديد (رسالة الاختبار موجودة)',
    histRenamed.data.messages?.some((m) => m.text.includes('رسالة اختبار')));
  const regOldName = await api('/api/register', { method: 'POST', body: { username: 'sara_test', password: STRONG } });
  check('الاسم المُخلى متاح للتسجيل فوراً بعد تغيير الاسم (لا مهلة حجز)',
    regOldName.status === 201 && !!regOldName.data.token, `status=${regOldName.status} err=${regOldName.data.error || ''}`);
  const stealNowTaken = await api('/api/me/username', { method: 'POST', token: tokA, body: { username: 'sara_test' } });
  check('تغيير الاسم إلى اسم صار مملوكاً لحساب آخر يُرفض برسالة «مستخدم من قبل»',
    stealNowTaken.status === 409 && (stealNowTaken.data.error || '').includes('مستخدم من قبل'),
    `status=${stealNowTaken.status} err=${stealNowTaken.data.error || ''}`);

  // 15) لوحة بيانات المالك — الخادم يعمل بـ ADMIN_USERNAME=admin_test
  const regAdmin = await api('/api/register', { method: 'POST', body: { username: 'admin_test', password: 'Admin1234!' } });
  check('تسجيل admin_test (المالك)', regAdmin.status === 201 && !!regAdmin.data.token, `status=${regAdmin.status}`);
  const tokAdmin = regAdmin.data.token;
  const regPlain = await api('/api/register', { method: 'POST', body: { username: 'plain_user', password: 'Plain1234!' } });
  check('تسجيل plain_user (مستخدم عادي)', regPlain.status === 201 && !!regPlain.data.token, `status=${regPlain.status}`);
  const tokPlain = regPlain.data.token;
  const mePlain = await api('/api/me', { token: tokPlain });
  check('/api/me للمستخدم العادي: isAdmin=false', mePlain.data.user?.isAdmin === false, JSON.stringify(mePlain.data.user || {}));
  const meAdmin = await api('/api/me', { token: tokAdmin });
  check('/api/me للمالك: isAdmin=true', meAdmin.data.user?.isAdmin === true, JSON.stringify(meAdmin.data.user || {}));
  const adminForbidden = await api('/api/admin/overview', { token: tokPlain });
  check('نقاط الإدارة محرّمة على غير المالك (403)', adminForbidden.status === 403, `status=${adminForbidden.status}`);
  // زرع محادثة بين العادي والمالك: رسالة نصية + رسالة صورة
  const plainText = await api('/api/messages/admin_test', { method: 'POST', token: tokPlain, body: { text: 'رسالة للوحة البيانات' } });
  check('plain_user يرسل رسالة نصية إلى admin_test', plainText.status === 201, `status=${plainText.status}`);
  const upAdminImg = await uploadRaw(PNG_BYTES, { token: tokPlain, mime: 'image/png', name: 'admin-pixel.png' });
  check('plain_user يرفع صورة (لرسالة اللوحة)', upAdminImg.status === 201 && !!upAdminImg.data.fileId, `status=${upAdminImg.status}`);
  const plainImg = await api('/api/messages/admin_test', { method: 'POST', token: tokPlain, body: { kind: 'image', fileId: upAdminImg.data.fileId } });
  check('plain_user يرسل رسالة الصورة إلى admin_test', plainImg.status === 201 && plainImg.data.message?.kind === 'image', `status=${plainImg.status}`);
  const ovAdmin = await api('/api/admin/overview', { token: tokAdmin });
  check('نظرة عامة الإدارة: الأعداد تغطي البيانات المزروعة',
    ovAdmin.status === 200 && ovAdmin.data.users >= 2 && ovAdmin.data.messages >= 2 && ovAdmin.data.uploads >= 1 && ovAdmin.data.uploadBytes >= PNG_BYTES.length,
    `status=${ovAdmin.status} data=${JSON.stringify(ovAdmin.data)}`);
  const usersAdmin = await api('/api/admin/users', { token: tokAdmin });
  check('قائمة مستخدمي الإدارة تتضمن admin_test و plain_user',
    usersAdmin.data.users?.some((u) => u.username === 'admin_test') && usersAdmin.data.users?.some((u) => u.username === 'plain_user'),
    `status=${usersAdmin.status}`);
  const convsAdmin = await api('/api/admin/conversations', { token: tokAdmin });
  const pairKey = (x, y) => [x, y].sort().join('|');
  const pairRow = convsAdmin.data.conversations?.find((c) => pairKey(c.a, c.b) === pairKey('admin_test', 'plain_user'));
  check('محادثات الإدارة تعرض الزوج admin_test/plain_user بعدّاد ≥ 2', !!pairRow && pairRow.count >= 2, JSON.stringify(pairRow || {}));
  const msgsAdmin = await api('/api/admin/messages?a=plain_user&b=admin_test', { token: tokAdmin });
  check('رسائل الإدارة بين الزوج تتضمن النصية والصورة مع رابط ملفها',
    msgsAdmin.data.messages?.some((m) => m.kind === 'text' && m.text.includes('للوحة البيانات')) &&
    msgsAdmin.data.messages?.some((m) => m.kind === 'image' && m.fileUrl === '/files/' + upAdminImg.data.fileId),
    `status=${msgsAdmin.status}`);
  const uploadsAdmin = await api('/api/admin/uploads', { token: tokAdmin });
  const upRow = uploadsAdmin.data.uploads?.find((u) => u.id === upAdminImg.data.fileId);
  check('قائمة ملفات الإدارة تتضمن الصورة بمالكها الصحيح plain_user',
    !!upRow && upRow.owner === 'plain_user' && upRow.mime === 'image/png', JSON.stringify(upRow || {}));

  // 16) الحذف لدى الجميع مع الاحتجاز للمالك: المحتوى يختفي عن الطرفين تماماً
  // (نص بديل بلا نص وبلا رابط ملف)، لكنه يبقى كاملاً في لوحة البيانات، وملف
  // الوسائط لا يُقدَّم بعد الحذف إلا بجلسة المالك (ترويسة أو ?t=).
  const getFileAuth = async (url, token) => {
    const res = await fetch(BASE + url, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
  };
  const regRetA = await api('/api/register', { method: 'POST', body: { username: 'ret_a', password: 'RetA1234!' } });
  const regRetB = await api('/api/register', { method: 'POST', body: { username: 'ret_b', password: 'RetB1234!' } });
  check('تسجيل ret_a و ret_b (اختبار الاحتجاز)', regRetA.status === 201 && regRetB.status === 201,
    `a=${regRetA.status} b=${regRetB.status}`);
  const tokRetA = regRetA.data.token, tokRetB = regRetB.data.token;
  const upRet = await uploadRaw(PNG_BYTES, { token: tokRetA, mime: 'image/png', name: 'retained.png' });
  check('ret_a يرفع صورة لرسالة الاحتجاز', upRet.status === 201 && !!upRet.data.fileId, `status=${upRet.status}`);
  const retFileUrl = '/files/' + upRet.data.fileId;
  const beforeDel = await getFileRaw(retFileUrl);
  check('قبل الحذف: الملف متاح علناً بمعرّفه (200)', beforeDel.status === 200 && beforeDel.buf.equals(PNG_BYTES), `status=${beforeDel.status}`);
  const retTextMsg = await api('/api/messages/ret_b', { method: 'POST', token: tokRetA, body: { text: 'نص محذوف يبقى عند المالك فقط' } });
  const retImgMsg = await api('/api/messages/ret_b', { method: 'POST', token: tokRetA, body: { kind: 'image', fileId: upRet.data.fileId } });
  check('ret_a يرسل رسالة نصية ورسالة صورة إلى ret_b',
    retTextMsg.status === 201 && retImgMsg.status === 201 && retImgMsg.data.message?.kind === 'image',
    `text=${retTextMsg.status} img=${retImgMsg.status}`);
  const retTextId = retTextMsg.data.message?.id, retImgId = retImgMsg.data.message?.id;
  const delRetText = await api('/api/messages/' + retTextId, { method: 'DELETE', token: tokRetA, body: { scope: 'everyone' } });
  const delRetImg = await api('/api/messages/' + retImgId, { method: 'DELETE', token: tokRetA, body: { scope: 'everyone' } });
  check('ret_a يحذف الرسالتين لدى الجميع (200)', delRetText.status === 200 && delRetImg.status === 200,
    `text=${delRetText.status} img=${delRetImg.status}`);
  await wait(200);
  // (أ) السجل العادي عند الطرفين: نص بديل بلا أي محتوى
  const histRetB = await api('/api/messages/ret_a', { token: tokRetB });
  const tombTextB = histRetB.data.messages?.find((m) => m.id === retTextId);
  const tombImgB = histRetB.data.messages?.find((m) => m.id === retImgId);
  check('سجل ret_b: الرسالة النصية المحذوفة بلا نص (deleted فقط)',
    !!tombTextB && tombTextB.deleted === true && !tombTextB.text, JSON.stringify(tombTextB || {}));
  check('سجل ret_b: رسالة الصورة المحذوفة بلا fileUrl وبلا fileId',
    !!tombImgB && tombImgB.deleted === true && !tombImgB.fileUrl && !tombImgB.fileId, JSON.stringify(tombImgB || {}));
  const histRetA = await api('/api/messages/ret_b', { token: tokRetA });
  const tombImgA = histRetA.data.messages?.find((m) => m.id === retImgId);
  check('سجل ret_a نفسه: الصورة المحذوفة بلا fileUrl أيضاً',
    !!tombImgA && tombImgA.deleted === true && !tombImgA.fileUrl, JSON.stringify(tombImgA || {}));
  // (ب) الملف المُحتجَز: 404 لغير المالك
  const fileAnon = await getFileRaw(retFileUrl);
  check('بعد الحذف: GET الملف بدون مصادقة يُرجع 404', fileAnon.status === 404, `status=${fileAnon.status}`);
  const fileAsB = await getFileAuth(retFileUrl, tokRetB);
  check('بعد الحذف: GET الملف بجلسة ret_b (غير المالك) يُرجع 404', fileAsB.status === 404, `status=${fileAsB.status}`);
  // (ج) لوحة البيانات: المحتوى الأصلي كاملاً مع deleted و deletedAt
  const msgsRetAdmin = await api('/api/admin/messages?a=ret_a&b=ret_b', { token: tokAdmin });
  const admText = msgsRetAdmin.data.messages?.find((m) => m.id === retTextId);
  const admImg = msgsRetAdmin.data.messages?.find((m) => m.id === retImgId);
  check('لوحة البيانات: النص الأصلي محفوظ مع deleted:true و deletedAt',
    !!admText && admText.text.includes('يبقى عند المالك فقط') && admText.deleted === true && typeof admText.deletedAt === 'number',
    JSON.stringify(admText || {}));
  check('لوحة البيانات: رسالة الصورة تحتفظ بـ fileUrl مع deleted:true و deletedAt',
    !!admImg && admImg.fileUrl === retFileUrl && admImg.deleted === true && typeof admImg.deletedAt === 'number',
    JSON.stringify(admImg || {}));
  // (د) المالك وحده يفتح الملف المُحتجَز — بالاستعلام وبالترويسة — بنفس البايتات
  const fileAdminQ = await getFileRaw(retFileUrl + '?t=' + encodeURIComponent(tokAdmin));
  check('المالك يفتح الملف المُحتجَز عبر ?t= (200 ونفس البايتات)',
    fileAdminQ.status === 200 && fileAdminQ.buf.equals(PNG_BYTES), `status=${fileAdminQ.status}`);
  const fileAdminH = await getFileAuth(retFileUrl, tokAdmin);
  check('المالك يفتح الملف المُحتجَز عبر ترويسة Authorization (200 ونفس البايتات)',
    fileAdminH.status === 200 && fileAdminH.buf.equals(PNG_BYTES), `status=${fileAdminH.status}`);
  // (هـ) قائمة ملفات الإدارة: الملف موجود ومُعلَّم retained — وغير المُحتجَز يبقى علنياً
  const uploadsAdmin2 = await api('/api/admin/uploads', { token: tokAdmin });
  const retRow = uploadsAdmin2.data.uploads?.find((u) => u.id === upRet.data.fileId);
  check('قائمة ملفات الإدارة: الملف المُحتجَز موجود مع retained:true',
    !!retRow && retRow.retained === true, JSON.stringify(retRow || {}));
  const plainRow2 = uploadsAdmin2.data.uploads?.find((u) => u.id === upAdminImg.data.fileId);
  const plainStillPublic = await getFileRaw('/files/' + upAdminImg.data.fileId);
  check('ملف غير مُحتجَز: retained غير مضبوط ويبقى متاحاً علناً (200)',
    !!plainRow2 && !plainRow2.retained && plainStillPublic.status === 200,
    `retained=${plainRow2?.retained} status=${plainStillPublic.status}`);

  // 17) أمان الحساب: تغيير كلمة المرور + ربط بريد مؤكد برمز + استعادة بالبريد
  const regSec = await api('/api/register', { method: 'POST', body: { username: 'sec_user', password: 'Secu1234!' } });
  check('تسجيل sec_user (اختبار الأمان)', regSec.status === 201 && !!regSec.data.token, `status=${regSec.status}`);
  const tokSec1 = regSec.data.token;
  const loginSec2 = await api('/api/login', { method: 'POST', body: { username: 'sec_user', password: 'Secu1234!' } });
  const tokSec2 = loginSec2.data.token;
  check('جلسة ثانية لـ sec_user قبل تغيير كلمة السر', loginSec2.status === 200 && !!tokSec2, `status=${loginSec2.status}`);

  const pwWrongCur = await api('/api/me/password', { method: 'POST', token: tokSec1, body: { currentPassword: 'WrongPass1!', newPassword: 'Newp1234!' } });
  check('تغيير كلمة السر بكلمة حالية خاطئة يُرفض 401', pwWrongCur.status === 401, `status=${pwWrongCur.status}`);
  const pwWeak = await api('/api/me/password', { method: 'POST', token: tokSec1, body: { currentPassword: 'Secu1234!', newPassword: 'weak' } });
  check('تغيير كلمة السر بكلمة جديدة ضعيفة يُرفض 400 مع رسالة القاعدة',
    pwWeak.status === 400 && (pwWeak.data.error || '').includes('كلمة المرور'), `status=${pwWeak.status}`);
  const pwChange = await api('/api/me/password', { method: 'POST', token: tokSec1, body: { currentPassword: 'Secu1234!', newPassword: 'Newp1234!' } });
  check('تغيير كلمة السر ينجح', pwChange.status === 200 && pwChange.data.ok === true, `status=${pwChange.status}`);
  const loginOldPw = await api('/api/login', { method: 'POST', body: { username: 'sec_user', password: 'Secu1234!' } });
  check('الدخول بكلمة السر القديمة بعد التغيير يُرفض 401', loginOldPw.status === 401, `status=${loginOldPw.status}`);
  const loginNewPw = await api('/api/login', { method: 'POST', body: { username: 'sec_user', password: 'Newp1234!' } });
  check('الدخول بكلمة السر الجديدة يعمل', loginNewPw.status === 200 && !!loginNewPw.data.token, `status=${loginNewPw.status}`);
  const tokSec3 = loginNewPw.data.token;
  const meSec2 = await api('/api/me', { token: tokSec2 });
  check('الجلسة الأخرى أُلغيت بعد تغيير كلمة السر (401)', meSec2.status === 401, `status=${meSec2.status}`);
  const meSec1 = await api('/api/me', { token: tokSec1 });
  check('جلسة المُغيِّر نفسها بقيت صالحة بعد التغيير', meSec1.status === 200 && meSec1.data.user?.username === 'sec_user', `status=${meSec1.status}`);

  // ربط البريد: صيغة خاطئة 400 — إرسال رمز — رمز خاطئ 400 — الصحيح يؤكد البريد
  const emailBad = await api('/api/me/email', { method: 'POST', token: tokSec1, body: { email: 'not-an-email' } });
  check('بريد بصيغة خاطئة يُرفض 400', emailBad.status === 400, `status=${emailBad.status}`);
  const emailSend = await api('/api/me/email', { method: 'POST', token: tokSec1, body: { email: 'Sec@Example.com' } });
  check('طلب رمز تأكيد البريد ينجح', emailSend.status === 200 && emailSend.data.ok === true, `status=${emailSend.status}`);
  const linkMail = lastMailTo('sec@example.com');
  const linkCode = codeFromMail(linkMail);
  check('وصل بريد التأكيد إلى الصادر (بأحرف صغيرة) وفيه رمز من ٦ أرقام', !!linkMail && !!linkCode, JSON.stringify(linkMail || {}));
  const verifyWrong = await api('/api/me/email/verify', { method: 'POST', token: tokSec1, body: { code: wrongCodeFor(linkCode) } });
  check('رمز تأكيد خاطئ يُرفض 400 «الرمز غير صحيح»',
    verifyWrong.status === 400 && (verifyWrong.data.error || '').includes('الرمز غير صحيح'),
    `status=${verifyWrong.status} err=${verifyWrong.data.error || ''}`);
  const verifyOk = await api('/api/me/email/verify', { method: 'POST', token: tokSec1, body: { code: linkCode } });
  check('الرمز الصحيح يؤكد البريد ويرجعه', verifyOk.status === 200 && verifyOk.data.email === 'sec@example.com', `status=${verifyOk.status}`);
  const meSecMail = await api('/api/me', { token: tokSec1 });
  check('/api/me يعرض البريد المؤكد و emailVerified=true ولا pendingEmail',
    meSecMail.data.user?.email === 'sec@example.com' && meSecMail.data.user?.emailVerified === true && !meSecMail.data.user?.pendingEmail,
    JSON.stringify(meSecMail.data.user || {}));

  // مهلة إعادة الإرسال (٦٠ ثانية): طلب رمز ثانٍ فوراً لنفس الغرض → 429
  const regCool = await api('/api/register', { method: 'POST', body: { username: 'cool_user', password: 'Cool1234!' } });
  const cool1 = await api('/api/me/email', { method: 'POST', token: regCool.data.token, body: { email: 'cool@example.com' } });
  const cool2 = await api('/api/me/email', { method: 'POST', token: regCool.data.token, body: { email: 'cool@example.com' } });
  check('إعادة طلب رمز خلال ٦٠ ثانية تُرفض 429', cool1.status === 200 && cool2.status === 429, `first=${cool1.status} second=${cool2.status}`);

  // الاستعادة: نسيت → رمز في الصادر → رمز خاطئ 400 → الصحيح يبدّل كلمة السر ويُلغي كل الجلسات
  const forgotSec = await api('/api/password/forgot', { method: 'POST', body: { username: 'sec_user' } });
  check('طلب الاستعادة لحساب له بريد مؤكد يرجع 200', forgotSec.status === 200 && forgotSec.data.ok === true, `status=${forgotSec.status}`);
  const resetMail = lastMailTo('sec@example.com');
  const resetCode = codeFromMail(resetMail);
  check('وصل بريد الاستعادة (موضوعه «استعادة») وفيه رمز من ٦ أرقام',
    !!resetMail && !!resetCode && (resetMail.subject || '').includes('استعادة'), JSON.stringify(resetMail || {}));
  const resetWrong = await api('/api/password/reset', { method: 'POST', body: { username: 'sec_user', code: wrongCodeFor(resetCode), newPassword: 'Reset123!' } });
  check('رمز استعادة خاطئ يُرفض 400', resetWrong.status === 400, `status=${resetWrong.status}`);
  const resetOk = await api('/api/password/reset', { method: 'POST', body: { username: 'sec_user', code: resetCode, newPassword: 'Reset123!' } });
  check('الرمز الصحيح يعيّن كلمة السر الجديدة', resetOk.status === 200 && resetOk.data.ok === true, `status=${resetOk.status} err=${resetOk.data.error || ''}`);
  const loginAfterResetOld = await api('/api/login', { method: 'POST', body: { username: 'sec_user', password: 'Newp1234!' } });
  check('كلمة السر قبل الاستعادة لم تعد تعمل (401)', loginAfterResetOld.status === 401, `status=${loginAfterResetOld.status}`);
  const loginAfterResetNew = await api('/api/login', { method: 'POST', body: { username: 'sec_user', password: 'Reset123!' } });
  check('الدخول بكلمة السر المُستعادة يعمل', loginAfterResetNew.status === 200 && !!loginAfterResetNew.data.token, `status=${loginAfterResetNew.status}`);
  const meSec1After = await api('/api/me', { token: tokSec1 });
  const meSec3After = await api('/api/me', { token: tokSec3 });
  check('كل جلسات sec_user السابقة أُلغيت بعد الاستعادة (401)',
    meSec1After.status === 401 && meSec3After.status === 401, `s1=${meSec1After.status} s3=${meSec3After.status}`);

  // نسيت لحساب بلا بريد مؤكد أو لحساب غير موجود: 200 دائماً وبلا أي بريد صادر
  const regNoMail = await api('/api/register', { method: 'POST', body: { username: 'noemail_user', password: 'NoMail123!' } });
  check('تسجيل noemail_user (بلا بريد)', regNoMail.status === 201, `status=${regNoMail.status}`);
  const outboxCountBefore = readOutbox().length;
  const forgotNoMail = await api('/api/password/forgot', { method: 'POST', body: { username: 'noemail_user' } });
  check('طلب الاستعادة لحساب بلا بريد مؤكد يرجع 200', forgotNoMail.status === 200, `status=${forgotNoMail.status}`);
  const forgotGhost = await api('/api/password/forgot', { method: 'POST', body: { username: 'ghost_xyz' } });
  check('طلب الاستعادة لحساب غير موجود يرجع 200', forgotGhost.status === 200, `status=${forgotGhost.status}`);
  check('لم يُرسل أي بريد في حالتي «بلا بريد» و«غير موجود»', readOutbox().length === outboxCountBefore,
    `before=${outboxCountBefore} after=${readOutbox().length}`);
  const resetGhost = await api('/api/password/reset', { method: 'POST', body: { username: 'ghost_xyz', code: '123456', newPassword: 'Reset123!' } });
  check('استعادة لحساب غير موجود تُرفض 400 برسالة موحّدة «الرمز غير صحيح أو منتهٍ»',
    resetGhost.status === 400 && (resetGhost.data.error || '').includes('الرمز غير صحيح أو منتهٍ'), `status=${resetGhost.status}`);

  // البريد معطّل تماماً: خادم ثانٍ بلا MAIL_OUTBOX وبلا SMTP → النقاط البريدية 503
  const dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'msgtest-nomail-'));
  const server2 = spawn('node', ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: '3220', DATA_DIR: dataDir2, MAIL_OUTBOX: '', SMTP_USER: '', SMTP_PASS: '', ADMIN_USERNAME: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server2.stderr.on('data', (d) => process.stderr.write('[server2] ' + d));
  try {
    let up2 = false;
    for (let i = 0; i < 50 && !up2; i++) {
      try { const r = await fetch('http://localhost:3220/api/health'); up2 = r.ok; } catch { await wait(200); }
    }
    check('الخادم الثاني (بلا إعداد بريد) أقلع', up2);
    const apiNoMail = async (p, { method = 'GET', token, body } = {}) => {
      const res = await fetch('http://localhost:3220' + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    const regNm = await apiNoMail('/api/register', { method: 'POST', body: { username: 'nomail_user', password: 'NoMail123!' } });
    const emailDisabled = await apiNoMail('/api/me/email', { method: 'POST', token: regNm.data.token, body: { email: 'x@example.com' } });
    check('بلا إعداد بريد: ربط البريد يرجع 503 «إرسال البريد غير مفعّل بعد»',
      emailDisabled.status === 503 && (emailDisabled.data.error || '').includes('غير مفعّل'), `status=${emailDisabled.status}`);
    const forgotDisabled = await apiNoMail('/api/password/forgot', { method: 'POST', body: { username: 'nomail_user' } });
    check('بلا إعداد بريد: طلب الاستعادة يرجع 503', forgotDisabled.status === 503, `status=${forgotDisabled.status}`);
  } finally {
    server2.kill();
    fs.rmSync(dataDir2, { recursive: true, force: true });
  }

  B2.close();
  A.close();
} catch (err) {
  failed++;
  console.log('  FAIL  خطأ عام:', err.message);
} finally {
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\nالنتيجة: ${passed} ناجح / ${failed} فاشل`);
process.exit(failed ? 1 : 0);

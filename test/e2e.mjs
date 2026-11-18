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
// خادم ثانٍ بلا أي إعداد بريد، وإرسال Brevo عبر HTTPS API على خادم ثالث
// يقصده خادم HTTP وهمي محلي (حمولة الطلب كاملة + مسار فشل عند ردّ 400)،
// وإرسال Mailjet عبر HTTPS API على خادم رابع يقصده وهمي محلي آخر (ترويسة
// مصادقة Basic وحمولة Messages + مسار فشل عند ردّ 401)، وإرسال SMTP2GO عبر
// HTTPS API على خادم خامس يقصده وهمي محلي ثالث (ترويسة X-Smtp2go-Api-Key
// وحمولة sender/to/text_body + مسار فشل عند ردّ 400)، وإشعارات Web Push على
// خادم سادس بمفاتيح VAPID مولّدة للاختبار ووضع الالتقاط PUSH_TEST_CAPTURE=1
// (المفتاح العام، رفض اشتراك مشوّه 400، دورة اشتراك/إلغاء مع التحقق من
// التخزين الفعلي في data.json وحدّ ٥ اشتراكات، والتقاط حمولة «رسالة» بلا أي
// نص من الرسالة وحمولة «مكالمة» لمستخدم غير متصل مشترك، وغياب الالتقاط
// عند الاتصال أو بعد إلغاء الاشتراك)، وتعطّل نقاط Push بـ 503 على الخادم
// الرئيسي بلا مفاتيح VAPID، ومجلدات لوحة البيانات: تصنيف ملفات كل مستخدم
// (صور/تسجيلات/فيديوهات/صور شخصية) وعدّادات /api/admin/users ونقطة
// /api/admin/users/:username/files (الفئات منفصلة، الصورة الشخصية ليست في
// الصور، الملف المُحتجَز المحذوف لدى الجميع داخل العدّادات، ورفض غير المالك)،
// والتصنيف الاحتياطي للسجلات القديمة بلا kind على خادم سابع ببيانات مزروعة
// (ملف الصورة الشخصية الحالية يُعدّ صورةً شخصية وما عداه بنوع mime).
// التشغيل: npm test
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
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
let server = startServer({ ADMIN_USERNAME: 'admin_test', MAIL_OUTBOX: outboxPath, SMTP2GO_API_KEY: '' });

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

  // 22) مجلدات لوحة البيانات: تصنيف ملفات مستخدم واحد في فئات (صور/تسجيلات/
  // فيديوهات/صور شخصية) + عدّادات /api/admin/users + نقطة ملفات الفئة.
  const regFold = await api('/api/register', { method: 'POST', body: { username: 'fold_user', password: 'Fold1234!' } });
  const regFoldPeer = await api('/api/register', { method: 'POST', body: { username: 'fold_peer', password: 'Fold1234!' } });
  check('تسجيل fold_user و fold_peer (اختبار المجلدات)', regFold.status === 201 && regFoldPeer.status === 201,
    `user=${regFold.status} peer=${regFoldPeer.status}`);
  const tokFold = regFold.data.token;
  const MP4_BYTES = Buffer.from('FAKE_MP4_VIDEO_BYTES');
  const VOICE_BYTES = Buffer.from('FAKE_WEBM_AUDIO_BYTES');
  const fUpPhoto = await uploadRaw(PNG_BYTES, { token: tokFold, mime: 'image/png', name: 'fold-photo.png' });
  const fUpVideo = await uploadRaw(MP4_BYTES, { token: tokFold, mime: 'video/mp4', name: 'fold-video.mp4' });
  const fUpVoice1 = await uploadRaw(VOICE_BYTES, { token: tokFold, mime: 'audio/webm', name: 'fold-voice1.webm' });
  const fUpVoice2 = await uploadRaw(VOICE_BYTES, { token: tokFold, mime: 'audio/webm', name: 'fold-voice2.webm' });
  const fUpPhoto2 = await uploadRaw(PNG_BYTES, { token: tokFold, mime: 'image/png', name: 'fold-photo2.png' });
  const fUpAvatar = await uploadRaw(PNG_BYTES, { token: tokFold, mime: 'image/png', name: 'fold-avatar.png' });
  check('fold_user يرفع ٦ ملفات بأنواع مختلفة',
    [fUpPhoto, fUpVideo, fUpVoice1, fUpVoice2, fUpPhoto2, fUpAvatar].every((u) => u.status === 201 && !!u.data.fileId),
    `statuses=${[fUpPhoto, fUpVideo, fUpVoice1, fUpVoice2, fUpPhoto2, fUpAvatar].map((u) => u.status).join(',')}`);
  const fSetAvatar = await api('/api/me/avatar', { method: 'POST', token: tokFold, body: { fileId: fUpAvatar.data.fileId } });
  check('fold_user يعيّن صورته الشخصية', fSetAvatar.status === 200, `status=${fSetAvatar.status}`);
  const fMsgText = await api('/api/messages/fold_peer', { method: 'POST', token: tokFold, body: { text: 'رسالة اختبار المجلدات' } });
  const fMsgPhoto = await api('/api/messages/fold_peer', { method: 'POST', token: tokFold, body: { kind: 'image', fileId: fUpPhoto.data.fileId } });
  const fMsgVoice = await api('/api/messages/fold_peer', { method: 'POST', token: tokFold, body: { kind: 'voice', fileId: fUpVoice1.data.fileId, durationSec: 3 } });
  const fMsgVideo = await api('/api/messages/fold_peer', { method: 'POST', token: tokFold, body: { kind: 'video', fileId: fUpVideo.data.fileId } });
  const fMsgPhoto2 = await api('/api/messages/fold_peer', { method: 'POST', token: tokFold, body: { kind: 'image', fileId: fUpPhoto2.data.fileId } });
  check('fold_user يرسل ٥ رسائل (نص/صورة/صوت/فيديو/صورة)',
    [fMsgText, fMsgPhoto, fMsgVoice, fMsgVideo, fMsgPhoto2].every((m) => m.status === 201),
    `statuses=${[fMsgText, fMsgPhoto, fMsgVoice, fMsgVideo, fMsgPhoto2].map((m) => m.status).join(',')}`);
  const fDelPhoto2 = await api('/api/messages/' + fMsgPhoto2.data.message?.id, { method: 'DELETE', token: tokFold, body: { scope: 'everyone' } });
  check('fold_user يحذف رسالة الصورة الثانية لدى الجميع (ملفها يصبح مُحتجَزاً)', fDelPhoto2.status === 200, `status=${fDelPhoto2.status}`);
  // العدّادات: ٥ رسائل مُرسَلة، صورتان (إحداهما مُحتجَزة)، فيديو، تسجيلان، صورة شخصية
  const usersFold = await api('/api/admin/users', { token: tokAdmin });
  const foldRow = usersFold.data.users?.find((u) => u.username === 'fold_user');
  const foldBytes = PNG_BYTES.length * 3 + MP4_BYTES.length + VOICE_BYTES.length * 2;
  check('عدّادات fold_user في /api/admin/users دقيقة وتشمل الملف المُحتجَز',
    !!foldRow && foldRow.counts?.messages === 5 && foldRow.counts?.photos === 2 && foldRow.counts?.videos === 1 &&
    foldRow.counts?.audio === 2 && foldRow.counts?.avatars === 1 && foldRow.counts?.totalFiles === 6 &&
    foldRow.counts?.totalBytes === foldBytes,
    JSON.stringify(foldRow?.counts || {}));
  // نقطة الفئات: فصل دقيق بين الفئات + الشريك + الاحتجاز
  const foldFiles = (cat) => api('/api/admin/users/fold_user/files?category=' + cat, { token: tokAdmin });
  const filesPhotos = await foldFiles('photos');
  const retItem = filesPhotos.data.files?.find((f) => f.id === fUpPhoto2.data.fileId);
  check('مجلد الصور: صورتان فقط — المُحتجَزة بينهما مع retained/deleted وشريكها، وبلا الصورة الشخصية',
    filesPhotos.status === 200 && filesPhotos.data.files?.length === 2 &&
    filesPhotos.data.files.some((f) => f.id === fUpPhoto.data.fileId && f.partner === 'fold_peer' && f.retained === false) &&
    !!retItem && retItem.retained === true && retItem.deleted === true && retItem.partner === 'fold_peer' &&
    !filesPhotos.data.files.some((f) => f.id === fUpAvatar.data.fileId),
    JSON.stringify(filesPhotos.data.files || {}));
  const retViaAdmin = retItem ? await getFileRaw(retItem.url + '?t=' + encodeURIComponent(tokAdmin)) : { status: 0 };
  check('رابط الملف المُحتجَز القادم من نقطة المجلدات يفتح بجلسة المالك (200)',
    retViaAdmin.status === 200 && retViaAdmin.buf.equals(PNG_BYTES), `status=${retViaAdmin.status}`);
  const filesAudio = await foldFiles('audio');
  check('مجلد التسجيلات: تسجيلان — المُرسَل بشريكه والمرفوع فقط بلا حقل شريك',
    filesAudio.status === 200 && filesAudio.data.files?.length === 2 &&
    filesAudio.data.files.some((f) => f.id === fUpVoice1.data.fileId && f.partner === 'fold_peer') &&
    filesAudio.data.files.some((f) => f.id === fUpVoice2.data.fileId && !('partner' in f)),
    JSON.stringify(filesAudio.data.files || {}));
  const filesVideos = await foldFiles('videos');
  check('مجلد الفيديوهات: الفيديو الوحيد فقط بشريكه',
    filesVideos.status === 200 && filesVideos.data.files?.length === 1 &&
    filesVideos.data.files[0].id === fUpVideo.data.fileId && filesVideos.data.files[0].partner === 'fold_peer',
    JSON.stringify(filesVideos.data.files || {}));
  const filesAvatars = await foldFiles('avatars');
  check('مجلد الصور الشخصية: الصورة الشخصية وحدها (لا تظهر في الصور)',
    filesAvatars.status === 200 && filesAvatars.data.files?.length === 1 &&
    filesAvatars.data.files[0].id === fUpAvatar.data.fileId && filesAvatars.data.files[0].category === 'avatars',
    JSON.stringify(filesAvatars.data.files || {}));
  const filesAll = await foldFiles('all');
  check('مجلد كل الملفات: ٦ ملفات مرتبة من الأحدث إلى الأقدم',
    filesAll.status === 200 && filesAll.data.files?.length === 6 &&
    filesAll.data.files.every((f, i, arr) => i === 0 || (arr[i - 1].createdAt || 0) >= (f.createdAt || 0)),
    `count=${filesAll.data.files?.length}`);
  const filesForbidden = await api('/api/admin/users/fold_user/files?category=photos', { token: tokFold });
  check('نقطة ملفات المجلدات محرّمة على غير المالك (403)', filesForbidden.status === 403, `status=${filesForbidden.status}`);
  const filesAnon = await api('/api/admin/users/fold_user/files?category=photos');
  check('نقطة ملفات المجلدات بلا جلسة تُرفض (401)', filesAnon.status === 401, `status=${filesAnon.status}`);
  const filesGhost = await api('/api/admin/users/no_such_user/files?category=photos', { token: tokAdmin });
  check('ملفات مستخدم غير موجود تُرجع 404', filesGhost.status === 404, `status=${filesGhost.status}`);
  const filesBadCat = await api('/api/admin/users/fold_user/files?category=bogus', { token: tokAdmin });
  check('تصنيف غير صالح يُرجع 400', filesBadCat.status === 400, `status=${filesBadCat.status}`);

  // 23) التصنيف الاحتياطي للسجلات القديمة بلا kind — خادم سابع ببيانات مزروعة:
  // ملف الصورة الشخصية الحالية لمالكه يُعدّ صورةً شخصية، وما عداه بنوع mime.
  const dataDir7 = fs.mkdtempSync(path.join(os.tmpdir(), 'msgtest7-'));
  const server7 = (() => {
    fs.mkdirSync(path.join(dataDir7, 'uploads'), { recursive: true });
    const salt7 = crypto.randomBytes(16).toString('hex');
    const hash7 = crypto.scryptSync('Legacy1234!', salt7, 64).toString('hex');
    const legacyId = crypto.randomUUID();
    const AVATAR_ID7 = 'a'.repeat(32);
    const PHOTO_ID7 = 'b'.repeat(32);
    fs.writeFileSync(path.join(dataDir7, 'uploads', AVATAR_ID7 + '.png'), PNG_BYTES);
    fs.writeFileSync(path.join(dataDir7, 'uploads', PHOTO_ID7 + '.png'), PNG_BYTES);
    fs.writeFileSync(path.join(dataDir7, 'data.json'), JSON.stringify({
      users: [{ id: legacyId, username: 'legacy_admin', salt: salt7, hash: hash7, createdAt: Date.now(), avatarFileId: AVATAR_ID7 }],
      messages: [], sessions: {}, nameReservations: [], emailCodes: [], emailCodeSentAt: {},
      uploads: {
        [AVATAR_ID7]: { file: AVATAR_ID7 + '.png', mime: 'image/png', size: PNG_BYTES.length, name: 'old-avatar.png', ownerId: legacyId, ts: Date.now() - 2000 },
        [PHOTO_ID7]: { file: PHOTO_ID7 + '.png', mime: 'image/png', size: PNG_BYTES.length, name: 'old-photo.png', ownerId: legacyId, ts: Date.now() - 1000 },
      },
    }));
    const s = spawn('node', ['server.js'], {
      cwd: root,
      env: {
        ...process.env, PORT: '3225', DATA_DIR: dataDir7, ADMIN_USERNAME: 'legacy_admin',
        MAIL_OUTBOX: '', SMTP_USER: '', SMTP_PASS: '', BREVO_API_KEY: '', MAILJET_API_KEY: '', MAILJET_API_SECRET: '', SMTP2GO_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    s.stderr.on('data', (d) => process.stderr.write('[server7] ' + d));
    return s;
  })();
  try {
    const BASE7 = 'http://localhost:3225';
    const api7 = async (p, { method = 'GET', token, body } = {}) => {
      const res = await fetch(BASE7 + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    let up7 = false;
    for (let i = 0; i < 50 && !up7; i++) {
      try { const r = await fetch(BASE7 + '/api/health'); up7 = r.ok; } catch { await wait(200); }
    }
    check('الخادم السابع (بيانات قديمة مزروعة) أقلع', up7);
    const login7 = await api7('/api/login', { method: 'POST', body: { username: 'legacy_admin', password: 'Legacy1234!' } });
    check('دخول legacy_admin على الخادم السابع', login7.status === 200 && !!login7.data.token, `status=${login7.status}`);
    const tok7 = login7.data.token;
    const av7 = await api7('/api/admin/users/legacy_admin/files?category=avatars', { token: tok7 });
    check('سجل قديم بلا kind: ملف الصورة الشخصية الحالية يُصنَّف في الصور الشخصية',
      av7.status === 200 && av7.data.files?.length === 1 && av7.data.files[0].id === 'a'.repeat(32),
      JSON.stringify(av7.data.files || {}));
    const ph7 = await api7('/api/admin/users/legacy_admin/files?category=photos', { token: tok7 });
    check('سجل قديم بلا kind: الصورة العادية تبقى في الصور ولا تتسرب إلى الشخصية',
      ph7.status === 200 && ph7.data.files?.length === 1 && ph7.data.files[0].id === 'b'.repeat(32),
      JSON.stringify(ph7.data.files || {}));
    const users7 = await api7('/api/admin/users', { token: tok7 });
    const row7 = users7.data.users?.find((u) => u.username === 'legacy_admin');
    check('عدّادات legacy_admin تعكس التصنيف الاحتياطي (شخصية ١، صور ١، الكل ٢)',
      row7?.counts?.avatars === 1 && row7?.counts?.photos === 1 && row7?.counts?.totalFiles === 2,
      JSON.stringify(row7?.counts || {}));
  } finally {
    server7.kill();
    fs.rmSync(dataDir7, { recursive: true, force: true });
  }

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
    env: { ...process.env, PORT: '3220', DATA_DIR: dataDir2, MAIL_OUTBOX: '', SMTP_USER: '', SMTP_PASS: '', ADMIN_USERNAME: '', BREVO_API_KEY: '', MAILJET_API_KEY: '', MAILJET_API_SECRET: '', SMTP2GO_API_KEY: '' },
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

  // 18) إرسال Brevo عبر HTTPS API: خادم ثالث بـ BREVO_API_KEY وبلا صندوق صادر
  // وبلا SMTP، يقصد خادم HTTP وهمياً محلياً يحاكي Brevo (يسجّل الطلبات ويردّ
  // 201، أو 400 في وضع الفشل). دورة ربط البريد كاملة تمرّ عبر هذا المسار.
  const brevoRequests = [];
  let brevoMode = 'ok';
  const brevoMock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let reqBody = {};
      try { reqBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
      brevoRequests.push({ method: req.method, url: req.url, headers: req.headers, body: reqBody });
      if (brevoMode === 'ok') {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ messageId: '<mock-brevo-id>' }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'invalid_parameter', message: 'sender email not verified (mock)' }));
      }
    });
  });
  await new Promise((r) => brevoMock.listen(0, '127.0.0.1', r));
  const brevoMockUrl = `http://127.0.0.1:${brevoMock.address().port}/v3/smtp/email`;
  const dataDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'msgtest-brevo-'));
  const server3 = spawn('node', ['server.js'], {
    cwd: root,
    env: {
      ...process.env, PORT: '3221', DATA_DIR: dataDir3,
      MAIL_OUTBOX: '', SMTP_USER: '', SMTP_PASS: '', ADMIN_USERNAME: '',
      MAILJET_API_KEY: '', MAILJET_API_SECRET: '', SMTP2GO_API_KEY: '',
      BREVO_API_KEY: 'test-key-123', MAIL_FROM: 'sender@test.dev', BREVO_API_URL: brevoMockUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server3.stderr.on('data', (d) => process.stderr.write('[server3] ' + d));
  try {
    const apiBrevo = async (p, { method = 'GET', token, body } = {}) => {
      const res = await fetch('http://localhost:3221' + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    let up3 = false;
    for (let i = 0; i < 50 && !up3; i++) {
      try { const r = await fetch('http://localhost:3221/api/health'); up3 = r.ok; } catch { await wait(200); }
    }
    check('الخادم الثالث (Brevo) أقلع', up3);
    const regBr = await apiBrevo('/api/register', { method: 'POST', body: { username: 'brevo_user', password: 'Brev1234!' } });
    check('تسجيل brevo_user على خادم Brevo', regBr.status === 201 && !!regBr.data.token, `status=${regBr.status}`);
    const tokBr = regBr.data.token;
    brevoRequests.length = 0;
    const brSend = await apiBrevo('/api/me/email', { method: 'POST', token: tokBr, body: { email: 'Target@Example.com' } });
    check('طلب رمز تأكيد البريد عبر Brevo ينجح (200)', brSend.status === 200 && brSend.data.ok === true,
      `status=${brSend.status} err=${brSend.data.error || ''}`);
    check('الوهمي استلم طلب POST واحداً فقط إلى مسار Brevo',
      brevoRequests.length === 1 && brevoRequests[0].method === 'POST' && brevoRequests[0].url === '/v3/smtp/email',
      `count=${brevoRequests.length} url=${brevoRequests[0]?.url || ''}`);
    const brReq = brevoRequests[0] || { headers: {}, body: {} };
    check('ترويسة api-key في طلب Brevo تساوي المفتاح المضبوط', brReq.headers['api-key'] === 'test-key-123',
      `api-key=${brReq.headers['api-key'] || ''}`);
    const brCode = codeFromMail({ text: brReq.body.textContent || '' });
    check('حمولة Brevo: المُرسِل المضبوط واسمه، والمستقبِل الصحيح، ونص فيه رمز من ٦ أرقام',
      brReq.body.sender?.email === 'sender@test.dev' && brReq.body.sender?.name === 'رسائلي' &&
      brReq.body.to?.[0]?.email === 'target@example.com' && !!brCode,
      JSON.stringify(brReq.body || {}));
    const brVerify = await apiBrevo('/api/me/email/verify', { method: 'POST', token: tokBr, body: { code: brCode } });
    check('تأكيد البريد بالرمز المُرسل عبر Brevo ينجح ويرجع البريد',
      brVerify.status === 200 && brVerify.data.email === 'target@example.com',
      `status=${brVerify.status} err=${brVerify.data.error || ''}`);
    const brMe = await apiBrevo('/api/me', { token: tokBr });
    check('/api/me بعد تأكيد Brevo: البريد مضبوط و emailVerified=true',
      brMe.data.user?.email === 'target@example.com' && brMe.data.user?.emailVerified === true,
      JSON.stringify(brMe.data.user || {}));
    // مسار الفشل: الوهمي يردّ 400 بخطأ JSON — طلب الرمز يفشل 502 ولا يصلح أي رمز
    brevoMode = 'fail';
    const regBr2 = await apiBrevo('/api/register', { method: 'POST', body: { username: 'brevo_fail', password: 'Brev1234!' } });
    check('تسجيل brevo_fail على خادم Brevo', regBr2.status === 201 && !!regBr2.data.token, `status=${regBr2.status}`);
    const brFailSend = await apiBrevo('/api/me/email', { method: 'POST', token: regBr2.data.token, body: { email: 'fail@example.com' } });
    check('عند ردّ Brevo بـ 400: طلب الرمز يرجع 502 «تعذّر إرسال البريد»',
      brFailSend.status === 502 && (brFailSend.data.error || '').includes('تعذّر إرسال'),
      `status=${brFailSend.status} err=${brFailSend.data.error || ''}`);
    const brFailVerify = await apiBrevo('/api/me/email/verify', { method: 'POST', token: regBr2.data.token, body: { code: '123456' } });
    check('بعد فشل إرسال Brevo لا يوجد رمز صالح (التأكيد يرجع 400)', brFailVerify.status === 400, `status=${brFailVerify.status}`);
  } finally {
    server3.kill();
    brevoMock.close();
    fs.rmSync(dataDir3, { recursive: true, force: true });
  }

  // 19) إرسال Mailjet عبر HTTPS API: خادم رابع بـ MAILJET_API_KEY/SECRET وبلا
  // صندوق صادر وبلا Brevo وبلا SMTP، يقصد خادم HTTP وهمياً محلياً يحاكي
  // Mailjet (يسجّل الطلبات ويردّ 200 بحالة success، أو 401 في وضع الفشل).
  // دورة ربط البريد كاملة تمرّ عبر هذا المسار.
  const mjRequests = [];
  let mjMode = 'ok';
  const mjMock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let reqBody = {};
      try { reqBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
      mjRequests.push({ method: req.method, url: req.url, headers: req.headers, body: reqBody });
      if (mjMode === 'ok') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Messages: [{ Status: 'success', To: [{ Email: 'target@example.com', MessageID: 123456789 }] }] }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ErrorIdentifier: 'mock-id', ErrorCode: 'mj-0001', StatusCode: 401, ErrorMessage: 'API key authentication failed (mock)' }));
      }
    });
  });
  await new Promise((r) => mjMock.listen(0, '127.0.0.1', r));
  const mjMockUrl = `http://127.0.0.1:${mjMock.address().port}/v3.1/send`;
  const dataDir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'msgtest-mailjet-'));
  const server4 = spawn('node', ['server.js'], {
    cwd: root,
    env: {
      ...process.env, PORT: '3222', DATA_DIR: dataDir4,
      MAIL_OUTBOX: '', SMTP_USER: '', SMTP_PASS: '', ADMIN_USERNAME: '', BREVO_API_KEY: '', SMTP2GO_API_KEY: '',
      MAILJET_API_KEY: 'mj-key-123', MAILJET_API_SECRET: 'mj-secret-456',
      MAIL_FROM: 'sender@test.dev', MAILJET_API_URL: mjMockUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server4.stderr.on('data', (d) => process.stderr.write('[server4] ' + d));
  try {
    const apiMj = async (p, { method = 'GET', token, body } = {}) => {
      const res = await fetch('http://localhost:3222' + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    let up4 = false;
    for (let i = 0; i < 50 && !up4; i++) {
      try { const r = await fetch('http://localhost:3222/api/health'); up4 = r.ok; } catch { await wait(200); }
    }
    check('الخادم الرابع (Mailjet) أقلع', up4);
    const regMj = await apiMj('/api/register', { method: 'POST', body: { username: 'mailjet_user', password: 'Mailjet123!' } });
    check('تسجيل mailjet_user على خادم Mailjet', regMj.status === 201 && !!regMj.data.token, `status=${regMj.status}`);
    const tokMj = regMj.data.token;
    mjRequests.length = 0;
    const mjSend = await apiMj('/api/me/email', { method: 'POST', token: tokMj, body: { email: 'Target@Example.com' } });
    check('طلب رمز تأكيد البريد عبر Mailjet ينجح (200)', mjSend.status === 200 && mjSend.data.ok === true,
      `status=${mjSend.status} err=${mjSend.data.error || ''}`);
    check('الوهمي استلم طلب POST واحداً فقط إلى مسار Mailjet',
      mjRequests.length === 1 && mjRequests[0].method === 'POST' && mjRequests[0].url === '/v3.1/send',
      `count=${mjRequests.length} url=${mjRequests[0]?.url || ''}`);
    const mjReq = mjRequests[0] || { headers: {}, body: {} };
    const mjExpectedAuth = 'Basic ' + Buffer.from('mj-key-123:mj-secret-456', 'utf8').toString('base64');
    check('ترويسة Authorization في طلب Mailjet هي Basic بالمفتاح والسر المضبوطين',
      mjReq.headers.authorization === mjExpectedAuth,
      `authorization=${mjReq.headers.authorization || ''}`);
    const mjMsg = mjReq.body.Messages?.[0] || {};
    const mjCode = codeFromMail({ text: mjMsg.TextPart || '' });
    check('حمولة Mailjet: المُرسِل المضبوط واسمه، والمستقبِل الصحيح، ونص فيه رمز من ٦ أرقام',
      mjMsg.From?.Email === 'sender@test.dev' && mjMsg.From?.Name === 'رسائلي' &&
      mjMsg.To?.[0]?.Email === 'target@example.com' && !!mjCode,
      JSON.stringify(mjReq.body || {}));
    const mjVerify = await apiMj('/api/me/email/verify', { method: 'POST', token: tokMj, body: { code: mjCode } });
    check('تأكيد البريد بالرمز المُرسل عبر Mailjet ينجح ويرجع البريد',
      mjVerify.status === 200 && mjVerify.data.email === 'target@example.com',
      `status=${mjVerify.status} err=${mjVerify.data.error || ''}`);
    const mjMe = await apiMj('/api/me', { token: tokMj });
    check('/api/me بعد تأكيد Mailjet: البريد مضبوط و emailVerified=true',
      mjMe.data.user?.email === 'target@example.com' && mjMe.data.user?.emailVerified === true,
      JSON.stringify(mjMe.data.user || {}));
    // مسار الفشل: الوهمي يردّ 401 — طلب الرمز يفشل 502 ولا يصلح أي رمز
    mjMode = 'fail';
    const regMj2 = await apiMj('/api/register', { method: 'POST', body: { username: 'mailjet_fail', password: 'Mailjet123!' } });
    check('تسجيل mailjet_fail على خادم Mailjet', regMj2.status === 201 && !!regMj2.data.token, `status=${regMj2.status}`);
    const mjFailSend = await apiMj('/api/me/email', { method: 'POST', token: regMj2.data.token, body: { email: 'fail@example.com' } });
    check('عند ردّ Mailjet بـ 401: طلب الرمز يرجع 502 «تعذّر إرسال البريد»',
      mjFailSend.status === 502 && (mjFailSend.data.error || '').includes('تعذّر إرسال'),
      `status=${mjFailSend.status} err=${mjFailSend.data.error || ''}`);
    const mjFailVerify = await apiMj('/api/me/email/verify', { method: 'POST', token: regMj2.data.token, body: { code: '123456' } });
    check('بعد فشل إرسال Mailjet لا يوجد رمز صالح (التأكيد يرجع 400)', mjFailVerify.status === 400, `status=${mjFailVerify.status}`);
  } finally {
    server4.kill();
    mjMock.close();
    fs.rmSync(dataDir4, { recursive: true, force: true });
  }

  // 20) إرسال SMTP2GO عبر HTTPS API: خادم خامس بـ SMTP2GO_API_KEY وبلا صندوق
  // صادر وبلا Mailjet وبلا Brevo وبلا SMTP، يقصد خادم HTTP وهمياً محلياً يحاكي
  // SMTP2GO (يسجّل الطلبات ويردّ 200 بـ data.succeeded=1، أو 400 بجسم خطأ في
  // وضع الفشل). دورة ربط البريد كاملة تمرّ عبر هذا المسار.
  const s2gRequests = [];
  let s2gMode = 'ok';
  const s2gMock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let reqBody = {};
      try { reqBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
      s2gRequests.push({ method: req.method, url: req.url, headers: req.headers, body: reqBody });
      if (s2gMode === 'ok') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ request_id: 'mock-s2g-req', data: { succeeded: 1, failed: 0, failures: [] } }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ request_id: 'mock-s2g-req', data: { succeeded: 0, failed: 1, error: 'sender address not verified (mock)' } }));
      }
    });
  });
  await new Promise((r) => s2gMock.listen(0, '127.0.0.1', r));
  const s2gMockUrl = `http://127.0.0.1:${s2gMock.address().port}/v3/email/send`;
  const dataDir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'msgtest-smtp2go-'));
  const server5 = spawn('node', ['server.js'], {
    cwd: root,
    env: {
      ...process.env, PORT: '3223', DATA_DIR: dataDir5,
      MAIL_OUTBOX: '', SMTP_USER: '', SMTP_PASS: '', ADMIN_USERNAME: '',
      BREVO_API_KEY: '', MAILJET_API_KEY: '', MAILJET_API_SECRET: '',
      SMTP2GO_API_KEY: 's2g-key-789', MAIL_FROM: 'sender@test.dev', SMTP2GO_API_URL: s2gMockUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server5.stderr.on('data', (d) => process.stderr.write('[server5] ' + d));
  try {
    const apiS2g = async (p, { method = 'GET', token, body } = {}) => {
      const res = await fetch('http://localhost:3223' + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    let up5 = false;
    for (let i = 0; i < 50 && !up5; i++) {
      try { const r = await fetch('http://localhost:3223/api/health'); up5 = r.ok; } catch { await wait(200); }
    }
    check('الخادم الخامس (SMTP2GO) أقلع', up5);
    const regS2g = await apiS2g('/api/register', { method: 'POST', body: { username: 'smtp2go_user', password: 'Smtp2go123!' } });
    check('تسجيل smtp2go_user على خادم SMTP2GO', regS2g.status === 201 && !!regS2g.data.token, `status=${regS2g.status}`);
    const tokS2g = regS2g.data.token;
    s2gRequests.length = 0;
    const s2gSend = await apiS2g('/api/me/email', { method: 'POST', token: tokS2g, body: { email: 'Target@Example.com' } });
    check('طلب رمز تأكيد البريد عبر SMTP2GO ينجح (200)', s2gSend.status === 200 && s2gSend.data.ok === true,
      `status=${s2gSend.status} err=${s2gSend.data.error || ''}`);
    check('الوهمي استلم طلب POST واحداً فقط إلى مسار SMTP2GO',
      s2gRequests.length === 1 && s2gRequests[0].method === 'POST' && s2gRequests[0].url === '/v3/email/send',
      `count=${s2gRequests.length} url=${s2gRequests[0]?.url || ''}`);
    const s2gReq = s2gRequests[0] || { headers: {}, body: {} };
    check('ترويسة X-Smtp2go-Api-Key في طلب SMTP2GO تساوي المفتاح المضبوط', s2gReq.headers['x-smtp2go-api-key'] === 's2g-key-789',
      `x-smtp2go-api-key=${s2gReq.headers['x-smtp2go-api-key'] || ''}`);
    const s2gCode = codeFromMail({ text: s2gReq.body.text_body || '' });
    check('حمولة SMTP2GO: المُرسِل المضبوط، والمستقبِل الصحيح، ونص فيه رمز من ٦ أرقام',
      s2gReq.body.sender === 'sender@test.dev' &&
      s2gReq.body.to?.[0] === 'target@example.com' && !!s2gCode,
      JSON.stringify(s2gReq.body || {}));
    const s2gVerify = await apiS2g('/api/me/email/verify', { method: 'POST', token: tokS2g, body: { code: s2gCode } });
    check('تأكيد البريد بالرمز المُرسل عبر SMTP2GO ينجح ويرجع البريد',
      s2gVerify.status === 200 && s2gVerify.data.email === 'target@example.com',
      `status=${s2gVerify.status} err=${s2gVerify.data.error || ''}`);
    const s2gMe = await apiS2g('/api/me', { token: tokS2g });
    check('/api/me بعد تأكيد SMTP2GO: البريد مضبوط و emailVerified=true',
      s2gMe.data.user?.email === 'target@example.com' && s2gMe.data.user?.emailVerified === true,
      JSON.stringify(s2gMe.data.user || {}));
    // مسار الفشل: الوهمي يردّ 400 بجسم خطأ — طلب الرمز يفشل 502 ولا يصلح أي رمز
    s2gMode = 'fail';
    const regS2g2 = await apiS2g('/api/register', { method: 'POST', body: { username: 'smtp2go_fail', password: 'Smtp2go123!' } });
    check('تسجيل smtp2go_fail على خادم SMTP2GO', regS2g2.status === 201 && !!regS2g2.data.token, `status=${regS2g2.status}`);
    const s2gFailSend = await apiS2g('/api/me/email', { method: 'POST', token: regS2g2.data.token, body: { email: 'fail@example.com' } });
    check('عند ردّ SMTP2GO بـ 400: طلب الرمز يرجع 502 «تعذّر إرسال البريد»',
      s2gFailSend.status === 502 && (s2gFailSend.data.error || '').includes('تعذّر إرسال'),
      `status=${s2gFailSend.status} err=${s2gFailSend.data.error || ''}`);
    const s2gFailVerify = await apiS2g('/api/me/email/verify', { method: 'POST', token: regS2g2.data.token, body: { code: '123456' } });
    check('بعد فشل إرسال SMTP2GO لا يوجد رمز صالح (التأكيد يرجع 400)', s2gFailVerify.status === 400, `status=${s2gFailVerify.status}`);
  } finally {
    server5.kill();
    s2gMock.close();
    fs.rmSync(dataDir5, { recursive: true, force: true });
  }

  // 21) إشعارات Web Push — خادم سادس بمفاتيح VAPID مولّدة للاختبار +
  // PUSH_TEST_CAPTURE=1: الحمولات تُسجَّل في push-capture.jsonl بدل الشبكة.
  // الخادم الرئيسي بلا مفاتيح VAPID: نقاط Push ترجع 503 ولا يتعطل شيء آخر.
  const pkNoVapid = await api('/api/push/public-key', { token: tokA });
  check('بلا مفاتيح VAPID: GET /api/push/public-key يرجع 503', pkNoVapid.status === 503, `status=${pkNoVapid.status}`);

  const webpushTest = createRequire(import.meta.url)('web-push');
  const vapidKeys = webpushTest.generateVAPIDKeys();
  const dataDir6 = fs.mkdtempSync(path.join(os.tmpdir(), 'msgtest-push-'));
  const capturePath6 = path.join(dataDir6, 'push-capture.jsonl');
  const server6 = spawn('node', ['server.js'], {
    cwd: root,
    env: {
      ...process.env, PORT: '3224', DATA_DIR: dataDir6,
      MAIL_OUTBOX: '', SMTP_USER: '', SMTP_PASS: '', ADMIN_USERNAME: '',
      BREVO_API_KEY: '', MAILJET_API_KEY: '', MAILJET_API_SECRET: '', SMTP2GO_API_KEY: '',
      VAPID_PUBLIC_KEY: vapidKeys.publicKey, VAPID_PRIVATE_KEY: vapidKeys.privateKey,
      PUSH_TEST_CAPTURE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server6.stderr.on('data', (d) => process.stderr.write('[server6] ' + d));
  try {
    const apiPush = async (p, { method = 'GET', token, body } = {}) => {
      const res = await fetch('http://localhost:3224' + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    let up6 = false;
    for (let i = 0; i < 50 && !up6; i++) {
      try { const r = await fetch('http://localhost:3224/api/health'); up6 = r.ok; } catch { await wait(200); }
    }
    check('الخادم السادس (Push) أقلع', up6);

    const regPS = await apiPush('/api/register', { method: 'POST', body: { username: 'push_sender', password: 'Push1234!' } });
    const regPR = await apiPush('/api/register', { method: 'POST', body: { username: 'push_receiver', password: 'Push1234!' } });
    check('تسجيل push_sender و push_receiver', regPS.status === 201 && regPR.status === 201,
      `sender=${regPS.status} receiver=${regPR.status}`);
    const tokPS = regPS.data.token, tokPR = regPR.data.token;

    const pkAnon = await apiPush('/api/push/public-key');
    check('GET /api/push/public-key بلا مصادقة يرجع 401', pkAnon.status === 401, `status=${pkAnon.status}`);
    const pk = await apiPush('/api/push/public-key', { token: tokPR });
    check('GET /api/push/public-key يرجع المفتاح العام المضبوط في البيئة',
      pk.status === 200 && pk.data.publicKey === vapidKeys.publicKey,
      `status=${pk.status} key=${pk.data.publicKey || ''}`);

    const fakeSub = (n) => ({
      endpoint: `https://push.example.test/sub/${n}`,
      expirationTime: null,
      keys: { p256dh: 'BPfakeP256dhKey' + n, auth: 'fakeauth' + n },
    });
    const readDb6 = () => JSON.parse(fs.readFileSync(path.join(dataDir6, 'data.json'), 'utf8'));
    const subsOf = (username) => (readDb6().users.find((u) => u.username === username) || {}).pushSubscriptions || [];
    const readCapture6 = () => {
      try { return fs.readFileSync(capturePath6, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
      catch { return []; }
    };
    const waitCapture6 = async (pred, ms = 4000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const found = readCapture6().find(pred);
        if (found) return found;
        await wait(150);
      }
      return null;
    };

    // اشتراك مشوّه: غياب keys / نوع خاطئ / جسم فارغ → 400
    const subBad1 = await apiPush('/api/push/subscribe', { method: 'POST', token: tokPR, body: { subscription: { endpoint: 'https://push.example.test/x' } } });
    const subBad2 = await apiPush('/api/push/subscribe', { method: 'POST', token: tokPR, body: { subscription: 'nope' } });
    const subBad3 = await apiPush('/api/push/subscribe', { method: 'POST', token: tokPR, body: {} });
    check('اشتراك Push مشوّه يُرفض 400 (بكل أشكاله)',
      subBad1.status === 400 && subBad2.status === 400 && subBad3.status === 400,
      `s1=${subBad1.status} s2=${subBad2.status} s3=${subBad3.status}`);

    // اشتراك صالح → يُحفَظ في سجل المستخدم فعلياً، والتكرار بنفس نقطة النهاية لا يضاعفه
    const subOk = await apiPush('/api/push/subscribe', { method: 'POST', token: tokPR, body: { subscription: fakeSub(1) } });
    check('اشتراك Push صالح ينجح (200)', subOk.status === 200 && subOk.data.ok === true, `status=${subOk.status}`);
    check('الاشتراك محفوظ في data.json داخل سجل push_receiver',
      subsOf('push_receiver').length === 1 && subsOf('push_receiver')[0].endpoint === fakeSub(1).endpoint &&
      subsOf('push_receiver')[0].keys?.p256dh === fakeSub(1).keys.p256dh,
      JSON.stringify(subsOf('push_receiver')));
    const subDup = await apiPush('/api/push/subscribe', { method: 'POST', token: tokPR, body: { subscription: fakeSub(1) } });
    check('إعادة الاشتراك بنفس نقطة النهاية لا تضاعف الاشتراك (تفريد)',
      subDup.status === 200 && subsOf('push_receiver').length === 1, `count=${subsOf('push_receiver').length}`);

    // رسالة إلى مشترك غير متصل → حمولة «message» ملتقطة، وبلا أي نص من الرسالة
    const SECRET = 'نص سري للغاية 98765';
    const msgToOffline = await apiPush('/api/messages/push_receiver', { method: 'POST', token: tokPS, body: { text: SECRET } });
    check('push_sender يرسل رسالة إلى push_receiver غير المتصل', msgToOffline.status === 201, `status=${msgToOffline.status}`);
    const capMsg = await waitCapture6((l) => l.type === 'message' && l.username === 'push_receiver');
    check('التقاط Push: حمولة رسالة للمشترك غير المتصل (from/title/body كما هو مضبوط)',
      !!capMsg && capMsg.from === 'push_sender' && capMsg.title === 'push_sender' && capMsg.body === 'أرسل لك رسالة جديدة',
      JSON.stringify(capMsg || {}));
    const captureRaw1 = (() => { try { return fs.readFileSync(capturePath6, 'utf8'); } catch { return ''; } })();
    check('ملف الالتقاط لا يحتوي أي نص من الرسالة نفسها', !captureRaw1.includes('98765') && !captureRaw1.includes('نص سري'));

    // دعوة مكالمة إلى مشترك غير متصل → حمولة «call» ملتقطة
    const connectWs6 = (token) => new Promise((resolve, reject) => {
      const ws6 = new WebSocket('ws://localhost:3224/ws');
      const inbox6 = [];
      const waiters6 = [];
      ws6.on('message', (raw) => {
        const m6 = JSON.parse(raw.toString());
        inbox6.push(m6);
        for (let i = waiters6.length - 1; i >= 0; i--) {
          if (waiters6[i].pred(m6)) { waiters6[i].resolve(m6); waiters6.splice(i, 1); }
        }
        if (m6.type === 'authed') resolve(apiWs6);
      });
      ws6.on('error', reject);
      const apiWs6 = {
        ws: ws6, inbox: inbox6,
        send: (o) => ws6.send(JSON.stringify(o)),
        waitFor: (pred, ms = 5000) => new Promise((res, rej) => {
          const f = inbox6.find(pred);
          if (f) return res(f);
          const w = { pred, resolve: res };
          waiters6.push(w);
          setTimeout(() => rej(new Error('timeout waiting for WS6 event')), ms);
        }),
        close: () => ws6.close(),
      };
      ws6.on('open', () => ws6.send(JSON.stringify({ type: 'auth', token })));
    });
    const PS = await connectWs6(tokPS);
    PS.send({ type: 'call_invite', to: 'push_receiver', callType: 'voice' });
    const unavail6 = await PS.waitFor((m) => m.type === 'call_unavailable' && m.with === 'push_receiver').catch(() => null);
    check('المتصل يستلم call_unavailable (المدعو غير متصل)', !!unavail6);
    const capCall = await waitCapture6((l) => l.type === 'call' && l.username === 'push_receiver');
    check('التقاط Push: حمولة مكالمة واردة للمشترك غير المتصل',
      !!capCall && capCall.from === 'push_sender' && capCall.title === 'push_sender' && capCall.body === 'مكالمة واردة',
      JSON.stringify(capCall || {}));
    PS.close();
    await wait(300);

    // مشترك متصل عبر WebSocket: الرسالة تصل لحظياً ولا يُرسل أي Push
    const msgCapsBefore = readCapture6().filter((l) => l.type === 'message').length;
    const PR = await connectWs6(tokPR);
    await wait(200);
    await apiPush('/api/messages/push_receiver', { method: 'POST', token: tokPS, body: { text: 'رسالة والمستقبل متصل' } });
    const livePush = await PR.waitFor((m) => m.type === 'message' && m.message.text.includes('والمستقبل متصل')).catch(() => null);
    check('المشترك المتصل يستلم الرسالة لحظياً عبر WebSocket', !!livePush);
    await wait(500);
    check('لا Push يُرسل ما دام المستقبِل متصلاً',
      readCapture6().filter((l) => l.type === 'message').length === msgCapsBefore,
      `before=${msgCapsBefore} after=${readCapture6().filter((l) => l.type === 'message').length}`);
    PR.close();
    await wait(400);

    // إلغاء الاشتراك: يُزال من السجل، وبعده لا Push لرسائل جديدة
    const unsub = await apiPush('/api/push/unsubscribe', { method: 'POST', token: tokPR, body: { endpoint: fakeSub(1).endpoint } });
    check('إلغاء اشتراك Push ينجح ويُزال من data.json',
      unsub.status === 200 && subsOf('push_receiver').length === 0,
      `status=${unsub.status} count=${subsOf('push_receiver').length}`);
    const capsBeforeUnsubMsg = readCapture6().length;
    await apiPush('/api/messages/push_receiver', { method: 'POST', token: tokPS, body: { text: 'رسالة بعد إلغاء الاشتراك' } });
    await wait(700);
    check('بعد إلغاء الاشتراك لا يُلتقط أي Push جديد',
      readCapture6().length === capsBeforeUnsubMsg,
      `before=${capsBeforeUnsubMsg} after=${readCapture6().length}`);

    // حدّ الاشتراكات: ٥ لكل مستخدم كحد أقصى مهما أُضيف
    for (let n = 2; n <= 7; n++) {
      await apiPush('/api/push/subscribe', { method: 'POST', token: tokPR, body: { subscription: fakeSub(n) } });
    }
    check('اشتراكات Push محدودة بـ ٥ لكل مستخدم', subsOf('push_receiver').length === 5,
      `count=${subsOf('push_receiver').length}`);
  } finally {
    server6.kill();
    fs.rmSync(dataDir6, { recursive: true, force: true });
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

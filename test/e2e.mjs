// اختبار شامل (End-to-End) — يشغّل الخادم على منفذ اختبار مع مجلد بيانات مؤقت،
// ثم يتحقق من: التسجيل، رفض التكرار وكلمة المرور الخاطئة، الإرسال اللحظي عبر
// WebSocket، سجل المحادثة، إشعار القراءة، والرسائل أثناء عدم الاتصال.
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

const server = spawn('node', ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

try {
  // انتظار إقلاع الخادم
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { const r = await fetch(BASE + '/api/health'); up = r.ok; } catch { await wait(200); }
  }
  if (!up) throw new Error('الخادم لم يقلع');
  console.log('الخادم أقلع — بدء الفحوصات:');

  // 1) التسجيل
  const regA = await api('/api/register', { method: 'POST', body: { username: 'omar_test', password: 'pass1234' } });
  check('تسجيل omar_test', regA.status === 201 && !!regA.data.token);
  const regB = await api('/api/register', { method: 'POST', body: { username: 'sara_test', password: 'pass5678' } });
  check('تسجيل sara_test', regB.status === 201 && !!regB.data.token);

  // 2) الرفض
  const dup = await api('/api/register', { method: 'POST', body: { username: 'omar_test', password: 'whatever1' } });
  check('رفض تسجيل مكرر', dup.status === 409, `status=${dup.status}`);
  const badLogin = await api('/api/login', { method: 'POST', body: { username: 'omar_test', password: 'wrong-pass' } });
  check('رفض كلمة مرور خاطئة', badLogin.status === 401, `status=${badLogin.status}`);
  const loginA = await api('/api/login', { method: 'POST', body: { username: 'omar_test', password: 'pass1234' } });
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
  const loginB2 = await api('/api/login', { method: 'POST', body: { username: 'sara_test', password: 'pass5678' } });
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
  const regC = await api('/api/register', { method: 'POST', body: { username: 'carol_test', password: 'pass9999' } });
  check('تسجيل carol_test (غير متصلة)', regC.status === 201);
  A.send({ type: 'call_invite', to: 'carol_test', callType: 'voice' });
  const unavail = await A.waitFor((m) => m.type === 'call_unavailable' && m.with === 'carol_test').catch(() => null);
  check('A يستلم call_unavailable عند الاتصال بمستخدم غير متصل', !!unavail);
  await wait(300);
  const histCarol = await api('/api/messages/carol_test', { token: tokA });
  const carolRecs = (histCarol.data.messages || []).filter((m) => m.kind === 'call');
  check('سجل مكالمة فائتة محفوظ في محادثة carol_test', carolRecs.length === 1 && carolRecs[0].text.includes('فائتة'), `count=${carolRecs.length}`);

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

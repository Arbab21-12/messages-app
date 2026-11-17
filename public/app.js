'use strict';
/* واجهة تطبيق الرسائل — تتصل بنفس الخادم: REST + WebSocket */
const $ = (id) => document.getElementById(id);

let token = localStorage.getItem('msg_token') || null;
let me = null;
let ws = null;
let onlineUsers = new Set();
let currentChat = null; // username الطرف الآخر
let authMode = 'login';

const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'حدث خطأ');
  return data;
};

function show(id) {
  for (const s of ['auth-screen', 'main-screen', 'chat-screen']) $(s).hidden = s !== id;
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
}
function ticks(m) {
  if (m.readAt) return '<span class="ticks read">✓✓ مقروءة</span>';
  if (m.deliveredAt) return '<span class="ticks">✓✓ تم التسليم</span>';
  return '<span class="ticks">✓ أُرسلت</span>';
}

// ---------- الدخول ----------
// قواعد الحساب الجديد — مرآة لقواعد الخادم (التحقق النهائي دائماً عند الخادم)
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,23}$/;
const USERNAME_ERROR = 'اسم المستخدم يجب أن يبدأ بحرف أو رقم، ويمكن أن يحتوي على حروف وأرقام و _ . - فقط';
function passwordMissing(pw) {
  const missing = [];
  if (((pw.match(/[A-Za-z]/g) || []).length) < 4) missing.push('٤ حروف على الأقل');
  if (!/\d/.test(pw)) missing.push('رقم');
  if (!/[^A-Za-z0-9]/.test(pw)) missing.push('رمز (مثل ! أو #)');
  return missing;
}
function setPwCheck(id, ok) {
  const li = $(id);
  li.classList.toggle('ok', ok);
  li.querySelector('.chk-mark').textContent = ok ? '✓' : '•';
}
function updatePwChecklist() {
  const pw = $('auth-password').value;
  setPwCheck('pw-chk-letters', ((pw.match(/[A-Za-z]/g) || []).length) >= 4);
  setPwCheck('pw-chk-digit', /\d/.test(pw));
  setPwCheck('pw-chk-symbol', /[^A-Za-z0-9]/.test(pw));
}
$('auth-password').addEventListener('input', () => { if (authMode === 'register') updatePwChecklist(); });

function setAuthMode(mode) {
  authMode = mode;
  $('tab-login').classList.toggle('active', mode === 'login');
  $('tab-register').classList.toggle('active', mode === 'register');
  $('auth-submit').textContent = mode === 'login' ? 'دخول' : 'إنشاء الحساب';
  $('auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('reg-hints').hidden = mode !== 'register';
  if (mode === 'register') updatePwChecklist();
  $('auth-error').hidden = true;
}
$('tab-login').onclick = () => setAuthMode('login');
$('tab-register').onclick = () => setAuthMode('register');

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('auth-username').value.trim();
  const password = $('auth-password').value;
  if (authMode === 'register') {
    // تحقق فوري بنفس قواعد الخادم — دون أي فحص تركيبي عند الدخول
    let err = null;
    if (!USERNAME_RE.test(username)) err = USERNAME_ERROR;
    else {
      const missing = passwordMissing(password);
      if (missing.length) err = 'كلمة المرور يجب أن تحتوي على: ' + missing.join(' + ');
    }
    if (err) {
      $('auth-error').textContent = err;
      $('auth-error').hidden = false;
      return;
    }
  }
  try {
    const data = await api(authMode === 'login' ? '/api/login' : '/api/register', {
      method: 'POST', body: JSON.stringify({ username, password }),
    });
    token = data.token; me = data.user;
    localStorage.setItem('msg_token', token);
    enterApp();
  } catch (err) {
    $('auth-error').textContent = err.message;
    $('auth-error').hidden = false;
  }
});

$('logout-btn').onclick = async () => {
  cleanupCall();
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  token = null; me = null; currentChat = null;
  localStorage.removeItem('msg_token');
  if (ws) ws.close();
  show('auth-screen');
};

// ---------- الدخول للتطبيق ----------
async function enterApp() {
  $('my-name').textContent = me.username;
  show('main-screen');
  connectWs();
  await loadConversations();
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
  ws.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.type === 'authed') { $('conn-dot').classList.add('online'); $('conn-dot').classList.remove('offline'); }
    if (data.type === 'presence') {
      onlineUsers = new Set(data.online);
      updatePresenceUI();
      loadPeople($('people-search').value.trim());
    }
    if (data.type === 'message') {
      const m = data.message;
      const other = m.from === me.username ? m.to : m.from;
      if (currentChat === other) {
        appendMessage(m);
        if (m.from === currentChat) markRead(m.from);
      }
      loadConversations();
    }
    if (data.type === 'message_deleted') {
      const el = document.querySelector(`.bubble[data-id="${data.id}"]`);
      if (data.scope === 'everyone') {
        if (el) renderTombstone(el);
      } else if (data.scope === 'me' && data.by === me.username) {
        // حذف «لديّ» من جهاز آخر لنفس المستخدم — أخفِها هنا أيضاً
        if (el) el.remove();
      }
      loadConversations();
    }
    if (typeof data.type === 'string' && data.type.startsWith('call_')) {
      handleCallEvent(data);
    }
    if (data.type === 'sent' || data.type === 'delivered') {
      if (currentChat) refreshChatTicks();
      loadConversations();
    }
    if (data.type === 'read_receipt') {
      if (currentChat === data.with) refreshChatTicks();
    }
  };
  ws.onclose = () => {
    $('conn-dot').classList.remove('online'); $('conn-dot').classList.add('offline');
    if (call) endCallWithMessage('انقطع الاتصال بالخادم');
    if (token) setTimeout(connectWs, 3000); // إعادة اتصال تلقائية
  };
}

// ---------- المحادثات ----------
function previewText(m) {
  if (!m) return '';
  if (m.deleted) return '🚫 تم حذف هذه الرسالة';
  if (m.kind === 'image') return '📷 صورة';
  if (m.kind === 'video') return '🎥 فيديو';
  if (m.kind === 'voice') return '🎤 رسالة صوتية';
  return m.text || '';
}
async function loadConversations() {
  if (!me) return;
  const { conversations } = await api('/api/conversations');
  const list = $('conversation-list');
  list.innerHTML = '';
  $('chats-empty').style.display = conversations.length ? 'none' : 'block';
  for (const c of conversations) {
    const li = document.createElement('li');
    const last = c.lastMessage;
    li.innerHTML = `
      <div class="avatar">${escapeHtml(c.username[0] || '؟')}</div>
      <div class="row-main">
        <div class="row-title"><span>${escapeHtml(c.username)}</span><time>${last ? fmtTime(last.ts) : ''}</time></div>
        <div class="row-sub">${escapeHtml(previewText(last))}</div>
      </div>
      ${c.unread ? `<span class="badge">${c.unread}</span>` : ''}`;
    li.onclick = () => openChat(c.username);
    list.appendChild(li);
  }
}

// ---------- الأشخاص ----------
async function loadPeople(q = '') {
  if (!me || $('view-people').hidden) return;
  const { users } = await api('/api/users' + (q ? '?q=' + encodeURIComponent(q) : ''));
  const list = $('people-list');
  list.innerHTML = '';
  $('people-empty').hidden = users.length > 0;
  for (const u of users) {
    const on = onlineUsers.has(u.username);
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="avatar">${escapeHtml(u.username[0] || '؟')}</div>
      <div class="row-main">
        <div class="row-title"><span>${escapeHtml(u.username)}</span></div>
        <div class="row-sub">${on ? 'متصل الآن' : 'غير متصل'}</div>
      </div>`;
    li.onclick = () => openChat(u.username);
    list.appendChild(li);
  }
}
$('people-search').addEventListener('input', (e) => loadPeople(e.target.value.trim()));

function setMainTab(which) {
  $('tab-chats').classList.toggle('active', which === 'chats');
  $('tab-people').classList.toggle('active', which === 'people');
  $('view-chats').hidden = which !== 'chats';
  $('view-people').hidden = which !== 'people';
  if (which === 'people') loadPeople($('people-search').value.trim());
  else loadConversations();
}
$('tab-chats').onclick = () => setMainTab('chats');
$('tab-people').onclick = () => setMainTab('people');

// ---------- المحادثة ----------
async function openChat(username) {
  currentChat = username;
  $('chat-name').textContent = username;
  updatePresenceUI();
  show('chat-screen');
  $('messages').innerHTML = '';
  const { messages } = await api('/api/messages/' + encodeURIComponent(username));
  for (const m of messages) appendMessage(m, false);
  scrollBottom();
  await markRead(username);
  loadConversations();
}
$('back-btn').onclick = () => { currentChat = null; show('main-screen'); loadConversations(); };

function appendMessage(m, scroll = true) {
  if (m.kind === 'call' && !m.deleted) {
    const div = document.createElement('div');
    div.className = 'call-record';
    div.dataset.id = m.id;
    div.textContent = `${m.text} · ${fmtTime(m.ts)}`;
    $('messages').appendChild(div);
    if (scroll) scrollBottom();
    return;
  }
  const div = document.createElement('div');
  div.className = 'bubble ' + (m.from === me.username ? 'mine' : 'theirs');
  div.dataset.id = m.id;
  div.dataset.from = m.from;
  const meta = `<span class="meta">${fmtTime(m.ts)}${m.from === me.username ? ' ' + ticks(m) : ''}</span>`;
  if (m.deleted) {
    div.classList.add('deleted');
    div.innerHTML = `<span class="deleted-text">🚫 تم حذف هذه الرسالة</span>${meta}`;
  } else if (m.kind === 'image') {
    div.classList.add('media');
    div.innerHTML = `<a href="${m.fileUrl}" target="_blank" rel="noopener"><img class="msg-img" src="${m.fileUrl}" alt="صورة" loading="lazy"></a>${meta}`;
  } else if (m.kind === 'video') {
    div.classList.add('media');
    div.innerHTML = `<video class="msg-video" src="${m.fileUrl}" controls preload="metadata" playsinline></video>${meta}`;
  } else if (m.kind === 'voice') {
    div.classList.add('media');
    div.innerHTML = `<div class="voice-player"><button type="button" class="voice-play" title="تشغيل">▶</button><span class="voice-dur">${fmtCallDuration(m.durationSec || 0)}</span><audio src="${m.fileUrl}" preload="metadata"></audio></div>${meta}`;
    wireVoicePlayer(div, m);
  } else {
    div.innerHTML = `${escapeHtml(m.text)}${meta}`;
  }
  $('messages').appendChild(div);
  if (scroll) scrollBottom();
}

// مشغّل الرسائل الصوتية: زر تشغيل/إيقاف + مدة تتحدث أثناء التشغيل
function wireVoicePlayer(div, m) {
  const audio = div.querySelector('audio');
  const btn = div.querySelector('.voice-play');
  const dur = div.querySelector('.voice-dur');
  if (!audio || !btn) return;
  const total = () => Math.round(m.durationSec || (isFinite(audio.duration) ? audio.duration : 0));
  btn.onclick = () => {
    if (audio.paused) {
      document.querySelectorAll('.voice-player audio').forEach((a) => { if (a !== audio) a.pause(); });
      audio.play().catch(() => {});
    } else audio.pause();
  };
  audio.onplay = () => { btn.textContent = '⏸'; };
  audio.onpause = () => { btn.textContent = '▶'; };
  audio.onloadedmetadata = () => { if (!m.durationSec && isFinite(audio.duration)) dur.textContent = fmtCallDuration(Math.round(audio.duration)); };
  audio.ontimeupdate = () => { if (!audio.paused) dur.textContent = fmtCallDuration(Math.floor(audio.currentTime)) + ' / ' + fmtCallDuration(total()); };
  audio.onended = () => { btn.textContent = '▶'; dur.textContent = fmtCallDuration(total()); };
}
async function refreshChatTicks() {
  if (!currentChat) return;
  const { messages } = await api('/api/messages/' + encodeURIComponent(currentChat));
  $('messages').innerHTML = '';
  for (const m of messages) appendMessage(m, false);
  scrollBottom();
}
function scrollBottom() { const el = $('messages'); el.scrollTop = el.scrollHeight; }

async function markRead(username) {
  try { await api('/api/messages/' + encodeURIComponent(username) + '/read', { method: 'POST' }); } catch {}
}

$('send-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('message-input').value.trim();
  if (!text || !currentChat) return;
  $('message-input').value = '';
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'send', to: currentChat, text }));
    // ستظهر الرسالة عبر حدث "sent" — ولضمان الظهور الفوري نطلب تحديثاً
    setTimeout(() => { if (currentChat) refreshChatTicks(); }, 150);
  } else {
    api('/api/messages/' + encodeURIComponent(currentChat), { method: 'POST', body: JSON.stringify({ text }) })
      .then(({ message }) => appendMessage(message))
      .catch((err) => alert(err.message));
  }
});

// ---------- حذف الرسائل (قائمة بالضغط المطوّل أو النقر باليمين) ----------
let menuMsgId = null;
let menuEl = null;

function renderTombstone(el) {
  if (!el || el.classList.contains('deleted')) return;
  const meta = el.querySelector('.meta');
  el.classList.add('deleted');
  el.classList.remove('media');
  el.innerHTML = '<span class="deleted-text">🚫 تم حذف هذه الرسالة</span>';
  if (meta) el.appendChild(meta);
}
function openMsgMenu(el, x, y) {
  menuMsgId = el.dataset.id;
  menuEl = el;
  $('menu-del-everyone').hidden = el.dataset.from !== me.username; // «لدى الجميع» لرسائلي فقط
  const menu = $('msg-menu');
  menu.hidden = false;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - 210)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - 170)) + 'px';
}
function closeMsgMenu() {
  $('msg-menu').hidden = true;
  menuMsgId = null;
  menuEl = null;
}
async function deleteMessage(scope) {
  const id = menuMsgId;
  const el = menuEl;
  closeMsgMenu();
  if (!id) return;
  try {
    await api('/api/messages/' + encodeURIComponent(id), { method: 'DELETE', body: JSON.stringify({ scope }) });
  } catch (err) { alert(err.message); return; }
  if (scope === 'me') { if (el) el.remove(); }
  else if (el) renderTombstone(el);
  loadConversations();
}
$('menu-del-everyone').onclick = () => deleteMessage('everyone');
$('menu-del-me').onclick = () => deleteMessage('me');
$('menu-cancel').onclick = closeMsgMenu;

const msgBox = $('messages');
msgBox.addEventListener('contextmenu', (e) => {
  const b = e.target.closest('.bubble');
  if (!b || b.classList.contains('deleted')) return;
  e.preventDefault();
  openMsgMenu(b, e.clientX, e.clientY);
});
let pressTimer = null;
let suppressClick = false;
msgBox.addEventListener('pointerdown', (e) => {
  const b = e.target.closest('.bubble');
  if (!b || b.classList.contains('deleted')) return;
  if (e.target.closest('video, audio, button')) return; // ضوابط الوسائط لها تفاعلها
  const x = e.clientX, y = e.clientY;
  pressTimer = setTimeout(() => { suppressClick = true; openMsgMenu(b, x, y); }, 600);
});
for (const ev of ['pointerup', 'pointercancel', 'pointermove']) {
  msgBox.addEventListener(ev, () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } }, { passive: true });
}
msgBox.addEventListener('click', (e) => {
  if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); }
}, true);
document.addEventListener('pointerdown', (e) => {
  if (!$('msg-menu').hidden && !e.target.closest('#msg-menu') && !e.target.closest('.bubble')) closeMsgMenu();
});

// ---------- رفع الملفات وإرسال الوسائط ----------
let uploading = false;

async function uploadFile(blob, name) {
  uploading = true;
  $('upload-status').hidden = false;
  $('attach-btn').disabled = true;
  $('mic-btn').disabled = true;
  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': (blob.type || '').split(';')[0] || 'application/octet-stream',
        'X-File-Name': encodeURIComponent(name || 'file'),
      },
      body: blob, // البايتات الأصلية كما هي — بلا أي ضغط أو إعادة ترميز
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'فشل الرفع');
    return data;
  } finally {
    uploading = false;
    $('upload-status').hidden = true;
    $('attach-btn').disabled = false;
    $('mic-btn').disabled = false;
  }
}
function sendMediaMessage(kind, fileId, durationSec) {
  if (!currentChat) return;
  const payload = { kind, fileId, durationSec: durationSec || 0 };
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'send', to: currentChat, ...payload }));
    setTimeout(() => { if (currentChat) refreshChatTicks(); }, 150);
  } else {
    api('/api/messages/' + encodeURIComponent(currentChat), { method: 'POST', body: JSON.stringify(payload) })
      .then(({ message }) => appendMessage(message))
      .catch((err) => alert(err.message));
  }
}
function probeVideoDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    const done = (d) => { URL.revokeObjectURL(url); resolve(d); };
    v.onloadedmetadata = () => done(isFinite(v.duration) ? Math.round(v.duration) : 0);
    v.onerror = () => done(0);
    setTimeout(() => done(0), 3000);
    v.src = url;
  });
}
$('attach-btn').onclick = () => { if (!uploading) $('file-input').click(); };
$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !currentChat) return;
  const kind = file.type.startsWith('video/') ? 'video' : 'image';
  let durationSec = 0;
  if (kind === 'video') durationSec = await probeVideoDuration(file).catch(() => 0);
  try {
    const up = await uploadFile(file, file.name);
    sendMediaMessage(kind, up.fileId, durationSec);
  } catch (err) { alert(err.message || 'فشل رفع الملف'); }
});

// ---------- تسجيل رسالة صوتية ----------
// الحد الأقصى: 60 ثانية من زمن التسجيل الفعلي — فترات الإيقاف المؤقت لا تُحسب.
// يُتتبَّع الزمن الفعلي كمقاطع: كل مقطع بين بدء/متابعة وإيقاف مؤقت/إيقاف.
const REC_MAX_SEC = 60;
let recorder = null, recChunks = [], recStream = null, recTimerInt = null, recSendOnStop = false;
let recAccumMs = 0;         // الزمن الفعلي المتراكم من المقاطع المكتملة
let recSegmentStart = 0;    // طابع بداية المقطع الجاري (0 أثناء الإيقاف المؤقت)
let recPaused = false;
let recCanPause = false;
let recStopping = false;
let recAutoStopped = false; // توقّف تلقائياً عند بلوغ الحد الأقصى
let recPending = null;      // { blob, durationSec } — تسجيل بلغ الحد، جاهز للإرسال/الإلغاء

function recActiveMs() {
  return recAccumMs + (recSegmentStart ? Date.now() - recSegmentStart : 0);
}
function recActiveSec() {
  return Math.min(REC_MAX_SEC, Math.floor(recActiveMs() / 1000));
}
function setRecLabel(text) { $('rec-label').textContent = text; }
function recUiTick() {
  $('rec-time').textContent = fmtCallDuration(recActiveSec());
  if (!recPaused && recActiveMs() >= REC_MAX_SEC * 1000) hitRecLimit();
}

async function startRecording() {
  if (recorder || recPending || uploading) return;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { alert('تعذّر الوصول إلى الميكروفون. تحقّق من أذونات المتصفح ثم حاول مرة أخرى.'); return; }
  recStream = stream;
  recChunks = [];
  try { recorder = new MediaRecorder(stream); } catch { recorder = null; }
  if (!recorder) {
    stream.getTracks().forEach((t) => t.stop());
    recStream = null;
    alert('التسجيل الصوتي غير مدعوم في هذا المتصفح');
    return;
  }
  // دعم الإيقاف المؤقت/المتابعة يختلف بين المتصفحات — يُخفى الزر عند غيابه
  recCanPause = typeof recorder.pause === 'function' && typeof recorder.resume === 'function';
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  recorder.onstop = finishRecording;
  recAccumMs = 0;
  recPaused = false;
  recStopping = false;
  recAutoStopped = false;
  recorder.start();
  recSegmentStart = Date.now();
  $('rec-time').textContent = '00:00';
  setRecLabel('جارٍ التسجيل…');
  $('recording-bar').classList.remove('paused');
  $('rec-pause').hidden = !recCanPause;
  $('rec-pause').textContent = '⏸ إيقاف مؤقت';
  $('recording-bar').hidden = false;
  recTimerInt = setInterval(recUiTick, 250);
}

function hitRecLimit() {
  if (!recorder || recStopping || recAutoStopped) return;
  recAutoStopped = true;
  stopRecording(true);
}

function toggleRecPause() {
  if (!recorder || !recCanPause) return;
  try {
    if (!recPaused && recorder.state === 'recording') {
      recorder.pause();
      recAccumMs += Date.now() - recSegmentStart;
      recSegmentStart = 0;
      recPaused = true;
      $('rec-pause').textContent = '▶ متابعة';
      setRecLabel('متوقف مؤقتاً');
      $('recording-bar').classList.add('paused');
    } else if (recPaused && recorder.state === 'paused') {
      recorder.resume();
      recSegmentStart = Date.now();
      recPaused = false;
      $('rec-pause').textContent = '⏸ إيقاف مؤقت';
      setRecLabel('جارٍ التسجيل…');
      $('recording-bar').classList.remove('paused');
    }
  } catch {
    // متصفح يعرض الدالتين ثم يرمي استثناءً عند الاستدعاء — عطّل الزر بصمت
    recCanPause = false;
    $('rec-pause').hidden = true;
  }
}

function stopRecording(send) {
  if (!recorder || recStopping) return;
  recStopping = true;
  recSendOnStop = send;
  try { recorder.stop(); } catch { finishRecording(); }
}

function resetRecBar() {
  $('recording-bar').hidden = true;
  $('recording-bar').classList.remove('paused');
  $('rec-pause').hidden = true;
}

async function sendVoiceBlob(blob, durationSec) {
  const type = blob.type || 'audio/webm';
  const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : type.includes('mpeg') ? 'mp3' : type.includes('wav') ? 'wav' : 'webm';
  try {
    const up = await uploadFile(blob, 'voice.' + ext);
    sendMediaMessage('voice', up.fileId, durationSec);
  } catch (err) { alert(err.message || 'فشل رفع التسجيل'); }
}
async function finishRecording() {
  recStopping = false;
  if (recTimerInt) { clearInterval(recTimerInt); recTimerInt = null; }
  if (recStream) { recStream.getTracks().forEach((t) => t.stop()); recStream = null; }
  const shouldSend = recSendOnStop;
  const autoStopped = recAutoStopped;
  const chunks = recChunks; recChunks = [];
  const rec = recorder; recorder = null; recSendOnStop = false; recAutoStopped = false;
  // المدة المُرسلة = زمن التسجيل الفعلي فقط (دون فترات الإيقاف المؤقت)، بسقف 60 ثانية
  const durationSec = Math.min(REC_MAX_SEC, Math.max(1, Math.round(recActiveMs() / 1000)));
  recAccumMs = 0; recSegmentStart = 0; recPaused = false;
  if (!chunks.length) { resetRecBar(); return; }
  const type = (rec && rec.mimeType) || 'audio/webm';
  const blob = new Blob(chunks, { type });
  if (autoStopped) {
    // بلغ الحد الأقصى فتوقّف تلقائياً: التسجيل جاهز الآن — بانتظار «إرسال» أو «إلغاء»
    recPending = { blob, durationSec };
    $('rec-time').textContent = fmtCallDuration(durationSec);
    setRecLabel('وصلت إلى الحد الأقصى: دقيقة واحدة');
    $('rec-pause').hidden = true;
    $('recording-bar').classList.remove('paused');
    $('recording-bar').hidden = false;
    return;
  }
  resetRecBar();
  if (!shouldSend || !currentChat) return;
  await sendVoiceBlob(blob, durationSec);
}
$('mic-btn').onclick = startRecording;
$('rec-pause').onclick = toggleRecPause;
$('rec-cancel').onclick = () => {
  if (recPending) { recPending = null; resetRecBar(); return; }
  stopRecording(false);
};
$('rec-send').onclick = async () => {
  if (recPending) {
    const pending = recPending; recPending = null; resetRecBar();
    if (currentChat) await sendVoiceBlob(pending.blob, pending.durationSec);
    return;
  }
  stopRecording(true);
};

function updatePresenceUI() {
  if (!currentChat) return;
  const on = onlineUsers.has(currentChat);
  $('chat-presence').textContent = on ? '• متصل الآن' : '• غير متصل';
  $('chat-presence').classList.toggle('on', on);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- المكالمات (WebRTC — الإشارة عبر خادمنا، والوسائط مباشرة بين الجهازين) ----------
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};
const RING_TIMEOUT_MS = 30000;
let call = null; // { peer, type, role, status, pc, localStream, connectedAt, acceptedAt, timer, ringTimeout, pendingIce }
let ringCtx = null;
let ringInterval = null;

function callSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function fmtCallDuration(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
}
function callDurationSeconds() {
  if (!call) return 0;
  const start = call.connectedAt || call.acceptedAt;
  return start ? Math.round((Date.now() - start) / 1000) : 0;
}

// ----- نغمة الرنين (WebAudio — بدون أي ملف خارجي) -----
function startRingtone() {
  stopRingtone();
  try {
    ringCtx = new (window.AudioContext || window.webkitAudioContext)();
    const beep = () => {
      if (!ringCtx) return;
      const t = ringCtx.currentTime;
      for (const off of [0, 0.35]) {
        const osc = ringCtx.createOscillator();
        const gain = ringCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, t + off);
        gain.gain.exponentialRampToValueAtTime(0.15, t + off + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.3);
        osc.connect(gain);
        gain.connect(ringCtx.destination);
        osc.start(t + off);
        osc.stop(t + off + 0.32);
      }
    };
    if (ringCtx.state === 'suspended') ringCtx.resume().catch(() => {});
    beep();
    ringInterval = setInterval(beep, 2000);
  } catch {}
}
function stopRingtone() {
  if (ringInterval) { clearInterval(ringInterval); ringInterval = null; }
  if (ringCtx) { ringCtx.close().catch(() => {}); ringCtx = null; }
  if (navigator.vibrate) navigator.vibrate(0);
}

// ----- واجهة المكالمة -----
function showCallOverlay(mode) {
  const isVideo = call.type === 'video';
  $('call-overlay').hidden = false;
  $('call-peer-name').textContent = call.peer;
  $('call-avatar').textContent = call.peer[0] || '؟';
  $('call-avatar').hidden = isVideo;
  $('remote-video').hidden = !(isVideo && mode === 'active');
  $('local-video').hidden = !isVideo;
  $('call-incoming-actions').hidden = mode !== 'incoming';
  $('call-outgoing-actions').hidden = mode !== 'outgoing';
  $('call-controls').hidden = mode !== 'active';
  $('call-error').hidden = true;
  $('call-camera').style.display = isVideo ? '' : 'none';
  $('call-mute').classList.remove('off');
  $('call-mute').textContent = '🎤 كتم';
  $('call-camera').classList.remove('off');
  $('call-camera').textContent = '📷 الكاميرا';
  updateSpeakerBtn();
  if (mode === 'outgoing') $('call-status').textContent = 'جارٍ الاتصال…';
  else if (mode === 'incoming') $('call-status').textContent = isVideo ? 'مكالمة فيديو واردة' : 'مكالمة صوتية واردة';
  else $('call-status').textContent = '00:00';
}
function teardownCallMedia() {
  stopRingtone();
  if (!call) return;
  if (call.ringTimeout) clearTimeout(call.ringTimeout);
  if (call.timer) clearInterval(call.timer);
  if (call.pc) { try { call.pc.close(); } catch {} }
  if (call.localStream) call.localStream.getTracks().forEach((t) => t.stop());
}
function cleanupCall() {
  teardownCallMedia();
  call = null;
  $('call-overlay').hidden = true;
  $('remote-video').srcObject = null;
  $('local-video').srcObject = null;
  $('remote-audio').srcObject = null;
}
function endCallWithMessage(msg) {
  if (!call) { $('call-overlay').hidden = true; return; }
  teardownCallMedia();
  call = null;
  $('call-status').textContent = msg;
  $('call-incoming-actions').hidden = true;
  $('call-outgoing-actions').hidden = true;
  $('call-controls').hidden = true;
  setTimeout(() => {
    if (!call) {
      $('call-overlay').hidden = true;
      $('remote-video').srcObject = null;
      $('local-video').srcObject = null;
      $('remote-audio').srcObject = null;
    }
  }, 1600);
}
function startCallTimer() {
  if (!call || call.timer) return;
  call.timer = setInterval(() => {
    if (call) $('call-status').textContent = fmtCallDuration(callDurationSeconds());
  }, 500);
}

// ----- اتصال WebRTC -----
// جودة فيديو عالية للمكالمات المرئية (720p مثالي، حتى 1080p، 30fps)
const VIDEO_CONSTRAINTS = {
  width: { ideal: 1280, max: 1920 },
  height: { ideal: 720, max: 1080 },
  frameRate: { ideal: 30, max: 30 },
  facingMode: 'user',
};
function setupPeerConnection() {
  const pc = new RTCPeerConnection(ICE_CONFIG);
  call.pc = pc;
  for (const track of call.localStream.getTracks()) pc.addTrack(track, call.localStream);
  // رفع جودة الإرسال: تلميح «تفاصيل» لمسار الفيديو + حد بت أعلى بدون تصغير للدقة
  const localVideoTrack = call.localStream.getVideoTracks()[0];
  if (localVideoTrack) { try { localVideoTrack.contentHint = 'detail'; } catch {} }
  if (call.type === 'video') {
    for (const sender of pc.getSenders()) {
      if (sender.track && sender.track.kind === 'video') {
        try {
          const params = sender.getParameters() || {};
          const existing = (params.encodings && params.encodings[0]) || {};
          params.encodings = [{ ...existing, maxBitrate: 2500000, maxFramerate: 30, scaleResolutionDownBy: 1 }];
          const p = sender.setParameters(params);
          if (p && p.catch) p.catch(() => {});
        } catch {}
      }
    }
  }
  if (call.type === 'video') $('local-video').srcObject = call.localStream;
  pc.onicecandidate = (e) => {
    if (e.candidate && call) callSend({ type: 'call_ice', to: call.peer, candidate: e.candidate.toJSON() });
  };
  pc.ontrack = (e) => {
    const stream = e.streams[0];
    if (call && call.type === 'video') {
      // فيديو: الصوت والصورة عبر عنصر الفيديو
      $('remote-video').srcObject = stream;
      $('remote-video').hidden = false;
    } else {
      // صوت فقط: عبر عنصر صوت مخصص ليتمكن setSinkId من تبديل مخرج الصوت
      $('remote-audio').srcObject = stream;
    }
    applyAudioOutput(false);
  };
  pc.onconnectionstatechange = () => {
    if (!call || call.pc !== pc) return;
    if (pc.connectionState === 'connected' && !call.connectedAt) {
      call.connectedAt = Date.now();
      startCallTimer();
    } else if ((pc.connectionState === 'failed' || pc.connectionState === 'disconnected') && call.status === 'active' && call.connectedAt) {
      callSend({ type: 'call_end', to: call.peer, duration: callDurationSeconds() });
      endCallWithMessage('انقطع الاتصال');
    }
  };
}
function flushPendingIce() {
  if (!call || !call.pc) return;
  for (const c of call.pendingIce) call.pc.addIceCandidate(c).catch(() => {});
  call.pendingIce = [];
}

// ----- بدء مكالمة صادرة -----
async function startCall(type) {
  if (call || !currentChat) return;
  const peer = currentChat;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: type === 'video' ? VIDEO_CONSTRAINTS : false });
  } catch {
    alert('تعذّر الوصول إلى ' + (type === 'video' ? 'الكاميرا والميكروفون' : 'الميكروفون') + '. تحقّق من أذونات المتصفح ثم حاول مرة أخرى.');
    return;
  }
  call = {
    peer, type, role: 'caller', status: 'outgoing',
    pc: null, localStream: stream, connectedAt: null, acceptedAt: null,
    timer: null, ringTimeout: null, pendingIce: [],
    speaker: type === 'video', // الفيديو: مكبر صوت افتراضياً — الصوتية: سماعة الهاتف
  };
  setupPeerConnection();
  showCallOverlay('outgoing');
  callSend({ type: 'call_invite', to: peer, callType: type });
  call.ringTimeout = setTimeout(() => {
    if (call && call.status === 'outgoing') {
      callSend({ type: 'call_end', to: call.peer });
      endCallWithMessage('لم يتم الرد على المكالمة');
    }
  }, RING_TIMEOUT_MS);
}
$('call-voice-btn').onclick = () => startCall('voice');
$('call-video-btn').onclick = () => startCall('video');

// ----- أحداث الإشارة الواردة من الخادم -----
function handleCallEvent(data) {
  switch (data.type) {
    case 'call_invite': {
      if (call) return; // مشغول محلياً أصلاً
      call = {
        peer: data.from, type: data.callType === 'video' ? 'video' : 'voice',
        role: 'callee', status: 'incoming',
        pc: null, localStream: null, connectedAt: null, acceptedAt: null,
        timer: null, ringTimeout: null, pendingIce: [],
        speaker: data.callType === 'video',
      };
      showCallOverlay('incoming');
      startRingtone();
      if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]);
      call.ringTimeout = setTimeout(() => {
        if (call && call.status === 'incoming') cleanupCall(); // توقف الرنين دون رد
      }, RING_TIMEOUT_MS);
      break;
    }
    case 'call_accept': {
      if (!call || call.role !== 'caller' || !call.pc) return;
      if (call.ringTimeout) clearTimeout(call.ringTimeout);
      call.status = 'active';
      call.acceptedAt = Date.now();
      showCallOverlay('active');
      (async () => {
        try {
          const offer = await call.pc.createOffer();
          await call.pc.setLocalDescription(offer);
          callSend({ type: 'call_offer', to: call.peer, sdp: call.pc.localDescription });
        } catch {}
      })();
      break;
    }
    case 'call_offer': {
      if (!call || call.role !== 'callee' || !call.pc) return;
      (async () => {
        try {
          await call.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          flushPendingIce();
          const answer = await call.pc.createAnswer();
          await call.pc.setLocalDescription(answer);
          callSend({ type: 'call_answer', to: call.peer, sdp: call.pc.localDescription });
        } catch {}
      })();
      break;
    }
    case 'call_answer': {
      if (!call || !call.pc) return;
      (async () => {
        try {
          await call.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          flushPendingIce();
        } catch {}
      })();
      break;
    }
    case 'call_ice': {
      if (!call || !data.candidate) return;
      const cand = new RTCIceCandidate(data.candidate);
      if (call.pc && call.pc.remoteDescription) call.pc.addIceCandidate(cand).catch(() => {});
      else call.pendingIce.push(cand);
      break;
    }
    case 'call_reject': if (call) endCallWithMessage('تم رفض المكالمة'); break;
    case 'call_busy': if (call) endCallWithMessage('المستخدم مشغول في مكالمة أخرى'); break;
    case 'call_unavailable': if (call) endCallWithMessage('المستخدم غير متصل الآن'); break;
    case 'call_end': if (call) endCallWithMessage('انتهت المكالمة'); break;
  }
}

// ----- أزرار واجهة المكالمة -----
$('call-accept').onclick = async () => {
  if (!call || call.status !== 'incoming') return;
  stopRingtone();
  if (call.ringTimeout) clearTimeout(call.ringTimeout);
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: call.type === 'video' ? VIDEO_CONSTRAINTS : false });
  } catch {
    callSend({ type: 'call_reject', to: call.peer });
    $('call-error').textContent = 'تعذّر الوصول إلى الميكروفون/الكاميرا — أُنهيت المكالمة. تحقّق من أذونات المتصفح.';
    $('call-error').hidden = false;
    teardownCallMedia();
    call = null;
    setTimeout(() => { $('call-overlay').hidden = true; }, 2500);
    return;
  }
  call.localStream = stream;
  call.status = 'active';
  call.acceptedAt = Date.now();
  setupPeerConnection();
  showCallOverlay('active');
  callSend({ type: 'call_accept', to: call.peer });
};
$('call-reject').onclick = () => {
  if (!call) return;
  callSend({ type: 'call_reject', to: call.peer });
  cleanupCall();
};
$('call-cancel').onclick = () => {
  if (!call) return;
  callSend({ type: 'call_end', to: call.peer });
  cleanupCall();
};
$('call-end').onclick = () => {
  if (!call) return;
  callSend({ type: 'call_end', to: call.peer, duration: callDurationSeconds() });
  cleanupCall();
};
$('call-mute').onclick = () => {
  if (!call || !call.localStream) return;
  const tracks = call.localStream.getAudioTracks();
  if (!tracks.length) return;
  const enabled = !tracks[0].enabled;
  tracks.forEach((t) => { t.enabled = enabled; });
  $('call-mute').classList.toggle('off', !enabled);
  $('call-mute').textContent = enabled ? '🎤 كتم' : '🔇 مكتوم';
};
$('call-camera').onclick = () => {
  if (!call || !call.localStream) return;
  const tracks = call.localStream.getVideoTracks();
  if (!tracks.length) return;
  const enabled = !tracks[0].enabled;
  tracks.forEach((t) => { t.enabled = enabled; });
  $('call-camera').classList.toggle('off', !enabled);
  $('call-camera').textContent = enabled ? '📷 الكاميرا' : '🚫 الكاميرا';
};

// ----- مخرج الصوت: سماعة الهاتف / مكبر الصوت (setSinkId حيثما يدعمه المتصفح) -----
let callToastTimer = null;
function showCallToast(msg) {
  const t = $('call-toast');
  t.textContent = msg;
  t.hidden = false;
  if (callToastTimer) clearTimeout(callToastTimer);
  callToastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}
function updateSpeakerBtn() {
  if (!call) return;
  $('call-speaker').textContent = call.speaker ? '🔊 مكبر الصوت' : '📞 سماعة الهاتف';
  $('call-speaker').classList.toggle('off', !call.speaker);
}
/** تطبيق مخرج الصوت الحالي على العنصر الذي يشغّل صوت الطرف الآخر.
 *  userInitiated=true يعني أن المستخدم ضغط الزر الآن — عندها فقط نعرض تنبيهاً عند عدم الدعم. */
async function applyAudioOutput(userInitiated) {
  if (!call) return;
  const el = call.type === 'video' ? $('remote-video') : $('remote-audio');
  const fail = () => {
    if (userInitiated) showCallToast('تبديل السماعة غير مدعوم على هذا المتصفح — الصوت يتبع إعدادات الهاتف');
  };
  if (!el || typeof el.setSinkId !== 'function') return fail();
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outs = devices.filter((d) => d.kind === 'audiooutput');
    if (call.speaker) {
      const spk = outs.find((d) => /speaker|مكبر/i.test(d.label || ''));
      await el.setSinkId(spk ? spk.deviceId : ''); // '' = الجهاز الافتراضي (المكبر عادة)
    } else {
      const ear = outs.find((d) => /earpiece|receiver|سماعة/i.test(d.label || ''));
      if (!ear) return fail();
      await el.setSinkId(ear.deviceId);
    }
  } catch { fail(); }
}
$('call-speaker').onclick = () => {
  if (!call) return;
  call.speaker = !call.speaker;
  updateSpeakerBtn();
  applyAudioOutput(true);
};

// ---------- إقلاع ----------
(async () => {
  if (token) {
    try {
      const { user } = await api('/api/me');
      me = user;
      enterApp();
      return;
    } catch { token = null; localStorage.removeItem('msg_token'); }
  }
  show('auth-screen');
})();

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
function setAuthMode(mode) {
  authMode = mode;
  $('tab-login').classList.toggle('active', mode === 'login');
  $('tab-register').classList.toggle('active', mode === 'register');
  $('auth-submit').textContent = mode === 'login' ? 'دخول' : 'إنشاء الحساب';
  $('auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('auth-error').hidden = true;
}
$('tab-login').onclick = () => setAuthMode('login');
$('tab-register').onclick = () => setAuthMode('register');

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('auth-username').value.trim();
  const password = $('auth-password').value;
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
        <div class="row-sub">${last ? escapeHtml(last.text) : ''}</div>
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
  if (m.kind === 'call') {
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
  div.innerHTML = `${escapeHtml(m.text)}<span class="meta">${fmtTime(m.ts)}${m.from === me.username ? ' ' + ticks(m) : ''}</span>`;
  $('messages').appendChild(div);
  if (scroll) scrollBottom();
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
function setupPeerConnection() {
  const pc = new RTCPeerConnection(ICE_CONFIG);
  call.pc = pc;
  for (const track of call.localStream.getTracks()) pc.addTrack(track, call.localStream);
  if (call.type === 'video') $('local-video').srcObject = call.localStream;
  pc.onicecandidate = (e) => {
    if (e.candidate && call) callSend({ type: 'call_ice', to: call.peer, candidate: e.candidate.toJSON() });
  };
  pc.ontrack = (e) => {
    $('remote-video').srcObject = e.streams[0];
    if (call && call.type === 'video') $('remote-video').hidden = false;
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
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: type === 'video' });
  } catch {
    alert('تعذّر الوصول إلى ' + (type === 'video' ? 'الكاميرا والميكروفون' : 'الميكروفون') + '. تحقّق من أذونات المتصفح ثم حاول مرة أخرى.');
    return;
  }
  call = {
    peer, type, role: 'caller', status: 'outgoing',
    pc: null, localStream: stream, connectedAt: null, acceptedAt: null,
    timer: null, ringTimeout: null, pendingIce: [],
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
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: call.type === 'video' });
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

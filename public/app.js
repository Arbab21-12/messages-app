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
      if (currentChat === m.from) { appendMessage(m); markRead(m.from); }
      loadConversations();
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

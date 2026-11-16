'use strict';
/**
 * طبقة التخزين — وحدة واحدة مستقلة.
 * حالياً: ملف JSON واحد (data.json) مع كتابة ذرّية (ملف مؤقت + إعادة تسمية).
 * لاحقاً يمكن استبدال هذه الوحدة فقط بـ Postgres دون تغيير بقية الخادم،
 * لأن بقية الكود يتعامل مع الدوال التالية فقط:
 *   getUserByUsername, getUserById, createUser,
 *   createSession, getUserIdByToken, deleteSession,
 *   listUsers, addMessage, getConversation, markConversationRead,
 *   markDelivered, getUndeliveredFor
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

let db = { users: [], messages: [], sessions: {} };

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    db = {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
    };
  } catch {
    db = { users: [], messages: [], sessions: {} };
  }
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE); // كتابة ذرّية
}

load();

// ---------- المستخدمون ----------
function getUserByUsername(username) {
  const u = String(username).toLowerCase();
  return db.users.find((x) => x.username.toLowerCase() === u) || null;
}
function getUserById(id) {
  return db.users.find((x) => x.id === id) || null;
}
function createUser(user) {
  db.users.push(user);
  save();
  return user;
}
function listUsers(excludeId, query) {
  const q = query ? String(query).toLowerCase() : '';
  return db.users
    .filter((x) => x.id !== excludeId)
    .filter((x) => !q || x.username.toLowerCase().includes(q))
    .map((x) => ({ id: x.id, username: x.username, createdAt: x.createdAt }))
    .sort((a, b) => a.username.localeCompare(b.username));
}

// ---------- الجلسات ----------
function createSession(token, userId) {
  db.sessions[token] = userId;
  save();
}
function getUserIdByToken(token) {
  return db.sessions[token] || null;
}
function deleteSession(token) {
  if (db.sessions[token]) {
    delete db.sessions[token];
    save();
  }
}

// ---------- الرسائل ----------
function addMessage(msg) {
  db.messages.push(msg);
  save();
  return msg;
}
function getConversation(userIdA, userIdB) {
  return db.messages
    .filter(
      (m) =>
        (m.fromId === userIdA && m.toId === userIdB) ||
        (m.fromId === userIdB && m.toId === userIdA)
    )
    .sort((a, b) => a.ts - b.ts);
}
function getAllConversationsFor(userId) {
  return db.messages.filter((m) => m.fromId === userId || m.toId === userId);
}
function markConversationRead(readerId, otherId) {
  const now = Date.now();
  let changed = [];
  for (const m of db.messages) {
    if (m.fromId === otherId && m.toId === readerId && !m.readAt) {
      m.readAt = now;
      if (!m.deliveredAt) m.deliveredAt = now;
      changed.push(m);
    }
  }
  if (changed.length) save();
  return changed;
}
function markDelivered(message) {
  if (!message.deliveredAt) {
    message.deliveredAt = Date.now();
    save();
  }
  return message;
}
function getUndeliveredFor(userId) {
  return db.messages.filter((m) => m.toId === userId && !m.deliveredAt);
}
function markManyDelivered(messages) {
  if (!messages.length) return;
  const now = Date.now();
  for (const m of messages) if (!m.deliveredAt) m.deliveredAt = now;
  save();
}

module.exports = {
  getUserByUsername,
  getUserById,
  createUser,
  listUsers,
  createSession,
  getUserIdByToken,
  deleteSession,
  addMessage,
  getConversation,
  getAllConversationsFor,
  markConversationRead,
  markDelivered,
  getUndeliveredFor,
  markManyDelivered,
};

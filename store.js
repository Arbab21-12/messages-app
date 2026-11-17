'use strict';
/**
 * طبقة التخزين — وحدة واحدة مستقلة.
 * حالياً: ملف JSON واحد (data.json) مع كتابة ذرّية (ملف مؤقت + إعادة تسمية).
 * لاحقاً يمكن استبدال هذه الوحدة فقط بـ Postgres دون تغيير بقية الخادم،
 * لأن بقية الكود يتعامل مع الدوال التالية فقط:
 *   getUserByUsername, getUserById, createUser, saveUser,
 *   createSession, getUserIdByToken, deleteSession,
 *   listUsers, addMessage, getConversation, markConversationRead,
 *   markDelivered, getUndeliveredFor,
 *   getNameReservation, addNameReservation, removeNameReservation,
 *   listAllUsers, getAllMessages, listUploads
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

let db = { users: [], messages: [], sessions: {}, uploads: {}, nameReservations: [] };

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    db = {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
      uploads: parsed.uploads && typeof parsed.uploads === 'object' ? parsed.uploads : {},
      nameReservations: Array.isArray(parsed.nameReservations) ? parsed.nameReservations : [],
    };
  } catch {
    db = { users: [], messages: [], sessions: {}, uploads: {}, nameReservations: [] };
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
// الهوية والفرادة بمطابقة دقيقة لحالة الأحرف (exact match): «omer» و«Omer» حسابان مختلفان،
// والدخول يتطلب نفس حالة الأحرف المسجّلة. البحث في الدليل وحده يبقى غير حسّاس للحالة
// (مطابقة جزئية) لتسهيل إيجاد الأشخاص — دون أن يؤثر على الهوية.
function getUserByUsername(username) {
  const u = String(username);
  return db.users.find((x) => x.username === u) || null;
}
function getUserById(id) {
  return db.users.find((x) => x.id === id) || null;
}
function createUser(user) {
  db.users.push(user);
  save();
  return user;
}
/** حفظ أي تعديل أُجري على سجل مستخدم موجود (صورة شخصية/تغيير اسم…) — يُعدَّل في مكانه ثم تُستدعى هذه. */
function saveUser() {
  save();
}
function avatarUrl(u) {
  return u && u.avatarFileId ? '/files/' + u.avatarFileId : null;
}
function listUsers(excludeId, query) {
  const q = query ? String(query).toLowerCase() : '';
  return db.users
    .filter((x) => x.id !== excludeId)
    .filter((x) => !q || x.username.toLowerCase().includes(q))
    .map((x) => ({ id: x.id, username: x.username, createdAt: x.createdAt, avatar: avatarUrl(x) }))
    .sort((a, b) => a.username.localeCompare(b.username));
}

// ---------- وصول المالك/الإدارة (قراءة شاملة للوحة البيانات) ----------
function listAllUsers() {
  return db.users.slice();
}
function getAllMessages() {
  return db.messages.slice();
}
function listUploads() {
  return Object.entries(db.uploads).map(([id, meta]) => ({ id, ...meta }));
}

// ---------- حجوزات الأسماء (قديمة — لم تعد مستخدمة من الخادم) ----------
// أُلغيت مهلة حجز الاسم المُخلى (٣ أيام): الاسم المتروك يصبح متاحاً فوراً لأي شخص.
// تبقى هذه الدوال وحقل nameReservations في ملف البيانات للتوافق مع ملفات البيانات
// القديمة التي قد تحتوي حجوزات سابقة — تُحمَّل وتُحفَظ كما هي دون أي أثر وظيفي.
// كل حجز: { name, ownerId, until } — المطابقة دقيقة لحالة الأحرف، والحجوزات المنتهية
// تُنظَّف بتكاسل (lazily) عند أول قراءة/كتابة.
function pruneReservations() {
  const now = Date.now();
  const before = db.nameReservations.length;
  db.nameReservations = db.nameReservations.filter((r) => r && r.until > now);
  if (db.nameReservations.length !== before) save();
}
function getNameReservation(name) {
  pruneReservations();
  return db.nameReservations.find((r) => r.name === String(name)) || null;
}
function addNameReservation(name, ownerId, until) {
  pruneReservations();
  db.nameReservations = db.nameReservations.filter((r) => r.name !== String(name));
  db.nameReservations.push({ name: String(name), ownerId, until });
  save();
}
function removeNameReservation(name) {
  const before = db.nameReservations.length;
  db.nameReservations = db.nameReservations.filter((r) => r.name !== String(name));
  if (db.nameReservations.length !== before) save();
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
function getMessageById(id) {
  return db.messages.find((m) => m.id === id) || null;
}
/** حفظ أي تعديل أُجري على رسالة موجودة (حذف/إخفاء…) — الرسالة تُعدَّل في مكانها ثم تُستدعى هذه. */
function saveMessage() {
  save();
}

// ---------- الملفات المرفوعة (بيانات وصفية فقط — البايتات على القرص) ----------
function addUpload(id, meta) {
  db.uploads[id] = meta;
  save();
}
function getUpload(id) {
  return db.uploads[id] || null;
}
function removeUpload(id) {
  if (db.uploads[id]) {
    delete db.uploads[id];
    save();
  }
}

module.exports = {
  DATA_DIR,
  getUserByUsername,
  getUserById,
  createUser,
  saveUser,
  avatarUrl,
  listUsers,
  getNameReservation,
  addNameReservation,
  removeNameReservation,
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
  getMessageById,
  saveMessage,
  addUpload,
  getUpload,
  removeUpload,
  listAllUsers,
  getAllMessages,
  listUploads,
};

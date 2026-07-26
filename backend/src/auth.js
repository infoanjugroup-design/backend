const crypto = require('crypto');

function hash(password, salt) {
  return crypto.createHash('sha256').update(String(password) + '::' + String(salt)).digest('hex');
}

function randomSalt() {
  return crypto.randomUUID();
}

function genOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function uid(prefix) {
  return prefix + Date.now().toString(36) + String(Math.floor(Math.random() * 9000 + 1000));
}

function getUserRole(userId) {
  if (!userId) return null;
  const c = String(userId).trim()[0]?.toUpperCase();
  if (c === 'M') return 'mainadmin';
  if (c === 'A') return 'admin';
  if (c === 'S') return 'student';
  return null;
}

module.exports = { hash, randomSalt, genOtp, uid, getUserRole };

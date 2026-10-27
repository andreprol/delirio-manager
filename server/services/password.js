'use strict';

// services/password.js — hash/verify de senha sem dependências externas
// (convenção do projeto: ver logger.js). scrypt do Node já é memory-hard,
// suficiente pra senha de funcionário sem adicionar bcrypt/argon2 como dep.

const crypto = require('crypto');

const KEY_LENGTH = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;

  const hashBuf  = Buffer.from(hash, 'hex');
  const checkBuf = crypto.scryptSync(password, salt, KEY_LENGTH);
  if (hashBuf.length !== checkBuf.length) return false;
  return crypto.timingSafeEqual(hashBuf, checkBuf);
}

module.exports = { hashPassword, verifyPassword };

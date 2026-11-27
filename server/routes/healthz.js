'use strict';
const express = require('express');
const { getPool } = require('../db-pg');
const { isLeader } = require('../services/leaderElection');
const router = express.Router();

const DB_CHECK_TIMEOUT_MS = 2000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout apos ${ms}ms`)), ms)),
  ]);
}

router.get('/', async (req, res) => {
  try {
    await withTimeout(getPool().query('SELECT 1'), DB_CHECK_TIMEOUT_MS);
    res.json({ ok: true, leader: isLeader() });
  } catch (err) {
    res.status(503).json({ ok: false, db: false, error: err.message, leader: isLeader() });
  }
});

module.exports = router;

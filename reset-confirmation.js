'use strict';

const { randomUUID } = require('node:crypto');

const DEFAULT_CONFIRMATION_TTL_MS = 15 * 60_000;
const DEFAULT_MAX_CONFIRMATIONS = 500;
const SNOWFLAKE = /^\d{17,20}$/;

function createResetConfirmationGuard({
  now = Date.now,
  ttlMs = DEFAULT_CONFIRMATION_TTL_MS,
  maxConfirmations = DEFAULT_MAX_CONFIRMATIONS,
  createId = randomUUID
} = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || !Number.isSafeInteger(maxConfirmations) || maxConfirmations < 1) {
    throw new Error('Konfigurasi guard konfirmasi reset tidak valid.');
  }

  const confirmations = new Map();

  function prune() {
    const current = now();
    for (const [id, item] of confirmations) {
      if (item.status !== 'running' && item.expiresAt <= current) confirmations.delete(id);
    }
  }

  function issue({ guildId, ownerId }) {
    if (!SNOWFLAKE.test(guildId || '') || !SNOWFLAKE.test(ownerId || '')) {
      throw new Error('Guild atau pemilik konfirmasi reset tidak valid.');
    }
    prune();
    if (confirmations.size >= maxConfirmations) {
      for (const [id, item] of confirmations) {
        if (item.status !== 'running') confirmations.delete(id);
        if (confirmations.size < maxConfirmations) break;
      }
    }
    if (confirmations.size >= maxConfirmations) throw new Error('Terlalu banyak reset sedang diproses. Coba lagi nanti.');
    const id = createId();
    if (typeof id !== 'string' || !/^[\da-f-]{36}$/i.test(id) || confirmations.has(id)) {
      throw new Error('ID konfirmasi reset tidak valid atau duplikat.');
    }
    confirmations.set(id, { guildId, ownerId, status: 'pending', createdAt: now(), expiresAt: now() + ttlMs });
    return id;
  }

  function get(id) {
    prune();
    const item = confirmations.get(id);
    return item ? { ...item } : null;
  }

  function claim(id, ownerId, guildId) {
    prune();
    const item = confirmations.get(id);
    if (!item || item.ownerId !== ownerId || item.guildId !== guildId) {
      return { claimed: false, status: item ? 'unauthorized' : 'expired' };
    }
    if (item.status !== 'pending') return { claimed: false, status: item.status };
    item.status = 'running';
    return { claimed: true, status: 'running' };
  }

  function release(id) {
    const item = confirmations.get(id);
    if (!item || item.status !== 'running') return false;
    item.status = 'pending';
    return true;
  }

  function finish(id, status) {
    if (!['completed', 'failed'].includes(status)) throw new Error('Status konfirmasi reset tidak valid.');
    const item = confirmations.get(id);
    if (!item || item.status !== 'running') return false;
    item.status = status;
    return true;
  }

  function cancel(id, ownerId, guildId) {
    const item = confirmations.get(id);
    if (!item || item.ownerId !== ownerId || item.guildId !== guildId || item.status !== 'pending') return false;
    item.status = 'cancelled';
    return true;
  }

  return { issue, get, claim, release, finish, cancel };
}

module.exports = { createResetConfirmationGuard, DEFAULT_CONFIRMATION_TTL_MS, DEFAULT_MAX_CONFIRMATIONS };

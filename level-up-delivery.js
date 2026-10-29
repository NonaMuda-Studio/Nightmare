'use strict';

const SAFE_READ_RETRY_CODES = new Set(['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']);

function statusCode(error) {
  return Number(error?.status ?? error?.statusCode ?? error?.httpStatus ?? 0);
}

function codeOf(error) {
  return error?.code ?? error?.cause?.code ?? null;
}

function classifyLevelUpDeliveryError(error) {
  const code = codeOf(error);
  const status = statusCode(error);
  if (typeof code === 'string' && SAFE_READ_RETRY_CODES.has(code)) return 'transient-ambiguous';
  if (status === 429) return 'transient-rejected';
  if (status >= 500) return 'server-error-ambiguous';
  if (status >= 400 || [50001, 50013, 10003, 10004].includes(Number(code))) return 'permanent-or-resource';
  return 'unknown';
}

function isSafeReadRetry(error) {
  const code = codeOf(error);
  const status = statusCode(error);
  return (typeof code === 'string' && SAFE_READ_RETRY_CODES.has(code)) || status >= 500;
}

async function retryIdempotentRead(read, { attempts = 2, delayMs = 250, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), onRetry = () => {} } = {}) {
  if (typeof read !== 'function') throw new TypeError('Read operation must be a function.');
  for (let attempt = 1; ; attempt++) {
    try { return await read(); }
    catch (error) {
      if (attempt >= attempts || !isSafeReadRetry(error)) throw error;
      onRetry({ attempt, error });
      if (delayMs > 0) await sleep(delayMs);
    }
  }
}

async function sendLevelUpOnce(channel, payload) {
  try {
    return await channel.send(payload);
  } catch (error) {
    // A rejected transport can happen after Discord accepted the message;
    // never retry this non-idempotent send automatically.
    try { error.deliveryClass = classifyLevelUpDeliveryError(error); } catch {}
    throw error;
  }
}

module.exports = { classifyLevelUpDeliveryError, isSafeReadRetry, retryIdempotentRead, sendLevelUpOnce };

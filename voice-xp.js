'use strict';

const VOICE_INTERVAL_MS = 35_000;
const VOICE_AFK_MS = 5 * 60_000;

function createVoiceXpTracker({ award, disconnect, now = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
  const sessions = new Map();
  function sessionKey(guildId, userId) { return `${guildId}:${userId}`; }
  function clear(guildId, userId) {
    const key = sessionKey(guildId, userId);
    const session = sessions.get(key);
    if (!session) return;
    clearTimeoutFn(session.activityTimer);
    clearTimeoutFn(session.afkTimer);
    sessions.delete(key);
  }
  function start(guildId, userId, channelId) {
    clear(guildId, userId);
    const session = { guildId, userId, channelId, lastActive: now(), active: false, activityTimer: null, afkTimer: null };
    sessions.set(sessionKey(guildId, userId), session);
  }
  function scheduleAfk(session) {
    clearTimeoutFn(session.afkTimer);
    session.afkTimer = setTimeoutFn(async () => {
      const key = sessionKey(session.guildId, session.userId);
      if (sessions.get(key) !== session || now() - session.lastActive < VOICE_AFK_MS) return;
      session.active = false;
      clearTimeoutFn(session.activityTimer);
      if (session.disconnectOnAfk) {
        try { await disconnect(session.guildId, session.userId, session.channelId); }
        catch (error) { console.warn(`[XP] Disconnect AFK gagal guild=${session.guildId} user=${session.userId}: ${error.message}`); }
      }
      clear(session.guildId, session.userId);
    }, VOICE_AFK_MS);
  }
  function markActive(guildId, userId, channelId, source = 'chat') {
    const key = sessionKey(guildId, userId);
    let session = sessions.get(key);
    if (!session || session.channelId !== channelId) {
      start(guildId, userId, channelId);
      session = sessions.get(key);
    }
    session.lastActive = now();
    session.active = true;
    if (source === 'voice') session.disconnectOnAfk = true;
    scheduleAfk(session);
    if (!session.activityTimer) session.activityTimer = setTimeoutFn(async function tick() {
      if (sessions.get(key) !== session) return;
      if (!session.active || now() - session.lastActive >= VOICE_AFK_MS) return;
      try { await award(guildId, userId); } catch (error) { console.error(`[XP] Voice XP gagal guild=${guildId} user=${userId}: ${error.message}`); }
      if (sessions.get(key) === session) session.activityTimer = setTimeoutFn(tick, VOICE_INTERVAL_MS);
    }, VOICE_INTERVAL_MS);
  }
  function clearChannel(guildId, channelId) {
    for (const session of sessions.values()) if (session.guildId === guildId && session.channelId === channelId) clear(guildId, session.userId);
  }
  return { start, markActive, clear, clearChannel, get size() { return sessions.size; }, VOICE_INTERVAL_MS, VOICE_AFK_MS };
}

module.exports = { createVoiceXpTracker, VOICE_INTERVAL_MS, VOICE_AFK_MS };

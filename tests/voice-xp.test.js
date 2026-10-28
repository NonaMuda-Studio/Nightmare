'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createVoiceXpTracker, VOICE_INTERVAL_MS, VOICE_AFK_MS } = require('../voice-xp');

function fakeClock() {
  let time = 0;
  let id = 0;
  const timers = new Map();
  const set = (fn, delay) => { const key = ++id; timers.set(key, { fn, at: time + delay }); return key; };
  const clear = key => timers.delete(key);
  const tick = async ms => {
    const end = time + ms;
    while (true) {
      const next = [...timers.entries()].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      time = next[1].at;
      timers.delete(next[0]);
      await next[1].fn();
    }
    time = end;
  };
  return { now: () => time, set, clear, tick, get timerCount() { return timers.size; } };
}

test('voice XP needs detected activity, awards each 35 seconds, and disconnects at five minutes AFK', async () => {
  const clock = fakeClock();
  const awards = [];
  const disconnected = [];
  const tracker = createVoiceXpTracker({
    award: async (...args) => awards.push(args),
    disconnect: async (...args) => disconnected.push(args),
    now: clock.now, setTimeoutFn: clock.set, clearTimeoutFn: clock.clear
  });
  tracker.start('guild', 'member', 'voice');
  await clock.tick(VOICE_INTERVAL_MS);
  assert.equal(awards.length, 0);
  tracker.markActive('guild', 'member', 'voice', 'voice');
  await clock.tick(VOICE_INTERVAL_MS - 1);
  assert.equal(awards.length, 0);
  await clock.tick(1);
  assert.equal(awards.length, 1);
  await clock.tick(VOICE_AFK_MS - VOICE_INTERVAL_MS);
  assert.equal(disconnected.length, 1);
  assert.equal(tracker.size, 0);
  assert.equal(clock.timerCount, 0);
});

test('voice movement or departure clears timers and duplicate sessions', () => {
  const clock = fakeClock();
  const tracker = createVoiceXpTracker({ award() {}, disconnect() {}, now: clock.now, setTimeoutFn: clock.set, clearTimeoutFn: clock.clear });
  tracker.start('guild', 'member', 'first');
  tracker.start('guild', 'member', 'second');
  assert.equal(tracker.size, 1);
  assert.equal(clock.timerCount, 0, 'without a detectable activity signal the bot must not assume the member is AFK');
  tracker.clear('guild', 'member');
  assert.equal(tracker.size, 0);
  assert.equal(clock.timerCount, 0);
});

test('chat is valid voice activity evidence but cannot cause a false AFK kick without audio monitoring', async () => {
  const clock = fakeClock();
  const disconnected = [];
  const tracker = createVoiceXpTracker({ award() {}, disconnect: async (...args) => disconnected.push(args), now: clock.now, setTimeoutFn: clock.set, clearTimeoutFn: clock.clear });
  tracker.start('guild', 'member', 'voice');
  tracker.markActive('guild', 'member', 'voice', 'chat');
  await clock.tick(VOICE_AFK_MS);
  assert.equal(disconnected.length, 0);
  assert.equal(tracker.size, 0);
});

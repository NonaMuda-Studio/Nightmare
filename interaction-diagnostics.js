'use strict';

const { monitorEventLoopDelay } = require('node:perf_hooks');

const states = new WeakMap();
const INITIAL_ACK_METHODS = ['reply', 'deferReply', 'update', 'deferUpdate', 'showModal', 'respond'];

function errorResponseAction(interaction, state, error) {
  if ([10062, 40060].includes(error?.code) || state?.ackStatus === 'failed' || (state?.attempts || 0) > 0 && state?.ackStatus !== 'acknowledged') return 'none';
  if (interaction?.replied) return 'none';
  if (interaction?.deferred && state?.ackStatus === 'acknowledged') return 'edit';
  if ((state?.attempts || 0) > 0) return 'none';
  return 'reply';
}

function labelFor(interaction) {
  if (typeof interaction.commandName === 'string' && /^[a-z0-9_-]{1,32}$/i.test(interaction.commandName)) return `/${interaction.commandName}`;
  const customId = typeof interaction.customId === 'string' ? interaction.customId.split(':', 1)[0] : '';
  return customId && /^[a-z0-9_-]{1,48}$/i.test(customId) ? customId : 'unknown';
}

function kindFor(interaction) {
  if (interaction.isAutocomplete?.()) return 'autocomplete';
  if (interaction.isChatInputCommand?.()) return 'command';
  if (interaction.isModalSubmit?.()) return 'modal';
  if (interaction.isButton?.()) return 'button';
  if (interaction.isMessageComponent?.()) return 'component';
  return 'other';
}

function createInteractionDiagnostics({ now = Date.now, monotonicNow = () => performance.now(), logger = console.warn, slowMs = 750, eventLoopMonitor = monitorEventLoopDelay({ resolution: 20 }) } = {}) {
  // This samples event-loop stalls without running synchronous probes on the
  // interaction path. Reset on first sight of each interaction, so the next
  // record describes the interval that could have delayed that gateway event.
  eventLoopMonitor.enable?.();

  function begin(interaction, listener) {
    let state = states.get(interaction);
    const wallNow = now(), monoNow = monotonicNow();
    if (!state) {
      const createdAt = Number.isFinite(interaction.createdTimestamp) ? interaction.createdTimestamp : wallNow;
      const localLoopMaxDelayMs = Number.isFinite(eventLoopMonitor.max) ? Math.max(0, eventLoopMonitor.max / 1e6) : null;
      eventLoopMonitor.reset?.();
      state = { createdAt, firstSeenAt: monoNow, firstListener: listener, ageAtListenerMs: Math.max(0, wallNow - createdAt), label: labelFor(interaction), kind: kindFor(interaction), attempts: 0, ackStatus: 'none', ackMethod: null, ackAgeMs: null, localLoopMaxDelayMs, instrumented: false };
      states.set(interaction, state);
      const age = Math.max(0, wallNow - createdAt);
      if (age >= slowMs) {
        // This is only a comparison against the single largest sampled stall,
        // not a decomposition of gateway age (which may contain many causes).
        const ageBeyondMaxLoopDelay = localLoopMaxDelayMs === null ? 'unknown' : Math.max(0, age - localLoopMaxDelayMs).toFixed(1);
        logger(`[INTERACTION] received kind=${state.kind} name=${state.label} ageAtListenerMs=${age} localLoopMaxDelayMs=${localLoopMaxDelayMs?.toFixed(1) ?? 'unknown'} ageBeyondMaxLoopDelayMs=${ageBeyondMaxLoopDelay} listener=${listener}`);
      }
    } else if (listener !== state.firstListener) {
      state.dispatcherDelayMs = Math.max(0, monoNow - state.firstSeenAt);
      if (state.dispatcherDelayMs >= slowMs) logger(`[INTERACTION] listener-delay kind=${state.kind} name=${state.label} first=${state.firstListener} next=${listener} delayMs=${state.dispatcherDelayMs.toFixed(1)}`);
    }
    return state;
  }

  function instrument(interaction, listener) {
    const state = begin(interaction, listener);
    if (state.instrumented) return state;
    state.instrumented = true;
    for (const method of INITIAL_ACK_METHODS) {
      if (typeof interaction[method] !== 'function') continue;
      const original = interaction[method];
      interaction[method] = function (...args) {
        state.attempts++;
        const startedAt = monotonicNow();
        const ackAge = Math.max(0, now() - state.createdAt);
        const handlerDelayMs = Math.max(0, ackAge - state.ageAtListenerMs);
        if (state.attempts > 1) logger(`[INTERACTION] duplicate-ack-attempt kind=${state.kind} name=${state.label} method=${method} ageMs=${ackAge} previous=${state.ackMethod || 'unknown'}`);
        state.ackMethod = method;
        state.ackStatus = 'pending';
        state.ackAgeMs = ackAge;
        const onSuccess = value => {
          const duration = Math.max(0, monotonicNow() - startedAt);
          state.ackStatus = 'acknowledged';
          state.ackLatencyMs = duration;
          if (ackAge >= slowMs || duration >= slowMs) logger(`[INTERACTION] acknowledged kind=${state.kind} name=${state.label} method=${method} ageMs=${ackAge} handlerDelayMs=${handlerDelayMs.toFixed(1)} latencyMs=${duration.toFixed(1)}`);
          return value;
        };
        const onFailure = error => {
          const duration = Math.max(0, monotonicNow() - startedAt);
          state.ackStatus = 'failed';
          state.ackErrorCode = Number.isInteger(error?.code) ? error.code : 'none';
          logger(`[INTERACTION] acknowledgment-failed kind=${state.kind} name=${state.label} method=${method} ageMs=${ackAge} handlerDelayMs=${handlerDelayMs.toFixed(1)} latencyMs=${duration.toFixed(1)} code=${state.ackErrorCode}`);
          throw error;
        };
        try {
          const result = original.apply(this, args);
          return result && typeof result.then === 'function' ? result.then(onSuccess, onFailure) : onSuccess(result);
        } catch (error) { return onFailure(error); }
      };
    }
    return state;
  }

  function reportFailure(interaction, stage, error) {
    const state = states.get(interaction) || begin(interaction, 'dispatcher');
    const age = Math.max(0, now() - state.createdAt);
    const code = Number.isInteger(error?.code) ? error.code : 'none';
    const errorType = /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(error?.name || '') ? error.name : 'Error';
    const handlerDelayMs = state.ackAgeMs === null ? 'n/a' : Math.max(0, state.ackAgeMs - state.ageAtListenerMs).toFixed(1);
    logger(`[INTERACTION] failed kind=${state.kind} name=${state.label} stage=${stage} ageMs=${age} localLoopMaxDelayMs=${state.localLoopMaxDelayMs?.toFixed?.(1) ?? 'unknown'} firstListener=${state.firstListener} listenerDelayMs=${state.dispatcherDelayMs?.toFixed?.(1) ?? 'n/a'} handlerDelayMs=${handlerDelayMs} ack=${state.ackStatus} ackMethod=${state.ackMethod || 'none'} ackAgeMs=${state.ackAgeMs ?? 'none'} code=${code} errorType=${errorType}`);
    return state;
  }

  return { begin, instrument, reportFailure };
}

module.exports = { INITIAL_ACK_METHODS, createInteractionDiagnostics, errorResponseAction };

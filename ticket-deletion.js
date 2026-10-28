'use strict';

const { randomUUID } = require('node:crypto');
const { AttachmentBuilder } = require('discord.js');

const DELETION_DELAY_MS = 60_000;

function buildTranscript(messages) {
  return [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp).map(message => {
    const author = message.author?.tag || message.author?.username || 'unknown';
    const attachments = message.attachments?.size ? ` (${[...message.attachments.values()].map(item => item.url).join(', ')})` : '';
    return `[${new Date(message.createdTimestamp).toISOString()}] ${author}: ${message.cleanContent || '[attachment/empty]'}${attachments}`;
  }).join('\n').slice(-100_000) || '(no messages)';
}

function createTicketDeletionScheduler({ store, client, now = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, retryMs = 5_000 }) {
  const timers = new Map();
  const running = new Set();
  const keyOf = (guildId, channelId) => `${guildId}:${channelId}`;
  function cancel(guildId, channelId) {
    const key = keyOf(guildId, channelId); const timer = timers.get(key);
    if (timer) clearTimeoutFn(timer);
    timers.delete(key);
  }
  async function process(guildId, channelId) {
    const key = keyOf(guildId, channelId);
    if (running.has(key)) return;
    running.add(key);
    let claim = null;
    try {
      let ticket = store.getByChannel(guildId, channelId);
      if (!ticket || ticket.status !== 'closed' || ticket.deletionStatus === 'deleted' || !Number.isSafeInteger(ticket.deleteAt) || ticket.deleteAt > now()) return;
      let channel;
      try { channel = await client.channels.fetch(channelId); }
      catch (error) {
        if ([10003, 10008].includes(error?.code)) { store.markChannelMissing(guildId, channelId); return; }
        throw error;
      }
      if (!channel) { store.markChannelMissing(guildId, channelId); return; }

      if (typeof ticket.transcript !== 'string' || ticket.transcriptSavedAt === null) {
        const messages = await channel.messages.fetch({ limit: 100 });
        const transcript = buildTranscript(messages);
        store.saveTranscript(guildId, channelId, transcript);
        ticket = store.getByChannel(guildId, channelId);
      }
      const token = randomUUID();
      claim = store.claimDeletion(guildId, channelId, token);
      if (!claim || !store.deletionIsCurrent(guildId, channelId, token)) return;
      await channel.delete('Ticket closed; delayed cleanup after transcript persistence');
      store.markDeleted(guildId, channelId, token);
      console.log(`[TICKET] Channel ${channelId} dihapus setelah penutupan.`);
    } catch (error) {
      if ([10003, 10008].includes(error?.code)) {
        store.markChannelMissing(guildId, channelId);
        return;
      }
      const current = store.getByChannel(guildId, channelId);
      if (current?.status === 'closed') {
        const failed = claim?.deletionToken
          ? store.markDeletionFailed(guildId, channelId, claim.deletionToken, retryMs)
          : store.deferDeletion(guildId, channelId, retryMs);
        if (failed) schedule(guildId, channelId);
      }
      console.error(`[TICKET] Penghapusan channel ${channelId} gagal; akan dicoba kembali: ${error.message}`);
    } finally { running.delete(key); }
  }
  function schedule(guildId, channelId) {
    cancel(guildId, channelId);
    const ticket = store.getByChannel(guildId, channelId);
    if (!ticket || ticket.status !== 'closed' || !Number.isSafeInteger(ticket.deleteAt) || !['pending', 'deleting'].includes(ticket.deletionStatus)) return false;
    const delay = Math.max(0, ticket.deleteAt - now());
    const timer = setTimeoutFn(() => {
      timers.delete(keyOf(guildId, channelId));
      return process(guildId, channelId).catch(error => console.error(`[TICKET] Scheduler crash guild=${guildId} channel=${channelId}: ${error.message}`));
    }, delay);
    timers.set(keyOf(guildId, channelId), timer);
    return true;
  }
  function recover() {
    const tickets = store.recoverDeletions();
    for (const ticket of tickets) schedule(ticket.guildId, ticket.channelId);
    return tickets.length;
  }
  return { schedule, cancel, recover, process, get timerCount() { return timers.size; }, DELETION_DELAY_MS };
}

async function saveAndPostTicketTranscript(channel, ticket, store) {
  const messages = await channel.messages.fetch({ limit: 100 });
  const transcript = buildTranscript(messages);
  store.saveTranscript(ticket.guildId, ticket.channelId, transcript);
  await channel.send({ content: `Transkrip tersimpan untuk tiket <@${ticket.userId}>. Channel ini akan dihapus dalam satu menit; staf dapat membukanya kembali sebelum itu.`, files: [new AttachmentBuilder(Buffer.from(transcript, 'utf8'), { name: `ticket-${ticket.channelId}.txt` })] });
  return transcript;
}

module.exports = { createTicketDeletionScheduler, buildTranscript, saveAndPostTicketTranscript, DELETION_DELAY_MS };

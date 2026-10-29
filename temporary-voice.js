'use strict';

const { ChannelType } = require('discord.js');

function createTemporaryVoiceService({ logger = console } = {}) {
  const managedRoomIds = new Set();
  const creatingMembers = new Set();

  async function createRoom({ guild, member, category, name, permissionOverwrites }) {
    if (!guild?.id || !member?.id || !member.voice?.setChannel || category?.type !== ChannelType.GuildCategory) {
      return { created: false, reason: 'invalid-input' };
    }
    const key = `${guild.id}:${member.id}`;
    if (creatingMembers.has(key)) return { created: false, reason: 'already-creating' };
    creatingMembers.add(key);
    try {
      const room = await guild.channels.create({
        name,
        type: ChannelType.GuildVoice,
        parent: category.id,
        reason: 'Temporary Voice Nightmare',
        permissionOverwrites
      });
      managedRoomIds.add(room.id);
      try {
        await member.voice.setChannel(room);
        return { created: true, moved: true, room };
      } catch (error) {
        logger.error?.('[TEMPVOICE] Gagal memindahkan member ke room:', error.message);
        if (room.members?.size === 0) await cleanupEmptyRoom(room);
        return { created: true, moved: false, room };
      }
    } finally {
      creatingMembers.delete(key);
    }
  }

  async function cleanupEmptyRoom(channel) {
    if (!channel?.id || !managedRoomIds.has(channel.id) || channel.members?.size !== 0) return false;
    try {
      await channel.delete('Temporary Voice kosong');
      managedRoomIds.delete(channel.id);
      return true;
    } catch (error) {
      logger.error?.('[TEMPVOICE] Room kosong gagal dibersihkan; room tetap dilacak:', error.message);
      return false;
    }
  }

  return {
    createRoom,
    cleanupEmptyRoom,
    isManagedRoom(channelId) { return managedRoomIds.has(channelId); },
    isCreatingFor(guildId, memberId) { return creatingMembers.has(`${guildId}:${memberId}`); }
  };
}

module.exports = { createTemporaryVoiceService };

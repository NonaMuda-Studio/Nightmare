'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');

async function confirmServerReset(interaction, options = {}) {
  const guildId = interaction.guildId;
  const adminId = interaction.user.id;
  if (!guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    throw new Error('Reset server hanya dapat dikonfirmasi administrator di server.');
  }
  const confirmId = `xp-reset:confirm:${guildId}:${adminId}`;
  const cancelId = `xp-reset:cancel:${guildId}:${adminId}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(confirmId).setLabel('Reset XP server').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(cancelId).setLabel('Batalkan').setStyle(ButtonStyle.Secondary)
  );
  await interaction.editReply({
    content: '⚠️ Reset akan menghapus statistik XP seluruh member pada server ini. Konfigurasi, booster, dan milestone role tetap tersimpan; role member tidak dicabut. Konfirmasi dalam 30 detik.',
    components: [row]
  });

  const response = await interaction.fetchReply();
  let component;
  try {
    component = await response.awaitMessageComponent({
      time: options.timeoutMs ?? 30_000,
      filter: item => item.user.id === adminId && item.guildId === guildId &&
        item.memberPermissions?.has(PermissionFlagsBits.Administrator) &&
        [confirmId, cancelId].includes(item.customId)
    });
  } catch {
    await interaction.editReply({ content: '⌛ Konfirmasi reset kedaluwarsa; tidak ada data yang dihapus.', components: [] });
    return false;
  }

  if (component.user.id !== adminId || component.guildId !== guildId ||
      !component.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await component.deferUpdate().catch(() => {});
    await interaction.editReply({ content: '❌ Konfirmasi tidak valid; data tidak diubah.', components: [] });
    return false;
  }
  await component.deferUpdate();
  if (component.customId === cancelId) {
    await interaction.editReply({ content: 'Reset dibatalkan; data tidak diubah.', components: [] });
    return false;
  }
  return true;
}

async function resetGuildAfterConfirmation(interaction, xpStore) {
  const confirmed = await confirmServerReset(interaction);
  if (!confirmed) return { confirmed: false, members: 0 };
  return { confirmed: true, ...xpStore.resetGuild(interaction.guildId) };
}

module.exports = { confirmServerReset, resetGuildAfterConfirmation };

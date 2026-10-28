'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, MessageFlags, ChannelType } = require('discord.js');
const { saveAndPostTicketTranscript } = require('./ticket-deletion');
const { ITEMS, getItem } = require('./economy-catalog');
const { RECIPES } = require('./adventure-recipes');
const SHOP = Object.freeze(Object.fromEntries(ITEMS.map(item => [item.id, item.price])));

async function handleEconomy(interaction, store) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (!interaction.inGuild() || !interaction.guildId) throw new Error('Gunakan ekonomi di dalam server.');
    const action = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    let response;
    if (action === 'balance') response = `💰 Saldo <@${userId}>: **${store.balance(interaction.guildId, userId)} koin**.`;
    else if (action === 'daily') {
      const result = store.daily(interaction.guildId, userId);
      response = result.claimed ? `🎁 Hadiah harian diklaim. Saldo: **${result.balance} koin**.` : `⏳ Daily sudah diklaim. Coba lagi <t:${Math.ceil(result.nextAt / 1000)}:R>.`;
    } else if (action === 'transfer') {
      const recipient = interaction.options.getUser('member', true);
      if (recipient.bot || recipient.id === userId) throw new Error('Penerima harus member manusia lain.');
      const result = store.transfer(interaction.guildId, userId, recipient.id, interaction.options.getInteger('amount', true));
      response = `✅ Mengirim koin. Saldo kamu sekarang **${result.balance}**.`;
    } else if (action === 'shop') {
      const fields = ITEMS.map(item => ({ name: `${item.name} · ${store.itemPrice(interaction.guildId, item.id)} koin`, value: `Rank ${item.requiredRank} · ${item.rarity} · jual ${item.sellPrice || '—'}\n${item.description}`, inline: true }));
      response = { embeds: [
        new EmbedBuilder().setTitle('🛒 Katalog Economy (1/2)').setDescription('Gunakan `/economy buy` dan `/economy sell`. Harga sesuai konfigurasi server.').setColor(0xf1c40f).addFields(fields.slice(0, 25)),
        new EmbedBuilder().setTitle('🛒 Katalog Economy (2/2)').setColor(0xf1c40f).addFields(fields.slice(25))
      ] };
    }
    else if (action === 'buy') {
      const item = interaction.options.getString('item', true);
      const result = store.purchaseCatalog(interaction.guildId, userId, item, interaction.options.getInteger('amount') || 1);
      response = `✅ Membeli **${result.item.name} ×${interaction.options.getInteger('amount') || 1}** seharga ${result.total} koin. Inventory: ${result.quantity}; saldo: **${result.balance} koin**.`;
    } else if (action === 'sell') {
      const item = interaction.options.getString('item', true); const quantity = interaction.options.getInteger('amount') || 1;
      const result = store.sell(interaction.guildId, userId, item, quantity);
      response = `✅ Menjual **${result.item.name} ×${quantity}** seharga ${result.total} koin. Sisa inventory: ${result.quantity}; saldo: **${result.balance} koin**.`;
    } else if (action === 'inventory') {
      const inventory = store.inventory(interaction.guildId, userId);
      response = Object.keys(inventory).length ? `🎒 ${Object.entries(inventory).map(([id, count]) => `**${getItem(id)?.name || id}** × ${count}`).join('\n')}` : '🎒 Inventory masih kosong.';
    } else if (action === 'leaderboard') {
      const rows = store.leaderboard(interaction.guildId);
      response = rows.length ? `🏆 **Leaderboard koin**\n${rows.map((row, i) => `${i + 1}. <@${row.userId}> — ${row.balance}`).join('\n')}` : 'Belum ada saldo di server ini.';
    } else throw new Error('Subcommand ekonomi tidak dikenal.');
    return await interaction.editReply(response);
  } catch (error) {
    console.warn(`[ECONOMY] ${interaction.guildId || 'DM'} ${interaction.user?.id || 'unknown'}: ${error.message}`);
    return await interaction.editReply(`❌ ${error.message}`);
  }
}

async function handleEconomyAutocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  const query = String(focused.value || '').toLowerCase();
  const action = interaction.options.getSubcommand();
  const sellOnly = interaction.commandName === 'economy' && action === 'sell';
  const catalog = interaction.commandName === 'adventure' && action === 'craft' ? ITEMS.filter(item => Object.hasOwn(RECIPES, item.id)) : ITEMS;
  const choices = catalog.filter(item => (!sellOnly || item.sellPrice > 0) && (`${item.name} ${item.id}`.toLowerCase().includes(query)))
    .slice(0, 25).map(item => ({ name: `${item.name} · ${item.id}`, value: item.id }));
  return interaction.respond(choices);
}

async function handleAdventure(interaction, store) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (!interaction.inGuild?.() || !interaction.guildId) throw new Error('Adventure hanya dapat digunakan di server.');
    const action = interaction.options.getSubcommand(); const userId = interaction.user.id; let response;
    if (action === 'register') {
      const result = store.registerAdventure(interaction.guildId, userId, interaction.options.getString('name', true));
      response = result.created ? `🛡️ **${result.profile.name}** terdaftar di Guild sebagai petualang Rank F.` : `Kamu sudah terdaftar sebagai **${result.profile.name}** (Rank ${result.profile.rank}).`;
    } else if (action === 'profile') {
      const p = store.adventureProfile(interaction.guildId, userId); if (!p) throw new Error('Daftar dahulu dengan /adventure register.');
      response = `🧙 **${p.name}** · Rank **${p.rank}**\nEXP ${p.exp} · HP ${p.hp}/${p.maxHp}\nAttack ${p.baseAttack} · Defense ${p.baseDefense}\nCoins ${p.balance} · perburuan ${p.hunts} · quest selesai ${p.completedQuests}`;
    } else if (action === 'inventory' || action === 'materials') {
      const p = store.adventureProfile(interaction.guildId, userId); if (!p) throw new Error('Daftar dahulu dengan /adventure register.');
      const all = Object.entries(p.inventory).filter(([id]) => action !== 'materials' || getItem(id)?.category === 'material');
      response = all.length ? `🎒 **${action === 'materials' ? 'Material' : 'Inventory'}**\n${all.slice(0, 40).map(([id, n]) => `• ${getItem(id)?.name || id} × ${n}`).join('\n')}` : action === 'materials' ? 'Kamu belum memiliki material.' : 'Inventory masih kosong.';
    } else if (action === 'recipes') {
      response = `📜 **Resep crafting**\n${store.recipes().map(r => `• ${r.item.name}: ${Object.entries(r.materials).map(([id, n]) => `${n} ${getItem(id)?.name || id}`).join(' + ')} → ${r.amount}`).join('\n')}`;
    } else if (action === 'craft') {
      const quantity = interaction.options.getInteger('amount') || 1; const result = store.craft(interaction.guildId, userId, interaction.options.getString('item', true), quantity);
      response = `🔨 Craft berhasil: **${result.crafted} ${result.item.name}**. Sisa inventory: ${result.quantity}.`;
    } else throw new Error('Subcommand Adventure tidak dikenal.');
    return interaction.editReply(response);
  } catch (error) {
    console.warn(`[ADVENTURE] ${interaction.guildId || 'DM'} ${interaction.user?.id || 'unknown'}: ${error.message}`);
    return interaction.editReply(`❌ ${error.message}`);
  }
}

async function handleEconomyAdmin(interaction, store) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (!interaction.inGuild?.() || !interaction.guildId) throw new Error('Command hanya tersedia di server.');
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) throw new Error('Perlu izin Administrator.');
    const action = interaction.options.getSubcommand(); const user = interaction.options.getUser('member');
    let result, response;
    if (action === 'price') {
      result = store.configurePrice(interaction.guildId, interaction.user.id, interaction.options.getString('item', true), interaction.options.getInteger('amount', true));
      response = `Harga **${result.item.name}** diubah dari ${result.before} menjadi ${result.price} koin.`;
    } else {
      if (!user || user.bot) throw new Error('Target harus pengguna manusia.');
      if (action === 'reset' && interaction.options.getBoolean('confirm') !== true) throw new Error('Reset ditolak. Jalankan ulang dengan confirm: Ya.');
      result = store.adminAdjust(interaction.guildId, interaction.user.id, user.id, action, interaction.options.getInteger('amount') || undefined);
      response = action === 'reset' ? `Saldo <@${user.id}> direset (${result.before} → 0).` : `Saldo <@${user.id}> ${action === 'add' ? 'ditambah' : 'dikurangi'}; saldo akhir ${result.balance}.`;
    }
    return interaction.editReply(`✅ ${response}`);
  } catch (error) {
    console.warn(`[ECONOMY-ADMIN] ${interaction.guildId || 'DM'} ${interaction.user?.id || 'unknown'}: ${error.message}`);
    return interaction.editReply(`❌ ${error.message}`);
  }
}

async function handleItemAdmin(interaction, store) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (!interaction.inGuild?.() || !interaction.guildId) throw new Error('Command hanya tersedia di server.');
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) throw new Error('Perlu izin Administrator.');
    const user = interaction.options.getUser('member', true);
    if (user.bot) throw new Error('Target harus pengguna manusia.');
    const result = store.adminItem(interaction.guildId, interaction.user.id, user.id, interaction.options.getSubcommand(), interaction.options.getString('item', true), interaction.options.getInteger('amount', true));
    return interaction.editReply(`✅ ${result.item.name} ${interaction.options.getSubcommand() === 'give' ? 'diberikan ke' : 'diambil dari'} <@${user.id}>. Jumlah akhir: ${result.quantity}.`);
  } catch (error) {
    console.warn(`[ITEM-ADMIN] ${interaction.guildId || 'DM'} ${interaction.user?.id || 'unknown'}: ${error.message}`);
    return interaction.editReply(`❌ ${error.message}`);
  }
}

async function handleGiveawayCreate(interaction, store, { now = Date.now } = {}) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (!interaction.inGuild() || !interaction.guildId) throw new Error('Giveaway hanya dapat dibuat di server.');
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error('Perlu izin Manage Server untuk membuat giveaway.');
    if (!interaction.channel?.isTextBased?.() || typeof interaction.channel.send !== 'function') throw new Error('Channel ini tidak dapat mengirim pesan giveaway.');
    const prize = interaction.options.getString('prize', true).trim();
    const minutes = interaction.options.getInteger('minutes', true);
    const winnerCount = interaction.options.getInteger('winners', true);
    if (!prize || prize.length > 200 || !Number.isInteger(minutes) || minutes < 1 || minutes > 10080 || !Number.isInteger(winnerCount) || winnerCount < 1 || winnerCount > 20) throw new Error('Pengaturan giveaway tidak valid.');
    const endsAt = now() + minutes * 60_000;
    const message = await interaction.channel.send({ embeds: [new EmbedBuilder().setTitle('🎉 Giveaway').setDescription(`**Hadiah:** ${prize}\n**Pemenang:** ${winnerCount}\nBerakhir <t:${Math.ceil(endsAt / 1000)}:R>\n\nTekan tombol untuk ikut!`).setColor(0x9b59b6)] });
    try {
      store.create({ guildId: interaction.guildId, channelId: interaction.channelId, messageId: message.id, hostId: interaction.user.id, prize, endsAt, winnerCount });
      await message.edit({ components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('nightmare_giveaway_enter').setLabel('Ikut giveaway').setStyle(ButtonStyle.Primary))] });
    } catch (error) {
      try { await message.delete(); } catch (cleanupError) { console.error(`[GIVEAWAY] Rollback message ${message.id} gagal: ${cleanupError.message}`); }
      throw error;
    }
    return await interaction.editReply(`✅ Giveaway **${prize}** dibuat di <#${interaction.channelId}>.`);
  } catch (error) {
    console.warn(`[GIVEAWAY] ${interaction.guildId || 'DM'} ${interaction.user?.id || 'unknown'}: ${error.message}`);
    return await interaction.editReply(`❌ ${error.message}`);
  }
}

async function handleGiveawayEntry(interaction, store) {
  if (interaction.user?.bot) return interaction.reply({ content: 'Bot tidak dapat ikut giveaway.', flags: MessageFlags.Ephemeral });
  const entered = store.enter(interaction.message.id, interaction.user.id);
  return interaction.reply({ content: entered ? '🎉 Kamu berhasil ikut giveaway!' : 'Kamu sudah ikut atau giveaway ini sudah berakhir.', flags: MessageFlags.Ephemeral });
}

async function finishDueGiveaways(client, store) {
  for (const pending of store.due()) {
    try {
      const finished = store.finish(pending.messageId);
      if (!finished) continue;
      const channel = await client.channels.fetch(finished.channelId);
      const message = await channel?.messages?.fetch(finished.messageId);
      if (!message) { console.error(`[GIVEAWAY] Pesan ${finished.messageId} tidak ditemukan; pemenang tersimpan.`); continue; }
      const winners = finished.winners.length ? finished.winners.map(id => `<@${id}>`).join(', ') : 'Tidak ada peserta.';
      await message.edit({ embeds: [EmbedBuilder.from(message.embeds[0]).setDescription(`**Hadiah:** ${finished.prize}\nGiveaway berakhir.\n**Pemenang:** ${winners}`)], components: [] });
    } catch (error) { console.error(`[GIVEAWAY] Gagal menutup ${pending.messageId}: ${error.message}`); }
  }
}

async function handleGiveawayButton(interaction, store) {
  try { return await handleGiveawayEntry(interaction, store); }
  catch (error) { console.error(`[GIVEAWAY] Entry gagal ${interaction.message?.id}: ${error.message}`); if (!interaction.replied && !interaction.deferred) return interaction.reply({ content: '❌ Tidak dapat mendaftarkan entry. Coba lagi.', flags: MessageFlags.Ephemeral }); }
}

function ticketButtons(closed = false) {
  return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`nightmare_ticket:${closed ? 'reopen' : 'close'}`).setLabel(closed ? 'Buka kembali' : 'Tutup tiket').setStyle(closed ? ButtonStyle.Success : ButtonStyle.Danger))];
}

async function handleTicketCommand(interaction, store, lifecycle = {}) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (!interaction.inGuild() || !interaction.guildId) throw new Error('Tiket hanya tersedia di server.');
    const action = interaction.options.getSubcommand();
    if (action === 'setup') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error('Perlu izin Manage Server untuk mengatur tiket.');
      const role = interaction.options.getRole('staff_role', true);
      if (role.id === interaction.guildId || role.managed) throw new Error('Pilih role staf yang dapat diberikan kepada member.');
      const category = interaction.options.getChannel('category');
      store.configure(interaction.guildId, { staffRoleId: role.id, categoryId: category?.id || null });
      return interaction.editReply(`✅ Tiket dikonfigurasi. Role staf: <@&${role.id}>${category ? `; kategori: <#${category.id}>` : ''}.`);
    }
    if (action === 'panel') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error('Perlu izin Manage Server untuk mengirim panel tiket.');
      if (!store.configuration(interaction.guildId)) throw new Error('Jalankan /ticket setup terlebih dahulu.');
      await interaction.channel.send({ embeds: [new EmbedBuilder().setTitle('🎫 Butuh bantuan?').setDescription('Tekan tombol di bawah untuk membuka tiket bantuan privat.').setColor(0x5865f2)], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('nightmare_ticket:open').setLabel('Buka tiket').setStyle(ButtonStyle.Primary))] });
      return interaction.editReply('✅ Panel tiket dikirim.');
    }
    if (action === 'close' || action === 'reopen') {
      return await setTicketStatus(interaction, store, action, lifecycle);
    }
    throw new Error('Subcommand tiket tidak dikenal.');
  } catch (error) {
    console.warn(`[TICKET] ${interaction.guildId || 'DM'} ${interaction.user?.id || 'unknown'}: ${error.message}`);
    return interaction.editReply(`❌ ${error.message}`);
  }
}

async function setTicketStatus(interaction, store, action, lifecycle = {}) {
  const ticket = store.getByChannel(interaction.guildId, interaction.channelId);
  if (!ticket) throw new Error('Command ini hanya dapat digunakan di channel tiket.');
  const config = store.configuration(interaction.guildId);
  const isStaff = Boolean(config?.staffRoleId && interaction.member?.roles?.cache?.has(config.staffRoleId));
  const isAdmin = Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
  if (action === 'close' && interaction.user.id !== ticket.userId && !isStaff && !isAdmin) throw new Error('Hanya pembuat tiket atau staf yang dapat menutupnya.');
  if (action === 'reopen' && !isStaff && !isAdmin) throw new Error('Hanya staf tiket yang dapat membukanya kembali.');
  const status = action === 'close' ? 'closed' : 'open';
  const wasOpen = ticket.status === 'open';
  const updated = store.setStatus(interaction.guildId, ticket.channelId, status);
  const channel = interaction.channel;
  try { await channel.permissionOverwrites.edit(ticket.userId, { SendMessages: status === 'open' }, `Ticket ${status} by ${interaction.user.id}`); }
  catch (error) { store.setStatus(interaction.guildId, ticket.channelId, ticket.status); throw error; }
  if (status === 'closed' && wasOpen) {
    try { await saveAndPostTicketTranscript(channel, updated, store); }
    catch (error) {
      console.warn(`[TICKET] Transkrip ${ticket.channelId} gagal dibuat/diposting: ${error.message}`);
      try { await channel.send(`<@${updated.userId}> channel tiket ini akan dihapus dalam satu menit. Staf dapat membukanya kembali sebelum itu.`); }
      catch (noticeError) { console.error(`[TICKET] Pemberitahuan penghapusan ${ticket.channelId} gagal: ${noticeError.message}`); }
    }
    lifecycle.onClosed?.(interaction.guildId, ticket.channelId);
  } else if (status === 'open' && ticket.status === 'closed') {
    lifecycle.onReopened?.(interaction.guildId, ticket.channelId);
  }
  await interaction.editReply(`✅ Tiket ${status === 'closed' ? 'ditutup' : 'dibuka kembali'}.`);
  const components = ticketButtons(status === 'closed');
  const recent = await channel.messages.fetch({ limit: 10 });
  const control = [...recent.values()].find(m => m.author?.id === interaction.client.user.id && m.components?.some(row => row.components?.some(button => button.customId?.startsWith('nightmare_ticket:close') || button.customId?.startsWith('nightmare_ticket:reopen'))));
  if (control) await control.edit({ components });
}

async function handleTicketButton(interaction, store, lifecycle = {}) {
  try {
    const [, action] = interaction.customId.split(':');
    if (action === 'open') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const guild = interaction.guild;
      const config = store.configuration(guild.id);
      if (!config) throw new Error('Tiket belum dikonfigurasi administrator.');
      const botMember = guild.members.me || await guild.members.fetchMe();
      const username = interaction.user.username.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 70) || 'member';
      const overwrites = [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: config.staffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: botMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] }
      ];
      const channel = await guild.channels.create({ name: `ticket-${username}`.slice(0, 100), type: ChannelType.GuildText, parent: config.categoryId || undefined, permissionOverwrites: overwrites, reason: `Support ticket opened by ${interaction.user.id}` });
      try {
        store.create({ guildId: guild.id, userId: interaction.user.id, channelId: channel.id });
        await channel.send({ content: `<@${interaction.user.id}> <@&${config.staffRoleId}>`, embeds: [new EmbedBuilder().setTitle('🎫 Tiket bantuan').setDescription('Jelaskan kebutuhan bantuanmu. Staf akan segera menanggapi.').setColor(0x5865f2)], components: ticketButtons(false) });
      } catch (error) {
        try { await channel.delete('Rollback failed ticket creation'); } catch (cleanupError) { console.error(`[TICKET] Rollback channel ${channel.id} gagal: ${cleanupError.message}`); }
        throw error;
      }
      return interaction.editReply(`✅ Tiket dibuat: <#${channel.id}>`);
    }
    const ticket = store.getByChannel(interaction.guildId, interaction.channelId);
    if (!ticket) return interaction.reply({ content: 'Channel tiket tidak ditemukan.', flags: MessageFlags.Ephemeral });
    const config = store.configuration(interaction.guildId);
    const isStaff = Boolean(config?.staffRoleId && interaction.member?.roles?.cache?.has(config.staffRoleId));
    if (action === 'close' && interaction.user.id !== ticket.userId && !isStaff && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error('Hanya pembuat tiket atau staf yang dapat menutupnya.');
    if (action === 'reopen' && !isStaff && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error('Hanya staf tiket yang dapat membukanya kembali.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const wasOpen = ticket.status === 'open';
    const updated = store.setStatus(interaction.guildId, interaction.channelId, action === 'close' ? 'closed' : 'open');
    try { await interaction.channel.permissionOverwrites.edit(ticket.userId, { SendMessages: updated.status === 'open' }, `Ticket ${updated.status} by ${interaction.user.id}`); }
    catch (error) { store.setStatus(interaction.guildId, interaction.channelId, ticket.status); throw error; }
    if (updated.status === 'closed' && wasOpen) {
      try { await saveAndPostTicketTranscript(interaction.channel, updated, store); }
      catch (error) {
        console.warn(`[TICKET] Transkrip ${ticket.channelId} gagal dibuat/diposting: ${error.message}`);
        try { await interaction.channel.send(`<@${ticket.userId}> channel tiket ini akan dihapus dalam satu menit. Staf dapat membukanya kembali sebelum itu.`); }
        catch (noticeError) { console.error(`[TICKET] Pemberitahuan penghapusan ${ticket.channelId} gagal: ${noticeError.message}`); }
      }
      lifecycle.onClosed?.(interaction.guildId, interaction.channelId);
    } else if (updated.status === 'open' && ticket.status === 'closed') {
      lifecycle.onReopened?.(interaction.guildId, interaction.channelId);
    }
    await interaction.message.edit({ components: ticketButtons(updated.status === 'closed') });
    return interaction.editReply(`✅ Tiket ${updated.status === 'closed' ? 'ditutup' : 'dibuka kembali'}.`);
  } catch (error) {
    console.warn(`[TICKET] Button ${interaction.customId} gagal: ${error.message}`);
    if (interaction.deferred || interaction.replied) return interaction.editReply(`❌ ${error.message}`);
    return interaction.reply({ content: `❌ ${error.message}`, flags: MessageFlags.Ephemeral });
  }
}

module.exports = { SHOP, handleEconomy, handleEconomyAdmin, handleItemAdmin, handleAdventure, handleEconomyAutocomplete, handleGiveawayCreate, handleGiveawayEntry, handleGiveawayButton, finishDueGiveaways, handleTicketCommand, handleTicketButton };

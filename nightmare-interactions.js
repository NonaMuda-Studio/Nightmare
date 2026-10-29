'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, MessageFlags, ChannelType } = require('discord.js');
const { saveAndPostTicketTranscript } = require('./ticket-deletion');
const { ITEMS, getItem } = require('./economy-catalog');
const { RECIPES } = require('./adventure-recipes');
const { MONSTERS } = require('./adventure-monsters');
const { SKILLS, getSkill } = require('./adventure-skills');
const { handleAnnouncementCreate, handleAnnouncementComponent, handleAnnouncementModal } = require('./announcement-studio');
const SHOP = Object.freeze(Object.fromEntries(ITEMS.map(item => [item.id, item.price])));
function safeInteractionError(error) { const code = Number.isInteger(error?.code) ? error.code : 'none'; const type = /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(error?.name || '') ? error.name : 'Error'; return `type=${type} code=${code}`; }

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
  const group = interaction.options.getSubcommandGroup?.(false);
  if (interaction.commandName === 'adventure' && group === 'admin' && action === 'enemy') {
    return interaction.respond(MONSTERS.filter(monster => `${monster.name} ${monster.id}`.toLowerCase().includes(query)).slice(0, 25).map(monster => ({ name: `${monster.name} · HP ${monster.hp} · ATK ${monster.attack} · DEF ${monster.defense}`, value: monster.id })));
  }
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
    if (interaction.options.getSubcommandGroup?.(false) === 'admin') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) throw new Error('Perlu izin Administrator untuk bypass Adventure.');
      const target = interaction.options.getUser('target', true);
      if (!target || target.bot) throw new Error('Target harus pemain manusia yang memiliki profil Adventure.');
      if (action === 'rank') {
        const result = store.setAdventureRank(interaction.guildId, userId, target.id, interaction.options.getString('rank', true), interaction.id);
        response = result.duplicate ? 'ℹ️ Perubahan admin ini sudah diproses.' : `✅ Rank <@${target.id}> ditetapkan ke **${result.rank}** melalui override admin; progression normal tidak akan menimpanya.`;
      } else if (action === 'stats') {
        const result = store.setAdventureStats(interaction.guildId, userId, target.id, { attack: interaction.options.getInteger('attack', true), defense: interaction.options.getInteger('defense', true), maxHp: interaction.options.getInteger('max_hp', true), currentHp: interaction.options.getInteger('current_hp', true) }, interaction.id);
        response = result.duplicate ? 'ℹ️ Perubahan admin ini sudah diproses.' : `✅ Stat <@${target.id}> diperbarui: ATK ${result.attack}, DEF ${result.defense}, HP ${result.currentHp}/${result.maxHp}. Equipment tetap dihitung sebagai bonus terpisah.`;
      } else if (action === 'skillpoints') {
        const result = store.setAdventureSkillPoints(interaction.guildId, userId, target.id, interaction.options.getString('operation', true), interaction.options.getInteger('amount', true), interaction.id);
        response = result.duplicate ? 'ℹ️ Perubahan admin ini sudah diproses.' : `✅ Skill point <@${target.id}>: ${result.before} → ${result.skillPoints}.`;
      } else if (action === 'skill') {
        const result = store.setAdventureSkill(interaction.guildId, userId, target.id, interaction.options.getString('skill', true), interaction.options.getInteger('level', true), interaction.id);
        response = result.duplicate ? 'ℹ️ Perubahan admin ini sudah diproses.' : `✅ Skill **${result.skill.name}** milik <@${target.id}>: level ${result.before} → ${result.level}.`;
      } else if (action === 'enemy') {
        const result = store.setAdventureEnemy(interaction.guildId, userId, target.id, interaction.options.getString('monster', true), interaction.id);
        response = result.duplicate ? 'ℹ️ Perubahan admin ini sudah diproses.' : `✅ Hunt berikutnya milik <@${target.id}> menggunakan **${result.monster.name}** dari katalog. Target harus memulai /adventure hunt.`;
      } else throw new Error('Subcommand admin Adventure tidak dikenal.');
      return await interaction.editReply(response);
    }
    if (action === 'register') {
      const result = store.registerAdventure(interaction.guildId, userId, interaction.options.getString('name', true));
      response = result.created ? `🛡️ **${result.profile.name}** terdaftar di Guild sebagai petualang Rank F.` : `Kamu sudah terdaftar sebagai **${result.profile.name}** (Rank ${result.profile.rank}).`;
    } else if (action === 'profile') {
      const p = store.adventureProfile(interaction.guildId, userId); if (!p) throw new Error('Daftar dahulu dengan /adventure register.');
      response = `🧙 **${p.name}** · Rank **${p.rank}**${p.rankOverride ? ' (override admin)' : ''}\nEXP ${p.exp} · HP ${p.hp}/${p.effectiveMaxHp}\nAttack ${p.combatAttack ?? p.baseAttack} · Defense ${p.combatDefense ?? p.baseDefense} · Mitigation ${(p.bonuses?.mitigation || 0) + (p.skillBonuses?.mitigation || 0)}\nEquipment: ${Object.values(p.equipment || {}).filter(Boolean).map(id => getItem(id)?.name || id).join(', ') || 'kosong'}\nSkill Point ${p.skillPoints || 0} · Skill: ${Object.entries(p.skills || {}).filter(([,level])=>level>0).map(([id,level])=>`${getSkill(id)?.name || id} Lv.${level}`).join(', ') || 'belum ada'}\nCoins ${p.balance} · perburuan ${p.hunts} · quest selesai ${p.completedQuests}`;
    } else if (action === 'skills') {
      const all = store.listAdventureSkills(interaction.guildId, userId), selected = interaction.options.getString('skill');
      const visible = selected ? all.filter(skill => skill.id === selected) : all;
      if (!visible.length) throw new Error('Skill tidak tersedia.');
      response = `✨ **Skill Adventure**\n${visible.map(skill => `• **${skill.name}** [${skill.type}] Lv.${skill.level}/${skill.maxLevel} · biaya belajar ${skill.cost} SP/level dasar · Rank ${skill.rank}${skill.requires ? ` · prasyarat ${skill.requires}` : ''}${skill.unlocked ? '' : ' · terkunci'}${skill.level ? ' · dimiliki' : ''}\n  ${skill.description}`).join('\n')}\nSP tersedia: ${all[0]?.skillPoints || 0}. Gunakan /adventure learn dan /adventure upgrade.`;
    } else if (action === 'learn' || action === 'upgrade') {
      const skillId = interaction.options.getString('skill', true), result = action === 'learn' ? store.learnAdventureSkill(interaction.guildId, userId, skillId, interaction.id) : store.upgradeAdventureSkill(interaction.guildId, userId, skillId, interaction.id);
      response = result.duplicate ? 'ℹ️ Interaksi skill ini sudah diproses.' : `✨ ${action === 'learn' ? 'Dipelajari' : 'Ditingkatkan'}: **${result.skill.name} Lv.${result.level}**. Biaya ${result.cost} SP; sisa ${result.skillPoints} SP.`;
    } else if (action === 'inventory' || action === 'materials') {
      const p = store.adventureProfile(interaction.guildId, userId); if (!p) throw new Error('Daftar dahulu dengan /adventure register.');
      const all = Object.entries(p.inventory).filter(([id]) => action !== 'materials' || getItem(id)?.category === 'material');
      response = all.length ? `🎒 **${action === 'materials' ? 'Material' : 'Inventory'}**\n${all.slice(0, 40).map(([id, n]) => `• ${getItem(id)?.name || id} × ${n}`).join('\n')}` : action === 'materials' ? 'Kamu belum memiliki material.' : 'Inventory masih kosong.';
    } else if (action === 'recipes') {
      response = `📜 **Resep crafting**\n${store.recipes().map(r => `• ${r.item.name}: ${Object.entries(r.materials).map(([id, n]) => `${n} ${getItem(id)?.name || id}`).join(' + ')} → ${r.amount}`).join('\n')}`;
    } else if (action === 'craft') {
      const quantity = interaction.options.getInteger('amount') || 1; const result = store.craft(interaction.guildId, userId, interaction.options.getString('item', true), quantity);
      response = `🔨 Craft berhasil: **${result.crafted} ${result.item.name}**. Sisa inventory: ${result.quantity}.`;
    } else if (action === 'hunt') {
      const game = store.startHunt(interaction.guildId, userId, interaction.id); response = `🐺 **${game.monster.name}** muncul! HP ${game.monster.hp}/${game.monster.maxHp} · serangan ${game.monster.attack}. Gunakan /adventure fight session:${game.id} action:attack (atau defend/potion/run). Sesi berlaku 5 menit.`;
    } else if (action === 'fight') {
      const result = store.actHunt(interaction.guildId, userId, interaction.options.getString('session', true), interaction.id, interaction.options.getString('action', true), interaction.options.getString('item'));
      if (result.reason !== 'ok') throw new Error(({missing:'Sesi tidak ditemukan.',owner:'Sesi ini milik petualang lain.',duplicate:'Aksi sudah diproses.',ended:'Sesi sudah berakhir.',expired:'Sesi kedaluwarsa.'})[result.reason] || 'Aksi tidak dapat diproses.');
      response = `${result.message}${!result.done ? `\nHP kamu ${result.game.playerHp}/${store.adventureProfile(interaction.guildId,userId).maxHp} · ${result.game.monster.name} ${result.game.monster.hp}/${result.game.monster.maxHp} HP. Sesi: ${result.game.id}` : ''}`;
    } else if (action === 'cast') {
      const skillId = interaction.options.getString('skill', true), result = store.actHunt(interaction.guildId, userId, interaction.options.getString('session', true), interaction.id, 'skill', skillId);
      if (result.reason !== 'ok') throw new Error(({missing:'Sesi tidak ditemukan.',owner:'Sesi ini milik petualang lain.',duplicate:'Aksi sudah diproses.',ended:'Sesi sudah berakhir.',expired:'Sesi kedaluwarsa.'})[result.reason] || 'Skill tidak dapat digunakan.');
      response = `${result.message}${!result.done ? `\nHP kamu ${result.game.playerHp}/${result.game.playerMaxHp} · ${result.game.monster.name} ${result.game.monster.hp}/${result.game.monster.maxHp} HP. Sesi: ${result.game.id}` : ''}`;
    } else if (action === 'quest') {
      const result = store.quest(interaction.guildId,userId); response = result.claimed ? `📜 Quest selesai: +${result.exp} EXP, ${result.coins} koin, 2 Herb.${result.skillPoints ? ` +${result.skillPoints} Skill Point dari progression rank.` : ''}${result.rankUp ? ` Rank naik ke ${result.rank}.` : ''}` : result.alreadyClaimed ? `📜 Hadiah quest hari ini sudah diklaim. Progress berikutnya: ${result.progress}/${result.target} kemenangan hunting.` : `📜 Quest harian: ${result.progress}/${result.target} hunting menang. Klaim tersedia setelah 3 kemenangan; hadiah 50 EXP, 75 koin, 2 Herb.`;
    } else if (action === 'equip' || action === 'unequip') {
      const result = store.equip(interaction.guildId,userId,interaction.options.getString('item'),interaction.options.getString('slot',true),action==='unequip'); response = action==='unequip' ? `✅ ${result.item.name} dilepas dan dikembalikan ke inventory.` : `✅ ${result.item.name} dipasang pada slot ${result.slot}.`;
    } else if (action === 'use') {
      const result = store.usePotion(interaction.guildId,userId,interaction.options.getString('item',true)); response = `🧪 ${result.item.name}: HP ${result.before} → ${result.hp}/${result.maxHp}.`;
    } else if (action === 'open-box') {
      const result = store.openMysteryBox(interaction.guildId,userId); response = `🎁 Mystery Box berisi **${result.quantity} ${result.item.name}**.`;
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
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (interaction.user?.bot) return interaction.editReply('Bot tidak dapat ikut giveaway.');
  let entered;
  try { entered = store.enter(interaction.message.id, interaction.user.id); }
  catch (error) { console.error(`[GIVEAWAY] Entry store gagal ${safeInteractionError(error)}`); return interaction.editReply('❌ Tidak dapat mendaftarkan entry. Coba lagi.'); }
  return interaction.editReply(entered ? '🎉 Kamu berhasil ikut giveaway!' : 'Kamu sudah ikut atau giveaway ini sudah berakhir.');
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
  catch (error) { console.error(`[GIVEAWAY] Entry gagal ${interaction.message?.id}: ${safeInteractionError(error)}`); }
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
  let acknowledged = false;
  let editAttempted = false;
  try {
    const [, action] = interaction.customId.split(':');
    // Acknowledge before potentially growing JSON reads and Discord lookups.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    acknowledged = true;
    if (action === 'open') {
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
      editAttempted = true;
      return interaction.editReply(`✅ Tiket dibuat: <#${channel.id}>`);
    }
    const ticket = store.getByChannel(interaction.guildId, interaction.channelId);
    if (!ticket) throw new Error('Channel tiket tidak ditemukan.');
    const config = store.configuration(interaction.guildId);
    const isStaff = Boolean(config?.staffRoleId && interaction.member?.roles?.cache?.has(config.staffRoleId));
    if (action === 'close' && interaction.user.id !== ticket.userId && !isStaff && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error('Hanya pembuat tiket atau staf yang dapat menutupnya.');
    if (action === 'reopen' && !isStaff && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error('Hanya staf tiket yang dapat membukanya kembali.');
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
    editAttempted = true;
    return interaction.editReply(`✅ Tiket ${updated.status === 'closed' ? 'ditutup' : 'dibuka kembali'}.`);
  } catch (error) {
    console.warn(`[TICKET] Button ${interaction.customId} gagal: ${safeInteractionError(error)}`);
    if ([10062, 40060].includes(error?.code)) return;
    if (acknowledged && !editAttempted) { editAttempted = true; return interaction.editReply(`❌ ${error.message}`); }
  }
}

module.exports = { SHOP, handleEconomy, handleEconomyAdmin, handleItemAdmin, handleAdventure, handleEconomyAutocomplete, handleGiveawayCreate, handleGiveawayEntry, handleGiveawayButton, finishDueGiveaways, handleTicketCommand, handleTicketButton };

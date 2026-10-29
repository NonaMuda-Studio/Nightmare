'use strict';

const { randomUUID } = require('node:crypto');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits, MessageFlags } = require('discord.js');

const DRAFT_TTL_MS = 15 * 60_000;
const TEMPLATE_KEYS = Object.freeze(['update', 'info', 'event', 'announcement', 'maintenance']);
const TEMPLATES = Object.freeze({
  update: Object.freeze({ title: 'Pembaruan Nightmare', description: 'Tuliskan ringkasan pembaruan.', color: 0x5865f2, footer: 'Nightmare · Update' }),
  info: Object.freeze({ title: 'Informasi Server', description: 'Tuliskan informasi yang perlu diketahui.', color: 0x3498db, footer: 'Nightmare · Informasi' }),
  event: Object.freeze({ title: 'Event Server', description: 'Tuliskan detail event dan cara bergabung.', color: 0x9b59b6, footer: 'Nightmare · Event' }),
  announcement: Object.freeze({ title: 'Pengumuman', description: 'Tuliskan isi pengumuman.', color: 0xf1c40f, footer: 'Nightmare' }),
  maintenance: Object.freeze({ title: 'Pemeliharaan Server', description: 'Tuliskan jadwal dan dampak pemeliharaan.', color: 0xe67e22, footer: 'Nightmare · Maintenance' })
});
const COLORS = Object.freeze(Object.fromEntries(TEMPLATE_KEYS.map(key => [key, TEMPLATES[key].color])));
const MAX_SAFE_TEXT = Object.freeze({ title: 256, description: 4096, footer: 2048, message: 1800 });

function validateHttpsUrl(value, label) {
  if (value === '' || value == null) return null;
  if (typeof value !== 'string' || value.length > 2048) throw new Error(`${label} harus URL HTTPS valid (maksimal 2.048 karakter).`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} harus URL HTTPS valid.`); }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !hostname || url.username || url.password || hostname === 'localhost' || hostname.endsWith('.local') || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) throw new Error(`${label} harus URL HTTPS publik tanpa kredensial atau alamat lokal.`);
  return url.toString();
}

function validateDraft(draft) {
  if (!TEMPLATE_KEYS.includes(draft.template)) throw new Error('Template pengumuman tidak valid.');
  for (const field of Object.keys(MAX_SAFE_TEXT)) {
    const value = draft[field];
    if (typeof value !== 'string' || value.length > MAX_SAFE_TEXT[field] || (field === 'title' || field === 'description') && !value.trim()) throw new Error(`Field ${field} harus berisi teks dengan panjang maksimal ${MAX_SAFE_TEXT[field]}.`);
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(draft.color || '')) throw new Error('Warna harus berformat hex #RRGGBB.');
  validateHttpsUrl(draft.imageUrl, 'Gambar utama');
  validateHttpsUrl(draft.thumbnailUrl, 'Thumbnail');
  return draft;
}

function createAnnouncementDraftStore({ now = Date.now, ttlMs = DRAFT_TTL_MS } = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 60 * 60_000) throw new Error('Masa berlaku draft tidak valid.');
  const drafts = new Map();
  function scope(draft, guildId, ownerId) {
    if (!draft || draft.guildId !== guildId || draft.ownerId !== ownerId) return null;
    if (draft.expiresAt <= now()) { drafts.delete(draft.id); return null; }
    return draft;
  }
  return {
    create({ guildId, ownerId, channelId, roleId = null, template }) {
      for (const [id, draft] of drafts) if (draft.expiresAt <= now()) drafts.delete(id);
      if (drafts.size >= 2_000) throw new Error('Banyak draft masih aktif; coba lagi setelah sebagian kedaluwarsa.');
      if (![guildId, ownerId, channelId].every(id => /^\d{17,20}$/.test(id || '')) || (roleId !== null && !/^\d{17,20}$/.test(roleId)) || !TEMPLATE_KEYS.includes(template)) throw new Error('Draft pengumuman tidak valid.');
      const preset = TEMPLATES[template]; const id = randomUUID();
      const draft = validateDraft({ id, guildId, ownerId, channelId, roleId, template, title: preset.title, description: preset.description, color: `#${preset.color.toString(16).padStart(6, '0')}`, footer: preset.footer, message: '', imageUrl: '', thumbnailUrl: '', status: 'draft', createdAt: now(), expiresAt: now() + ttlMs });
      drafts.set(id, draft); return structuredClone(draft);
    },
    get(id, guildId, ownerId) { const found = scope(drafts.get(id), guildId, ownerId); return found ? structuredClone(found) : null; },
    update(id, guildId, ownerId, patch) {
      const draft = scope(drafts.get(id), guildId, ownerId); if (!draft) throw new Error('Draft tidak ditemukan atau sudah kedaluwarsa.');
      if (draft.status !== 'draft') throw new Error('Draft sudah dikirim atau sedang diproses.');
      const allowed = ['title', 'description', 'color', 'footer', 'message', 'imageUrl', 'thumbnailUrl'];
      if (!patch || Object.keys(patch).some(key => !allowed.includes(key))) throw new Error('Field editor tidak valid.');
      const next = validateDraft({ ...draft, ...patch }); drafts.set(id, next); return structuredClone(next);
    },
    cancel(id, guildId, ownerId) {
      const draft = scope(drafts.get(id), guildId, ownerId); if (!draft) return false;
      if (draft.status !== 'draft') return false; drafts.delete(id); return true;
    },
    beginSend(id, guildId, ownerId) {
      const draft = scope(drafts.get(id), guildId, ownerId); if (!draft) throw new Error('Draft tidak ditemukan atau sudah kedaluwarsa.');
      if (draft.status !== 'draft') throw new Error('Draft sudah pernah dikirim atau sedang diproses.');
      validateDraft(draft); draft.status = 'sending'; drafts.set(id, draft); return structuredClone(draft);
    },
    finishSend(id, status) {
      if (!['sent', 'uncertain'].includes(status)) throw new Error('Status pengiriman tidak valid.');
      const draft = drafts.get(id); if (!draft || draft.status !== 'sending') return false;
      draft.status = status; draft.finishedAt = now(); drafts.set(id, draft); return true;
    },
    size() { return drafts.size; }
  };
}

function buildEmbed(draft) {
  validateDraft(draft);
  const embed = new EmbedBuilder().setTitle(draft.title).setDescription(draft.description).setColor(parseInt(draft.color.slice(1), 16));
  if (draft.footer) embed.setFooter({ text: draft.footer });
  if (draft.imageUrl) embed.setImage(draft.imageUrl);
  if (draft.thumbnailUrl) embed.setThumbnail(draft.thumbnailUrl);
  return embed;
}

function controls(id) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`nightmare_announce:edit:${id}`).setLabel('Edit').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`nightmare_announce:images:${id}`).setLabel('Gambar').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`nightmare_announce:preview:${id}`).setLabel('Preview').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`nightmare_announce:send:${id}`).setLabel('Kirim').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`nightmare_announce:cancel:${id}`).setLabel('Batal').setStyle(ButtonStyle.Danger)
  )];
}

function modalFor(draft, kind) {
  const modal = new ModalBuilder().setCustomId(`nightmare_announce_modal:${kind}:${draft.id}`).setTitle(kind === 'edit' ? 'Edit pengumuman' : 'Edit gambar');
  const fields = kind === 'edit'
    ? [['title','Judul',draft.title,256,TextInputStyle.Short],['description','Deskripsi',draft.description,4000,TextInputStyle.Paragraph],['color','Warna #RRGGBB',draft.color,7,TextInputStyle.Short],['footer','Footer',draft.footer,2048,TextInputStyle.Short],['message','Teks pesan',draft.message,1800,TextInputStyle.Paragraph]]
    : [['imageUrl','URL gambar utama HTTPS',draft.imageUrl,2000,TextInputStyle.Short],['thumbnailUrl','URL thumbnail HTTPS',draft.thumbnailUrl,2000,TextInputStyle.Short]];
  for (const [name,label,value,maxLength,style] of fields) {
    const input = new TextInputBuilder().setCustomId(name).setLabel(label).setStyle(style).setRequired(name === 'title' || name === 'description').setMaxLength(maxLength);
    if (value) input.setValue(value);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return modal;
}

function checkUserPermission(interaction) {
  if (!interaction.inGuild?.() || !interaction.guildId) throw new Error('Studio hanya dapat digunakan di server.');
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error('Perlu izin Manage Server untuk membuat atau mengirim pengumuman.');
}

async function getDraftForInteraction(interaction, store, id) {
  checkUserPermission(interaction);
  const draft = store.get(id, interaction.guildId, interaction.user.id);
  if (!draft) throw new Error('Draft tidak ditemukan, bukan milikmu, atau sudah kedaluwarsa.');
  return draft;
}

async function privateError(interaction, error) {
  console.warn(`[ANNOUNCEMENT] ${interaction.guildId || 'DM'} ${interaction.user?.id || 'unknown'}: ${error.message}`);
  if ([10062, 40060].includes(error.code)) return;
  try {
    if (interaction.deferred || interaction.replied) return await interaction.followUp({ content: `❌ ${error.message}`, flags: MessageFlags.Ephemeral });
    return await interaction.reply({ content: `❌ ${error.message}`, flags: MessageFlags.Ephemeral });
  } catch (replyError) { console.warn(`[ANNOUNCEMENT] Respons privat gagal code=${Number.isInteger(replyError?.code) ? replyError.code : 'none'}`); }
}

async function handleAnnouncementCreate(interaction, store) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    checkUserPermission(interaction);
    const channel = interaction.options.getChannel('channel', true);
    if (!channel || channel.guildId !== interaction.guildId || ![0, 5].includes(channel.type) || !channel.isTextBased?.()) throw new Error('Pilih channel teks dari server ini.');
    if (!channel.permissionsFor(interaction.member)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) throw new Error('Kamu harus dapat melihat dan mengirim pesan di channel tujuan.');
    const role = interaction.options.getRole('role');
    if (role && (role.guild?.id !== interaction.guildId || role.id === interaction.guildId)) throw new Error('Role mention harus role biasa dari server ini.');
    const draft = store.create({ guildId: interaction.guildId, ownerId: interaction.user.id, channelId: channel.id, roleId: role?.id || null, template: interaction.options.getString('template', true) });
    return await interaction.editReply({ content: `Draft **${draft.template}** · <#${draft.channelId}> · berlaku 15 menit. Preview ini hanya terlihat olehmu.`, embeds: [buildEmbed(draft)], components: controls(draft.id), allowedMentions: { parse: [], users: [], roles: [] } });
  } catch (error) { return await interaction.editReply(`❌ ${error.message}`); }
}

async function prepareSend(interaction, store, draft) {
  const guild = interaction.guild;
  if (!guild || guild.id !== draft.guildId) throw new Error('Guild draft tidak cocok.');
  const channel = guild.channels.cache.get(draft.channelId) || await guild.channels.fetch(draft.channelId).catch(() => null);
  if (!channel || channel.guildId !== draft.guildId || ![0, 5].includes(channel.type) || !channel.isTextBased?.() || typeof channel.send !== 'function') throw new Error('Channel tujuan tidak tersedia atau bukan channel teks server ini.');
  const botMember = guild.members.me;
  if (!botMember) throw new Error('Keanggotaan bot di server tidak tersedia untuk pemeriksaan izin.');
  if (!channel.permissionsFor(interaction.member)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) throw new Error('Kamu tidak lagi memiliki izin melihat dan mengirim pesan di channel tujuan.');
  const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
  if (!channel.permissionsFor(botMember)?.has(required)) throw new Error('Bot tidak memiliki ViewChannel, SendMessages, EmbedLinks, atau izin mention role yang diperlukan di channel tujuan.');
  let role = null;
  if (draft.roleId) {
    role = guild.roles.cache.get(draft.roleId) || await guild.roles.fetch(draft.roleId).catch(() => null);
    if (!role || role.guild?.id !== draft.guildId || role.id === draft.guildId) throw new Error('Role mention sudah tidak tersedia di server ini.');
    if (!role.mentionable && !channel.permissionsFor(botMember)?.has(PermissionFlagsBits.MentionEveryone)) throw new Error('Role tidak mentionable dan bot tidak memiliki izin MentionEveryone.');
  }
  return { channel, role };
}

async function handleAnnouncementComponent(interaction, store) {
  const match = /^nightmare_announce:(edit|images|preview|send|confirm|back|cancel):([\da-f-]{36})$/.exec(interaction.customId || '');
  if (!match) return false;
  const [, action, id] = match;
  try {
    let draft = await getDraftForInteraction(interaction, store, id);
    if (action === 'edit' || action === 'images') return await interaction.showModal(modalFor(draft, action === 'edit' ? 'edit' : 'images'));
    if (draft.status !== 'draft') throw new Error('Draft sudah dikirim, sedang diproses, atau tidak dapat diedit.');
    if (action === 'cancel') {
      store.cancel(id, interaction.guildId, interaction.user.id);
      return await interaction.update({ content: 'Draft dibatalkan.', embeds: [], components: [], allowedMentions: { parse: [], users: [], roles: [] } });
    }
    if (action === 'preview') return await interaction.update({ content: `Preview privat · tujuan <#${draft.channelId}>${draft.roleId ? ` · role <@&${draft.roleId}>` : ''}`, embeds: [buildEmbed(draft)], components: controls(id), allowedMentions: { parse: [], users: [], roles: [] } });
    if (action === 'send') {
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`nightmare_announce:confirm:${id}`).setLabel('Konfirmasi kirim publik').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`nightmare_announce:back:${id}`).setLabel('Kembali').setStyle(ButtonStyle.Secondary));
      return await interaction.update({ content: 'Konfirmasi: pengumuman ini akan dikirim ke channel publik yang dipilih.', components: [row], allowedMentions: { parse: [], users: [], roles: [] } });
    }
    if (action === 'back') return await interaction.update({ content: `Draft **${draft.template}** · <#${draft.channelId}> · preview privat.`, embeds: [buildEmbed(draft)], components: controls(id), allowedMentions: { parse: [], users: [], roles: [] } });
    if (action === 'confirm') {
      // Channel/role cache misses require Discord REST fetches; acknowledge the
      // component before those requests so the three-second initial window is met.
      await interaction.deferUpdate();
      validateDraft(draft);
      const { channel, role } = await prepareSend(interaction, store, draft);
      draft = store.get(id, interaction.guildId, interaction.user.id);
      if (!draft || draft.status !== 'draft') throw new Error('Draft telah berubah atau kedaluwarsa sebelum dikirim.');
      draft = store.beginSend(id, interaction.guildId, interaction.user.id);
      const roleMention = role ? `<@&${role.id}>` : '';
      const content = [roleMention, draft.message].filter(Boolean).join('\n');
      try {
        await channel.send({ content: content || undefined, embeds: [buildEmbed(draft)], allowedMentions: { parse: [], users: [], roles: role ? [role.id] : [], repliedUser: false } });
      } catch (error) {
        store.finishSend(id, 'uncertain');
        console.error(`[ANNOUNCEMENT] Pengiriman ${id} gagal/tidak pasti; pesan mungkin telah diterima: ${error.message}`);
        return await interaction.editReply({ content: '⚠️ Pengiriman gagal atau hasilnya tidak dapat dipastikan. Draft dikunci agar tidak terkirim dua kali; periksa channel tujuan sebelum membuat draft baru.', embeds: [], components: [] });
      }
      store.finishSend(id, 'sent');
      return await interaction.editReply({ content: `✅ Pengumuman berhasil dikirim ke <#${channel.id}>.`, embeds: [], components: [] });
    }
    return false;
  } catch (error) { return await privateError(interaction, error); }
}

async function handleAnnouncementModal(interaction, store) {
  const match = /^nightmare_announce_modal:(edit|images):([\da-f-]{36})$/.exec(interaction.customId || '');
  if (!match) return false;
  const [, kind, id] = match;
  try {
    const draft = await getDraftForInteraction(interaction, store, id);
    const patch = kind === 'edit'
      ? { title: interaction.fields.getTextInputValue('title'), description: interaction.fields.getTextInputValue('description'), color: interaction.fields.getTextInputValue('color'), footer: interaction.fields.getTextInputValue('footer'), message: interaction.fields.getTextInputValue('message') }
      : { imageUrl: interaction.fields.getTextInputValue('imageUrl'), thumbnailUrl: interaction.fields.getTextInputValue('thumbnailUrl') };
    const updated = store.update(id, interaction.guildId, interaction.user.id, patch);
    return await interaction.update({ content: `Draft **${updated.template}** · <#${updated.channelId}> · preview privat.`, embeds: [buildEmbed(updated)], components: controls(id), allowedMentions: { parse: [], users: [], roles: [] } });
  } catch (error) { return await privateError(interaction, error); }
}

module.exports = { DRAFT_TTL_MS, TEMPLATE_KEYS, TEMPLATES, validateHttpsUrl, validateDraft, buildEmbed, createAnnouncementDraftStore, handleAnnouncementCreate, handleAnnouncementComponent, handleAnnouncementModal };

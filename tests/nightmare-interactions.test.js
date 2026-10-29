'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { handleEconomy, handleAdventure, handleEconomyAutocomplete, handleGiveawayCreate, handleGiveawayButton, handleTicketButton, handleTicketCommand } = require('../nightmare-interactions');
const { createEconomyStore } = require('../nightmare-services');

function interaction(action, options = {}) {
  const replies = [];
  return {
    replies, id: '12345678901234580', guildId: '12345678901234567', user: { id: '12345678901234568', bot: false },
    inGuild: () => true, memberPermissions: { has: bit => bit === require('discord.js').PermissionFlagsBits.ManageGuild },
    options: {
      getSubcommand: () => action,
      getUser: () => options.member || { id: '12345678901234569', bot: false },
      getInteger: name => name === 'amount' ? (options.amount ?? 25) : (options.minutes ?? 10),
      getString: name => name === 'prize' ? (options.prize ?? 'Book') : (options.item ?? 'Potion')
    },
    async deferReply(options) { replies.push('defer'); this.deferOptions = options; },
    async editReply(payload) { replies.push(payload); return payload; },
    async reply(payload) { replies.push(payload); return payload; }
  };
}

test('economy command defers, uses server-scoped store and reports transfer validation', async () => {
  const calls = [];
  const store = { transfer: (...args) => { calls.push(args); throw new Error('Insufficient balance'); }, balance() { return 0; } };
  const it = interaction('transfer');
  await handleEconomy(it, store);
  assert.equal(it.replies[0], 'defer');
  assert.match(it.replies[1], /Insufficient balance/);
  assert.deepEqual(calls[0], ['12345678901234567', '12345678901234568', '12345678901234569', 25]);
});

test('economy rejects direct messages after acknowledgment', async () => {
  const it = interaction('balance'); it.inGuild = () => false;
  await handleEconomy(it, { balance() { assert.fail('store must not be accessed in DMs'); } });
  assert.equal(it.replies[0], 'defer');
  assert.match(it.replies[1], /server/);
});

test('registered economy buy and sell handlers use the same persistent inventory and balance service', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-economy-handler-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createEconomyStore(path.join(dir, 'economy.json'));
  store.daily('12345678901234567', '12345678901234568', 1000);
  const make = action => {
    const it = interaction(action, { item: 'iron_sword', amount: 1 });
    it.options.getInteger = name => name === 'amount' ? 1 : 0;
    return it;
  };
  const buy = make('buy'); await handleEconomy(buy, store);
  assert.match(buy.replies[1], /Iron Sword/);
  assert.equal(store.inventory('12345678901234567', '12345678901234568').iron_sword, 1);
  const sell = make('sell'); await handleEconomy(sell, store);
  assert.match(sell.replies[1], /Menjual/);
  assert.equal(store.inventory('12345678901234567', '12345678901234568').iron_sword || 0, 0);
});

test('economy shop splits catalogue within Discord embed field limits', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-shop-handler-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const it = interaction('shop');
  await handleEconomy(it, createEconomyStore(path.join(dir, 'economy.json')));
  const payload = it.replies[1];
  assert.equal(payload.embeds.length, 2);
  assert.deepEqual(payload.embeds.map(embed => embed.data.fields.length), [25, 5]);
});

test('Adventure Discord handler registers and crafts against Economy inventory; item autocomplete exposes valid IDs', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-adventure-handler-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createEconomyStore(path.join(dir, 'economy.json')); const guildId = '12345678901234567', userId = '12345678901234568';
  const register = interaction('register', { item: 'Aria' }); register.options.getString = () => 'Aria';
  await handleAdventure(register, store); assert.match(register.replies[1], /terdaftar/);
  store.adminItem(guildId, '12345678901234569', userId, 'give', 'slime_gel', 2);
  store.adminItem(guildId, '12345678901234569', userId, 'give', 'herb', 1);
  const craft = interaction('craft', { item: 'health_potion', amount: 1 }); craft.options.getString = () => 'health_potion'; craft.options.getInteger = () => 1;
  await handleAdventure(craft, store); assert.match(craft.replies[1], /Craft berhasil/);
  assert.equal(store.inventory(guildId, userId).health_potion, 1);
  let choices;
  await handleEconomyAutocomplete({ commandName: 'adventure', options: { getSubcommand: () => 'craft', getFocused: () => ({ name: 'item', value: 'wand' }) }, respond: async value => { choices = value; } });
  assert.ok(choices.some(option => option.value === 'magic_wand'));
});

test('Adventure slash handler acknowledges hunt privately and rejects another user without consuming a turn', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nightmare-adventure-hunt-handler-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=createEconomyStore(path.join(dir,'economy.json'));const guildId='12345678901234567',owner='12345678901234568';store.registerAdventure(guildId,owner,'Rin');
  const hunt=interaction('hunt');await handleAdventure(hunt,store);assert.equal(hunt.replies[0],'defer');assert.equal(hunt.deferOptions.flags,64);assert.match(hunt.replies[1],/Sesi berlaku 5 menit/);const session=hunt.id;
  const outsider=interaction('fight');outsider.user={id:'12345678901234569',bot:false};outsider.options.getString=name=>name==='session'?session:name==='action'?'attack':null;await handleAdventure(outsider,store);assert.match(outsider.replies[1],/milik petualang lain/);
  const ownerExit=interaction('fight');ownerExit.id='12345678901234581';ownerExit.options.getString=name=>name==='session'?session:name==='action'?'run':null;await handleAdventure(ownerExit,store);assert.match(ownerExit.replies[1],/kabur/);assert.equal(store.balance(guildId,owner),0);
});

test('Adventure admin subcommands enforce Administrator at execution and audit authorized bypasses', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nightmare-adventure-admin-handler-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=createEconomyStore(path.join(dir,'economy.json'));const guild='12345678901234567',target='12345678901234569';store.registerAdventure(guild,target,'Kai');
  const denied=interaction('rank');denied.options.getSubcommandGroup=()=> 'admin';denied.options.getUser=()=>({id:target,bot:false});denied.options.getString=()=> 'S';denied.memberPermissions={has:()=>false};await handleAdventure(denied,store);assert.match(denied.replies[1],/Administrator/);assert.equal(store.adventureProfile(guild,target).rank,'F');
  const allowed=interaction('rank');allowed.options.getSubcommandGroup=()=> 'admin';allowed.options.getUser=()=>({id:target,bot:false});allowed.options.getString=()=> 'S';allowed.memberPermissions={has:value=>value===require('discord.js').PermissionFlagsBits.Administrator};await handleAdventure(allowed,store);assert.match(allowed.replies[1],/override admin/);assert.equal(store.adventureProfile(guild,target).rank,'S');
  const botTarget=interaction('rank');botTarget.options.getSubcommandGroup=()=> 'admin';botTarget.options.getUser=()=>({id:target,bot:true});botTarget.memberPermissions=allowed.memberPermissions;await handleAdventure(botTarget,store);assert.match(botTarget.replies[1],/pemain manusia/);
});

test('Adventure skill commands are ephemeral, cast only learned skills, and admin skill bypass is authorized and audited', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nightmare-adventure-skill-handler-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=createEconomyStore(path.join(dir,'economy.json'));const guild='12345678901234567',user='12345678901234568';store.registerAdventure(guild,user,'Mira');store.setAdventureSkillPoints(guild,user,user,'set',5,'12345678901234581');
  const skills=interaction('skills');skills.options.getString=name=>name==='skill'?'arcane_slash':null;await handleAdventure(skills,store);assert.equal(skills.replies[0],'defer');assert.match(skills.replies[1],/Arcane Slash/);
  const learn=interaction('learn');learn.options.getString=name=>name==='skill'?'arcane_slash':null;await handleAdventure(learn,store);assert.match(learn.replies[1],/Dipelajari/);assert.equal(store.adventureProfile(guild,user).skillPoints,4);
  const game=store.startHunt(guild,user,'12345678901234582',{random:()=>0});const cast=interaction('cast');cast.options.getString=name=>name==='session'?game.id:'arcane_slash';await handleAdventure(cast,store);assert.match(cast.replies[1],/Arcane Slash/);const escape=interaction('fight');escape.id='12345678901234584';escape.options.getString=name=>name==='session'?game.id:'run';await handleAdventure(escape,store);
  const forbidden=interaction('skill');forbidden.options.getSubcommandGroup=()=> 'admin';forbidden.options.getUser=()=>({id:user,bot:false});forbidden.options.getString=name=>name==='skill'?'crescent_nova':null;forbidden.options.getInteger=()=>1;forbidden.memberPermissions={has:()=>false};await handleAdventure(forbidden,store);assert.match(forbidden.replies[1],/Administrator/);assert.equal(store.adventureProfile(guild,user).skills.crescent_nova,undefined);
  const bypass=interaction('skill');bypass.id='12345678901234583';bypass.options.getSubcommandGroup=()=> 'admin';bypass.options.getUser=()=>({id:user,bot:false});bypass.options.getString=name=>name==='skill'?'arcane_slash':null;bypass.options.getInteger=()=>2;bypass.memberPermissions={has:value=>value===require('discord.js').PermissionFlagsBits.Administrator};await handleAdventure(bypass,store);assert.match(bypass.replies[1],/level 1 → 2/);assert.ok(store.adventureProfile(guild,user).skills.arcane_slash===2);assert.ok(JSON.parse(fs.readFileSync(path.join(dir,'economy.json'),'utf8')).guilds[guild].adminAudit.some(entry=>entry.action==='adventure_skill_override'));
});

test('Adventure enemy autocomplete contains only catalog encounters', async () => {
  let choices;await handleEconomyAutocomplete({commandName:'adventure',options:{getSubcommand:()=> 'enemy',getSubcommandGroup:()=> 'admin',getFocused:()=>({name:'monster',value:'gob'})},respond:async value=>{choices=value;}});assert.deepEqual(choices.map(option=>option.value),['goblin']);
});

test('giveaway creation enforces Manage Server and rolls message back on persistence failure', async () => {
  const it = interaction('create', { prize: 'Book' });
  it.channelId = '12345678901234570';
  let deleted = false;
  const message = { id: '12345678901234571', edit: async () => {}, delete: async () => { deleted = true; } };
  it.channel = { isTextBased: () => true, send: async () => message };
  await handleGiveawayCreate(it, { create() { throw new Error('disk unavailable'); } }, { now: () => 1_000 });
  assert.equal(it.replies[0], 'defer');
  assert.equal(deleted, true);
  assert.match(it.replies[1], /disk unavailable/);

  const denied = interaction('create'); denied.channel = it.channel; denied.memberPermissions = { has: () => false };
  await handleGiveawayCreate(denied, { create: () => assert.fail('must reject before store') });
  assert.match(denied.replies[1], /Manage Server/);
});

test('giveaway button creates a private response and handles storage failures', async () => {
  const it = { user: { id: '12345678901234568', bot: false }, message: { id: '12345678901234569' }, replied: false, deferred: false, async deferReply(payload) { this.deferred = true; this.deferOptions = payload; }, async editReply(content) { this.payload = { content }; }, async reply(payload) { this.replied = true; this.payload = payload; } };
  await handleGiveawayButton(it, { enter: () => true });
  assert.match(it.payload.content, /berhasil ikut/);
  assert.equal(it.deferOptions.flags, 64);

  const failed = { ...it, replied: false, deferred: false, async deferReply(payload) { this.deferred = true; this.deferOptions = payload; }, async editReply(content) { this.payload = { content }; } };
  await handleGiveawayButton(failed, { enter() { throw new Error('corrupt store'); } });
  assert.match(failed.payload.content, /Tidak dapat mendaftarkan/);
  assert.equal(failed.deferOptions.flags, 64);
});

test('ticket open button creates a private channel, persists it and prevents duplicate openings', async () => {
  const guild = {
    id: '12345678901234567', members: { me: { id: '12345678901234572' } },
    channels: { async create(options) { guild.created = options; return { id: '12345678901234573', async send(payload) { guild.ticketMessage = payload; }, async delete() { guild.rolledBack = true; } }; } }
  };
  const calls = [];
  const store = { configuration: () => ({ staffRoleId: '12345678901234570', categoryId: null }), create: data => calls.push(data) };
  const it = { customId: 'nightmare_ticket:open', guild, guildId: guild.id, user: { id: '12345678901234568', username: 'A User' }, deferred: false, replied: false,
    async deferReply() { this.deferred = true; }, async editReply(message) { this.result = message; } };
  await handleTicketButton(it, store);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channelId, '12345678901234573');
  assert.ok(guild.created.permissionOverwrites.some(entry => entry.id === it.user.id));
  assert.match(it.result, /Tiket dibuat/);

  const duplicate = { ...it, deferred: false, replied: false, async deferReply() { this.deferred = true; }, async editReply(message) { this.result = message; } };
  await handleTicketButton(duplicate, { ...store, create() { throw new Error('Kamu sudah memiliki tiket terbuka.'); } });
  assert.match(duplicate.result, /sudah memiliki tiket/);
});

test('ticket close button acknowledges before reading persistent ticket state', async () => {
  const it = { customId:'nightmare_ticket:close',guildId:'12345678901234567',channelId:'12345678901234573',user:{id:'12345678901234568'},deferred:false,async deferReply(){this.deferred=true;},async editReply(message){this.result=message;} };
  const store={getByChannel(){assert.equal(it.deferred,true);return null;}};
  await handleTicketButton(it,store);assert.match(it.result,/Channel tiket tidak ditemukan/);
});

test('ticket close/reopen button enforces roles, updates access, control buttons, and transcript', async () => {
  const userId = '12345678901234568';
  let status = 'open'; const transitions = [];
  const ticket = { userId, channelId: '12345678901234573', status };
  let savedTranscript = null;
  const store = {
    configuration: () => ({ staffRoleId: '12345678901234570' }),
    getByChannel: () => ({ ...ticket, status }),
    saveTranscript(_guild, _channel, value) { savedTranscript = value; },
    setStatus(_guild, _channel, next) { transitions.push(next); status = next; ticket.status = next; return { ...ticket }; }
  };
  const edits = [], sends = [], overwrites = [];
  const messages = new Map([
    ['m1', { createdTimestamp: 2, author: { username: 'Staff' }, cleanContent: 'Resolved it', attachments: new Map() }],
    ['m2', { createdTimestamp: 1, author: { username: 'Member' }, cleanContent: 'Need help', attachments: new Map() }]
  ]);
  const channel = {
    permissionOverwrites: { async edit(id, values) { overwrites.push([id, values]); } },
    messages: { async fetch() { return messages; } },
    async send(payload) { sends.push(payload); }
  };
  const makeInteraction = ({ action, user, roles = [], messageEdit = async value => edits.push(value), permissionEdit } = {}) => ({
    customId: `nightmare_ticket:${action}`, guildId: '12345678901234567', channelId: ticket.channelId,
    user: user || { id: userId }, member: { roles: { cache: { has: roleId => roles.includes(roleId) } } },
    memberPermissions: { has: () => false }, channel, message: { edit: messageEdit },
    client: { user: { id: '12345678901234572' } }, deferred: false, replied: false,
    async deferReply() { this.deferred = true; }, async editReply(content) { this.result = content; },
    async reply(payload) { this.replied = true; this.result = payload.content; },
    ...(permissionEdit ? { channel: { ...channel, permissionOverwrites: { edit: permissionEdit }, messages: channel.messages, send: channel.send } } : {})
  });

  const close = makeInteraction({ action: 'close' });
  const lifecycleEvents = [];
  await handleTicketButton(close, store, { onClosed: (...args) => lifecycleEvents.push(['closed', ...args]) });
  assert.equal(status, 'closed');
  assert.deepEqual(overwrites[0], [userId, { SendMessages: false }]);
  assert.match(sends[0].content, /dihapus dalam satu menit/);
  assert.match(savedTranscript, /Need help[\s\S]*Resolved it/);
  assert.deepEqual(lifecycleEvents, [['closed', '12345678901234567', ticket.channelId]]);
  assert.equal(sends[0].files[0].name, `ticket-${ticket.channelId}.txt`);
  assert.match(sends[0].files[0].attachment.toString(), /Need help[\s\S]*Resolved it/);
  assert.match(edits[0].components[0].components[0].data.custom_id, /reopen/);

  const reopen = makeInteraction({ action: 'reopen', user: { id: '12345678901234574' }, roles: ['12345678901234570'] });
  await handleTicketButton(reopen, store, { onReopened: (...args) => lifecycleEvents.push(['reopened', ...args]) });
  assert.equal(status, 'open');
  assert.deepEqual(overwrites[1], [userId, { SendMessages: true }]);
  assert.match(edits[1].components[0].components[0].data.custom_id, /close/);
  assert.deepEqual(lifecycleEvents[1], ['reopened', '12345678901234567', ticket.channelId]);
  assert.deepEqual(transitions, ['closed', 'open']);
});

test('ticket rejects unauthorized reopen and rolls stored status back if Discord permission update fails', async () => {
  let status = 'open'; const transitions = [];
  const store = {
    configuration: () => ({ staffRoleId: '12345678901234570' }),
    getByChannel: () => ({ userId: '12345678901234568', channelId: '12345678901234573', status }),
    saveTranscript() {},
    setStatus(_guild, _channel, next) { transitions.push(next); status = next; return { userId: '12345678901234568', channelId: '12345678901234573', status }; }
  };
  const base = { customId: 'nightmare_ticket:reopen', guildId: '12345678901234567', channelId: '12345678901234573', user: { id: '12345678901234574' }, member: { roles: { cache: { has: () => false } } }, memberPermissions: { has: () => false }, replied: false, deferred: false, async deferReply() { this.deferred = true; }, async editReply(payload) { this.result = payload; }, async reply(payload) { this.result = payload.content; } };
  await handleTicketButton(base, store);
  assert.match(base.result, /Hanya staf/);
  assert.deepEqual(transitions, []);

  status = 'open'; transitions.length = 0;
  const failing = { ...base, customId: 'nightmare_ticket:close', user: { id: '12345678901234568' }, async deferReply() { this.deferred = true; }, async editReply(value) { this.result = value; }, channel: { permissionOverwrites: { async edit() { throw new Error('Missing Permissions'); } } } };
  await handleTicketButton(failing, store);
  assert.deepEqual(transitions, ['closed', 'open']);
  assert.equal(status, 'open');
  assert.match(failing.result, /Missing Permissions/);
});

test('ticket slash close/reopen uses the same access controls and persistent status transitions', async () => {
  let status = 'open'; const changes = [];
  const store = {
    configuration: () => ({ staffRoleId: '12345678901234570' }),
    getByChannel: () => ({ userId: '12345678901234568', channelId: '12345678901234573', status }),
    saveTranscript() {},
    setStatus(_guild, _channel, next) { changes.push(next); status = next; return { userId: '12345678901234568', channelId: '12345678901234573', status }; }
  };
  const sent = [], componentEdits = [];
  const channel = {
    permissionOverwrites: { async edit() {} },
    messages: { async fetch() { return new Map(); } },
    async send(payload) { sent.push(payload); }
  };
  const make = (action, userId, isStaff) => ({
    guildId: '12345678901234567', channelId: '12345678901234573', user: { id: userId },
    inGuild: () => true,
    member: { roles: { cache: { has: id => isStaff && id === '12345678901234570' } } },
    memberPermissions: { has: () => false }, channel, client: { user: { id: '12345678901234572' } },
    options: { getSubcommand: () => action },
    async deferReply() {}, async editReply(value) { this.result = value; }
  });
  const creatorClose = make('close', '12345678901234568', false);
  await handleTicketCommand(creatorClose, store);
  assert.equal(status, 'closed');
  assert.match(sent[0].content, /Transkrip/);
  const staffReopen = make('reopen', '12345678901234574', true);
  staffReopen.channel.messages.fetch = async () => new Map([['control', { author: { id: '12345678901234572' }, components: [{ components: [{ customId: 'nightmare_ticket:close' }] }], async edit(value) { componentEdits.push(value); } }]]);
  await handleTicketCommand(staffReopen, store);
  assert.equal(status, 'open');
  assert.match(componentEdits[0].components[0].components[0].data.custom_id, /close/);
  assert.deepEqual(changes, ['closed', 'open']);
});

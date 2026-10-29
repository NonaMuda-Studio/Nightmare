'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const {
  CATEGORY_NAMES, STATS_CHANNELS, SETUP_MANIFESTS, buildSetupPreview,
  permissionOverwrites, applySetupManifest, createSetupConfirmationStore,
  renderSetupPreview, inspectPrivateChannelPermissions, validateSetupStaffRole, setupPreviewMatches
} = require('../server-setup');
const { calculateServerStats, createServerStatusUpdater } = require('../server-status');

const expectedStats = ['👥・all-members','👤・members','🤖・bots','💬・channels','🎭・roles'];

test('three distinct manifests have the required eight ordered categories and calculated permanent-channel minimums', () => {
  assert.deepEqual(CATEGORY_NAMES, [
    '– – ~ 📊 • | SERVER STATS |','– – ~ 📢 • | ANNOUNCEMENT |','– – ~ 💬 • | GENERAL |','– – ~ 📝 • | LOGS |',
    '– – ~ 🎮 • | GAME |','– – ~ 🛡️ • | MOD & STAFF |','– – ~ 🎵 • | MUSIC |','– – ~ 🔊 • | VOICE LOUNGE |'
  ]);
  const minimums = { large: 95, medium: 50, small: 35 };
  for (const [id, minimum] of Object.entries(minimums)) {
    const manifest = SETUP_MANIFESTS[id];
    assert.equal(manifest.categories.length, 8);
    assert.deepEqual(manifest.categories.map(category => category.name), CATEGORY_NAMES);
    assert.deepEqual(manifest.categories.map(category => category.order), [1,2,3,4,5,6,7,8]);
    const countedFromActualChannelSpecs = manifest.categories.reduce((count, category) => count + category.channels.length, 0);
    assert.equal(manifest.permanentChannelCount, countedFromActualChannelSpecs);
    assert.ok(countedFromActualChannelSpecs >= minimum);
    const stats = manifest.categories[0];
    assert.deepEqual(stats.channels.map(channel => channel.name), expectedStats);
    assert.ok(stats.channels.every(channel => channel.type === ChannelType.GuildText));
    assert.ok(stats.channels.every(channel => channel.order >= 1 && channel.permissions.profile === 'inherit-category'));
    assert.equal(manifest.categories[3].permissionProfile, 'private-staff');
    assert.equal(manifest.categories[5].permissionProfile, 'private-staff');
    const names = manifest.categories.flatMap(category => category.channels.map(channel => channel.name));
    assert.equal(new Set(names).size, names.length, `${id} has no duplicate channel names`);
    for (const category of manifest.categories) {
      assert.equal(category.type, ChannelType.GuildCategory);
      assert.ok(category.permissions.profile);
      for (const channel of category.channels) {
        assert.ok(channel.name.includes('・'));
        assert.ok(channel.typeName);
        assert.ok(Number.isInteger(channel.order));
        assert.equal(channel.permissionProfile, 'inherit-category');
        assert.ok(channel.permissions.profile);
      }
    }
  }
  assert.deepEqual(Object.fromEntries(Object.entries(SETUP_MANIFESTS).map(([id, manifest]) => [id, manifest.permanentChannelCount])), { large: 95, medium: 50, small: 35 });
});

test('preview calculates new, matching, and conflicting resources from live channel collection', () => {
  const manifest = SETUP_MANIFESTS.small;
  const category = { id: 'cat-stats', name: CATEGORY_NAMES[0], type: ChannelType.GuildCategory };
  const already = { id: 'stats-1', name: STATS_CHANNELS[0], type: ChannelType.GuildText, parentId: category.id };
  const conflict = { id: 'wrong-place', name: STATS_CHANNELS[1], type: ChannelType.GuildText, parentId: 'elsewhere' };
  const preview = buildSetupPreview(manifest, new Map([[category.id, category], [already.id, already], [conflict.id, conflict]]));
  assert.equal(preview.permanentChannelCount, manifest.categories.reduce((n, item) => n + item.channels.length, 0));
  assert.equal(preview.existingChannels, 1);
  assert.equal(preview.conflicts, 1);
  assert.equal(preview.newChannels, preview.permanentChannelCount - 2);
  assert.equal(preview.categories[0].channelPlans[0].status, 'existing');
  assert.equal(preview.categories[0].channelPlans[1].status, 'conflict');
  const counterPreview = buildSetupPreview(manifest, new Map([
    [category.id, category],
    ['live-counter', { id: 'live-counter', name: STATS_CHANNELS[0] + '・73', type: ChannelType.GuildText, parentId: category.id }]
  ]));
  assert.equal(counterPreview.categories[0].channelPlans[0].status, 'existing');
  assert.equal(renderSetupPreview(preview).length, 8);
});

test('staff and stats category overwrites are explicit and do not grant private access to everyone', () => {
  const staff = permissionOverwrites('private-staff', { everyoneId: 'guild', botId: 'bot', staffRoleId: 'staff' });
  assert.ok(staff[0].deny.includes(PermissionFlagsBits.ViewChannel));
  assert.equal(staff.some(overwrite => overwrite.id === 'staff' && overwrite.allow.includes(PermissionFlagsBits.ViewChannel)), true);
  assert.equal(staff.some(overwrite => overwrite.id === 'bot' && overwrite.allow.includes(PermissionFlagsBits.ManageChannels)), true);
  const noConfiguredStaff = permissionOverwrites('private-staff', { everyoneId: 'guild', botId: 'bot' });
  assert.deepEqual(noConfiguredStaff.map(item => item.id), ['guild','bot']);
  const stats = permissionOverwrites('stats-readonly', { everyoneId: 'guild', botId: 'bot' });
  assert.ok(stats[0].allow.includes(PermissionFlagsBits.ViewChannel));
  assert.ok(stats[0].deny.includes(PermissionFlagsBits.SendMessages));
});

function makeGuild() {
  const channels = new Map();
  let next = 1;
  const manager = {
    async fetch(id) { return id ? channels.get(id) || null : new Map(channels); },
    async create(payload) {
      if (payload.name === '💬・global-chat') {
        const error = new Error('mock rate limit'); error.code = 429; throw error;
      }
      const parent = payload.parent ? channels.get(payload.parent) : null;
      const object = { ...payload, permissionOverwrites: payload.permissionOverwrites || parent?.permissionOverwrites || [], permissionsLocked: Boolean(parent), id: `c${next++}`, parentId: payload.parent || null, async setName(name) { this.name = name; } };
      channels.set(object.id, object);
      return object;
    }
  };
  return { id: 'guild-1', channels: manager, all: channels };
}

test('setup applies only missing entries, verifies creations, stays idempotent, and continues after a rate-limit error', async () => {
  const manifest = SETUP_MANIFESTS.small;
  const guild = makeGuild();
  const logger = { info() {} };
  const first = await applySetupManifest(guild, manifest, { staffRoleId: 'staff-role', botId: 'bot-id', logger });
  assert.equal(first.madeCategories, 8);
  assert.equal(first.failed.length, 1);
  assert.match(first.failed[0], /global-chat/);
  assert.equal(first.actualCount, manifest.permanentChannelCount - 1);
  const createdAfterFirst = guild.all.size;
  for (const counter of STATS_CHANNELS) {
    const item = [...guild.all.values()].find(channel => channel.name === counter);
    item.name = counter + '・73';
  }
  const second = await applySetupManifest(guild, manifest, { staffRoleId: 'staff-role', botId: 'bot-id', logger });
  assert.equal(guild.all.size, createdAfterFirst, 'rerun creates no duplicate category or channel');
  assert.equal(second.madeCategories, 0);
  assert.equal(second.madeChannels, 0);
  assert.equal(second.actualCount, manifest.permanentChannelCount - 1);
  assert.ok(second.skipped >= manifest.permanentChannelCount - 1);
  const staffCategory = [...guild.all.values()].find(item => item.name === CATEGORY_NAMES[5]);
  assert.equal(staffCategory.permissionOverwrites[0].deny.includes(PermissionFlagsBits.ViewChannel), true);
  assert.equal(staffCategory.permissionOverwrites[1].id, 'staff-role');
  const statsCategory = [...guild.all.values()].find(item => item.name === CATEGORY_NAMES[0]);
  assert.equal(statsCategory.permissionOverwrites[0].deny.includes(PermissionFlagsBits.SendMessages), true);
});

test('setup rerun after a bot restart reuses server state and does not create duplicates', async () => {
  const originalGuild = makeGuild();
  originalGuild.channels.create = async payload => {
    const parent = payload.parent ? originalGuild.all.get(payload.parent) : null;
    const created = { ...payload, permissionOverwrites: payload.permissionOverwrites || parent?.permissionOverwrites || [], permissionsLocked: Boolean(parent), id: `restart-${originalGuild.all.size}`, parentId: payload.parent || null };
    originalGuild.all.set(created.id, created);
    return created;
  };
  const first = await applySetupManifest(originalGuild, SETUP_MANIFESTS.small, { botId: 'bot-id', logger: { info() {} } });
  assert.equal(first.madeCategories, 8);
  assert.equal(first.madeChannels, SETUP_MANIFESTS.small.permanentChannelCount);
  const channelCountBeforeRestart = originalGuild.all.size;

  // A new manager and guild wrapper represent a fresh process; only Discord's
  // persisted channel state is shared with it.
  const restartedGuild = {
    id: originalGuild.id,
    channels: {
      async fetch(id) { return id ? originalGuild.all.get(id) || null : new Map(originalGuild.all); },
      async create() { throw new Error('No resource should be created on restart rerun.'); }
    }
  };
  const rerun = await applySetupManifest(restartedGuild, SETUP_MANIFESTS.small, { botId: 'bot-id', logger: { info() {} } });
  assert.equal(originalGuild.all.size, channelCountBeforeRestart);
  assert.equal(rerun.madeCategories, 0);
  assert.equal(rerun.madeChannels, 0);
  assert.equal(rerun.failed.length, 0);
  assert.equal(rerun.actualCount, SETUP_MANIFESTS.small.permanentChannelCount);
});

test('existing private child overwrites are classified and unsafe or unknown channels are skipped unchanged', async () => {
  const guild = makeGuild();
  await applySetupManifest(guild, SETUP_MANIFESTS.small, { staffRoleId: 'staff-role', botId: 'bot-id', logger: { info() {} } });
  const staffSpec = SETUP_MANIFESTS.small.categories[5].channels[0];
  const staffChannel = [...guild.all.values()].find(channel => channel.name === staffSpec.name);
  assert.equal(inspectPrivateChannelPermissions(staffChannel, { guildId: guild.id, staffRoleId: 'staff-role', botId: 'bot-id' }).status, 'safe');

  staffChannel.permissionOverwrites = [{ id: guild.id, allow: [PermissionFlagsBits.ViewChannel], deny: [] }];
  const unsafePreview = buildSetupPreview(SETUP_MANIFESTS.small, guild.all, { guildId: guild.id, staffRoleId: 'staff-role', botId: 'bot-id' });
  assert.equal(unsafePreview.categories[5].channelPlans[0].permissionStatus, 'unsafe');
  assert.equal(unsafePreview.categories[5].channelPlans[0].status, 'conflict');
  assert.match(unsafePreview.categories[5].channelPlans[0].statusReason, /@everyone/);
  const unsafeResult = await applySetupManifest(guild, SETUP_MANIFESTS.small, { staffRoleId: 'staff-role', botId: 'bot-id', logger: { info() {} } });
  assert.ok(unsafeResult.failed.some(reason => reason.includes(staffSpec.name) && reason.includes('unsafe')));
  assert.equal(staffChannel.permissionOverwrites[0].allow.includes(PermissionFlagsBits.ViewChannel), true, 'old permission is left unchanged');

  staffChannel.permissionOverwrites = [{ id: 'unrecognized-role', allow: [PermissionFlagsBits.ViewChannel], deny: [] }];
  const unverifiablePreview = buildSetupPreview(SETUP_MANIFESTS.small, guild.all, { guildId: guild.id, staffRoleId: 'staff-role', botId: 'bot-id' });
  assert.equal(unverifiablePreview.categories[5].channelPlans[0].permissionStatus, 'unverifiable');
  assert.equal(unverifiablePreview.categories[5].channelPlans[0].status, 'conflict');
  const unverifiableResult = await applySetupManifest(guild, SETUP_MANIFESTS.small, { staffRoleId: 'staff-role', botId: 'bot-id', logger: { info() {} } });
  assert.ok(unverifiableResult.failed.some(reason => reason.includes(staffSpec.name) && reason.includes('unverifiable')));
  assert.equal(inspectPrivateChannelPermissions({}, { guildId: guild.id }).status, 'unverifiable');
  assert.equal(inspectPrivateChannelPermissions({ permissionOverwrites: [], permissionsLocked: false }, { guildId: guild.id }).status, 'unverifiable');
  assert.equal(inspectPrivateChannelPermissions({ permissionOverwrites: [{ id: guild.id, allow: [], deny: [PermissionFlagsBits.ViewChannel] }, { id: 'staff-role', allow: [PermissionFlagsBits.ViewChannel], deny: [] }, { id: 'bot-id', allow: [PermissionFlagsBits.ViewChannel], deny: [] }], permissionsLocked: false }, { guildId: guild.id, staffRoleId: 'staff-role', botId: 'bot-id' }).status, 'safe');
});

test('existing unsafe private categories are not reused or silently made public', async () => {
  const guild = makeGuild();
  const existing = { id: 'unsafe-staff', name: CATEGORY_NAMES[5], type: ChannelType.GuildCategory, permissionOverwrites: [] };
  guild.all.set(existing.id, existing);
  const existingStaffChannel = { id: 'existing-staff-chat', name: SETUP_MANIFESTS.small.categories[5].channels[0].name, type: ChannelType.GuildText, parentId: existing.id };
  guild.all.set(existingStaffChannel.id, existingStaffChannel);
  const preview = buildSetupPreview(SETUP_MANIFESTS.small, guild.all, { guildId: guild.id, staffRoleId: 'staff-role', botId: 'bot-id' });
  assert.equal(preview.categories[5].categoryPermissionSafe, false);
  assert.equal(preview.categories[5].channelPlans[0].status, 'conflict');
  assert.match(renderSetupPreview(preview)[5].name, /permission unsafe, skipped/);
  const result = await applySetupManifest(guild, SETUP_MANIFESTS.small, { botId: 'bot-id', logger: { info() {} } });
  assert.ok(result.failed.some(message => message.includes(CATEGORY_NAMES[5]) && message.includes('permission')));
  assert.deepEqual([...guild.all.values()].filter(channel => channel.parentId === existing.id).map(channel => channel.id), [existingStaffChannel.id]);
});

test('private category with an unpreviewed View Channel grant is conflicted and left unchanged', async () => {
  const guild = makeGuild();
  const category = {
    id: 'staff-with-extra-access', name: CATEGORY_NAMES[5], type: ChannelType.GuildCategory,
    permissionOverwrites: [
      { id: guild.id, allow: [], deny: [PermissionFlagsBits.ViewChannel] },
      { id: 'staff-role', allow: [PermissionFlagsBits.ViewChannel], deny: [] },
      { id: 'bot-id', allow: [PermissionFlagsBits.ViewChannel], deny: [] },
      { id: 'unpreviewed-role', allow: [PermissionFlagsBits.ViewChannel], deny: [] }
    ]
  };
  guild.all.set(category.id, category);
  const preview = buildSetupPreview(SETUP_MANIFESTS.small, guild.all, { guildId: guild.id, staffRoleId: 'staff-role', botId: 'bot-id' });
  assert.equal(preview.categories[5].categoryPermissionSafe, false);
  assert.equal(preview.categories[5].channelPlans[0].status, 'conflict');
  const result = await applySetupManifest(guild, SETUP_MANIFESTS.small, { staffRoleId: 'staff-role', botId: 'bot-id', logger: { info() {} } });
  assert.ok(result.failed.some(reason => reason.includes(CATEGORY_NAMES[5]) && reason.includes('permission')));
  assert.equal(category.permissionOverwrites.some(overwrite => overwrite.id === 'unpreviewed-role'), true);
  assert.equal([...guild.all.values()].some(channel => channel.parentId === category.id), false);
});

test('public category explicitly denying everyone is conflicted instead of presented as usable', async () => {
  const guild = makeGuild();
  const category = {
    id: 'hidden-public-category', name: CATEGORY_NAMES[2], type: ChannelType.GuildCategory,
    permissionOverwrites: [{ id: guild.id, allow: [], deny: [PermissionFlagsBits.ViewChannel] }]
  };
  guild.all.set(category.id, category);
  const preview = buildSetupPreview(SETUP_MANIFESTS.small, guild.all, { guildId: guild.id, botId: 'bot-id' });
  assert.equal(preview.categories[2].categoryPermissionSafe, false);
  assert.equal(preview.categories[2].channelPlans[0].status, 'conflict');
  const result = await applySetupManifest(guild, SETUP_MANIFESTS.small, { botId: 'bot-id', logger: { info() {} } });
  assert.ok(result.failed.some(reason => reason.includes(CATEGORY_NAMES[2]) && reason.includes('permission')));
  assert.equal([...guild.all.values()].some(channel => channel.parentId === category.id), false);
});

test('setup failure creating one category does not prevent later categories from being attempted', async () => {
  const manifest = SETUP_MANIFESTS.small;
  const guild = makeGuild();
  const create = guild.channels.create;
  guild.channels.create = async payload => {
    if (payload.name === CATEGORY_NAMES[1]) throw Object.assign(new Error('mock API unavailable'), { code: 500 });
    return create(payload);
  };
  const result = await applySetupManifest(guild, manifest, { botId: 'bot-id', logger: { info() {} } });
  assert.ok(result.failed.some(message => message.includes(CATEGORY_NAMES[1])));
  assert.ok([...guild.all.values()].some(channel => channel.name === CATEGORY_NAMES[2]));
});

test('setup aborts before mutation when guild resources changed after preview', async () => {
  const guild = makeGuild();
  const manifest = SETUP_MANIFESTS.small;
  const preview = buildSetupPreview(manifest, guild.all, { guildId: guild.id, staffRoleId: 'staff-role', botId: 'bot-id' });
  const category = { id: 'changed-category', name: CATEGORY_NAMES[2], type: ChannelType.GuildCategory, permissionOverwrites: [] };
  const conflicting = { id: 'changed-channel', name: manifest.categories[2].channels[0].name, type: ChannelType.GuildVoice, parentId: category.id, permissionOverwrites: [], permissionsLocked: true };
  guild.all.set(category.id, category);
  guild.all.set(conflicting.id, conflicting);
  const current = buildSetupPreview(manifest, guild.all, { guildId: guild.id, staffRoleId: 'staff-role', botId: 'bot-id' });
  assert.equal(setupPreviewMatches(preview, current), false);
  await assert.rejects(applySetupManifest(guild, manifest, { staffRoleId: 'staff-role', botId: 'bot-id', expectedPreview: preview, logger: { info() {} } }), /berubah sejak preview/);
  assert.equal([...guild.all.values()].length, 2, 'no setup resources were created after the stale preview was rejected');
});

test('setup confirmation tokens are bound, expiring, and single use', () => {
  let now = 1000;
  const ids = ['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
  const store = createSetupConfirmationStore({ now: () => now, ttlMs: 60_000, createId: () => ids.shift() });
  const id = store.create({ guildId: 'guild', ownerId: 'user', templateId: 'small', preview: {}, staffRoleId: 'role-1' });
  assert.equal(store.get(id, 'other-guild', 'user'), null);
  assert.equal(store.get(id, 'guild', 'other-user'), null);
  assert.equal(store.claim(id, 'guild', 'user').templateId, 'small');
  assert.equal(store.get(id, 'guild', 'user').staffRoleId, 'role-1');
  assert.equal(store.claim(id, 'guild', 'user'), null);
  const expiring = store.create({ guildId: 'guild', ownerId: 'user', templateId: 'medium', preview: {} });
  now += 60_001;
  assert.equal(store.get(expiring, 'guild', 'user'), null);
});

test('setup confirmation atomically transitions pending to cancelled or claimed, never both', async () => {
  let sequence = 0;
  const makeStore = () => createSetupConfirmationStore({ createId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` });
  const cancelledStore = makeStore();
  const cancelledId = cancelledStore.create({ guildId: 'guild', ownerId: 'user', templateId: 'small', preview: {} });
  assert.equal(cancelledStore.cancel(cancelledId, 'guild', 'user'), 'cancelled-now');
  assert.equal(cancelledStore.get(cancelledId, 'guild', 'user').status, 'cancelled');
  assert.equal(cancelledStore.claim(cancelledId, 'guild', 'user'), null);

  const claimedStore = makeStore();
  const claimedId = claimedStore.create({ guildId: 'guild', ownerId: 'user', templateId: 'small', preview: {} });
  assert.equal(claimedStore.claim(claimedId, 'guild', 'user').status, 'claimed');
  assert.equal(claimedStore.cancel(claimedId, 'guild', 'user'), 'claimed');
  assert.equal(claimedStore.get(claimedId, 'guild', 'user').status, 'claimed');

  const closeStore = makeStore();
  const closeId = closeStore.create({ guildId: 'guild', ownerId: 'user', templateId: 'small', preview: {} });
  const [confirmAction, cancelAction] = await Promise.all([
    Promise.resolve().then(() => closeStore.claim(closeId, 'guild', 'user')),
    Promise.resolve().then(() => closeStore.cancel(closeId, 'guild', 'user'))
  ]);
  assert.equal(confirmAction.status, 'claimed');
  assert.equal(cancelAction, 'claimed');
  assert.equal(closeStore.get(closeId, 'guild', 'user').status, 'claimed');
});

test('setup confirmation retains the previewed fallback staff role if ticket config changes', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(source, /staffRoleId: configuredStaffRoleId/);
  const handlerStart = source.indexOf('async function handleSetupComponent');
  const handlerEnd = source.indexOf("client.on('interactionCreate'", handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);
  assert.match(handler, /const staffRoleId = claimed\.staffRoleId \|\| null/);
  assert.doesNotMatch(handler, /ticketStore\.configuration\(guild\.id\)/);

  const settings = { staffRoleId: 'role-before-preview' };
  const store = createSetupConfirmationStore({ createId: () => '33333333-3333-4333-8333-333333333333' });
  const previewRoleId = settings.staffRoleId;
  const id = store.create({ guildId: 'guild', ownerId: 'user', templateId: 'small', preview: {}, staffRoleId: previewRoleId });
  settings.staffRoleId = 'role-after-preview';
  const claimed = store.claim(id, 'guild', 'user');
  assert.equal(claimed.staffRoleId, 'role-before-preview');
  const guild = { id: 'guild', roles: { async fetch(roleId) { return roleId === 'role-before-preview' ? { id: roleId, managed: false, guild: { id: 'guild' } } : null; } } };
  assert.equal((await validateSetupStaffRole(guild, claimed.staffRoleId)).id, 'role-before-preview');
  await assert.rejects(validateSetupStaffRole(guild, settings.staffRoleId), /tidak tersedia atau tidak valid/);
});

test('server statistics use humans plus bots, count non-category channel types, and count fetched roles', () => {
  const result = calculateServerStats({
    members: [{ user: { bot: false } }, { user: { bot: true } }, { user: { bot: false } }],
    channels: [
      { type: ChannelType.GuildText }, { type: ChannelType.GuildVoice }, { type: ChannelType.GuildForum },
      { type: ChannelType.GuildAnnouncement }, { type: ChannelType.GuildStageVoice }, { type: ChannelType.GuildCategory }
    ],
    roles: new Map([['everyone', {}], ['member', {}], ['staff', {}]])
  });
  assert.equal(result['👥・all-members'], 3);
  assert.equal(result['👤・members'], 2);
  assert.equal(result['🤖・bots'], 1);
  assert.equal(result['👥・all-members'], result['👤・members'] + result['🤖・bots']);
  assert.equal(result['💬・channels'], 5);
  assert.equal(result['🎭・roles'], 3);
});

function statusGuild({ missing = [], renameFailure = null, renameFailureOnce = false, memberFailure = false } = {}) {
  let failedRename = false;
  const category = { id: 'stats', name: CATEGORY_NAMES[0], type: ChannelType.GuildCategory };
  const channels = [category, ...STATS_CHANNELS.filter(name => !missing.includes(name)).map((name, index) => ({
    id: `s${index}`, name: `${name}・0`, parentId: category.id, type: ChannelType.GuildText,
    async setName(next) { if (name === renameFailure && (!renameFailureOnce || !failedRename)) { failedRename = true; throw Object.assign(new Error('mock rate limit'), { code: 429 }); } this.name = next; }
  })), { id: 'voice', name: 'voice', type: ChannelType.GuildVoice }];
  return {
    name: 'mock-guild', id: 'guild-status', channels: { async fetch() { return channels; } },
    members: { async fetch() { if (memberFailure) throw new Error('mock members intent denied'); return [{ user: { bot: false } }, { user: { bot: true } }]; } },
    roles: { async fetch() { return new Map([['everyone', {}], ['member', {}]]); } },
    _channels: channels
  };
}

test('missing stat channel and one rename failure do not block the other four statistics', async () => {
  const guild = statusGuild({ missing: [STATS_CHANNELS[0]], renameFailure: STATS_CHANNELS[1] });
  const logs = [];
  const updater = createServerStatusUpdater({ client: { guilds: { cache: new Map([[guild.id, guild]]) } }, renameDelayMs: 0, logger: { log: line => logs.push(line), warn: line => logs.push(line), error: line => logs.push(line) } });
  await updater.update();
  assert.ok(logs.some(line => line.includes(`Channel tidak ditemukan: ${STATS_CHANNELS[0]}`)));
  assert.ok(logs.some(line => line.includes(`Gagal memperbarui channel: ${STATS_CHANNELS[1]}`) && line.includes('code=429')));
  for (const name of STATS_CHANNELS.slice(2)) assert.ok(guild._channels.some(channel => channel.name === `${name}・${name === STATS_CHANNELS[2] ? 1 : name === STATS_CHANNELS[3] ? 5 : 2}`), name);
});

test('failed counter rename attempts to replace an old count with an explicit unavailable marker', async () => {
  const guild = statusGuild({ renameFailure: STATS_CHANNELS[1], renameFailureOnce: true });
  const logs = [];
  const updater = createServerStatusUpdater({ client: { guilds: { cache: new Map([[guild.id, guild]]) } }, renameDelayMs: 0, logger: { log: line => logs.push(line), warn: line => logs.push(line), error: line => logs.push(line) } });
  await updater.update();
  assert.ok(guild._channels.some(channel => channel.name === STATS_CHANNELS[1] + '・unavailable'));
  assert.ok(logs.some(line => line.includes('Angka lama dihapus dari nama counter')));
});

test('member fetch failure leaves member statistics untouched but still refreshes channel and role counts', async () => {
  const guild = statusGuild({ memberFailure: true });
  const logs = [];
  const updater = createServerStatusUpdater({ client: { guilds: { cache: new Map([[guild.id, guild]]) } }, renameDelayMs: 0, logger: { log: line => logs.push(line), warn: line => logs.push(line), error: line => logs.push(line) } });
  await updater.update();
  assert.ok(logs.some(line => line.includes('statistik member tidak diubah')));
  assert.ok(guild._channels.some(channel => channel.name === `${STATS_CHANNELS[3]}・6`));
  assert.ok(guild._channels.some(channel => channel.name === `${STATS_CHANNELS[4]}・2`));
  assert.ok(guild._channels.some(channel => channel.name === `${STATS_CHANNELS[0]}・unavailable`));
});

test('status updater schedules one timer and prevents overlapping update cycles', async () => {
  let starts = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const guild = statusGuild();
  guild.channels.fetch = async () => { await gate; return guild._channels; };
  let intervalCallback, scheduledDelay;
  const updater = createServerStatusUpdater({
    client: { guilds: { cache: new Map([[guild.id, guild]]) } }, renameDelayMs: 0,
    setIntervalFn: (callback, delay) => { starts++; intervalCallback = callback; scheduledDelay = delay; return { unref() {} }; },
    clearIntervalFn() {}, logger: { log() {}, warn() {}, error() {} }
  });
  assert.equal(updater.start(), true);
  assert.equal(updater.start(), false);
  assert.equal(starts, 1);
  assert.equal(scheduledDelay, 5 * 60 * 1000);
  await Promise.resolve();
  const overlap = await updater.update();
  assert.equal(overlap.skipped, true);
  release();
  await new Promise(resolve => setImmediate(resolve));
  updater.stop();
  assert.equal(typeof intervalCallback, 'function');
});

test('Temporary Voice remains a single independent voiceStateUpdate system with exact trigger and guarded cleanup', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.equal((source.match(/client\.on\('voiceStateUpdate'/g) || []).length, 1);
  assert.match(source, /const TEMPVOICE_TRIGGER = '➕・create-voice'/);
  assert.match(source, /newState\.channel\.name === TEMPVOICE_TRIGGER/);
  assert.match(source, /temporaryVoiceService\.createRoom\(/);
  assert.match(source, /temporaryVoiceService\.cleanupEmptyRoom\(leftChannel\)/);
  const service = require('../temporary-voice');
  assert.equal(typeof service.createTemporaryVoiceService, 'function');
  assert.match(source, /channel\.name === '– – ~ 🔊 • \| VOICE LOUNGE \|'/);
});

test('setup acknowledges before reading an optional template and diagnoses the failing stage', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const start = source.indexOf("if (interaction.commandName !== 'setup') return;");
  const end = source.indexOf("} catch (error) {", start);
  const handler = source.slice(start, end);
  assert.ok(handler.indexOf('await interaction.deferReply') < handler.indexOf("getString('template', false)"));
  assert.match(handler, /getString\('template', false\)/);
  assert.match(handler, /belum memiliki opsi template/);
  assert.match(source, /\[SETUP\] Command gagal stage=\$\{setupStage\}[^`]*safeErrorDiagnostic\(error\)/);
  assert.match(source, /errorResponseAction\(interaction, diagnostic, error\)/);
});

test('slash setup exposes all templates and routes an owner-bound confirmation through permission preflight', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(source, /buildSetupCommand\(\)/);
  const setupSchema = require('../setup-command-schema').buildSetupCommand().toJSON();
  const templateOption = setupSchema.options.find(option => option.name === 'template');
  assert.equal(templateOption.type, 3);
  assert.equal(templateOption.required, true);
  assert.ok(templateOption.description);
  assert.deepEqual(templateOption.choices.map(choice => choice.value), ['large', 'medium', 'small']);
  assert.match(source, /setupConfirmationStore\.create\(\{ guildId: guild\.id, ownerId: interaction\.user\.id, templateId: manifest\.id/);
  assert.ok(setupSchema.options.some(option => option.name === 'staff_role' && option.type === 8 && option.required === false));
  assert.match(source, /staffRoleId: configuredStaffRoleId/);
  assert.match(source, /setupConfirmationStore\.claim\(id, interaction\.guildId, interaction\.user\.id\)/);
  const componentStart = source.indexOf('async function handleSetupComponent');
  const componentEnd = source.indexOf("client.on('interactionCreate'", componentStart);
  const componentHandler = source.slice(componentStart, componentEnd);
  assert.match(componentHandler, /cancellation === 'claimed'/);
  assert.match(componentHandler, /Setup sedang diproses dan tidak dapat dibatalkan lewat tombol/);
  assert.match(source, /validateSetupStaffRole\(guild, staffRoleId\)/);
  assert.match(source, /PermissionFlagsBits\.ManageChannels/);
  assert.match(source, /applySetupManifest\(guild, SETUP_MANIFESTS\[claimed\.templateId\]/);
  assert.match(source, /expectedPreview: claimed\.preview/);
  assert.match(source, /client\.once\('clientReady', \(\) => serverStatusUpdater\.start\(\)\)/);
});

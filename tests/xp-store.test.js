'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createXpStore, calculateProgress, xpRequiredForLevel, isEligibleMessage } = require('../xp-store');
const { renderRankCardSafely } = require('../rank-card');
const { grantMilestoneRoles } = require('../level-rewards');
const { buildLevelRolePanel, buildLevelRoleList } = require('../leveling-ui');
const { confirmServerReset, resetGuildAfterConfirmation } = require('../level-admin');
const { PermissionFlagsBits } = require('discord.js');

const GUILD_A = '10000000000000001';
const GUILD_B = '10000000000000002';
const USER_A = '20000000000000001';
const USER_B = '20000000000000002';
const CHANNEL_A = '30000000000000001';
const ROLE_A = '40000000000000001';
const ROLE_B = '40000000000000002';

function withStore(callback, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-xp-'));
  const file = path.join(directory, 'xp.json');
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    const result = callback(createXpStore(file, options), file);
    if (result && typeof result.then === 'function') return result.finally(cleanup);
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}

function message(guildId = GUILD_A, userId = USER_A, channelId = CHANNEL_A, extra = {}) {
  return {
    guild: { id: guildId },
    author: { id: userId, bot: false },
    channelId,
    content: 'A message worth XP',
    attachments: { size: 0 },
    ...extra
  };
}

test('XP increments with deterministic 15–25 range and the level progress formula is consistent', () => {
  withStore(store => {
    const result = store.awardMessage(message(), 1000);
    assert.equal(result.awarded, true);
    assert.equal(result.xpAdded, 20);
    assert.equal(result.stats.totalXp, 20);
    assert.deepEqual(calculateProgress(99), {
      totalXp: 99, level: 0, currentLevelXp: 99, xpToNextLevel: 100, nextLevelAt: 100, progress: 0.99
    });
    assert.equal(xpRequiredForLevel(1), 100);
    assert.equal(xpRequiredForLevel(2), 250);
    assert.equal(calculateProgress(100).level, 1);
    assert.equal(calculateProgress(249).currentLevelXp, 149);
    assert.equal(calculateProgress(250).level, 2);
  }, { randomXp: () => 20 });
});

test('cooldown is isolated per guild and member', () => {
  withStore(store => {
    assert.equal(store.awardMessage(message(GUILD_A, USER_A), 10000).awarded, true);
    assert.equal(store.awardMessage(message(GUILD_A, USER_A), 10001).reason, 'cooldown');
    assert.equal(store.awardMessage(message(GUILD_A, USER_B), 10001).awarded, true);
    assert.equal(store.awardMessage(message(GUILD_B, USER_A), 10001).awarded, true);
    assert.equal(store.awardMessage(message(GUILD_A, USER_A), 70000).awarded, true);
  }, { randomXp: () => 15, cooldownMs: 60_000 });
});

test('server/member data is isolated and survives reopening the JSON store', () => {
  withStore((store, file) => {
    store.awardMessage(message(GUILD_A, USER_A), 1000);
    store.awardMessage(message(GUILD_B, USER_A), 1000);
    store.awardMessage(message(GUILD_A, USER_B), 1000);
    const restarted = createXpStore(file, { randomXp: () => 20 });
    assert.equal(restarted.getStats(GUILD_A, USER_A).totalXp, 20);
    assert.equal(restarted.getStats(GUILD_B, USER_A).totalXp, 20);
    assert.equal(restarted.getStats(GUILD_A, USER_B).totalXp, 20);
    assert.equal(restarted.getStats(GUILD_B, USER_B).totalXp, 0);
  }, { randomXp: () => 20 });
});

test('sequential XP writes do not lose updates', () => {
  withStore(store => {
    for (let index = 0; index < 30; index++) {
      assert.equal(store.awardMessage(message(), 1000 + index).awarded, true);
    }
    assert.equal(store.getStats(GUILD_A, USER_A).totalXp, 600);
  }, { randomXp: () => 20, cooldownMs: 0 });
});

test('admin give-xp and remove-xp apply validated totals and clamp XP at zero', () => {
  withStore(store => {
    const given = store.giveXp(GUILD_A, USER_A, 320);
    assert.equal(given.applied, 320);
    assert.equal(given.stats.totalXp, 320);
    assert.equal(given.stats.level, 2);
    const removed = store.removeXp(GUILD_A, USER_A, 70);
    assert.equal(removed.applied, 70);
    assert.equal(removed.stats.totalXp, 250);
    assert.equal(removed.stats.level, 2);
    const clamped = store.removeXp(GUILD_A, USER_A, 1000);
    assert.equal(clamped.applied, 250);
    assert.equal(clamped.stats.totalXp, 0);
    assert.equal(clamped.stats.level, 0);
    assert.equal(store.getStats(GUILD_A, USER_A).totalXp, 0);
  });
});

test('admin give-level and remove-level set exact existing-formula thresholds', () => {
  withStore(store => {
    store.giveXp(GUILD_A, USER_A, 275);
    const given = store.giveLevels(GUILD_A, USER_A, 3);
    assert.equal(given.previousStats.level, 2);
    assert.equal(given.stats.level, 5);
    assert.equal(given.stats.totalXp, xpRequiredForLevel(5));
    const removed = store.removeLevels(GUILD_A, USER_A, 2);
    assert.equal(removed.stats.level, 3);
    assert.equal(removed.stats.totalXp, xpRequiredForLevel(3));
    const clamped = store.removeLevels(GUILD_A, USER_A, 500);
    assert.equal(clamped.stats.level, 0);
    assert.equal(clamped.stats.totalXp, xpRequiredForLevel(0));
    assert.equal(clamped.applied, 3);
  });
});

test('admin XP operations validate positive bounded integer amounts and valid IDs', () => {
  withStore(store => {
    for (const method of ['giveXp', 'removeXp', 'giveLevels', 'removeLevels']) {
      assert.throws(() => store[method](GUILD_A, USER_A, 0), /bilangan bulat positif/);
      assert.throws(() => store[method](GUILD_A, USER_A, 1.5), /bilangan bulat positif/);
      assert.throws(() => store[method](GUILD_A, USER_A, Number.MAX_SAFE_INTEGER), /bilangan bulat positif/);
      assert.throws(() => store[method](GUILD_A, 'bad-id', 1), /ID Discord/);
    }
    assert.throws(() => store.giveLevels(GUILD_A, USER_A, 501), /bilangan bulat positif/);
    store.giveLevels(GUILD_A, USER_A, 500);
    assert.equal(store.giveLevels(GUILD_A, USER_A, 1).stats.level, 501);
  });
});

test('admin XP persists after restart and remains isolated by guild', () => {
  withStore((store, file) => {
    store.giveXp(GUILD_A, USER_A, 140);
    store.giveLevels(GUILD_B, USER_A, 2);
    const restarted = createXpStore(file);
    assert.equal(restarted.getStats(GUILD_A, USER_A).totalXp, 140);
    assert.equal(restarted.getStats(GUILD_B, USER_A).totalXp, xpRequiredForLevel(2));
    assert.equal(restarted.getStats(GUILD_A, USER_B).totalXp, 0);
  });
});

test('concurrent admin updates do not lose XP and rank/leaderboard immediately reflect changes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-xp-admin-concurrent-'));
  try {
    const store = createXpStore(path.join(directory, 'xp.json'));
    await Promise.all(Array.from({ length: 25 }, () => Promise.resolve().then(() => store.giveXp(GUILD_A, USER_A, 40))));
    store.giveXp(GUILD_A, USER_B, 250);
    const stats = store.getStats(GUILD_A, USER_A);
    const leaderboard = store.getLeaderboard(GUILD_A);
    assert.equal(stats.totalXp, 1000);
    assert.equal(stats.level, calculateProgress(1000).level);
    assert.equal(store.getRank(GUILD_A, USER_A), 1);
    assert.equal(leaderboard.entries[0].userId, USER_A);
    assert.equal(leaderboard.entries[0].totalXp, stats.totalXp);
    const afterRemoval = store.removeXp(GUILD_A, USER_A, 900);
    assert.equal(store.getStats(GUILD_A, USER_A).totalXp, 100);
    assert.equal(store.getLeaderboard(GUILD_A).entries[0].totalXp, 250);
    assert.equal(afterRemoval.stats.totalXp, 100);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('bot, webhook, DM, system, and empty messages do not qualify for XP', () => {
  const good = message();
  assert.equal(isEligibleMessage(good), true);
  assert.equal(isEligibleMessage({ ...good, guild: null }), false);
  assert.equal(isEligibleMessage({ ...good, author: { ...good.author, bot: true } }), false);
  assert.equal(isEligibleMessage({ ...good, webhookId: 'webhook' }), false);
  assert.equal(isEligibleMessage({ ...good, system: true }), false);
  assert.equal(isEligibleMessage({ ...good, content: '  ' }), false);
  assert.equal(isEligibleMessage({ ...good, content: '', attachments: { size: 1 } }), true);
  withStore(store => {
    assert.equal(store.awardMessage({ ...good, author: { ...good.author, bot: true } }, 1000).reason, 'ineligible');
    assert.equal(store.awardMessage({ ...good, guild: null }, 1000).reason, 'ineligible');
    assert.equal(store.getStats(GUILD_A, USER_A).totalXp, 0);
  });
});

test('leaderboard is XP ordered with deterministic tie-breaking and pagination', () => {
  withStore(store => {
    store.awardMessage(message(GUILD_A, USER_A), 1000);
    store.awardMessage(message(GUILD_A, USER_B), 1000);
    const result = store.getLeaderboard(GUILD_A, 1, 1);
    assert.equal(result.total, 2);
    assert.equal(result.totalPages, 2);
    assert.equal(result.entries[0].userId, USER_A);
    assert.equal(result.entries[0].rank, 1);
    assert.equal(store.getLeaderboard(GUILD_A, 2, 1).entries[0].userId, USER_B);
    assert.equal(store.getRank(GUILD_A, USER_A), 1);
  }, { randomXp: () => 20 });
});

test('guild configuration and reward mappings validate and persist', () => {
  withStore(store => {
    store.setEnabled(GUILD_A, false);
    assert.equal(store.awardMessage(message(), 1000).reason, 'disabled');
    store.setEnabled(GUILD_A, true);
    store.setAnnouncement(GUILD_A, CHANNEL_A);
    store.updateExcludedChannel(GUILD_A, 'add', CHANNEL_A);
    store.addReward(GUILD_A, 5, ROLE_A);
    assert.throws(() => store.addReward(GUILD_A, 5, ROLE_B), /sudah memiliki/);
    assert.throws(() => store.addReward(GUILD_A, 6, ROLE_A), /sudah digunakan/);
    assert.throws(() => store.addReward(GUILD_A, -1, ROLE_B), /0–500/);
    store.addReward(GUILD_A, 0, ROLE_B);
    assert.throws(() => store.updateExcludedChannel(GUILD_A, 'add', CHANNEL_A), /sudah dikecualikan/);
    assert.throws(() => store.setEnabled(GUILD_A, 'false'), /true atau false/);
    assert.deepEqual(store.getConfig(GUILD_A), {
      enabled: true,
      announcement: { enabled: true, channelId: CHANNEL_A },
      excludedChannelIds: [CHANNEL_A],
      rewards: [{ level: 0, roleId: ROLE_B }, { level: 5, roleId: ROLE_A }],
      boosters: [],
      levelPanel: null
    });
    assert.equal(store.awardMessage(message(), 1000).reason, 'excluded-channel');
    store.setAnnouncement(GUILD_A, null);
    store.updateExcludedChannel(GUILD_A, 'remove', CHANNEL_A);
    store.removeReward(GUILD_A, 5);
    store.removeReward(GUILD_A, 0);
    assert.equal(store.getRewards(GUILD_A).length, 0);
  });
});

test('legacy XP JSON migrates in memory without losing XP or configuration', () => {
  withStore((_store, file) => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, guilds: {
      [GUILD_A]: { enabled: true, announcement: { enabled: true, channelId: null }, excludedChannelIds: [], rewards: [{ level: 4, roleId: ROLE_A }], members: { [USER_A]: { xp: 460, lastMessageAt: 1000 } } }
    } }));
    const migrated = createXpStore(file);
    assert.equal(migrated.getStats(GUILD_A, USER_A).totalXp, 460);
    assert.deepEqual(migrated.getConfig(GUILD_A).boosters, []);
    assert.equal(migrated.getConfig(GUILD_A).levelPanel, null);
    migrated.addBooster(GUILD_A, 'channel', CHANNEL_A, 1.5);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(persisted.guilds[GUILD_A].members[USER_A].xp, 460);
    assert.deepEqual(persisted.guilds[GUILD_A].boosters, [{ type: 'channel', targetId: CHANNEL_A, multiplier: 1.5 }]);
  });
});

test('admin set and reset operations use the level formula, preserve config, and isolate reset guilds', () => {
  withStore((store, file) => {
    store.addReward(GUILD_A, 8, ROLE_A);
    store.addBooster(GUILD_A, 'channel', CHANNEL_A, 2);
    store.setLevelPanel(GUILD_A, CHANNEL_A, '50000000000000001');
    store.setXp(GUILD_A, USER_A, 350);
    assert.equal(store.setLevel(GUILD_A, USER_A, 7).stats.totalXp, xpRequiredForLevel(7));
    assert.equal(store.setXp(GUILD_A, USER_A, 0).stats.level, 0);
    assert.throws(() => store.setXp(GUILD_A, USER_A, -1), /Total XP harus/);
    assert.throws(() => store.setLevel(GUILD_A, USER_A, 5001), /Level harus/);
    assert.equal(store.setLevel(GUILD_A, USER_A, 5000).stats.totalXp, xpRequiredForLevel(5000));
    store.giveXp(GUILD_A, USER_A, 500);
    store.giveXp(GUILD_B, USER_A, 800);
    const removed = store.resetMember(GUILD_A, USER_A);
    assert.equal(removed.removed, true);
    assert.equal(store.getStats(GUILD_A, USER_A).totalXp, 0);
    assert.equal(store.getStats(GUILD_B, USER_A).totalXp, 800);
    store.giveXp(GUILD_A, USER_A, 100);
    const reset = store.resetGuild(GUILD_A);
    assert.equal(reset.members, 1);
    assert.equal(store.getStats(GUILD_A, USER_A).totalXp, 0);
    assert.equal(store.getStats(GUILD_B, USER_A).totalXp, 800);
    assert.equal(store.getRewards(GUILD_A)[0].roleId, ROLE_A);
    assert.equal(store.getConfig(GUILD_A).boosters[0].multiplier, 2);
    assert.deepEqual(store.getConfig(GUILD_A).levelPanel, { channelId: CHANNEL_A, messageId: '50000000000000001' });
    assert.equal(createXpStore(file).getStats(GUILD_A, USER_A).totalXp, 0);
  });
});

test('role and channel XP boosters use the highest match, round once, and dedupe a message ID', () => {
  let baseXp = 20;
  withStore(store => {
    store.addBooster(GUILD_A, 'role', ROLE_A, 2);
    store.addBooster(GUILD_A, 'channel', CHANNEL_A, 1.1);
    assert.throws(() => store.addBooster(GUILD_A, 'role', ROLE_A, 3), /sudah ada/);
    assert.throws(() => store.addBooster(GUILD_A, 'role', ROLE_B, 5.01), /Multiplier/);
    assert.throws(() => store.addBooster(GUILD_A, 'role', 'bad', 2), /ID Discord/);
    const boosted = store.awardMessage(message(GUILD_A, USER_A, CHANNEL_A, {
      id: '60000000000000001', member: { roles: { cache: new Map([[ROLE_A, {}]]) } }
    }), 1000);
    assert.equal(boosted.baseXp, 20);
    assert.equal(boosted.multiplier, 2);
    assert.equal(boosted.xpAdded, 40);
    assert.equal(store.awardMessage(message(GUILD_A, USER_A, CHANNEL_A, {
      id: '60000000000000001', member: { roles: { cache: new Map([[ROLE_A, {}]]) } }
    }), 70000).reason, 'duplicate');
    store.removeBooster(GUILD_A, 'role', ROLE_A);
    const channelOnly = store.awardMessage(message(GUILD_A, USER_A, CHANNEL_A, { id: '60000000000000002' }), 70000);
    assert.equal(channelOnly.multiplier, 1.1);
    assert.equal(channelOnly.xpAdded, 22);
    store.removeBooster(GUILD_A, 'channel', CHANNEL_A);
    store.addBooster(GUILD_A, 'channel', CHANNEL_A, 1.1);
    baseXp = 15;
    const fractional = store.awardMessage(message(GUILD_A, USER_B, CHANNEL_A, { id: '60000000000000003' }), 1000);
    assert.equal(fractional.xpAdded, 17, '15 × 1.1 rounds to nearest XP');
    assert.equal(store.getConfig(GUILD_A).boosters.length, 1);
  }, { randomXp: () => baseXp });
});

test('excluded, bot, DM, webhook, and duplicate messages never produce duplicate XP', () => {
  withStore(store => {
    store.updateExcludedChannel(GUILD_A, 'add', CHANNEL_A);
    const ignored = store.awardMessage(message(GUILD_A, USER_A, CHANNEL_A, { id: '70000000000000001' }), 1000);
    assert.equal(ignored.reason, 'excluded-channel');
    assert.equal(store.awardMessage(message(GUILD_A, USER_A, CHANNEL_A, { id: '70000000000000001' }), 70000).reason, 'duplicate');
    assert.equal(store.awardMessage(message(GUILD_A, USER_A, CHANNEL_A, { id: '70000000000000002', webhookId: 'hook' }), 70000).reason, 'ineligible');
    assert.equal(store.getStats(GUILD_A, USER_A).totalXp, 0);
  }, { randomXp: () => 20 });
});

test('milestone roles stack across level jumps and skip existing, deleted, and unmanageable roles', async () => {
  const assigned = [];
  const owned = new Map([[ROLE_A, {}], ['49999999999999999', {}]]);
  const roleData = new Map([
    [ROLE_A, { id: ROLE_A, guild: { id: GUILD_A }, position: 1, editable: true, managed: false }],
    [ROLE_B, { id: ROLE_B, guild: { id: GUILD_A }, position: 2, editable: true, managed: false }],
    ['40000000000000003', { id: '40000000000000003', guild: { id: GUILD_A }, position: 101, editable: false, managed: false }]
  ]);
  const member = { id: USER_A, roles: { cache: owned, add: async role => { assigned.push(role.id); owned.set(role.id, role); } } };
  const botMember = { permissions: { has: value => value === PermissionFlagsBits.ManageRoles }, roles: { highest: { position: 100 } } };
  const guild = { id: GUILD_A, members: { me: botMember }, roles: { fetch: async roleId => roleData.get(roleId) || null } };
  const rewards = [
    { level: 5, roleId: ROLE_A },
    { level: 10, roleId: ROLE_B },
    { level: 11, roleId: '40000000000000003' },
    { level: 12, roleId: '40000000000000004' }
  ];
  const first = await grantMilestoneRoles(guild, member, rewards, 4, 12, {
    manageRolesPermission: PermissionFlagsBits.ManageRoles, logger: { warn() {} }
  });
  assert.deepEqual(assigned, [ROLE_B]);
  assert.ok(owned.has(ROLE_A), 'existing milestone role remains');
  assert.ok(owned.has('49999999999999999'), 'non-milestone role remains');
  assert.equal(first.skipped.find(item => item.level === 11).reason, 'role-not-manageable');
  assert.equal(first.skipped.find(item => item.level === 12).reason, 'role-missing');
  const second = await grantMilestoneRoles(guild, member, rewards, 4, 12, {
    manageRolesPermission: PermissionFlagsBits.ManageRoles, logger: { warn() {} }
  });
  assert.deepEqual(assigned, [ROLE_B], 'owned milestone is never granted a second time');
  assert.equal(second.skipped.find(item => item.roleId === ROLE_B).reason, 'already-owned');
});

test('level-zero reward is deferred until a member receives XP, not mass-granted', () => {
  withStore(store => {
    store.addReward(GUILD_A, 0, ROLE_A);
    const newMember = store.awardMessage(message(GUILD_A, USER_A, CHANNEL_A, { id: '80000000000000001' }), 1000);
    assert.equal(newMember.rewardFromLevel, -1);
    assert.equal(newMember.level, 0);
    assert.equal(store.getStats(GUILD_A, USER_B).totalXp, 0);
  }, { randomXp: () => 15 });
});

test('level-zero reward waits for the next XP event for active level-zero members', () => {
  withStore(store => {
    store.giveXp(GUILD_A, USER_A, 20);
    store.addReward(GUILD_A, 0, ROLE_A);
    const result = store.awardMessage(message(GUILD_A, USER_A, CHANNEL_A, { id: '80000000000000002' }), 70000);
    assert.equal(result.previousLevel, 0);
    assert.equal(result.level, 0);
    assert.equal(result.rewardFromLevel, -1);
  }, { randomXp: () => 15 });
});

test('admin increases report crossed milestones while reductions and reward removal never revoke roles', async () => {
  withStore(async store => {
    store.addReward(GUILD_A, 1, ROLE_A);
    store.addReward(GUILD_A, 2, ROLE_B);
    const change = store.giveLevels(GUILD_A, USER_A, 2);
    assert.equal(change.rewardFromLevel, -1);
    assert.equal(change.stats.level, 2);
    const assigned = [];
    const botMember = { permissions: { has: () => true }, roles: { highest: { position: 100 } } };
    const roles = new Map([ROLE_A, ROLE_B].map((id, index) => [id, { id, guild: { id: GUILD_A }, position: index + 1, editable: true, managed: false }]));
    const memberRoles = new Map();
    const member = { id: USER_A, roles: { cache: memberRoles, add: async role => { assigned.push(role.id); memberRoles.set(role.id, role); } } };
    await grantMilestoneRoles({ id: GUILD_A, members: { me: botMember }, roles: { fetch: async id => roles.get(id) } }, member, store.getRewards(GUILD_A), change.rewardFromLevel, change.stats.level, { manageRolesPermission: PermissionFlagsBits.ManageRoles, logger: { warn() {} } });
    assert.deepEqual(assigned, [ROLE_A, ROLE_B]);
    store.removeReward(GUILD_A, 1);
    assert.equal(memberRoles.has(ROLE_A), true, 'removing a reward mapping never removes a member role');
    store.removeLevels(GUILD_A, USER_A, 2);
    assert.equal(memberRoles.has(ROLE_A), true);
    assert.equal(memberRoles.has(ROLE_B), true);
  });
});

test('role reward API and permission failures do not alter persisted XP', async () => {
  withStore(async store => {
    store.addReward(GUILD_A, 1, ROLE_A);
    const change = store.giveXp(GUILD_A, USER_A, 100);
    const member = { id: USER_A, roles: { cache: new Map(), add: async () => { throw new Error('API unavailable'); } } };
    const rewards = store.getRewards(GUILD_A);
    const missingPermission = await grantMilestoneRoles({ id: GUILD_A, members: { me: { permissions: { has: () => false }, roles: { highest: { position: 10 } } } } }, member, rewards, change.rewardFromLevel, change.stats.level, { manageRolesPermission: PermissionFlagsBits.ManageRoles, logger: { warn() {} } });
    assert.equal(missingPermission.skipped[0].reason, 'missing-permission');
    const apiFailure = await grantMilestoneRoles({ id: GUILD_A, members: { me: { permissions: { has: () => true }, roles: { highest: { position: 10 } } } }, roles: { fetch: async () => ({ id: ROLE_A, guild: { id: GUILD_A }, position: 1, editable: true, managed: false }) } }, member, rewards, change.rewardFromLevel, change.stats.level, { manageRolesPermission: PermissionFlagsBits.ManageRoles, logger: { warn() {} } });
    assert.equal(apiFailure.skipped[0].reason, 'api-error');
    assert.equal(store.getStats(GUILD_A, USER_A).totalXp, 100);
  });
});

test('milestone panel sorts rewards, marks deleted roles, and handles empty and bounded data', () => {
  const rewards = Array.from({ length: 30 }, (_, index) => ({ level: 30 - index, roleId: `${String(90000000000000000 + index)}` }));
  const panel = buildLevelRolePanel(rewards, id => id === '90000000000000029' ? { id } : null);
  assert.equal(panel.title, 'Nightmare • Level Roles');
  assert.match(panel.description, /Level 1/);
  assert.ok(panel.description.length <= 4000);
  const rows = buildLevelRoleList(rewards, () => null);
  assert.equal(rows.length, 25);
  assert.equal(rows[0].startsWith('**Level 1**'), true);
  assert.equal(rows[0].startsWith('**Level 1**'), true);
  assert.match(buildLevelRolePanel([], () => null).description, /Belum ada milestone/);
});

test('server reset route needs same-admin confirmation and only resets selected guild stats', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-xp-confirm-reset-'));
  try {
    const store = createXpStore(path.join(directory, 'xp.json'));
    store.giveXp(GUILD_A, USER_A, 500);
    store.giveXp(GUILD_B, USER_A, 900);
    let edits = 0;
    const adminId = USER_B;
    const validAdmin = {
      user: { id: adminId }, guildId: GUILD_A,
      customId: `xp-reset:confirm:${GUILD_A}:${adminId}`,
      memberPermissions: { has: value => value === PermissionFlagsBits.Administrator },
      deferUpdate: async () => {}
    };
    const wrongAdmin = { ...validAdmin, user: { id: USER_A } };
    const wrongGuild = { ...validAdmin, guildId: GUILD_B };
    const interaction = {
      guildId: GUILD_A, user: { id: adminId },
      memberPermissions: { has: value => value === PermissionFlagsBits.Administrator },
      editReply: async () => { edits++; },
      fetchReply: async () => ({ awaitMessageComponent: async ({ filter }) => {
        assert.equal(filter(wrongAdmin), false);
        assert.equal(filter(wrongGuild), false);
        assert.equal(filter(validAdmin), true);
        return validAdmin;
      } })
    };
    const result = await resetGuildAfterConfirmation(interaction, store);
    assert.equal(result.confirmed, true);
    assert.equal(result.members, 1);
    assert.equal(store.getStats(GUILD_A, USER_A).totalXp, 0);
    assert.equal(store.getStats(GUILD_B, USER_A).totalXp, 900);
    assert.ok(edits >= 1);

    const unconfirmed = await resetGuildAfterConfirmation({
      ...interaction,
      fetchReply: async () => ({ awaitMessageComponent: async () => { throw new Error('timeout'); } })
    }, store);
    assert.equal(unconfirmed.confirmed, false);
    assert.equal(store.getStats(GUILD_B, USER_A).totalXp, 900);
    await assert.rejects(resetGuildAfterConfirmation({
      ...interaction, memberPermissions: { has: () => false }
    }, store), /administrator di server/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('corrupt XP JSON is reported and never overwritten silently', () => {
  withStore((_store, file) => {
    fs.writeFileSync(file, '{broken json');
    const before = fs.readFileSync(file, 'utf8');
    const brokenStore = createXpStore(file);
    assert.throws(() => brokenStore.awardMessage(message(), 1000), /rusak; file tidak ditimpa/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
});

test('rank card falls back when avatar fetch fails and contains rendering failures', async () => {
  const stats = calculateProgress(125);
  const fallback = await renderRankCardSafely({
    username: 'Nightmare Member',
    avatarUrl: 'https://cdn.discordapp.com/avatars/example.png',
    stats,
    rank: 1
  }, { fetchAvatar: async () => { throw new Error('mock avatar failure'); } });
  assert.equal(fallback.error, null);
  assert.ok(Buffer.isBuffer(fallback.buffer));
  assert.deepEqual([...fallback.buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

  const failed = await renderRankCardSafely({ username: 'Member', stats, rank: null }, {
    canvas: { createCanvas() { throw new Error('mock renderer failure'); } }
  });
  assert.equal(failed.buffer, null);
  assert.match(failed.error.message, /mock renderer failure/);
});

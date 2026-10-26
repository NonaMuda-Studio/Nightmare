'use strict';

const roleMutationLocks = new Map();

function serializeForMember(key, operation) {
  const previous = roleMutationLocks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  roleMutationLocks.set(key, current);
  return current.finally(() => {
    if (roleMutationLocks.get(key) === current) roleMutationLocks.delete(key);
  });
}

async function grantMilestoneRoles(guild, member, rewards, fromLevel, toLevel, options = {}) {
  const logger = options.logger || console;
  const eligible = rewards
    .filter(item => item.level > fromLevel && item.level <= toLevel)
    .sort((a, b) => a.level - b.level);
  if (!eligible.length) return { granted: [], skipped: [] };

  const key = `${guild.id}:${member.id}`;
  return serializeForMember(key, async () => {
    let botMember;
    try { botMember = guild.members.me || await guild.members.fetchMe(); }
    catch (error) {
      logger.warn(`[XP] Tidak dapat memeriksa role reward guild=${guild.id}: ${error.message}`);
      return { granted: [], skipped: eligible.map(item => ({ ...item, reason: 'bot-member-unavailable' })) };
    }
    if (!botMember.permissions.has(options.manageRolesPermission)) {
      logger.warn(`[XP] Reward dilewati: bot tidak memiliki Manage Roles guild=${guild.id} user=${member.id}`);
      return { granted: [], skipped: eligible.map(item => ({ ...item, reason: 'missing-permission' })) };
    }

    let currentMember = member;
    if (typeof guild.members.fetch === 'function') {
      try { currentMember = await guild.members.fetch(member.id); }
      catch (error) {
        logger.warn(`[XP] Gagal memuat role member guild=${guild.id} user=${member.id}: ${error.message}`);
        return { granted: [], skipped: eligible.map(item => ({ ...item, reason: 'member-unavailable' })) };
      }
    }
    const granted = [];
    const skipped = [];
    const owned = new Set(currentMember.roles?.cache?.keys ? currentMember.roles.cache.keys() : []);
    for (const reward of eligible) {
      try {
        const role = await guild.roles.fetch(reward.roleId);
        if (!role) {
          skipped.push({ ...reward, reason: 'role-missing' });
          logger.warn(`[XP] Role reward sudah dihapus guild=${guild.id} role=${reward.roleId}`);
          continue;
        }
        if (role.guild?.id !== guild.id || role.id === guild.id || role.managed || !role.editable ||
            role.position >= botMember.roles.highest.position) {
          skipped.push({ ...reward, reason: 'role-not-manageable' });
          logger.warn(`[XP] Role reward di luar hierarki bot guild=${guild.id} role=${role.id}`);
          continue;
        }
        if (owned.has(role.id)) {
          skipped.push({ ...reward, reason: 'already-owned' });
          continue;
        }
        await currentMember.roles.add(role, `Nightmare level reward level=${reward.level}`);
        owned.add(role.id);
        granted.push({ ...reward, roleId: role.id });
      } catch (error) {
        skipped.push({ ...reward, reason: 'api-error' });
        logger.warn(`[XP] Gagal memberi role reward guild=${guild.id} user=${member.id} role=${reward.roleId}: ${error.message}`);
      }
    }
    return { granted, skipped };
  });
}

module.exports = { grantMilestoneRoles };

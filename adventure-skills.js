'use strict';

// Costs and effects are deliberately small and use the existing combat stats.
const SKILLS = Object.freeze([
  { id: 'weapon_mastery', name: 'Weapon Mastery', type: 'passive', maxLevel: 3, cost: 1, rank: 'F', requires: null, description: '+2 ATK per level.', effect: { attack: 2 } },
  { id: 'vitality', name: 'Vitality', type: 'passive', maxLevel: 3, cost: 1, rank: 'F', requires: null, description: '+10 max HP per level.', effect: { maxHp: 10 } },
  { id: 'iron_guard', name: 'Iron Guard', type: 'passive', maxLevel: 3, cost: 1, rank: 'F', requires: null, description: 'Reduce incoming damage by 1 per level.', effect: { mitigation: 1 } },
  { id: 'critical_eye', name: 'Critical Eye', type: 'passive', maxLevel: 3, cost: 1, rank: 'E', requires: 'weapon_mastery:1', description: '+5 percentage points critical chance per level (1.5× damage).', effect: { critChance: 0.05 } },
  { id: 'arcane_slash', name: 'Arcane Slash', type: 'active', maxLevel: 3, cost: 1, rank: 'F', requires: null, description: 'Deal 1.5× ATK, +0.25× per level.', effect: { multiplier: 1.5, perLevel: 0.25 } },
  { id: 'flame_burst', name: 'Flame Burst', type: 'active', maxLevel: 3, cost: 2, rank: 'D', requires: 'arcane_slash:1', description: 'Deal 1.8× ATK plus 4 damage per level.', effect: { multiplier: 1.8, flatPerLevel: 4 } },
  { id: 'crescent_nova', name: 'Crescent Nova', type: 'ultimate', maxLevel: 1, cost: 3, rank: 'B', requires: 'flame_burst:2', description: 'Once per hunt, deal 3× ATK as an ultimate strike.', effect: { multiplier: 3, uses: 1 } }
].map(skill => Object.freeze({ ...skill, effect: Object.freeze(skill.effect) })));
const BY_ID = new Map(SKILLS.map(skill => [skill.id, skill]));
function getSkill(id) { return BY_ID.get(String(id || '')) || null; }
function parseRequirement(requirement) { if (!requirement) return null; const [id, level] = requirement.split(':'); return { id, level: Number(level) }; }
module.exports = { SKILLS, getSkill, parseRequirement };

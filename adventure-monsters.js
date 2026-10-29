'use strict';

// Encounter records moved verbatim from the existing Adventure hunt service.
const MONSTERS = Object.freeze([
  Object.freeze({ id: 'slime', name: 'Slime', hp: 24, attack: 7, defense: 1, exp: 18, coins: 12, loot: 'slime_gel' }),
  Object.freeze({ id: 'goblin', name: 'Goblin', hp: 38, attack: 10, defense: 3, exp: 30, coins: 20, loot: 'monster_fang' }),
  Object.freeze({ id: 'dire_wolf', name: 'Dire Wolf', hp: 54, attack: 13, defense: 4, exp: 44, coins: 30, loot: 'herb' })
]);
const BY_ID = new Map(MONSTERS.map(monster => [monster.id, monster]));
function getMonster(id) { return BY_ID.get(String(id || '')) || null; }

module.exports = { MONSTERS, getMonster };

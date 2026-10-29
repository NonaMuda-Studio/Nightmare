'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const SETUP_TEMPLATE_CHOICES = Object.freeze([
  Object.freeze({ name: 'Large Community', value: 'large' }),
  Object.freeze({ name: 'Medium Community', value: 'medium' }),
  Object.freeze({ name: 'Small Community', value: 'small' })
]);

function buildSetupCommand() {
  return new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Pratinjau dan siapkan struktur server Nightmare')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption(option => option
      .setName('template')
      .setDescription('Pilih ukuran komunitas: Large, Medium, atau Small.')
      .addChoices(...SETUP_TEMPLATE_CHOICES)
      .setRequired(true))
    .addRoleOption(option => option
      .setName('staff_role')
      .setDescription('Role yang memperoleh akses kategori MOD & STAFF dan LOGS')
      .setRequired(false));
}

function validateSetupCommandSchema(command) {
  const errors = [];
  if (!command || command.name !== 'setup') errors.push('Nama command harus setup.');
  if (typeof command?.description !== 'string' || !command.description.trim()) errors.push('Deskripsi command wajib diisi.');
  const options = Array.isArray(command?.options) ? command.options : [];
  const template = options.find(option => option.name === 'template');
  if (!template || template.type !== 3 || template.required !== true || typeof template.description !== 'string' || !template.description.trim()) {
    errors.push('Opsi template harus string, required, dan memiliki deskripsi.');
  }
  const expected = SETUP_TEMPLATE_CHOICES.map(choice => ({ name: choice.name, value: choice.value }));
  const actual = (template?.choices || []).map(({ name, value }) => ({ name, value }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push('Pilihan template harus Large, Medium, dan Small Community dengan value large, medium, dan small.');
  const staffRole = options.find(option => option.name === 'staff_role');
  if (!staffRole || staffRole.type !== 8 || staffRole.required !== false) errors.push('Opsi staff_role harus role opsional.');
  if (errors.length) throw new Error(`Schema /setup tidak valid: ${errors.join(' ')}`);
  return command;
}

module.exports = { SETUP_TEMPLATE_CHOICES, buildSetupCommand, validateSetupCommandSchema };

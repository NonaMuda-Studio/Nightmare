'use strict';

const { randomInt } = require('node:crypto');
const { MessageFlags } = require('discord.js');

const GAME_TTL_MS = 5 * 60_000;
const QUESTIONS = Object.freeze([
  { question: 'Apa ibu kota Jepang?', choices: ['Seoul', 'Tokyo', 'Kyoto', 'Osaka'], answer: 2 },
  { question: 'Planet terbesar di Tata Surya?', choices: ['Mars', 'Bumi', 'Jupiter', 'Venus'], answer: 3 },
  { question: 'Berapa sisi pada segi enam?', choices: ['5', '6', '7', '8'], answer: 2 },
  { question: 'Bahasa yang digunakan untuk styling web?', choices: ['HTML', 'CSS', 'SQL', 'Bash'], answer: 2 }
]);

function createPlaygroundService(economy, { now = Date.now, random = randomInt } = {}) {
  function start(guildId, userId, interactionId, type, stake, payload) {
    const started = economy.startGame({ guildId, userId, gameId: interactionId, type, entryFee: stake, payload, expiresAt: now() + GAME_TTL_MS });
    return { id: interactionId, balance: started.balance, expiresAt: started.game.expiresAt, payload: started.game.payload };
  }
  return {
    startGuess(guildId, userId, interactionId, stake = 0) {
      return start(guildId, userId, interactionId, 'guess', stake, { target: random(1, 11), attemptsLeft: 3 });
    },
    guess(guildId, userId, gameId, interactionId, value) {
      if (!Number.isInteger(value) || value < 1 || value > 10) throw new Error('Tebakan harus bilangan bulat 1–10.');
      return economy.actGame({ guildId, userId, gameId, actionId: interactionId, apply(game) {
        if (game.type !== 'guess') throw new Error('ID ini bukan game tebak angka.');
        const correct = value === game.payload.target;
        const attemptsLeft = correct ? game.payload.attemptsLeft : game.payload.attemptsLeft - 1;
        const done = correct || attemptsLeft <= 0;
        return {
          game: { ...game, payload: { ...game.payload, attemptsLeft } }, done,
          outcome: correct ? 'won' : 'lost', payout: correct ? 15 + game.entryFee * 2 : 0,
          response: correct ? `Tebakan tepat! Angkanya **${game.payload.target}**.` : done ? `Kesempatan habis. Angkanya **${game.payload.target}**.` : `Belum tepat. Sisa kesempatan: **${attemptsLeft}**.`
        };
      } });
    },
    startTrivia(guildId, userId, interactionId, stake = 0) {
      const question = QUESTIONS[random(QUESTIONS.length)];
      const started = start(guildId, userId, interactionId, 'trivia', stake, { question: question.question, choices: question.choices, answer: question.answer });
      return { ...started, question: question.question, choices: [...question.choices] };
    },
    answerTrivia(guildId, userId, gameId, interactionId, answer) {
      if (!Number.isInteger(answer) || answer < 1 || answer > 4) throw new Error('Jawaban harus nomor 1–4.');
      return economy.actGame({ guildId, userId, gameId, actionId: interactionId, apply(game) {
        if (game.type !== 'trivia') throw new Error('ID ini bukan game trivia.');
        const correct = answer === game.payload.answer;
        return { game, done: true, outcome: correct ? 'won' : 'lost', payout: correct ? 30 + game.entryFee * 2 : 0, response: correct ? 'Jawaban benar!' : `Jawaban belum tepat. Jawaban: **${game.payload.answer}. ${game.payload.choices[game.payload.answer - 1]}**.` };
      } });
    },
    flip(guildId, userId, interactionId, choice, stake) {
      if (!['heads', 'tails'].includes(choice)) throw new Error('Pilih heads atau tails.');
      if (!Number.isInteger(stake) || stake < 1 || stake > 100) throw new Error('Taruhan coin flip harus 1–100 koin.');
      const result = random(2) === 0 ? 'heads' : 'tails';
      start(guildId, userId, interactionId, 'flip', stake, { choice, result });
      return economy.actGame({ guildId, userId, gameId: interactionId, actionId: interactionId, apply(game) {
        const won = game.payload.choice === game.payload.result;
        return { game, done: true, outcome: won ? 'won' : 'lost', payout: won ? stake * 2 : 0, response: won ? `Menang! Hasil coin flip **${result}**.` : `Kalah. Hasil coin flip **${result}**.` };
      } });
    }
  };
}

function describeResult(result) {
  if (!result || result.reason === 'missing') return 'Game tidak ditemukan atau interaksi sudah kedaluwarsa.';
  if (result.reason === 'owner') return 'Game ini dibuat oleh member lain.';
  if (result.reason === 'duplicate') return 'Interaksi ini sudah diproses; hadiah tidak dibayar dua kali.';
  if (result.reason === 'ended') return 'Game ini sudah berakhir.';
  if (result.reason === 'expired') return 'Game kedaluwarsa. Buat game baru untuk bermain lagi.';
  return `${result.response || 'Game selesai.'}${result.done ? `\n${result.payout ? `Hadiah: **${result.payout} coin**.` : 'Tidak ada hadiah kali ini.'} Saldo: **${result.balance} coin**.` : ''}`;
}

async function handlePlaygroundCommand(interaction, service) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (!interaction.inGuild() || !interaction.guildId) throw new Error('Playground hanya tersedia di server.');
    const action = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    if (action === 'guess-start') {
      const game = service.startGuess(interaction.guildId, userId, interaction.id, interaction.options.getInteger('stake') || 0);
      return interaction.editReply(`🎯 Game tebak angka dibuat. Tebak 1–10 dalam 3 kesempatan dengan /playground guess; game ID: ${game.id}. Entry fee: ${interaction.options.getInteger('stake') || 0}; saldo: ${game.balance}. Berlaku 5 menit.`);
    }
    if (action === 'guess') {
      const result = service.guess(interaction.guildId, userId, interaction.options.getString('game_id', true), interaction.id, interaction.options.getInteger('number', true));
      return interaction.editReply(describeResult(result));
    }
    if (action === 'trivia-start') {
      const game = service.startTrivia(interaction.guildId, userId, interaction.id, interaction.options.getInteger('stake') || 0);
      return interaction.editReply(`🧠 **${game.question}**\n${game.choices.map((choice, i) => `${i + 1}. ${choice}`).join('\n')}\n\nJawab dengan /playground answer; game ID: ${game.id}. Entry fee: ${interaction.options.getInteger('stake') || 0}; berlaku 5 menit.`);
    }
    if (action === 'answer') {
      const result = service.answerTrivia(interaction.guildId, userId, interaction.options.getString('game_id', true), interaction.id, interaction.options.getInteger('choice', true));
      return interaction.editReply(describeResult(result));
    }
    if (action === 'flip') {
      const result = service.flip(interaction.guildId, userId, interaction.id, interaction.options.getString('choice', true), interaction.options.getInteger('stake', true));
      return interaction.editReply(describeResult(result));
    }
    throw new Error('Game tidak dikenal.');
  } catch (error) {
    console.warn(`[PLAYGROUND] ${interaction.guildId || 'DM'} ${interaction.user?.id || 'unknown'}: ${error.message}`);
    if (/Insufficient balance/.test(error.message)) return interaction.editReply('❌ Saldo coin tidak cukup untuk entry fee/taruhan.');
    if (/Game cooldown active/.test(error.message)) return interaction.editReply(`⏳ ${error.message.replace('Game cooldown active; retry after ', 'Tunggu ').replace(' seconds.', ' detik sebelum memulai game lain.')}`);
    return interaction.editReply(`❌ ${error.message}`);
  }
}

module.exports = { createPlaygroundService, handlePlaygroundCommand, describeResult, GAME_TTL_MS };

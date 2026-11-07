// game.js — pure game + money logic for the 24/7 spin-the-wheel game.
// Money is integer cents everywhere (no float dollars). No I/O here, so it
// can be unit-tested directly with node.
const crypto = require('node:crypto');

const SEGMENTS = 101; // numbers 0..100
const NEON_COLORS = ['#22d3ee', '#8b5cf6', '#ec4899', '#3b82f6', '#14b8a6', '#f59e0b', '#6366f1', '#d946ef'];

// ---- money model (locked in Nov 6, 2026) ---------------------------------
const SINGLE_PRICE_CENTS = 500;      // $5 per play
const BUNDLE_PRICE_CENTS = 10000;    // $100 bundle
const BUNDLE_PAID_PLAYS = 20;        // bundle includes 20 paid plays...
const BUNDLE_BONUS_PLAYS = 2;        // ...+ 2 bonus plays free (22 total)
const HOUSE_PCT = 20;                // of each paid play: 20% house (Will)
const WINNER_PCT = 70;               // 70% to the round winner
const JACKPOT_PCT = 10;              // 10% into the rollover jackpot
const REFERRAL_BONUS_PLAYS = 1;      // referrer earns 1 free play per friend who pays
const ROUND_WIN_BONUS_POINTS = 0;    // no points anymore — winners are paid in dollars

// Split of one paid play (500c): house 100c, winner 350c, jackpot 50c. Exact.
function splitPaidPlay(cents = SINGLE_PRICE_CENTS) {
  return {
    house: Math.round((cents * HOUSE_PCT) / 100),
    winner: Math.round((cents * WINNER_PCT) / 100),
    jackpot: Math.round((cents * JACKPOT_PCT) / 100),
  };
}

// Split of a whole round's paid pot.
function splitPot(paidPlays) {
  const pot = paidPlays * SINGLE_PRICE_CENTS;
  const s = splitPaidPlay(SINGLE_PRICE_CENTS);
  return {
    pot,
    paidPlays,
    house: s.house * paidPlays,
    winner: s.winner * paidPlays,
    jackpot: s.jackpot * paidPlays,
  };
}

function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// ---- round timing -------------------------------------------------------
// Rounds are 5 minutes, aligned to the America/New_York clock: a round
// ends at :00, :05, :10, … :55 ET and the next one opens immediately.
// ROUND_MINUTES env overrides the length (used for local testing only);
// with an override, rounds are fixed-length from their start time.
const ROUND_INTERVAL_MS = 5 * 60 * 1000;

function roundLengthMs() {
  const m = parseInt(process.env.ROUND_MINUTES || '', 10);
  return Number.isFinite(m) && m > 0 ? m * 60 * 1000 : ROUND_INTERVAL_MS;
}

// Offset (ms) between UTC and America/New_York wall time at a given instant.
function etOffsetMs(date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(date)) p[type] = value;
  const hour = parseInt(p.hour, 10) % 24; // hour12:false reports midnight as 24
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}

// Epoch ms of the next America/New_York 5-minute boundary after nowMs
// (ET wall-clock minutes :00, :05, :10, … :55, on the minute).
function nextEtRoundBoundary(nowMs) {
  const off = etOffsetMs(new Date(nowMs));
  const wall = nowMs + off;
  let nextWall = Math.floor(wall / ROUND_INTERVAL_MS) * ROUND_INTERVAL_MS + ROUND_INTERVAL_MS;
  // Refine the offset at the boundary (matters across DST transitions).
  let boundary = nextWall - etOffsetMs(new Date(nextWall - off));
  boundary = nextWall - etOffsetMs(new Date(boundary));
  if (boundary <= nowMs) {
    nextWall += ROUND_INTERVAL_MS;
    boundary = nextWall - etOffsetMs(new Date(nextWall - etOffsetMs(new Date(nextWall))));
  }
  return boundary;
}

function computeRoundEnd(startsAtMs) {
  if (process.env.ROUND_MINUTES) return startsAtMs + roundLengthMs();
  return nextEtRoundBoundary(startsAtMs);
}

// ---- winner logic -------------------------------------------------------
function drawWinningNumber() {
  return crypto.randomInt(0, SEGMENTS); // 0..100 inclusive
}

// guesses: [{ name, guess, created_at }] — created_at breaks closest ties (earliest wins).
// Returns { type: 'exact'|'closest'|'none', winners: [...], distance }
function computeWinners(guesses, winningNumber) {
  if (!guesses || guesses.length === 0) return { type: 'none', winners: [], distance: null };
  const exact = guesses.filter((g) => g.guess === winningNumber);
  if (exact.length > 0) return { type: 'exact', winners: exact, distance: 0 };
  let best = null;
  let bestDist = Infinity;
  const ordered = [...guesses].sort((a, b) => a.created_at - b.created_at);
  for (const g of ordered) {
    const d = Math.abs(g.guess - winningNumber);
    if (d < bestDist) { bestDist = d; best = g; }
  }
  return { type: 'closest', winners: best ? [best] : [], distance: bestDist };
}

function normalizeName(raw) {
  return String(raw || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);
}

function normalizeToken(raw) {
  const t = String(raw || '').trim();
  return /^[A-Za-z0-9-]{8,64}$/.test(t) ? t : null;
}

function newPlayerToken() {
  return crypto.randomUUID();
}

// Referral code: 6 uppercase letters/digits, no confusing 0/O/1/I.
function newReferralCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(0, alphabet.length)];
  return code;
}

// Which credit gets spent: bonus credits first (free plays are the perk —
// spend them before paid credits). Returns { useBonus, usePaid } counts.
function consumeCredits(paid, bonus, needed = 1) {
  const useBonus = Math.min(bonus, needed);
  const usePaid = Math.min(paid, needed - useBonus);
  return { useBonus, usePaid, ok: useBonus + usePaid >= needed };
}

module.exports = {
  SEGMENTS,
  NEON_COLORS,
  SINGLE_PRICE_CENTS,
  BUNDLE_PRICE_CENTS,
  BUNDLE_PAID_PLAYS,
  BUNDLE_BONUS_PLAYS,
  HOUSE_PCT,
  WINNER_PCT,
  JACKPOT_PCT,
  REFERRAL_BONUS_PLAYS,
  ROUND_WIN_BONUS_POINTS,
  splitPaidPlay,
  splitPot,
  formatCents,
  roundLengthMs,
  etOffsetMs,
  nextEtRoundBoundary,
  ROUND_INTERVAL_MS,
  computeRoundEnd,
  drawWinningNumber,
  computeWinners,
  normalizeName,
  normalizeToken,
  newPlayerToken,
  newReferralCode,
  consumeCredits,
};

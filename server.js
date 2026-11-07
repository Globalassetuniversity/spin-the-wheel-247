// server.js — Spin the Wheel 24/7.
// Node/Express + SQLite (node:sqlite, no native deps), same pattern as the
// Crypto Hub classroom app. One process, one SQLite file on a persistent
// volume (DB_PATH, e.g. /data/data.db on Railway).
//
// MONEY MODEL (locked in Nov 6, 2026) — all money is integer cents:
// - $5 per play (single) or $100 bundle = 20 paid plays + 2 bonus plays.
// - Each PAID play puts $5 in its round's pot: 20% house (Will), 70% round
//   winner, 10% rollover jackpot. Bonus plays (bundle freebies + referral
//   rewards) can win but add $0 to the pot.
// - Closest guess wins the round (70% of the round's paid pot). Hit the
//   exact number and you ALSO take the whole jackpot (rollover + this
//   round's 10%); the jackpot then resets to $0.
// - Referrals: a friend who pays for at least one game earns the referrer
//   1 free play, once per friend. Joining free earns nothing.
//
// PAYMENTS — Square embedded checkout (Web Payments SDK):
// - The player enters their card right on the game page. The browser
//   tokenizes it with Square's SDK and sends only the one-time source ID
//   to the server. The server charges it via the Square Payments API
//   (POST /v2/payments) with an idempotency key per attempt.
//   On Apple devices an Apple Pay button shows above the card form
//   instead — its token goes through the exact same charge path
//   (POST /api/payments/charge). Apple Pay needs the game domain
//   registered in the Square Developer Console (Apple Pay section) and
//   the domain verification file served at
//   /.well-known/apple-developer-merchantid-domain-association (see the
//   route below). Where Apple Pay is unavailable the button stays
//   hidden and the card form works as before. A Google Pay button
//   shows alongside it on Chrome, Firefox, Safari and Edge where
//   Google Pay is available — same charge path, and it needs no domain
//   file or registration.
// - A charge is only CONFIRMED (credits issued) when Square reports the
//   payment COMPLETED for the exact expected amount in USD. The amount is
//   always derived server-side from the kind ('single' = $5, 'bundle' =
//   $100) — never from anything the client sends. A Square payment ID can
//   only ever credit once.
// - Live only when SQUARE_APPLICATION_ID + SQUARE_LOCATION_ID +
//   SQUARE_ACCESS_TOKEN are all set (env vars on Railway). Otherwise the
//   game runs in free-preview mode exactly as before: plays are free,
//   $0 to the pot, and the page says payments are not live yet.
// - The old payment-link redirect flow (?paid=single|bundle + claim) is
//   retired — there is one payment path now.
//
// ROUNDS — 60 minutes, aligned to the America/New_York hour. A tick runs
// every 5 seconds (and on every API call): any round whose end time passed
// is drawn, winners are paid, and the next round opens. No login.
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  SINGLE_PRICE_CENTS,
  BUNDLE_PRICE_CENTS,
  BUNDLE_PAID_PLAYS,
  BUNDLE_BONUS_PLAYS,
  REFERRAL_BONUS_PLAYS,
  splitPot,
  formatCents,
  computeRoundEnd,
  drawWinningNumber,
  computeWinners,
  normalizeName,
  normalizeToken,
  newPlayerToken,
  newReferralCode,
  consumeCredits,
} = require('./game');
const { chargeAndVerify } = require('./square');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const ADMIN_CODE = process.env.ADMIN_CODE || '';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  winning_number INTEGER,
  jackpot_at_start_cents INTEGER NOT NULL DEFAULT 0,
  pot_cents INTEGER,
  paid_plays INTEGER NOT NULL DEFAULT 0,
  winner_payout_cents INTEGER,
  house_cents INTEGER,
  jackpot_contribution_cents INTEGER,
  jackpot_paid_cents INTEGER,
  winner_names TEXT,
  winner_guess INTEGER,
  winner_exact INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS players (
  player_token TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT 'Player',
  referral_code TEXT NOT NULL UNIQUE,
  referred_by TEXT,
  referral_rewarded INTEGER NOT NULL DEFAULT 0,
  referral_credits_earned INTEGER NOT NULL DEFAULT 0,
  paid_credits INTEGER NOT NULL DEFAULT 0,
  bonus_credits INTEGER NOT NULL DEFAULT 0,
  total_won_cents INTEGER NOT NULL DEFAULT 0,
  rounds_won INTEGER NOT NULL DEFAULT 0,
  jackpots_won INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS guesses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL,
  player_token TEXT NOT NULL,
  name TEXT NOT NULL,
  guess INTEGER NOT NULL,
  credit_type TEXT NOT NULL DEFAULT 'bonus',
  created_at INTEGER NOT NULL,
  UNIQUE(round_id, player_token, guess)
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_token TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  order_id TEXT,
  payment_id TEXT,
  receipt_ref TEXT,
  verify_note TEXT,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER
);
`);

// payment_id (the Square payment ID) was added when the game moved from
// payment links to embedded checkout. Older DBs get the column added here —
// BEFORE the index below is created, so an existing DB migrates cleanly.
try {
  const cols = db.prepare('PRAGMA table_info(payments)').all();
  if (!cols.some((c) => c.name === 'payment_id')) {
    db.exec('ALTER TABLE payments ADD COLUMN payment_id TEXT');
  }
} catch (e) { /* column already exists or table is new */ }

db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_order_used
  ON payments (order_id) WHERE order_id IS NOT NULL AND status = 'confirmed';
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_payment_used
  ON payments (payment_id) WHERE payment_id IS NOT NULL AND status = 'confirmed';
`);

// ---- meta helpers ---------------------------------------------------------
function metaGet(key, fallback) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  if (!row) return fallback;
  const n = parseInt(row.value, 10);
  return Number.isFinite(n) ? n : fallback;
}
function metaSet(key, value) {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, String(value));
}
const getJackpotCents = () => metaGet('jackpot_cents', 0);
const setJackpotCents = (v) => metaSet('jackpot_cents', v);
const getHouseCents = () => metaGet('house_cents', 0);
const addHouseCents = (v) => metaSet('house_cents', getHouseCents() + v);

// ---- payments config ------------------------------------------------------
// Prices come from payments.json (falling back to the locked constants in
// game.js). Whether payments are LIVE is decided by env vars only:
// all three Square vars must be set. Nothing in payments.json can turn
// payments on — and nothing here ever holds a secret.
function loadPayments() {
  const defaults = {
    singlePriceCents: SINGLE_PRICE_CENTS, bundlePriceCents: BUNDLE_PRICE_CENTS,
    bundlePaidPlays: BUNDLE_PAID_PLAYS, bundleBonusPlays: BUNDLE_BONUS_PLAYS,
  };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'payments.json'), 'utf8'));
    return { ...defaults, ...raw };
  } catch (e) { return defaults; }
}
function squareConfigured() {
  return !!(process.env.SQUARE_APPLICATION_ID && process.env.SQUARE_LOCATION_ID && process.env.SQUARE_ACCESS_TOKEN);
}
function paymentsPublic() {
  const p = loadPayments();
  const live = squareConfigured();
  return {
    // mode: 'free' (preview) or 'embedded' (card checkout on the page).
    mode: live ? 'embedded' : 'free',
    enabled: live,
    singlePriceCents: p.singlePriceCents,
    bundlePriceCents: p.bundlePriceCents,
    bundlePaidPlays: p.bundlePaidPlays,
    bundleBonusPlays: p.bundleBonusPlays,
    autoVerify: live,
  };
}

// ---- sponsors --------------------------------------------------------------
function loadSponsors() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'sponsors.json'), 'utf8'));
    if (Array.isArray(raw)) return raw.slice(0, 3).map((s, i) => ({
      slot: i + 1,
      name: String(s.name || '').trim(),
      message: String(s.message || '').trim(),
      price: [25, 35, 40, 50].includes(+s.price) ? +s.price : 50,
    }));
  } catch (e) { /* fall through to defaults */ }
  return [1, 2, 3].map((slot) => ({ slot, name: '', message: '', price: 50 }));
}

// ---- players ---------------------------------------------------------------
function getPlayer(token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM players WHERE player_token = ?').get(token) || null;
}

function ensurePlayer(token, displayName, refCode) {
  let player = getPlayer(token);
  const now = Date.now();
  if (player) {
    if (displayName) {
      db.prepare('UPDATE players SET display_name = ?, updated_at = ? WHERE player_token = ?')
        .run(displayName, now, token);
      player.display_name = displayName;
    }
    return player;
  }
  let code = null;
  for (let i = 0; i < 5 && !code; i++) {
    const candidate = newReferralCode();
    const clash = db.prepare('SELECT 1 FROM players WHERE referral_code = ?').get(candidate);
    if (!clash) code = candidate;
  }
  let referredBy = null;
  if (refCode) {
    const referrer = db.prepare('SELECT player_token FROM players WHERE referral_code = ?').get(refCode);
    if (referrer && referrer.player_token !== token) referredBy = refCode;
  }
  db.prepare(
    `INSERT INTO players (player_token, display_name, referral_code, referred_by,
     referral_rewarded, referral_credits_earned, paid_credits, bonus_credits,
     total_won_cents, rounds_won, jackpots_won, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, ?, ?)`
  ).run(token, displayName || 'Player', code, referredBy, now, now);
  return getPlayer(token);
}

function friendsPaidCount(referralCode) {
  const row = db.prepare(
    'SELECT COUNT(*) AS n FROM players WHERE referred_by = ? AND referral_rewarded = 1'
  ).get(referralCode);
  return row ? row.n : 0;
}

// Issue credits for a CONFIRMED payment. Also pays the referral reward:
// the first confirmed payment from a referred player earns their referrer
// 1 bonus play, once.
function issueCreditsForPayment(payment) {
  const player = getPlayer(payment.player_token);
  if (!player) return null;
  const cfg = loadPayments();
  let paid = 0;
  let bonus = 0;
  if (payment.kind === 'single') paid = 1;
  else if (payment.kind === 'bundle') { paid = cfg.bundlePaidPlays; bonus = cfg.bundleBonusPlays; }
  db.prepare(
    'UPDATE players SET paid_credits = paid_credits + ?, bonus_credits = bonus_credits + ?, updated_at = ? WHERE player_token = ?'
  ).run(paid, bonus, Date.now(), payment.player_token);

  let referralAwarded = false;
  if (player.referred_by && !player.referral_rewarded) {
    const referrer = db.prepare('SELECT * FROM players WHERE referral_code = ?').get(player.referred_by);
    if (referrer) {
      db.prepare(
        'UPDATE players SET bonus_credits = bonus_credits + ?, referral_credits_earned = referral_credits_earned + ?, updated_at = ? WHERE player_token = ?'
      ).run(REFERRAL_BONUS_PLAYS, REFERRAL_BONUS_PLAYS, Date.now(), referrer.player_token);
      referralAwarded = true;
    }
    db.prepare('UPDATE players SET referral_rewarded = 1 WHERE player_token = ?').run(payment.player_token);
  }
  return { paid, bonus, referralAwarded };
}

function confirmPayment(paymentId) {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!payment || payment.status !== 'pending') return null;
  // A Square payment ID can only ever credit once — if another confirmed
  // payment already used this payment (or the legacy order) ID, reject
  // this one instead of double-crediting.
  if (payment.payment_id) {
    const used = db.prepare(
      "SELECT id FROM payments WHERE payment_id = ? AND status = 'confirmed' AND id != ?"
    ).get(payment.payment_id, paymentId);
    if (used) {
      db.prepare("UPDATE payments SET status = 'rejected', verify_note = 'payment already used' WHERE id = ?").run(paymentId);
      return { payment: { ...payment, status: 'rejected' }, issued: null, duplicate: true };
    }
  }
  if (payment.order_id) {
    const used = db.prepare(
      "SELECT id FROM payments WHERE order_id = ? AND status = 'confirmed' AND id != ?"
    ).get(payment.order_id, paymentId);
    if (used) {
      db.prepare("UPDATE payments SET status = 'rejected', verify_note = 'order already used' WHERE id = ?").run(paymentId);
      return { payment: { ...payment, status: 'rejected' }, issued: null, duplicate: true };
    }
  }
  db.prepare("UPDATE payments SET status = 'confirmed', confirmed_at = ? WHERE id = ?").run(Date.now(), paymentId);
  const issued = issueCreditsForPayment({ ...payment, status: 'confirmed' });
  return { payment: { ...payment, status: 'confirmed' }, issued };
}

// ---- rounds ----------------------------------------------------------------
function openRound() {
  return db.prepare("SELECT * FROM rounds WHERE status = 'open' ORDER BY id DESC LIMIT 1").get() || null;
}

function createRound(now) {
  const endsAt = computeRoundEnd(now);
  const info = db.prepare(
    'INSERT INTO rounds (starts_at, ends_at, status, jackpot_at_start_cents, created_at) VALUES (?, ?, \'open\', ?, ?)'
  ).run(now, endsAt, getJackpotCents(), now);
  return db.prepare('SELECT * FROM rounds WHERE id = ?').get(info.lastInsertRowid);
}

function ensureRound() {
  let round = openRound();
  if (!round) round = createRound(Date.now());
  return round;
}

function paidPlaysInRound(roundId) {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM guesses WHERE round_id = ? AND credit_type = 'paid'"
  ).get(roundId);
  return row ? row.n : 0;
}

// Live jackpot display: rollover + this round's 10% share so far.
function displayJackpotCents(round) {
  return getJackpotCents() + splitPot(paidPlaysInRound(round.id)).jackpot;
}

function closeRound(round, now) {
  const winningNumber = drawWinningNumber();
  const guesses = db.prepare(
    'SELECT name, player_token, guess, credit_type, created_at FROM guesses WHERE round_id = ? ORDER BY created_at ASC'
  ).all(round.id);
  const result = computeWinners(guesses, winningNumber);
  const paidPlays = guesses.filter((g) => g.credit_type === 'paid').length;
  const split = splitPot(paidPlays);
  const jackpotBefore = getJackpotCents() + split.jackpot; // rollover + this round's 10%
  addHouseCents(split.house);

  let winnerNames = null;
  let winnerGuess = null;
  let winnerExact = 0;
  let winnerPayout = 0;
  let jackpotPaid = null;

  const payPlayer = (playerToken, displayName, cents, wonRound, wonJackpot) => {
    if (cents > 0 || wonRound) {
      db.prepare(
        `UPDATE players SET total_won_cents = total_won_cents + ?,
         rounds_won = rounds_won + ?, jackpots_won = jackpots_won + ?, updated_at = ?
         WHERE player_token = ?`
      ).run(cents, wonRound ? 1 : 0, wonJackpot ? 1 : 0, Date.now(), playerToken);
    }
  };

  if (result.type === 'exact') {
    winnerExact = 1;
    winnerNames = result.winners.map((w) => w.name).join(', ');
    winnerGuess = winningNumber;
    const eachWinnerShare = Math.floor(split.winner / result.winners.length);
    const eachJackpotShare = Math.floor(jackpotBefore / result.winners.length);
    winnerPayout = eachWinnerShare + eachJackpotShare;
    jackpotPaid = eachJackpotShare * result.winners.length;
    for (const w of result.winners) payPlayer(w.player_token, w.name, winnerPayout, 1, 1);
    setJackpotCents(jackpotBefore - jackpotPaid); // remainder (rounding dust) stays
  } else if (result.type === 'closest') {
    const w = result.winners[0];
    winnerNames = w.name;
    winnerGuess = w.guess;
    winnerPayout = split.winner;
    payPlayer(w.player_token, w.name, winnerPayout, 1, 0);
    setJackpotCents(jackpotBefore); // rolls over
  } else {
    setJackpotCents(jackpotBefore); // no guesses: rolls over
  }

  db.prepare(
    `UPDATE rounds SET status = 'closed', winning_number = ?, jackpot_paid_cents = ?,
     pot_cents = ?, paid_plays = ?, winner_payout_cents = ?, house_cents = ?,
     jackpot_contribution_cents = ?, winner_names = ?, winner_guess = ?, winner_exact = ?
     WHERE id = ?`
  ).run(winningNumber, jackpotPaid, split.pot, paidPlays, winnerPayout, split.house,
    split.jackpot, winnerNames, winnerGuess, winnerExact, round.id);

  console.log(`[spin] round ${round.id} closed — winning number ${winningNumber}, pot ${formatCents(split.pot)} ` +
    (result.type === 'exact' ? `JACKPOT ${formatCents(jackpotPaid)} to ${winnerNames}` :
     result.type === 'closest' ? `closest: ${winnerNames} (${winnerGuess}) wins ${formatCents(winnerPayout)}` :
     'no guesses, jackpot rolls over') +
    `, jackpot now ${formatCents(getJackpotCents())}`);
  return createRound(now);
}

// Tick: close any due rounds, make sure a round is open.
function tick() {
  const now = Date.now();
  let round = openRound();
  let guard = 0;
  while (round && round.ends_at <= now && guard < 48) {
    round = closeRound(round, now);
    guard++;
  }
  if (!openRound()) createRound(now);
}

// ---- app -------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '16kb' }));

// ---- Apple Pay domain verification --------------------------------------
// Apple Pay on the web only works once Apple can fetch this file from the
// game domain. Square issues the file; download the current copy from
// https://app.squareup.com/digital-wallets/apple-pay/apple-developer-merchantid-domain-association
// and drop it at public/.well-known/apple-developer-merchantid-domain-association.
// Square updates this file from time to time — if Apple Pay ever stops
// verifying, re-download it. express.static ignores dotfiles by default,
// so this needs its own route, registered BEFORE the static middleware.
// It serves in free-preview mode too: the file is public and harmless
// without Square credentials configured.
const APPLE_PAY_FILE = path.join(__dirname, 'public', '.well-known', 'apple-developer-merchantid-domain-association');
app.get('/.well-known/apple-developer-merchantid-domain-association', (req, res) => {
  if (!fs.existsSync(APPLE_PAY_FILE)) return res.status(404).end();
  res.sendFile(APPLE_PAY_FILE);
});

app.use(express.static(path.join(__dirname, 'public')));

// Tiny in-memory throttle: 10 guess posts / 5 charge posts per IP per minute.
const hitLog = new Map();
function throttle(limit) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.ip || 'unknown'}:${req.path}`;
    const hits = (hitLog.get(key) || []).filter((t) => now - t < 60000);
    if (hits.length >= limit) return res.status(429).json({ ok: false, error: 'Slow down — too many tries at once.' });
    hits.push(now);
    hitLog.set(key, hits);
    next();
  };
}

function publicState(playerToken) {
  tick();
  const round = ensureRound();
  const guesses = db.prepare(
    'SELECT player_token, name, guess, credit_type, created_at FROM guesses WHERE round_id = ? ORDER BY created_at ASC'
  ).all(round.id).map((g) => ({
    name: g.name, guess: g.guess, credit_type: g.credit_type, created_at: g.created_at,
    mine: !!playerToken && g.player_token === playerToken,
  }));
  const split = splitPot(paidPlaysInRound(round.id));
  const leaderboard = db.prepare(
    'SELECT display_name AS name, total_won_cents AS won_cents, rounds_won, jackpots_won FROM players ORDER BY total_won_cents DESC, rounds_won DESC LIMIT 20'
  ).all();
  const history = db.prepare(
    `SELECT id, ends_at, winning_number, winner_names, winner_guess, winner_exact,
     pot_cents, winner_payout_cents, jackpot_paid_cents
     FROM rounds WHERE status = 'closed' ORDER BY id DESC LIMIT 12`
  ).all();
  const lastClosed = history[0] || null;

  let me = null;
  if (playerToken) {
    const p = getPlayer(playerToken);
    if (p) {
      me = {
        playerToken: p.player_token,
        name: p.display_name,
        referralCode: p.referral_code,
        paidCredits: p.paid_credits,
        bonusCredits: p.bonus_credits,
        referralCreditsEarned: p.referral_credits_earned,
        friendsPaid: friendsPaidCount(p.referral_code),
        totalWonCents: p.total_won_cents,
        roundsWon: p.rounds_won,
        jackpotsWon: p.jackpots_won,
      };
    }
  }

  return {
    now: Date.now(),
    jackpotCents: displayJackpotCents(round),
    jackpotRolloverCents: getJackpotCents(),
    round: {
      id: round.id,
      starts_at: round.starts_at,
      ends_at: round.ends_at,
      status: round.status,
      jackpot_at_start_cents: round.jackpot_at_start_cents,
      paidPlays: split.paidPlays,
      potCents: split.pot,
      winnerShareCents: split.winner,
      jackpotShareCents: split.jackpot,
      houseShareCents: split.house,
      guesses,
    },
    lastResult: lastClosed ? {
      round_id: lastClosed.id,
      ended_at: lastClosed.ends_at,
      winning_number: lastClosed.winning_number,
      winner_names: lastClosed.winner_names,
      winner_guess: lastClosed.winner_guess,
      winner_exact: !!lastClosed.winner_exact,
      pot_cents: lastClosed.pot_cents,
      winner_payout_cents: lastClosed.winner_payout_cents,
      jackpot_paid_cents: lastClosed.jackpot_paid_cents,
    } : null,
    leaderboard,
    history: history.map((h) => ({
      round_id: h.id,
      ended_at: h.ends_at,
      winning_number: h.winning_number,
      winner_names: h.winner_names,
      winner_guess: h.winner_guess,
      winner_exact: !!h.winner_exact,
      pot_cents: h.pot_cents,
      winner_payout_cents: h.winner_payout_cents,
      jackpot_paid_cents: h.jackpot_paid_cents,
    })),
    sponsors: loadSponsors(),
    payments: paymentsPublic(),
    me,
  };
}

app.get('/api/health', (req, res) => res.json({ ok: true, now: Date.now() }));

app.get('/api/state', (req, res) => {
  const token = normalizeToken(req.query.playerToken);
  res.json(publicState(token));
});

// Register/update this browser's player (called on page load). Captures a
// referral code from ?ref= on the player's FIRST visit only.
app.post('/api/player', (req, res) => {
  const token = normalizeToken(req.body && req.body.playerToken) || newPlayerToken();
  const name = normalizeName(req.body && req.body.name);
  const ref = typeof (req.body && req.body.ref) === 'string' ? req.body.ref.trim().toUpperCase() : '';
  const player = ensurePlayer(token, name || undefined, ref || undefined);
  res.json({
    ok: true,
    playerToken: player.player_token,
    name: player.display_name,
    referralCode: player.referral_code,
    paidCredits: player.paid_credits,
    bonusCredits: player.bonus_credits,
    referralCreditsEarned: player.referral_credits_earned,
    friendsPaid: friendsPaidCount(player.referral_code),
  });
});

app.post('/api/guess', throttle(10), (req, res) => {
  tick();
  const round = ensureRound();
  const now = Date.now();
  if (round.ends_at <= now) {
    return res.status(409).json({ ok: false, error: 'This round just closed — your guess goes to the next round. Try again.' });
  }
  const token = normalizeToken(req.body && req.body.playerToken);
  if (!token) return res.status(400).json({ ok: false, error: 'Reload the page and try again.' });
  const name = normalizeName(req.body && req.body.name);
  const guess = Number(req.body && req.body.guess);
  if (!name) return res.status(400).json({ ok: false, error: 'Enter your name.' });
  if (!Number.isInteger(guess) || guess < 0 || guess > 100) {
    return res.status(400).json({ ok: false, error: 'Pick a whole number from 0 to 100.' });
  }
  const player = ensurePlayer(token, name);
  const dupe = db.prepare(
    'SELECT id FROM guesses WHERE round_id = ? AND player_token = ? AND guess = ?'
  ).get(round.id, token, guess);
  if (dupe) {
    return res.status(409).json({ ok: false, error: `You already guessed ${guess} this round — pick a different number.` });
  }

  const pay = paymentsPublic();
  let creditType = 'bonus';
  if (pay.enabled) {
    // Paid mode: a guess costs 1 credit. Bonus credits are spent first.
    const use = consumeCredits(player.paid_credits, player.bonus_credits, 1);
    if (!use.ok) {
      return res.status(402).json({
        ok: false, needsPayment: true,
        error: 'No plays left — buy a $5 play or the $100 bundle (22 plays) to keep playing.',
      });
    }
    creditType = use.useBonus > 0 ? 'bonus' : 'paid';
    db.prepare(
      'UPDATE players SET paid_credits = paid_credits - ?, bonus_credits = bonus_credits - ?, updated_at = ? WHERE player_token = ?'
    ).run(use.usePaid, use.useBonus, now, token);
  }
  // Free mode: guesses cost nothing and count as bonus plays ($0 to the pot).

  db.prepare(
    'INSERT INTO guesses (round_id, player_token, name, guess, credit_type, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(round.id, token, name, guess, creditType, now);
  const fresh = getPlayer(token);
  res.json({
    ok: true, roundId: round.id, name, guess, creditType,
    paidCredits: fresh.paid_credits, bonusCredits: fresh.bonus_credits,
    jackpotCents: displayJackpotCents(round), endsAt: round.ends_at,
  });
});

// ---- payments: embedded checkout ----------------------------------------
// The page fetches the PUBLIC Square identifiers from here (application ID
// + location ID). The access token is never sent to the browser — it stays
// on the server and is only used to charge via the Payments API.
app.get('/api/square-config', (req, res) => {
  if (!squareConfigured()) return res.json({ enabled: false });
  res.json({
    enabled: true,
    applicationId: process.env.SQUARE_APPLICATION_ID,
    locationId: process.env.SQUARE_LOCATION_ID,
  });
});

// Charge a tokenized card and, ONLY on a confirmed Square payment, issue
// the plays. Body: { playerToken, name, kind: 'single'|'bundle', sourceId }
// — sourceId is the one-time nonce from Square's Web Payments SDK.
// The amount is derived server-side from kind; the client never sets it.
// A declined card or a wrong amount credits 0 plays.
app.post('/api/payments/charge', throttle(5), async (req, res) => {
  const pay = paymentsPublic();
  if (!pay.enabled) {
    return res.status(400).json({ ok: false, error: 'Payments are not switched on yet — plays are free for now.' });
  }
  const token = normalizeToken(req.body && req.body.playerToken);
  if (!token) return res.status(400).json({ ok: false, error: 'Reload the page and try again.' });
  const kind = req.body && req.body.kind === 'bundle' ? 'bundle' : 'single';
  const name = normalizeName(req.body && req.body.name);
  const sourceId = typeof (req.body && req.body.sourceId) === 'string' ? req.body.sourceId.trim() : '';
  if (!sourceId || sourceId.length > 256) {
    return res.status(400).json({ ok: false, error: 'Payment did not start — please try your card again.' });
  }
  const player = ensurePlayer(token, name || undefined);
  const amountCents = kind === 'bundle' ? pay.bundlePriceCents : pay.singlePriceCents;

  // Same player re-tapping Pay within 2 minutes for the same kind: don't
  // charge twice — the first attempt is still being handled.
  const recent = db.prepare(
    "SELECT id FROM payments WHERE player_token = ? AND kind = ? AND status = 'pending' AND created_at > ?"
  ).get(token, kind, Date.now() - 120000);
  if (recent) {
    return res.status(409).json({ ok: false, error: 'That payment is already being processed — give it a moment, then check your plays.' });
  }

  const info = db.prepare(
    `INSERT INTO payments (player_token, kind, amount_cents, status, created_at)
     VALUES (?, ?, ?, 'pending', ?)`
  ).run(token, kind, amountCents, Date.now());
  const paymentId = info.lastInsertRowid;

  const v = await chargeAndVerify(sourceId, amountCents, crypto.randomUUID());
  if (!v.verified) {
    db.prepare("UPDATE payments SET status = 'rejected', verify_note = ? WHERE id = ?")
      .run(`charge failed: ${v.reason}${v.code ? ` (${v.code})` : ''}`, paymentId);
    const msg = v.declined
      ? 'Your card was declined — no charge went through and no plays were added. Check the card and try again.'
      : v.reason === 'amount_mismatch'
        ? 'The payment did not match the price — no plays were added. Please try again.'
        : 'The payment could not be completed — no charge went through and no plays were added. Please try again.';
    return res.status(402).json({ ok: false, error: msg, reason: v.reason });
  }

  // Record the Square payment ID first, then confirm (which double-checks
  // the ID was never used before and issues the credits + referral reward).
  db.prepare('UPDATE payments SET payment_id = ? WHERE id = ?').run(v.paymentId, paymentId);
  const done = confirmPayment(paymentId);
  if (!done || done.duplicate) {
    return res.status(409).json({ ok: false, error: 'That payment was already used to add plays.' });
  }
  const fresh = getPlayer(token);
  res.json({
    ok: true, status: 'confirmed', paymentId,
    paidCredits: fresh.paid_credits, bonusCredits: fresh.bonus_credits,
    issued: done.issued,
    receiptUrl: v.receiptUrl || null,
    message: kind === 'bundle'
      ? 'Payment confirmed — 22 plays added (20 paid + 2 free). Good luck!'
      : 'Payment confirmed — 1 play added. Good luck!',
  });
});

// ---- admin (Will only, ADMIN_CODE env) ------------------------------------
// Embedded checkout confirms payments itself, so there is nothing to
// confirm by hand anymore. /admin is now a read-only view: jackpot,
// house cut, whether card payments are live, and recent payments.
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
function adminAuthed(req) {
  if (!ADMIN_CODE) return false;
  const code = String((req.body && req.body.code) || '');
  if (code.length !== ADMIN_CODE.length) return false;
  return crypto.timingSafeEqual(Buffer.from(code), Buffer.from(ADMIN_CODE));
}

app.post('/api/admin/stats', (req, res) => {
  if (!ADMIN_CODE) return res.status(503).json({ ok: false, error: 'Admin is not configured (set ADMIN_CODE).' });
  if (!adminAuthed(req)) return res.status(401).json({ ok: false, error: 'Wrong code.' });
  const recent = db.prepare(
    `SELECT p.*, pl.display_name AS player_name FROM payments p
     LEFT JOIN players pl ON pl.player_token = p.player_token
     ORDER BY p.created_at DESC LIMIT 20`
  ).all();
  res.json({
    ok: true, recent,
    jackpotCents: getJackpotCents(), houseCents: getHouseCents(),
    paymentsLive: squareConfigured(),
    autoVerify: squareConfigured(),
  });
});

setInterval(tick, 5000);
tick();
ensureRound();

app.listen(PORT, () => {
  console.log(`Spin the Wheel 24/7 listening on port ${PORT} (DB: ${DB_PATH})`);
  const pay = paymentsPublic();
  console.log(`Payments mode: ${pay.mode}${pay.enabled ? ' (embedded card + Apple Pay checkout live)' : ' (FREE PREVIEW — set SQUARE_APPLICATION_ID, SQUARE_LOCATION_ID and SQUARE_ACCESS_TOKEN to switch card payments on)'}`);
  console.log(`Apple Pay domain file: ${fs.existsSync(APPLE_PAY_FILE) ? 'present' : 'MISSING — download the current file from Square (see the route above server.js) or Apple Pay cannot verify'}`);
  const r = openRound();
  if (r) console.log(`Current round #${r.id} spins at ${new Date(r.ends_at).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET, jackpot ${formatCents(displayJackpotCents(r))}`);
});

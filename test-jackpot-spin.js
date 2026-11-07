// test-jackpot-spin.js — jackpot bonus spin tests for Spin the Wheel 24/7.
// Runs the real server in free-preview mode (no Square env needed).
// Verifies:
//   window unit checks: result within ±5 of the winning number awards,
//     ±6 does not (winning 50: 45/55 award, 44/56 do not)
//   an exact winner gets a pending bonus spin in `me`; a non-player in
//     the same game does NOT (winner only)
//   a non-winner cannot take the winner's spin (403); unknown id -> 404
//   taking it draws a server-side result 0..100 and marks the spin used
//   a second take is rejected (409)
//   credit consistency: result within 5 -> bonus_credits +10 exactly,
//     otherwise unchanged; the round's jackpot payout never changes
//   the Wheel announces the bonus spin in chat (+ the +10 message when
//     the spin lands within 5)
//   the page serves the bonus spin panel + How to Play copy
//
// Deterministic exact win: the test seeds the rollover jackpot in the
// DB, gives the winner a guess on EVERY number 0..100 (inserted
// directly into the DB while the server is stopped — the API's per-IP
// throttle would need a dozen restarts), backdates the round's end,
// and restarts so the startup tick closes the round immediately.
// Usage: node test-jackpot-spin.js   (exit 0 = all pass)
const net = require('node:net');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DIR = __dirname;
const DB = path.join('/tmp', `stw247-jackpot-test-${process.pid}.db`);
let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function startGame(envExtra) {
  return new Promise(async (resolve, reject) => {
    const port = await freePort();
    const env = { ...process.env, PORT: String(port), DB_PATH: DB, ADMIN_CODE: 'testadmin', ...envExtra };
    const child = spawn('node', ['server.js'], { cwd: DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const deadline = Date.now() + 15000;
    const tick = async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (r.ok) return resolve({ child, port, out: () => out });
      } catch (e) { /* not up yet */ }
      if (Date.now() > deadline) return reject(new Error('game server did not start:\n' + out));
      setTimeout(tick, 200);
    };
    tick();
  });
}
function stopGame(g) {
  return new Promise((resolve) => {
    if (!g || !g.child || g.child.exitCode !== null) return resolve();
    g.child.once('exit', () => resolve());
    g.child.kill('SIGTERM');
    setTimeout(() => { try { g.child.kill('SIGKILL'); } catch (e) {} resolve(); }, 5000);
  });
}

function api(port, method, p, body) {
  return fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})), text: null }))
    .catch((e) => ({ status: 0, body: {}, text: String(e) }));
}
function page(port, p) {
  return fetch(`http://127.0.0.1:${port}${p}`).then(async (r) => ({ status: r.status, text: await r.text() }));
}

async function main() {
  // ===== Phase 0: the window check itself (pure, deterministic) =======
  console.log('Phase 0 — window unit checks');
  const game = require('./game.js');
  check('window is 5, bonus is 10 plays',
    game.JACKPOT_SPIN_WINDOW === 5 && game.JACKPOT_SPIN_BONUS_PLAYS === 10,
    `window=${game.JACKPOT_SPIN_WINDOW} bonus=${game.JACKPOT_SPIN_BONUS_PLAYS}`);
  check('winning 50: result 45 awards (exactly 5 below)', game.jackpotSpinBonusAwarded(45, 50) === true);
  check('winning 50: result 55 awards (exactly 5 above)', game.jackpotSpinBonusAwarded(55, 50) === true);
  check('winning 50: result 50 awards (exact)', game.jackpotSpinBonusAwarded(50, 50) === true);
  check('winning 50: result 44 does NOT award (6 below)', game.jackpotSpinBonusAwarded(44, 50) === false);
  check('winning 50: result 56 does NOT award (6 above)', game.jackpotSpinBonusAwarded(56, 50) === false);
  check('edges do not wrap: winning 2, result 99 does NOT award', game.jackpotSpinBonusAwarded(99, 2) === false);
  check('edges do not wrap: winning 98, result 1 does NOT award', game.jackpotSpinBonusAwarded(1, 98) === false);

  // ===== Phase 1: seed an exact jackpot win ============================
  console.log('Phase 1 — seed the exact win, close the round');
  const WINNER = 'test-jackpot-winner-01';
  const OTHER = 'test-jackpot-other-002';
  const SEED_JACKPOT = 5000; // $50 rollover, so the payout is real money

  let g = await startGame({ ROUND_MINUTES: '1' });
  let r = await api(g.port, 'POST', '/api/player', { playerToken: WINNER, name: 'Wendy' });
  check('winner registers', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
  r = await api(g.port, 'POST', '/api/player', { playerToken: OTHER, name: 'Oscar' });
  check('other player registers', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
  await stopGame(g);

  // Direct DB setup: seed the rollover, cover every number for the
  // winner, and make the open round already due.
  const db = new DatabaseSync(DB);
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('jackpot_cents', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(SEED_JACKPOT));
  const round = db.prepare("SELECT id FROM rounds WHERE status = 'open' ORDER BY id DESC LIMIT 1").get();
  check('an open round exists to seed', !!round, JSON.stringify(round));
  const ins = db.prepare(
    'INSERT INTO guesses (round_id, player_token, name, guess, credit_type, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const t0 = Date.now() - 60000;
  for (let n = 0; n <= 100; n++) ins.run(round.id, WINNER, 'Wendy', n, 'bonus', t0 + n);
  db.prepare('UPDATE rounds SET ends_at = ? WHERE id = ?').run(Date.now() - 1000, round.id);
  db.close();

  g = await startGame({ ROUND_MINUTES: '1' });
  const P = g.port;

  // The startup tick (or this state call's tick) closes the seeded round.
  let state = null;
  for (let i = 0; i < 25 && !state; i++) {
    r = await api(P, 'GET', `/api/state?playerToken=${WINNER}`);
    if (r.body.lastResult && r.body.lastResult.round_id === round.id && r.body.me) state = r.body;
    else await sleep(300);
  }
  check('seeded round closed as the last result',
    !!state && state.lastResult.winner_exact === true,
    state ? JSON.stringify(state.lastResult) : 'no state');
  const winningNumber = state.lastResult.winning_number;
  check('round paid the seeded jackpot',
    state.lastResult.jackpot_paid_cents === SEED_JACKPOT
    && state.lastResult.winner_payout_cents === SEED_JACKPOT,
    JSON.stringify(state.lastResult));
  const payoutBefore = state.lastResult.winner_payout_cents;
  const jackpotPaidBefore = state.lastResult.jackpot_paid_cents;
  const wonBefore = state.me.totalWonCents;
  const bonusBefore = state.me.bonusCredits;
  check("winner's record shows the jackpot win",
    wonBefore === SEED_JACKPOT && state.me.jackpotsWon === 1,
    `totalWon=${wonBefore} jackpotsWon=${state.me.jackpotsWon}`);

  // (1) pending spin in `me` for the winner only
  const spin = state.me.jackpotSpin;
  check('winner has a pending bonus spin in me',
    !!spin && typeof spin.id === 'number' && spin.roundId === round.id
    && spin.winningNumber === winningNumber && spin.jackpotCents === SEED_JACKPOT,
    JSON.stringify(state.me.jackpotSpin));
  r = await api(P, 'GET', `/api/state?playerToken=${OTHER}`);
  check('other player has NO pending bonus spin',
    !!r.body.me && (r.body.me.jackpotSpin === null || r.body.me.jackpotSpin === undefined),
    JSON.stringify(r.body.me && r.body.me.jackpotSpin));

  // ===== Phase 2: taking the spin ======================================
  console.log('Phase 2 — take the bonus spin');
  // (2a) a non-winner cannot take it
  r = await api(P, 'POST', '/api/jackpot-spin', { playerToken: OTHER, spinId: spin.id });
  check("non-winner taking the winner's spin -> rejected",
    r.status === 403 && r.body.ok === false, `status=${r.status} ${JSON.stringify(r.body)}`);
  // (2b) unknown spin id -> 404
  r = await api(P, 'POST', '/api/jackpot-spin', { playerToken: WINNER, spinId: 999999 });
  check('unknown spin id -> 404', r.status === 404 && r.body.ok === false, `status=${r.status}`);

  // (3) the winner takes it — the server draws the result
  r = await api(P, 'POST', '/api/jackpot-spin', { playerToken: WINNER, spinId: spin.id });
  check('winner takes the spin -> 200',
    r.status === 200 && r.body.ok === true && r.body.spinId === spin.id, JSON.stringify(r.body));
  const result = r.body.resultNumber;
  check('result is a whole number 0..100',
    Number.isInteger(result) && result >= 0 && result <= 100, `result=${result}`);
  const expectWithin = Math.abs(result - winningNumber) <= 5;
  check('withinWindow matches |result - winning| <= 5',
    r.body.withinWindow === expectWithin && r.body.winningNumber === winningNumber,
    `result=${result} winning=${winningNumber} within=${r.body.withinWindow}`);
  check('bonusAwarded is 10 inside the window, 0 outside',
    r.body.bonusAwarded === (expectWithin ? 10 : 0), `awarded=${r.body.bonusAwarded}`);

  // (5) credit consistency: exactly +10 inside the window, unchanged outside
  r = await api(P, 'GET', `/api/state?playerToken=${WINNER}`);
  check('bonus_credits moved by exactly the award',
    r.body.me.bonusCredits === bonusBefore + (expectWithin ? 10 : 0),
    `before=${bonusBefore} after=${r.body.me.bonusCredits} within=${expectWithin}`);
  check('pending spin is gone from me after taking it',
    r.body.me.jackpotSpin === null || r.body.me.jackpotSpin === undefined,
    JSON.stringify(r.body.me.jackpotSpin));
  check("winner's money total is untouched by the spin",
    r.body.me.totalWonCents === wonBefore, `before=${wonBefore} after=${r.body.me.totalWonCents}`);

  // (4) a second take is rejected
  r = await api(P, 'POST', '/api/jackpot-spin', { playerToken: WINNER, spinId: spin.id });
  check('second take of the same spin -> rejected',
    r.status === 409 && r.body.ok === false, `status=${r.status} ${JSON.stringify(r.body)}`);

  // (6) the round record is unchanged by the spin
  r = await api(P, 'GET', `/api/state?playerToken=${WINNER}`);
  const rec = (r.body.history || []).find((h) => h.round_id === round.id) || r.body.lastResult;
  check('round jackpot payout unchanged after the spin',
    rec.winner_payout_cents === payoutBefore && rec.jackpot_paid_cents === jackpotPaidBefore,
    JSON.stringify(rec));

  // Chat: the Wheel announced the bonus spin (and the +10 when it hit)
  r = await api(P, 'GET', '/api/chat');
  const took = r.body.messages.find((m) => m.system && m.text.includes('JACKPOT BONUS SPIN'));
  check('Wheel announces the bonus spin in chat',
    !!took && took.text.includes('Wendy'), JSON.stringify(r.body.messages.map((m) => m.text)));
  if (expectWithin) {
    const hit = r.body.messages.find((m) => m.system && m.text.includes('+10 FREE plays'));
    check('Wheel announces the within-5 hit + 10 free plays',
      !!hit && hit.text.includes(`landed ${result}`) && hit.text.includes(`within 5 of ${winningNumber}`),
      JSON.stringify(r.body.messages.map((m) => m.text)));
  }

  // Page: the panel + copy are served
  const home = await page(P, '/');
  check('page serves the bonus spin panel + button',
    home.status === 200 && home.text.includes('id="bonusSpinPanel"') && home.text.includes('id="bonusSpinBtn"')
    && home.text.includes('id="bonusSpinText"'),
    `status=${home.status}`);
  check('How to Play copy mentions the bonus spin + 10 free plays',
    home.text.includes('BONUS SPIN') && home.text.includes('10 FREE plays'),
    '');
  const appJs = await page(P, '/app.js');
  check('app.js wires the panel to /api/jackpot-spin',
    appJs.text.includes('/api/jackpot-spin') && appJs.text.includes('renderBonusPanel')
    && appJs.text.includes('jackpotSpin'),
    '');

  await stopGame(g);
  for (const f of [DB, DB + '-wal', DB + '-shm']) {
    try { fs.unlinkSync(f); } catch (e) {}
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('TEST RUNNER ERROR:', e); process.exit(1); });

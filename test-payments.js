// test-payments.js — payment-flow tests for Spin the Wheel 24/7.
// Runs the real server against a MOCK Square server (no real Square calls,
// no real charges). Verifies:
//   $5 charge -> 1 paid play; $100 charge -> 22 plays (20 paid + 2 bonus)
//   declined card -> 0 plays; wrong amount -> 0 plays; not-completed -> 0
//   paid referral -> referrer earns 1 free play
//   a Square payment ID can only ever credit once (replay -> 409, 0 plays)
//   Apple Pay: domain verification file serves 200 (live + free preview);
//     an Apple Pay token charges through the same /api/payments/charge
//     path as a card token and credits the same plays
//   Google Pay: a Google Pay token charges through the same path too
//     (no domain file or registration needed for Google Pay)
//   free-preview mode (no Square env): page loads, guesses free, charge 400s
//   /api/square-config never leaks the access token
// Usage: node test-payments.js   (exit 0 = all pass)
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DIR = __dirname;
const DB = path.join('/tmp', `stw247-test-${process.pid}.db`);
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

// ---- mock Square -----------------------------------------------------------
function startMockSquare() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v2/payments') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ errors: [{ code: 'NOT_FOUND' }] }));
      }
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch (e) { /* ignore */ }
      seen.push({
        auth: req.headers.authorization || '',
        version: req.headers['square-version'] || '',
        sourceId: parsed.source_id,
        amount: parsed.amount_money && parsed.amount_money.amount,
        currency: parsed.amount_money && parsed.amount_money.currency,
        locationId: parsed.location_id,
        idempotencyKey: parsed.idempotency_key,
      });
      const src = parsed.source_id;
      const pay = (id, status, amount) => ({
        payment: { id, status, receipt_url: `https://square.test/receipt/${id}`, amount_money: { amount, currency: 'USD' } },
      });
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (src === 'tok_ok_500') return send(200, pay('pay_ok500', 'COMPLETED', 500));
      if (src === 'tok_ok_500_b') return send(200, pay('pay_ok500b', 'COMPLETED', 500));
      if (src === 'tok_ok_10000') return send(200, pay('pay_ok10000', 'COMPLETED', 10000));
      // An Apple Pay token is just another one-time source ID to Square:
      // same charge path, same verification, same credits as a card token.
      if (src === 'tok_applepay_500') return send(200, pay('pay_apple500', 'COMPLETED', 500));
      // Same for Google Pay: another one-time source ID, same charge path.
      if (src === 'tok_googlepay_500') return send(200, pay('pay_google500', 'COMPLETED', 500));
      if (src === 'tok_declined') return send(402, { errors: [{ code: 'CARD_DECLINED', detail: 'Card declined.' }] });
      if (src === 'tok_wrong_amount') return send(200, pay('pay_wrong', 'COMPLETED', 9999));
      if (src === 'tok_pending') return send(200, pay('pay_pending', 'APPROVED', 500));
      return send(400, { errors: [{ code: 'BAD_REQUEST', detail: 'Unknown test token.' }] });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }));
  });
}

// ---- game server -----------------------------------------------------------
function startGame(envExtra) {
  return new Promise(async (resolve, reject) => {
    const port = await freePort();
    const env = { ...process.env, PORT: String(port), DB_PATH: DB, ...envExtra };
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

// ---- http helpers ----------------------------------------------------------
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
  const mock = await startMockSquare();
  const liveEnv = {
    SQUARE_APPLICATION_ID: 'test-app-id',
    SQUARE_LOCATION_ID: 'test-loc-id',
    SQUARE_ACCESS_TOKEN: 'test-access-token',
    SQUARE_API_BASE: `http://127.0.0.1:${mock.port}`,
    ADMIN_CODE: 'testadmin',
  };

  // ===== Phase 1: live (embedded) mode =====================================
  console.log('Phase 1 — embedded checkout (mock Square)');
  let game = await startGame(liveEnv);
  const P = game.port;

  let r = await api(P, 'GET', '/api/square-config');
  check('square-config enabled + returns public IDs', r.body.enabled === true
    && r.body.applicationId === 'test-app-id' && r.body.locationId === 'test-loc-id');
  check('square-config never leaks the access token',
    JSON.stringify(r.body).indexOf('test-access-token') === -1);

  r = await api(P, 'GET', '/api/state?playerToken=x');
  check('state reports mode=embedded, enabled', r.body.payments.mode === 'embedded' && r.body.payments.enabled === true);

  // Player A: $5 single -> 1 paid play
  const tokenA = 'test-player-a-0001';
  r = await api(P, 'POST', '/api/player', { playerToken: tokenA, name: 'Alice' });
  check('register player A', r.body.ok === true && r.body.playerToken === tokenA);
  const refA = r.body.referralCode;
  r = await api(P, 'POST', '/api/payments/charge', { playerToken: tokenA, name: 'Alice', kind: 'single', sourceId: 'tok_ok_500' });
  check('$5 charge confirms + credits 1 paid play', r.status === 200 && r.body.ok === true
    && r.body.status === 'confirmed' && r.body.paidCredits === 1 && r.body.bonusCredits === 0,
    JSON.stringify(r.body));

  // Player A: $100 bundle -> +20 paid, +2 bonus
  r = await api(P, 'POST', '/api/payments/charge', { playerToken: tokenA, name: 'Alice', kind: 'bundle', sourceId: 'tok_ok_10000' });
  check('$100 charge confirms + credits 22 plays', r.status === 200 && r.body.ok === true
    && r.body.paidCredits === 21 && r.body.bonusCredits === 2, JSON.stringify(r.body));

  // Declined card -> 402, 0 plays
  r = await api(P, 'POST', '/api/payments/charge', { playerToken: tokenA, name: 'Alice', kind: 'single', sourceId: 'tok_declined' });
  check('declined card -> 402 + no credits', r.status === 402 && r.body.ok === false, JSON.stringify(r.body));

  // Wrong amount from Square -> rejected, 0 plays
  r = await api(P, 'POST', '/api/payments/charge', { playerToken: tokenA, name: 'Alice', kind: 'single', sourceId: 'tok_wrong_amount' });
  check('wrong amount -> rejected + no credits', r.body.ok === false && r.body.reason === 'amount_mismatch', JSON.stringify(r.body));

  // APPROVED but not COMPLETED -> rejected, 0 plays
  r = await api(P, 'POST', '/api/payments/charge', { playerToken: tokenA, name: 'Alice', kind: 'single', sourceId: 'tok_pending' });
  check('not-completed payment -> rejected + no credits', r.body.ok === false && r.body.reason === 'not_completed', JSON.stringify(r.body));

  r = await api(P, 'GET', `/api/state?playerToken=${tokenA}`);
  check('credits unchanged by failed charges (21 paid / 2 bonus)',
    r.body.me && r.body.me.paidCredits === 21 && r.body.me.bonusCredits === 2, JSON.stringify(r.body.me));

  // Mock saw proper Square requests (auth + idempotency + location)
  check('server sent auth + idempotency key + location to Square',
    mock.seen.length >= 5 && mock.seen.every((s) => s.auth === 'Bearer test-access-token'
      && typeof s.idempotencyKey === 'string' && s.idempotencyKey.length > 10
      && s.locationId === 'test-loc-id' && s.currency === 'USD'),
    `seen=${mock.seen.length}`);

  // Apple Pay: the domain verification file serves with the exact
  // contents Square issued. (The Apple Pay charge test lives in Phase 2:
  // Phase 1 already made 5 charge posts, and the server throttles
  // /api/payments/charge to 5 per IP per minute.)
  const appleFile = fs.readFileSync(
    path.join(DIR, 'public', '.well-known', 'apple-developer-merchantid-domain-association'), 'utf8');
  const ap = await page(P, '/.well-known/apple-developer-merchantid-domain-association');
  check('Apple Pay domain file serves 200 with the Square file contents',
    ap.status === 200 && ap.text === appleFile, `status=${ap.status} len=${ap.text.length}`);

  // Admin stats (live mode)
  r = await api(P, 'POST', '/api/admin/stats', { code: 'testadmin' });
  check('admin stats loads, payments live, recent includes confirmed',
    r.body.ok === true && r.body.paymentsLive === true
    && Array.isArray(r.body.recent) && r.body.recent.some((p) => p.status === 'confirmed' && p.payment_id === 'pay_ok500'),
    JSON.stringify(r.body).slice(0, 200));
  r = await api(P, 'POST', '/api/admin/stats', { code: 'wrong' });
  check('admin stats rejects wrong code', r.status === 401);

  // Old claim endpoint is gone
  r = await api(P, 'POST', '/api/payments/claim', { playerToken: tokenA, kind: 'single' });
  check('old /api/payments/claim endpoint is retired (404)', r.status === 404, `status=${r.status}`);

  await stopGame(game);

  // ===== Phase 2: referral + replay guard + paid guess ======================
  // (fresh process resets the in-memory charge throttle; same DB keeps credits)
  console.log('Phase 2 — referral reward, replay guard, paid guess');
  game = await startGame(liveEnv);
  const P2 = game.port;

  // Player B joins via A's referral link and pays $5 -> B gets 1 play, A gets 1 free play
  const tokenB = 'test-player-b-0002';
  r = await api(P2, 'POST', '/api/player', { playerToken: tokenB, name: 'Bob', ref: refA });
  check('register player B with referral', r.body.ok === true);
  r = await api(P2, 'POST', '/api/payments/charge', { playerToken: tokenB, name: 'Bob', kind: 'single', sourceId: 'tok_ok_500_b' });
  check('B first $5 charge confirms + credits 1 paid play',
    r.status === 200 && r.body.ok === true && r.body.paidCredits === 1, JSON.stringify(r.body));
  r = await api(P2, 'GET', `/api/state?playerToken=${tokenA}`);
  check('A earned 1 referral free play when B first paid', r.body.me && r.body.me.bonusCredits === 3,
    JSON.stringify(r.body.me));

  // Replay guard: charge the SAME successful token again for a new player C.
  // The mock returns the same payment ID; the server must refuse to credit.
  const tokenC = 'test-player-c-0003';
  await api(P2, 'POST', '/api/player', { playerToken: tokenC, name: 'Carol' });
  r = await api(P2, 'POST', '/api/payments/charge', { playerToken: tokenC, name: 'Carol', kind: 'bundle', sourceId: 'tok_ok_10000' });
  check('replayed Square payment ID -> 409 + 0 plays', r.status === 409 && r.body.ok === false, JSON.stringify(r.body));
  r = await api(P2, 'GET', `/api/state?playerToken=${tokenC}`);
  check('C has 0 credits after replay attempt', r.body.me && r.body.me.paidCredits === 0 && r.body.me.bonusCredits === 0,
    JSON.stringify(r.body.me));

  // Apple Pay: a token from the Apple Pay sheet is just another one-time
  // source ID to Square — same charge path, same verification, same
  // credits as a card token (fresh player D, counts stay independent).
  const tokenD = 'test-player-d-0004';
  await api(P2, 'POST', '/api/player', { playerToken: tokenD, name: 'Dana' });
  r = await api(P2, 'POST', '/api/payments/charge', { playerToken: tokenD, name: 'Dana', kind: 'single', sourceId: 'tok_applepay_500' });
  check('Apple Pay token charges + credits 1 paid play (same charge path)',
    r.status === 200 && r.body.ok === true && r.body.status === 'confirmed'
    && r.body.paidCredits === 1 && r.body.bonusCredits === 0, JSON.stringify(r.body));

  // Google Pay: same story — one-time source ID, same charge path,
  // same credits (fresh player E).
  const tokenE = 'test-player-e-0005';
  await api(P2, 'POST', '/api/player', { playerToken: tokenE, name: 'Erin' });
  r = await api(P2, 'POST', '/api/payments/charge', { playerToken: tokenE, name: 'Erin', kind: 'single', sourceId: 'tok_googlepay_500' });
  check('Google Pay token charges + credits 1 paid play (same charge path)',
    r.status === 200 && r.body.ok === true && r.body.status === 'confirmed'
    && r.body.paidCredits === 1 && r.body.bonusCredits === 0, JSON.stringify(r.body));

  // Paid guess: A spends a bonus credit first (free play), counts as bonus
  r = await api(P2, 'POST', '/api/guess', { playerToken: tokenA, name: 'Alice', guess: 42 });
  check('paid-mode guess succeeds', r.status === 200 && r.body.ok === true && r.body.guess === 42, JSON.stringify(r.body));
  check('guess spent a bonus credit first', r.body.creditType === 'bonus' && r.body.bonusCredits === 2 && r.body.paidCredits === 21,
    JSON.stringify(r.body));

  await stopGame(game);

  // ===== Phase 3: free-preview mode (no Square env) =========================
  console.log('Phase 3 — free preview (no Square env vars)');
  game = await startGame({ ADMIN_CODE: 'testadmin' });
  const P3 = game.port;

  r = await api(P3, 'GET', '/api/square-config');
  check('free preview: square-config disabled', r.body.enabled === false);
  r = await api(P3, 'GET', '/api/state?playerToken=x');
  check('free preview: state reports mode=free, not enabled',
    r.body.payments.mode === 'free' && r.body.payments.enabled === false);
  r = await api(P3, 'POST', '/api/payments/charge', { playerToken: tokenA, name: 'Alice', kind: 'single', sourceId: 'tok_ok_500' });
  check('free preview: charge endpoint refuses (400)', r.status === 400 && r.body.ok === false, JSON.stringify(r.body));
  r = await api(P3, 'POST', '/api/guess', { playerToken: tokenA, name: 'Alice', guess: 7 });
  check('free preview: guess works free', r.status === 200 && r.body.ok === true && r.body.creditType === 'bonus',
    JSON.stringify(r.body));
  const home = await page(P3, '/');
  check('game page loads (200)', home.status === 200);
  check('page has embedded checkout UI incl. wallet buttons, no claim UI',
    home.text.includes('checkoutBox') && home.text.includes('card-container')
    && home.text.includes('apple-pay-button') && home.text.includes('google-pay-button')
    && !home.text.includes('claimBox') && !home.text.includes('/api/payments/claim'),
    'page still references the old claim flow');
  const appJs = await page(P3, '/app.js');
  check('app.js posts to /api/payments/charge, not /claim, and wires Apple Pay + Google Pay',
    appJs.text.includes('/api/payments/charge') && !appJs.text.includes('/api/payments/claim')
    && appJs.text.includes('applePay') && appJs.text.includes('apple-pay-button')
    && appJs.text.includes('googlePay') && appJs.text.includes('google-pay-button'));
  const admin = await page(P3, '/admin');
  check('admin page loads (200)', admin.status === 200);
  // The domain file is public and static: it serves in free-preview mode
  // too, so Apple can verify the domain before payments ever go live.
  const ap3 = await page(P3, '/.well-known/apple-developer-merchantid-domain-association');
  check('free preview: Apple Pay domain file still serves 200',
    ap3.status === 200 && ap3.text === appleFile, `status=${ap3.status}`);

  await stopGame(game);
  mock.server.close();
  try { fs.unlinkSync(DB); } catch (e) {}
  try { fs.unlinkSync(DB + '-wal'); } catch (e) {}
  try { fs.unlinkSync(DB + '-shm'); } catch (e) {}

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('TEST RUNNER ERROR:', e); process.exit(1); });

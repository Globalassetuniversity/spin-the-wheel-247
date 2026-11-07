// test-chat.js — live-chat tests for Spin the Wheel 24/7.
// Runs the real server in free-preview mode (no Square env needed).
// Verifies:
//   post a message -> it comes back on GET /api/chat
//   HTML in a message is escaped on the way out (no raw <script>)
//   messages over 200 chars are rejected (400)
//   one message per player every 3 seconds (second quick post -> 429)
//   emoji reactions toggle on/off and counts show up in GET
//   invalid emoji -> 400; reacting to a missing message -> 404
//   history prunes to the latest 100 messages
//   the Wheel posts a spin announcement in chat when a round closes
//   the game page serves the chat panel (chatList / chatForm / shouts)
// Usage: node test-chat.js   (exit 0 = all pass)
const net = require('node:net');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DIR = __dirname;
const DB = path.join('/tmp', `stw247-chat-test-${process.pid}.db`);
const DB2 = path.join('/tmp', `stw247-chat-test2-${process.pid}.db`);
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

function startGame(envExtra, dbPath) {
  return new Promise(async (resolve, reject) => {
    const port = await freePort();
    const env = { ...process.env, PORT: String(port), DB_PATH: dbPath || DB, ADMIN_CODE: 'testadmin', ...envExtra };
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
  console.log('Phase 1 — post, fetch, escape, limits, reactions');
  let game = await startGame({});
  let P = game.port;

  let r = await api(P, 'GET', '/api/chat');
  check('chat starts empty', r.body.ok === true && Array.isArray(r.body.messages) && r.body.messages.length === 0,
    JSON.stringify(r.body));

  // Player A posts a message
  const tokenA = 'test-chat-a-0001';
  await api(P, 'POST', '/api/player', { playerToken: tokenA, name: 'Alice' });
  r = await api(P, 'POST', '/api/chat', { playerToken: tokenA, name: 'Alice', text: 'Hello wheel! 🎉' });
  check('post a message -> 200 + id', r.status === 200 && r.body.ok === true && typeof r.body.id === 'number',
    JSON.stringify(r.body));
  const msgId = r.body.id;

  r = await api(P, 'GET', '/api/chat');
  check('message comes back on GET', r.body.messages.length === 1
    && r.body.messages[0].name === 'Alice' && r.body.messages[0].text === 'Hello wheel! 🎉',
    JSON.stringify(r.body.messages));

  // HTML injection is escaped on the way out (different player, no rate-limit clash)
  const tokenB = 'test-chat-b-0002';
  await api(P, 'POST', '/api/player', { playerToken: tokenB, name: 'Bob' });
  r = await api(P, 'POST', '/api/chat', { playerToken: tokenB, name: 'Bob', text: '<script>alert("x")</script> <b>bold</b>' });
  check('HTML message posts (stored, not rejected)', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
  r = await api(P, 'GET', '/api/chat');
  const bobMsg = r.body.messages.find((m) => m.name === 'Bob');
  check('HTML is escaped in GET output (no raw <script>)',
    !!bobMsg && bobMsg.text.indexOf('<script>') === -1 && bobMsg.text.indexOf('&lt;script&gt;') !== -1
    && bobMsg.text.indexOf('&lt;b&gt;') !== -1, bobMsg ? bobMsg.text : 'no Bob message');

  // Too long -> 400
  const tokenC = 'test-chat-c-0003';
  r = await api(P, 'POST', '/api/chat', { playerToken: tokenC, name: 'Carol', text: 'x'.repeat(201) });
  check('201-char message rejected (400)', r.status === 400 && r.body.ok === false, JSON.stringify(r.body));

  // Empty -> 400
  r = await api(P, 'POST', '/api/chat', { playerToken: tokenC, name: 'Carol', text: '   ' });
  check('empty message rejected (400)', r.status === 400 && r.body.ok === false, JSON.stringify(r.body));

  // Rate limit: same player, two quick posts -> second is 429
  const tokenD = 'test-chat-d-0004';
  await api(P, 'POST', '/api/player', { playerToken: tokenD, name: 'Dana' });
  r = await api(P, 'POST', '/api/chat', { playerToken: tokenD, name: 'Dana', text: 'first!' });
  check('first quick message posts', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
  r = await api(P, 'POST', '/api/chat', { playerToken: tokenD, name: 'Dana', text: 'second, too soon' });
  check('second message within 3s -> 429', r.status === 429 && r.body.ok === false, JSON.stringify(r.body));

  // Reactions: add, see it, remove, see it gone
  r = await api(P, 'POST', '/api/chat/react', { playerToken: tokenB, messageId: msgId, emoji: '🎉' });
  check('react 🎉 -> reacted true', r.status === 200 && r.body.ok === true && r.body.reacted === true,
    JSON.stringify(r.body));
  r = await api(P, 'GET', `/api/chat?playerToken=${tokenB}`);
  const withReact = r.body.messages.find((m) => m.id === msgId);
  check('GET shows the reaction count + mine',
    !!withReact && withReact.reactions.some((x) => x.emoji === '🎉' && x.count === 1 && x.mine === true),
    JSON.stringify(withReact && withReact.reactions));
  r = await api(P, 'POST', '/api/chat/react', { playerToken: tokenB, messageId: msgId, emoji: '🎉' });
  check('react again -> toggles off', r.status === 200 && r.body.ok === true && r.body.reacted === false,
    JSON.stringify(r.body));
  r = await api(P, 'GET', `/api/chat?playerToken=${tokenB}`);
  const unReacted = r.body.messages.find((m) => m.id === msgId);
  check('GET shows the reaction gone after toggle-off',
    !!unReacted && !unReacted.reactions.some((x) => x.emoji === '🎉'),
    JSON.stringify(unReacted && unReacted.reactions));

  // Invalid emoji -> 400; missing message -> 404
  r = await api(P, 'POST', '/api/chat/react', { playerToken: tokenB, messageId: msgId, emoji: '🤔' });
  check('emoji outside the allowlist -> 400', r.status === 400 && r.body.ok === false, JSON.stringify(r.body));
  r = await api(P, 'POST', '/api/chat/react', { playerToken: tokenB, messageId: 999999, emoji: '🎉' });
  check('reacting to a missing message -> 404', r.status === 404 && r.body.ok === false, JSON.stringify(r.body));

  // since= polling: only newer messages come back
  r = await api(P, 'GET', `/api/chat?since=${msgId}`);
  check('since= returns only newer messages',
    r.body.messages.length > 0 && r.body.messages.every((m) => m.id > msgId),
    `got ${r.body.messages.length}`);

  // Pruning: 105 more messages from fresh tokens -> history stays at 100.
  // The per-IP throttle allows 20 chat posts/minute, so the server is
  // restarted (same DB) between batches of 20 — the throttle resets.
  await stopGame(game);
  game = await startGame({});
  P = game.port;
  for (let batch = 0; batch < 6; batch++) {
    for (let i = 0; i < 20; i++) {
      const n = batch * 20 + i;
      if (n >= 105) break;
      const t = `test-chat-prune-${String(n).padStart(3, '0')}`;
      await api(P, 'POST', '/api/chat', { playerToken: t, name: `P${n}`, text: `prune test ${n}` });
    }
    if (batch < 5) {
      await stopGame(game);
      game = await startGame({});
      P = game.port;
    }
  }
  r = await api(P, 'GET', '/api/chat');
  check('history prunes to the latest 100',
    r.body.messages.length === 100 && r.body.messages[0].text === 'prune test 5'
    && r.body.messages[99].text === 'prune test 104',
    `got ${r.body.messages.length}, first=${r.body.messages[0] && r.body.messages[0].text}`);

  // The game page serves the chat panel
  const home = await page(P, '/');
  check('page has the chat panel (list, form, shouts)',
    home.status === 200 && home.text.includes('id="chatList"') && home.text.includes('id="chatForm"')
    && home.text.includes('id="chatShouts"') && home.text.includes('id="chatInput"'),
    `status=${home.status}`);
  const appJs = await page(P, '/app.js');
  check('app.js wires chat fetch/post/react + shout buttons',
    appJs.text.includes('/api/chat') && appJs.text.includes('/api/chat/react')
    && appJs.text.includes('chatShouts') && appJs.text.includes('chatMsgHtml'));

  await stopGame(game);

  // ===== Phase 2: the Wheel announces a spin in chat ======================
  // 1-minute rounds (ROUND_MINUTES only takes whole minutes) so a round
  // closes while we watch.
  console.log('Phase 2 — Wheel spin announcement');
  const game2 = await startGame({ ROUND_MINUTES: '1' }, DB2);
  const P2 = game2.port;
  await sleep(75000); // round ends 60s after start; the 5s tick closes it
  r = await api(P2, 'GET', '/api/chat');
  const sysMsg = r.body.messages.find((m) => m.system === true);
  check('Wheel posts a spin announcement in chat',
    !!sysMsg && sysMsg.name === '🎡 Wheel' && /spun \d+/.test(sysMsg.text),
    JSON.stringify(r.body.messages));
  await stopGame(game2);

  for (const f of [DB, DB + '-wal', DB + '-shm', DB2, DB2 + '-wal', DB2 + '-shm']) {
    try { fs.unlinkSync(f); } catch (e) {}
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('TEST RUNNER ERROR:', e); process.exit(1); });

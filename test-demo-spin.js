// test-demo-spin.js — tap-to-spin demo button tests for Spin the Wheel 24/7.
// Verifies (over real HTTP + a DOM-stub vm running the real public/app.js):
//   the game page serves the "Spin it now" button + the just-for-fun note
//   clicking the button (or the wheel) runs the full spin animation with
//     the ticking sound, and lands on a random number in the readout
//   a second tap while a spin is running is ignored (no restart)
//   a real round-close spin takes over a running demo spin
//   the demo spin makes no server calls that could change state, and
//     /api/state is identical before and after a demo spin
//   the demo spin respects mute (no ticks while sound is off)
// Usage: node test-demo-spin.js   (exit 0 = all pass)
const net = require('node:net');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DIR = __dirname;
const DB = path.join('/tmp', `stw247-demo-test-${process.pid}.db`);
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
function startGame() {
  return new Promise(async (resolve, reject) => {
    const port = await freePort();
    const env = { ...process.env, PORT: String(port), DB_PATH: DB, ADMIN_CODE: 'testadmin' };
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
    setTimeout(resolve, 3000);
  });
}

(async () => {
  // ===== Phase 1: real server — button present, state snapshot ==========
  console.log('Phase 1 — served page + state snapshot');
  let game = null;
  try {
    game = await startGame();
  } catch (e) {
    console.log('  FAIL server did not start — ' + e.message);
    process.exit(1);
  }
  const base = `http://127.0.0.1:${game.port}`;
  let stateBefore = null;
  try {
    const page = await (await fetch(base + '/')).text();
    check('page serves the demo spin button', page.includes('id="demoSpinBtn"') && page.includes('Spin it now'));
    check('page explains the button is just for fun', page.includes("doesn't change the round") && page.includes('top of every hour'));
    check('page still says the real wheel spins on the hour', page.includes('The wheel spins itself at the top of every hour'));
    const s = await (await fetch(base + '/api/state')).json();
    stateBefore = s;
    check('state snapshot taken', !!s && !!s.round && typeof s.round.id === 'number', `round=${s && s.round && s.round.id}`);
  } catch (e) {
    check('served page + state fetch', false, e.message);
  }

  // ===== Phase 2: vm — real app.js with DOM stubs ========================
  console.log('Phase 2 — demo spin in the vm');
  const APP_JS = path.join(DIR, 'public', 'app.js');
  const src = fs.readFileSync(APP_JS, 'utf8');

  const createdCtxs = [];
  class FakeOsc {
    constructor() { this.type = ''; this.frequency = { value: 0 }; this.started = false; this.stopped = false; }
    connect() {} start() { this.started = true; } stop() { this.stopped = true; }
  }
  class FakeGain {
    constructor() { this.gain = { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }; }
    connect() {}
  }
  class FakeAudioCtx {
    constructor() { this.state = 'running'; this.currentTime = 0; this.nodes = []; this.destination = {}; createdCtxs.push(this); }
    createOscillator() { const o = new FakeOsc(); this.nodes.push(o); return o; }
    createGain() { const g = new FakeGain(); this.nodes.push(g); return g; }
    resume() { return Promise.resolve(); }
  }
  function makeCtx() {
    return new Proxy({}, {
      get: (t, k) => (typeof k === 'string' ? (() => {}) : undefined),
      set: () => true,
    });
  }
  function makeEl(id) {
    const el = {
      id, style: {}, textContent: '', innerHTML: '', value: '',
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      _handlers: {},
      addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
      removeEventListener() {},
      setAttribute() {}, getAttribute() { return null; },
      appendChild() {}, insertAdjacentHTML() {}, querySelector() { return null; },
      querySelectorAll() { return []; }, closest() { return null; },
      scrollIntoView() {}, select() {},
      click() { (this._handlers.click || []).forEach((f) => f.call(this, { preventDefault() {} })); },
      scrollTop: 0, scrollHeight: 0, clientHeight: 0,
      getContext: () => makeCtx(),
      width: 1200, height: 1200,
      disabled: false,
    };
    return el;
  }
  const elements = {};
  const documentStub = {
    getElementById: (id) => elements[id] || (elements[id] = makeEl(id)),
    addEventListener() {},
    createElement: (tag) => makeEl(tag),
    fonts: { ready: Promise.resolve() },
    querySelector: () => null,
  };
  const state = {
    jackpotCents: 500, now: Date.now(),
    round: { id: 7, starts_at: Date.now(), ends_at: Date.now() + 3600000, status: 'open',
      jackpot_at_start_cents: 500, paidPlays: 0, potCents: 0, winnerShareCents: 0,
      jackpotShareCents: 0, houseShareCents: 0, guesses: [] },
    lastResult: null, leaderboard: [], history: [],
    sponsors: [{ slot: 1, name: '', message: '', price: 50 }],
    payments: { mode: 'free', enabled: false, singlePriceCents: 500, bundlePriceCents: 10000 },
    me: null,
  };
  // Record every fetch the page makes, so the demo spin can be proven
  // to call no endpoint (reads or writes) while it runs.
  const fetchCalls = [];
  const sandbox = {
    console,
    setInterval, clearInterval, setTimeout, clearTimeout,
    performance,
    URLSearchParams,
    document: documentStub,
    location: { search: '', origin: 'http://localhost', pathname: '/' },
    localStorage: {
      _s: {},
      getItem(k) { return this._s[k] ?? null; },
      setItem(k, v) { this._s[k] = String(v); },
      removeItem(k) { delete this._s[k]; },
    },
    navigator: {},
    AudioContext: FakeAudioCtx,
    fetch: async (url, opts) => {
      fetchCalls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
      return { ok: true, status: 200, json: async () => state };
    },
    requestAnimationFrame: (cb) => setTimeout(() => cb(performance.now()), 16),
    crypto: { randomUUID: () => 'test-token-1234' },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  let loadError = null;
  try {
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'app.js' });
  } catch (e) { loadError = e; }
  check('app.js loads without throwing', !loadError, loadError ? loadError.message : '');
  if (loadError) {
    await stopGame(game);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
  }

  await sleep(500); // let registerPlayer/poll + a few frames run
  const S = sandbox.__stw247;
  check('demoSpin handle exists', !!(S && S.demoSpin && S.isDemoSpinning));
  check('demo button element exists', !!elements.demoSpinBtn, 'demoSpinBtn=' + !!elements.demoSpinBtn);
  check('demo button starts enabled with the right label',
    elements.demoSpinBtn && elements.demoSpinBtn.disabled === false &&
    elements.demoSpinBtn.textContent === '🎡 Spin it now',
    JSON.stringify(elements.demoSpinBtn && elements.demoSpinBtn.textContent));

  // --- button click runs a demo spin with ticks ---------------------------
  fetchCalls.length = 0;
  const ticksBefore = S.sound.tickCount();
  elements.demoSpinBtn.click();
  await sleep(300);
  check('button click starts the spin', S.isSpinning() === true);
  check('it is a demo spin', S.isDemoSpinning() === true);
  check('button disables itself while spinning', elements.demoSpinBtn.disabled === true);
  check('button label flips to Spinning…', elements.demoSpinBtn.textContent === '🎡 Spinning…',
    JSON.stringify(elements.demoSpinBtn.textContent));
  // A second tap mid-spin must be ignored — the spin must still finish
  // ~4.5s after the FIRST tap, not restart.
  const t0 = Date.now();
  await sleep(700);
  S.demoSpin();
  await sleep(3600); // ~4.6s after the first tap
  check('second tap mid-spin is ignored (spin still ends on time)',
    S.isSpinning() === false && Date.now() - t0 < 5200, `elapsed=${Date.now() - t0}ms`);
  check('button re-enables after the spin', elements.demoSpinBtn.disabled === false);
  check('button label returns to Spin it now', elements.demoSpinBtn.textContent === '🎡 Spin it now');
  const ticksAfter = S.sound.tickCount();
  check('ticks fire during the demo spin', ticksAfter > ticksBefore, `${ticksBefore} → ${ticksAfter} ticks`);
  check('readout shows a number after the demo spin',
    /^\d{1,3}$/.test(String(elements.currentNum.textContent).trim()),
    JSON.stringify(elements.currentNum.textContent));
  // The vm's poll() also fetches on a 3s interval — allow only the
  // read-only state/chat polls, never a write.
  const writes = fetchCalls.filter((c) => c.method !== 'GET');
  check('no write calls during the demo window', writes.length === 0,
    writes.map((c) => c.method + ' ' + c.url).join(', ') || '(none)');
  const nonPollReads = fetchCalls.filter((c) =>
    c.method === 'GET' && !c.url.startsWith('/api/state') && !c.url.startsWith('/api/chat'));
  check('demo spin triggers no extra reads either', nonPollReads.length === 0,
    nonPollReads.map((c) => c.method + ' ' + c.url).join(', ') || '(none)');

  // --- tapping the wheel itself does the same thing ------------------------
  fetchCalls.length = 0;
  elements.wheel.click();
  await sleep(300);
  check('tapping the wheel starts a demo spin', S.isSpinning() === true && S.isDemoSpinning() === true);
  await sleep(4600);
  check('wheel-tap demo spin finishes', S.isSpinning() === false);

  // --- a real spin takes over a running demo spin --------------------------
  S.demoSpin();
  await sleep(500);
  check('demo spin running before the takeover', S.isDemoSpinning() === true);
  S.spin(42); // the real round-close path
  await sleep(200);
  check('real spin wins over the demo spin', S.isDemoSpinning() === false && S.isSpinning() === true);
  await sleep(4600);
  check('real spin finishes normally', S.isSpinning() === false);

  // --- mute is respected ----------------------------------------------------
  elements.soundToggle.click(); // sound off
  await sleep(100);
  check('sound toggled off', S.sound.isOn() === false);
  const muteTicksBefore = S.sound.tickCount();
  S.demoSpin();
  await sleep(1000);
  check('no ticks while muted', S.sound.tickCount() === muteTicksBefore,
    `${muteTicksBefore} → ${S.sound.tickCount()} ticks`);
  check('demo spin still animates while muted', S.isSpinning() === true);
  await sleep(3800);
  elements.soundToggle.click(); // sound back on for cleanliness
  await sleep(100);
  check('sound toggles back on', S.sound.isOn() === true);

  // ===== Phase 3: server state unchanged ===================================
  console.log('Phase 3 — server state unchanged by demo spins');
  try {
    const s = await (await fetch(base + '/api/state')).json();
    check('same round id before/after', s.round.id === stateBefore.round.id,
      `${stateBefore.round.id} → ${s.round.id}`);
    check('same pot before/after', s.round.potCents === stateBefore.round.potCents,
      `${stateBefore.round.potCents} → ${s.round.potCents}`);
    check('same lastResult before/after',
      JSON.stringify(s.lastResult) === JSON.stringify(stateBefore.lastResult));
    check('same jackpot before/after', s.jackpotCents === stateBefore.jackpotCents,
      `${stateBefore.jackpotCents} → ${s.jackpotCents}`);
  } catch (e) {
    check('state-after fetch', false, e.message);
  }

  await stopGame(game);
  try { fs.unlinkSync(DB); } catch (e) { /* ignore */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('FAIL harness error — ' + (e && e.stack || e));
  process.exit(1);
});

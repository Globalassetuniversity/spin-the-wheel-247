// DOM-stub smoke test for wheel sounds: loads the real public/app.js in a
// Node vm with stubbed DOM + a fake AudioContext, then exercises the
// sound engine, triggers a real spin animation, and flips the mute toggle.
// Usage: node test-sounds.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const APP_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'app.js');
const src = fs.readFileSync(APP_JS, 'utf8');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

// --- fake AudioContext: records every oscillator/gain created ---
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

// --- DOM stubs ---
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
    scrollIntoView() {}, select() {}, click() { (this._handlers.click || []).forEach((f) => f.call(this, { preventDefault() {} })); },
    scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    getContext: () => makeCtx(),
    width: 1200, height: 1200,
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

// --- plausible /api/state + /api/player payload ---
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
  fetch: async () => ({ ok: true, status: 200, json: async () => state }),
  requestAnimationFrame: (cb) => setTimeout(() => cb(performance.now()), 16),
  crypto: { randomUUID: () => 'test-token-1234' },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let loadError = null;
try {
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'app.js' });
} catch (e) {
  loadError = e;
}
check('app.js loads without throwing', !loadError, loadError ? loadError.message : '');
if (loadError) { console.log(`\n0 passed, ${results.filter((r) => !r.ok).length} failed`); process.exit(1); }

await sleep(500); // let registerPlayer/poll + a few frames run

const S = sandbox.__stw247;
check('sound test handle exists', !!(S && S.sound && S.sound.playTick));
check('sound is on by default', S.sound.isOn() === true);
check('toggle starts ON', elements.soundToggle.textContent === '🔊 Sound on', JSON.stringify(elements.soundToggle.textContent));

// Exercise every sound function against the fake AudioContext.
let soundErr = null;
try {
  S.sound.ensureAudio();
  S.sound.playTick(0.8);
  S.sound.playBlip();
  S.sound.playResultSound({ winner_exact: 1, winner_names: 'Test' });
  S.sound.playResultSound({ winner_names: 'Test', winner_guess: 42 });
  S.sound.playResultSound({ winner_names: null });
  S.sound.playResultSound(null);
} catch (e) { soundErr = e; }
check('all sound functions run without errors', !soundErr, soundErr ? soundErr.message : '');

// Oscillators were actually synthesized (not just no-ops): the tick
// counter moved, which proves playTick ran its audio path.
check('tick counter moved after sounds', (() => {
  return S.sound.tickCount() >= 1;
})(), `tickCount=${S.sound.tickCount()}`);
check('oscillators actually created + started', (() => {
  const ctx = createdCtxs[0];
  if (!ctx) return false;
  const oscs = ctx.nodes.filter((n) => n instanceof FakeOsc);
  return oscs.length > 0 && oscs.every((o) => o.started);
})(), `oscillators=${createdCtxs[0] ? createdCtxs[0].nodes.filter((n) => n instanceof FakeOsc).length : 0}`);

// Trigger a REAL spin animation and confirm ratchet ticks fire over time.
const ticksBefore = S.sound.tickCount();
S.spin(42);
await sleep(800);
check('spin animation starts', S.isSpinning() === true);
await sleep(4500);
const ticksAfter = S.sound.tickCount();
check('ticks fire during a real spin', ticksAfter > ticksBefore, `${ticksBefore} → ${ticksAfter} ticks`);
check('spin animation finishes', S.isSpinning() === false);

// Mute toggle: off persists, on restores.
elements.soundToggle.click();
await sleep(100);
check('toggle switches to OFF', elements.soundToggle.textContent === '🔇 Sound off', JSON.stringify(elements.soundToggle.textContent));
check('mute choice saved to localStorage', sandbox.localStorage.getItem('stw247_sound') === 'off');
check('sound reports off', S.sound.isOn() === false);
elements.soundToggle.click();
await sleep(100);
check('toggle switches back to ON', elements.soundToggle.textContent === '🔊 Sound on');
check('unmute saved to localStorage', sandbox.localStorage.getItem('stw247_sound') === 'on');

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

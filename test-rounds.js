// test-rounds.js — round timing checks: rounds are 1 minute, aligned to
// minute boundaries on the America/New_York clock (Will approved Nov 7,
// 2026 — was 5 minutes before, hourly before that). Run: node test-rounds.js
const assert = require('node:assert');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok — ${name}`);
}

const game = require('./game.js');
const et = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });

// 2026-11-07 is EST (UTC-5). 11:52:30 ET = 16:52:30 UTC.
check('mid-round start ends at the next ET minute boundary (11:52:30 -> 11:53:00)', () => {
  const start = Date.UTC(2026, 10, 7, 16, 52, 30);
  const end = game.computeRoundEnd(start);
  assert.strictEqual(et(end), '11/7/2026, 11:53:00');
  assert.ok(end - start <= 60 * 1000, 'round is never longer than 1 minute');
});

check('a start exactly on a boundary gets a full 1-minute round (11:53 -> 11:54)', () => {
  const start = Date.UTC(2026, 10, 7, 16, 53, 0);
  assert.strictEqual(game.computeRoundEnd(start) - start, 60 * 1000);
});

check('alignment holds in EDT too (15:03 -> 15:04)', () => {
  const start = Date.UTC(2026, 6, 4, 19, 3, 0); // 2026-07-04 15:03 ET
  assert.strictEqual(et(game.computeRoundEnd(start)), '7/4/2026, 15:04:00');
});

check('default round length is 1 minute', () => {
  assert.strictEqual(game.roundLengthMs(), 60 * 1000);
});

check('ROUND_MINUTES override still gives fixed-length rounds (local testing)', () => {
  process.env.ROUND_MINUTES = '2';
  try {
    const start = Date.UTC(2026, 10, 7, 16, 52, 30);
    assert.strictEqual(game.computeRoundEnd(start) - start, 2 * 60 * 1000);
    assert.strictEqual(game.roundLengthMs(), 2 * 60 * 1000);
  } finally {
    delete process.env.ROUND_MINUTES;
  }
});

console.log(`\ntest-rounds: ${passed}/5 passed`);

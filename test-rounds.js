// test-rounds.js — round timing checks: rounds are 5 minutes, aligned to
// 5-minute boundaries on the America/New_York clock (Will approved Nov 7,
// 2026 — was hourly before). Run: node test-rounds.js
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
check('mid-round start ends at the next 5-minute ET boundary (11:52:30 -> 11:55:00)', () => {
  const start = Date.UTC(2026, 10, 7, 16, 52, 30);
  const end = game.computeRoundEnd(start);
  assert.strictEqual(et(end), '11/7/2026, 11:55:00');
  assert.ok(end - start <= 5 * 60 * 1000, 'round is never longer than 5 minutes');
});

check('a start exactly on a boundary gets a full 5-minute round (11:55 -> 12:00)', () => {
  const start = Date.UTC(2026, 10, 7, 16, 55, 0);
  assert.strictEqual(game.computeRoundEnd(start) - start, 5 * 60 * 1000);
});

check('alignment holds in EDT too (15:03 -> 15:05)', () => {
  const start = Date.UTC(2026, 6, 4, 19, 3, 0); // 2026-07-04 15:03 ET
  assert.strictEqual(et(game.computeRoundEnd(start)), '7/4/2026, 15:05:00');
});

check('default round length is 5 minutes', () => {
  assert.strictEqual(game.roundLengthMs(), 5 * 60 * 1000);
});

check('ROUND_MINUTES override still gives fixed-length rounds (local testing)', () => {
  process.env.ROUND_MINUTES = '1';
  try {
    const start = Date.UTC(2026, 10, 7, 16, 52, 30);
    assert.strictEqual(game.computeRoundEnd(start) - start, 60 * 1000);
    assert.strictEqual(game.roundLengthMs(), 60 * 1000);
  } finally {
    delete process.env.ROUND_MINUTES;
  }
});

console.log(`\ntest-rounds: ${passed}/5 passed`);

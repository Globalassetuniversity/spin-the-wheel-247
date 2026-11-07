// square.js — Square Payments API (embedded checkout, Web Payments SDK).
// The player enters their card right on the game page; the browser
// tokenizes it with Square's SDK and sends only the one-time source ID
// (nonce) to this server. The server charges it here via POST /v2/payments.
//
// Secrets stay server-side: SQUARE_ACCESS_TOKEN is read from env only
// (Will connects it through the secure flow; never in chat). The public
// Application ID and Location ID are served to the page by
// GET /api/square-config — those two are public identifiers, not secrets.
//
// A payment is only trusted when Square says status COMPLETED, currency
// USD, and the amount equals the expected amount exactly (integer cents).
// Anything else credits NOTHING. A Square payment ID can only ever
// credit once — see confirmPayment() in server.js.
const SQUARE_API = process.env.SQUARE_API_BASE || 'https://connect.squareup.com';
const SQUARE_VERSION = process.env.SQUARE_VERSION || '2025-04-16';

function squareHeaders() {
  return {
    Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
    'Square-Version': SQUARE_VERSION,
    'Content-Type': 'application/json',
  };
}

// Charge a tokenized card (sourceId from the Web Payments SDK) for exactly
// amountCents. idempotencyKey must be unique per charge attempt — Square
// dedupes replays of the same key, so a retried request cannot double-charge.
// fetchImpl is injectable for tests (a mock Square server).
async function createPayment(sourceId, amountCents, idempotencyKey, fetchImpl = fetch) {
  if (!process.env.SQUARE_ACCESS_TOKEN) return { ok: false, error: 'no_token' };
  if (!process.env.SQUARE_LOCATION_ID) return { ok: false, error: 'no_location' };
  const url = `${SQUARE_API}/v2/payments`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: squareHeaders(),
      body: JSON.stringify({
        source_id: sourceId,
        idempotency_key: idempotencyKey,
        amount_money: { amount: amountCents, currency: 'USD' },
        location_id: process.env.SQUARE_LOCATION_ID,
        autocomplete: true,
      }),
    });
  } catch (e) {
    return { ok: false, error: 'network', detail: String(e && e.message ? e.message : e) };
  }
  let body = {};
  try { body = await res.json(); } catch (e) { /* non-JSON body */ }
  if (!res.ok) {
    const errs = Array.isArray(body.errors) ? body.errors : [];
    const first = errs[0] || {};
    return {
      ok: false,
      error: 'square_error',
      status: res.status,
      code: first.code || null,
      // A declined card is a normal outcome, not a crash: surface it plainly.
      declined: first.code === 'CARD_DECLINED' || first.code === 'CARD_DECLINED_VERIFICATION_REQUIRED',
      detail: JSON.stringify(body).slice(0, 300),
    };
  }
  const p = body.payment || {};
  const total = p.amount_money || {};
  return {
    ok: true,
    paymentId: p.id || null,
    status: p.status || null,
    amountCents: typeof total.amount === 'number' ? total.amount : null,
    currency: total.currency || null,
    receiptUrl: p.receipt_url || null,
  };
}

// Charge + verify in one step. verified is true ONLY when the payment
// completed for exactly the expected amount in USD.
async function chargeAndVerify(sourceId, expectedCents, idempotencyKey, fetchImpl) {
  const r = await createPayment(sourceId, expectedCents, idempotencyKey, fetchImpl);
  if (!r.ok) {
    return {
      verified: false,
      reason: r.error,
      code: r.code || null,
      declined: !!r.declined,
      detail: r.detail || null,
    };
  }
  if (r.status !== 'COMPLETED') {
    return { verified: false, reason: 'not_completed', status: r.status, paymentId: r.paymentId };
  }
  if (r.currency !== 'USD') {
    return { verified: false, reason: 'wrong_currency', currency: r.currency, paymentId: r.paymentId };
  }
  if (r.amountCents !== expectedCents) {
    return {
      verified: false,
      reason: 'amount_mismatch',
      expected: expectedCents,
      actual: r.amountCents,
      paymentId: r.paymentId,
    };
  }
  return { verified: true, paymentId: r.paymentId, amountCents: r.amountCents, receiptUrl: r.receiptUrl };
}

module.exports = { createPayment, chargeAndVerify, SQUARE_VERSION };

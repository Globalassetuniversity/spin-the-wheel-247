// square.js — verify a Square payment-link order via the Square Orders API.
// Used only when SQUARE_ACCESS_TOKEN is set (Will connects it through the
// secure flow; never in chat). Without a token the server does NOT auto-
// confirm payments — claims wait for Will in /admin instead.
//
// GET https://connect.squareup.com/v2/orders/{order_id}
//   Authorization: Bearer <token>, Square-Version: <pinned version>
// Confirm only when the order is COMPLETED, in USD, and its total equals
// the expected amount exactly. Money is integer cents.
const SQUARE_API = process.env.SQUARE_API_BASE || 'https://connect.squareup.com';
const SQUARE_VERSION = process.env.SQUARE_VERSION || '2025-04-16';

async function retrieveOrder(orderId, fetchImpl = fetch) {
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token) return { ok: false, error: 'no_token' };
  const url = `${SQUARE_API}/v2/orders/${encodeURIComponent(orderId)}`;
  let res;
  try {
    res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Square-Version': SQUARE_VERSION,
        'Content-Type': 'application/json',
      },
    });
  } catch (e) {
    return { ok: false, error: 'network', detail: String(e && e.message ? e.message : e) };
  }
  let body = {};
  try { body = await res.json(); } catch (e) { /* non-JSON body */ }
  if (!res.ok) {
    return { ok: false, error: 'square_error', status: res.status, detail: JSON.stringify(body).slice(0, 300) };
  }
  const order = body.order || {};
  const total = order.total_money || {};
  return {
    ok: true,
    orderId: order.id || orderId,
    state: order.state || null,
    amountCents: typeof total.amount === 'number' ? total.amount : null,
    currency: total.currency || null,
  };
}

// True only when the order is fully paid for exactly the expected amount.
async function verifyOrderPaid(orderId, expectedCents, fetchImpl) {
  const r = await retrieveOrder(orderId, fetchImpl);
  if (!r.ok) return { verified: false, reason: r.error, detail: r.detail || null };
  if (r.state !== 'COMPLETED') return { verified: false, reason: 'not_completed', state: r.state };
  if (r.currency !== 'USD') return { verified: false, reason: 'wrong_currency', currency: r.currency };
  if (r.amountCents !== expectedCents) {
    return { verified: false, reason: 'amount_mismatch', expected: expectedCents, actual: r.amountCents };
  }
  return { verified: true, orderId: r.orderId, amountCents: r.amountCents };
}

module.exports = { retrieveOrder, verifyOrderPaid, SQUARE_VERSION };

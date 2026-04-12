/**
 * Polymarket US Order Test — verify signing and order placement work.
 *
 * Places a tiny IOC order ($0.50) on a liquid market.
 * IOC = fills immediately or cancels, no risk of hanging orders.
 *
 * Run: cd bot && node test-poly-order.mjs
 */

import 'dotenv/config';

const POLY_US_KEY_ID = process.env.POLY_US_KEY_ID ?? '';
const POLY_US_SECRET = process.env.POLY_US_SECRET_KEY ?? '';
const POLY_US_API = 'https://api.polymarket.us';

if (!POLY_US_KEY_ID || !POLY_US_SECRET) {
  console.error('Missing POLY_US_KEY_ID or POLY_US_SECRET_KEY in .env');
  process.exit(1);
}

// Initialize Ed25519 signing
let polySign, polyPrivBytes;
try {
  const { createHash } = await import('crypto');
  const ed = await import('@noble/ed25519');
  try {
    ed.etc.sha512Sync = (...m) => {
      const h = createHash('sha512');
      for (const msg of m) h.update(msg);
      return new Uint8Array(h.digest());
    };
  } catch { /* frozen */ }
  polySign = ed.signAsync ?? ed.sign;
  polyPrivBytes = Uint8Array.from(atob(POLY_US_SECRET), c => c.charCodeAt(0)).slice(0, 32);
  console.log('✅ Ed25519 signing initialized');
} catch (e) {
  console.error('❌ Signing init failed:', e.message);
  process.exit(1);
}

async function signRequest(method, path, body = '') {
  const ts = String(Date.now());
  const message = `${ts}${method}${path}${body}`;
  const sigBytes = await polySign(new TextEncoder().encode(message), polyPrivBytes);
  const signature = btoa(String.fromCharCode(...sigBytes));
  return {
    ts,
    headers: {
      'X-PM-Access-Key': POLY_US_KEY_ID,
      'X-PM-Timestamp': ts,
      'X-PM-Signature': signature,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'arbor-test/1',
    },
  };
}

// Test 1: Balance check
console.log('\n=== TEST 1: Balance ===');
const balAuth = await signRequest('GET', '/v1/account/balances');
const balRes = await fetch(`${POLY_US_API}/v1/account/balances`, {
  headers: balAuth.headers,
  signal: AbortSignal.timeout(8000),
});
console.log('Status:', balRes.status);
const balData = await balRes.json().catch(() => ({}));
console.log('Response:', JSON.stringify(balData, null, 2));

if (!balRes.ok) {
  console.error('❌ Balance fetch failed — signing is broken. Testing without body in signature...');

  // Try without body (some APIs don't include body in GET signature)
  const ts2 = String(Date.now());
  const msg2 = `${ts2}GET/v1/account/balances`;
  const sig2 = await polySign(new TextEncoder().encode(msg2), polyPrivBytes);
  const signature2 = btoa(String.fromCharCode(...sig2));
  const res2 = await fetch(`${POLY_US_API}/v1/account/balances`, {
    headers: {
      'X-PM-Access-Key': POLY_US_KEY_ID,
      'X-PM-Timestamp': ts2,
      'X-PM-Signature': signature2,
      'Content-Type': 'application/json',
    },
  });
  console.log('Without-body status:', res2.status);
  console.log('Response:', JSON.stringify(await res2.json().catch(() => ({})), null, 2));
  if (!res2.ok) {
    console.error('❌ Both signing approaches failed. Check credentials.');
    process.exit(1);
  }
}

// Test 2: Fetch a market to test with
console.log('\n=== TEST 2: Finding test market ===');
const mktsRes = await fetch('https://gateway.polymarket.us/v1/markets?limit=20&active=true&closed=false', {
  headers: { 'User-Agent': 'arbor-test/1', 'Accept': 'application/json' },
  signal: AbortSignal.timeout(10000),
});
const mktsData = await mktsRes.json();
const testMkt = (mktsData.markets ?? []).find(m =>
  (m.marketType === 'moneyline' || m.marketType === 'futures') &&
  m.marketSides?.length >= 2 &&
  parseFloat(m.marketSides[0]?.price ?? '0') > 0.20 &&
  parseFloat(m.marketSides[0]?.price ?? '0') < 0.80
);

if (!testMkt) {
  console.error('❌ No suitable test market found');
  process.exit(1);
}

const testSlug = testMkt.slug;
const testPrice = parseFloat(testMkt.marketSides[0].price);
console.log(`Found: "${testMkt.question}"`);
console.log(`Slug: ${testSlug}`);
console.log(`Side0 price: $${testPrice.toFixed(2)}`);

// Test 3: Place a tiny IOC order (1 share at low price — won't fill, just tests auth)
console.log('\n=== TEST 3: Placing test order (1 share, low price IOC) ===');
const lowPrice = 0.01; // Very low — won't fill, but tests if API accepts the request
const orderBody = {
  marketSlug: testSlug,
  intent: 'ORDER_INTENT_BUY_LONG',
  type: 'ORDER_TYPE_LIMIT',
  price: { value: lowPrice.toFixed(2), currency: 'USD' },
  quantity: 1,
  tif: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL',
};
const orderStr = JSON.stringify(orderBody);

// Test with body in signature
const orderAuth = await signRequest('POST', '/v1/orders', orderStr);
console.log('Request body:', orderStr);

const orderRes = await fetch(`${POLY_US_API}/v1/orders`, {
  method: 'POST',
  headers: orderAuth.headers,
  body: orderStr,
  signal: AbortSignal.timeout(10000),
});

console.log('Status:', orderRes.status);
const orderData = await orderRes.json().catch(() => ({}));
console.log('Response:', JSON.stringify(orderData, null, 2));

if (orderRes.ok) {
  console.log('✅ ORDER ACCEPTED — Polymarket signing works!');
  if (orderData.id || orderData.orderId) {
    console.log('Order ID:', orderData.id ?? orderData.orderId);
  }
} else if (orderRes.status === 401 || orderRes.status === 403) {
  console.log('❌ AUTH FAILED — trying without body in signature...');

  const ts3 = String(Date.now());
  const msg3 = `${ts3}POST/v1/orders`;
  const sig3 = await polySign(new TextEncoder().encode(msg3), polyPrivBytes);
  const signature3 = btoa(String.fromCharCode(...sig3));
  const res3 = await fetch(`${POLY_US_API}/v1/orders`, {
    method: 'POST',
    headers: {
      'X-PM-Access-Key': POLY_US_KEY_ID,
      'X-PM-Timestamp': ts3,
      'X-PM-Signature': signature3,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: orderStr,
    signal: AbortSignal.timeout(10000),
  });
  console.log('Without-body status:', res3.status);
  console.log('Response:', JSON.stringify(await res3.json().catch(() => ({})), null, 2));
  if (res3.ok) {
    console.log('⚠️  Works WITHOUT body in signature — need to fix polySignRequest!');
  } else {
    console.log('❌ Both approaches failed. Check API docs or credentials.');
  }
} else {
  console.log(`⚠️  HTTP ${orderRes.status} — auth works but order was rejected (check body format)`);
}

process.exit(0);

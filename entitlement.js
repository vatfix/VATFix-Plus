// lib/entitlement.js — dev-friendly (no S3/Stripe needed when ENFORCE_STRIPE !== '1')
import Stripe from 'stripe';

// ENV
const {
  STRIPE_SECRET_KEY,
  S3_BUCKET,
  AWS_REGION = 'eu-north-1',
  ENFORCE_STRIPE = '1',                                  // '1' = enforce cloud checks; anything else = dev mode
  VATFIX_PRICE_IDS = '',
  VATFIX_ALLOWED_SUB_STATUSES = 'active,trialing',
} = process.env;

// Parse allow-lists once
const allowedPriceIds = new Set(
  VATFIX_PRICE_IDS.split(',').map(s => s.trim()).filter(Boolean)
);
const allowedStatuses = new Set(
  VATFIX_ALLOWED_SUB_STATUSES.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);

// Lazily created clients (only in enforce mode)
let stripe = null;
let s3 = null;

// --- Tiny helper so we don’t import AWS SDKs in dev mode ---
async function getEntitlementByKeyFromS3(apiKey) {
  // Only used in enforce mode; create v3 client lazily
  if (!s3) {
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
    s3 = new S3Client({ region: AWS_REGION });
    s3._GetObjectCommand = GetObjectCommand;
  }
  try {
    const out = await s3.send(new s3._GetObjectCommand({ Bucket: S3_BUCKET, Key: `keys/by-key/${apiKey}.json` }));
    const text = typeof out.Body?.transformToByteArray === 'function'
      ? Buffer.from(await out.Body.transformToByteArray()).toString('utf8')
      : await new Response(out.Body).text(); // Node 18+ fetch Response fallback
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Assert PLUS access.
 * In dev mode (ENFORCE_STRIPE !== '1'): we skip S3/Stripe and just require an apiKey to be present.
 * In prod mode  (ENFORCE_STRIPE === '1'): we enforce S3/Stripe as before.
 */
export async function assertActivePlus(input = {}) {
  const enforce = ENFORCE_STRIPE === '1';

  // --- DEV MODE: allow without cloud deps ---
  if (!enforce) {
    // Still require an API key to be present in the header (keeps your tests meaningful)
    if (!input.apiKey) throw new Error('invalid_key');
    return {
      customerId: null,
      email: input.email || null,
      key: input.apiKey,
      active: true,
      source: 'no_enforce', // signals dev mode
    };
  }

  // --- PROD MODE: enforce S3 + Stripe ---
  if (!S3_BUCKET) throw new Error('S3_BUCKET missing');
  if (!STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY missing');
  if (!stripe) stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

  // 1) Resolve entitlement via S3 by API key (fast path)
  let entitlement = null;
  if (input.apiKey) {
    entitlement = await getEntitlementByKeyFromS3(input.apiKey);
    if (!entitlement) throw new Error('invalid_key');
    if (entitlement.active === false) throw new Error('key_revoked');
  }

  // 2) Determine customer/email context
  let customerId = input.customerId || entitlement?.customerId || null;
  let email = input.email || entitlement?.email || null;

  // 3) Resolve customer by email if needed
  if (!customerId && email) {
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (!customers.data.length) throw new Error('no_customer');
    customerId = customers.data[0].id;
  }
  if (!customerId) throw new Error('no_customer');

  // 4) Fill missing email (best-effort)
  if (!email) {
    try {
      const c = await stripe.customers.retrieve(customerId);
      if (c && !c.deleted) email = c.email || email || null;
    } catch {
      // ignore
    }
  }

  // 5) Fetch subscriptions and validate status/price
  const subs = await stripe.subscriptions.list({
    customer: customerId,
    expand: ['data.items.data.price'],
    limit: 100,
  });
  const eligibleSubs = subs.data.filter(sub => allowedStatuses.has(String(sub.status).toLowerCase()));
  if (!eligibleSubs.length) throw new Error('no_active_subscription');

  if (allowedPriceIds.size) {
    const ok = eligibleSubs.some(sub =>
      sub.items.data.some(item => item.price && allowedPriceIds.has(item.price.id))
    );
    if (!ok) throw new Error('price_not_allowed');
  }

  return { customerId, email, key: entitlement?.key, active: true, source: 'stripe' };
}

export default assertActivePlus;

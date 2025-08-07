// lib/entitlement.js — hardened PLUS gate

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function assertActivePlus(email) {
  console.log(`[entitlement] checking PLUS for: ${email}`);

  const customers = await stripe.customers.list({ email });
  console.log(`[entitlement] customers found: ${customers.data.length}`);

  if (!customers.data.length) throw new Error('no_customer');

  const customer = customers.data[0];
  const subs = await stripe.subscriptions.list({
    customer: customer.id,
    status: 'active',
    expand: ['data.items'],
  });

  console.log(`[entitlement] subs found: ${subs.data.length}`);

  const allowedPriceIds = (process.env.VATFIX_PRICE_IDS || '').split(',');

  for (const sub of subs.data) {
    for (const item of sub.items.data) {
      console.log(`[entitlement] item: ${item.price.id}`);
    }
  }

  const allowed = subs.data.some(sub =>
    sub.items.data.some(item =>
      allowedPriceIds.includes(item.price.id)
    )
  );

  if (!allowed) {
    console.log(`[entitlement] ❌ no match for VATFIX_PRICE_IDS: ${process.env.VATFIX_PRICE_IDS}`);
    throw new Error('not_plus');
  }

  console.log(`[entitlement] ✅ access granted`);
}

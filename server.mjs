// server.mjs — VATFix Plus (single origin, no redirects loops)
// Hosts docs, pricing, checkout, success page, webhook, and /vat/* API on plus.vatfix.eu

import express from 'express';
import Stripe from 'stripe';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

import checkVAT from './lib/validate.js';
import { meterAndCheck } from './lib/meter.js';
import { assertActivePlus } from './lib/entitlement.js';
import webhookHandler from './webhook.js';

// --- Env ---
const {
  STRIPE_SECRET_KEY,
  S3_BUCKET,
  AWS_REGION = 'eu-north-1',

  MARKETING_ORIGIN = 'https://plus.vatfix.eu',

  CHECKOUT_PRICE_ID,                 // required for /buy
  CHECKOUT_SUCCESS_PATH = '/success',
  CHECKOUT_CANCEL_PATH = '/cancel',

  TRIAL_DAYS = '',                   // optional free trial days
} = process.env;

if (!STRIPE_SECRET_KEY) throw new Error('Missing STRIPE_SECRET_KEY');
if (!S3_BUCKET) throw new Error('Missing S3_BUCKET');

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const s3 = new S3Client({ region: AWS_REGION });

const app = express();
app.set('trust proxy', true);

// ---------- Global security headers ----------
app.use((req, res, next) => {
  res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  // Cache pages minimally; avoid caching success
  if (!req.path.startsWith('/success') && !req.path.startsWith('/lib/success')) {
    res.set('Cache-Control', 'no-cache');
  }
  next();
});

// ---------- Stripe webhook MUST see raw body (FIRST) ----------
app.post('/webhook', express.raw({ type: 'application/json' }), webhookHandler);

// ---------- JSON for everything else ----------
app.use(express.json({ limit: '1mb' }));

// ---------- Shared constants ----------
const endpoint = 'https://plus.vatfix.eu/vat/lookup';
const portal = 'https://billing.stripe.com/p/login/14A14o2Kk69F6Ei2hQ5wI00';

// ---------- Tiny S3 JSON reader (v3) ----------
async function s3GetJson(Key) {
  const out = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key }));
  const body = out.Body;
  let buf;
  if (typeof body?.transformToByteArray === 'function') {
    buf = Buffer.from(await body.transformToByteArray());
  } else {
    buf = await new Promise((resolve, reject) => {
      const chunks = [];
      body.on('data', (c) => chunks.push(c));
      body.on('end', () => resolve(Buffer.concat(chunks)));
      body.on('error', reject);
    });
  }
  return JSON.parse(buf.toString('utf8'));
}

// ---------- Renderers ----------
function renderPlusPage() {
  return `<!doctype html><meta charset="utf-8">
<title>VATFix Plus — Quickstart</title>
<style>
  body{font:16px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:40px;max-width:820px}
  code,pre{font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  pre{background:#0b1021;color:#e5e7eb;padding:14px;border-radius:12px;overflow:auto}
  .pill{display:inline-block;background:#eef;padding:2px 8px;border-radius:999px;font-size:12px}
  a{color:#2563eb;text-decoration:none} a:hover{text-decoration:underline}
  .btn{display:inline-block;background:#111;color:#fff;padding:10px 14px;border-radius:10px;text-decoration:none}
</style>
<h1>📟 VATFix Plus — Quickstart</h1>
<p><span class="pill">Endpoint</span><br><code>POST ${endpoint}</code></p>
<p><span class="pill">Required headers</span><br><code>x-api-key</code> • <code>x-customer-email</code></p>
<pre>curl -sS ${endpoint} \\
 -H "Content-Type: application/json" \\
 -H "x-api-key: &lt;your key&gt;" \\
 -H "x-customer-email: &lt;billing email&gt;" \\
 -d '{"countryCode":"DE","vatNumber":"12345678912"}' | jq .</pre>
<p><a class="btn" href="/buy">Get your API key</a></p>
<p><span class="pill">Limits</span><br>Default <code>120</code> requests/min per key.</p>
<p><span class="pill">Errors</span></p>
<pre>401 invalid_key | 401 missing_api_key | 401 missing_customer_email
403 access_denied | 403 key_revoked | 403 plan_not_allowed
429 rate_limit_exceeded</pre>
<p><span class="pill">Billing & support</span><br>
  Manage subscription: <a href="${portal}">${portal}</a><br>
  Email: <a href="mailto:support@vatfix.eu">support@vatfix.eu</a></p>
<p>Stay boring, stay online.</p>`;
}

function renderPricingPage() {
  return `<!doctype html><meta charset="utf-8">
<title>VATFix Plus — Pricing</title>
<style>
  body{font:16px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:40px;max-width:820px}
  .card{border:1px solid #e5e7eb;border-radius:14px;padding:18px;margin:12px 0}
  .btn{display:inline-block;background:#111;color:#fff;padding:10px 14px;border-radius:10px;text-decoration:none}
  code{background:#f6f7f9;padding:2px 6px;border-radius:6px}
</style>
<h1>Pricing</h1>
<div class="card">
  <h2>Plus</h2>
  <p>One key. <b>120 req/min</b>. S3 cache, rate limits, Stripe‑gated access.</p>
  <p>Endpoint: <code>${endpoint}</code></p>
  <p><a class="btn" href="/buy">Get your API key</a></p>
</div>
<p>Need higher RPS or custom SLA? Email <a href="mailto:support@vatfix.eu">support@vatfix.eu</a>.</p>`;
}

function renderFAQPage() {
  return `<!doctype html><meta charset="utf-8">
<title>VATFix Plus — FAQ</title>
<style>body{font:16px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:40px;max-width:820px}</style>
<h1>FAQ</h1>
<h3>Which countries?</h3>
<p>All EU member states supported by VIES.</p>
<h3>Headers required?</h3>
<p><code>x-api-key</code> and <code>x-customer-email</code>.</p>
<h3>How does caching work?</h3>
<p>Each VAT number response is cached in S3 for 12 hours. On VIES outage we serve the cached entry and set <code>source: "cache"</code>.</p>
<h3>What are the errors?</h3>
<p>401 <code>invalid_key</code>, 401 <code>missing_* </code>, 403 <code>access_denied</code>, 403 <code>plan_not_allowed</code>, 429 <code>rate_limit_exceeded</code>.</p>`;
}

function setSuccessCsp(res) {
  res.set('Cache-Control', 'no-store');
  res.set('X-Frame-Options', 'DENY');
  res.set('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'; img-src data: https:; frame-ancestors 'none'");
}

function renderSuccessHtml({ key, email, portalUrl }) {
  return `<!doctype html><meta charset="utf-8">
<title>VATFix Plus — Your API Key</title>
<style>
  body{font:16px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:40px;max-width:820px;color:#111}
  code,pre{font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  pre{background:#0b1021;color:#e5e7eb;padding:14px;border-radius:12px;overflow:auto}
  .btn{display:inline-block;background:#111;color:#fff;padding:10px 14px;border-radius:10px;text-decoration:none}
  .muted{color:#555}
</style>
<h1>📟 VATFix Plus — Your API Key</h1>
<p><b>Key:</b> <code>${key}</code></p>
<p><b>Endpoint:</b> <a href="${endpoint}" target="_blank" rel="noopener">${endpoint}</a></p>
<p><b>Headers:</b></p>
<pre>x-customer-email: ${email}
x-api-key: ${key}</pre>
<p><b>Quick test</b>:</p>
<pre>curl -sS ${endpoint} \\
 -H "Content-Type: application/json" \\
 -H "x-api-key: ${key}" \\
 -H "x-customer-email: ${email}" \\
 -d '{"countryCode":"DE","vatNumber":"12345678912"}' | jq .</pre>
<p><a class="btn" href="${portalUrl}" target="_blank" rel="noopener">Manage billing</a></p>
<p class="muted">Keep this safe. It won't be shown again here. An email was also sent to ${email}.</p>
<p class="muted">Need help? <a href="mailto:support@vatfix.eu">support@vatfix.eu</a></p>`;
}

// ---------- VAT API ----------
async function vatHandler(req, res) {
  try {
    const apiKey = req.header('x-api-key');
    const email = req.header('x-customer-email');
    const { countryCode, vatNumber } = req.body || {};

    if (!apiKey) return res.status(401).json({ error: 'missing_api_key' });
    if (!email) return res.status(401).json({ error: 'missing_customer_email' });
    if (!countryCode || !vatNumber) return res.status(400).json({ error: 'missing_vat_data' });

    // Entitlement via S3 + Stripe
    try {
      await assertActivePlus({ apiKey, email });
    } catch (e) {
      const code = String(e?.message || '');
      if (code === 'invalid_key') return res.status(401).json({ error: 'invalid_api_key' });
      if (code === 'key_revoked') return res.status(403).json({ error: 'key_revoked' });
      if (code === 'no_active_subscription') return res.status(403).json({ error: 'access_denied' });
      if (code === 'price_not_allowed') return res.status(403).json({ error: 'plan_not_allowed' });
      return res.status(403).json({ error: 'access_denied' });
    }

    // Per-key rate limit (best‑effort)
    const meterRes = await meterAndCheck({ apiKey, email, countryCode, vatNumber });
    if (meterRes.remaining !== undefined) res.set('X-Rate-Remaining', String(meterRes.remaining));
    if (!meterRes.allowed) return res.status(429).json({ error: meterRes.reason || 'rate_limit_exceeded' });

    // VIES with S3 cache fallback inside checkVAT
    const result = await checkVAT({ countryCode, vatNumber, email });
    return res.status(200).json(result);
  } catch (err) {
    console.error('[vat] server error:', err);
    return res.status(500).json({ error: 'server_error' });
  }
}
app.post('/vat/validate', vatHandler);
app.post('/vat/lookup',  vatHandler);

// ---------- BUY: Stripe Checkout ----------
app.get('/buy', async (_req, res) => {
  try {
    if (!CHECKOUT_PRICE_ID) return res.status(503).send('Price not configured');
    const successUrl = `${MARKETING_ORIGIN}${CHECKOUT_SUCCESS_PATH}?sid={CHECKOUT_SESSION_ID}`;
    const cancelUrl  = `${MARKETING_ORIGIN}${CHECKOUT_CANCEL_PATH}`;
    const trialDays = String(TRIAL_DAYS || '').trim();
    const subscription_data = trialDays ? { trial_period_days: Number(trialDays) } : undefined;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: CHECKOUT_PRICE_ID, quantity: 1 }],
      allow_promotion_codes: true,
      automatic_tax: { enabled: false },
      subscription_data,
      success_url: successUrl,
      cancel_url: cancelUrl,
    });
    return res.redirect(303, session.url);
  } catch (e) {
    console.error('[buy]', e?.message || e);
    return res.status(500).send('Unable to start checkout');
  }
});

// ---------- Success page ----------
async function successHandler(req, res) {
  try {
    const sid = req.query.sid;
    if (!sid) return res.status(400).send('Missing sid');

    const sess = await stripe.checkout.sessions.retrieve(String(sid));
    const customerId = sess?.customer;
    if (!customerId) return res.status(404).send('No customer for session');

    const rec = await s3GetJson(`keys/${customerId}.json`);
    const key = rec?.key;
    const email = rec?.email || sess.customer_details?.email || '';

    if (!key) return res.status(404).send('Key not provisioned yet');

    const portalSess = await stripe.billingPortal.sessions.create({
      customer: String(customerId),
      return_url: `${MARKETING_ORIGIN}/dashboard`,
    });

    setSuccessCsp(res);
    const html = renderSuccessHtml({ key, email, portalUrl: portalSess.url });
    return res.status(200).type('html').send(html);
  } catch (e) {
    console.error('[success]', e?.message || e);
    return res.status(500).send('Unable to fetch key');
  }
}
app.get('/success', successHandler);
app.get('/vat/success', successHandler);

// ---------- Docs & pages (mounted at both / and /vat) ----------
app.get('/plus', (_req, res) => res.type('html').send(renderPlusPage()));
app.get('/vat/plus', (_req, res) => res.type('html').send(renderPlusPage()));

app.get('/pricing', (_req, res) => res.type('html').send(renderPricingPage()));
app.get('/vat/pricing', (_req, res) => res.type('html').send(renderPricingPage()));

app.get('/faq', (_req, res) => res.type('html').send(renderFAQPage()));
app.get('/vat/faq', (_req, res) => res.type('html').send(renderFAQPage()));

app.get('/status', (_req, res) => {
  const started = process.env.FLY_MACHINE_ID ? 'fly' : 'local';
  res.type('html').send(`<!doctype html><meta charset="utf-8">
<title>VATFix Plus — Status</title>
<style>body{font:16px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:40px;max-width:820px}.ok{color:#16a34a}.muted{color:#6b7280}</style>
<h1 class="ok">● All systems green</h1>
<p class="muted">Region: ${AWS_REGION} • Host: ${started}</p>`);
});
app.get('/vat/status', (_req, res) => {
  const started = process.env.FLY_MACHINE_ID ? 'fly' : 'local';
  res.type('html').send(`<!doctype html><meta charset="utf-8">
<title>VATFix Plus — Status</title>
<style>body{font:16px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:40px;max-width:820px}.ok{color:#16a34a}.muted{color:#6b7280}</style>
<h1 class="ok">● All systems green</h1>
<p class="muted">Region: ${AWS_REGION} • Host: ${started}</p>`);
});

// ---------- Legal ----------
const robotsTxt = 'User-agent: *\nAllow: /\n';
app.get('/robots.txt', (_req, res) => res.type('text/plain').send(robotsTxt));
app.get('/vat/robots.txt', (_req, res) => res.type('text/plain').send(robotsTxt));

app.get('/legal/privacy', (_req, res) => {
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Privacy</title>
<style>body{font:16px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:40px;max-width:820px}</style>
<h1>Privacy</h1>
<p>We store minimal logs in S3 for audit and abuse control. No personal data beyond billing email and VAT numbers sent to the API.</p>`);
});
app.get('/vat/legal/privacy', (_req, res) => {
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Privacy</title>
<style>body{font:16px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:40px;max-width:820px}</style>
<h1>Privacy</h1>
<p>We store minimal logs in S3 for audit and abuse control. No personal data beyond billing email and VAT numbers sent to the API.</p>`);
});
app.get('/legal/terms', (_req, res) => {
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Terms</title>
<style>body{font:16px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:40px;max-width:820px}</style>
<h1>Terms</h1>
<p>Service is provided as‑is with best‑effort uptime. Fair use applies. Contact support for custom SLA.</p>`);
});
app.get('/vat/legal/terms', (_req, res) => {
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Terms</title>
<style>body{font:16px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:40px;max-width:820px}</style>
<h1>Terms</h1>
<p>Service is provided as‑is with best‑effort uptime. Fair use applies. Contact support for custom SLA.</p>`);
});

// ---------- Health + misc ----------
app.get('/', (_req, res) => res.send('📟 VATFix Plus'));
app.get('/vat', (_req, res) => res.type('html').send(renderPlusPage()));
app.get('/cancel', (_req, res) => res.status(200).send('Checkout canceled.'));
app.get('/vat/cancel', (_req, res) => res.status(200).send('Checkout canceled.'));

// ---------- 404 ----------
app.use((_req, res) => res.status(404).send('Not found'));

// --- Start ---
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  const stripeOn = STRIPE_SECRET_KEY ? 'on' : 'off';
  const s3On = S3_BUCKET ? 'on' : 'off';
  console.log(`🚀 VATFix-Plus listening on 0.0.0.0:${port} (stripe=${stripeOn}, s3=${s3On})`);
});

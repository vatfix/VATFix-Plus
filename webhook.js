// webhook.js — VATFix Plus Stripe listener (trial + grace, AWS v3, TLS-clean)
import crypto from 'crypto';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import Stripe from 'stripe';
import nodemailer from 'nodemailer';

const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  S3_BUCKET,
  AWS_REGION = 'eu-north-1',

  // Mail (optional)
  MAIL_FROM,
  MAIL_FALLBACK,          // optional: where to send if email is missing
  SMTP_URL,               // e.g. "smtp://USER:PASS@smtp.protonmail.ch:587"
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,

  // Grace config
  TRIAL_MIN_SECONDS = '0',
  GRACE_DAYS_AFTER_END = '7',
} = process.env;

if (!STRIPE_SECRET_KEY) throw new Error('Missing STRIPE_SECRET_KEY');
if (!STRIPE_WEBHOOK_SECRET) throw new Error('Missing STRIPE_WEBHOOK_SECRET');
if (!S3_BUCKET) throw new Error('Missing S3_BUCKET');

const s3 = new S3Client({ region: AWS_REGION });
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

/* ---------------- SMTP ---------------- */
let transporter = null;
async function initMailer() {
  if (!(MAIL_FROM && (SMTP_URL || (SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS)))) {
    console.warn('[mail] SMTP not configured — key emails will NOT be sent');
    return null;
  }
  const transport =
    SMTP_URL
      ? nodemailer.createTransport(SMTP_URL, {
          tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
          requireTLS: true,
        })
      : nodemailer.createTransport({
          host: SMTP_HOST,
          port: Number(SMTP_PORT),
          secure: Number(SMTP_PORT) === 465,
          auth: { user: SMTP_USER, pass: SMTP_PASS },
          tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
          requireTLS: Number(SMTP_PORT) !== 465,
        });

  try {
    await transport.verify();
    console.log('[mail] SMTP ready as', MAIL_FROM);
    return transport;
  } catch (e) {
    console.error('[mail] SMTP verify failed:', e?.message || e);
    return null;
  }
}
transporter = await initMailer();

/* ---------------- S3 helpers ---------------- */
async function readBody(stream) {
  if (typeof stream?.transformToByteArray === 'function') {
    const bytes = await stream.transformToByteArray();
    return Buffer.from(bytes);
  }
  const chunks = [];
  for await (const c of Readable.from(stream)) chunks.push(c);
  return Buffer.concat(chunks);
}
async function getJSON(Key) {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key }));
    const buf = await readBody(out.Body);
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}
async function putJSON(Key, data) {
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key,
      Body: JSON.stringify(data),
      ContentType: 'application/json',
    })
  );
}
function keyRecord({ customerId, email, key, active, trialUntil = null, graceUntil = null }) {
  return {
    customerId,
    email,
    key,
    active,
    createdAt: new Date().toISOString(),
    trialUntil,
    graceUntil,
  };
}
function maxIso(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return new Date(a) > new Date(b) ? a : b;
}
async function upsertEntitlement({ customerId, email, active = true, trialUntil = null, graceUntil = null }) {
  const custPath = `keys/${customerId}.json`;
  let record = await getJSON(custPath);

  if (!record?.key) {
    const key = 'sk_live_' + crypto.randomBytes(24).toString('hex');
    record = keyRecord({ customerId, email, key, active, trialUntil, graceUntil });
  } else {
    record = {
      ...record,
      email: email || record.email,
      active,
      trialUntil: maxIso(record.trialUntil, trialUntil),
      graceUntil: maxIso(record.graceUntil, graceUntil),
      updatedAt: new Date().toISOString(),
    };
  }
  await putJSON(custPath, record);
  await putJSON(`keys/by-key/${record.key}.json`, record);
  return record;
}
async function deactivateEntitlement(customerId, { graceUntil = null } = {}) {
  const custPath = `keys/${customerId}.json`;
  const rec = await getJSON(custPath);
  if (!rec) return null;

  const updated = {
    ...rec,
    active: false,
    deactivatedAt: new Date().toISOString(),
    graceUntil: maxIso(rec.graceUntil, graceUntil),
  };
  await putJSON(custPath, updated);
  await putJSON(`keys/by-key/${rec.key}.json`, updated);
  return updated;
}

/* ---------------- Stripe helpers ---------------- */
async function primaryEmailFromCustomer(customerId) {
  try {
    const c = await stripe.customers.retrieve(customerId);
    return c?.email || c?.billing_email || null;
  } catch {
    return null;
  }
}
function isSubInactive(sub) {
  return ['canceled', 'unpaid', 'incomplete_expired'].includes(sub.status);
}
function isoFromEpochSeconds(sec) {
  if (!sec) return null;
  const d = new Date(sec * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function addDays(fromIso, days) {
  const d = fromIso ? new Date(fromIso) : new Date();
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString();
}

/* ---------------- Email key ---------------- */
export async function emailKey(to, key) {
  if (!transporter || !MAIL_FROM) return;

  if (!to) {
    if (MAIL_FALLBACK) {
      console.warn('[mail] No recipient email — using MAIL_FALLBACK:', MAIL_FALLBACK);
      to = MAIL_FALLBACK;
    } else {
      console.warn('[mail] Skipped: no recipient email for key', key.slice(0, 14) + '…');
      return;
    }
  }

  const endpoint = 'https://plus.vatfix.eu/vat/lookup';
  const billingPortal = 'https://billing.stripe.com/p/login/14A14o2Kk69F6Ei2hQ5wI00';

  const text = [
    'Your VATFix API key is ready.',
    '',
    `Key: ${key}`,
    `Endpoint: ${endpoint}`,
    '',
    'Headers:',
    `  x-api-key: ${key}`,
    '  x-customer-email: <billing email>',
    '',
    'Quick test (replace email/VAT):',
    'curl -sS https://plus.vatfix.eu/vat/lookup \\',
    ' -H "Content-Type: application/json" \\',
    ` -H "x-api-key: ${key}" \\`,
    ' -H "x-customer-email: you@example.com" \\',
    ` -d '{"countryCode":"DE","vatNumber":"12345678901"}' | jq .`,
    '',
    `Manage your subscription: ${billingPortal}`,
    '',
    'Stay boring, stay online.',
  ].join('\n');

  const html = `
  <div style="font:14px/1.5 -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color:#111;">
    <p>Your VATFix API key is ready.</p>
    <p><b>Key:</b> <code style="padding:2px 6px;background:#f4f4f4;border-radius:6px;">${key}</code></p>
    <p><b>Endpoint:</b> <a href="${endpoint}" target="_blank" rel="noopener">${endpoint}</a></p>
    <p><b>Headers:</b></p>
    <pre style="background:#0b1021;color:#e5e7eb;padding:12px;border-radius:10px;overflow:auto">x-api-key: ${key}
x-customer-email: &lt;billing email&gt;</pre>
    <p><b>Quick test</b> (replace email/VAT):</p>
    <pre style="background:#0b1021;color:#e5e7eb;padding:12px;border-radius:10px;overflow:auto">curl -sS https://plus.vatfix.eu/vat/lookup \\
 -H "Content-Type: application/json" \\
 -H "x-api-key: ${key}" \\
 -H "x-customer-email: you@example.com" \\
 -d '{"countryCode":"DE","vatNumber":"12345678901"}' | jq .</pre>
    <p><b>Manage your subscription:</b> <a href="${billingPortal}" target="_blank" rel="noopener">${billingPortal}</a></p>
    <p>Stay boring, stay online.</p>
  </div>`;

  try {
    await transporter.sendMail({
      from: `"VATFix Plus" <${MAIL_FROM}>`,
      to,
      subject: '📟 VATFix Plus — Your API key',
      text,
      html,
    });
    console.log(`[mail] Key sent to ${to}`);
  } catch (e) {
    console.error('[mail] Failed to send:', e?.message || e);
  }
}

/* ---------------- Webhook entry ---------------- */
export default async function webhookHandler(req, res) {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] Signature error:', err?.message || err);
    return res.status(400).send('Invalid signature');
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const sess = event.data.object;
        if (!sess.customer) break;

        let trialUntil = null;
        try {
          if (sess.subscription) {
            const sub = await stripe.subscriptions.retrieve(String(sess.subscription));
            trialUntil =
              isoFromEpochSeconds(sub.trial_end) ||
              (Number(TRIAL_MIN_SECONDS) > 0
                ? new Date(Date.now() + Number(TRIAL_MIN_SECONDS) * 1000).toISOString()
                : null);
          }
        } catch {}

        const email = sess.customer_details?.email || (await primaryEmailFromCustomer(sess.customer));
        const rec = await upsertEntitlement({
          customerId: sess.customer,
          email,
          active: true,
          trialUntil,
        });
        await emailKey(email, rec.key);
        console.log('[webhook] checkout.session.completed → key ensured; trialUntil:', trialUntil || 'none');
        break;
      }

      case 'invoice.payment_succeeded': {
        const inv = event.data.object;
        if (!inv.customer) break;

        let trialUntil = null;
        try {
          if (inv.subscription) {
            const sub = await stripe.subscriptions.retrieve(String(inv.subscription));
            trialUntil = isoFromEpochSeconds(sub.trial_end);
          }
        } catch {}

        const email = await primaryEmailFromCustomer(inv.customer);
        const rec = await upsertEntitlement({
          customerId: inv.customer,
          email,
          active: true,
          trialUntil,
        });
        if (email && rec?.key) await emailKey(email, rec.key);
        console.log('[webhook] invoice.payment_succeeded → entitlement refreshed');
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        if (!sub.customer) break;

        if (isSubInactive(sub)) {
          const graceUntil = addDays(null, Number(GRACE_DAYS_AFTER_END) || 0);
          await deactivateEntitlement(sub.customer, { graceUntil });
          console.log('[webhook] subscription inactive → entitlement deactivated; graceUntil:', graceUntil);
        } else {
          const trialUntil = isoFromEpochSeconds(sub.trial_end);
          const email = await primaryEmailFromCustomer(sub.customer);
          const rec = await upsertEntitlement({
            customerId: sub.customer,
            email,
            active: true,
            trialUntil,
          });
          if (email && rec?.key) await emailKey(email, rec.key);
          console.log('[webhook] subscription active/trialing → entitlement ensured; trialUntil:', trialUntil || 'none');
        }
        break;
      }

      default:
        console.log('[webhook] Ignored event:', event.type);
        break;
    }
  } catch (err) {
    console.error('[webhook] Handler error:', err?.message || err);
    return res.status(500).send('Webhook error');
  }

  return res.status(200).send('ok');
}

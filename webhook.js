// webhook.js — drop‑in replacement with S3 idempotency + better email fallbacks

import 'dotenv/config';
import Stripe from 'stripe';
import nodemailer from 'nodemailer';
import AWS from 'aws-sdk';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const s3 = new AWS.S3();

const SENDER = process.env.MAIL_FROM || 'VATFix Vault <vault@vatfix.eu>';
const PROTON_URL = process.env.VATFIX_ZIP_URL || 'https://drive.proton.me/urls/KYPWZ9KHPM#2ol9KYsK86Yt';
const EXIT_URL = process.env.VATFIX_EXIT_URL || 'https://vatfix.eu/exit.lock';
const BUCKET = process.env.S3_BUCKET;
const IDEMP_PREFIX = process.env.WEBHOOK_S3_PREFIX || 'webhook';

const transporter = nodemailer.createTransport({
  host: 'smtp.simplelogin.io',
  port: 587,
  secure: false,
  auth: {
    user: 'vault@vatfix.eu',
    pass: process.env.SIMPLELOGIN_PW,
  },
});

/**
 * Fetch a customer email reliably for different event payloads.
 */
async function resolveEmail(event) {
  const obj = event.data?.object || {};
  // Checkout Session
  if (obj.object === 'checkout.session') {
    return obj.customer_details?.email || obj.customer_email || null;
  }
  // Invoice
  if (obj.object === 'invoice') {
    if (obj.customer_email) return obj.customer_email;
    if (obj.customer) {
      const cust = await stripe.customers.retrieve(obj.customer);
      return cust?.email || null;
    }
  }
  // Subscription (fallback, not primary trigger)
  if (obj.object === 'subscription' && obj.customer) {
    const cust = await stripe.customers.retrieve(obj.customer);
    return cust?.email || null;
  }
  return null;
}

/**
 * S3 idempotency: avoid duplicate sends on Stripe retries.
 */
async function seenEvent(eventId) {
  if (!BUCKET) return false; // if no bucket, skip idempotency but keep working
  try {
    await s3
      .headObject({ Bucket: BUCKET, Key: `${IDEMP_PREFIX}/${eventId}.json` })
      .promise();
    return true;
  } catch {
    return false;
  }
}

async function markEvent(eventId, payload) {
  if (!BUCKET) return;
  try {
    await s3
      .putObject({
        Bucket: BUCKET,
        Key: `${IDEMP_PREFIX}/${eventId}.json`,
        Body: JSON.stringify(payload),
        ContentType: 'application/json',
      })
      .promise();
  } catch {
    // non‑fatal
  }
}

export default async function webhookHandler(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;

  // Construct event with the *raw* body (Buffer)
  try {
    const raw = req.rawBody || req.body; // server passes raw Buffer
    event = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Idempotency guard
  if (await seenEvent(event.id)) {
    return res.status(200).end();
  }

  const type = event.type;
  const eligible =
    type === 'checkout.session.completed' ||
    type === 'invoice.paid';

  if (!eligible) {
    await markEvent(event.id, { type, skipped: true, at: new Date().toISOString() });
    return res.status(200).end();
  }

  try {
    const email = await resolveEmail(event);
    if (!email) {
      await markEvent(event.id, { type, error: 'no_email', at: new Date().toISOString() });
      return res.status(400).send('No email found on event');
    }

    const text = [
      `Here is your VATFix Proxy Node:`,
      ``,
      PROTON_URL,
      ``,
      `Deploy it. No UI. No support. No updates.`,
      ``,
      `Exit any time: ${EXIT_URL}`,
    ].join('\n');

    const html = `
      <div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Ubuntu;">
        <p>Here is your <strong>VATFix Proxy Node</strong>:</p>
        <p><a href="${PROTON_URL}">${PROTON_URL}</a></p>
        <p>Deploy it. No UI. No support. No updates.</p>
        <p style="color:#666">Exit any time: <a href="${EXIT_URL}">${EXIT_URL}</a></p>
      </div>
    `;

    await transporter.sendMail({
      from: SENDER,
      to: email,
      subject: '🧾 Your VATFix Node (Download)',
      text,
      html,
      headers: { 'X-VATFix-Event': event.id },
    });

    await markEvent(event.id, {
      type,
      sentTo: email,
      at: new Date().toISOString(),
      link: PROTON_URL,
    });

    console.log(`✅ Sent zip link to: ${email}`);
    return res.status(200).end();
  } catch (err) {
    console.error('❌ Mail dispatch failed:', err.message);
    await markEvent(event.id, {
      type,
      error: err.message || 'send_failed',
      at: new Date().toISOString(),
    });
    return res.status(500).send('Dispatch failed');
  }
}

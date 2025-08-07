import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import soap from 'soap';
import https from 'https';
import AWS from 'aws-sdk';
import Stripe from 'stripe';
import webhookHandler from './webhook.js';

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const s3 = new AWS.S3();

app.use(cors());

app.post('/webhook', bodyParser.raw({ type: '*/*' }), (req, res) => {
  webhookHandler({ ...req, rawBody: req.body }, res);
});

app.use(bodyParser.json());

app.get('/', (_req, res) => res.status(200).send('🧾 VATFix Proxy API'));

app.post('/vat/lookup', async (req, res) => {
  const clientKey = req.header('x-api-key');
  const email = req.header('x-customer-email');
  const { countryCode, vatNumber } = req.body || {};

  if (clientKey !== process.env.API_KEY)
    return res.status(401).json({ error: 'Invalid API key' });
  if (!email)
    return res.status(401).json({ error: 'Missing customer email' });
  if (!countryCode || !vatNumber)
    return res.status(400).json({ error: 'Missing VAT data' });

  try {
    const customers = await stripe.customers.list({ email });
    if (!customers.data.length) throw new Error('no_customer');

    const customer = customers.data[0];
    const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'active' });
    if (!subs.data.length) throw new Error('no_active_subscription');
  } catch (err) {
    console.error(`[stripe] ${email}: ${err.message}`);
    return res.status(403).json({ error: 'Access denied' });
  }

  const isPlus = process.env.VATFIX_PLUS === '1';

  if (isPlus) {
    try {
      const { assertActivePlus } = await import('./lib/entitlement.js');
      await assertActivePlus(email);
    } catch (err) {
      console.error(`[entitlement] ${email}: ${err.message}`);
      return res.status(403).json({ error: 'Access denied' });
    }

    try {
      const { meterAndCheck } = await import('./lib/meter.js');
      const { allowed, reason } = await meterAndCheck({ apiKey: clientKey, email, countryCode, vatNumber });
      if (!allowed) return res.status(429).json({ error: reason || 'rate_limit_exceeded' });
    } catch (err) {
      console.error(`[meter] ${email}: ${err.message}`);
      return res.status(503).json({ error: 'meter_unavailable' });
    }
  } else {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, countryCode, vatNumber, email };
    s3.putObject({
      Bucket: process.env.S3_BUCKET,
      Key: `logs/${timestamp}_${vatNumber}.json`,
      Body: JSON.stringify(logEntry),
      ContentType: 'application/json'
    }).promise().catch(() => {});
  }

  try {
    if (isPlus) {
      const { checkVAT } = await import('./lib/validate.js'); // ← fixed here
      const result = await checkVAT({ countryCode, vatNumber, email });
      const code = result?.error ? 502 : 200;
      return res.status(code).json(result);
    } else {
      const wsdlUrl = 'https://ec.europa.eu/taxation_customs/vies/checkVatService.wsdl';
      const client = await soap.createClientAsync(wsdlUrl, { httpsAgent: new https.Agent({ keepAlive: true }) });
      const [result] = await client.checkVatAsync({ countryCode, vatNumber });
      return res.status(200).json(result);
    }
  } catch (err) {
    console.error(`[validation] ${email}: ${err.message}`);
    return res.status(500).json({ valid: false, error: err?.message || 'validation_failed' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Server listening on http://0.0.0.0:${port}`);
});

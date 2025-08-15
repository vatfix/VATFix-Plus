import Stripe from 'stripe';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { setSuccessCsp, renderSuccessHtml } from './pages.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-north-1' });

async function s3GetJson(Key) {
  const out = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key }));
  const body = out.Body;
  const buf = typeof body?.transformToByteArray === 'function'
    ? Buffer.from(await body.transformToByteArray())
    : await new Promise((res, rej)=>{const c=[]; body.on('data',x=>c.push(x)); body.on('end',()=>res(Buffer.concat(c))); body.on('error',rej);});
  return JSON.parse(buf.toString('utf8'));
}

export async function successHandler(req, res) {
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
      return_url: `${process.env.MARKETING_ORIGIN || 'https://plus.vatfix.eu'}/dashboard`,
    });

    setSuccessCsp(res);
    const html = renderSuccessHtml({ key, email, portalUrl: portalSess.url });
    res.status(200).type('html').send(html);
  } catch (e) {
    console.error('[success]', e?.message || e);
    res.status(500).send('Unable to fetch key');
  }
}

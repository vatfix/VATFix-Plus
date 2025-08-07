// lib/meter.js — S3 metering + per-key rate limiting

import AWS from 'aws-sdk';
const s3 = new AWS.S3();

const BUCKET = process.env.S3_BUCKET;
const WINDOW_MS = +process.env.VATFIX_WINDOW_MS || 60 * 1000; // 1 min
const LIMIT = +process.env.VATFIX_RPS_LIMIT || 60;            // requests/window/key

/**
 * Increment usage for a key + window and enforce limit.
 * Returns { allowed: boolean, reason?: string }
 */
export async function meterAndCheck({ apiKey, email, countryCode, vatNumber }) {
  if (!BUCKET) return { allowed: true }; // no bucket, no limit

  const now = Date.now();
  const window = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const key = `meter/${apiKey}/${window}.json`;

  let doc = { count: 0, window, key: apiKey };
  try {
    const obj = await s3.getObject({ Bucket: BUCKET, Key: key }).promise();
    doc = JSON.parse(obj.Body.toString('utf-8'));
  } catch {
    // first hit for this window
  }

  doc.count++;
  if (doc.count > LIMIT) {
    // write back current count and block
    await s3.putObject({
      Bucket: BUCKET, Key: key,
      Body: JSON.stringify(doc), ContentType: 'application/json'
    }).promise().catch(() => {});
    return { allowed: false, reason: 'rate_limit_exceeded' };
  }

  // persist count
  await s3.putObject({
    Bucket: BUCKET, Key: key,
    Body: JSON.stringify(doc), ContentType: 'application/json'
  }).promise().catch(() => {});

  // append audit log (best effort)
  const audit = {
    t: new Date().toISOString(),
    apiKey,
    email,
    countryCode,
    vatNumber
  };
  s3.putObject({
    Bucket: BUCKET,
    Key: `logs/${audit.t}_${vatNumber}.json`,
    Body: JSON.stringify(audit),
    ContentType: 'application/json'
  }).promise().catch(() => {});

  return { allowed: true };
}

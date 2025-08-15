// lib/meter.js — S3 metering + per‑key rate limiting (AWS SDK v3)
// Best‑effort: failures degrade to allowed:true. No DynamoDB, no locks.

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const {
  S3_BUCKET,
  AWS_REGION = 'eu-north-1',
  VATFIX_WINDOW_MS = '60000',   // 60s
  VATFIX_RPS_LIMIT = '120',     // max requests per window per key
} = process.env;

if (!S3_BUCKET) {
  console.warn('[meter] S3_BUCKET not set — rate limiting disabled');
}

const s3 = new S3Client({ region: AWS_REGION });
const WINDOW_MS = Number(VATFIX_WINDOW_MS) || 60000;
const LIMIT = Number(VATFIX_RPS_LIMIT) || 120;

// ----- tiny helpers -----
async function getJSON(Key) {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key }));
    const buf =
      typeof out.Body?.transformToByteArray === 'function'
        ? Buffer.from(await out.Body.transformToByteArray())
        : Buffer.from(await streamToBuffer(out.Body));
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}
async function putJSON(Key, data) {
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key,
        Body: JSON.stringify(data),
        ContentType: 'application/json',
      })
    );
  } catch {
    // swallow — best effort
  }
}
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/**
 * Increment usage for a key within the current window and enforce the limit.
 * Returns { allowed: boolean, reason?: string, remaining?: number }
 *
 * Note: S3 is not transactional. This is "good enough" to stop bursts.
 */
export async function meterAndCheck({ apiKey, email, countryCode, vatNumber }) {
  if (!S3_BUCKET || !apiKey) return { allowed: true, remaining: undefined };

  const now = Date.now();
  const window = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const day = new Date(window).toISOString().slice(0, 10); // YYYY-MM-DD
  const meterKey = `meter/${day}/${apiKey}/${window}.json`;

  try {
    let doc = (await getJSON(meterKey)) || { count: 0, window, apiKey, limit: LIMIT };
    doc.count = (Number(doc.count) || 0) + 1;

    // Persist new count (best effort)
    await putJSON(meterKey, doc);

    if (doc.count > LIMIT) {
      return { allowed: false, reason: 'rate_limit_exceeded', remaining: 0 };
    }

    // Tiny audit line (best effort). Overwrites by second — good enough.
    const t = new Date().toISOString().replace(/[:]/g, '-'); // safer key
    const audit = { t, apiKey, email, countryCode, vatNumber };
    putJSON(`logs/${day}/${t}_${vatNumber || 'unknown'}.json`, audit);

    return { allowed: true, remaining: Math.max(0, LIMIT - doc.count) };
  } catch (e) {
    console.error('[meter]', e?.message || e);
    return { allowed: true, remaining: undefined };
  }
}

// Expose constants for server headers/tests (optional)
export const WINDOW_MS_CONST = WINDOW_MS;
export const LIMIT_CONST = LIMIT;

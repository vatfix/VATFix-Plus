// lookup.js — drop‑in replacement
// Preserves legacy behavior, adds PLUS fallback + S3 cache when VATFIX_PLUS=1

import https from 'https';
import soap from 'soap';
import AWS from 'aws-sdk';

const s3 = new AWS.S3();
const WSDL = 'https://ec.europa.eu/taxation_customs/vies/checkVatService.wsdl';
const BUCKET = process.env.S3_BUCKET;
const CACHE_TTL_MS = +process.env.VATFIX_CACHE_TTL_MS || 12 * 3600 * 1000; // 12h

function cacheKey(countryCode, vatNumber) {
  return `cache/${countryCode}_${vatNumber}.json`;
}

async function getCached(countryCode, vatNumber) {
  if (!BUCKET) return null;
  try {
    const obj = await s3.getObject({ Bucket: BUCKET, Key: cacheKey(countryCode, vatNumber) }).promise();
    const data = JSON.parse(obj.Body.toString('utf-8'));
    const fresh = Date.now() - new Date(data.cachedAt).getTime() < CACHE_TTL_MS;
    return fresh ? data.payload : null;
  } catch {
    return null;
  }
}

async function setCached(countryCode, vatNumber, payload) {
  if (!BUCKET) return;
  try {
    await s3
      .putObject({
        Bucket: BUCKET,
        Key: cacheKey(countryCode, vatNumber),
        Body: JSON.stringify({ cachedAt: new Date().toISOString(), payload }),
        ContentType: 'application/json',
      })
      .promise();
  } catch {
    // non‑fatal
  }
}

async function viesCall(countryCode, vatNumber) {
  const client = await soap.createClientAsync(WSDL, {
    httpsAgent: new https.Agent({ keepAlive: true }),
  });
  const [result] = await client.checkVatAsync({ countryCode, vatNumber });
  return result;
}

/**
 * validateVAT — legacy signature retained
 * If VATFIX_PLUS=1 → resilient flow:
 *    VIES → cache result → return
 *    On error: return cached (if any) else deterministic soft‑deny
 * Else (legacy): raw VIES call + log, no cache
 */
export async function validateVAT({ countryCode, vatNumber, email }) {
  const isPlus = process.env.VATFIX_PLUS === '1';

  // Best‑effort write‑only request log (legacy behavior retained)
  try {
    if (BUCKET) {
      const timestamp = new Date().toISOString();
      const logEntry = { timestamp, countryCode, vatNumber, email };
      await s3
        .putObject({
          Bucket: BUCKET,
          Key: `logs/${timestamp}_${vatNumber}.json`,
          Body: JSON.stringify(logEntry),
          ContentType: 'application/json',
        })
        .promise();
    }
  } catch {
    // ignore logging failures
  }

  // PLUS path: VIES with cache + fallback
  if (isPlus) {
    try {
      const res = await viesCall(countryCode, vatNumber);
      if (typeof res?.valid === 'boolean') await setCached(countryCode, vatNumber, res);
      return res;
    } catch (err) {
      const cached = await getCached(countryCode, vatNumber);
      if (cached) return { ...cached, cached: true };
      return {
        countryCode,
        vatNumber,
        valid: false,
        error: `fallback:${err?.message || 'unavailable'}`,
      };
    }
  }

  // Legacy path: direct VIES, let errors surface as 500 upstream
  const result = await viesCall(countryCode, vatNumber);
  return result;
}

// ✅ Add this to support expected default export in server.mjs
export async function checkVAT({ countryCode, vatNumber, email }) {
  return validateVAT({ countryCode, vatNumber, email });
}

export default checkVAT;

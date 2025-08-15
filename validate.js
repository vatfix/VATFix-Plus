// lib/validate.js — VIES validator with S3 (AWS SDK v3) cache + resilient fallback
// Stable payload: { countryCode, vatNumber, valid, name, address, requestDate, lookupId, source, cacheTtlMs, [cached], [error] }

import https from 'https';
import soap from 'soap';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const {
  S3_BUCKET,
  AWS_REGION = 'eu-north-1',
  VATFIX_CACHE_TTL_MS = String(12 * 3600 * 1000), // 12h
} = process.env;

const s3 = new S3Client({ region: AWS_REGION });
const WSDL = 'https://ec.europa.eu/taxation_customs/vies/checkVatService.wsdl';
const CACHE_TTL_MS = Number(VATFIX_CACHE_TTL_MS) || 12 * 3600 * 1000;

// Keep‑alive TLS; short socket + handshake timeouts
const httpsAgent = new https.Agent({ keepAlive: true, timeout: 2500 });

const cacheKey = (countryCode, vatNumber) =>
  `cache/${String(countryCode || '').toUpperCase()}_${String(vatNumber || '').replace(/\s+/g, '')}.json`;

// ---------- S3 helpers (v3) ----------
async function getJSON(Key) {
  if (!S3_BUCKET) return null;
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
  if (!S3_BUCKET) return;
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key,
        Body: JSON.stringify(data),
        ContentType: 'application/json',
      }),
    );
  } catch {
    // best‑effort
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

// ---------- Cache ----------
async function getCached(countryCode, vatNumber) {
  const rec = await getJSON(cacheKey(countryCode, vatNumber));
  if (!rec) return null;
  const fresh = Date.now() - new Date(rec.cachedAt).getTime() < CACHE_TTL_MS;
  return fresh ? rec.payload : null;
}
async function setCached(countryCode, vatNumber, payload) {
  await putJSON(cacheKey(countryCode, vatNumber), {
    cachedAt: new Date().toISOString(),
    payload,
  });
}

// ---------- VIES ----------
async function viesCall(countryCode, vatNumber) {
  // soap allows passing wsdl_options to control agent/timeouts
  const client = await soap.createClientAsync(WSDL, {
    wsdl_headers: { 'User-Agent': 'VATFix-Plus/1.0' },
    wsdl_options: { agent: httpsAgent, timeout: 2500 },
    // endpoint left default; WSDL provides it
  });
  const [raw] = await client.checkVatAsync({ countryCode, vatNumber });
  // raw: { countryCode, vatNumber, requestDate, valid, name, address }
  return raw;
}

// Normalize VIES requestDate to valid ISO 8601
function normalizeRequestDate(rd) {
  if (rd instanceof Date) {
    return Number.isNaN(rd.getTime()) ? new Date().toISOString() : rd.toISOString();
  }
  if (typeof rd === 'string') {
    // VIES often: "YYYY-MM-DD+HH:MM" → fix to parseable
    const fixed = rd.replace(/(\+\d{2}):?(\d{2})$/, '$1$2');
    const d = new Date(fixed);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  return new Date().toISOString();
}

// ---------- Public API ----------
/**
 * checkVAT({ countryCode, vatNumber, email? })
 * -> { countryCode, vatNumber, valid, name, address, requestDate, lookupId, source, cacheTtlMs, cached?, error? }
 */
export async function checkVAT({ countryCode, vatNumber, email }) {
  const cc = String(countryCode || '').toUpperCase().trim();
  const vn = String(vatNumber || '').replace(/\s+/g, '');
  const lookupId = `${cc}-${vn}-${Date.now().toString(36)}`;

  // write‑only audit (best‑effort)
  try {
    const t = new Date().toISOString().replace(/[:]/g, '-');
    await putJSON(`logs/${t}_${vn || 'unknown'}.json`, { t, countryCode: cc, vatNumber: vn, email });
  } catch {
    // ignore
  }

  try {
    // live VIES
    const res = await viesCall(cc, vn);
    const payload = {
      countryCode: res.countryCode || cc,
      vatNumber: res.vatNumber || vn,
      valid: !!res.valid,
      name: res.name || null,
      address: res.address || null,
      requestDate: normalizeRequestDate(res.requestDate),
      lookupId,
      source: 'vies',
      cacheTtlMs: CACHE_TTL_MS,
    };
    try { await setCached(cc, vn, payload); } catch {}
    return payload;
  } catch (err) {
    // cache fallback
    const cached = await getCached(cc, vn);
    if (cached) {
      return {
        ...cached,
        requestDate: new Date().toISOString(),
        lookupId,
        source: 'cache',
        cacheTtlMs: CACHE_TTL_MS,
        cached: true,
      };
    }
    // soft error
    return {
      countryCode: cc,
      vatNumber: vn,
      valid: false,
      name: null,
      address: null,
      requestDate: new Date().toISOString(),
      lookupId,
      source: 'error',
      cacheTtlMs: CACHE_TTL_MS,
      error: `fallback:${err?.message || 'unavailable'}`,
    };
  }
}

// legacy alias
export async function validateVAT(args) {
  return checkVAT(args);
}

export default checkVAT;

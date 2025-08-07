# 📟 VATFix Plus

Silent shell for automated EU VAT number validation.
Proxy fallback ready. No UI. No dependencies. No exposure.

---

## 🔌 Entry Point

**Endpoint:**

```
POST /vat/lookup
```

**Headers:**

* `x-api-key`: `sk_...` (required)
* `x-customer-email`: billing email (required)

**Body:**

```json
{
  "countryCode": "EU",
  "vatNumber": "123456789"
}
```

**Response:**

```json
{
  "countryCode": "EU",
  "vatNumber": "EU123456789",
  "requestDate": "2025-08-06",
  "valid": true,
  "name": "ACME CORP",
  "address": "123 EU VAT STREET\n10000 EXAMPLE CITY"
}
```

---

## 🧼 Errors

| Status | Message                | Meaning                         |
| ------ | ---------------------- | ------------------------------- |
| 401    | Invalid API key        | Bad `x-api-key` header          |
| 401    | Missing customer email | No `x-customer-email` header    |
| 400    | Missing VAT data       | No `countryCode` or `vatNumber` |
| 403    | Access denied          | No active Stripe subscription   |
| 429    | rate\_limit\_exceeded  | Key over quota                  |
| 502    | fallback\:unavailable  | VIES offline, no cache fallback |
| 500    | validation\_failed     | Uncaught error during lookup    |

---

## 🧱 Infrastructure

| Component         | Description                          |
| ----------------- | ------------------------------------ |
| **Hosting**       | Fly.io                               |
| **Rate Limiting** | S3 metering per `x-api-key`          |
| **Logging**       | S3 bucket logs requests `/logs/...`  |
| **Billing**       | Stripe → `vatfix_plus_001`           |
| **Cache**         | S3 caching if `VATFIX_PLUS=1` is set |

---

## ✅ Compliance

* GDPR-compliant. No user-tracking.
* Legal terms verified by Iubenda.
* Public VIES WSDL only: `ec.europa.eu/taxation_customs/vies`

---

## 🔚 Exit Protocol

* Hitting `https://vatfix.eu/kill` disables `/vat/lookup`
* Stripe SKU archived
* All logs exported to S3
* Domain cancelled via Njalla API

---

## 👷 Dev Mode

Set environment variables in `.env` or deploy config:

```bash
PORT=3000
API_KEY=sk_...
STRIPE_SECRET_KEY=sk_test_...
S3_BUCKET=vatfix-logs
VATFIX_PLUS=1
VATFIX_CACHE_TTL_MS=43200000
VATFIX_PRICE_IDS=price_1RpxXnLxlDpcd1R1baTsCsPZ,price_1RpxbaLxlDpcd1R1ydGR3ej6
```

---

## ⛑ Fallback Logic (when `VATFIX_PLUS=1`)

1. Try real-time VIES
2. If success → cache result in S3
3. If error:

   * Return cached result (if available)
   * Otherwise soft-fail with fallback error

---

## 📝 Notes

* No frontend
* No dashboard
* No analytics
* Just works™️

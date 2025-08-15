# 📟 VATFix Plus — INSTRUCTIONS.md

This file is **internal-use only**. Do not include in public README or documentation.

---

## 🧱 STACK

* **Runtime**: Node.js (ESM modules)
* **Server**: Express
* **Infra**: Fly.io (global edge)
* **Storage**: S3 (for validation logs)
* **Billing**: Stripe (Checkout, Webhooks)
* **Email**: ProtonMail + SimpleLogin SMTP aliases

---

## 🚀 DEPLOYMENT STEPS

1. **Clone repo**

```bash
git clone https://github.com/vatfix/vatfix-plus
cd vatfix-plus
```

2. **Set secrets**

```bash
echo STRIPE_SECRET_KEY=sk_live_... >> .env
echo AWS_ACCESS_KEY_ID=... >> .env
...
```

3. **Install & run local**

```bash
npm install
node server.mjs
```

4. **Deploy to Fly.io**

```bash
fly launch
fly deploy
```

---

## 📬 WEBHOOKS

Stripe sends checkout + subscription events to:

```
POST https://plus.vatfix.eu/webhook
```

Webhook secret is set as:

```env
STRIPE_WEBHOOK_SECRET=whsec_...
```

Event flow:

* Create API key on `checkout.session.completed`
* Set quota based on `price_id`
* Track usage + rate limit via `meter.js`
* Revoke key on cancellation

---

## 🔐 S3 LOGGING

Each VAT lookup writes a log to S3 bucket:

```
/vatfix/{lookupId}.json
```

IAM user must have PutObject permission.

---

## 📈 API USAGE

Every request:

* Reads rate limits via `meter.js`
* Logs the request (header + IP + result)
* Responds with `X-Rate-Remaining` header

---

## 📡 STRIPE SETUP

Create products & pricing in Stripe Dashboard.
Example:

* **Plus Plan** → `price_1NX...`

These IDs are passed into:

```env
VATFIX_PRICE_IDS=price_1NXABC123,price_1NXDEF456
```

Only buyers with active Stripe subscription can use the API.

---

## 📤 SMTP SETUP

Used for recovery + alerts.
Set up SimpleLogin SMTP alias:

```env
MAIL_FROM=vault@vatfix.eu
SMTP_USER='vault@vatfix.eu'
SMTP_PASS='password'
SMTP_HOST=smtp.simplelogin.io
SMTP_PORT=587
```

---

## 🧪 TEST URLS

* [x] Live test: `https://plus.vatfix.eu/vat/lookup`
* [x] Billing page: `https://plus.vatfix.eu/buy`
* [x] Docs: `https://plus.vatfix.eu/plus`

---

## ✅ FINAL CHECK

* [ ] Stripe webhook responds 200 OK
* [ ] Lookup returns correct data
* [ ] S3 logs appear with lookupId
* [ ] Rate limits enforce per key
* [ ] No `.env` or `.log` in repo

Stay boring. Stay profitable.

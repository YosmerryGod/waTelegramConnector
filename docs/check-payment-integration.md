# Check Payment automatic Premium integration

Check Payment forwards incoming DANA Business notification events to WAGRAM. The Android notification is treated as an operational payment signal, not as a provider-signed settlement receipt.

## Server configuration

Set a long random secret on the WAGRAM server:

```bash
openssl rand -hex 32
```

Add the generated value to the WAGRAM process environment as:

```env
DANA_PAYMENT_MONITOR_API_KEY=<generated-secret>
```

Restart the WAGRAM process after updating the environment. Do not commit the secret to Git or put it in public documentation. Enter the same secret in Check Payment's API Key field.

## Check Payment configuration

- Backend URL: the HTTPS origin serving WAGRAM, without a path. Example: `https://your-wagram-domain.example`.
- API Key: the exact value configured as `DANA_PAYMENT_MONITOR_API_KEY`.

Check Payment posts to `POST /api/miniapp/payment-monitor/events` with `X-API-Key`.

## Automatic payment flow

1. WAGRAM creates a pending Premium QRIS order with a unique amount and a 15-minute expiry.
2. Check Payment accepts only the configured DANA package, incoming-payment title, DANA Bisnis body format, IDR currency, positive integer amount, and SHA-256 event ID.
3. The backend atomically matches the amount to one unexpired pending order.
4. A match marks the order approved and activates the corresponding Premium plan. Duplicate event IDs cannot activate the same order twice.
5. WAGRAM pushes the membership update to the open Mini App. The payment screen polls the order status as a fallback, shows a success check, then returns to the Chats page.
6. Unmatched notifications do not activate any account.

## Security and operational limitations

- Protect `DANA_PAYMENT_MONITOR_API_KEY` as a production secret and use HTTPS only.
- The API key authenticates the installed monitor, but Android notification content is not cryptographically signed by DANA. A compromised device or extracted key could forge an event.
- Unique QRIS amounts, short order expiry, exact notification-format checks, and event idempotency reduce accidental or duplicate activation, but do not provide the same assurance as a DANA/provider settlement webhook.
- For higher-value production payments, replace notification-based settlement with an official provider callback or transaction-status API when available.

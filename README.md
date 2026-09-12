# BEST TRADERS TEAM — Vercel + Neon + Brevo Email OTP

This version keeps the working Postgres/Neon authentication and adds email verification for account creation using Brevo transactional email API.

## Vercel environment variables

Keep your existing values:

- `DATABASE_URL`
- `SESSION_SECRET`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`

Add these three:

- `BREVO_API_KEY` — your Brevo API key
- `BREVO_SENDER_EMAIL` — an email sender verified in Brevo
- `BREVO_SENDER_NAME` — e.g. `BEST TRADERS TEAM`

Brevo's transactional email API uses `POST https://api.brevo.com/v3/smtp/email` and requires an API key plus a registered/verified sender.

## Signup flow

1. User opens Create Account.
2. User enters name, email and password.
3. Site sends a 6-digit OTP to the email through Brevo.
4. OTP is valid for 10 minutes and has a maximum of 5 incorrect attempts.
5. After successful verification, the account is created in Neon and the user is logged in.
6. Resend is rate-limited to once per 60 seconds.

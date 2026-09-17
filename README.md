# BEST TRADERS TEAM — All Features

This build preserves the working Neon/Postgres authentication, Brevo email OTP signup, login/logout, sessions and admin access, and adds the requested trading, wallet and admin features.

## Trading
Admin can create/edit/close calls for:
- Individual shares/stocks (examples: RELIANCE, TCS, HDFCBANK, INFY, SBIN)
- NIFTY / BANKNIFTY and other indexes
- MCX
- FOREX

Each call supports Buy/Sell, Entry, Stop Loss, Target 1/2/3 and status: Active, Target Hit, SL Hit, Closed.

## Wallet
- Server-side balance
- Credit/debit transaction ledger
- Deposit and withdrawal status
- Atomic withdrawal debit and insufficient-balance protection

## Deposits
- Amount
- UTR/reference
- Payment screenshot
- Duplicate UTR protection
- Admin approve/reject
- Approved deposits credit wallet automatically

## Withdrawals
- Saved bank details
- Amount request
- Pending/approved/rejected
- Admin approval atomically debits wallet
- Insufficient balance protection

## Notifications
New calls, deposit/withdrawal decisions, premium updates and admin broadcasts.

## Security
OTP/login rate limiting, admin-only endpoints, audit log, duplicate UTR checks, server-side wallet operations and protected bank data access.

## Required Vercel environment variables
Keep the existing:
`DATABASE_URL`, `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME`.

Do not replace working secret values. After deploying code, redeploy the Vercel project so the new server code is active.

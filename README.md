# BEST TRADERS TEAM — Consolidated Manual Trading Build

This build keeps the existing Express + Neon + Brevo authentication foundation and adds a consolidated trading-platform interface.

## User screens
Home, Markets, Watchlist, Portfolio, Orders, Funds, Premium and Profile.

## Manual trading flow
User submits BUY/SELL request → admin reviews → admin records actual execution price → executed orders appear in the user order history/holdings view. No claim of live exchange execution is made. A broker API can be connected later behind the same order interface.

## Payments
Deposit QR and Premium QR are stored separately in Neon settings. Premium requests include UTR and optional payment screenshot for manual verification.

## Deployment
Keep the existing Vercel environment variables: DATABASE_URL, SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, BREVO_API_KEY, BREVO_SENDER_EMAIL, BREVO_SENDER_NAME.

const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const { randomInt } = require('crypto');
const { neon } = require('@neondatabase/serverless');

const app = express();
app.use(cookieParser());
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const BREVO_API_KEY = (process.env.BREVO_API_KEY || '').trim();
const BREVO_SENDER_EMAIL = (process.env.BREVO_SENDER_EMAIL || '').trim();
const BREVO_SENDER_NAME = (process.env.BREVO_SENDER_NAME || 'BEST TRADERS TEAM').trim();

if (!process.env.DATABASE_URL) console.warn('DATABASE_URL is not set. API/database features will not work until it is added.');
if (!SESSION_SECRET) console.warn('SESSION_SECRET is not set. Login will be unavailable until it is added.');
if (!BREVO_API_KEY) console.warn('BREVO_API_KEY is not set. Email OTP will not work until it is added.');
if (!BREVO_SENDER_EMAIL) console.warn('BREVO_SENDER_EMAIL is not set. Email OTP will not work until it is added.');

const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
let dbReady;

async function initDb() {
  if (!sql) throw new Error('DATABASE_URL is not configured');
  if (!dbReady) {
    dbReady = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        premium_until DATE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS calls (
        id SERIAL PRIMARY KEY,
        market TEXT NOT NULL,
        type TEXT NOT NULL,
        entry TEXT,
        status TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS payment_requests (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount INTEGER NOT NULL DEFAULT 1499,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reviewed_at TIMESTAMPTZ
      )`;
      await sql`CREATE TABLE IF NOT EXISTS signup_otps (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    })().catch(err => { dbReady = null; throw err; });
  }
  return dbReady;
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function signSession(payload) {
  if (!SESSION_SECRET) throw new Error('SESSION_SECRET is not configured');
  return jwt.sign(payload, SESSION_SECRET, { expiresIn: '7d' });
}
function readSession(req) {
  if (!SESSION_SECRET) return null;
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    try { return jwt.verify(authHeader.slice(7), SESSION_SECRET); } catch {}
  }
  const raw = req.cookies?.btt_session;
  if (!raw) return null;
  try { return jwt.verify(raw, SESSION_SECRET); } catch { return null; }
}
function sessionToken(payload) { return signSession(payload); }
function setSession(res, payload) {
  const token = signSession(payload);
  res.setHeader('Cache-Control', 'no-store');
  res.cookie('btt_session', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 604800000
  });
}
function clearSession(res) {
  res.setHeader('Set-Cookie', 'btt_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}
function auth(req, res, next) {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'Login required' });
  req.sessionUser = session;
  next();
}
function admin(req, res, next) {
  const session = readSession(req);
  if (!session || session.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  req.sessionUser = session;
  next();
}
function normalizeEmail(email) { return String(email || '').trim().toLowerCase(); }

app.get('/api/health', async (req, res) => {
  try { await initDb(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

const OTP_TTL_MINUTES = 10;
const OTP_RESEND_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;
function generateOtp() { return String(randomInt(100000, 1000000)); }
async function sendBrevoOtpEmail({ name, email, otp }) {
  if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) throw new Error('Email OTP service is not configured.');
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'api-key': BREVO_API_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
      to: [{ name, email }],
      subject: 'Your BEST TRADERS TEAM verification code',
      textContent: `Hello ${name},\n\nYour BEST TRADERS TEAM verification code is ${otp}.\n\nThis code expires in ${OTP_TTL_MINUTES} minutes. If you did not request this code, you can ignore this email.`,
      htmlContent: `<div style="font-family:Arial,sans-serif;line-height:1.6"><h2>BEST TRADERS TEAM</h2><p>Hello ${escapeHtmlServer(name)},</p><p>Your verification code is:</p><p style="font-size:30px;font-weight:800;letter-spacing:8px">${otp}</p><p>This code expires in ${OTP_TTL_MINUTES} minutes.</p><p>If you did not request this code, you can ignore this email.</p></div>`
    })
  });
  const body = await response.text();
  if (!response.ok) {
    let detail = 'Unable to send verification email.';
    try { detail = JSON.parse(body)?.message || detail; } catch {}
    throw new Error(detail);
  }
}
function escapeHtmlServer(s) {
  return String(s).replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
}

app.post('/api/signup/send-otp', async (req, res) => {
  try {
    await initDb();
    const name = String(req.body?.name || '').trim();
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!name || !email || password.length < 8) return res.status(400).json({ error: 'Name, email and a password of at least 8 characters are required.' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (ADMIN_EMAIL && email === ADMIN_EMAIL) return res.status(409).json({ error: 'This email is reserved for the admin account.' });
    const existing = await sql`SELECT id FROM users WHERE email=${email} LIMIT 1`;
    if (existing.length) return res.status(409).json({ error: 'Email is already registered.' });
    const existingOtp = await sql`SELECT last_sent_at FROM signup_otps WHERE email=${email} LIMIT 1`;
    if (existingOtp.length) {
      const lastSentMs = new Date(existingOtp[0].last_sent_at).getTime();
      const remaining = Math.ceil((lastSentMs + OTP_RESEND_SECONDS * 1000 - Date.now()) / 1000);
      if (remaining > 0) return res.status(429).json({ error: `Please wait ${remaining} seconds before requesting another OTP.`, retry_after: remaining });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const otp = generateOtp();
    const codeHash = await bcrypt.hash(otp, 10);
    await sendBrevoOtpEmail({ name, email, otp });
    await sql`INSERT INTO signup_otps (name,email,password_hash,code_hash,expires_at,attempts,last_sent_at) VALUES (${name},${email},${passwordHash},${codeHash},NOW() + (${OTP_TTL_MINUTES} * INTERVAL '1 minute'),0,NOW()) ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name,password_hash=EXCLUDED.password_hash,code_hash=EXCLUDED.code_hash,expires_at=EXCLUDED.expires_at,attempts=0,last_sent_at=NOW()`;
    res.json({ ok: true, message: 'OTP sent to your email address.', expires_in: OTP_TTL_MINUTES * 60 });
  } catch (e) {
    console.error(e);
    const message = e.message === 'Email OTP service is not configured.' ? e.message : 'Unable to send OTP email.';
    res.status(500).json({ error: message });
  }
});

app.post('/api/signup/verify-otp', async (req, res) => {
  try {
    await initDb();
    const email = normalizeEmail(req.body?.email);
    const otp = String(req.body?.otp || '').trim();
    if (!/^\d{6}$/.test(otp)) return res.status(400).json({ error: 'Enter the 6-digit OTP.' });
    const rows = await sql`SELECT id,name,email,password_hash,code_hash,expires_at,attempts FROM signup_otps WHERE email=${email} LIMIT 1`;
    const pending = rows[0];
    if (!pending) return res.status(400).json({ error: 'No active OTP request found. Please request a new OTP.' });
    if (new Date(pending.expires_at).getTime() < Date.now()) {
      await sql`DELETE FROM signup_otps WHERE email=${email}`;
      return res.status(400).json({ error: 'OTP has expired. Please request a new OTP.' });
    }
    if (pending.attempts >= OTP_MAX_ATTEMPTS) {
      await sql`DELETE FROM signup_otps WHERE email=${email}`;
      return res.status(429).json({ error: 'Too many incorrect OTP attempts. Please request a new OTP.' });
    }
    const valid = await bcrypt.compare(otp, pending.code_hash);
    if (!valid) {
      await sql`UPDATE signup_otps SET attempts=attempts+1 WHERE email=${email}`;
      return res.status(400).json({ error: `Incorrect OTP. ${Math.max(0, OTP_MAX_ATTEMPTS - pending.attempts - 1)} attempts remaining.` });
    }
    const rows2 = await sql`INSERT INTO users (name,email,password_hash) VALUES (${pending.name},${pending.email},${pending.password_hash}) RETURNING id,name,email,role,premium_until`;
    const user = rows2[0];
    await sql`DELETE FROM signup_otps WHERE email=${email}`;
    setSession(res, user);
    res.json({ user, token: sessionToken(user) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email is already registered.' });
    console.error(e); res.status(500).json({ error: 'Unable to verify OTP and create account.' });
  }
});

app.post('/api/signup', async (req, res) => {
  res.status(410).json({ error: 'Email verification is required. Request an OTP first.' });
});

app.post('/api/login', async (req, res) => {
  try {
    await initDb();
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');

    if (ADMIN_EMAIL && email === ADMIN_EMAIL && ADMIN_PASSWORD && password === ADMIN_PASSWORD) {
      const adminUser = { id: 'admin', name: 'Administrator', email: ADMIN_EMAIL, role: 'admin', premium_until: null };
      setSession(res, adminUser);
      return res.json({ user: adminUser, token: sessionToken(adminUser) });
    }

    const rows = await sql`SELECT id,name,email,password_hash,role,premium_until FROM users WHERE email=${email} LIMIT 1`;
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Invalid email or password.' });
    delete user.password_hash;
    setSession(res, user);
    res.json({ user, token: sessionToken(user) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Unable to log in.' }); }
});

app.post('/api/logout', (req, res) => { clearSession(res); res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true }); });
app.get('/api/me', (req, res) => { res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate'); res.setHeader('Pragma','no-cache'); res.setHeader('Expires','0'); res.json({ user: readSession(req) }); });

app.get('/api/calls', async (req, res) => {
  try { await initDb(); const rows = await sql`SELECT id,market,type,entry,status,created_at FROM calls ORDER BY id DESC LIMIT 50`; res.json(rows); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Unable to load calls.' }); }
});

app.post('/api/payment-request', auth, async (req, res) => {
  try {
    await initDb();
    if (req.sessionUser.role === 'admin') return res.status(400).json({ error: 'Admin accounts do not need membership.' });
    const existing = await sql`SELECT id FROM payment_requests WHERE user_id=${req.sessionUser.id} AND status='pending' LIMIT 1`;
    if (existing.length) return res.json({ ok: true, status: 'pending' });
    await sql`INSERT INTO payment_requests (user_id,amount) VALUES (${req.sessionUser.id},1499)`;
    res.json({ ok: true, status: 'pending' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Unable to submit payment request.' }); }
});

app.post('/api/calls', admin, async (req, res) => {
  try {
    await initDb();
    const market = String(req.body?.market || '').trim();
    const type = String(req.body?.type || '').trim();
    const entry = String(req.body?.entry || '—').trim();
    const status = String(req.body?.status || 'Published').trim();
    if (!market || !type) return res.status(400).json({ error: 'Market and type are required.' });
    const rows = await sql`INSERT INTO calls (market,type,entry,status) VALUES (${market},${type},${entry},${status}) RETURNING id`;
    res.json({ id: rows[0].id });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Unable to publish call.' }); }
});

app.delete('/api/calls/:id', admin, async (req, res) => {
  try { await initDb(); await sql`DELETE FROM calls WHERE id=${Number(req.params.id)}`; res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Unable to delete call.' }); }
});

app.get('/api/admin/users', admin, async (req, res) => {
  try { await initDb(); res.json(await sql`SELECT id,name,email,role,premium_until,created_at FROM users ORDER BY id DESC`); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Unable to load members.' }); }
});

app.get('/api/admin/payments', admin, async (req, res) => {
  try {
    await initDb();
    res.json(await sql`SELECT p.id,p.amount,p.status,p.created_at,p.reviewed_at,u.name,u.email FROM payment_requests p JOIN users u ON u.id=p.user_id ORDER BY p.id DESC LIMIT 100`);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Unable to load payments.' }); }
});

app.post('/api/admin/payments/:id/approve', admin, async (req, res) => {
  try {
    await initDb();
    const id = Number(req.params.id);
    const rows = await sql`SELECT user_id FROM payment_requests WHERE id=${id} AND status='pending' LIMIT 1`;
    if (!rows.length) return res.status(404).json({ error: 'Payment request not found or already reviewed.' });
    await sql`UPDATE payment_requests SET status='approved', reviewed_at=NOW() WHERE id=${id}`;
    await sql`UPDATE users SET premium_until=(CURRENT_DATE + INTERVAL '30 days')::date WHERE id=${rows[0].user_id}`;
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Unable to approve payment.' }); }
});

app.post('/api/admin/payments/:id/reject', admin, async (req, res) => {
  try { await initDb(); await sql`UPDATE payment_requests SET status='rejected', reviewed_at=NOW() WHERE id=${Number(req.params.id)} AND status='pending'`; res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Unable to reject payment.' }); }
});

app.post('/api/admin/users/:id/premium', admin, async (req, res) => {
  try {
    await initDb();
    const until = String(req.body?.premium_until || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) return res.status(400).json({ error: 'Use YYYY-MM-DD.' });
    await sql`UPDATE users SET premium_until=${until} WHERE id=${Number(req.params.id)}`;
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Unable to update membership.' }); }
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Vercel runs this Express app as a serverless function. Keep listen() only for local development.
if (require.main === module) {
  app.listen(PORT, () => console.log(`BEST TRADERS TEAM running on port ${PORT}`));
}

module.exports = app;

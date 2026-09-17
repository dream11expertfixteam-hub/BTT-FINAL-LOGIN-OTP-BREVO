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
        referral_code TEXT UNIQUE,
        referred_by TEXT,
        referral_bonus NUMERIC(12,2) NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT`;
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by TEXT`;
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_bonus NUMERIC(12,2) NOT NULL DEFAULT 0`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_idx ON users(referral_code) WHERE referral_code IS NOT NULL`;
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
      await sql`ALTER TABLE calls ADD COLUMN IF NOT EXISTS stop_loss TEXT`;
      await sql`ALTER TABLE calls ADD COLUMN IF NOT EXISTS target1 TEXT`;
      await sql`ALTER TABLE calls ADD COLUMN IF NOT EXISTS target2 TEXT`;
      await sql`ALTER TABLE calls ADD COLUMN IF NOT EXISTS target3 TEXT`;
      await sql`ALTER TABLE calls ADD COLUMN IF NOT EXISTS asset_type TEXT DEFAULT 'Stock'`;
      await sql`ALTER TABLE calls ADD COLUMN IF NOT EXISTS chart_data TEXT`;
      await sql`CREATE TABLE IF NOT EXISTS orders (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        call_id INTEGER REFERENCES calls(id) ON DELETE SET NULL,
        side TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        price NUMERIC(14,2),
        order_type TEXT NOT NULL DEFAULT 'MARKET',
        status TEXT NOT NULL DEFAULT 'requested',
        execution_price NUMERIC(14,2),
        executed_at TIMESTAMPTZ,
        admin_note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS utr TEXT`;
      await sql`ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS screenshot TEXT`;
      await sql`CREATE TABLE IF NOT EXISTS site_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
      await sql`INSERT INTO site_settings(key,value) VALUES ('deposit_qr',''),('premium_qr',''),('upi_id',''),('premium_amount','1499'),('site_about','A trading-focused community platform.'),('site_contact','Use Help & Support to contact the team.'),('site_telegram','https://t.me/stockmarkets_calls') ON CONFLICT(key) DO NOTHING`;
      await sql`CREATE TABLE IF NOT EXISTS wallets (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        balance NUMERIC(14,2) NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS transactions (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        amount NUMERIC(14,2) NOT NULL,
        status TEXT NOT NULL DEFAULT 'completed',
        reference TEXT UNIQUE,
        description TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS deposits (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount NUMERIC(14,2) NOT NULL,
        utr TEXT NOT NULL UNIQUE,
        screenshot TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        reviewed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS bank_details (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        account_name TEXT NOT NULL,
        account_number TEXT NOT NULL,
        ifsc TEXT NOT NULL,
        bank_name TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS withdrawals (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount NUMERIC(14,2) NOT NULL,
        bank_snapshot TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        reviewed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS notifications (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'info',
        read_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS audit_logs (
        id BIGSERIAL PRIMARY KEY,
        actor_id TEXT,
        actor_role TEXT,
        action TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        details TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS support_tickets (
        id BIGSERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subject TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
        admin_reply TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS education_articles (
        id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'General',
        content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'published', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS site_updates (
        id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL, message TEXT NOT NULL, version TEXT,
        status TEXT NOT NULL DEFAULT 'published', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    })().catch(err => { dbReady = null; throw err; });
  }
  return dbReady;
}

app.use(express.json({ limit: '6mb' }));
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
function cleanText(value, max=500) { return String(value ?? '').trim().slice(0,max); }
function isValidAmount(value) {
  const n=Number(value);
  return Number.isFinite(n) && n>0 && n<=10000000 && Math.round(n*100)===n*100;
}
async function ensureWallet(userId) {
  await sql`INSERT INTO wallets(user_id,balance) VALUES(${Number(userId)},0) ON CONFLICT(user_id) DO NOTHING`;
}
async function notifyUser(userId,title,message,kind='info') {
  await sql`INSERT INTO notifications(user_id,title,message,kind) VALUES(${Number(userId)},${cleanText(title,120)},${cleanText(message,1000)},${kind})`;
}
async function notifyAllUsers(title,message,kind='broadcast') {
  await sql`INSERT INTO notifications(user_id,title,message,kind)
            SELECT id,${cleanText(title,120)},${cleanText(message,1000)},${kind} FROM users`;
}
const rateBuckets = new Map();
function rateLimit(key,limit,windowMs) {
  const now=Date.now(), b=rateBuckets.get(key)||{start:now,count:0};
  if(now-b.start>=windowMs){b.start=now;b.count=0;}
  b.count++; rateBuckets.set(key,b); return b.count<=limit;
}
async function audit(req,action,entityType='',entityId='',details='') {
  try {
    const a=req.sessionUser||{};
    await sql`INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,details)
              VALUES(${String(a.id??'')},${String(a.role??'')},${cleanText(action,120)},${cleanText(entityType,80)},${String(entityId)},${cleanText(details,2000)})`;
  } catch(e){ console.error('audit failed',e); }
}


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
    if(!rateLimit(`otp:${req.ip}`,8,15*60*1000)) return res.status(429).json({error:'Too many OTP requests. Please try later.'});
    await initDb();
    const name = String(req.body?.name || '').trim();
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const referralCode = String(req.body?.referral_code || '').trim().toUpperCase();
    if (!name || !email || password.length < 8) return res.status(400).json({ error: 'Name, email and a password of at least 8 characters are required.' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (ADMIN_EMAIL && email === ADMIN_EMAIL) return res.status(409).json({ error: 'This email is reserved for the admin account.' });
    const existing = await sql`SELECT id FROM users WHERE email=${email} LIMIT 1`;
    if (referralCode) { const ref = await sql`SELECT id FROM users WHERE referral_code=${referralCode} LIMIT 1`; if (!ref.length) return res.status(400).json({ error: 'Invalid referral code.' }); }
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
    await sql`INSERT INTO signup_otps (name,email,password_hash,code_hash,expires_at,attempts,last_sent_at,referral_code) VALUES (${name},${email},${passwordHash},${codeHash},NOW() + (${OTP_TTL_MINUTES} * INTERVAL '1 minute'),0,NOW(),${referralCode || null}) ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name,password_hash=EXCLUDED.password_hash,code_hash=EXCLUDED.code_hash,expires_at=EXCLUDED.expires_at,attempts=0,last_sent_at=NOW(),referral_code=EXCLUDED.referral_code`;
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
    const rows = await sql`SELECT id,name,email,password_hash,code_hash,expires_at,attempts,referral_code FROM signup_otps WHERE email=${email} LIMIT 1`;
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
    const rows2 = await sql`INSERT INTO users (name,email,password_hash,referral_code,referred_by) VALUES (${pending.name},${pending.email},${pending.password_hash},'BTT-' || UPPER(SUBSTRING(MD5(RANDOM()::TEXT || ${pending.email}) FROM 1 FOR 8)),${pending.referral_code}) RETURNING id,name,email,role,premium_until`;
    const user = rows2[0];
    await sql`DELETE FROM signup_otps WHERE email=${email}`;
    await ensureWallet(user.id);
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
    if(!rateLimit(`login:${req.ip}`,12,15*60*1000)) return res.status(429).json({error:'Too many login attempts. Please try later.'});
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
    await ensureWallet(user.id);
    setSession(res, user);
    res.json({ user, token: sessionToken(user) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Unable to log in.' }); }
});

app.post('/api/logout', (req, res) => { clearSession(res); res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true }); });
app.get('/api/me', (req, res) => { res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate'); res.setHeader('Pragma','no-cache'); res.setHeader('Expires','0'); res.json({ user: readSession(req) }); });


app.get('/api/calls', async (req,res)=>{
  try{
    await initDb();
    const rows=await sql`SELECT id,market,type,entry,stop_loss,target1,target2,target3,status,asset_type,chart_data,created_at FROM calls ORDER BY id DESC LIMIT 100`;
    res.json(rows.map(x=>({...x,chart_data:x.chart_data||''})));
  }catch(e){console.error(e);res.status(500).json({error:'Unable to load calls.'});}
});
app.post('/api/calls',admin,async(req,res)=>{
  try{
    await initDb();
    const market=cleanText(req.body?.market,100), type=cleanText(req.body?.type,20);
    const entry=cleanText(req.body?.entry,100), stop_loss=cleanText(req.body?.stop_loss,100);
    const target1=cleanText(req.body?.target1,100), target2=cleanText(req.body?.target2,100), target3=cleanText(req.body?.target3,100);
    const status=cleanText(req.body?.status||'Active',40), asset_type=cleanText(req.body?.asset_type||'Stock',30);
    const chart_data=String(req.body?.chart_data||'').slice(0,200000);
    if(!market||!entry||!['Buy','Sell'].includes(type)||!['Active','Target Hit','SL Hit','Closed'].includes(status))
      return res.status(400).json({error:'Invalid call fields.'});
    const rows=await sql`INSERT INTO calls(market,type,entry,stop_loss,target1,target2,target3,status,asset_type,chart_data)
      VALUES(${market},${type},${entry},${stop_loss},${target1},${target2},${target3},${status},${asset_type},${chart_data}) RETURNING *`;
    await notifyAllUsers('New trading call',`${market} ${type} — Entry ${entry}`,'call');
    await audit(req,'create_call','call',rows[0].id,`${asset_type} ${market} ${type}`);
    res.json(rows[0]);
  }catch(e){console.error(e);res.status(500).json({error:'Unable to publish call.'});}
});
app.patch('/api/calls/:id',admin,async(req,res)=>{
  try{
    await initDb(); const id=Number(req.params.id);
    const market=cleanText(req.body?.market,100), type=cleanText(req.body?.type,20), entry=cleanText(req.body?.entry,100);
    const stop_loss=cleanText(req.body?.stop_loss,100), target1=cleanText(req.body?.target1,100), target2=cleanText(req.body?.target2,100), target3=cleanText(req.body?.target3,100);
    const status=cleanText(req.body?.status,40), asset_type=cleanText(req.body?.asset_type||'Stock',30);
    const chart_data=String(req.body?.chart_data||'').slice(0,200000);
    if(!Number.isInteger(id)||!market||!entry||!['Buy','Sell'].includes(type)||!['Active','Target Hit','SL Hit','Closed'].includes(status))
      return res.status(400).json({error:'Invalid call fields.'});
    const rows=await sql`UPDATE calls SET market=${market},type=${type},entry=${entry},stop_loss=${stop_loss},target1=${target1},target2=${target2},target3=${target3},status=${status},asset_type=${asset_type},chart_data=${chart_data} WHERE id=${id} RETURNING *`;
    if(!rows.length)return res.status(404).json({error:'Call not found.'});
    await audit(req,'edit_call','call',id,`${asset_type} ${market} ${status}`);
    res.json(rows[0]);
  }catch(e){console.error(e);res.status(500).json({error:'Unable to update call.'});}
});
app.delete('/api/calls/:id',admin,async(req,res)=>{
  try{await initDb();const id=Number(req.params.id);await sql`DELETE FROM calls WHERE id=${id}`;await audit(req,'delete_call','call',id);res.json({ok:true});}
  catch(e){console.error(e);res.status(500).json({error:'Unable to delete call.'});}
});

/* Member order requests. Actual execution requires a broker/exchange integration. */
app.post('/api/orders',auth,async(req,res)=>{
  try{
    await initDb();
    const call_id=Number(req.body?.call_id), side=cleanText(req.body?.side,10).toUpperCase();
    const quantity=Number(req.body?.quantity), order_type=cleanText(req.body?.order_type||'MARKET',10).toUpperCase();
    const rawPrice=req.body?.price; const price=rawPrice===''||rawPrice==null?null:Number(rawPrice);
    if(!Number.isInteger(call_id)||!['BUY','SELL'].includes(side)||!Number.isInteger(quantity)||quantity<1||quantity>100000||!['MARKET','LIMIT'].includes(order_type)) return res.status(400).json({error:'Invalid order details.'});
    if(price!==null&&(!Number.isFinite(price)||price<0)) return res.status(400).json({error:'Invalid order price.'});
    const c=(await sql`SELECT id,market,type,status FROM calls WHERE id=${call_id} LIMIT 1`)[0];
    if(!c)return res.status(404).json({error:'Trading call not found.'});
    const r=await sql`INSERT INTO orders(user_id,call_id,side,quantity,price,order_type) VALUES(${req.sessionUser.id},${call_id},${side},${quantity},${price},${order_type}) RETURNING id,call_id,side,quantity,price,order_type,status,execution_price,executed_at,admin_note,created_at`;
    await audit(req,'order_request','order',r[0].id,`${side} ${c.market} x${quantity}`);
    res.json({ok:true,order:r[0],message:'Order request recorded.'});
  }catch(e){console.error(e);res.status(500).json({error:'Unable to submit order.'});}
});
app.get('/api/orders',auth,async(req,res)=>{
  try{await initDb();const rows=await sql`SELECT o.id,o.call_id,c.market,o.side,o.quantity,o.price,o.order_type,o.status,o.execution_price,o.executed_at,o.admin_note,o.created_at FROM orders o LEFT JOIN calls c ON c.id=o.call_id WHERE o.user_id=${req.sessionUser.id} ORDER BY o.id DESC LIMIT 100`;res.json(rows)}catch(e){console.error(e);res.status(500).json({error:'Unable to load orders.'});}
});

app.get('/api/admin/orders',admin,async(req,res)=>{
  try{await initDb(); const rows=await sql`SELECT o.id,o.user_id,u.name,u.email,o.call_id,c.market,o.side,o.quantity,o.price,o.order_type,o.status,o.execution_price,o.executed_at,o.admin_note,o.created_at FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN calls c ON c.id=o.call_id ORDER BY o.id DESC LIMIT 300`; res.json(rows.map(x=>({...x,price:x.price==null?null:Number(x.price),execution_price:x.execution_price==null?null:Number(x.execution_price)})));}
  catch(e){console.error(e);res.status(500).json({error:'Unable to load orders.'});}
});
app.post('/api/admin/orders/:id/review',admin,async(req,res)=>{
  try{await initDb(); const id=Number(req.params.id); const action=cleanText(req.body?.action,20).toLowerCase(); const execution=req.body?.execution_price===''||req.body?.execution_price==null?null:Number(req.body?.execution_price); const note=cleanText(req.body?.admin_note,500);
    if(!['approve','reject','execute','cancel'].includes(action)) return res.status(400).json({error:'Invalid order action.'});
    const o=(await sql`SELECT o.*,c.market FROM orders o LEFT JOIN calls c ON c.id=o.call_id WHERE o.id=${id} LIMIT 1`)[0]; if(!o)return res.status(404).json({error:'Order not found.'});
    if(action==='reject'||action==='cancel'){await sql`UPDATE orders SET status=${action==='reject'?'rejected':'cancelled'},admin_note=${note||('Order '+action+' by admin')} WHERE id=${id}`; await notifyUser(o.user_id,'Order update',`Order #${id} for ${o.market||'market'} was ${action}ed.`,'order'); await audit(req,action+'_order','order',id); return res.json({ok:true});}
    if(action==='approve'){await sql`UPDATE orders SET status='approved',admin_note=${note} WHERE id=${id}`; await notifyUser(o.user_id,'Order approved',`Order #${id} has been approved for manual execution.`,'order'); await audit(req,'approve_order','order',id); return res.json({ok:true});}
    if(execution===null||!Number.isFinite(execution)||execution<=0) return res.status(400).json({error:'Execution price is required.'});
    await sql`UPDATE orders SET status='executed',execution_price=${execution},executed_at=NOW(),admin_note=${note} WHERE id=${id}`; await notifyUser(o.user_id,'Order executed',`Order #${id} ${o.side} ${o.market||''} executed at ₹${execution}.`,'order'); await audit(req,'execute_order','order',id,`price ${execution}`); return res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Unable to review order.'});}
});

/* Existing membership request */
app.post('/api/payment-request',auth,async(req,res)=>{
  try{
    await initDb();
    if(req.sessionUser.role==='admin')return res.status(400).json({error:'Admin accounts do not need membership.'});
    const utr=cleanText(req.body?.utr,80); const screenshot=String(req.body?.screenshot||'').slice(0,3500000);
    if(!utr) return res.status(400).json({error:'UTR is required.'});
    const x=await sql`SELECT id FROM payment_requests WHERE user_id=${req.sessionUser.id} AND status='pending' LIMIT 1`;
    if(x.length)return res.json({ok:true,status:'pending'});
    const setting=(await sql`SELECT value FROM site_settings WHERE key='premium_amount' LIMIT 1`)[0];
    const amount=Math.max(1,Number(setting?.value||1499));
    await sql`INSERT INTO payment_requests(user_id,amount,utr,screenshot) VALUES(${req.sessionUser.id},${Math.round(amount)},${utr},${screenshot||null})`;
    await notifyUser(req.sessionUser.id,'Premium payment submitted','Your UTR has been submitted for admin verification.','premium');
    res.json({ok:true,status:'pending'});
  }catch(e){console.error(e);res.status(500).json({error:'Unable to submit payment request.'});}
});

/* Member wallet/profile/deposit/withdrawal/notification */
app.get('/api/wallet',auth,async(req,res)=>{
  try{
    await initDb();await ensureWallet(req.sessionUser.id);
    const w=(await sql`SELECT balance FROM wallets WHERE user_id=${req.sessionUser.id}`)[0];
    const tx=await sql`SELECT id,type,amount,status,reference,description,created_at FROM transactions WHERE user_id=${req.sessionUser.id} ORDER BY id DESC LIMIT 100`;
    res.json({balance:Number(w?.balance||0),transactions:tx.map(x=>({...x,amount:Number(x.amount)}))});
  }catch(e){console.error(e);res.status(500).json({error:'Unable to load wallet.'});}
});
app.get('/api/profile',auth,async(req,res)=>{
  try{
    await initDb();
    const user=(await sql`SELECT id,name,email,role,premium_until,referral_code,referred_by,referral_bonus,created_at FROM users WHERE id=${req.sessionUser.id}`)[0];
    const bank=(await sql`SELECT account_name,account_number,ifsc,bank_name FROM bank_details WHERE user_id=${req.sessionUser.id}`)[0]||null;
    res.json({user,bank});
  }catch(e){console.error(e);res.status(500).json({error:'Unable to load profile.'});}
});
app.post('/api/profile',auth,async(req,res)=>{
  try{await initDb();const name=cleanText(req.body?.name,100);if(!name)return res.status(400).json({error:'Name is required.'});
    await sql`UPDATE users SET name=${name} WHERE id=${req.sessionUser.id}`;res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Unable to update profile.'});}
});
app.post('/api/profile/password',auth,async(req,res)=>{
  try{
    if(!rateLimit(`pw:${req.sessionUser.id}`,5,15*60*1000))return res.status(429).json({error:'Too many password changes. Try later.'});
    await initDb();const current=String(req.body?.current_password||''),next=String(req.body?.new_password||'');
    if(next.length<8)return res.status(400).json({error:'New password must be at least 8 characters.'});
    const row=(await sql`SELECT password_hash FROM users WHERE id=${req.sessionUser.id}`)[0];
    if(!row||!(await bcrypt.compare(current,row.password_hash)))return res.status(401).json({error:'Current password is incorrect.'});
    await sql`UPDATE users SET password_hash=${await bcrypt.hash(next,12)} WHERE id=${req.sessionUser.id}`;
    await audit(req,'change_password','user',req.sessionUser.id);res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Unable to change password.'});}
});
app.post('/api/profile/bank',auth,async(req,res)=>{
  try{
    await initDb();
    const bank_name=cleanText(req.body?.bank_name,120),account_name=cleanText(req.body?.account_name,120),account_number=cleanText(req.body?.account_number,40),ifsc=cleanText(req.body?.ifsc,20).toUpperCase();
    if(!bank_name||!account_name||!account_number||!ifsc||!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc))return res.status(400).json({error:'Please enter valid bank details.'});
    await sql`INSERT INTO bank_details(user_id,account_name,account_number,ifsc,bank_name) VALUES(${req.sessionUser.id},${account_name},${account_number},${ifsc},${bank_name})
      ON CONFLICT(user_id) DO UPDATE SET account_name=EXCLUDED.account_name,account_number=EXCLUDED.account_number,ifsc=EXCLUDED.ifsc,bank_name=EXCLUDED.bank_name,updated_at=NOW()`;
    res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Unable to save bank details.'});}
});
app.post('/api/deposits',auth,async(req,res)=>{
  try{
    if(!rateLimit(`dep:${req.sessionUser.id}`,10,60*60*1000))return res.status(429).json({error:'Too many deposit submissions. Try later.'});
    await initDb();const amount=Number(req.body?.amount),utr=cleanText(req.body?.utr,100).toUpperCase(),screenshot=String(req.body?.screenshot||'');
    if(!isValidAmount(amount)||amount<100)return res.status(400).json({error:'Deposit amount must be at least ₹100.'});
    if(!/^[A-Z0-9][A-Z0-9 ._\/-]{5,80}$/.test(utr))return res.status(400).json({error:'Enter a valid UTR/reference number.'});
    if(screenshot.length>5_000_000)return res.status(400).json({error:'Screenshot is too large.'});
    const dup=await sql`SELECT id FROM deposits WHERE utr=${utr} LIMIT 1`;if(dup.length)return res.status(409).json({error:'This UTR has already been submitted.'});
    const r=await sql`INSERT INTO deposits(user_id,amount,utr,screenshot) VALUES(${req.sessionUser.id},${amount},${utr},${screenshot||null}) RETURNING id,status`;
    await notifyUser(req.sessionUser.id,'Deposit submitted',`₹${amount.toFixed(2)} deposit is pending admin verification.`,'deposit');
    await audit(req,'submit_deposit','deposit',r[0].id,`₹${amount} UTR ${utr}`);res.json({ok:true,deposit:r[0]});
  }catch(e){console.error(e);if(e.code==='23505')return res.status(409).json({error:'This UTR has already been submitted.'});res.status(500).json({error:'Unable to submit deposit.'});}
});
app.post('/api/withdrawals',auth,async(req,res)=>{
  try{
    if(!rateLimit(`wd:${req.sessionUser.id}`,5,60*60*1000))return res.status(429).json({error:'Too many withdrawal requests. Try later.'});
    await initDb();const amount=Number(req.body?.amount);if(!isValidAmount(amount)||amount<100)return res.status(400).json({error:'Withdrawal amount must be at least ₹100.'});
    const bank=(await sql`SELECT account_name,account_number,ifsc,bank_name FROM bank_details WHERE user_id=${req.sessionUser.id}`)[0];
    if(!bank)return res.status(400).json({error:'Please save your bank details first.'});
    const p=await sql`SELECT id FROM withdrawals WHERE user_id=${req.sessionUser.id} AND status='pending' LIMIT 1`;if(p.length)return res.status(409).json({error:'You already have a pending withdrawal.'});
    await ensureWallet(req.sessionUser.id);const w=(await sql`SELECT balance FROM wallets WHERE user_id=${req.sessionUser.id}`)[0];
    if(Number(w.balance)<amount)return res.status(400).json({error:'Insufficient wallet balance.'});
    const r=await sql`INSERT INTO withdrawals(user_id,amount,bank_snapshot) VALUES(${req.sessionUser.id},${amount},${JSON.stringify(bank)}) RETURNING id,status`;
    await notifyUser(req.sessionUser.id,'Withdrawal submitted',`₹${amount.toFixed(2)} withdrawal is pending admin review.`,'withdrawal');
    await audit(req,'submit_withdrawal','withdrawal',r[0].id,`₹${amount}`);res.json({ok:true,withdrawal:r[0]});
  }catch(e){console.error(e);res.status(500).json({error:'Unable to submit withdrawal.'});}
});
app.get('/api/notifications',auth,async(req,res)=>{
  try{await initDb();res.json(await sql`SELECT id,title,message,kind,read_at,created_at FROM notifications WHERE user_id=${req.sessionUser.id} ORDER BY id DESC LIMIT 100`);}
  catch(e){console.error(e);res.status(500).json({error:'Unable to load notifications.'});}
});
app.post('/api/notifications/read',auth,async(req,res)=>{
  try{await initDb();await sql`UPDATE notifications SET read_at=NOW() WHERE user_id=${req.sessionUser.id} AND read_at IS NULL`;res.json({ok:true});}
  catch(e){console.error(e);res.status(500).json({error:'Unable to update notifications.'});}
});

app.get('/api/payment-settings', async (req,res)=>{
  try{await initDb();const r=await sql`SELECT key,value FROM site_settings WHERE key IN ('deposit_qr','premium_qr','upi_id','premium_amount')`;const out={};for(const x of r)out[x.key]=x.value||'';res.json(out);}
  catch(e){console.error(e);res.status(500).json({error:'Unable to load payment settings.'});}
});

/* Admin */
app.get('/api/admin/settings',admin,async(req,res)=>{
  try{await initDb();const r=await sql`SELECT key,value FROM site_settings WHERE key IN ('deposit_qr','premium_qr','upi_id','premium_amount')`;const out={};for(const x of r)out[x.key]=x.value||'';res.json(out);}
  catch(e){console.error(e);res.status(500).json({error:'Unable to load settings.'});}
});
app.post('/api/admin/settings',admin,async(req,res)=>{
  try{await initDb();const keys=['deposit_qr','premium_qr','upi_id','premium_amount'];for(const key of keys){let value=String(req.body?.[key]??'');if(key.endsWith('_qr') && value.length>3500000) return res.status(400).json({error:'QR image is too large.'});if(key==='premium_amount'){const n=Number(value);if(!Number.isFinite(n)||n<1||n>10000000)return res.status(400).json({error:'Invalid premium amount.'});value=String(Math.round(n));}await sql`INSERT INTO site_settings(key,value,updated_at) VALUES(${key},${value},NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`;}await audit(req,'update_payment_settings','settings','', 'Payment QR/UPI/premium amount updated');res.json({ok:true});}
  catch(e){console.error(e);res.status(500).json({error:'Unable to save settings.'});}
});

app.get('/api/admin/dashboard',admin,async(req,res)=>{
  try{
    await initDb();
    const users=(await sql`SELECT COUNT(*)::int c FROM users`)[0].c;
    const wallet=(await sql`SELECT COALESCE(SUM(balance),0) balance FROM wallets`)[0].balance;
    const pd=(await sql`SELECT COUNT(*)::int c FROM deposits WHERE status='pending'`)[0].c;
    const pw=(await sql`SELECT COUNT(*)::int c FROM withdrawals WHERE status='pending'`)[0].c;
    const ac=(await sql`SELECT COUNT(*)::int c FROM calls WHERE status='Active'`)[0].c;
    const pu=(await sql`SELECT COUNT(*)::int c FROM users WHERE premium_until>=CURRENT_DATE`)[0].c;
    const recent=await sql`SELECT t.id,t.user_id,u.name,u.email,t.type,t.amount,t.status,t.reference,t.description,t.created_at FROM transactions t JOIN users u ON u.id=t.user_id ORDER BY t.id DESC LIMIT 30`;
    res.json({users,total_wallet_balance:Number(wallet),pending_deposits:pd,pending_withdrawals:pw,active_calls:ac,premium_users:pu,recent_transactions:recent.map(x=>({...x,amount:Number(x.amount)}))});
  }catch(e){console.error(e);res.status(500).json({error:'Unable to load admin dashboard.'});}
});
app.get('/api/admin/deposits',admin,async(req,res)=>{
  try{await initDb();res.json(await sql`SELECT d.id,d.user_id,u.name,u.email,d.amount,d.utr,d.screenshot,d.status,d.created_at,d.reviewed_at FROM deposits d JOIN users u ON u.id=d.user_id ORDER BY d.id DESC LIMIT 200`);}
  catch(e){console.error(e);res.status(500).json({error:'Unable to load deposits.'});}
});
app.post('/api/admin/deposits/:id/approve',admin,async(req,res)=>{
  try{
    await initDb();const id=Number(req.params.id);
    const d=(await sql`UPDATE deposits SET status='approved',reviewed_at=NOW() WHERE id=${id} AND status='pending' RETURNING id,user_id,amount,utr`)[0];
    if(!d)return res.status(404).json({error:'Deposit not found or already reviewed.'});
    await ensureWallet(d.user_id);
    await sql`UPDATE wallets SET balance=balance+${d.amount},updated_at=NOW() WHERE user_id=${d.user_id}`;
    await sql`INSERT INTO transactions(user_id,type,amount,status,reference,description) VALUES(${d.user_id},'credit',${d.amount},'completed',${`DEP-${d.id}`},'Deposit approved') ON CONFLICT(reference) DO NOTHING`;
    await notifyUser(d.user_id,'Deposit approved',`₹${Number(d.amount).toFixed(2)} has been credited to your wallet.`,'deposit');
    await audit(req,'approve_deposit','deposit',id,`₹${d.amount} UTR ${d.utr}`);res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Unable to approve deposit.'});}
});
app.post('/api/admin/deposits/:id/reject',admin,async(req,res)=>{
  try{await initDb();const id=Number(req.params.id);
    const d=(await sql`UPDATE deposits SET status='rejected',reviewed_at=NOW() WHERE id=${id} AND status='pending' RETURNING user_id,amount`)[0];
    if(!d)return res.status(404).json({error:'Deposit not found or already reviewed.'});
    await notifyUser(d.user_id,'Deposit rejected',`Your ₹${Number(d.amount).toFixed(2)} deposit was rejected.`,'deposit');
    await audit(req,'reject_deposit','deposit',id);res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Unable to reject deposit.'});}
});
app.get('/api/admin/withdrawals',admin,async(req,res)=>{
  try{await initDb();const r=await sql`SELECT w.id,w.user_id,u.name,u.email,w.amount,w.bank_snapshot,w.status,w.created_at,w.reviewed_at FROM withdrawals w JOIN users u ON u.id=w.user_id ORDER BY w.id DESC LIMIT 200`;res.json(r.map(x=>({...x,amount:Number(x.amount)})));}
  catch(e){console.error(e);res.status(500).json({error:'Unable to load withdrawals.'});}
});
app.post('/api/admin/withdrawals/:id/approve',admin,async(req,res)=>{
  try{
    await initDb();const id=Number(req.params.id);
    const w=(await sql`SELECT id,user_id,amount FROM withdrawals WHERE id=${id} AND status='pending' LIMIT 1`)[0];
    if(!w)return res.status(404).json({error:'Withdrawal not found or already reviewed.'});
    await ensureWallet(w.user_id);
    const debited=await sql`UPDATE wallets SET balance=balance-${w.amount},updated_at=NOW() WHERE user_id=${w.user_id} AND balance>=${w.amount} RETURNING balance`;
    if(!debited.length)return res.status(400).json({error:'Insufficient wallet balance.'});
    const changed=await sql`UPDATE withdrawals SET status='approved',reviewed_at=NOW() WHERE id=${id} AND status='pending' RETURNING id`;
    if(!changed.length){await sql`UPDATE wallets SET balance=balance+${w.amount},updated_at=NOW() WHERE user_id=${w.user_id}`;return res.status(409).json({error:'Withdrawal was already reviewed.'});}
    await sql`INSERT INTO transactions(user_id,type,amount,status,reference,description) VALUES(${w.user_id},'debit',${w.amount},'completed',${`WD-${w.id}`},'Withdrawal approved') ON CONFLICT(reference) DO NOTHING`;
    await notifyUser(w.user_id,'Withdrawal approved',`₹${Number(w.amount).toFixed(2)} has been deducted from your wallet.`,'withdrawal');
    await audit(req,'approve_withdrawal','withdrawal',id,`₹${w.amount}`);res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Unable to approve withdrawal.'});}
});
app.post('/api/admin/withdrawals/:id/reject',admin,async(req,res)=>{
  try{await initDb();const id=Number(req.params.id);
    const w=(await sql`UPDATE withdrawals SET status='rejected',reviewed_at=NOW() WHERE id=${id} AND status='pending' RETURNING user_id,amount`)[0];
    if(!w)return res.status(404).json({error:'Withdrawal not found or already reviewed.'});
    await notifyUser(w.user_id,'Withdrawal rejected',`Your ₹${Number(w.amount).toFixed(2)} withdrawal was rejected. Wallet was not debited.`,'withdrawal');
    await audit(req,'reject_withdrawal','withdrawal',id);res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Unable to reject withdrawal.'});}
});
app.post('/api/admin/broadcast',admin,async(req,res)=>{
  try{await initDb();const title=cleanText(req.body?.title,120),message=cleanText(req.body?.message,1000);if(!title||!message)return res.status(400).json({error:'Title and message are required.'});await notifyAllUsers(title,message);await audit(req,'broadcast_notification','notification','',title);res.json({ok:true});}
  catch(e){console.error(e);res.status(500).json({error:'Unable to send broadcast.'});}
});
app.get('/api/admin/audit',admin,async(req,res)=>{
  try{await initDb();res.json(await sql`SELECT id,actor_id,actor_role,action,entity_type,entity_id,details,created_at FROM audit_logs ORDER BY id DESC LIMIT 200`);}
  catch(e){console.error(e);res.status(500).json({error:'Unable to load audit log.'});}
});
app.get('/api/admin/users',admin,async(req,res)=>{
  try{await initDb();res.json(await sql`SELECT id,name,email,role,premium_until,created_at FROM users ORDER BY id DESC`);}
  catch(e){console.error(e);res.status(500).json({error:'Unable to load members.'});}
});
app.get('/api/admin/payments',admin,async(req,res)=>{
  try{await initDb();res.json(await sql`SELECT p.id,p.amount,p.utr,p.screenshot,p.status,p.created_at,p.reviewed_at,u.name,u.email FROM payment_requests p JOIN users u ON u.id=p.user_id ORDER BY p.id DESC LIMIT 100`);}
  catch(e){console.error(e);res.status(500).json({error:'Unable to load payments.'});}
});
app.post('/api/admin/payments/:id/approve',admin,async(req,res)=>{
  try{await initDb();const id=Number(req.params.id);const r=(await sql`UPDATE payment_requests SET status='approved',reviewed_at=NOW() WHERE id=${id} AND status='pending' RETURNING user_id`)[0];if(!r)return res.status(404).json({error:'Payment request not found or already reviewed.'});await sql`UPDATE users SET premium_until=(CURRENT_DATE+INTERVAL '30 days')::date WHERE id=${r.user_id}`;await notifyUser(r.user_id,'Premium activated','Your premium membership has been activated for 30 days.','premium');res.json({ok:true});}
  catch(e){console.error(e);res.status(500).json({error:'Unable to approve payment.'});}
});
app.post('/api/admin/payments/:id/reject',admin,async(req,res)=>{
  try{await initDb();const id=Number(req.params.id);const r=(await sql`UPDATE payment_requests SET status='rejected',reviewed_at=NOW() WHERE id=${id} AND status='pending' RETURNING user_id`)[0];if(!r)return res.status(404).json({error:'Payment request not found or already reviewed.'});await notifyUser(r.user_id,'Premium payment rejected','Your premium payment request was rejected.','premium');res.json({ok:true});}
  catch(e){console.error(e);res.status(500).json({error:'Unable to reject payment.'});}
});
app.post('/api/admin/users/:id/premium',admin,async(req,res)=>{
  try{await initDb();const until=String(req.body?.premium_until||'').trim();if(!/^\d{4}-\d{2}-\d{2}$/.test(until))return res.status(400).json({error:'Use YYYY-MM-DD.'});const id=Number(req.params.id);await sql`UPDATE users SET premium_until=${until} WHERE id=${id}`;await notifyUser(id,'Membership updated',`Your premium membership expiry is now ${until}.`,'premium');res.json({ok:true});}
  catch(e){console.error(e);res.status(500).json({error:'Unable to update membership.'});}
});

/* Support, education, updates, history and content management */
app.post('/api/support/tickets',auth,async(req,res)=>{try{await initDb();const subject=cleanText(req.body?.subject,160),message=cleanText(req.body?.message,3000);if(!subject||!message)return res.status(400).json({error:'Subject and message are required.'});const r=await sql`INSERT INTO support_tickets(user_id,subject,message) VALUES(${req.sessionUser.id},${subject},${message}) RETURNING id,status,created_at`;await audit(req,'create_ticket','support_ticket',r[0].id,subject);res.json({ok:true,ticket:r[0]})}catch(e){console.error(e);res.status(500).json({error:'Unable to create support ticket.'})}});
app.get('/api/support/tickets',auth,async(req,res)=>{try{await initDb();res.json(await sql`SELECT id,subject,message,status,admin_reply,created_at,updated_at FROM support_tickets WHERE user_id=${req.sessionUser.id} ORDER BY id DESC LIMIT 100`)}catch(e){console.error(e);res.status(500).json({error:'Unable to load support tickets.'})}});
app.get('/api/education',async(req,res)=>{try{await initDb();res.json(await sql`SELECT id,title,category,content,created_at,updated_at FROM education_articles WHERE status='published' ORDER BY id DESC LIMIT 100`)}catch(e){console.error(e);res.status(500).json({error:'Unable to load education.'})}});
app.get('/api/updates',async(req,res)=>{try{await initDb();res.json(await sql`SELECT id,title,message,version,created_at FROM site_updates WHERE status='published' ORDER BY id DESC LIMIT 50`)}catch(e){console.error(e);res.status(500).json({error:'Unable to load updates.'})}});
app.get('/api/call-history',auth,async(req,res)=>{try{await initDb();res.json(await sql`SELECT id,market,type,entry,stop_loss,target1,target2,target3,status,created_at FROM calls WHERE status IN ('Target Hit','SL Hit','Closed') ORDER BY id DESC LIMIT 100`)}catch(e){console.error(e);res.status(500).json({error:'Unable to load call history.'})}});
app.get('/api/admin/tickets',admin,async(req,res)=>{try{await initDb();res.json(await sql`SELECT t.id,t.user_id,u.name,u.email,t.subject,t.message,t.status,t.admin_reply,t.created_at,t.updated_at FROM support_tickets t JOIN users u ON u.id=t.user_id ORDER BY t.id DESC LIMIT 300`)}catch(e){console.error(e);res.status(500).json({error:'Unable to load tickets.'})}});
app.post('/api/admin/tickets/:id/reply',admin,async(req,res)=>{try{await initDb();const id=Number(req.params.id),reply=cleanText(req.body?.reply,3000),status=cleanText(req.body?.status,30)||'open';if(!reply)return res.status(400).json({error:'Reply is required.'});const r=await sql`UPDATE support_tickets SET admin_reply=${reply},status=${status},updated_at=NOW() WHERE id=${id} RETURNING user_id`;if(!r.length)return res.status(404).json({error:'Ticket not found.'});await notifyUser(r[0].user_id,'Support ticket update',reply,'support');await audit(req,'reply_ticket','support_ticket',id,status);res.json({ok:true})}catch(e){console.error(e);res.status(500).json({error:'Unable to reply to ticket.'})}});
app.get('/api/admin/education',admin,async(req,res)=>{try{await initDb();res.json(await sql`SELECT * FROM education_articles ORDER BY id DESC LIMIT 300`)}catch(e){console.error(e);res.status(500).json({error:'Unable to load education.'})}});
app.post('/api/admin/education',admin,async(req,res)=>{try{await initDb();const id=req.body?.id?Number(req.body.id):0,title=cleanText(req.body?.title,180),category=cleanText(req.body?.category,80)||'General',content=cleanText(req.body?.content,12000),status=cleanText(req.body?.status,30)||'published';if(!title||!content)return res.status(400).json({error:'Title and content are required.'});if(id)await sql`UPDATE education_articles SET title=${title},category=${category},content=${content},status=${status},updated_at=NOW() WHERE id=${id}`;else await sql`INSERT INTO education_articles(title,category,content,status) VALUES(${title},${category},${content},${status})`;await audit(req,id?'update_education':'create_education','education',id||'',title);res.json({ok:true})}catch(e){console.error(e);res.status(500).json({error:'Unable to save education article.'})}});
app.delete('/api/admin/education/:id',admin,async(req,res)=>{try{await initDb();await sql`DELETE FROM education_articles WHERE id=${Number(req.params.id)}`;await audit(req,'delete_education','education',req.params.id);res.json({ok:true})}catch(e){console.error(e);res.status(500).json({error:'Unable to delete article.'})}});
app.get('/api/admin/updates',admin,async(req,res)=>{try{await initDb();res.json(await sql`SELECT * FROM site_updates ORDER BY id DESC LIMIT 200`)}catch(e){console.error(e);res.status(500).json({error:'Unable to load updates.'})}});
app.post('/api/admin/updates',admin,async(req,res)=>{try{await initDb();const title=cleanText(req.body?.title,180),message=cleanText(req.body?.message,3000),version=cleanText(req.body?.version,50),status=cleanText(req.body?.status,30)||'published';if(!title||!message)return res.status(400).json({error:'Title and message are required.'});const r=await sql`INSERT INTO site_updates(title,message,version,status) VALUES(${title},${message},${version},${status}) RETURNING id`;await notifyAllUsers(title,message,'update');await audit(req,'publish_update','site_update',r[0].id,title);res.json({ok:true,id:r[0].id})}catch(e){console.error(e);res.status(500).json({error:'Unable to publish update.'})}});
app.get('/api/admin/call-performance',admin,async(req,res)=>{try{await initDb();const rows=await sql`SELECT status,COUNT(*)::int count FROM calls GROUP BY status ORDER BY status`;res.json(rows)}catch(e){console.error(e);res.status(500).json({error:'Unable to load call performance.'})}});
app.get('/api/admin/content',admin,async(req,res)=>{try{await initDb();const r=await sql`SELECT key,value FROM site_settings WHERE key IN ('site_about','site_contact','site_telegram') ORDER BY key`;res.json(Object.fromEntries(r.map(x=>[x.key,x.value])))}catch(e){console.error(e);res.status(500).json({error:'Unable to load content.'})}});
app.post('/api/admin/content',admin,async(req,res)=>{try{await initDb();for(const key of ['site_about','site_contact','site_telegram']){if(req.body?.[key]!==undefined)await sql`INSERT INTO site_settings(key,value,updated_at) VALUES(${key},${cleanText(req.body[key],2000)},NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`}await audit(req,'update_site_content','site_settings','','Public website content updated');res.json({ok:true})}catch(e){console.error(e);res.status(500).json({error:'Unable to save content.'})}});
app.get('/api/admin/portfolio',admin,async(req,res)=>{try{await initDb();res.json(await sql`SELECT o.id,o.user_id,u.name,u.email,c.market,o.side,o.quantity,o.execution_price,o.executed_at,o.status FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN calls c ON c.id=o.call_id WHERE o.status='executed' ORDER BY o.id DESC LIMIT 500`)}catch(e){console.error(e);res.status(500).json({error:'Unable to load portfolio trades.'})}});
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Vercel runs this Express app as a serverless function. Keep listen() only for local development.
if (require.main === module) {
  app.listen(PORT, () => console.log(`BEST TRADERS TEAM running on port ${PORT}`));
}

module.exports = app;

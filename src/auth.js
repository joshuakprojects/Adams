const crypto = require('node:crypto');
const config = require('./config');

const SESSION_DAYS = 30;
const COOKIE = 'dispatch_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// Emails are stored lower-case so logins aren't case-sensitive (in SQLite and PostgreSQL alike).
class UserError extends Error {
  constructor(message) { super(message); this.status = 400; }
}
const ROLES = ['office', 'dispatcher', 'admin'];
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

/** Create a login, or update the name / password / role of an existing one (same email). */
async function createUser(db, { email, name, password, role = 'admin' }) {
  if (!email || !password || String(password).length < 8) throw new UserError('Email and a password of 8+ characters are required');
  email = String(email).trim().toLowerCase();
  if (!validEmail(email)) throw new UserError('That email address doesn\'t look right');
  if (!ROLES.includes(role)) throw new UserError('Unknown role');
  const existing = await db.get('SELECT id FROM users WHERE email = ?', email);
  if (existing) {
    await db.run('UPDATE users SET name = ?, password_hash = ?, role = ?, active = 1 WHERE id = ?', name || email, hashPassword(password), role, existing.id);
    return existing.id;
  }
  return Number((await db.run('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)',
    email, name || email, hashPassword(password), role)).lastInsertRowid);
}

async function listUsers(db) {
  return db.all('SELECT id, email, name, role, active, boss_notes, created_at FROM users ORDER BY active DESC, lower(name)');
}

/** Change a login's name, role, or password (blank = keep). Changing the password or turning a login off logs it out. */
async function updateUser(db, id, { name, role, password, active, boss_notes: bossNotes }) {
  const u = await db.get('SELECT * FROM users WHERE id = ?', Number(id));
  if (!u) throw new UserError('Login not found');
  if (role !== undefined && !ROLES.includes(role)) throw new UserError('Unknown role');
  if (password && String(password).length < 8) throw new UserError('Passwords need 8 or more characters');
  await db.run('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?',
    String(name ?? u.name).trim() || u.email, role ?? u.role, active === undefined ? u.active : (active ? 1 : 0), u.id);
  if (password) await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), u.id);
  if (bossNotes !== undefined) await db.run('UPDATE users SET boss_notes = ? WHERE id = ?', bossNotes ? 1 : 0, u.id);
  if (password || active === false) await db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
  return db.get('SELECT id, email, name, role, active, boss_notes, created_at FROM users WHERE id = ?', u.id);
}

/** Remove a login. Their work orders keep their name in the history. */
async function deleteUser(db, id) {
  await db.run('DELETE FROM sessions WHERE user_id = ?', Number(id));
  await db.run('DELETE FROM users WHERE id = ?', Number(id));
}

/** On first start, create the admin from ADMIN_EMAIL / ADMIN_PASSWORD if there are no users yet. */
async function ensureAdmin(db) {
  const count = (await db.get('SELECT COUNT(*) AS n FROM users')).n;
  if (count > 0) return;
  if (config.admin.email && config.admin.password) {
    await createUser(db, { email: config.admin.email, name: 'Admin', password: config.admin.password });
    console.log(`Created office login for ${config.admin.email}`);
  } else {
    console.warn('No office users yet. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env, or run: npm run add-user');
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function authRoutes(app, db) {
  const loginAttempts = new Map(); // ip -> { count, until }

  app.post('/api/login', async (req, res, next) => {
    try {
    const ip = req.ip;
    const rec = loginAttempts.get(ip);
    if (rec && rec.count >= 10 && rec.until > Date.now()) {
      return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    }
    const { email, password } = req.body || {};
    const user = await db.get('SELECT * FROM users WHERE email = ?', String(email || '').trim().toLowerCase());
    if (!user || !verifyPassword(password, user.password_hash) || !Number(user.active ?? 1)) {
      const next = rec && rec.until > Date.now() ? rec.count + 1 : 1;
      loginAttempts.set(ip, { count: next, until: Date.now() + 10 * 60 * 1000 });
      return res.status(401).json({ error: 'Wrong email or password' });
    }
    loginAttempts.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
    await db.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, user.id, expires.toISOString());
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${config.cookieSecure ? '; Secure' : ''}`);
    res.json({ ok: true, name: user.name });
    } catch (err) { next(err); }
  });

  app.post('/api/logout', async (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) await db.run('DELETE FROM sessions WHERE token = ?', token).catch(() => {});
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });
}

/** Attach req.user if the session cookie is valid. */
function loadUser(db) {
  return async (req, _res, next) => {
    try {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (token) {
        const row = await db.get(`SELECT u.id, u.email, u.name, u.role, u.active, u.boss_notes, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`, token);
        if (row && Number(row.active) && row.expires_at > new Date().toISOString()) {
          req.user = { id: row.id, email: row.email, name: row.name, role: row.role || 'admin', boss_notes: Number(row.boss_notes) || 0 };
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

function requireUser(req, res, next) {
  if (req.user) return next();
  if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Please log in' });
  res.redirect('/login');
}

module.exports = { hashPassword, verifyPassword, createUser, listUsers, updateUser, deleteUser, UserError, ensureAdmin, authRoutes, loadUser, requireUser };

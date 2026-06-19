import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from './db.js';

const TOKEN_COOKIE = 'hra_token';

export async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, plan: user.plan, isAdmin: Boolean(user.is_admin || user.isAdmin) },
    getJwtSecret(),
    { expiresIn: '7d' }
  );
}

export function setAuthCookie(res, token) {
  res.setHeader('Set-Cookie', `${TOKEN_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`);
}

export function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${TOKEN_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

export function getConfiguredAdminEmail() {
  return (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
}

export function isConfiguredAdminEmail(email = '') {
  const configuredAdmin = getConfiguredAdminEmail();
  return Boolean(configuredAdmin && email.trim().toLowerCase() === configuredAdmin);
}

export async function requireUser(req) {
  const token = getBearerToken(req) || getCookie(req, TOKEN_COOKIE);
  if (!token) {
    throw Object.assign(new Error('Authentication required'), { statusCode: 401 });
  }

  let payload;
  try {
    payload = jwt.verify(token, getJwtSecret());
  } catch {
    throw Object.assign(new Error('Authentication required'), { statusCode: 401 });
  }

  const result = await query('SELECT id, email, plan, is_admin, created_at FROM users WHERE id = $1', [payload.sub]);
  const user = result.rows[0];
  if (!user) {
    throw Object.assign(new Error('User not found'), { statusCode: 401 });
  }

  return user;
}

export function encryptSecret(value = '') {
  if (!value) return '';

  const iv = crypto.randomBytes(12);
  const key = getEncryptionKey();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSecret(value = '') {
  if (!value) return '';

  const [ivText, tagText, encryptedText] = value.split(':');
  if (!ivText || !tagText || !encryptedText) return '';

  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'base64')),
    decipher.final()
  ]).toString('utf-8');
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
}

function getCookie(req, name) {
  const rawCookie = req.headers.cookie || '';
  return rawCookie
    .split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name}=`))
    ?.slice(name.length + 1) || null;
}

function getJwtSecret() {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured.');
  }

  return process.env.JWT_SECRET;
}

function getEncryptionKey() {
  return crypto.createHash('sha256').update(getJwtSecret()).digest();
}

export async function requireAdmin(req) {
  const user = await requireUser(req);
  if (!user.is_admin && isConfiguredAdminEmail(user.email)) {
    await query("UPDATE users SET is_admin = true, plan = 'premium' WHERE id = $1", [user.id]);
    return { ...user, is_admin: true, plan: 'premium' };
  }

  if (!user.is_admin) {
    throw Object.assign(new Error('Admin permission required'), { statusCode: 403 });
  }
  
  return user;
}

import './env.js';
import pg from 'pg';
import bcrypt from 'bcryptjs';

const { Pool } = pg;

let pool;
let initialized = false;

export function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured.');
  }

  if (!pool) {
    const isLocalDatabase = process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1');
    const strictSsl = process.env.DB_SSL_STRICT === 'true';

    if (!isLocalDatabase && !strictSsl) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }

    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: isLocalDatabase ? false : { rejectUnauthorized: strictSsl }
    });
  }

  return pool;
}

export async function query(text, params = []) {
  await ensureSchema();
  return getPool().query(text, params);
}

export async function ensureSchema() {
  if (initialized) {
    return;
  }

  const db = getPool();
  await db.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text UNIQUE NOT NULL,
      password_hash text NOT NULL,
      plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'premium')),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free'");
  await db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()");
  await db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false");
  await db.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'name'
      ) THEN
        ALTER TABLE users ALTER COLUMN name DROP NOT NULL;
      END IF;
    END $$;
  `);
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_plan_check'
      ) THEN
        ALTER TABLE users ADD CONSTRAINT users_plan_check CHECK (plan IN ('free', 'pro', 'premium'));
      END IF;
    END $$;
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS user_credentials (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      linkedin_li_at text,
      linkedin_cookies text,
      gmail_user text,
      gmail_pass text,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.query('ALTER TABLE user_credentials ADD COLUMN IF NOT EXISTS linkedin_li_at text');
  await db.query('ALTER TABLE user_credentials ADD COLUMN IF NOT EXISTS linkedin_cookies text');
  await db.query('ALTER TABLE user_credentials ADD COLUMN IF NOT EXISTS gmail_user text');
  await db.query('ALTER TABLE user_credentials ADD COLUMN IF NOT EXISTS gmail_pass text');
  await db.query('ALTER TABLE user_credentials ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()');

  await db.query(`
    CREATE TABLE IF NOT EXISTS usage_logs (
      id bigserial PRIMARY KEY,
      user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      run_id text NOT NULL,
      emails_sent integer NOT NULL DEFAULT 0,
      posts_scraped integer NOT NULL DEFAULT 0,
      apollo_calls integer NOT NULL DEFAULT 0,
      timestamp timestamptz NOT NULL DEFAULT now(),
      plan_at_time text NOT NULL
    )
  `);
  await db.query('ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS emails_sent integer NOT NULL DEFAULT 0');
  await db.query('ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS posts_scraped integer NOT NULL DEFAULT 0');
  await db.query('ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS apollo_calls integer NOT NULL DEFAULT 0');
  await db.query('ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS timestamp timestamptz NOT NULL DEFAULT now()');
  await db.query("ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS plan_at_time text NOT NULL DEFAULT 'free'");

  await db.query(`
    CREATE TABLE IF NOT EXISTS coupons (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code text UNIQUE NOT NULL,
      plan text NOT NULL CHECK (plan IN ('pro', 'premium')),
      discount_percent integer NOT NULL DEFAULT 100 CHECK (discount_percent >= 0 AND discount_percent <= 100),
      max_uses integer,
      uses integer DEFAULT 0,
      is_active boolean DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.query('ALTER TABLE coupons ADD COLUMN IF NOT EXISTS discount_percent integer NOT NULL DEFAULT 100');
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'coupons_discount_percent_check'
      ) THEN
        ALTER TABLE coupons ADD CONSTRAINT coupons_discount_percent_check CHECK (discount_percent >= 0 AND discount_percent <= 100);
      END IF;
    END $$;
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS coupon_redemptions (
      id bigserial PRIMARY KEY,
      coupon_id uuid REFERENCES coupons(id) ON DELETE CASCADE,
      user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      redeemed_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT unique_user_coupon UNIQUE (user_id, coupon_id)
    )
  `);

  // Ensure the single admin user exists and is up to date in the database
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword) {
    const hashed = await bcrypt.hash(adminPassword, 12);
    const userRes = await db.query('SELECT id FROM users WHERE email = $1', [adminEmail.trim().toLowerCase()]);
    if (userRes.rows.length === 0) {
      await db.query(
        'INSERT INTO users (email, password_hash, plan, is_admin) VALUES ($1, $2, $3, true)',
        [adminEmail.trim().toLowerCase(), hashed, 'premium']
      );
      console.log(`[Admin Setup] Created admin account: ${adminEmail}`);
    } else {
      await db.query(
        "UPDATE users SET password_hash = $1, plan = 'premium', is_admin = true WHERE email = $2",
        [hashed, adminEmail.trim().toLowerCase()]
      );
    }
  }

  initialized = true;
}

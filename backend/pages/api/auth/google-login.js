import { isConfiguredAdminEmail, signToken, setAuthCookie } from '../../../backend/auth.js';
import { query } from '../../../backend/db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  const { credential } = req.body || {};
  if (!credential) {
    return res.status(400).json({ message: 'Google credential token is required.' });
  }

  try {
    // Verify ID Token with Google
    const googleVerifyRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`
    );

    if (!googleVerifyRes.ok) {
      return res.status(401).json({ message: 'Invalid Google credential token.' });
    }

    const payload = await googleVerifyRes.json();
    const { sub, email, email_verified } = payload;

    if (!email || (email_verified !== 'true' && email_verified !== true)) {
      return res.status(400).json({ message: 'Google email address is not verified or unavailable.' });
    }

    const normalizedEmail = email.toLowerCase();
    if (isConfiguredAdminEmail(normalizedEmail)) {
      return res.status(403).json({ message: 'Admin must sign in with the dedicated admin credentials.' });
    }

    // Upsert user into database
    const dbResult = await query(
      `
        INSERT INTO users (email, password_hash, plan)
        VALUES ($1, $2, 'free')
        ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
        RETURNING id, email, plan, is_admin, created_at
      `,
      [normalizedEmail, `google:${sub}`]
    );

    const user = dbResult.rows[0];

    // Generate JWT and set HttpOnly auth cookie
    const token = signToken(user);
    setAuthCookie(res, token);

    return res.status(200).json({ token, user });
  } catch (error) {
    console.error('Failed to login with Google:', error);
    return res.status(500).json({ message: error.message || 'Internal Server Error' });
  }
}

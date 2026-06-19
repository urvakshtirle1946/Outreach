import { hashPassword, isConfiguredAdminEmail, setAuthCookie, signToken, verifyPassword } from '../../../backend/auth.js';
import { query } from '../../../backend/db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const isConfiguredAdminLogin = isConfiguredAdminEmail(normalizedEmail) && password === process.env.ADMIN_PASSWORD;
    let result = await query('SELECT id, email, password_hash, plan, is_admin, created_at FROM users WHERE email = $1', [normalizedEmail]);
    let user = result.rows[0];

    if (isConfiguredAdminLogin && (!user || !(await verifyPassword(password, user.password_hash)) || !user.is_admin)) {
      const passwordHash = await hashPassword(password);
      const adminResult = await query(
        `
          INSERT INTO users (email, password_hash, plan, is_admin)
          VALUES ($1, $2, 'premium', true)
          ON CONFLICT (email) DO UPDATE SET
            password_hash = EXCLUDED.password_hash,
            plan = 'premium',
            is_admin = true
          RETURNING id, email, password_hash, plan, is_admin, created_at
        `,
        [normalizedEmail, passwordHash]
      );
      user = adminResult.rows[0];
    }

    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    const safeUser = {
      id: user.id,
      email: user.email,
      plan: user.plan,
      is_admin: user.is_admin,
      created_at: user.created_at
    };
    const token = signToken(safeUser);
    setAuthCookie(res, token);

    return res.status(200).json({ token, user: safeUser });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

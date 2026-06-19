import { requireUser } from '../../../backend/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  try {
    const user = await requireUser(req);
    return res.status(200).json({
      user: {
        id: user.id,
        email: user.email,
        plan: user.plan,
        is_admin: user.is_admin,
        created_at: user.created_at
      }
    });
  } catch (error) {
    return res.status(error.statusCode || 401).json({ message: error.message });
  }
}

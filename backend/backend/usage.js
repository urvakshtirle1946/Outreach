import { query } from './db.js';
import { getPlanLimits } from './plans.js';

export async function getUsageSummary(user) {
  const limits = getPlanLimits(user.plan);
  const result = await query(
    `
      SELECT
        COUNT(*)::int AS runs_today,
        COALESCE(SUM(emails_sent), 0)::int AS emails_sent_today,
        COALESCE(SUM(apollo_calls), 0)::int AS apollo_calls_today
      FROM usage_logs
      WHERE user_id = $1
        AND timestamp >= date_trunc('day', now())
    `,
    [user.id]
  );

  const row = result.rows[0] || {};
  return {
    runsToday: row.runs_today || 0,
    emailsSentToday: row.emails_sent_today || 0,
    apolloCallsToday: row.apollo_calls_today || 0,
    limits
  };
}

export async function canStartRun(user) {
  const usage = await getUsageSummary(user);
  if (usage.runsToday >= usage.limits.runsPerDay) {
    return {
      allowed: false,
      usage,
      response: {
        success: false,
        reason: 'limit_exceeded',
        message: 'Upgrade to Pro to run more searches today',
        upgradeUrl: '/pricing'
      }
    };
  }

  return { allowed: true, usage };
}

export async function recordUsage({ userId, runId, emailsSent = 0, postsScraped = 0, apolloCalls = 0, plan }) {
  await query(
    `
      INSERT INTO usage_logs (user_id, run_id, emails_sent, posts_scraped, apollo_calls, plan_at_time)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [userId, runId, emailsSent, postsScraped, apolloCalls, plan]
  );
}

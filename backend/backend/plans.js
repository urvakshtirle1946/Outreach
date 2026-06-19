export const PLAN_LIMITS = {
  free: {
    emailsPerRun: 10,
    runsPerDay: 1,
    apollo: false,
    apolloCallsPerDay: 10,
    watermark: true
  },
  pro: {
    emailsPerRun: 50,
    runsPerDay: 5,
    apollo: true,
    apolloCallsPerDay: 50,
    watermark: false
  },
  premium: {
    emailsPerRun: 999,
    runsPerDay: 999,
    apollo: true,
    apolloCallsPerDay: 200,
    watermark: false
  }
};

export function getPlanLimits(plan = 'free') {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
}

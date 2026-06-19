/**
 * Enriches a LinkedIn profile URL through Apollo people/match.
 * API failures are returned as misses so the agent can continue.
 */
export async function enrichEmail(linkedinProfileUrl, { apiKey = process.env.APOLLO_API_KEY, logger = console } = {}) {
  if (!linkedinProfileUrl) {
    return { email: null, source: null, error: 'Missing LinkedIn profile URL' };
  }

  if (!apiKey) {
    logger.warn('Apollo enrichment skipped: APOLLO_API_KEY is not configured.');
    return { email: null, source: null, error: 'Missing Apollo API key' };
  }

  try {
    const response = await fetch('https://api.apollo.io/api/v1/people/match', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      },
      body: JSON.stringify({
        api_key: apiKey,
        linkedin_url: linkedinProfileUrl,
        reveal_personal_emails: true
      })
    });

    if (!response.ok) {
      const errorText = await safeReadText(response);
      logger.warn(`Apollo enrichment skipped (${response.status}): ${errorText || response.statusText}`);
      return { email: null, source: null, error: `Apollo ${response.status}` };
    }

    const data = await response.json();
    const email = data?.person?.email || data?.person?.personal_emails?.[0] || null;

    if (!email) {
      return { email: null, source: null, error: null };
    }

    return { email: email.toLowerCase(), source: 'apollo', error: null };
  } catch (error) {
    logger.warn(`Apollo enrichment skipped: ${error.message}`);
    return { email: null, source: null, error: error.message };
  }
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

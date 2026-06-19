import { decryptSecret, requireUser } from '../../../backend/auth.js';
import { query } from '../../../backend/db.js';
import { getPlanLimits } from '../../../backend/plans.js';
import { getUsageSummary, recordUsage, canStartRun } from '../../../backend/usage.js';
import { enrichEmail } from '../../../backend/apollo.js';
import { customizeMail } from '../../../backend/customizer.js';
import { sendEmail } from '../../../backend/mailer.js';
import { filterRelevantPosts } from '../../../backend/extractor.js';
import { delay } from '../../../backend/utils/delay.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  try {
    // 1. Authenticate user from Bearer token
    let user;
    try {
      user = await requireUser(req);
    } catch (authErr) {
      return res.status(401).json({ message: 'Authentication required. Please log in.' });
    }

    // 2. Validate user daily run limits
    const limitCheck = await canStartRun(user);
    if (!limitCheck.allowed) {
      return res.status(403).json(limitCheck.response);
    }

    const {
      posts = [],
      template = '',
      subjectTemplate = 'Application for {role} Role'
    } = req.body || {};

    if (!Array.isArray(posts) || posts.length === 0) {
      return res.status(400).json({ message: 'No posts provided for processing.' });
    }

    const limits = getPlanLimits(user.plan);
    const usage = limitCheck.usage; // retrieved during canStartRun

    // 3. Load user's Gmail SMTP credentials
    const credsResult = await query(
      'SELECT gmail_user, gmail_pass FROM user_credentials WHERE user_id = $1',
      [user.id]
    );
    const creds = credsResult.rows[0];
    const gmailUser = creds?.gmail_user || null;
    const gmailAppPassword = creds?.gmail_pass ? decryptSecret(creds.gmail_pass) : null;

    // 4. Normalize posts and run Apollo enrichment
    const postsForExtraction = posts.map(p => ({
      text: p.postText || p.text || '',
      authorName: p.authorName || 'LinkedIn User',
      authorHeadline: p.authorTitle || p.authorHeadline || '',
      authorProfileUrl: p.authorProfileUrl || '',
      postUrl: p.postUrl || ''
    }));

    let apolloCallsUsed = 0;
    const enrichedPosts = [];

    for (let i = 0; i < postsForExtraction.length; i++) {
      const post = postsForExtraction[i];
      let enrichedEmail = { email: null, source: null };

      const apolloQuotaRemaining = Math.max(0, limits.apolloCallsPerDay - usage.apolloCallsToday - apolloCallsUsed);

      if (!limits.apollo) {
        console.log(`[Outly API] Apollo enrichment skipped: disabled on ${user.plan} plan.`);
      } else if (apolloQuotaRemaining <= 0) {
        console.log('[Outly API] Apollo enrichment skipped: daily quota limit reached.');
        enrichedEmail = { email: null, source: 'quota_exceeded_fallback' };
      } else if (post.authorProfileUrl) {
        apolloCallsUsed += 1;
        try {
          const apolloRes = await enrichEmail(post.authorProfileUrl, {
            apiKey: process.env.APOLLO_API_KEY,
            logger: console
          });
          enrichedEmail = apolloRes;
        } catch (apolloErr) {
          console.warn(`[Outly API] Apollo lookup error for ${post.authorName}:`, apolloErr.message);
        }
        await delay(500); // Prevent hitting rate limits
      }

      enrichedPosts.push({
        ...post,
        enrichedEmail
      });
    }

    // 5. Filter relevant posts containing emails (either Apollo or post text regex)
    const relevantPosts = filterRelevantPosts(enrichedPosts);

    if (relevantPosts.length === 0) {
      // Record run with 0 emails sent
      const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await recordUsage({
        userId: user.id,
        runId,
        emailsSent: 0,
        postsScraped: posts.length,
        apolloCalls: apolloCallsUsed,
        plan: user.plan
      });

      return res.status(200).json({
        success: true,
        results: [],
        message: 'No leads with contact email addresses found.'
      });
    }

    // 6. Limit process leads based on Plan Limit
    const maxLeads = Math.min(relevantPosts.length, limits.emailsPerRun);
    const leadsToProcess = relevantPosts.slice(0, maxLeads);

    const results = [];
    let emailsSentCount = 0;

    for (let i = 0; i < leadsToProcess.length; i++) {
      const post = leadsToProcess[i];
      
      // Extract Company Name from author headline
      const company = extractCompanyFromTitle(post.authorHeadline);

      const leadResult = {
        email: post.primaryEmail,
        role: post.role,
        company: company,
        authorName: post.authorName,
        status: 'pending',
        error: null
      };

      try {
        // A. Customize Mail via NVIDIA NIM
        const customizedBody = await customizeMail({
          postText: post.text,
          authorName: post.authorName,
          role: post.role,
          apiKey: process.env.NVIDIA_API_KEY,
          template: template
        });

        const finalBody = limits.watermark
          ? `${customizedBody}\n\nSent via Outly`
          : customizedBody;

        // B. Send Email if SMTP credentials exist
        if (gmailUser && gmailAppPassword) {
          const subject = subjectTemplate.replace(/{role}/g, post.role);
          await sendEmail({
            to: post.primaryEmail,
            subject,
            body: finalBody,
            gmailUser,
            gmailAppPassword
          });
          leadResult.status = 'sent';
          emailsSentCount += 1;
        } else {
          leadResult.status = 'dry-run';
        }
      } catch (err) {
        console.error(`[Outly API] Failed to process outreach for ${post.primaryEmail}:`, err);
        leadResult.status = 'failed';
        leadResult.error = err.message || 'Outreach processing failed.';
      }

      results.push(leadResult);

      // Delay between SMTP deliveries to prevent rate blocks
      if (i < leadsToProcess.length - 1 && gmailUser && gmailAppPassword) {
        await delay(2000);
      }
    }

    // 7. Record usage in DB
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await recordUsage({
      userId: user.id,
      runId,
      emailsSent: emailsSentCount,
      postsScraped: posts.length,
      apolloCalls: apolloCallsUsed,
      plan: user.plan
    });

    return res.status(200).json({
      success: true,
      results,
      message: `Successfully processed ${results.length} leads.`
    });

  } catch (error) {
    console.error('[Outly API] Process Endpoint crashed:', error);
    return res.status(500).json({ message: error.message || 'Internal server error.' });
  }
}

/**
 * Heuristically parses company name from a LinkedIn headline title.
 * Handles forms like: "at Company", "@ Company", "| Company", "- Company"
 */
function extractCompanyFromTitle(title) {
  if (!title) return '';
  
  // Try matching "at [Company]" or "@ [Company]"
  const atMatch = title.match(/\b(?:at|@)\s+([^|,\-\n\(\)]+)/i);
  if (atMatch && atMatch[1]) {
    return atMatch[1].trim();
  }
  
  // Try matching with "|" separator
  const pipeMatch = title.match(/\|\s*([^|,\-\n\(\)]+)/);
  if (pipeMatch && pipeMatch[1]) {
    return pipeMatch[1].trim();
  }
  
  // Try matching with "-" or "–" separator
  const dashMatch = title.match(/[\-\–]\s*([^|,\-\n\(\)]+)/);
  if (dashMatch && dashMatch[1]) {
    return dashMatch[1].trim();
  }
  
  return '';
}

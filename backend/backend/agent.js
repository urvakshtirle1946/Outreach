import fs from 'fs';
import path from 'path';
import { filterRelevantPosts } from './extractor.js';

// Playwright scraper disabled: scraping is now offloaded to the Outly Chrome Extension.
export async function scrapeLinkedInPosts() {
  throw new Error('Local Playwright scraping is deprecated. Please install the Outly Chrome Extension to run LinkedIn outreach campaigns directly from your browser.');
}
import { customizeMail } from './customizer.js';
import { sendEmail } from './mailer.js';
import { delay } from './utils/delay.js';
import { writeStatus } from './status.js';
import { enrichEmail } from './apollo.js';
import { getPlanLimits } from './plans.js';
import { getUsageSummary, recordUsage } from './usage.js';

// Resolve results.json path safely in current working directory
const getResultsPath = () => {
  return path.join(process.cwd(), 'results.json');
};

export const getInitialResults = () => ({
  status: 'idle',
  userId: null,
  runId: null,
  error: null,
  totalFound: 0,
  totalRelevant: 0,
  totalSent: 0,
  leads: [],
  logs: []
});

export function writeResults(data) {
  try {
    fs.writeFileSync(getResultsPath(), JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to write results.json:', err);
  }
}

export function readResults() {
  try {
    const p = getResultsPath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  } catch (err) {
    console.error('Failed to read results.json, returning initial state.', err);
  }
  return getInitialResults();
}

function getUserFriendlyAgentError(error) {
  const technicalMessage = error?.message || String(error || '');

  if (technicalMessage === 'LinkedIn session expired') {
    return {
      kind: 'linkedin-auth',
      step: 'LinkedIn session needs attention',
      message: 'LinkedIn rejected this session. Please open Settings, paste a fresh LinkedIn li_at cookie from a browser where LinkedIn is already working, then relaunch the agent.',
      logMessage: 'LinkedIn session expired.'
    };
  }

  if (/LinkedIn redirect loop|ERR_TOO_MANY_REDIRECTS|too many redirects/i.test(technicalMessage)) {
    return {
      kind: 'linkedin-auth',
      step: 'LinkedIn is redirecting the session',
      message: 'LinkedIn kept redirecting the agent instead of opening search results. This usually means your LinkedIn cookie is expired, invalid, or being challenged. Open LinkedIn in your normal browser, make sure it works without a login or checkpoint screen, then update your li_at cookie in Settings and relaunch.',
      logMessage: `LinkedIn redirect loop: ${technicalMessage}`
    };
  }

  if (/checkpoint|challenge|login|signup/i.test(technicalMessage) && /linkedin/i.test(technicalMessage)) {
    return {
      kind: 'linkedin-auth',
      step: 'LinkedIn verification required',
      message: 'LinkedIn is asking this session to log in or complete a verification check. Please open LinkedIn manually, finish any verification, copy a fresh li_at cookie, save it in Settings, and relaunch.',
      logMessage: `LinkedIn verification required: ${technicalMessage}`
    };
  }

  if (/page crashed|target page|context or browser has been closed/i.test(technicalMessage)) {
    return {
      kind: 'browser',
      step: 'Browser preview crashed',
      message: 'The hidden browser crashed while loading LinkedIn. Relaunch the agent once. If it happens again, lower the max leads limit and try a fresh LinkedIn cookie.',
      logMessage: `Browser crash: ${technicalMessage}`
    };
  }

  return {
    kind: 'generic',
    step: 'Agent failed',
    message: 'The agent could not finish this run. Please try relaunching. If it happens again, update your credentials in Settings and run a smaller search.',
    logMessage: technicalMessage
  };
}

/**
 * Runs the complete Outly flow
 */
export async function runAgent({
  userId = null,
  userPlan = 'free',
  runId = `${Date.now()}`,
  query,
  liAtCookie,
  linkedInCookies,
  apolloApiKey,
  gmailUser,
  gmailAppPassword,
  nvidiaApiKey,
  subjectTemplate = 'Application for {role} Role',
  emailTemplate = '',
  limit = 20,
  sendEmailsEnabled = false,
  headless = true
}) {
  const limits = getPlanLimits(userPlan);
  const results = getInitialResults();
  let apolloCallsUsed = 0;
  results.status = 'running';
  results.userId = userId;
  results.runId = runId;
  results.logs.push(`[${new Date().toLocaleTimeString()}] Agent execution started for query: "${query}"`);
  writeResults(results);

  try {
    if (userId) {
      const usage = await getUsageSummary({ id: userId, plan: userPlan });
      if (usage.runsToday >= limits.runsPerDay) {
        results.status = 'error';
        results.error = 'Upgrade to Pro to run more searches today';
        results.logs.push(`[${new Date().toLocaleTimeString()}] Limit exceeded: daily run limit reached for ${userPlan.toUpperCase()} plan.`);
        writeResults(results);
        return {
          success: false,
          reason: 'limit_exceeded',
          message: 'Upgrade to Pro to run more searches today',
          upgradeUrl: '/pricing'
        };
      }
    }

    // 1. Scraping LinkedIn
    results.logs.push(`[${new Date().toLocaleTimeString()}] Launching LinkedIn Scraper...`);
    writeResults(results);

    let rawPosts = [];
    try {
      rawPosts = await scrapeLinkedInPosts({ query, liAtCookie, linkedInCookies, headless });
    } catch (scrapeErr) {
      const friendlyError = getUserFriendlyAgentError(scrapeErr);
      if (friendlyError.kind === 'linkedin-auth') {
        results.status = 'error';
        results.error = friendlyError.message;
        results.logs.push(`[${new Date().toLocaleTimeString()}] Error: ${friendlyError.logMessage}`);
        writeStatus({
          step: friendlyError.step,
          stepKey: 'logging-into-linkedin',
          progress: 2,
          state: 'failed',
          error: friendlyError.message
        });
        writeResults(results);
        return;
      }
      throw scrapeErr;
    }

    results.totalFound = rawPosts.length;
    results.logs.push(`[${new Date().toLocaleTimeString()}] Scraper completed. Found ${rawPosts.length} posts.`);
    writeResults(results);

    // 2. Enriching Emails and Extracting Job Titles
    writeStatus({
      step: 'Filtering relevant posts',
      stepKey: 'filtering-posts',
      progress: 7,
      details: { role: query, postsFound: rawPosts.length }
    });
    results.logs.push(`[${new Date().toLocaleTimeString()}] Enriching emails via Apollo and extracting fallback emails from post text...`);
    writeResults(results);

    const enrichedPosts = [];
    for (let index = 0; index < rawPosts.length; index++) {
      const post = rawPosts[index];
      let enrichedEmail = { email: null, source: null };

      const usage = userId ? await getUsageSummary({ id: userId, plan: userPlan }) : null;
      const apolloQuotaRemaining = usage ? Math.max(0, limits.apolloCallsPerDay - usage.apolloCallsToday - apolloCallsUsed) : limits.apolloCallsPerDay;

      if (!limits.apollo) {
        results.logs.push(`[${new Date().toLocaleTimeString()}] Apollo enrichment disabled on ${userPlan.toUpperCase()} plan; using post text fallback.`);
        writeResults(results);
      } else if (apolloQuotaRemaining <= 0) {
        results.logs.push(`[${new Date().toLocaleTimeString()}] Apollo quota exceeded; using regex fallback for remaining posts.`);
        console.log({ source: 'quota_exceeded_fallback', userId, runId, postIndex: index });
        writeResults(results);
        enrichedEmail = { email: null, source: 'quota_exceeded_fallback' };
      } else if (post.authorProfileUrl) {
        results.logs.push(`[${new Date().toLocaleTimeString()}] Apollo lookup ${index + 1}/${rawPosts.length}: ${post.authorName}`);
        writeResults(results);

        apolloCallsUsed += 1;
        enrichedEmail = await enrichEmail(post.authorProfileUrl, {
          apiKey: apolloApiKey,
          logger: console
        });

        if (enrichedEmail.email) {
          results.logs.push(`[${new Date().toLocaleTimeString()}] Apollo found email for ${post.authorName}.`);
        } else {
          results.logs.push(`[${new Date().toLocaleTimeString()}] Apollo did not return an email for ${post.authorName}; using post text fallback.`);
        }
        writeResults(results);
        await delay(500);
      } else {
        results.logs.push(`[${new Date().toLocaleTimeString()}] No LinkedIn profile URL found for ${post.authorName}; using post text fallback.`);
        writeResults(results);
      }

      enrichedPosts.push({
        ...post,
        enrichedEmail
      });
    }

    const relevantPosts = filterRelevantPosts(enrichedPosts);
    results.totalRelevant = relevantPosts.length;
    writeStatus({
      step: `Found ${relevantPosts.length} emails`,
      stepKey: 'found-emails',
      progress: 8,
      details: { emailsFound: relevantPosts.length }
    });
    results.logs.push(`[${new Date().toLocaleTimeString()}] Found ${relevantPosts.length} posts containing emails.`);
    writeResults(results);

    if (relevantPosts.length === 0) {
      results.status = 'completed';
      results.logs.push(`[${new Date().toLocaleTimeString()}] No relevant leads with email addresses found. Agent finished.`);
      writeStatus({
        step: 'Done - 0 emails sent',
        stepKey: 'done',
        progress: 11,
        state: 'done',
        details: { emailsSent: 0 }
      });
      writeResults(results);
      if (userId) {
        await recordUsage({
          userId,
          runId,
          emailsSent: 0,
          postsScraped: rawPosts.length,
          apolloCalls: apolloCallsUsed,
          plan: userPlan
        });
      }
      return;
    }

    // Slice to the requested limit
    const effectiveLimit = Math.min(limit, limits.emailsPerRun);
    const leadsToProcess = relevantPosts.slice(0, effectiveLimit);
    if (limit > effectiveLimit) {
      results.logs.push(`[${new Date().toLocaleTimeString()}] Plan limit applied: processing ${effectiveLimit} emails for ${userPlan.toUpperCase()} plan.`);
    }
    results.logs.push(`[${new Date().toLocaleTimeString()}] Processing top ${leadsToProcess.length} leads...`);
    writeResults(results);

    // 3. Process each lead
    for (let index = 0; index < leadsToProcess.length; index++) {
      const post = leadsToProcess[index];
      const leadId = `lead-${index + 1}`;

      const newLead = {
        id: leadId,
        authorName: post.authorName,
        authorHeadline: post.authorHeadline,
        authorProfileUrl: post.authorProfileUrl,
        postUrl: post.postUrl,
        email: post.primaryEmail,
        emailSource: post.emailSource,
        role: post.role,
        customizedBody: null,
        status: 'scraped',
        error: null,
        timestamp: new Date().toLocaleTimeString()
      };

      results.leads.push(newLead);
      results.logs.push(`[${new Date().toLocaleTimeString()}] Processing lead: ${post.authorName} (${post.primaryEmail}) for ${post.role}`);
      writeResults(results);

      const leadIndex = results.leads.findIndex(l => l.id === leadId);

      try {
        // A. Customize Mail via LLM
        results.leads[leadIndex].status = 'generating';
        writeStatus({
          step: `Customizing email ${index + 1}/${leadsToProcess.length} via NVIDIA NIM`,
          stepKey: 'customizing-email',
          progress: 9,
          details: { current: index + 1, total: leadsToProcess.length, email: post.primaryEmail }
        });
        results.logs.push(`[${new Date().toLocaleTimeString()}] Generating custom email body via NVIDIA NIM for ${post.authorName}...`);
        writeResults(results);

        const emailBody = await customizeMail({
          postText: post.text,
          authorName: post.authorName,
          role: post.role,
          apiKey: nvidiaApiKey,
          template: emailTemplate
        });
        const finalEmailBody = limits.watermark
          ? `${emailBody}\n\nSent via Outly`
          : emailBody;

        results.leads[leadIndex].customizedBody = finalEmailBody;
        results.leads[leadIndex].status = 'customized';
        results.logs.push(`[${new Date().toLocaleTimeString()}] Email body customized successfully.`);
        writeResults(results);

        // B. Send Email if SMTP set and sendEmailsEnabled is true
        if (sendEmailsEnabled) {
          results.leads[leadIndex].status = 'sending';
          writeStatus({
            step: `Sending email to ${post.primaryEmail}`,
            stepKey: 'sending-email',
            progress: 10,
            details: { current: index + 1, total: leadsToProcess.length, email: post.primaryEmail }
          });
          results.logs.push(`[${new Date().toLocaleTimeString()}] Dispatching email to ${post.primaryEmail} via Nodemailer...`);
          writeResults(results);

          const subject = subjectTemplate.replace(/{role}/g, post.role);
          await sendEmail({
            to: post.primaryEmail,
            subject,
            body: finalEmailBody,
            gmailUser,
            gmailAppPassword
          });

          results.leads[leadIndex].status = 'sent';
          results.totalSent += 1;
          results.logs.push(`[${new Date().toLocaleTimeString()}] Email successfully sent to ${post.primaryEmail}.`);
        } else {
          results.leads[leadIndex].status = 'dry-run';
          results.logs.push(`[${new Date().toLocaleTimeString()}] [Dry Run] Email generated for ${post.primaryEmail} (not sent).`);
        }
        writeResults(results);

      } catch (leadError) {
        console.error(`Error processing lead ${post.primaryEmail}:`, leadError);
        results.leads[leadIndex].status = 'failed';
        results.leads[leadIndex].error = leadError.message;
        results.logs.push(`[${new Date().toLocaleTimeString()}] Failed to process lead ${post.primaryEmail}: ${leadError.message}`);
        writeResults(results);
      }

      // Add a rate-limiting delay between lead processings
      if (index < leadsToProcess.length - 1) {
        await delay(3000);
      }
    }

    results.status = 'completed';
    results.logs.push(`[${new Date().toLocaleTimeString()}] Outly run completed successfully.`);
    writeStatus({
      step: `Done - ${results.totalSent} emails sent`,
      stepKey: 'done',
      progress: 11,
      state: 'done',
      details: { emailsSent: results.totalSent }
    });
    writeResults(results);
    if (userId) {
      await recordUsage({
        userId,
        runId,
        emailsSent: results.totalSent,
        postsScraped: rawPosts.length,
        apolloCalls: apolloCallsUsed,
        plan: userPlan
      });
    }

  } catch (globalError) {
    console.error('Fatal agent orchestrator error:', globalError);
    const friendlyError = getUserFriendlyAgentError(globalError);
    results.status = 'error';
    results.error = friendlyError.message;
    results.logs.push(`[${new Date().toLocaleTimeString()}] Fatal Agent Error: ${globalError.message}`);
    writeStatus({
      step: friendlyError.step || 'Agent failed',
      stepKey: 'failed',
      progress: 11,
      state: 'failed',
      error: friendlyError.message
    });
    writeResults(results);
    if (userId) {
      try {
        await recordUsage({
          userId,
          runId,
          emailsSent: results.totalSent,
          postsScraped: results.totalFound,
          apolloCalls: apolloCallsUsed,
          plan: userPlan
        });
      } catch (usageError) {
        console.error('Failed to record failed-run usage:', usageError);
      }
    }
  }
}

// Outly Chrome Extension Popup Controller
import { loginUser, getApiBaseUrl } from '../utils/api.js';

// DOM Elements
const authView = document.getElementById('auth-view');
const warningView = document.getElementById('warning-view');
const dashboardView = document.getElementById('dashboard-view');
const viewPanel = document.getElementById('view-panel');
const planBadge = document.getElementById('plan-badge');
const logoutBtn = document.getElementById('logout-btn');
const statusFooter = document.getElementById('status-footer');

// Form/Inputs
const loginForm = document.getElementById('login-form');
const loginEmail = document.getElementById('login-email');
const loginPassword = document.getElementById('login-password');
const authError = document.getElementById('auth-error');

const configCard = document.getElementById('config-card');
const targetRoleInput = document.getElementById('target-role');
const emailTemplateTextarea = document.getElementById('email-template');
const subjectTemplateInput = document.getElementById('subject-template');
const maxLeadsInput = document.getElementById('max-leads');
const startScrapeBtn = document.getElementById('start-scrape-btn');
const runError = document.getElementById('run-error');

// Status & Progress
const statusCard = document.getElementById('status-card');
const statusText = document.getElementById('status-text');
const postsCountText = document.getElementById('posts-count-text');
const progressBar = document.getElementById('progress-bar');
const statusDot = document.getElementById('status-dot');

// Results
const resultsCard = document.getElementById('results-card');
const resultsTbody = document.getElementById('results-tbody');

// Action Buttons
const openLinkedinBtn = document.getElementById('open-linkedin-btn');

// Initial State Checks
document.addEventListener('DOMContentLoaded', async () => {
  await checkAuthState();
  setupEventListeners();
  restoreCachedResults();
});

/**
 * Setup Event Listeners
 */
function setupEventListeners() {
  // Login Form Submission
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideElement(authError);
    setLoadingState(true);

    try {
      const email = loginEmail.value.trim();
      const password = loginPassword.value;
      const data = await loginUser(email, password);

      // Save to chrome local storage
      await chrome.storage.local.set({
        token: data.token,
        user: data.user
      });

      loginForm.reset();
      await checkAuthState();
    } catch (err) {
      showError(authError, err.message || 'Login failed. Please check credentials.');
    } finally {
      setLoadingState(false);
    }
  });

  // Logout Button
  logoutBtn.addEventListener('click', async () => {
    await chrome.storage.local.remove(['token', 'user', 'lastResults', 'lastResultsTime']);
    clearResultsTable();
    hideElement(resultsCard);
    hideElement(statusCard);
    await checkAuthState();
  });

  // Open LinkedIn Button
  openLinkedinBtn.addEventListener('click', () => {
    chrome.tabs.create({
      url: 'https://www.linkedin.com/search/results/content/?keywords=Hiring%20Software%20Engineer&origin=SWITCH_SEARCH_VERTICAL'
    });
  });

  // Start Scraping Button
  startScrapeBtn.addEventListener('click', async () => {
    hideElement(runError);
    const role = targetRoleInput.value.trim();
    const limit = parseInt(maxLeadsInput.value, 10) || 10;
    const template = emailTemplateTextarea.value.trim();
    const subjectTemplate = subjectTemplateInput.value.trim();

    if (!role) {
      showError(runError, 'Please enter a target role.');
      return;
    }

    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const activeTab = tabs[0];

      if (!activeTab || !activeTab.id) {
        showError(runError, 'Cannot establish connection to the tab.');
        return;
      }

      // Initialise UI progress indicators
      showElement(statusCard);
      hideElement(resultsCard);
      startScrapeBtn.disabled = true;
      startScrapeBtn.textContent = 'Scraping LinkedIn...';
      updateProgressUI('Initializing crawler...', 0, 10);

      // Save current configuration values in local storage
      await chrome.storage.local.set({
        lastRoleConfig: role,
        lastLimitConfig: limit,
        lastSubjectConfig: subjectTemplate,
        lastTemplateConfig: template
      });

      // Send start message to content script
      chrome.tabs.sendMessage(activeTab.id, {
        type: 'START_SCRAPE',
        limit: limit
      }, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          console.error(lastError);
          showError(runError, 'Content script is not responsive. Please refresh the LinkedIn page and try again.');
          hideElement(statusCard);
          resetScrapeButton();
        }
      });

    } catch (err) {
      showError(runError, err.message);
      resetScrapeButton();
    }
  });
}

/**
 * Handle incoming message signals from Content Script or Background Service worker
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SCRAPING_PROGRESS') {
    // Scroll progress update: increments progress bar slightly
    const count = msg.count || 0;
    const percent = Math.min(75, 10 + count * 5); // caps scraping at 75%
    updateProgressUI('Scrolling & scanning posts...', count, percent);
  }

  else if (msg.type === 'SESSION_EXPIRED') {
    updateProgressUI('LinkedIn session expired!', 0, 0);
    showError(runError, 'LinkedIn rejected authentication. Make sure you are logged in to LinkedIn on this page.');
    resetScrapeButton();
  }

  else if (msg.type === 'SCRAPE_ERROR') {
    updateProgressUI('Scraper error.', 0, 0);
    showError(runError, msg.message || 'Scraper failed.');
    resetScrapeButton();
  }

  else if (msg.type === 'POSTS_FOUND') {
    const posts = msg.posts || [];
    if (posts.length === 0) {
      updateProgressUI('No posts found.', 0, 100);
      showError(runError, 'No matching hiring posts found on page. Try adjusting your query or scrolling manually first.');
      resetScrapeButton();
      return;
    }

    // Trigger enrich and send process via background script
    processLeads(posts);
  }
});

/**
 * Trigger the background script call to API to avoid CORS issues
 */
async function processLeads(posts) {
  updateProgressUI('Apollo enrichment & AI customized mailing...', posts.length, 80);
  
  const template = emailTemplateTextarea.value.trim();
  const subjectTemplate = subjectTemplateInput.value.trim();

  // Send request to background service worker
  chrome.runtime.sendMessage({
    type: 'ENRICH_AND_SEND',
    posts,
    template,
    subjectTemplate
  }, (response) => {
    const lastError = chrome.runtime.lastError;
    if (lastError) {
      console.error(lastError);
      showError(runError, `Background communication error: ${lastError.message}`);
      resetScrapeButton();
      return;
    }

    if (response && response.success) {
      updateProgressUI('Outreach sequence completed successfully!', posts.length, 100);
      statusFooter.textContent = 'SEQUENCE COMPLETED';
      
      // Inject results into UI table
      displayResults(response.results || []);
    } else {
      updateProgressUI('Outreach sequence failed.', posts.length, 0);
      showError(runError, response?.error || 'Failed to process outreach sequence.');
    }
    
    resetScrapeButton();
  });
}

/**
 * Check user authentication state and display views accordingly
 */
async function checkAuthState() {
  const storage = await chrome.storage.local.get(['token', 'user']);
  const user = storage.user;

  if (storage.token && user) {
    // User is logged in
    showElement(logoutBtn);
    planBadge.textContent = (user.plan || 'FREE').toUpperCase();
    hideElement(authView);
    statusFooter.textContent = `USER: ${user.email}`;

    // Verify current browser tab URL is LinkedIn Search
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];
    
    if (activeTab && activeTab.url && activeTab.url.includes('linkedin.com/search/results/content')) {
      showElement(dashboardView);
      hideElement(warningView);
      
      // Restore last configuration from storage
      const configs = await chrome.storage.local.get([
        'lastRoleConfig',
        'lastLimitConfig',
        'lastSubjectConfig',
        'lastTemplateConfig'
      ]);
      if (configs.lastRoleConfig) targetRoleInput.value = configs.lastRoleConfig;
      if (configs.lastLimitConfig) maxLeadsInput.value = configs.lastLimitConfig;
      if (configs.lastSubjectConfig) subjectTemplateInput.value = configs.lastSubjectConfig;
      if (configs.lastTemplateConfig) emailTemplateTextarea.value = configs.lastTemplateConfig;

    } else {
      // Not on valid LinkedIn page
      hideElement(dashboardView);
      showElement(warningView);
    }
  } else {
    // User is logged out
    hideElement(logoutBtn);
    planBadge.textContent = 'GUEST';
    showElement(authView);
    hideElement(dashboardView);
    hideElement(warningView);
    statusFooter.textContent = 'SYSTEM OFFLINE';
  }
}

/**
 * Injects and renders outreach results in the scrollable table
 */
function displayResults(results) {
  clearResultsTable();
  showElement(resultsCard);

  if (!results || results.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = `<td colspan="3" style="text-align:center;color:var(--text-muted);">No emails sent (no contact details found or limit reached).</td>`;
    resultsTbody.appendChild(row);
    return;
  }

  results.forEach(lead => {
    const row = document.createElement('tr');
    
    const emailVal = lead.email || 'N/A';
    const roleVal = lead.role || targetRoleInput.value;
    const statusVal = lead.status || 'failed';
    const badgeClass = statusVal.toLowerCase();

    row.innerHTML = `
      <td title="${emailVal}">${emailVal}</td>
      <td title="${roleVal}">${roleVal}</td>
      <td><span class="status-badge ${badgeClass}">${statusVal}</span></td>
    `;
    resultsTbody.appendChild(row);
  });
}

/**
 * Restore results from chrome storage if they are less than 1 hour old
 */
async function restoreCachedResults() {
  const cache = await chrome.storage.local.get(['lastResults', 'lastResultsTime']);
  if (cache.lastResults && cache.lastResultsTime) {
    const elapsedMs = Date.now() - cache.lastResultsTime;
    const oneHourMs = 3600000;
    if (elapsedMs < oneHourMs) {
      displayResults(cache.lastResults);
    }
  }
}

/**
 * Update the animated status panel
 */
function updateProgressUI(status, count, percent) {
  statusText.textContent = status;
  postsCountText.textContent = `Found ${count} posts`;
  progressBar.style.width = `${percent}%`;

  if (percent === 100) {
    statusDot.style.backgroundColor = 'var(--color-success)';
    statusDot.style.animation = 'none';
  } else if (percent === 0) {
    statusDot.style.backgroundColor = 'var(--color-failed)';
    statusDot.style.animation = 'none';
  } else {
    statusDot.style.backgroundColor = 'var(--color-active)';
    statusDot.style.animation = 'pulse 1.6s infinite';
  }
}

function resetScrapeButton() {
  startScrapeBtn.disabled = false;
  startScrapeBtn.textContent = 'Start Outreach Run';
}

function clearResultsTable() {
  resultsTbody.innerHTML = '';
}

function setLoadingState(loading) {
  const submitBtn = document.getElementById('login-submit-btn');
  if (loading) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Authenticating...';
  } else {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Authenticate';
  }
}

function showError(el, message) {
  el.textContent = message;
  showElement(el);
}

function showElement(el) {
  el.classList.remove('hidden');
}

function hideElement(el) {
  el.classList.add('hidden');
}

// Outly Chrome Extension Background Service Worker

// Default Backend URL fallback
const DEFAULT_API_URL = 'https://outly-production-9f82.up.railway.app';

// Listen for messages from the popup or content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'ENRICH_AND_SEND') {
    handleEnrichAndSend(msg, sendResponse);
    return true; // Keep message channel open for asynchronous sendResponse
  }
});

/**
 * Handles communication with the backend endpoint to process, enrich, and send emails
 */
async function handleEnrichAndSend(msg, sendResponse) {
  try {
    // 1. Get stored JWT token and custom backend API URL from local storage
    const storage = await chrome.storage.local.get(['token', 'apiUrl']);
    const token = storage.token;
    const baseUrl = storage.apiUrl || DEFAULT_API_URL;

    if (!token) {
      sendResponse({
        success: false,
        error: 'Authentication token missing. Please log in through the Outly extension popup.'
      });
      return;
    }

    // 2. Fetch the process API route on our Next.js backend
    const endpoint = `${baseUrl}/api/extension/process`;
    console.log(`Outly Background: Fetching ${endpoint} with ${msg.posts.length} posts.`);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        posts: msg.posts,
        template: msg.template,
        subjectTemplate: msg.subjectTemplate
      })
    });

    // 3. Handle non-200 responses
    if (!response.ok) {
      let errorMessage = `Server error: ${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.message) {
          errorMessage = errorData.message;
        }
      } catch (jsonErr) {
        // Fallback to text if not JSON
        const textResponse = await response.text().catch(() => '');
        if (textResponse) errorMessage = textResponse.slice(0, 100);
      }
      sendResponse({ success: false, error: errorMessage });
      return;
    }

    // 4. Return successful results
    const data = await response.json();
    
    // Cache the last successful results in local storage for popup persistence
    await chrome.storage.local.set({
      lastResults: data.results || [],
      lastResultsTime: Date.now()
    });

    sendResponse({ success: true, results: data.results });
  } catch (error) {
    console.error('Outly Background Error in ENRICH_AND_SEND:', error);
    sendResponse({ success: false, error: error.message || 'Network error connection failed.' });
  }
}

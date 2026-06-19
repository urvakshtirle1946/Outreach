// Outly Chrome Extension API Utilities

const DEFAULT_API_URL = 'https://outly-production-9f82.up.railway.app';

/**
 * Retrieves the base API URL stored in local storage, defaulting to localhost.
 */
export async function getApiBaseUrl() {
  const data = await chrome.storage.local.get(['apiUrl']);
  return data.apiUrl || DEFAULT_API_URL;
}

/**
 * Updates the base API URL in local storage.
 */
export async function setApiBaseUrl(url) {
  const cleanUrl = url.replace(/\/$/, ''); // Remove trailing slash
  await chrome.storage.local.set({ apiUrl: cleanUrl });
  return cleanUrl;
}

/**
 * Submits user login credentials to the Next.js server.
 */
export async function loginUser(email, password) {
  const baseUrl = await getApiBaseUrl();
  const endpoint = `${baseUrl}/api/auth/login`;

  console.log(`Outly API: Login request to ${endpoint}`);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ email, password })
  });

  if (!response.ok) {
    let errorMsg = 'Invalid email or password.';
    try {
      const errData = await response.json();
      if (errData.message) {
        errorMsg = errData.message;
      }
    } catch {
      // Ignored
    }
    throw new Error(errorMsg);
  }

  return response.json(); // Returns { token, user }
}

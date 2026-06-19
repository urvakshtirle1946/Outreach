// Outly Chrome Extension Content Script (runs on linkedin.com search pages)

console.log('Outly content script loaded.');

// Listen for messages from the popup UI
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_SCRAPE') {
    runScrape(msg.limit || 10);
    sendResponse({ started: true });
  }
});

/**
 * Main scraping routine
 */
async function runScrape(limit) {
  try {
    // 1. Check if the session is expired or requires authentication
    if (isLoginOrChallengePage()) {
      chrome.runtime.sendMessage({ type: 'SESSION_EXPIRED' });
      return;
    }

    const maxScrolls = 5;
    const scrollDelay = 1500;
    let allPosts = [];

    // 2. Perform dynamic scrolling to load more updates
    for (let scrollCount = 0; scrollCount < maxScrolls; scrollCount++) {
      // Scrape posts currently visible in the DOM
      const currentPosts = extractPostsFromDOM();
      
      // Merge and deduplicate
      allPosts = mergeAndDeduplicate(allPosts, currentPosts);

      // Send live progress count back to popup
      chrome.runtime.sendMessage({
        type: 'SCRAPING_PROGRESS',
        count: allPosts.length
      });

      // Break if we've collected more than enough candidates
      if (allPosts.length >= limit * 2) {
        break;
      }

      // Scroll down
      window.scrollBy(0, window.innerHeight * 1.5);
      // Dispatch scroll event to let LinkedIn load next batch
      window.dispatchEvent(new Event('scroll'));

      // Wait for delay
      await new Promise(resolve => setTimeout(resolve, scrollDelay));
    }

    // Final extraction and deduping
    const finalPosts = extractPostsFromDOM();
    allPosts = mergeAndDeduplicate(allPosts, finalPosts);

    // Limit to safety threshold or target limit
    const truncatedPosts = allPosts.slice(0, Math.max(limit, 20));

    // Send final list to popup
    chrome.runtime.sendMessage({
      type: 'POSTS_FOUND',
      posts: truncatedPosts
    });

  } catch (err) {
    console.error('Outly Scraper Error:', err);
    chrome.runtime.sendMessage({
      type: 'SCRAPE_ERROR',
      message: err.message || 'Scraper failed due to an unexpected error.'
    });
  }
}

/**
 * Scrapes posts currently present in the DOM
 */
function extractPostsFromDOM() {
  // Find all possible post containers
  const postContainers = document.querySelectorAll('.feed-shared-update-v2, li.reusable-search__result-container, article');
  const posts = [];

  postContainers.forEach((post) => {
    try {
      // 1. Extract Post Content
      const textSelectors = [
        '.update-components-text',
        '.feed-shared-update-v2__description',
        '.feed-shared-text',
        '[class*="update-components-text"]',
        '[class*="update-v2__description"]',
        '[dir="ltr"]'
      ];
      
      let postText = '';
      for (const selector of textSelectors) {
        const textEl = post.querySelector(selector);
        if (textEl && textEl.innerText.trim()) {
          postText = textEl.innerText.trim();
          break;
        }
      }
      
      // Fallback to whole card text if description not found
      if (!postText) {
        postText = post.innerText || post.textContent || '';
      }

      postText = postText.replace(/\s+/g, ' ').trim();

      // Skip short cards or LinkedIn platform elements
      if (postText.length < 20 || isLinkedInChromeText(postText)) {
        return;
      }

      // 2. Extract Author Name
      const nameSelectors = [
        '.update-components-actor__name',
        '.update-components-actor__title span[aria-hidden="true"]',
        '[class*="actor__name"]',
        '[class*="actor__title"]',
        'a[href*="/in/"] span[aria-hidden="true"]'
      ];
      
      let authorName = '';
      for (const selector of nameSelectors) {
        const nameEl = post.querySelector(selector);
        if (nameEl && nameEl.innerText.trim()) {
          authorName = nameEl.innerText.trim();
          break;
        }
      }

      // 3. Extract Author Headline / Title
      const titleSelectors = [
        '.update-components-actor__description',
        '[class*="actor__description"]',
        '[class*="actor__headline"]'
      ];
      
      let authorTitle = '';
      for (const selector of titleSelectors) {
        const titleEl = post.querySelector(selector);
        if (titleEl && titleEl.innerText.trim()) {
          authorTitle = titleEl.innerText.trim();
          break;
        }
      }

      // 4. Extract Author Profile URL
      const profileLinkEl = post.querySelector('a[href*="/in/"], a[href*="/company/"]');
      let authorProfileUrl = '';
      if (profileLinkEl && profileLinkEl.href) {
        // Strip query params
        authorProfileUrl = profileLinkEl.href.split('?')[0];
      }

      // 5. Extract Post URL / URN
      const postLinkEl = post.querySelector('a[href*="/feed/update/"], a[href*="urn:li:activity"], a[href*="urn:li:share"]');
      let postUrl = '';
      if (postLinkEl && postLinkEl.href) {
        postUrl = postLinkEl.href.split('?')[0];
      } else {
        // Try reading data-urn attribute
        const childWithUrn = post.matches('[data-urn]') ? post : post.querySelector('[data-urn]');
        const urn = childWithUrn ? childWithUrn.getAttribute('data-urn') : '';
        if (urn) {
          postUrl = `https://www.linkedin.com/feed/update/${urn}`;
        }
      }

      posts.push({
        postText,
        authorName: authorName || 'LinkedIn User',
        authorTitle: authorTitle || 'Hiring Manager',
        authorProfileUrl,
        postUrl
      });

    } catch (cardErr) {
      console.warn('Failed to parse card:', cardErr);
    }
  });

  return posts;
}

/**
 * Merge and deduplicate arrays of posts by postText similarity
 */
function mergeAndDeduplicate(existingPosts, newPosts) {
  const merged = [...existingPosts];
  
  newPosts.forEach(newPost => {
    // Generate simple deduping key
    const key = newPost.postText.slice(0, 150).toLowerCase();
    
    const exists = merged.some(existingPost => 
      existingPost.postText.slice(0, 150).toLowerCase() === key
    );

    if (!exists) {
      merged.push(newPost);
    }
  });

  return merged;
}

/**
 * Detect login redirects, challenges, or checkpoint walls
 */
function isLoginOrChallengePage() {
  const url = window.location.href;
  const loginWallExist = !!document.querySelector('form.login__form') ||
    !!document.querySelector('[data-tracking-control-name="guest_homepage-basic_nav-header-signin"]') ||
    url.includes('/login') ||
    url.includes('/signup') ||
    url.includes('/checkpoint') ||
    url.includes('/challenge');
  
  return loginWallExist;
}

/**
 * Helper to identify layout navigation terms to filter out
 */
function isLinkedInChromeText(text) {
  const lower = text.toLowerCase();
  return lower.includes('try searching for') ||
    lower.includes('no results found') ||
    lower.includes('linkedin corporation') ||
    lower.includes('sign in') ||
    lower.includes('join now');
}

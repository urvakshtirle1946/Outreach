/**
 * Extracts all email addresses from a given text string.
 * @param {string} text 
 * @returns {Array<string>} Array of unique emails
 */
export function extractEmails(text) {
  if (!text) return [];
  const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const matches = text.match(EMAIL_REGEX) || [];
  return [...new Set(matches.map(email => email.toLowerCase()))];
}

/**
 * Extracts potential job titles/roles from the text.
 * @param {string} text 
 * @returns {string} The identified job role
 */
export function extractRole(text) {
  if (!text) return 'Software Engineer';

  // Common patterns for hiring posts
  const patterns = [
    /looking for(?: a| an)?\s+([^,.\n]+)/i,
    /hiring for(?: a| an)?\s+([^,.\n]+)/i,
    /hiring\s+([^,.\n]{3,40})/i,
    /role:\s*([^,.\n]+)/i,
    /position:\s*([^,.\n]+)/i,
    /job title:\s*([^,.\n]+)/i,
    /opening for\s+([^,.\n]+)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const role = match[1].trim();
      // Clean up common fluff words
      const cleaned = role
        .replace(/^(a|an|the|our|my|some|immediate|urgent)\s+/i, '')
        .split(/\s+(?:at|with|in|for|to|on)\s+/i)[0] // truncate at prepositions
        .trim();
      if (cleaned.length > 2 && cleaned.length < 50) {
        return cleaned;
      }
    }
  }

  // Fallback to searching for standard keywords
  const standardRoles = [
    'Software Engineer', 'Frontend Developer', 'Backend Developer', 'Fullstack Developer',
    'React Developer', 'Node.js Developer', 'Product Manager', 'Data Scientist',
    'DevOps Engineer', 'UI/UX Designer', 'Sales Representative', 'HR Manager',
    'Recruiter', 'Marketing Specialist', 'Mobile Developer', 'iOS Developer', 'Android Developer'
  ];

  for (const role of standardRoles) {
    const regex = new RegExp(`\\b${role}\\b`, 'i');
    if (regex.test(text)) {
      return role;
    }
  }

  return 'Software Engineer'; // sensible default
}

/**
 * Filters posts, retaining only those with email addresses.
 * Extracts email and job role and populates them on each post.
 * @param {Array<Object>} posts 
 * @returns {Array<Object>} Relevant posts with extracted email and role
 */
export function filterRelevantPosts(posts) {
  if (!posts || !Array.isArray(posts)) return [];
  
  return posts
    .map(post => {
      const emails = extractEmails(post.text);
      const role = extractRole(post.text);
      const apolloEmail = post.enrichedEmail?.email || null;
      const fallbackEmail = emails[0] || null;
      return {
        ...post,
        emails,
        primaryEmail: apolloEmail || fallbackEmail,
        emailSource: apolloEmail ? 'apollo' : fallbackEmail ? 'post-text' : null,
        role
      };
    })
    .filter(post => post.primaryEmail !== null);
}

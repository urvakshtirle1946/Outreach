import OpenAI from 'openai';

/**
 * Customizes the email body using NVIDIA NIM Llama-3.1-70b-instruct
 * @param {Object} params
 * @param {string} params.postText - The full text of the scraped post
 * @param {string} params.authorName - Name of the hiring person
 * @param {string} params.role - Target job role parsed from post
 * @param {string} params.apiKey - NVIDIA NIM API Key
 * @param {string} params.template - Custom context/guideline template for email customization
 * @returns {Promise<string>} Customized email body
 */
export async function customizeMail({ postText, authorName, role, apiKey, template }) {
  const token = apiKey || process.env.NVIDIA_API_KEY;
  if (!token) {
    throw new Error('NVIDIA NIM API Key is missing. Provide it via credentials or .env file.');
  }

  const client = new OpenAI({
    apiKey: token,
    baseURL: 'https://integrate.api.nvidia.com/v1',
  });

  const customTemplatePrompt = template 
    ? `Apply the following template guidelines:\n"${template}"`
    : `Write a short, engaging cold email body. Refer to the role and the post if appropriate. Highlight interest in contributing.`;

  const systemPrompt = `You are a cold outreach assistant. Your goal is to write a highly personalized, short, and professional cold email body based on a hiring post.
Follow these rules strictly:
1. Do NOT include a subject line.
2. Do NOT include signature sign-offs like "Best regards, [My Name]" or placeholder brackets for sender details. Start with a greeting and end with the final email body sentence.
3. Keep the email concise: 3 to 4 sentences maximum.
4. Be friendly, polite, and professional. Avoid sounding automated.
5. Refer directly to the author "${authorName}" and the role "${role}".`;

  const userPrompt = `
Hiring Post Author: ${authorName}
Target Role: ${role}
Post Content:
"${postText}"

Guidelines:
${customTemplatePrompt}

Please generate the customized cold email body now:`;

  try {
    const response = await client.chat.completions.create({
      model: 'meta/llama-3.1-70b-instruct',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 256,
    });

    const bodyText = response.choices[0]?.message?.content || '';
    return bodyText.trim();
  } catch (error) {
    console.error('NVIDIA NIM API error:', error);
    throw new Error(`Failed to generate email body: ${error.message}`);
  }
}

import nodemailer from 'nodemailer';

/**
 * Sends a customized email using Nodemailer via Gmail SMTP
 * @param {Object} params
 * @param {string} params.to - Recipient email
 * @param {string} params.subject - Email subject
 * @param {string} params.body - Email body text
 * @param {string} params.gmailUser - Sender Gmail email address
 * @param {string} params.gmailAppPassword - Sender Gmail 16-char App Password
 * @returns {Promise<Object>} Sent message info
 */
export async function sendEmail({ to, subject, body, gmailUser, gmailAppPassword }) {
  const user = gmailUser || process.env.GMAIL_USER;
  const pass = gmailAppPassword || process.env.GMAIL_APP_PASSWORD;

  if (!user || !pass) {
    throw new Error('Gmail SMTP credentials missing. Provide them in credentials or .env file.');
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: user,
      pass: pass,
    },
  });

  // Support plain text and automatically format simple HTML linebreaks
  const mailOptions = {
    from: user,
    to: to,
    subject: subject,
    text: body,
    html: body.replace(/\n/g, '<br/>'),
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`Email successfully sent to ${to}: ${info.messageId}`);
    return info;
  } catch (error) {
    console.error(`Nodemailer error sending to ${to}:`, error);
    throw new Error(`SMTP Mailer failed: ${error.message}`);
  }
}

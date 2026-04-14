const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * Send an email using Resend.
 *
 * @param {Object} options
 * @param {string} options.to        - Recipient email address
 * @param {string} options.subject   - Email subject
 * @param {string} options.html      - HTML body
 * @param {string} [options.text]    - Plain-text fallback (optional)
 */
const sendEmail = async ({ to, subject, html, text }) => {
  const from = `${process.env.FROM_NAME || 'Relux Laundry'} <${process.env.FROM_EMAIL || 'onboarding@resend.dev'}>`;

  await resend.emails.send({
    from,
    to,
    subject,
    html,
    ...(text ? { text } : {}),
  });
};

module.exports = sendEmail;

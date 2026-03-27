const nodemailer = require('nodemailer');

/**
 * Send an email using the configured SMTP transport.
 *
 * @param {Object} options
 * @param {string} options.to        - Recipient email address
 * @param {string} options.subject   - Email subject
 * @param {string} options.html      - HTML body
 * @param {string} [options.text]    - Plain-text fallback
 */
const sendEmail = async ({ to, subject, html, text }) => {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465, // true only for port 465
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
  });

  await transporter.sendMail({
    from: `"${process.env.FROM_NAME || 'Relux Laundry'}" <${process.env.FROM_EMAIL}>`,
    to,
    subject,
    text: text || subject,
    html,
  });
};

module.exports = sendEmail;

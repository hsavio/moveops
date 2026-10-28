// Outgoing email over SMTP. Works with Gmail / Google Workspace (smtp.gmail.com:465 with an
// app password), Microsoft 365, or any SMTP relay. Configure with SMTP_* environment variables.
const nodemailer = require('nodemailer');

function createMailer(env = process.env, transport) {
  const configured = Boolean(transport || env.SMTP_HOST);
  const from = env.MAIL_FROM || env.SMTP_USER;
  const transporter = transport ? nodemailer.createTransport(transport) : configured ? nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT) || 465,
    secure: (Number(env.SMTP_PORT) || 465) === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  }) : null;

  return {
    configured,
    async send({ to, subject, text, html }) {
      if (!transporter) throw Object.assign(new Error('Email is not configured: set SMTP_HOST, SMTP_USER and SMTP_PASS'), { status: 503 });
      return transporter.sendMail({ from, to, subject, text, html });
    },
  };
}

module.exports = { createMailer };

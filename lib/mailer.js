'use strict';
// Optional email delivery for scheduled automations. nodemailer is guard-loaded (like
// the MCP SDK / puppeteer) so a missing dependency or unconfigured SMTP degrades
// gracefully — send returns { ok:false, error } and the in-app inbox delivery still
// works.
//
// SMTP is read FRESH from the config module on each send (via require, which returns
// the current module — config-save calls reloadConfig() so a saved change takes effect
// without a restart). The "smtp" block: { host, port, secure, user, pass, from }.

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch { /* not installed — email disabled */ }

// Bounded SMTP timeouts so a host that accepts the TCP connection but then stalls can't tie up an
// awaited delivery for nodemailer's long defaults — a scheduled digest to a slow or black-holed server
// must fail fast and let the automation move on.
const SMTP_TIMEOUT_MS = 15000;
const buildTransport = (smtp) => {
  const secure = smtp.secure ?? (smtp.port === 465);
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port || 587,
    secure,
    // On a non-secure (STARTTLS) connection, REQUIRE the TLS upgrade. Without this nodemailer only
    // upgrades opportunistically, so a server that does not advertise STARTTLS — misconfigured, or a
    // downgrade/man-in-the-middle — would receive the SMTP credentials and the message body in cleartext.
    // requireTLS makes a failed upgrade abort the send instead. (Port 465 is already implicit TLS.)
    ...(secure ? {} : { requireTLS: true }),
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
    ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass || '' } } : {}),
  });
};

// Send a real email using the saved SMTP config. Used by automation delivery.
const sendMail = async ({ to, subject, html, text }) => {
  if (!nodemailer) return { ok: false, error: 'nodemailer not installed — run: npm install nodemailer' };
  const smtp = require('./config').smtp;   // fresh — picks up a saved change after reloadConfig()
  if (!smtp || !smtp.host) return { ok: false, error: 'SMTP not configured (Settings → Email)' };
  if (!to) return { ok: false, error: 'no recipient address' };
  // Build inside the try so a synchronous createTransport throw (malformed SMTP config) returns the
  // documented { ok:false, error } instead of rejecting — keeping the contract a scheduled job relies on.
  let transporter;
  try {
    transporter = buildTransport(smtp);
    await transporter.sendMail({ from: smtp.from || smtp.user || 'lokyni@localhost', to, subject, html, text });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try { if (transporter) transporter.close(); } catch { /* best-effort — free the connection pool */ }
  }
};

// Test explicit SMTP values (the possibly-unsaved settings form). Always verifies the
// connection + auth; if `to` is given, also sends a real test email so the user gets
// end-to-end confirmation. Never touches saved config — the caller passes the values.
const testConnection = async (smtp, to) => {
  if (!nodemailer) return { ok: false, error: 'nodemailer not installed — run: npm install nodemailer' };
  if (!smtp || !smtp.host || !smtp.user) return { ok: false, error: 'Host and username are required.' };
  let transporter;
  try {
    transporter = buildTransport(smtp);   // inside the try so a malformed-config throw returns { ok:false }
    await transporter.verify();
    if (to) {
      await transporter.sendMail({
        from: smtp.from || smtp.user,
        to,
        subject: 'Lokyni SMTP test',
        text: 'This is a test email from Lokyni. If you received it, SMTP is configured correctly and automation digests can be emailed.',
      });
      return { ok: true, sent: true };
    }
    return { ok: true, sent: false };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try { if (transporter) transporter.close(); } catch { /* best-effort */ }
  }
};

module.exports = { sendMail, testConnection };

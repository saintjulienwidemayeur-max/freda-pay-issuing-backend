'use strict';
/**
 * Mock Brevo (transactional email) server - captures every "sent" email in
 * memory so tests can retrieve it (e.g. to extract an OTP code) without any
 * real network access or a real inbox. NOT for production use.
 */
const http = require('http');
const crypto = require('crypto');

const PORT = parseInt(process.env.MOCK_BREVO_PORT || '4506', 10);
const API_KEY = process.env.MOCK_BREVO_API_KEY || 'mock-brevo-key';

const sentEmails = []; // { to, subject, html, text, sentAt }

function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); }
    });
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://internal');

  if (url.pathname === '/__control/reset') {
    sentEmails.length = 0;
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/__control/last-email' && req.method === 'GET') {
    const to = url.searchParams.get('to');
    const matches = sentEmails.filter((e) => e.to === to);
    const last = matches[matches.length - 1];
    if (!last) return send(res, 404, { message: 'No email found for that address (mock)' });
    return send(res, 200, last);
  }

  if (url.pathname === '/v3/smtp/email' && req.method === 'POST') {
    if (req.headers['api-key'] !== API_KEY) {
      return send(res, 401, { code: 'unauthorized', message: 'Key not found' });
    }
    const body = await readJson(req);
    const to = body.to && body.to[0] && body.to[0].email;
    if (!to || !body.subject) {
      return send(res, 400, { code: 'missing_parameter', message: 'Missing required fields (mock)' });
    }
    sentEmails.push({
      to,
      from: body.sender && body.sender.email,
      replyTo: body.replyTo && body.replyTo.email,
      headers: body.headers,
      subject: body.subject,
      html: body.htmlContent,
      text: body.textContent,
      sentAt: new Date().toISOString(),
    });
    return send(res, 201, { messageId: `mock-${crypto.randomBytes(6).toString('hex')}` });
  }

  send(res, 404, { message: 'Not found (mock)' });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Mock Brevo server on http://localhost:${PORT}`));
}

module.exports = { server, sentEmails };

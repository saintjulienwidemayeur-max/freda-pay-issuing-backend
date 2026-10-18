'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// The provider's address may redirect (http -> https, apex -> www). fetch drops Authorization on such a redirect, which
// made every withdrawal fail with "Jeton d'authentification manquant". The client must re-send it itself.
test('plopplop client keeps the Authorization header across a redirect', async () => {
  const seen = [];
  const target = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization || null, body: b });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, withdrawal_token: 'wd_x' }));
    });
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const targetPort = target.address().port;
  const first = http.createServer((req, res) => {
    req.resume();
    res.writeHead(307, { Location: `http://127.0.0.1:${targetPort}${req.url}` });
    res.end();
  });
  await new Promise((r) => first.listen(0, '127.0.0.1', r));
  process.env.PLOPPLOP_BASE_URL = `http://127.0.0.1:${first.address().port}`;
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/services/plopplop')];
  const plop = require('../src/services/plopplop');
  try {
    const out = await plop.getWithdrawalToken({ marchandToken: 'tok_123', amount: 214, method: 'moncash', recipient: '50944741471', reference: 'r1', timestamp: 1, signature: 's' });
    assert.equal(out.httpStatus, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].auth, 'Bearer tok_123');
    assert.match(seen[0].body, /"amount":214/);
  } finally {
    await new Promise((r) => first.close(r));
    await new Promise((r) => target.close(r));
  }
});

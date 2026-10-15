'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verify } = require('../src/utils/mapleradWebhook');

function sign(svixId, svixTimestamp, rawBody, signingSecret) {
  const secretB64 = signingSecret.replace(/^whsec_/, '');
  const secretBytes = Buffer.from(secretB64, 'base64');
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const sig = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  return `v1,${sig}`;
}

test('verify accepts a correctly signed webhook', () => {
  const secret = 'whsec_' + Buffer.from('supersecretkeybytes').toString('base64');
  const body = JSON.stringify({ event: 'issuing.created.successful', reference: 'ref_1' });
  const id = 'msg_123';
  const ts = String(Math.floor(Date.now() / 1000));
  const sigHeader = sign(id, ts, body, secret);

  const result = verify({ svixId: id, svixTimestamp: ts, rawBody: body, signatureHeader: sigHeader, signingSecret: secret });
  assert.equal(result.valid, true);
});

test('verify rejects a tampered body', () => {
  const secret = 'whsec_' + Buffer.from('supersecretkeybytes').toString('base64');
  const body = JSON.stringify({ event: 'issuing.created.successful', reference: 'ref_1' });
  const id = 'msg_123';
  const ts = String(Math.floor(Date.now() / 1000));
  const sigHeader = sign(id, ts, body, secret);

  const tamperedBody = JSON.stringify({ event: 'issuing.created.successful', reference: 'ref_HACKED' });
  const result = verify({ svixId: id, svixTimestamp: ts, rawBody: tamperedBody, signatureHeader: sigHeader, signingSecret: secret });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'SIGNATURE_MISMATCH');
});

test('verify rejects a signature made with the wrong secret', () => {
  const secret = 'whsec_' + Buffer.from('supersecretkeybytes').toString('base64');
  const wrongSecret = 'whsec_' + Buffer.from('totallydifferentkey').toString('base64');
  const body = JSON.stringify({ event: 'issuing.created.successful' });
  const id = 'msg_123';
  const ts = String(Math.floor(Date.now() / 1000));
  const sigHeader = sign(id, ts, body, wrongSecret);

  const result = verify({ svixId: id, svixTimestamp: ts, rawBody: body, signatureHeader: sigHeader, signingSecret: secret });
  assert.equal(result.valid, false);
});

test('verify rejects an old timestamp (replay protection)', () => {
  const secret = 'whsec_' + Buffer.from('supersecretkeybytes').toString('base64');
  const body = JSON.stringify({ event: 'issuing.created.successful' });
  const id = 'msg_123';
  const oldTs = String(Math.floor(Date.now() / 1000) - 3600); // 1 hour ago
  const sigHeader = sign(id, oldTs, body, secret);

  const result = verify({ svixId: id, svixTimestamp: oldTs, rawBody: body, signatureHeader: sigHeader, signingSecret: secret });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'TIMESTAMP_OUT_OF_RANGE');
});

test('verify handles multiple space-separated signatures (secret rotation)', () => {
  const secret = 'whsec_' + Buffer.from('supersecretkeybytes').toString('base64');
  const body = JSON.stringify({ event: 'issuing.created.successful' });
  const id = 'msg_123';
  const ts = String(Math.floor(Date.now() / 1000));
  const realSig = sign(id, ts, body, secret);
  const decoySig = 'v1,' + Buffer.from('decoy-signature-bytes').toString('base64');
  const combinedHeader = `${decoySig} ${realSig}`;

  const result = verify({ svixId: id, svixTimestamp: ts, rawBody: body, signatureHeader: combinedHeader, signingSecret: secret });
  assert.equal(result.valid, true);
});

test('verify rejects missing headers', () => {
  const result = verify({ svixId: null, svixTimestamp: '123', rawBody: '{}', signatureHeader: 'v1,abc', signingSecret: 'whsec_abc' });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'MISSING_HEADERS');
});

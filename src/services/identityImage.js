'use strict';
const net = require('net');
const dns = require('dns').promises;

/**
 * The card provider wants identity.image as a Base64 URI ("data:image/jpeg;base64,..."), not a link.
 * Merchants may still send either: a data URI is checked and passed through; an https link is downloaded
 * here (images only, size and time capped, never to a private address) and converted.
 */
const MAX_BYTES = 4 * 1024 * 1024;
const DATA_URI = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/]+=*$/;

function isDataUri(v) { return DATA_URI.test(String(v || '')); }

function privateAddress(ip) {
  if (net.isIPv6(ip)) return ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip) || /^::ffff:/i.test(ip);
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

async function assertPublicHost(hostname) {
  const addrs = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true });
  if (!addrs.length || addrs.some((a) => privateAddress(a.address))) throw bad('Le lien de l\'image n\'est pas accessible.');
}

function bad(message) {
  const err = new Error(message);
  err.httpStatus = 400;
  err.code = 'INVALID_IDENTITY_IMAGE';
  return err;
}

// Replaceable in tests.
let fetchImpl = (url, opts) => fetch(url, opts);
let customFetch = false;
function setFetch(fn) { customFetch = !!fn; fetchImpl = fn || ((url, opts) => fetch(url, opts)); }

async function toBase64Uri(input) {
  const value = String(input || '').trim();
  if (isDataUri(value)) return value;
  if (!/^https:\/\//i.test(value)) throw bad("L'image de la pièce doit être un lien https ou une image en Base64 (data:image/jpeg;base64,...).");
  let res;
  try {
    const host = new URL(value).hostname;
    if (!customFetch || net.isIP(host)) await assertPublicHost(host); // (a replaced fetch is a test double: no DNS)
    res = await fetchImpl(value, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  } catch (e) {
    if (e.code === 'INVALID_IDENTITY_IMAGE') throw e;
    throw bad("Impossible de télécharger l'image de la pièce. Vérifiez le lien ou envoyez l'image en Base64.");
  }
  if (!res.ok) throw bad("Impossible de télécharger l'image de la pièce (le lien répond avec une erreur).");
  const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!/^image\/(png|jpe?g|webp)$/.test(type)) throw bad("Le lien de la pièce doit pointer vers une image PNG, JPEG ou WebP.");
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > MAX_BYTES) throw bad("L'image de la pièce est vide ou dépasse 4 Mo.");
  return `data:${type === 'image/jpg' ? 'image/jpeg' : type};base64,${buf.toString('base64')}`;
}

module.exports = { toBase64Uri, isDataUri, setFetch, MAX_BYTES };

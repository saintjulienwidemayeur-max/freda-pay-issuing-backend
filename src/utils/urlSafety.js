'use strict';
const dns = require('dns').promises;
const net = require('net');

/**
 * Outbound URL safety (SSRF). A merchant-supplied webhook URL must never reach localhost, a private network,
 * a link-local / cloud-metadata address, or use a scheme other than https. Tests and the local mock stack opt in
 * explicitly with ALLOW_PRIVATE_WEBHOOKS=1 (read at call time).
 */
function allowPrivate() {
  return process.env.ALLOW_PRIVATE_WEBHOOKS === '1';
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, p) => acc * 256 + Number(p), 0);
}

const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => ({ start: ipv4ToInt(base), size: 2 ** (32 - bits) }));

function isBlockedIPv4(ip) {
  const n = ipv4ToInt(ip);
  return V4_BLOCKS.some((b) => n >= b.start && n < b.start + b.size);
}

function isBlockedIPv6(ip) {
  const lower = ip.toLowerCase().split('%')[0];
  // IPv4-mapped / compatible (::ffff:a.b.c.d or ::ffff:7f00:1)
  const dotted = lower.match(/^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isBlockedIPv4(dotted[1]);
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return isBlockedIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (lower === '::' || lower === '::1') return true;
  const first = parseInt(lower.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (first === 0x2001 && lower.startsWith('2001:db8')) return true; // documentation
  return false;
}

function isBlockedIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIPv4(ip);
  if (family === 6) return isBlockedIPv6(ip);
  return true;
}

function isBlockedHostname(host) {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')
    || h.endsWith('.localdomain') || h === 'metadata.google.internal' || !h.includes('.');
}

/** Synchronous check of the URL text. Returns the parsed URL or throws an Error with a French message. */
function checkWebhookUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch (_) {
    throw new Error('url invalide.');
  }
  const local = allowPrivate();
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const localHost = host === 'localhost' || net.isIP(host) !== 0;
  if (u.protocol !== 'https:' && !(local && localHost && u.protocol === 'http:')) {
    throw new Error('url doit commencer par https://.');
  }
  if (u.username || u.password) throw new Error("url ne doit pas contenir d'identifiants.");
  if (String(raw).length > 2000) throw new Error('url trop longue.');
  if (!local) {
    if (net.isIP(host) ? isBlockedIp(host) : isBlockedHostname(host)) {
      throw new Error("url doit pointer vers un serveur public (adresses locales, privées ou internes refusées).");
    }
  }
  return u;
}

/** Async check at registration and at send time: also resolves the name and refuses private/internal answers. */
async function assertPublicUrl(raw) {
  const u = checkWebhookUrl(raw);
  if (allowPrivate()) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return u;
  let answers;
  try {
    answers = await dns.lookup(host, { all: true });
  } catch (_) {
    throw new Error("url : le nom de domaine ne se résout pas.");
  }
  if (!answers.length || answers.some((a) => isBlockedIp(a.address))) {
    throw new Error("url doit pointer vers un serveur public (adresses locales, privées ou internes refusées).");
  }
  return u;
}

module.exports = { checkWebhookUrl, assertPublicUrl, isBlockedIp, isBlockedHostname };

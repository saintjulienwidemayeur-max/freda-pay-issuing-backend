'use strict';

/**
 * Guardrails of the AI agent. They run on EVERYTHING the agent writes (email drafts, chat replies, admin chat) and on everything it reads
 * from a tool, whatever the model was told: a prompt can be fooled, these rules cannot.
 *  - redact(): full card numbers, CVV, API keys and tokens, passwords are replaced before any text leaves.
 *  - detectSecretRequest(): someone asks for a card number / CVV / API key / password / 2FA code (social engineering).
 *  - detectInjection(): the incoming text tries to give the agent new instructions.
 *  - sensitiveIntent(): refunds, blocking, limits, account changes, legal threats... always need a human.
 */
const luhn = (digits) => {
  let sum = 0; let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
};

const PATTERNS = [
  { kind: 'api_key', re: /\b(?:sk|pk|rk|mpr_sk|mpr_pk)_(?:live|test|sandbox)?_?[A-Za-z0-9]{10,}\b/g, replace: '[clé API masquée]' },
  { kind: 'webhook_secret', re: /\bwhsec_[A-Za-z0-9+/=_-]{8,}\b/g, replace: '[secret masqué]' },
  { kind: 'token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, replace: 'Bearer [jeton masqué]' },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: '[jeton masqué]' },
  { kind: 'long_secret', re: /\b[a-f0-9]{40,}\b/gi, replace: '[secret masqué]' },
  { kind: 'password', re: /\b(mot de passe|motdepasse|password|passwd|pwd|modpas|mod pas|contraseña)\s*(?:est|is|=|:|es)?\s*[:=]?\s*["']?[^\s"']{4,}/gi, replace: (m, label) => `${label} : [masqué]` },
  { kind: 'cvv', re: /\b(cvv2?|cvc2?|cid|code de sécurité|security code|kòd sekirite|código de seguridad)\b[^\n\d]{0,25}\b\d{3,4}\b/gi, replace: (m, label) => `${label} : [masqué]` },
  { kind: 'otp', re: /\b(code de vérification|verification code|code 2fa|2fa code|otp|kòd verifikasyon)\b[^\n\d]{0,20}\b\d{6}\b/gi, replace: (m, label) => `${label} : [masqué]` },
];

/**
 * The names of our partners (card issuer, payment processors) are never written to a merchant: not in an email, not in the chat.
 * Replaced silently (this is not an incident, so it is not a finding). The admin assistant keeps them (keepPartners).
 */
const PARTNER_NAMES = /\bPay['’]m\s+PlopPlop\b|\bPlopPlop\b|\bPay['’]m\b|\bMonerails?\b|\bMaplerad\b|\bTranzak\b/gi;
const hidePartners = (text) => String(text == null ? '' : text).replace(PARTNER_NAMES, 'notre partenaire').replace(/(notre partenaire)(?:\s*(?:\/|,|et|and|ou)\s*notre partenaire)+/gi, '$1');

/** Returns { text, findings: [kind...] }. Card numbers are recognised by their length AND the Luhn check, so long reference numbers are left alone. */
function redact(input, opts) {
  let text = String(input == null ? '' : input);
  if (!(opts && opts.keepPartners)) text = hidePartners(text);
  const findings = [];
  for (const p of PATTERNS) {
    text = text.replace(p.re, (...args) => { findings.push(p.kind); return typeof p.replace === 'function' ? p.replace(...args) : p.replace; });
  }
  text = text.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) { findings.push('card_number'); return '[numéro de carte masqué]'; }
    return m;
  });
  return { text, findings: [...new Set(findings)] };
}

/** Same rule on structured data coming back from a tool. */
function redactDeep(value) {
  if (typeof value === 'string') return redact(value).text;
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/^(pan|card_number|cvv|cvc|password|password_hash|secret|api_key|key_hash|token|access_token|refresh_token|signature)$/i.test(k)) continue;
      out[k] = redactDeep(v);
    }
    return out;
  }
  return value;
}

const SECRET_ASK = [
  /\b(cvv|cvc|code de sécurité|security code|kòd sekirite)\b/i,
  /\b(numéro|numero|number|nimewo|número)\b[^\n.?!]{0,30}\b(complet|full|entier|konplè|completo)\b[^\n.?!]{0,30}\b(carte|card|kat|tarjeta)\b/i,
  /\b(clé|cle|key|kle|llave)\b[^\n.?!]{0,15}\b(api|secrète|secrete|secret|live)\b/i,
  /\b(mot de passe|password|modpas|contraseña)\b/i,
  /\b(code|kòd)\b[^\n.?!]{0,15}\b(2fa|otp|authenticator|vérification|verification)\b/i,
  /\b(donne|donnez|envoie|envoyez|send|give|share|montre|révèle|reveal|voye|ban mwen|muestra|envía)\b[^\n.?!]{0,40}\b(pan|numéro de carte|card number|nimewo kat)\b/i,
];
const INJECTION = [
  /ignore (all |any )?(the )?(previous|prior|above|earlier) (instructions|rules|prompts?)/i,
  /ignore[zr]? (toutes )?(les )?(instructions|règles|consignes) (précédentes|ci-dessus|antérieures)/i,
  /\b(system prompt|prompt système|instructions? système|your instructions|tes instructions|vos instructions)\b/i,
  /you are (now|no longer)\b|tu es (maintenant|désormais)|vous êtes (maintenant|désormais)/i,
  /\b(jailbreak|developer mode|mode développeur|do anything now|DAN)\b/i,
  /(oublie|forget|disregard)[^\n.]{0,30}(règles|rules|instructions|consignes)/i,
  /\[\s*(system|assistant|admin)\s*\]|<\s*(system|assistant)\s*>/i,
  /(désactive|disable|turn off|bypass|contourne)[^\n.]{0,30}(guardrail|sécurité|safety|restriction|protection|filtre)/i,
];
const SENSITIVE = [
  { reason: 'remboursement', re: /\b(rembours\w*|refund\w*|chargeback|rétrofactur\w*|ranbou\w*|reembols\w*|devolución)\b/i },
  { reason: 'blocage / déblocage de compte ou de carte', re: /\b(bloqu\w*|débloqu\w*|debloqu\w*|geler|gel de|freeze|unfreeze|suspend\w*|reactiv\w*|réactiv\w*|bloke|debloke|bloquear|desbloquear)\b/i },
  { reason: 'changement de limite', re: /\b(limite|limit|plafond|ogmant\w*|augmenter la limite|raise (my )?limit|límite)\b/i },
  { reason: 'fermeture ou suppression de compte', re: /\b(supprim\w+ (mon|le|votre) compte|fermer (mon|le) compte|delete (my )?account|close (my )?account|efase kont|cerrar (mi )?cuenta)\b/i },
  { reason: 'retrait ou transfert de fonds', re: /\b(retirer|retrait|withdraw|transf[eé]r\w*|virement|wire|retire lajan|retirar|libérer les fonds|release (the )?funds)\b/i },
  { reason: 'changement de coordonnées ou de sécurité', re: /\b(changer (mon|l') ?(email|adresse|numéro|mot de passe)|change (my )?(email|phone|password)|reset (my )?(2fa|password)|réinitialiser (la )?2fa|perdu (mon )?(téléphone|telephone|accès)|lost (my )?(phone|access)|chanje (imèl|modpas))\b/i },
  { reason: 'menace juridique, plainte ou fraude', re: /\b(avocat|lawyer|attorney|plainte|police|tribunal|lawsuit|sue you|poursuite|escroc\w*|scam|fraud\w*|vol\b|stolen|volé|piraté|hacked|abogado|demanda|estafa)\b/i },
  { reason: 'décision KYC / KYB', re: /\b(valider mon (kyc|kyb|compte)|approve my (kyc|kyb|account)|pourquoi (mon )?(kyc|kyb)|kyc (refus|rejet)|rejected kyc|verification (rejected|refused))\b/i },
];

const hit = (list, text) => list.some((re) => re.test(text));
const detectSecretRequest = (text) => hit(SECRET_ASK, String(text || ''));
const detectInjection = (text) => hit(INJECTION, String(text || ''));
/** The reasons a human must decide (empty = nothing sensitive was found in this text). */
function sensitiveIntent(text) {
  const t = String(text || '');
  return SENSITIVE.filter((s) => s.re.test(t)).map((s) => s.reason);
}

module.exports = { hidePartners, redact, redactDeep, detectSecretRequest, detectInjection, sensitiveIntent, luhn };

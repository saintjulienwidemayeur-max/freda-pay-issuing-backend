'use strict';

/**
 * Signs of an automated or throw-away signup: a disposable mailbox (the bot reads the verification code there), an account created by API
 * without the signup questionnaire, "test" names and mailboxes made of a long number. Used to refuse the worst at signup and to flag
 * the rest for the team (nothing is ever deleted automatically).
 */
const DISPOSABLE = new Set([
  'euploading.com', 'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.biz', 'guerrillamailblock.com', 'sharklasers.com', 'grr.la',
  '10minutemail.com', '10minutemail.net', '20minutemail.com', 'yopmail.com', 'yopmail.net', 'yopmail.fr', 'tempmail.com', 'temp-mail.org', 'temp-mail.io', 'tempmail.net', 'tempmailo.com',
  'trashmail.com', 'trashmail.net', 'trash-mail.com', 'getnada.com', 'nada.email', 'dispostable.com', 'maildrop.cc', 'mohmal.com', 'throwawaymail.com', 'fakeinbox.com',
  'emailondeck.com', 'mailnesia.com', 'mintemail.com', 'moakt.com', 'tmpmail.org', 'tmpmail.net', 'tempr.email', 'discard.email', 'spamgourmet.com', 'burnermail.io',
  '1secmail.com', '1secmail.org', '1secmail.net', 'wwjmp.com', 'esiix.com', 'xojxe.com', 'yoggm.com', 'dcctb.com', 'kzccv.com', 'qiott.com', 'wuuvo.com', 'vjuum.com', 'laafd.com',
  'txcct.com', 'rteet.com', 'emltmp.com', 'inboxkitten.com', 'tempinbox.xyz', 'mail.tm', 'tmail.ws', 'tmpeml.com', 'fexpost.com', 'mailpoof.com', 'cuvox.de', 'armyspy.com',
  'dayrep.com', 'einrot.com', 'fleckens.hu', 'gustr.com', 'jourrapide.com', 'rhyta.com', 'superrito.com', 'teleworm.us', 'mailcatch.com', 'spambox.us', 'tempail.com', 'luxusmail.org',
]);
const extra = () => String(process.env.BLOCKED_EMAIL_DOMAINS || '').split(/[\s,;]+/).map((d) => d.trim().toLowerCase()).filter(Boolean);

function domainOf(email) { const m = /@([^@\s]+)$/.exec(String(email || '').trim().toLowerCase()); return m ? m[1] : ''; }
/** The domain or any parent of it is on the list (mail.euploading.com counts). */
function isDisposable(email) {
  const d = domainOf(email);
  if (!d) return false;
  const bad = new Set([...DISPOSABLE, ...extra()]);
  const parts = d.split('.');
  for (let i = 0; i < parts.length - 1; i += 1) if (bad.has(parts.slice(i).join('.'))) return true;
  return false;
}

/** Flags for the admin list (strings): disposable_email, no_questionnaire, test_name, number_mailbox. */
function flagsFor(m) {
  const out = [];
  if (isDisposable(m.email)) out.push('disposable_email');
  const onb = m.onboarding;
  if (!onb || (typeof onb === 'object' && !Object.keys(onb).length)) out.push('no_questionnaire');
  if (/\b(test|tester|demo)\b/i.test(String(m.business_name || ''))) out.push('test_name');
  if (/^[a-z]*\d{8,}@/i.test(String(m.email || ''))) out.push('number_mailbox');
  return out;
}

module.exports = { isDisposable, flagsFor, domainOf };

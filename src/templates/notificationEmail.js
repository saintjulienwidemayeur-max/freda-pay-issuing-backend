'use strict';
const config = require('../config');

const LOGO_URL = config.emailLogoUrl;

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Escapes, then turns **bold** into <strong>. The only markup a caller can produce. */
function inline(text) {
  return escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

const TONES = { info: '#ff4081', success: '#16a34a', danger: '#dc2626', warning: '#d97706' };

/**
 * One branded transactional email layout for every notification (verification
 * result, suspension, deposit decision, login code...). Table-based and
 * inline-styled so it renders in Gmail/Outlook/Apple Mail.
 *
 * @param {object} o
 * @param {string} o.subject
 * @param {string} o.eyebrow      small uppercase label above the heading
 * @param {string} o.heading
 * @param {string[]} o.paragraphs plain text; **bold** allowed
 * @param {string} [o.tone]       info | success | danger | warning
 * @param {string} [o.code]       renders a big code box (login code)
 * @param {{label:string,url:string}} [o.button]
 * @param {string} [o.notice]     small yellow security/notice box
 */
function buildEmail({ subject, eyebrow, heading, paragraphs = [], tone = 'info', code, button, notice }) {
  const color = TONES[tone] || TONES.info;
  const paras = paragraphs.map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#4b4b4b;">${inline(p)}</p>`).join('\n');
  const codeBox = code
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#faf6f8;border:1px solid #ece4e8;border-radius:12px;margin:8px 0 20px;"><tr><td align="center" style="padding:24px 16px;"><span style="font-family:'Courier New',monospace;font-size:36px;font-weight:800;letter-spacing:0.28em;color:#111111;">${escapeHtml(code)}</span></td></tr></table>`
    : '';
  const btn = button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px;"><tr><td style="background-color:#111111;border-radius:10px;"><a href="${escapeHtml(button.url)}" style="display:inline-block;padding:14px 26px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">${escapeHtml(button.label)}</a></td></tr></table>`
    : '';
  const noticeBox = notice
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;background-color:#fff8eb;border-radius:10px;"><tr><td style="padding:14px 16px;font-size:13px;color:#92400e;line-height:1.5;">${inline(notice)}</td></tr></table>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background-color:#f4f1f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f1f3;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 20px 50px -20px rgba(0,0,0,0.15);">
        <tr>
          <td style="background-color:#111111;padding:28px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td style="width:36px;height:36px;border-radius:9px;overflow:hidden;"><img src="${LOGO_URL}" width="36" height="36" alt="" style="display:block;width:36px;height:36px;border-radius:9px;border:0;"></td>
              <td style="padding-left:11px;vertical-align:middle;"><span style="color:#ffffff;font-size:16px;font-weight:800;">FREDA PAY</span><span style="color:#ff4081;font-size:16px;font-weight:800;">&nbsp;ISSUING</span></td>
            </tr></table>
          </td>
        </tr>
        <tr>
          <td style="padding:40px 32px 28px;">
            <p style="margin:0 0 6px;font-size:13px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${color};">${escapeHtml(eyebrow)}</p>
            <h1 style="margin:0 0 18px;font-size:22px;font-weight:800;color:#111111;line-height:1.3;">${escapeHtml(heading)}</h1>
            ${paras}
            ${codeBox}
            ${btn}
            ${noticeBox}
          </td>
        </tr>
        <tr>
          <td style="padding:22px 32px;border-top:1px solid #ece4e8;">
            <p style="margin:0;font-size:12px;color:#9c9297;line-height:1.6;">© ${new Date().getFullYear()} Freda Pay LLC · <a href="mailto:issuing@fredapay.com" style="color:#ff4081;text-decoration:none;">issuing@fredapay.com</a></p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    heading,
    '',
    ...paragraphs.map((p) => p.replace(/\*\*/g, '')),
    code ? `\n${code}\n` : '',
    button ? `${button.label} : ${button.url}` : '',
    notice ? notice.replace(/\*\*/g, '') : '',
  ].filter((l) => l !== '').join('\n');

  return { subject, html, text };
}

module.exports = { buildEmail };

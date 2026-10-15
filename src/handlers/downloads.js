'use strict';
const fs = require('fs');
const path = require('path');
function httpError(status, code, message) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  return err;
}

// Plugin and SDK kits are only handed to a logged-in merchant. The names are a
// fixed whitelist (never built from user input), so no path traversal is possible.
const DIR = path.join(__dirname, '..', '..', 'downloads');
const FILES = {
  'freda-pay-woocommerce.zip': 'WordPress / WooCommerce',
  'freda-pay-wix.zip': 'Wix',
  'freda-pay-node-sdk.zip': 'SDK Node.js',
  'freda-pay-php-sdk.zip': 'SDK PHP',
};

async function download(ctx) {
  const name = ctx.params.name;
  if (!Object.prototype.hasOwnProperty.call(FILES, name)) {
    throw httpError(404, 'NOT_FOUND', 'Fichier introuvable.');
  }
  let buf;
  try { buf = fs.readFileSync(path.join(DIR, name)); }
  catch (e) { throw httpError(404, 'NOT_FOUND', 'Fichier introuvable.'); }
  ctx.res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': buf.length,
    'Content-Disposition': 'attachment; filename="' + name + '"',
    'Cache-Control': 'private, no-store',
  });
  ctx.res.end(buf);
}

module.exports = { download, FILES };

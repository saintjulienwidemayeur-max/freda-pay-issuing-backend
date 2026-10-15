'use strict';
const fs = require('fs');
const path = require('path');

// Public brand images served by the backend itself, so emails and the blog never depend on another host.
const FILES = {
  'logo-email.png': path.join(__dirname, '..', 'assets', 'logo-email.png'),
  'logo.png': path.join(__dirname, '..', 'assets', 'logo-email.png'),
};
const cache = {};

async function serve(ctx) {
  const file = FILES[ctx.params.name];
  if (!file) { const err = new Error('Fichier introuvable.'); err.httpStatus = 404; err.code = 'NOT_FOUND'; throw err; }
  if (!cache[ctx.params.name]) cache[ctx.params.name] = fs.readFileSync(file);
  ctx.res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': cache[ctx.params.name].length,
    'Cache-Control': 'public, max-age=86400',
    'Access-Control-Allow-Origin': '*',
  });
  ctx.res.end(cache[ctx.params.name]);
}

module.exports = { serve };

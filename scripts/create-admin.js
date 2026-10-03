#!/usr/bin/env node
'use strict';
/**
 * Prints an INSERT statement to create (or reset) an admin account.
 * Run locally: node scripts/create-admin.js "email@fredapay.com" "Full Name" "password" [owner|admin|editor]
 * Then paste the printed SQL into the Supabase SQL Editor and run it once.
 * Roles: owner/admin can review KYC/KYB and manage the blog; editor can only manage the blog.
 */
const { hashPassword } = require('../src/utils/password');
const { randomHex } = require('../src/utils/ids');

const [, , email, name, password, role] = process.argv;
if (!email || !name || !password) {
  console.error('Usage: node scripts/create-admin.js "email@fredapay.com" "Full Name" "password" [owner|admin|editor]');
  process.exit(1);
}
const finalRole = role || 'owner';
if (!['owner', 'admin', 'editor'].includes(finalRole)) {
  console.error('role must be one of: owner, admin, editor');
  process.exit(1);
}

const id = `adm_${randomHex(8)}`;
const passwordHash = hashPassword(password);
const esc = (s) => s.replace(/'/g, "''");

console.log('\n-- Paste this into Supabase SQL Editor and run it once:\n');
console.log(
  `insert into admin_users (id, email, password_hash, name, role) values ` +
  `('${id}', '${esc(email.toLowerCase())}', '${passwordHash}', '${esc(name)}', '${finalRole}') ` +
  `on conflict (email) do update set password_hash = excluded.password_hash, name = excluded.name, role = excluded.role;`
);
console.log('\nLogin at /admin.html with the email and password you gave this script.\n');

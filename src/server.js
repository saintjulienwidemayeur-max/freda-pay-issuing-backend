'use strict';
const http = require('http');
const { Router, createHandler } = require('./router');
const config = require('./config');

const session = require('./middleware/session');
const apiKey = require('./middleware/apiKey');
const rateLimit = require('./utils/rateLimit');

const authHandlers = require('./handlers/auth');
const apiKeyHandlers = require('./handlers/apiKeys');
const paymentHandlers = require('./handlers/payments');
const payoutHandlers = require('./handlers/payouts');
const walletHandlers = require('./handlers/wallet');
const walletTopupHandlers = require('./handlers/walletTopup');
const accountHandlers = require('./handlers/account');
const billingHandlers = require('./handlers/billing');
const paymentLinkHandlers = require('./handlers/paymentLinks');
const cardHandlers = require('./handlers/cards');
const webhookHandlers = require('./handlers/webhooks');
const webhookEndpointHandlers = require('./handlers/webhookEndpoints');
const teamHandlers = require('./handlers/team');
const adminAuthHandlers = require('./handlers/adminAuth');
const adminVerificationHandlers = require('./handlers/adminVerifications');
const adminBlogHandlers = require('./handlers/adminBlog');
const adminMerchantHandlers = require('./handlers/adminMerchants');
const adminTeamHandlers = require('./handlers/adminTeam');
const blogHandlers = require('./handlers/blog');
const verificationHandlers = require('./handlers/verification');
const disputeHandlers = require('./handlers/disputes');
const adminDisputeHandlers = require('./handlers/adminDisputes');
const gatewaySummaryHandlers = require('./handlers/gatewaySummary');
const issuingAccessHandlers = require('./handlers/issuingAccess');
const adminIssuingAccessHandlers = require('./handlers/adminIssuingAccess');
const adminSession = require('./middleware/adminSession');

const router = new Router();

// ---- Health ----
router.get('/health', async () => ({ status: 200, body: { ok: true, service: 'freda-pay-backend' } }));

// Machine-readable API spec - same convention as most public APIs (e.g.
// GET /openapi.yaml). Served as a raw file, not the JSON envelope every
// other route uses (see router.js: a handler that writes its own response
// is left alone).
router.get('/openapi.yaml', async (ctx) => {
  const fs = require('fs');
  const path = require('path');
  const specPath = path.join(__dirname, '..', 'openapi.yaml');
  const yaml = fs.readFileSync(specPath, 'utf8');
  ctx.res.writeHead(200, { 'Content-Type': 'application/yaml; charset=utf-8' });
  ctx.res.end(yaml);
});

// ---- Dashboard auth (used by freda-pay-signup.html) ----
router.post('/auth/register', rateLimit.middleware('register', 60, 60 * 60 * 1000), authHandlers.register);
router.post('/auth/login', rateLimit.middleware('login', 20, 15 * 60 * 1000), authHandlers.login);
router.post('/auth/verify-otp', rateLimit.middleware('verify-otp', 100, 15 * 60 * 1000), authHandlers.verifyEmailOtp);
router.post('/auth/resend-otp', rateLimit.middleware('resend-otp', 3, 5 * 60 * 1000), authHandlers.resendEmailOtp);
router.get('/auth/me', session.requireSession, authHandlers.me);
router.get('/auth/invite-info', rateLimit.middleware('invite-info', 30, 15 * 60 * 1000), teamHandlers.inviteInfo);
router.post('/auth/accept-invite', rateLimit.middleware('accept-invite', 20, 15 * 60 * 1000), teamHandlers.acceptInvite);

// ---- Team (owner only) ----
router.get('/dashboard/team', session.requireSession, session.requireOwner, teamHandlers.list);
router.post('/dashboard/team/invite', session.requireSession, session.requireOwner, teamHandlers.invite);
router.post('/dashboard/team/:id/resend', session.requireSession, session.requireOwner, teamHandlers.resend);
router.del('/dashboard/team/:id', session.requireSession, session.requireOwner, teamHandlers.remove);

// ---- API key management (dashboard-authenticated) ----
router.post('/dashboard/api-keys', session.requireSession, apiKeyHandlers.create);
router.get('/dashboard/api-keys', session.requireSession, apiKeyHandlers.list);
router.del('/dashboard/api-keys/:id', session.requireSession, apiKeyHandlers.revoke);
router.get('/dashboard/balance', session.requireSession, walletHandlers.getBalance);

// ---- Dashboard views of payments/payouts (same handlers as the merchant API,
// just authenticated via the dashboard session instead of an API key) ----
router.get('/dashboard/payments', session.requireSession, paymentHandlers.list);
router.post('/dashboard/payments', session.requireSession, paymentHandlers.create);
router.get('/dashboard/payments/export.csv', session.requireSession, paymentHandlers.exportCsv); // must be registered before the :id route below, or "export.csv" matches as an :id
router.get('/dashboard/payments/:id', session.requireSession, paymentHandlers.get);

router.get('/dashboard/payouts', session.requireSession, payoutHandlers.list);
router.post('/dashboard/payouts', session.requireSession, payoutHandlers.create);
router.get('/dashboard/payouts/:id', session.requireSession, payoutHandlers.get);

// ---- Master Wallet top-ups: MonCash/Natcash (automatic) or Zelle/bank
// transfer (manual, requires a receipt and staff review before crediting) ----
router.get('/dashboard/wallet/topups', session.requireSession, walletTopupHandlers.list);
router.post('/dashboard/wallet/topups', session.requireSession, walletTopupHandlers.create);
router.get('/dashboard/wallet/topups/:id', session.requireSession, walletTopupHandlers.get);

// ---- Account (business info, individual -> business conversion) ----
router.put('/dashboard/account', session.requireSession, accountHandlers.update);
router.put('/dashboard/mode', session.requireSession, accountHandlers.setMode);
router.post('/dashboard/account/password', session.requireSession, accountHandlers.changePassword);

// ---- Billing (Issuing subscription plans, charged to the Master Wallet) ----
router.get('/dashboard/billing/plans', billingHandlers.getPlans);
router.post('/dashboard/billing/gateway-plan', session.requireSession, billingHandlers.changeGatewayPlan);
router.post('/dashboard/billing/issuing-plan', session.requireSession, billingHandlers.changeIssuingPlan);

// ---- Payment Links (dashboard management) ----
router.post('/dashboard/payment-links', session.requireSession, paymentLinkHandlers.create);
router.get('/dashboard/payment-links', session.requireSession, paymentLinkHandlers.list);
router.post('/dashboard/payment-links/:id/disable', session.requireSession, paymentLinkHandlers.disable);
router.del('/dashboard/payment-links/:id', session.requireSession, paymentLinkHandlers.remove);

// ---- Payment Links (PUBLIC - anyone with the link can view/pay, no account needed) ----
router.get('/public/payment-links/:id', paymentLinkHandlers.publicGet);
router.post('/public/payment-links/:id/pay', paymentLinkHandlers.publicPay);
router.get('/public/payment-links/:id/payments/:paymentId', paymentLinkHandlers.publicPaymentStatus);

// ---- Cards (Issuing, via Maplerad) ----
router.get('/dashboard/cards/holder-profile', session.requireSession, cardHandlers.getHolderProfile);
router.post('/dashboard/cards/holder-profile', session.requireSession, cardHandlers.submitHolderProfile);
router.get('/dashboard/cards/holders', session.requireSession, cardHandlers.listHolders);
router.post('/dashboard/cards/holders', session.requireSession, cardHandlers.createHolder);
router.get('/dashboard/cards/holders/:id', session.requireSession, cardHandlers.getHolder);
router.post('/dashboard/cards', session.requireSession, cardHandlers.createCard);
router.get('/dashboard/cards', session.requireSession, cardHandlers.list);
router.get('/dashboard/cards/transactions', session.requireSession, cardHandlers.getAllTransactions); // consolidated, for the Overview page - must come before /:id below
router.get('/dashboard/cards/:id', session.requireSession, cardHandlers.get);
router.get('/dashboard/cards/:id/transactions', session.requireSession, cardHandlers.getTransactions);
router.post('/dashboard/cards/:id/simulate-transaction', session.requireSession, cardHandlers.simulateTransaction);
router.post('/dashboard/cards/:id/reveal', session.requireSession, cardHandlers.revealDetails);
router.post('/v1/cards/:id/reveal', apiKey.requireApiKey, cardHandlers.revealDetails);

// Same card operations, authenticated with a merchant's own API key
// (Authorization: Bearer sk_test_xxx / sk_live_xxx) instead of a dashboard
// session token - lets a third-party backend issue and manage cards
// programmatically, server-to-server, exactly like /v1/payments and
// /v1/payouts below. Reuses the exact same handlers as the /dashboard/cards
// routes above: both middlewares set ctx.merchantId the same way.
router.get('/v1/cards/holder-profile', apiKey.requireApiKey, cardHandlers.getHolderProfile);
router.post('/v1/cards/holder-profile', apiKey.requireApiKey, cardHandlers.submitHolderProfile);
router.get('/v1/cards/holders', apiKey.requireApiKey, cardHandlers.listHolders);
router.post('/v1/cards/holders', apiKey.requireApiKey, cardHandlers.createHolder);
router.get('/v1/cards/holders/:id', apiKey.requireApiKey, cardHandlers.getHolder);
router.post('/v1/cards', apiKey.requireApiKey, cardHandlers.createCard);
router.get('/v1/cards', apiKey.requireApiKey, cardHandlers.list);
router.get('/v1/cards/:id', apiKey.requireApiKey, cardHandlers.get);
router.get('/v1/cards/:id/transactions', apiKey.requireApiKey, cardHandlers.getTransactions);
router.post('/v1/cards/:id/simulate-transaction', apiKey.requireApiKey, cardHandlers.simulateTransaction);
router.post('/v1/cards/:id/fund', apiKey.requireApiKey, cardHandlers.fund);
router.post('/v1/cards/:id/withdraw', apiKey.requireApiKey, cardHandlers.withdraw);
router.post('/v1/cards/:id/freeze', apiKey.requireApiKey, cardHandlers.freeze);
router.post('/v1/cards/:id/unfreeze', apiKey.requireApiKey, cardHandlers.unfreeze);
router.post('/v1/cards/:id/terminate', apiKey.requireApiKey, cardHandlers.terminate);
router.post('/dashboard/cards/:id/fund', session.requireSession, cardHandlers.fund);
router.post('/dashboard/cards/:id/withdraw', session.requireSession, cardHandlers.withdraw);
router.post('/dashboard/cards/:id/freeze', session.requireSession, cardHandlers.freeze);
router.post('/dashboard/cards/:id/unfreeze', session.requireSession, cardHandlers.unfreeze);
router.post('/dashboard/cards/:id/terminate', session.requireSession, cardHandlers.terminate);

// ---- Webhooks (PUBLIC - called by providers, authenticated via signature, not session/API key) ----
router.post('/webhooks/maplerad', webhookHandlers.receiveMaplerad);

// ---- Outbound webhook management (register the URL Freda Pay notifies on events) ----
router.post('/dashboard/webhooks', session.requireSession, webhookEndpointHandlers.register);
router.get('/dashboard/webhooks', session.requireSession, webhookEndpointHandlers.get);
router.del('/dashboard/webhooks', session.requireSession, webhookEndpointHandlers.remove);
router.post('/dashboard/webhooks/rotate-secret', session.requireSession, webhookEndpointHandlers.rotateSecret);

router.post('/v1/webhooks', apiKey.requireApiKey, webhookEndpointHandlers.register);
router.get('/v1/webhooks', apiKey.requireApiKey, webhookEndpointHandlers.get);
router.del('/v1/webhooks', apiKey.requireApiKey, webhookEndpointHandlers.remove);
router.post('/v1/webhooks/rotate-secret', apiKey.requireApiKey, webhookEndpointHandlers.rotateSecret);

// ---- Merchant-facing API (used by Freda Pay's own merchants, via API key) ----
router.post('/v1/payments', apiKey.requireApiKey, paymentHandlers.create);
router.get('/v1/payments/:id', apiKey.requireApiKey, paymentHandlers.get);

router.post('/v1/payouts', apiKey.requireApiKey, payoutHandlers.create);
router.get('/v1/payouts/:id', apiKey.requireApiKey, payoutHandlers.get);

router.get('/v1/balance', apiKey.requireApiKey, walletHandlers.getBalance);

const handler = createHandler(router, {
  onLog: ({ method, path, status, ms }) => {
    // eslint-disable-next-line no-console
    console.log(`${method} ${path} -> ${status} (${ms}ms)`);
  },
});


// ---- Merchant-facing KYC/KYB submission (real - replaces the old client-only checkbox) ----
router.post('/dashboard/verification/:kind', session.requireSession, verificationHandlers.submit);
router.get('/dashboard/verification', session.requireSession, verificationHandlers.mine);

// ---- Disputes (merchant opens, admin reviews) ----
router.post('/dashboard/payments/:id/dispute', session.requireSession, disputeHandlers.create);
router.get('/dashboard/disputes', session.requireSession, disputeHandlers.mine);
router.get('/admin/disputes', adminSession.requireAdminSession, adminDisputeHandlers.list);
router.post('/admin/disputes/:id/resolve', adminSession.requireAdminSession, (ctx) => { adminSession.requireComplianceRole(ctx); return adminDisputeHandlers.resolve(ctx); });
router.post('/admin/disputes/:id/reject', adminSession.requireAdminSession, (ctx) => { adminSession.requireComplianceRole(ctx); return adminDisputeHandlers.reject(ctx); });

// ---- Gateway summary (money in, fees paid, day/week) ----
router.get('/dashboard/gateway-summary', session.requireSession, gatewaySummaryHandlers.summary);

// ---- Issuing Live access (always a separate admin-reviewed request, never auto-granted by KYC) ----
router.post('/dashboard/issuing-access/request', session.requireSession, issuingAccessHandlers.request);
router.get('/dashboard/issuing-access', session.requireSession, issuingAccessHandlers.mine);
router.get('/admin/issuing-access', adminSession.requireAdminSession, adminIssuingAccessHandlers.listPending);
router.post('/admin/issuing-access/:id/approve', adminSession.requireAdminSession, (ctx) => { adminSession.requireComplianceRole(ctx); return adminIssuingAccessHandlers.approve(ctx); });
router.post('/admin/issuing-access/:id/reject', adminSession.requireAdminSession, (ctx) => { adminSession.requireComplianceRole(ctx); return adminIssuingAccessHandlers.reject(ctx); });

// ---- Public blog (server-rendered HTML, indexable by search engines) ----
router.get('/blog', blogHandlers.listPage);
router.get('/blog/:slug', blogHandlers.postPage);
router.get('/api/blog', blogHandlers.listPublicJson);

// ---- Admin (Freda Pay staff only - separate login from merchants) ----
router.post('/admin/login', rateLimit.middleware('admin-login', 80, 15 * 60 * 1000), adminAuthHandlers.login);
router.get('/admin/invite-info', rateLimit.middleware('admin-invite-info', 30, 15 * 60 * 1000), adminTeamHandlers.inviteInfo);
router.post('/admin/accept-invite', rateLimit.middleware('admin-accept-invite', 20, 15 * 60 * 1000), adminTeamHandlers.acceptInvite);
router.get('/admin/me', adminSession.requireAdminSession, adminAuthHandlers.me);
router.post('/admin/account/password', adminSession.requireAdminSession, adminAuthHandlers.changePassword);

router.get('/admin/overview', adminSession.requireAdminSession, adminMerchantHandlers.overview);
router.get('/admin/merchants', adminSession.requireAdminSession, adminMerchantHandlers.list);
router.get('/admin/merchants/:id', adminSession.requireAdminSession, adminMerchantHandlers.get);
router.post('/admin/merchants/:id/credit', adminSession.requireAdminSession, (ctx) => { adminSession.requireComplianceRole(ctx); return adminMerchantHandlers.credit(ctx); });
router.put('/admin/merchants/:id/pricing', adminSession.requireAdminSession, (ctx) => { adminSession.requireComplianceRole(ctx); return adminMerchantHandlers.setPricing(ctx); });
router.del('/admin/merchants/:id/pricing', adminSession.requireAdminSession, (ctx) => { adminSession.requireComplianceRole(ctx); return adminMerchantHandlers.clearPricing(ctx); });
router.put('/admin/merchants/:id/live', adminSession.requireAdminSession, (ctx) => { adminSession.requireComplianceRole(ctx); return adminMerchantHandlers.setLive(ctx); });
router.put('/admin/merchants/:id/free-plan', adminSession.requireAdminSession, (ctx) => { adminSession.requireComplianceRole(ctx); return adminMerchantHandlers.setFreePlan(ctx); });
router.del('/admin/merchants/:id', adminSession.requireAdminSession, (ctx) => { adminSession.requireComplianceRole(ctx); return adminMerchantHandlers.remove(ctx); });
router.post('/admin/merchants/:id/restore', adminSession.requireAdminSession, (ctx) => { adminSession.requireComplianceRole(ctx); return adminMerchantHandlers.restore(ctx); });

// ---- Admin team (owner only manages other admins) ----
router.get('/admin/team', adminSession.requireAdminSession, adminTeamHandlers.list);
router.post('/admin/team/invite', adminSession.requireAdminSession, (ctx) => { if (ctx.adminRole !== 'owner') throw Object.assign(new Error('Seul le propriétaire peut inviter.'), { httpStatus: 403, code: 'OWNER_ONLY' }); return adminTeamHandlers.invite(ctx); });
router.post('/admin/team/:id/resend', adminSession.requireAdminSession, (ctx) => { if (ctx.adminRole !== 'owner') throw Object.assign(new Error('Seul le propriétaire peut renvoyer une invitation.'), { httpStatus: 403, code: 'OWNER_ONLY' }); return adminTeamHandlers.resend(ctx); });
router.del('/admin/team/:id', adminSession.requireAdminSession, (ctx) => { if (ctx.adminRole !== 'owner') throw Object.assign(new Error('Seul le propriétaire peut retirer un accès.'), { httpStatus: 403, code: 'OWNER_ONLY' }); return adminTeamHandlers.remove(ctx); });

router.get('/admin/verifications', adminSession.requireAdminSession, adminVerificationHandlers.listPending);
router.get('/admin/verifications/:id/document', adminSession.requireAdminSession, adminVerificationHandlers.viewDocument);
router.post('/admin/verifications/:id/approve', adminSession.requireAdminSession, (ctx) => { adminSession.requireComplianceRole(ctx); return adminVerificationHandlers.approve(ctx); });
router.post('/admin/verifications/:id/reject', adminSession.requireAdminSession, (ctx) => { adminSession.requireComplianceRole(ctx); return adminVerificationHandlers.reject(ctx); });

router.get('/admin/blog', adminSession.requireAdminSession, adminBlogHandlers.list);
router.get('/admin/blog/:id', adminSession.requireAdminSession, adminBlogHandlers.get);
router.post('/admin/blog', adminSession.requireAdminSession, adminBlogHandlers.create);
router.put('/admin/blog/:id', adminSession.requireAdminSession, adminBlogHandlers.update);
router.post('/admin/blog/:id/publish', adminSession.requireAdminSession, adminBlogHandlers.publish);
router.post('/admin/blog/:id/unpublish', adminSession.requireAdminSession, adminBlogHandlers.unpublish);
router.del('/admin/blog/:id', adminSession.requireAdminSession, adminBlogHandlers.remove);
router.post('/admin/blog/upload-cover', adminSession.requireAdminSession, adminBlogHandlers.uploadCover);

const server = http.createServer(handler);
// Hosting proxies (Render, etc.) keep connections open longer than Node's 5s
// default; if Node closes first, the proxy occasionally reuses a dead socket
// and the client sees a spurious 502. Stay open longer than the proxy does.
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;

if (require.main === module) {
  server.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Freda Pay backend listening on http://localhost:${config.port}`);
    if (!config.plopplop.clientId || !config.plopplop.clientSecret) {
      console.warn(
        'WARNING: PLOPPLOP_CLIENT_ID / PLOPPLOP_CLIENT_SECRET are not set. ' +
        'Payments and payouts will fail until you configure them in .env'
      );
    }
    if (!config.maplerad.secretKey) {
      console.warn('WARNING: MAPLERAD_SECRET_KEY is not set. Card issuing will fail until you configure it in .env');
    }
    if (!config.maplerad.webhookSecret) {
      console.warn('WARNING: MAPLERAD_WEBHOOK_SECRET is not set. Card creation will never be confirmed (stuck pending) until you configure it in .env');
    }
    require('./services/selfPing').start();
  });
}

module.exports = server;

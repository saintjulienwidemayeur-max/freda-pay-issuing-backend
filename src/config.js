'use strict';

// Minimal .env loader (no dependency on the `dotenv` package).
function loadDotEnv(path) {
  const fs = require('fs');
  if (!fs.existsSync(path)) return;
  const content = fs.readFileSync(path, 'utf8');
  content.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  });
}

loadDotEnv(require('path').join(__dirname, '..', '.env'));

/** Env values pasted into a dashboard often carry a trailing newline, spaces or wrapping quotes: strip them. */
const clean = (v) => String(v == null ? '' : v).trim().replace(/^["'`]+|["'`]+$/g, '').trim();

const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  dbPath: process.env.DB_PATH || require('path').join(__dirname, '..', 'freda.db'),

  // Freda Pay's own session-token signing secret (dashboard login).
  sessionSecret: process.env.SESSION_SECRET || 'CHANGE_ME_DEV_ONLY_SESSION_SECRET',

  // PlopPlop is the underlying payment provider. Freda Pay holds ONE merchant
  // account with PlopPlop and pools all of its own merchants' funds through it,
  // tracking per-merchant balances internally (see src/services/ledger.js).
  plopplop: {
    baseUrl: process.env.PLOPPLOP_BASE_URL || 'https://plopplop.solutionip.app/',
    clientId: process.env.PLOPPLOP_CLIENT_ID || '',
    clientSecret: process.env.PLOPPLOP_CLIENT_SECRET || '',
  },

  // Supabase (Postgres) is Freda Pay's database. The backend talks to it with
  // the service_role key ONLY (server-side, never in any frontend file) since
  // this key bypasses Row Level Security entirely.
  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },

  // Maplerad is the card issuing provider (virtual Visa/Mastercard, business
  // cards). Like PlopPlop, Freda Pay holds ONE Maplerad account and issues
  // cards on behalf of all Freda Pay merchants, tracked internally.
  // Maplerad uses the SAME base URL for sandbox and live: the API key alone
  // decides which environment a request hits. So each platform mode gets its
  // own key set. Sandbox keys stay in the original variables (unchanged);
  // live keys live in MAPLERAD_LIVE_* and are NEVER used unless a request is
  // explicitly in live mode.
  maplerad: {
    baseUrl: process.env.MAPLERAD_BASE_URL || 'https://api.maplerad.com/v1',
    secretKey: clean(process.env.MAPLERAD_SECRET_KEY),
    webhookSecret: clean(process.env.MAPLERAD_WEBHOOK_SECRET),
    liveSecretKey: clean(process.env.MAPLERAD_LIVE_SECRET_KEY),
    livePublicKey: clean(process.env.MAPLERAD_LIVE_PUBLIC_KEY), // not used for server-to-server calls; kept for client-side SDKs
    liveWebhookSecret: clean(process.env.MAPLERAD_LIVE_WEBHOOK_SECRET),
    // Optional static-IP proxy (http://user:pass@host:port). The partner only accepts calls from a fixed IP address; when
    // the hosting plan cannot give one, route the calls to the partner through a static-IP proxy service. Never logged.
    proxyUrl: clean(process.env.MAPLERAD_PROXY_URL),
  },

  // Self-ping keep-alive: free hosting tiers (e.g. Render's free plan) spin
  // the server down after ~15 minutes of no incoming traffic. If a URL is
  // configured, the backend pings its own /health endpoint every 10 minutes
  // so it never goes to sleep. RENDER_EXTERNAL_URL is set automatically by
  // Render itself - no manual config needed once deployed there.
  selfPing: {
    url: process.env.SELF_PING_URL || process.env.RENDER_EXTERNAL_URL || '',
  },

  // Public site URL (no trailing slash) - used to build absolute asset URLs
  // for things external services must fetch themselves (email logo images,
  // og:image, JSON-LD). Update this once the site is deployed to its real domain.
  // Freda Pay LLC is a US company: comprehensively sanctioned jurisdictions cannot be served (ISO country codes).
  restrictedCountries: ['CU', 'IR', 'KP', 'SY'],
  // The PUBLIC WEBSITE (landing, signup, dashboard...), where every link in an email must land. NOT the API.
  defaultSiteUrl: 'https://issuing.fredapay.com',
  siteUrl: (process.env.SITE_URL || 'https://issuing.fredapay.com').trim().replace(/\/+$/, ''),
  // This backend's own public address (serves the email/blog logo, the sitemap...).
  apiUrl: (process.env.API_URL || 'https://api.fredapay.com').trim().replace(/\/+$/, ''),
  // Where the admin panel is hosted (it is NOT on the public site). Optional: invitations also read it from the panel itself.
  adminUrl: (process.env.ADMIN_URL || '').trim().replace(/\/+$/, ''),
  // Emails need a small PNG on a public HTTPS URL. Override with EMAIL_LOGO_URL if the site lives elsewhere.
  // Services that answer "what public IP is calling you?". First that works wins; overridable for tests / restricted networks.
  egressIpUrls: (process.env.EGRESS_IP_URLS || 'https://api.ipify.org?format=json,https://api64.ipify.org?format=json,https://ifconfig.me/ip').split(',').map((u) => u.trim()).filter(Boolean),
  // The logo in emails and in the blog is served by THIS backend: it never depends on the website being deployed or SITE_URL being right.
  emailLogoUrl: (process.env.EMAIL_LOGO_URL || `${(process.env.API_URL || 'https://api.fredapay.com').trim().replace(/\/+$/, '')}/assets/logo-email.png`).trim(),

  // Brevo (transactional email) - sends the OTP verification code at signup
  // and account/balance notifications. See src/services/brevo.js.
  brevo: {
    baseUrl: process.env.BREVO_BASE_URL || 'https://api.brevo.com',
    apiKey: process.env.BREVO_API_KEY || '',
    senderEmail: process.env.BREVO_SENDER_EMAIL || 'otp.issuing@fredapay.com',
    senderName: process.env.BREVO_SENDER_NAME || 'Freda Pay Issuing',
    // Address used for messages written by the admin team (must be a validated sender in Brevo).
    adminSenderEmail: process.env.BREVO_ADMIN_SENDER_EMAIL || 'administration@fredapay.com',
    adminSenderName: process.env.BREVO_ADMIN_SENDER_NAME || 'Freda Pay',
    // Inbound email (replies from merchants): Brevo Inbound Parsing posts to /webhooks/inbound-email?token=...
    inboundSecret: process.env.INBOUND_EMAIL_SECRET || '',
    // Address that receives replies in Brevo's inbound domain (e.g. inbox@inbound.fredapay.com). Falls back to the sender address.
    inboundReplyAddress: process.env.INBOUND_REPLY_ADDRESS || '',
  },

  // Email OTP verification, required before a new account can log in.
  otp: {
    codeLength: 6,
    expiryMinutes: 10,
    maxAttempts: 5,
    resendCooldownSeconds: 60,
  },

  // HTG <-> USD conversion used throughout (Master Wallet top-ups, converting
  // the HTG-denominated Gateway plan fee to a USD Master Wallet debit, etc).
  exchangeRateHtgPerUsd: 133,

  // ---- Freda Pay's published pricing (see the "Tarifs" section of the landing page, index.html) ----
  // Two independent plan tracks: a merchant picks ONE Gateway plan (payment
  // acceptance, priced in HTG) and, separately, ONE Issuing plan (card
  // issuance, priced in USD). Every new merchant defaults to the free tier of
  // each until they explicitly upgrade.

  // Gateway (payment acceptance: MonCash, Natcash, carte). Every plan's
  // per-transaction fee applies uniformly across all payment methods -
  // Freda Pay no longer prices moncash/natcash/carte differently.
  gatewayPlans: {
    free: {
      label: 'Offert', monthlyFeeHTG: 0, pct: 0, fixedHTG: 0,
      payoutDelay: '48-72h', volumeLimitHTG: null, grantedOnly: true, // never self-serve - admin grants it per merchant
    },
    standard: {
      label: 'Standard', monthlyFeeHTG: 0, pct: 0.06, fixedHTG: 10,
      payoutDelay: '48-72h', volumeLimitHTG: 150000,
    },
    pro: {
      label: 'Pro', monthlyFeeHTG: 1000, pct: 0.042, fixedHTG: 10,
      payoutDelay: '24h', volumeLimitHTG: 1500000,
    },
    business: {
      label: 'Business', monthlyFeeHTG: 5000, pct: 0.04, fixedHTG: 10,
      payoutDelay: 'instant', volumeLimitHTG: null,
    },
  },

  // Issuing (virtual card issuance: Visa/Mastercard). Card creation, card
  // recharge (fund) and card withdrawal are FLAT per-operation fees (not a
  // percentage), on top of whatever amount is being moved. Master Wallet
  // funding (topping up the Master Wallet itself via MonCash/Natcash) is
  // priced as a percentage that varies by Issuing plan.
  // Our own cost from the card-issuing provider (COGS), confirmed amounts -
  // NOT what we charge merchants (see issuingPlans above for that). The gap
  // between issuingPlans prices (or a merchant's custom override) and these
  // costs is our actual profit per transaction.
  // What the PAYMENT partner (Pay'm PlopPlop) charges Freda Pay on every MonCash/Natcash amount it collects: 4 % of the
  // amount (confirmed by the founder). It applies to Gateway payments AND to Master Wallet top-ups paid by MonCash/Natcash.
  // Override on the host if the rate changes:  GATEWAY_PARTNER_COST_PCT=4   GATEWAY_PARTNER_COST_FIXED_HTG=0
  gatewayProviderCost: {
    pct: Number(process.env.GATEWAY_PARTNER_COST_PCT != null && process.env.GATEWAY_PARTNER_COST_PCT !== '' ? process.env.GATEWAY_PARTNER_COST_PCT : 4),
    fixedHTG: Number(process.env.GATEWAY_PARTNER_COST_FIXED_HTG || 0),
    configured: true,
  },
  // Monthly plan renewal (Live plans only): a renewal that cannot be paid is retried every hour for `graceDays` days
  // (the merchant is warned once), then the account goes back to the entry plan (Gateway: Standard, Issuing: Startup).
  billing: { graceDays: 3, checkEveryMs: 60 * 60 * 1000 },
  // What the merchant pays to WITHDRAW from the Gateway balance (can be overridden per merchant by an admin):
  //   MonCash / Natcash: 5 % of the amount        Bank transfer: a fixed 100 HTG (processed by hand by the team)
  payoutFees: {
    mobilePct: 0.05,
    bankFixedHTG: 100,
    bankMinHTG: 1000, // below this the fixed fee would eat the withdrawal
  },
  issuingProviderCostsUSD: {
    cardCreation: 1.50,
    cardRecharge: 1.00,
    cardWithdrawal: 1.00,
    walletFundingPct: 0.02,
  },

  issuingPlans: {
    free: {
      label: 'Offert', monthlyFeeUSD: 0, cardCreationUSD: 0,
      rechargeUSD: 0, withdrawalUSD: 0, declineUSD: 0, walletFundingPct: 0,
      cardLimit: 200, grantedOnly: true, // never self-serve - admin grants it per merchant
    },
    startup: {
      label: 'Startup', monthlyFeeUSD: 0, cardCreationUSD: 5.00,
      rechargeUSD: 1.60, withdrawalUSD: 1.30, declineUSD: 1.00, walletFundingPct: 0.045,
      cardLimit: 200,
    },
    pro: {
      label: 'Pro', monthlyFeeUSD: 150, cardCreationUSD: 3.50,
      rechargeUSD: 1.25, withdrawalUSD: 1.15, declineUSD: 1.00, walletFundingPct: 0.03,
      cardLimit: 7000,
    },
    premium: {
      label: 'Premium', monthlyFeeUSD: 500, cardCreationUSD: 2.50,
      rechargeUSD: 1.10, withdrawalUSD: 1.10, declineUSD: 1.00, walletFundingPct: 0.025,
      cardLimit: null,
    },
  },

  // Master Wallet must always keep at least this much USD as a reserve - no
  // debit (card creation/funding, plan billing, etc.) may bring the balance
  // below it. A low-balance email is sent the first time a debit brings the
  // balance down to this floor.
  masterWallet: {
    minimumBalanceUsd: parseFloat(process.env.MASTER_WALLET_MINIMUM_USD || '50'),
  },

  // Every new account starts in sandbox mode (live_enabled = false). To let
  // merchants freely test billing, card issuance, etc. without first having
  // to fund a real top-up, we seed a generous fake Master Wallet balance at
  // registration. This is sandbox play money - it has no bearing on the real
  // pooled Maplerad/PlopPlop balances once the account goes live.
  sandbox: {
    masterWalletSeedUsd: parseFloat(process.env.SANDBOX_MASTER_WALLET_SEED_USD || '5000'),
  },

  // PlopPlop enforces a 120s cooldown between withdrawals PER IP. Since all
  // Freda merchants share one outbound IP (our server), payouts are queued
  // and processed one at a time with this minimum gap.
  payoutCooldownMs: parseInt(process.env.PAYOUT_COOLDOWN_MS || '120000', 10),
};

module.exports = config;

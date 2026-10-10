# Freda Pay Issuing: Backend

Backend pou Freda Pay Issuing: otantifikasyon marchand, jesyon kle API, ak yon API
senplifye (`/v1/*`) ke ou bay ou pwòp itilizatè yo, ki vlope founisè peman **PlopPlop**
(MonCash, Natcash, kat) anba kapòt la. Baz done a se **Supabase (Postgres)**.

Zewo depandans npm: tout bagay ekri ak modil entegre Node.js sèlman (`http`, `crypto`,
`fetch`). Backend la pale ak Supabase atravè API REST li (PostgREST), pa `pg`/SDK.

## ⚠️ Sekirite: enpòtan anvan ou fè anyen ak zip sa a

Fichye `.env` ki nan livrezon sa a **deja gen** `SUPABASE_SERVICE_ROLE_KEY` ou te ban
mwen an. Kle sa a bay **aksè total** (li bypass Row Level Security). Règ yo:

- **Pa janm** mete `.env` la nan Git/GitHub piblik. Li gen kounye a **kle Maplerad LIVE yo** (`MAPLERAD_LIVE_*`): vrè lajan.
  Sou Render, mete menm varyab yo nan *Environment*; pa depann de fichye `.env` la.
- **Pa janm** sèvi ak `service_role` la nan yon fichye frontend/browser (`freda-pay-*.html`).
  Se sèlman backend la (sèvè) ki dwe konnen li.
- Si w gen dout kle a ka gaye (pa egzanp si w te kopye-kole l yon lòt kote), **rejenere l**
  nan Supabase Dashboard → Project Settings → API → "Reset service_role key".

## Achitekti

```
Merchant yo (biznis ki enskri sou signup.html)
        │  sk_test_xxx / sk_live_xxx
        ▼
  Freda Pay Backend  ──────────────►  PlopPlop (UN sèl kont marchand)
        │                              MonCash · Natcash · Cartes
        ▼
   Supabase (Postgres)
   merchants, api_keys, ledger_entries, payments, payouts
```

Tout lajan pase pa **YON SÈL** kont PlopPlop (kont Freda Pay a). Backend la kenbe yon
**ledger entèn nan Supabase** (`ledger_entries`) ki swiv konbyen chak marchand Freda Pay
genyen, menm jan Stripe Connect oswa lòt platfòm "embedded finance" fonksyone. Balans
"Solde Gateway" ak "Master Wallet" nan dashboard la soti dirèkteman nan ledger sa a
(fonksyon Postgres `get_balance()`, gade `supabase-schema.sql`).

### Poukisa referans yo "namespaced"

PlopPlop mande pou `refference_id` (peman) ak `reference` (retrè) inik **atravè tout
kont PlopPlop la**. Depi tout marchand Freda Pay pataje YON sèl kont PlopPlop, backend
la otomatikman prefikse chak referans marchand yo bay ak `fp_{merchantId}_...` anvan
li voye l bay PlopPlop: konsa de marchand ka itilize menm referans pa yo (`"CMD-001"`)
san yo pa antre an konfli. (`src/utils/ids.js#namespaceReference`)

### Payout queue (cooldown 120s)

Dokiman PlopPlop la di gen yon **cooldown 120s pa adrès IP** ant chak retrè. Depi tout
marchand Freda Pay yo pral rele PlopPlop soti nan MENM sèvè a (menm IP), backend la
mete tout demand payout yo nan yon **file datant** (`src/services/payoutOrchestrator.js`)
ki trete yo YOUN pa YOUN, respekte 120s la. Se poutèt sa `POST /v1/payouts` retounen
`202 Accepted` (pa `200`) imedyatman ak estati `pending`: kliyan an dwe `GET
/v1/payouts/:id` apre pou wè si li `success` oswa `failed`.

## Enstale ak lanse

**Etap 1: kreye tab yo nan Supabase (yon sèl fwa) :**
Louvri Supabase Dashboard → SQL Editor → New query → kole tout kontni
`supabase-schema.sql` → Run.

**Etap 2: konfigire `.env` :**
`.env` la deja ranpli ak `SUPABASE_URL` ak `SUPABASE_SERVICE_ROLE_KEY` ou te ban mwen
an. Ou dwe ajoute `PLOPPLOP_CLIENT_ID` ak `PLOPPLOP_CLIENT_SECRET` lè w gen yo.

**Etap 3: lanse :**
```bash
cd freda-backend
node src/server.js
# → Freda Pay backend listening on http://localhost:4000
```

Pa gen `npm install` obligatwa (zewo depandans). `npm run dev` pou otoreload pandan devlopman.

## Teste

```bash
npm test
```

31 tès (inite + entegrasyon konplè) ki kouri kont **de sèvè simile lokal** :
`mock/plopplop-mock-server.js` (simile PlopPlop) ak `mock/supabase-mock-server.js`
(simile API REST Supabase/PostgREST): yo verifye siyati HMAC, ekspirasyon jeton, kredi/
debi ledger, idanpotans, echèk payout ki PA dwe debite balans lan, elatriye. Pa gen
okenn apèl reyèl ki soti sou entènèt pandan tès yo: mwen pa gen aksè entènèt nan
anviwònman kote m ap ekri kòd la, se poutèt sa m pa t ka teste kont *vrè* pwojè
Supabase w la dirèkteman, men chemen REST yo swiv dokimantasyon PostgREST la egzakteman.

## Referans API

### Otantifikasyon dashboard (pou paj login/signup)

| Metòd | Chemen | Deskripsyon |
|---|---|---|
| POST | `/auth/register` | Kreye yon kont marchand. Retounen `session_token`. |
| POST | `/auth/login` | Konekte. Retounen `session_token`. |
| GET | `/auth/me` | Enfo kont lan (`Authorization: Bearer <session_token>`). |

### Jesyon kle API (otantifye ak session_token)

| Metòd | Chemen | Deskripsyon |
|---|---|---|
| POST | `/dashboard/api-keys` | Kreye yon kle (`{ "mode": "test" \| "live" }`). Sekrè a montre **yon sèl fwa**. |
| GET | `/dashboard/api-keys` | Lis kle yo (san sekrè yo). |
| DELETE | `/dashboard/api-keys/:id` | Revoke yon kle. |
| GET | `/dashboard/balance` | Balans Gateway + Master Wallet. |

### API pou marchand yo (`Authorization: Bearer sk_test_xxx`)

**Aksepte yon peman**
```
POST /v1/payments
{ "amount": 1500, "currency": "HTG", "method": "moncash", "reference": "CMD-001" }

→ 201 { "id": "pay_...", "status": "pending", "checkout_url": "...", ... }
```
`method` ka: `moncash`, `moncash_ussd` (mande `phone`), `natcash`, `carte`, `all`.

**Verifye/rafrechi yon peman**
```
GET /v1/payments/:id
→ { "status": "succeeded", "fee": 55, "net_amount": 945, ... }
```
Premye fwa li konfime, backend la kredite otomatikman Solde Gateway marchand lan
(apre frè Freda Pay yo dedwi: 5%+5 HTG pou MonCash/Natcash, 3.5%+0.30$ pou kat).

**Fè yon retrè (payout)**
```
POST /v1/payouts
{ "amount": 500, "method": "natcash", "recipient": "50912345678", "reference": "WD-001" }

→ 202 { "id": "po_...", "status": "pending" }
```
Verifye balans disponib anvan; si pa ase, `400 INSUFFICIENT_BALANCE`.

**Verifye yon retrè**
```
GET /v1/payouts/:id
→ { "status": "success" | "failed" | "pending", "fee": ..., "failure_reason": ... }
```

**Balans**
```
GET /v1/balance
→ { "gateway": { "available": 945, "currency": "HTG" }, "master_wallet": {...} }
```

Tout endpoint yo retounen erè nan fòma `{ "error": { "code": "...", "message": "..." } }`.

### Kat (Issuing, atravè Maplerad): `Authorization: Bearer <session_token>`

Menm modèl ak PlopPlop la: **YON SÈL** kont Maplerad pou tout marchand Freda Pay,
ak yon ledger entèn (`Master Wallet`) ki swiv konbyen chak marchand genyen.

**Etap 1: Konplete pwofil moun k ap detni kat la** (yon sèl fwa pa kont) :
```
POST /dashboard/cards/holder-profile
{ "firstName": "Rose", "lastName": "Lakay", "email": "...", "country": "HT",
  "dob": "1990-05-12", "identificationNumber": "...", "phoneNumber": "37001234",
  "phoneShortCode": "+509", "address": { "city": "Port-au-Prince", "country": "HT" } }
```
Sa a anrejistre marchand lan kòm yon "kliyan" Maplerad (`POST /customers/enroll`).

**Etap 2: Kreye yon kat** (endividyèl oswa biznis) :
```
POST /dashboard/cards
{ "reference": "CARD-001", "brand": "VISA", "amount": 20 }   // endividyèl
{ "reference": "CARD-002", "kind": "business", "business_name": "Boutik Rose SA",
  "brand": "MASTERCARD", "amount": 30 }                       // biznis

→ 202 { "id": "card_...", "status": "pending" }
```
`amount` an **dola (USD)**, dedwi imedyatman nan Master Wallet la. Kreyasyon kat la
**asenkwòn**: Maplerad konfime rezilta a pa yon **webhook** (`POST /webhooks/maplerad`,
verifye ak siyati HMAC), pa yon repons imedya. Poll `GET /dashboard/cards/:id` jiskaske
estati a chanje soti nan `pending` a `active` oswa `failed`. Si li echwe, Master Wallet la
ranbouse otomatikman.

**Jere yon kat :**
```
POST /dashboard/cards/:id/fund      { "amount": 10 }
POST /dashboard/cards/:id/withdraw  { "amount": 5 }
POST /dashboard/cards/:id/freeze
POST /dashboard/cards/:id/unfreeze
POST /dashboard/cards/:id/terminate  // ranbouse balans ki rete a nan Master Wallet
GET  /dashboard/cards               // lis tout kat yo
GET  /dashboard/cards/:id
```

⚠️ **Konfigirasyon webhook obligatwa** : nan Maplerad Dashboard, mete
`https://VOTRE-BACKEND-DEPLOYE/webhooks/maplerad` kòm URL webhook, epi kopye
"Signing Secret" la (`whsec_...`) nan `MAPLERAD_WEBHOOK_SECRET`. San sa, kreyasyon
kat yo ap rete "pending" pou tout tan paske konfimasyon an pa janm rive.

## Maplerad Live (vrè kat, vrè lajan)

Maplerad itilize **menm URL** (`https://api.maplerad.com/v1`) pou sandbox ak live: se **kle a** ki detèmine anviwònman an.
Kidonk platfòm lan gen de seri kle, e li chwazi youn selon **mòd** demann lan (sandbox oswa live):

| Variab anviwònman | Itilize pou |
|---|---|
| `MAPLERAD_SECRET_KEY`, `MAPLERAD_WEBHOOK_SECRET` | Sandbox (kle tès, `mpr_sandbox_...`) |
| `MAPLERAD_LIVE_SECRET_KEY`, `MAPLERAD_LIVE_WEBHOOK_SECRET`, `MAPLERAD_LIVE_PUBLIC_KEY` | Live (`mpr_sk_...`, `mpr_pk_...`) |

Garanti ki nan kòd la:
- Kle live pa janm itilize pou yon demann sandbox, e kle sandbox pa janm itilize pou live. Si kle live a manke, demann lan echwe ak yon erè klè (li pa tonbe sou sandbox an silans).
- Yon kle ki sanble ak move anviwònman (`mpr_sk_` nan `MAPLERAD_SECRET_KEY`, oswa `mpr_sandbox_` nan `MAPLERAD_LIVE_SECRET_KEY`) rejte.
- Lajan **live ak sandbox separe nèt**: balans live yo nan wallet `live:master_wallet` / `live:gateway`. Lajan tès pa ka janm finanse yon vrè kat.
- Titilè kat (holders), kat, peman, retrè, rechajman ak frè yo make ak mòd yo. Yon kat/titilè sandbox pa ka sèvi nan live.
- Webhook: `POST /webhooks/maplerad` verifye siyati a ak sekrè sandbox la, apresa sekrè live la. Sekrè ki valide a se sa ki di ki anviwònman ki voye evènman an, e yon evènman sandbox pa ka touche yon kat live (ni envèsman).
- Anvan l kreye yon kat live, backend la tcheke kle live la ak sekrè webhook live la: si youn manke, li refize **anvan** li debite lajan.
- Lòg live yo pa kenbe done pèsonèl kliyan (sèlman estati, id, referans).

### Si Maplerad Live refize (HTTP 401 « Access Denied »)
Ale nan **Admin > Paramètres > Diagnostic Maplerad** (wout `GET /admin/diagnostic/maplerad`, sèlman owner/admin). Li montre IP sòti sèvè a (3 echantiyon, pou wè si gen plizyè), fòma kle Live ak Sandbox (8 premye karaktè sèlman, rès la maske), si sekrè webhook yo la, ak estati konfigirasyon an. Bouton **Tester Live / Sandbox** (`?probe=live`) fè yon sèl demann lekti bay Maplerad epi montre repons li. `EGRESS_IP_URLS` chanje sèvis ki bay IP a si sa nesesè.
Kòz posib (pou konfime ak sipò Maplerad, yo pa verifye isit la): aksè Live/Issuing poko aktive sou kont Maplerad ou; Maplerad pa aksepte IP sèvè a (mande yo pou yo otorize IP sòti a ak IP Outbound Render yo); kle a pa bon. Voye rezilta dyagnostik la bay Maplerad.


### Maplerad exige une IP fixe (401 « Access Denied »)
Maplerad n'accepte les appels que depuis une adresse IP déclarée dans son dashboard (liste d'adresses autorisées). Sur Render, un service sort par une plage d'adresses **partagée** : n'importe quelle adresse de la plage peut servir, donc ce n'est pas une IP fixe. Trois façons de faire :
1. **Render « Dedicated IPs »** (payant) : 3 adresses fixes pour la région du service ; ajoutez-les **toutes** dans Maplerad.
2. **Proxy à IP fixe** (ex. QuotaGuard, mentionné dans la documentation de Render) : mettez son URL dans `MAPLERAD_PROXY_URL=http://utilisateur:motdepasse@hote:port`. Seuls les appels vers Maplerad passent par lui ; Maplerad voit l'IP du proxy.
3. Héberger le backend sur un serveur avec une IP fixe.

Pour voir l'adresse que Maplerad voit (l'équivalent de `curl ifconfig.me` exécuté depuis le serveur) : **Admin > Paramètres > Diagnostic Maplerad**. Après avoir ajouté l'adresse dans Maplerad, cliquez « Tester Live » : il doit répondre « Accepté ».

### Imèl: logo ak lyen
Imèl yo konstwi lyen yo ak `SITE_URL` (sit piblik la, pa API a): `SITE_URL=https://issuing.fredapay.com`. Logo a se `SITE_URL/logo-email.png` (fichye a nan frontend lan, depoze l ansanm). Ou ka chanje l ak `EMAIL_LOGO_URL`. Si `SITE_URL` pa bon, sèvè a ekri yon AVÈTISMAN nan lòg la lè li demare.


## Adrès piblik yo (enpòtan: yon move valè kraze imèl yo)
| Varyab | Valè | Sèvi pou |
|---|---|---|
| `SITE_URL` | `https://issuing.fredapay.com` (sit piblik la, **pa** API a, **pa** `fredapay.com`) | tout bouton nan imèl yo, lyen blog la |
| `API_URL` | `https://api.fredapay.com` | logo imèl/blog (sèvi pa backend lan), sitemap |
| `ADMIN_URL` | adrès panèl admin lan (opsyonèl) | envitasyon admin (sinon li pran adrès kote admin an ye a) |

Sèvè a **verifye** `SITE_URL` lè li demare: si sit la pa sèvi logo a men sit ofisyèl la sèvi l, li itilize sit ofisyèl la epi li ekri yon AVÈTISMAN. Admin > Paramètres > "Diagnostic e-mails et liens" montre sa ki an itilizasyon, tcheke chak lyen (404?), epi voye w yon imèl tès.

## Sitemap otomatik
`GET /sitemap.xml` jenere soti nan `src/services/sitemapPages.js` (paj yo) + atik blog ki **pibliye** yo. Netlify voye `/sitemap.xml` sou li (`_redirects`). Lè w kreye yon nouvo paj sou sit la, ajoute l nan `sitemapPages.js` (se sèl kote).

## Retrè (Gateway)
- **MonCash / Natcash:** frè Freda Pay = **5 %** sou montan an, ajoute sou li (`payoutFees.mobilePct`). **Virement bancaire:** **100 HTG fiks**, minimòm 1 000 HTG (`payoutFees.bankFixedHTG`, `bankMinHTG`). Admin ka chanje yo pa machann (`payout_mobile_pct`, `payout_bank_fee_htg`).
- Montan + frè **kenbe** (hold) sou balans lan lè demann lan aksepte; si retrè a echwe oswa admin refize l, tout rimèt (montan + frè). De demann ki rive an menm tan pa ka depanse menm lajan an.
- **Virement bancaire:** machann nan anrejistre kont bank li (Retraits > "Ajouter mon compte", yon imèl alèt voye chak fwa li chanje). Demann lan ale dirèk nan **Admin > Retraits bancaires** ak tout enfòmasyon bank la (kopi jan yo te ye lè demann lan fèt). Ou voye virement lan nan bank ou, epi ou make "Virement envoyé" ak referans lan (machann nan resevwa yon imèl) oswa "Refuser" ak yon rezon. Sèlman nan dashboard, pa nan API. Nan Sandbox li fini touswit, san vrè virement.
- **Frè PlopPlop 4 % sou rechaj wallet pa MonCash/Natcash** peye pa moun k ap rechaje a (ajoute sou frè Freda Pay), kidonk li pa yon koût pou nou.

## Chif admin
Revni = frè Freda Pay reyèlman ankese. Pwofi = revni - frè patnè (kreyasyon kat 1,50 $, rechajman 1,00 $, retrè kat 1,00 $, finansman wallet 2 % sou depo). Koût PlopPlop: 4 % sou chak montan li ankese (peman Gateway **ak** recharj MonCash/Natcash nan wallet), konfime pa fondatè a. Ou ka chanje l ak `GATEWAY_PARTNER_COST_PCT` / `GATEWAY_PARTNER_COST_FIXED_HTG`. Achte an liy ak kat yo soti nan notifikasyon `issuing.transaction` Maplerad la (tab `card_transactions`), depi lè yo kòmanse rive.

### Pou ale an Live
1. Mete `MAPLERAD_LIVE_SECRET_KEY` ak `MAPLERAD_LIVE_PUBLIC_KEY` nan anviwònman Render la.
2. Nan dashboard Maplerad (anviwònman **Live**), anrejistre webhook `https://api.fredapay.com/webhooks/maplerad`. Maplerad ba ou yon `whsec_...`: mete l nan `MAPLERAD_LIVE_WEBHOOK_SECRET`. (Se Maplerad ki jenere l; ou pa kreye l ou menm.)
3. Finanse wallet Maplerad Live ou a (se li ki peye vrè kat yo).
4. Machann nan: KYC/KYB apwouve -> Gateway Live -> demann Issuing Live apwouve nan admin -> admin kredite Master Wallet **Live** li (sou bon konfimasyon depo a).
5. Teste ak yon sèl kat ak yon ti montan anvan ou louvri pou tout moun.

## Sekirite: pwen enpòtan

- `PLOPPLOP_CLIENT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` ak `SESSION_SECRET` **pa dwe
  janm** parèt nan kòd la ni nan Git: yo rete nan `.env` sèlman (fichye sa a deja nan
  `.gitignore` pa defo). `SUPABASE_SERVICE_ROLE_KEY` an patikilye bypass tout Row Level
  Security: li pa dwe janm parèt nan yon fichye frontend.
- Sekrè kle API yo (`sk_test_.../sk_live_...`) estoke kòm **SHA-256 hash** sèlman nan
  baz done a: si baz done a vòlè, sekrè yo pa ka rekipere.
- Modpas yo estoke ak `scrypt` (built-in Node), pa `bcrypt` (pou evite yon depandans
  externe), ak yon sèl (`salt`) diferan pou chak itilizatè.
- Mode `live` bloke pou yon kle API si `live_enabled` pa `true` sou kont marchand lan
  (sa vle di KYC/KYB dwe apwouve avan).
- `MAPLERAD_SECRET_KEY` menm jan an: pa dwe janm nan yon fichye frontend.
  `MAPLERAD_WEBHOOK_SECRET` pwoteje `/webhooks/maplerad` : nenpòt moun ka rele URL
  sa a (li piblik san API key), men san bon siyati a, backend la rejte l ak `401`.

## Sa ki toujou sou papye (pwochèn etap)

- **Webhooks pou marchand yo**: kounye a marchand yo dwe *poll* (`GET /v1/payments/:id`)
  pou konnen si yon peman konfime, paske PlopPlop li menm pa voye webhook (dapre
  dokiman an). Ta ka ajoute yon job ki poll PlopPlop chak X segond epi voye yon POST
  bay yon `webhook_url` marchand lan konfigire.
- **Deplwaman KYC/KYB → `live_enabled`**: kounye a `live_enabled` rete `false` pou
  tout moun; li ta dwe vin `true` otomatikman (oswa manyèlman pa yon admin) lè
  verifikasyon konfòmite a fini.
- **Tranzaksyon kat an dirèk** (`issuing.transaction`, `issuing.charge`, elatriye) :
  webhook Maplerad yo deja anrejistre nan tab `webhook_events` pou dibogaj, men balans
  kat yo poko ajiste otomatikman lè yon kliyan itilize kat la nan yon magazen (sèlman
  fund/withdraw manyèl yo swiv kounye a).
- **Tier 2 KYC pou kliyan kat yo** (pyès idantite + foto): `submitHolderProfile`
  sèlman voye Tier 0+1 (san dokiman idantite), ki ka sifi pou kat tès men gen chans
  Maplerad mande Tier 2 pou kèk aksyon an mòd Live.

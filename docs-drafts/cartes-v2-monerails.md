# Cartes virtuelles : documentation v2 (émetteur Monerails) — BROUILLON

> **Brouillon interne, pas encore publié.** Il décrit l'API Freda Pay Issuing telle qu'elle sera quand les nouvelles cartes
> passeront par Monerails. Aujourd'hui, Monerails n'est branché qu'en **sandbox, dans le panneau admin** : l'API des marchands
> (`/v1/cards`) utilise toujours l'émetteur actuel. Les paramètres marqués **(nouveau)** n'existent pas encore dans l'API :
> ne publier cette page qu'une fois ces points codés et testés (voir « À faire avant publication » en bas).

---

## 1. Ce qui change pour vous

| Sujet | Avant | Avec les nouvelles cartes |
|---|---|---|
| Pièce d'identité du titulaire | une photo | **recto + verso** (le verso n'est pas demandé pour un passeport) |
| Âge du titulaire | — | **18 ans minimum** |
| Plafond de dépense | aucun réglage | **vous fixez le plafond** de chaque carte : par jour ou par achat (nouveau) |
| Carte à usage unique | — | possible (nouveau) |
| Résilier une carte | à tout moment | **pas le jour de sa création** : gelez-la, résiliez-la le lendemain |
| Voir le numéro complet / CVV | sans limite | 30 fois par heure et par carte |
| Apple Pay / Google Pay | — | voir section 6 |
| Noms des webhooks, des statuts, des champs | — | **inchangés** |

Rien ne change pour vos cartes déjà créées : elles continuent de fonctionner comme aujourd'hui.

---

## 2. Le titulaire de la carte

`POST /v1/cards/holder-profile` (inchangé), avec ces règles :

- **Majeur** : 18 ans ou plus le jour de la demande.
- **Nom, prénom et date de naissance identiques à la pièce d'identité**, sinon la vérification est refusée.
- **Email unique** : un même email ne peut servir qu'à un seul titulaire sur votre compte.
- **Pays non acceptés** : Cuba (CU), Iran (IR), Corée du Nord (KP), Syrie (SY), Russie (RU), Biélorussie (BY).
- **Pièces acceptées** : `PASSPORT`, `NIN` (carte d'identité nationale), `DRIVERS_LICENSE`, `VOTERS_CARD`.
- **Photos** : JPEG ou PNG, 4 Mo maximum, au moins 600 × 400 px, nettes, non coupées, pièce non expirée.

| Champ | Type | Obligatoire | Description |
|---|---|---|---|
| `identity.imageUrl` | string | Oui | Recto de la pièce (Base64 `data:image/...;base64,` ou lien https) |
| `identity.imageBackUrl` **(nouveau)** | string | Oui, sauf passeport | Verso de la pièce |
| `address.street`, `address.city`, `address.state` | string | Oui | Adresse du titulaire |

La vérification se fait en quelques minutes. Le résultat arrive :
- dans `GET /v1/cards/holders/{id}` (`status` : `pending` → `enrolled` ou `failed`, avec `failure_reason`) ;
- par webhook.

Une vérification refusée peut être relancée avec de nouvelles photos (`restart_verification: true`), **5 fois au maximum par 24 h**.

---

## 3. Créer une carte

`POST /v1/cards` — paramètres existants, plus :

| Champ | Type | Obligatoire | Description |
|---|---|---|---|
| `spending_limit` **(nouveau)** | object | Non | Le plafond de dépense que **vous** fixez pour cette carte |
| `spending_limit.amount` | number | Oui si `spending_limit` | Montant maximum en dollars |
| `spending_limit.interval` | string | Oui si `spending_limit` | `daily` (par jour) ou `per_transaction` (par achat) |
| `single_use` **(nouveau)** | boolean | Non | Carte valable pour **un seul achat**. Elle ne se recharge pas, ne se retire pas, n'accepte pas de plafond, et se ferme seule 30 jours après si elle n'a pas servi (le solde vous revient). |

**C'est vous, le marchand, qui décidez du plafond.** Freda Pay Issuing n'en impose pas en plus de celui de l'émetteur :
fixez-le selon l'usage de la carte (abonnement, achats d'un employé, carte client...). Sans `spending_limit`, la carte
peut dépenser tout son solde.

```json
POST /v1/cards
{
  "reference": "EMP-0042",
  "kind": "individual",
  "holder_id": "mpc_1a2b3c4d5e6f7a8b",
  "brand": "VISA",
  "amount": 50,
  "spending_limit": { "amount": 20, "interval": "daily" }
}
```

**Montant minimum** : les frais de création + 1 $ (erreur `BELOW_MINIMUM_BALANCE`).

**Création asynchrone** : la réponse est `202` avec `status: "pending"`. Le résultat arrive par webhook
`card.created` (carte active) ou `card.failed` (avec `failure_reason`). Vous pouvez aussi lire `GET /v1/cards/{id}`.

---

## 4. Gérer une carte

| Action | Route | Règle |
|---|---|---|
| Recharger | `POST /v1/cards/{id}/fund` | gratuit côté émetteur ; vos frais Freda Pay s'appliquent |
| Retirer | `POST /v1/cards/{id}/withdraw` | **1 $ minimum doit rester** sur la carte |
| Geler / dégeler | `POST /v1/cards/{id}/freeze` / `unfreeze` | immédiat |
| Résilier | `POST /v1/cards/{id}/terminate` | **définitif** ; impossible **le jour de la création** (erreur `CARD_TERMINATE_SAME_DAY`, nouveau) : gelez-la puis résiliez-la le lendemain. Le solde revient à votre Master Wallet. |
| Voir numéro / CVV / expiration | `POST /v1/cards/{id}/reveal` | 30 fois par heure et par carte ; **ne jamais stocker ni journaliser** ces données |

**Gel automatique** : après **3 paiements refusés en 24 h**, l'émetteur gèle la carte (webhook `card.frozen`).
Il peut aussi la fermer après des refus répétés pour solde insuffisant (webhook `card.terminated`) : gardez un solde suffisant.

Une opération peut répondre `202` (en cours) : le résultat final arrive par webhook.
Deux opérations en même temps sur la même carte sont refusées (`409 CARD_OPERATION_IN_PROGRESS`, nouveau) : attendez la fin de la première.

---

## 5. Webhooks

Inchangés : `card.created`, `card.failed`, `card.frozen`, `card.unfrozen`, `card.terminated`, `card.transaction`,
`card.funded`, `card.withdrawn`. Même signature `X-Freda-Signature`.

`card.transaction` couvre aussi les remboursements et annulations. Un paiement refusé est envoyé avec le motif
(par exemple solde insuffisant, plafond atteint, carte gelée).

---

## 6. Ajouter la carte à Apple Pay ou Google Pay

La carte est une vraie carte Visa ou Mastercard : le titulaire peut l'ajouter à son téléphone pour payer sans contact
et en ligne. Il lui faut le **numéro complet, la date d'expiration et le CVV** (`POST /v1/cards/{id}/reveal`, à afficher
uniquement au titulaire).

### iPhone (Apple Pay)
1. Ouvrir l'app **Cartes** (Wallet).
2. Toucher **+** puis **Carte de débit ou de crédit**, puis **Continuer**.
3. Choisir **Saisir manuellement** et entrer le nom du titulaire, le numéro, la date d'expiration et le CVV.
4. Accepter les conditions. Si un code de vérification est demandé, suivre les instructions affichées.
5. La carte apparaît dans Cartes : elle s'utilise au terminal sans contact et sur les sites et apps qui affichent Apple Pay.

### Android (Google Pay / Google Wallet)
1. Ouvrir **Google Wallet**.
2. Toucher **Ajouter à Wallet** puis **Carte de paiement**, puis **Nouvelle carte de crédit ou de débit**.
3. Scanner ou saisir le numéro, la date d'expiration, le CVV, puis le nom et l'adresse du titulaire.
4. Accepter les conditions et terminer la vérification si elle est demandée.
5. Pour payer sans contact, Google Wallet doit être l'app de paiement par défaut et le NFC activé.

**Bon à savoir**
- Le **solde et le plafond** de la carte s'appliquent aussi aux paiements Apple Pay / Google Pay.
- Une carte **gelée** est refusée dans Apple Pay / Google Pay ; une carte **résiliée** doit être retirée du téléphone.
- Si l'ajout est refusé par Apple ou Google, vérifiez que le nom saisi est exactement celui du titulaire, puis réessayez ;
  sinon contactez-nous à issuing@fredapay.com.

---

## 7. Nouvelles erreurs (proposition)

| Code | HTTP | Quand |
|---|---|---|
| `HOLDER_DOCUMENT_BACK_REQUIRED` | 400 | verso de la pièce manquant (sauf passeport) |
| `HOLDER_UNDERAGE` | 400 | titulaire de moins de 18 ans |
| `HOLDER_COUNTRY_UNSUPPORTED` | 400 | pays non accepté |
| `HOLDER_EMAIL_EXISTS` | 409 | email déjà utilisé pour un autre titulaire |
| `HOLDER_VERIFICATION_LIMIT` | 429 | plus de 5 vérifications en 24 h |
| `CARD_MINIMUM_BALANCE` | 400 | un retrait laisserait moins de 1 $ |
| `CARD_TERMINATE_SAME_DAY` | 400 | résiliation le jour de la création |
| `CARD_OPERATION_IN_PROGRESS` | 409 | une autre opération est en cours sur cette carte |
| `CARD_SINGLE_USE` | 400 | recharge ou retrait d'une carte à usage unique |
| `CARD_REVEAL_LIMIT` | 429 | plus de 30 affichages du numéro en 1 heure |

---

## À faire avant publication (interne, à retirer de la page publique)

1. **Coder dans l'API marchands** : `identity.imageBackUrl`, `spending_limit`, `single_use`, les codes d'erreur ci-dessus,
   le choix de l'émetteur par carte (colonne `provider`, défaut l'émetteur actuel) et le webhook Monerails traduit
   vers nos événements.
2. **Confirmer avec Monerails** (questions déjà envoyées) :
   - Apple Pay / Google Pay : leurs cartes sont-elles acceptées (tokenisation), et qui reçoit le code de vérification ?
     Leur documentation n'en parle pas : **ne pas publier la section 6 sans leur confirmation**.
   - 3D Secure pour les achats en ligne.
   - Délai exact avant de pouvoir résilier (24 h ou le lendemain, quel fuseau ?).
   - Grille de frais complète (émission, maintenance, refus, rétrofacturation) pour fixer nos frais.
   - Cartes au nom d'une entreprise (KYB) : notre `kind: business` n'a pas d'équivalent clair.
3. **Recharge du solde Monerails** : uniquement en crypto depuis leur dashboard ; prévoir une alerte « solde bas ».
4. Mettre à jour `openapi.yaml`, les pages `creer-une-carte`, `gerer-une-carte`, `restrictions-cartes`, et la base de
   connaissances de l'agent IA.

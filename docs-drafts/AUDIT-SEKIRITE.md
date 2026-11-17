# Audit de sécurité et de conformité Monerails : 17 novembre 2026

Périmètre : l'intégration Monerails (sandbox + Live éteint), le programme de cartes, les règles de cartes et de titulaires, les clés saisies dans l'admin, l'agent IA et le compositeur d'email admin.
Limite : `docs.monerails.com` n'est pas joignable depuis le serveur de travail ; la conformité a été vérifiée contre le rapport complet de la documentation fourni (22 pages + OpenAPI), pas contre les pages en direct.

## Corrigé dans ce passage
| # | Constat | Gravité | Correction |
|---|---|---|---|
| 1 | Résultat inconnu chez Monerails (délai, erreur 500) : l'opération était considérée comme échouée et le Master Wallet remboursé, alors que Monerails pouvait l'avoir faite (double paiement possible) | Haute | Clé d'idempotence déterministe par opération, 2 nouvelles tentatives avec la MÊME clé, puis `CARD_RESULT_UNKNOWN` (502) sans remboursement automatique + alerte admin |
| 2 | Création de carte sans réponse : carte en échec + remboursement alors qu'elle pouvait exister chez Monerails | Haute | Carte laissée `pending` ; une tâche (toutes les 5 min) la retrouve chez Monerails par son libellé, ou la fait échouer et rembourse après 30 min |
| 3 | Entrée dans le programme : deux requêtes simultanées pouvaient débiter 2 × 20 $ | Moyenne | L'adhésion est réservée d'abord (clé primaire), puis le débit ; échec = adhésion libérée |
| 4 | Email dont le Reply-To diffère du From (expéditeur falsifié) : l'agent aurait pu répondre avec des données du compte à l'adresse du Reply-To | Moyenne | Ce message n'est jamais lié à un compte : l'agent ne répond qu'avec des connaissances publiques |
| 5 | Plan Premium : sans la colonne compteur (migration non exécutée), cartes gratuites illimitées | Moyenne | Sans le compteur, le prix du plan s'applique ; compteur en compare-and-set (pas de double créneau gratuit) |
| 6 | Limite de corps de requête de 40 Mo sur la création de titulaire de l'admin | Basse | 12 Mo (deux photos de 4 Mo en Base64) |
| 7 | Montant envoyé à Monerails sans plafond | Basse | Maximum 10 000 000 cents (100 000 $) comme dans la documentation |
| 8 | Nom, prénom, email envoyés sans respecter les longueurs de Monerails (50, 50, 200) | Basse | Tronqués |
| 9 | Email admin collé depuis un document : titres, listes et tableaux écrasés | Fonctionnel | Reconnaissance des titres, listes, tableaux (tabulations), liens ; aperçu ; ligne « Objet : » et « Bonjour, » gérées |

## Vérifié, rien à corriger
- Webhook Monerails : signature HMAC-SHA256 `t.corps` avec comparaison en temps constant, fenêtre de 5 minutes, deux secrets (test et Live), l'environnement est décidé par le secret qui valide la signature, `livemode` incohérent ignoré, limite de débit, doublons sans effet, 500 en cas d'échec pour déclencher les nouvelles tentatives.
- Clés : test et Live séparées, une clé du mauvais type refusée, jamais renvoyées par l'API (indice de 4 caractères), chiffrées AES-256-GCM, écriture réservée au propriétaire, interrupteur Live refusé tant que clé et webhook Live manquent.
- Isolation : aucun marchand n'atteint `/admin/monerails/*` ; une carte Live utilise la clé Live, une carte Sandbox la clé test ; un événement d'un autre environnement ne touche pas la carte.
- Lecteur (viewer) : toute écriture refusée côté serveur (`READ_ONLY`), y compris `spending-limit`.
- Les erreurs Monerails ne sont jamais montrées telles quelles aux marchands (messages génériques, code interne), le nom du fournisseur ne fuit pas.
- Aucun secret ou clé réelle dans le dépôt (recherche `mr_live_`, `whsec_`, `AIza`, `sk_live_`).
- Sorties HTML : échappées (admin, tableau de bord, email) ; aucun script possible dans l'aperçu.
- Montants en cents, `Idempotency-Key` ≤ 255, libellé ≤ 60, `spending_limit` en cents, limite et intervalle conformes, titulaire (18 ans, pays, recto/verso, 5 vérifications par 24 h) conforme.

## Reste à confirmer ou à décider (non corrigeable par le code)
1. **Apple Pay / Google Pay et 3D Secure** : non documentés par Monerails. Publiés sur le site ; à confirmer avant l'ouverture Live.
2. **Cartes entreprise (KYB)** : pas de titulaire entreprise chez Monerails ; elles restent chez l'ancien émetteur.
3. **Email du titulaire unique chez Monerails (par entreprise)** : la même personne chez deux marchands Freda Pay provoque `cardholder_exists` ; le titulaire reste utilisable chez l'ancien émetteur (repli). À améliorer si besoin.
4. **Mémoire des compteurs** : verrou par carte et compteur d'affichage sont en base (`card_locks`, `card_reveals`) ; sans les migrations, repli en mémoire (un seul serveur).
5. **Frais de retrait Monerails** (1,5 %) : le frais « retrait » de la grille est retenu sur le montant retiré, mais Monerails prend aussi son propre frais ; vérifier la marge réelle.
6. **Rotation des secrets déjà exposés** : clé Gemini et secrets de webhook Freda Mail collés dans le chat. À régénérer.

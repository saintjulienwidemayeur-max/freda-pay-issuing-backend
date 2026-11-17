# État du projet Freda Pay Issuing — 16 novembre 2026

À coller au début d'une nouvelle session Claude Code pour reprendre le travail.

## Dépôts et règles de travail
- Backend : `saintjulienwidemayeur-max/freda-pay-issuing-backend` (Node.js sans dépendances, tests `node --test test/*.test.js`, 429 tests verts au dernier passage).
- Frontend : `saintjulienwidemayeur-max/frontent-fredapay-issuing` (`dashboard.html`, `index.html`, `docs/`, `freda-bot.js`).
- `admin.html` n'est PAS dans les dépôts : le propriétaire garde le fichier ; Claude le modifie et le renvoie après chaque changement.
- Toujours travailler sur la branche `claude/vibrant-brahmagupta-cyboos`, puis créer la PR et la merger (squash) quand c'est fini.
- Les migrations SQL doivent être montrées dans le chat (le propriétaire les exécute sur Supabase).
- Le propriétaire écrit en kreyòl ; répondre en kreyòl.
- Le message « Stop hook : unpushed commit » est une fausse alerte après un squash merge (vérifier `git ls-remote` = `HEAD`).

## Fait récemment (tout est mergé)
- Agent IA : répond seul à tous les emails des vraies personnes (Freda Mail, boîtes issuing@ et contact@), ton humain, voit la conversation, répond aux questions de légalité avec l'identité légale ; sujets sensibles = réponse + ligne « l'équipe prend le relais » + alerte admin ; emails anciens (30 j, jusqu'à 365) traités ; erreur 404 « Message à relancer introuvable » corrigée (autres boîtes puis Brevo).
- Clés API saisies dans l'admin (Agent IA > Clés API) : Gemini, Anthropic, Freda Mail (une par boîte), secrets webhook Freda Mail (plusieurs), clé et secret Monerails ; chiffrées dans `platform_settings`.
- Bénéfices : séparés Gateway / Issuing / Autres dans « Bénéfices par opération », la vue d'ensemble et le PDF partenaire (en USD ; l'affichage HTG a été retiré à la demande).
- Monerails (2e émetteur de cartes) : intégré en **SANDBOX seulement**, dans l'admin (section « Monerails (Sandbox) ») : titulaires (vérification envoyée automatiquement, approbation de test), cartes (création, recharge, retrait, gel, résiliation, détails, achat simulé), transactions, webhook signé `/webhooks/monerails` (table `monerails_events`). Aucun marchand n'est concerné.
- Dashboard marchand : section « Activité » (tous les mouvements, onglets, recherche, par jour) et bandeau d'information (maintenance) réglable dans admin > Paramètres.

## Constats Monerails (tests sandbox)
- Une carte ne peut pas être résiliée le jour de sa création (« Cards Created Today Cannot be Terminated ») : geler puis résilier le lendemain.
- La vérification d'un titulaire doit être envoyée avant l'approbation de test (`verification_not_submitted`).
- Le solde cartes Monerails se recharge seulement en crypto depuis leur dashboard.
- Non documenté par Monerails : Apple Pay / Google Pay, 3D Secure, cartes d'entreprise (KYB), frais complets. Email de questions préparé.

## Prochaines étapes
1. Attendre les réponses de Monerails (Apple Pay/Google Pay, 3DS, KYB, frais, délai de résiliation).
2. FAIT le 17/11 : Monerails branché à l'API marchands (Sandbox) sans toucher les cartes existantes : colonne `provider` (défaut `maplerad`), couche `src/services/cardIssuer.js`, réglage admin (Admin > Monerails > Émetteur des cartes : marchands pilotes ou tous), titulaires des pilotes aussi inscrits chez Monerails, nouvelles cartes INDIVIDUELLES Sandbox des pilotes émises chez Monerails (plafond appliqué par Monerails), webhooks Monerails traduits (`src/services/monerailsBridge.js`), alerte « solde Monerails bas », plafond modifiable après création (`POST /cards/:id/spending-limit`, sauf cartes Monerails), verrou par carte et compteur `reveal` en base (`card_locks`, `card_reveals`). RESTE : le Live chez Monerails (clé live non acceptée pour l'instant) et les cartes entreprise (pas de KYB chez Monerails).
3. Ajouter à l'API : `identity.imageBackUrl`, `spending_limit` (le marchand fixe le plafond), `single_use`, nouveaux codes d'erreur, résiliation différée.
4. **URGENT : la documentation v2 est DÉJÀ PUBLIÉE** (à la demande du propriétaire, PR backend #136 et frontend #63) : `spending_limit`, `single_use`, verso obligatoire, règles des titulaires, codes `INVALID_SPENDING_LIMIT`, `AMOUNT_TOO_SMALL`, `HOLDER_*`, `CARD_MINIMUM_BALANCE`, `CARD_TERMINATE_SAME_DAY`, `CARD_OPERATION_IN_PROGRESS`, `CARD_SINGLE_USE`, `CARD_REVEAL_LIMIT`, et la section Apple Pay / Google Pay. FAIT le 17/11 : `spending_limit` (daily / per_transaction, contrôlé à chaque achat : la carte est gelée quand le plafond est atteint) et `single_use` (table `card_rules`, migration `2026-11-17-card-rules.sql`). FAIT aussi : règles des titulaires (`HOLDER_DOCUMENT_BACK_REQUIRED`, `HOLDER_UNDERAGE`, `HOLDER_COUNTRY_UNSUPPORTED`, `HOLDER_EMAIL_EXISTS`, `HOLDER_VERIFICATION_LIMIT`), `CARD_MINIMUM_BALANCE`, `CARD_TERMINATE_SAME_DAY` (l'admin et la fermeture auto des cartes à usage unique passent outre), `CARD_OPERATION_IN_PROGRESS`, `CARD_REVEAL_LIMIT`, et les champs plafond / usage unique dans le dashboard. La documentation publiée correspond maintenant à l'API.

## Rappels pour le propriétaire
- Migrations à exécuter si pas encore fait : `2026-11-12-ai-agent.sql`, `2026-11-15-agent-autonomy.sql`, `2026-11-16-monerails-sandbox.sql`, `2026-11-17-card-rules.sql`, `2026-11-17-holder-attempts.sql`, `2026-11-17-card-providers.sql` (dans cet ordre).
- Changer la clé Gemini et les secrets webhook Freda Mail qui ont été collés dans le chat.
- Éteindre le bandeau maintenance (admin > Paramètres) quand la maintenance est finie.

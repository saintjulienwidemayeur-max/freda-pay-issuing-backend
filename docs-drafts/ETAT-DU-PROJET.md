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
2. Brancher Monerails à l'API marchands SANS toucher les cartes existantes : colonne `provider` sur `cards` (défaut l'émetteur actuel), couche « fournisseur » commune, interrupteur admin pour les nouvelles cartes, pilote avec 1-2 marchands.
3. Ajouter à l'API : `identity.imageBackUrl`, `spending_limit` (le marchand fixe le plafond), `single_use`, nouveaux codes d'erreur, résiliation différée.
4. Publier la documentation v2 : brouillon dans `docs-drafts/cartes-v2-monerails.md` (backend), à reporter dans `openapi.yaml` et `docs/*.html` une fois codé.

## Rappels pour le propriétaire
- Migrations à exécuter si pas encore fait : `2026-11-12-ai-agent.sql`, `2026-11-15-agent-autonomy.sql`, `2026-11-16-monerails-sandbox.sql`.
- Changer la clé Gemini et les secrets webhook Freda Mail qui ont été collés dans le chat.
- Éteindre le bandeau maintenance (admin > Paramètres) quand la maintenance est finie.

# Avancement du prototype

Où en est l'implémentation de [`otoroshi-api-management-specs`](../otoroshi-api-management-specs),
décision par décision, ce qui est en cours, et ce qui vient ensuite. **Tenu à jour à chaque commit.**

Légende : ✅ fait et vérifié · 🟡 partiel · ⬜ à faire · ➖ sans objet / hors MVP

Dernière mise à jour : 18/11/2026.

---

## En cours

- Rien : prochaine entrée de la liste ci-dessous.

## Suite, dans l'ordre proposé

1. **D-15**, suite : certificats (autorités de confiance des plans mTLS) et modules d'auth (plans oauth2-remote) dérivés, comme les JWT verifiers.
2. Console en français (le portail l'est déjà).
3. **D-20** : tester l'exposition par nom d'hôte ; redirections quand le patron change ; mono-tenant sans préfixe.
4. Notifications hors application (e-mail, webhook) — les notifications in-app existent ; le canal n'est pas tranché dans le spec.
5. **D-28** : CRDs Kubernetes et chart Helm.
6. **D-36 / Q-12** : connecteur Stripe Checkout + webhooks (le connecteur de test existe).
7. **Q-8** : rétention et échantillonnage du chemin brut.
8. Mode adopt : reprendre aussi les souscriptions et apikeys existantes.

## Points connus

- **Push bloqué** depuis le redémarrage : la clé SSH n'est plus chargée (`ssh-add`). Les commits s'accumulent en local.
- Données de démo : le workspace `default` déclare un champ de plan `sla` obligatoire (démonstration de D-18) ; les plans de Books et Petstore l'ont renseigné.

---

## Décisions du spec

| Décision | État | Où / comment c'est vérifié |
|---|---|---|
| D-1 l'entité `Api` d'Otoroshi | ✅ | `server/otoroshi/projection.js` ; test L0 |
| D-2 synchronisation sélective | ✅ | doc, CGU, usage, prix, métadonnées jamais projetés ; `test/model.test.js` |
| D-3 l'API créée de bout en bout, routes comprises | ✅ | ressources → routes, backends, flows |
| D-4 jamais dans le chemin de requête | ✅ | file de tâches rejouable `server/domain/tasks.js` ; souscription en attente tant que l'API n'est pas déployée |
| D-5 la policy vit dans le plan | ✅ | éditeur de plan ; limites et filtrage projetés sur le plan |
| D-6 une souscription est une apikey | ✅ | `apiRef` + `id_ref` vérifiés sur la gateway — limites : G-1, G-4 |
| D-8 PostgreSQL ×2 | ✅ | `server/db/migrations.js` |
| D-9 n°1 tout ce que fait l'UI passe par l'API | ✅ | même routeur sur `/api` et `/backoffice/api` |
| D-9 n°2 échappatoire vers l'entité projetée | ✅ | « Technical details », lien vers le backoffice Otoroshi |
| D-9 n°3 rien d'essentiel masqué | ✅ | avertissements : routes ouvertes, tout jeton passe, attributs non appliqués, ordre de résolution |
| D-9 n°4 réversibilité | 🟡 | export / import ✅ ; « désinstaller laisse une conf qui tourne » non testé |
| D-9 n°5 Apache 2.0 | ✅ | `LICENSE`, `NOTICE` |
| D-10 WAF dans l'extension | 🟡 | posable comme plugin dans un flow ou un groupe ; pas d'écran dédié |
| D-11 i18n | 🟡 | doc multilingue ✅, portail en/fr ✅, console en anglais seulement, libellés des champs de métadonnées dans une seule langue |
| D-12 clair / sombre / système | ✅ | console et portail |
| D-14 plus besoin d'ouvrir Otoroshi | 🟡 | APIM complet ; reste D-15 pour les certificats et modules d'auth |
| D-15 objets dérivés (certificats, modules d'auth, JWT verifiers) | 🟡 | JWT verifiers ✅ dérivés de la description du plan (JWKS ou HMAC, iss, aud), marqués, inclus dans le diff de déploiement et le drift, supprimés avec l'API — test L0 ; certificats et modules d'auth ⬜ |
| D-16 compositions nommées | 🟡 | groupes de policies ✅ (versions figées, montée de version) ; resources et dictionnaires ⬜ |
| D-17 try-it | 🟡 | portail (Scalar + proxy) ✅ ; console ✅ sans la trace des policies (G-12) |
| D-18 métadonnées typées, une seule mécanique | ✅ | 5 portées, formulaire de demande, blocage de publication |
| D-19 workspace + teams, utilisateurs globaux | ✅ | un admin ne voit que les membres de ses workspaces |
| D-20 un portail par workspace, résolu par l'URL | 🟡 | par chemin ✅ ; par nom d'hôte codé, non testé ; redirections ⬜ |
| D-22 état décrit / état déployé, diff avant d'agir | ✅ | dry-run systématique avant déploiement |
| D-24 location `default` + marquage de propriété | ✅ | |
| D-25 authentification | ✅ | OIDC console et portail vérifiés (IdP de dev) ; mode Otoroshi testé en unitaire |
| D-26 application, `client_id` attendu, `id_ref` | 🟡 | ✅ ; certificats clients stockés mais pas projetés |
| D-27 navigation de la console | ✅ | état de la gateway en bas de la sidebar (emplacement que D-37 laissait ouvert : proposition) |
| D-28 administrable par programme | 🟡 | API ✅, CLI ✅, catalogues distants http/git ✅, CRDs ⬜ |
| D-29 une version est une nouvelle API | ✅ | |
| D-30 transfert vers un plan équivalent | ✅ | même clé, même historique ; un transfert qui dégrade (débit, quotas, prix, CGU, ressources) attend l'accord du consommateur ; le consommateur demande, le producteur applique ; notifications in-app des deux côtés |
| D-31 pas de quota agrégé | ✅ | |
| D-32 périmètre MVP, événements captés | 🟡 | GatewayEvent vérifié en réel ; LLMUsageAudit et McpAudit codés, non testés avec de vrais événements |
| D-33 deux chemins de stockage | 🟡 | calculé + brut avec masquage ✅ ; rétention / échantillonnage ⬜ (Q-8) |
| D-35 brouillon → snapshot immuable | ✅ | rollback = redéployer un snapshot |
| D-36 prêt pour la monétisation | 🟡 | schéma ✅, connecteur de test ✅, Stripe ⬜ (Q-12 ouverte) |
| D-37 une installation, un cluster | ✅ | |
| D-38 projection par écriture marquée catalogue | ✅ | historique de déploiement côté Otoroshi |
| D-39 CSS écrit à la main | ✅ | palette des graphiques validée |
| D-41 unité de mesure du plan | ✅ | tokens / budget refusés sans backend LLM |
| D-42 Scalar embarqué derrière un proxy | ✅ | |
| ➖ D-7, D-21, D-23 (remplacées), D-13, D-34, D-40 | ➖ | |

## Règles de la frontière de synchronisation (spec §5)

| Règle | État |
|---|---|
| Projection idempotente et rejouable | ✅ |
| Propriété explicite (marqueur, `managed_by`) | ✅ |
| Détection de drift (API et clés), lisible | ✅ |
| Mode adopt | 🟡 l'API est reprise sans être écrasée ; ses souscriptions existantes ne le sont pas |
| Dry-run avant projection de masse | ✅ déploiement et synchro de catalogue |

## §8 du spec, pas encore instruit

| Sujet | État |
|---|---|
| Template de portail par défaut | ✅ ; templates utilisateur ⬜ |
| Analytics et restitution | ✅ attribution à l'ingestion, tableaux de bord console et portail |
| Journal d'audit, modifications et consultations | ✅ ; export vers webhooks ✅ (curseur, au moins une fois, rattrapage vérifié après coupure) |
| Le catalogue comme système de découverte | 🟡 recherche et tags ; catégories et mise en avant ⬜ |
| Dynamic client registration auprès de l'IdP | ⬜ |
| Historique de déploiement relié au snapshot | 🟡 via les métadonnées de l'`Api` (G-7) |

## Critère de sortie de L0

✅ `test/reference-catalogue.test.js` : catalogue Atlas (6 plans, 5 mécanismes d'auth, 4 modes d'approbation, une API, un seul jeu de routes) projeté sur Otoroshi 18.0.1, réconcilié, drift détecté puis réparé — y compris le JWT verifier dérivé du plan Partner. 14 tests, stables.

## Documentation

✅ Site Docusaurus dans `documentation/` (même socle que les autres extensions : recherche locale, thème sombre par défaut), 20 pages, construit sans lien cassé ; `doc.sh` le publie dans `./docs` pour GitHub Pages.

✅ **Visite des écrans** (`documentation/docs/screens.mdx`) : 80 captures de chaque écran de la console et du portail, tiroirs, modales et menus compris, clair et sombre, anglais et français, dans `documentation/static/img/screens/`. Elles sont produites par `bun run screenshots` (Chromium headless), qui régénère aussi la page : à relancer après chaque changement d'interface.

## Manques côté Otoroshi

Consignés au fil de l'eau dans [`OTOROSHI-GAPS.md`](./OTOROSHI-GAPS.md) (G-1 à G-14), pour correction dans le plan de données.

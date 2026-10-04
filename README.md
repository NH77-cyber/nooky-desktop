# Nooky Desktop

Nooky est un petit nuage sobre qui vit en haut de ton écran — dans l'encoche du MacBook, ou
au bord haut de l'écran sur Windows. Il te montre ta journée, te rappelle tes tâches à
l'heure, attrape les fichiers et les textes que tu lui glisses, et discute avec Claude.

- **Accueil** : ta journée en un coup d'œil (mode pro ou perso, progression, 3 prochaines
  tâches, « Sac de demain » le soir, une ligne du dernier brief, courrier non lu) et des
  boutons rapides, dont **Concentration 25 / 50 min**.
- **Pro / perso** : Nooky passe tout seul en pro pendant tes heures de travail (ambre) et en
  perso le reste du temps (menthe) ; la pastille en haut de l'île bascule à la main.
- **Ma journée** : tâches du jour, report automatique, rappels, **routines** (« tous les
  jours », « jours ouvrés », « chaque mardi », « chaque mois le 5 ») et **Sac de demain**.
- **Saisie rapide** dans « Ma journée » et le chat : `+ relancer le client demain 14h`,
  `courses : lait, pain`, `abo Netflix 13,49 le 12` — avec un bouton « Annuler ».
- **Plus** : Courses, Abonnements (total du mois, rappels 3 jours avant), Agenda (14 jours),
  À suivre, Courrier.
- **Briefs** : Ce matin, Veille, Ce soir, Semaine, Mois, Loisirs, préparés par les tâches
  planifiées. **Bilan du soir** les jours de travail.
- **Chat** avec Claude : avec une clé API (gardée dans le trousseau du système), ou **gratuit
  via la maison** quand elle est ouverte.
- **Synchronisation** : tout passe par un dossier Google Drive partagé entre le Mac, le PC, la
  maison et les tâches planifiées (format décrit dans [SYNC-FORMAT.md](SYNC-FORMAT.md), v2).

## Installer

- **Recommandé** : GitHub construit l'app et Nooky se met à jour tout seul →
  [GUIDE-GITHUB.md](GUIDE-GITHUB.md) (workflow `.github/workflows/release.yml`).
- Construire soi-même : macOS [GUIDE-MAC.md](GUIDE-MAC.md), Windows 11 [GUIDE-WINDOWS.md](GUIDE-WINDOWS.md).

Au premier lancement, Nooky demande ton prénom. Le reste se règle dans **Réglages** :
« Ce que Nooky doit savoir sur toi », le lien de la maison, et **Rythme et loisirs** (heures
pro, heure du bilan du soir, plateformes de jeu, services de streaming, zone scolaire) — cette
partie est partagée avec la maison via le dossier de synchronisation. Rien de personnel n'est
dans le code.

En bref : `npm install`, puis `npm run tauri dev` pour essayer, `npm run tauri build` pour
fabriquer l'app (`.app` + `.dmg` sur Mac, installeur NSIS sur Windows).

## Développer

- `npm run dev` ouvre l'île dans un navigateur, sans Tauri, avec un faux dossier de
  synchronisation (dans le localStorage) et une fausse maison qui répond au chat gratuit.
  Ajoute `?reset` pour repartir des données d'exemple, `?notch=185` pour simuler une encoche,
  `?name=Camille` pour un prénom, `?maison=off` pour une maison fermée, et un état :
  `#greeting`, `#compact`, `#overview`, `#tasks`, `#chat`, `#chat-bridge`, `#reminder`,
  `#morning`, `#brief`, `#shopping`, `#subs`, `#agenda`, `#watch`, `#mail`, `#recap`,
  `#focus`, `#pause`, `#notice`, `#drop`, `#drop-text`, `#confused`.
  `settings.html` ouvre la fenêtre des Réglages.
- `npm test` : tests du journal d'opérations (v1 et v2), des routines, de la saisie rapide,
  des briefs, du courrier et des heures pro.
- `cargo test -p nooky` : tests Rust (dossier de synchronisation, fichiers v2, chat gratuit,
  compactage, fichiers déposés).
- `npm run icons` : régénère les icônes (dessinées en code, `scripts/gen-icons.mjs`).

## Crédits et licence

Nooky Desktop est basé sur **Coucou** de **Louis Raillé**, publié sous licence MIT
(voir [LICENSE-COUCOU-MIT](LICENSE-COUCOU-MIT)) : la mécanique de l'île (animations,
ressorts, survol, fenêtre transparente, glisser-déposer, chat) vient de son code.
Le nom, le personnage, les icônes et les sons de Coucou ne sont pas repris
(voir [REFERENCE-coucou-LICENSE-ASSETS.md](REFERENCE-coucou-LICENSE-ASSETS.md)) :
Nooky, son dessin (le « nuage épuré »), ses icônes et ses sons (synthétisés) sont originaux.

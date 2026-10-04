# Construire et mettre à jour Nooky avec GitHub (sans rien installer)

Avec cette méthode, c'est **GitHub** qui fabrique Nooky pour Mac et pour Windows, sur ses
propres machines. Toi, tu n'utilises que le site **github.com** dans Chrome. Ensuite, Nooky
se met à jour **tout seul**.

Il te faut :

- un compte GitHub (gratuit) : https://github.com/signup ;
- le fichier **nooky-desktop.zip** ;
- le fichier **release.yml** (fourni à côté du zip) ;
- le fichier **nooky-cles-secretes.txt** (fourni à part).

> **Le fichier nooky-cles-secretes.txt est secret.** Range-le dans un endroit sûr (par
> exemple ton gestionnaire de mots de passe), ne l'envoie à personne et ne le mets **jamais**
> sur GitHub. Si tu le perds, les mises à jour automatiques ne marcheront plus : il faudra
> réinstaller Nooky à la main une fois avec une nouvelle clé.

---

## a) Créer le dépôt

1. Va sur **https://github.com/new**.
2. **Repository name** : `nooky-desktop`.
3. Choisis **Public**.
4. Ne coche **rien** dans « Initialize this repository with » : pas de README, pas de
   .gitignore, pas de licence.
5. Clique **Create repository**.

## b) Envoyer les fichiers

1. Sur ton ordinateur, décompresse **nooky-desktop.zip** (double-clic sur Mac, clic droit →
   « Extraire tout… » sur Windows). Ouvre le dossier **nooky-desktop** qui en sort.
2. Sur la page du dépôt (vide), clique le lien **uploading an existing file**.
3. Dans le Finder (ou l'Explorateur), sélectionne **tout le contenu** du dossier nooky-desktop
   (Cmd + A sur Mac, Ctrl + A sur Windows) : les fichiers **et** les dossiers (`src`,
   `src-tauri`, `scripts`, `tests`…). Glisse-les dans la zone de la page GitHub.
4. Attends que tous les fichiers soient listés, puis clique **Commit changes** en bas.

Le projet contient **89 fichiers** ; le Finder en montre **87** (voir l'encadré). C'est sous
la limite de GitHub de **100 fichiers par envoi** : un seul glisser-déposer suffit. (Si un
jour GitHub refuse parce qu'il y en a plus de 100, envoie d'abord le dossier `src`, puis
« Add file → Upload files » pour le reste.)

> **Attention, sur Mac** : le Finder cache les dossiers dont le nom commence par un point.
> Le dossier **`.github`** (qui contient la recette de construction) **ne part donc pas**
> avec le glisser-déposer. On le crée à la main juste après. (Le fichier caché
> `.gitignore` ne part pas non plus ; il n'est pas indispensable.)

### Créer la recette de construction

1. Sur la page du dépôt : **Add file → Create new file**.
2. Dans la case du nom, tape exactement :
   `.github/workflows/release.yml`
   (GitHub transforme chaque `/` en dossier, c'est normal.)
3. Ouvre le fichier **release.yml** fourni à côté du zip (avec TextEdit ou le Bloc-notes),
   copie **tout** son contenu et colle-le dans la grande zone de texte.
4. Clique **Commit changes…** puis **Commit changes**.

## c) Ajouter les deux secrets

Ils servent à signer les mises à jour, pour que Nooky n'installe que des versions qui
viennent vraiment de toi.

1. Dans le dépôt : **Settings** (en haut à droite) → dans la colonne de gauche,
   **Secrets and variables → Actions**.
2. Clique **New repository secret**.
   - **Name** : `TAURI_SIGNING_PRIVATE_KEY`
   - **Secret** : la longue ligne qui suit ce nom dans **nooky-cles-secretes.txt**
     (copie-la en entier, sans espace avant ni après).
   - **Add secret**.
3. Recommence avec **New repository secret** :
   - **Name** : `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
   - **Secret** : la ligne qui suit ce nom dans le fichier.
   - **Add secret**.

Les noms doivent être **exactement** ceux-là (majuscules et tirets bas compris).

## d) Autoriser GitHub à publier

**Settings → Actions → General** → descends jusqu'à **Workflow permissions** → coche
**Read and write permissions** → **Save**.

## e) Lancer la construction

1. Onglet **Actions** du dépôt. (Si GitHub demande d'activer les workflows, clique le bouton
   vert pour accepter.)
2. Dans la colonne de gauche, clique **Construire Nooky**.
3. À droite, **Run workflow** → **Run workflow** (bouton vert).
4. Attends **15 à 25 minutes**. Recharge la page de temps en temps :
   - **rond orange** : en cours ;
   - **coche verte** : réussi, Nooky est publié (étape f) ;
   - **croix rouge** : échec.

**Si c'est rouge** : clique sur la ligne en rouge, puis sur le travail en échec
(« Nooky macOS (Apple silicon) » ou « Nooky Windows »), puis sur l'étape marquée d'une croix.
Copie les **60 dernières lignes** du journal et envoie-les à Claude. Si l'erreur parle de
« Secrets manquants », refais l'étape c.

## f) Installer Nooky

1. Sur la page du dépôt, à droite : **Releases** → la plus récente (« Nooky v0.4.0 »).
2. Dans **Assets**, télécharge :
   - **Mac** : le fichier **`.dmg`** dont le nom contient **`aarch64`** ;
   - **Windows** : le fichier qui finit par **`-setup.exe`**.

**Sur Mac** : ouvre le `.dmg`, glisse **Nooky** dans **Applications**, puis lance-le.
Nooky n'est pas certifié par Apple, donc macOS bloque la première ouverture :

- va dans **Réglages Système → Confidentialité et sécurité**, descends jusqu'au message sur
  Nooky et clique **« Ouvrir quand même »**, puis confirme ;
- si macOS dit que Nooky **« est endommagé »**, ouvre l'app **Terminal** et colle :
  ```
  xattr -dr com.apple.quarantine /Applications/Nooky.app
  ```
  puis relance Nooky.

**Sur Windows** : lance le `-setup.exe`. Si Windows affiche « Windows a protégé votre
ordinateur », clique **Informations complémentaires** puis **Exécuter quand même**.

Au premier lancement, Nooky te demande ton prénom. La suite (Google Drive, clé API Claude,
notifications) est expliquée dans GUIDE-MAC.md et GUIDE-WINDOWS.md, sections « Utiliser
Nooky » et suivantes.

## g) Les mises à jour, ensuite

1. Claude t'envoie les fichiers modifiés. Il augmente **toujours** le numéro de version
   dans `package.json`, `src-tauri/tauri.conf.json` et `Cargo.toml` (+ `Cargo.lock`) (sinon
   la mise à jour ne serait pas proposée).
2. Sur GitHub, va dans le bon dossier du dépôt, **Add file → Upload files**, glisse les
   fichiers : ceux qui ont le même nom sont **remplacés**. Puis **Commit changes**.
   (Si c'est `release.yml` qui change : ouvre-le sur GitHub, icône crayon, remplace le
   contenu, **Commit changes**.)
3. **Actions → Construire Nooky → Run workflow**, attends la coche verte.
4. C'est tout : Nooky voit la nouvelle version (au démarrage et toutes les 6 heures) et te
   propose en haut de l'écran **« Installer et relancer »**. Tu peux aussi forcer la
   vérification : icône nuage → **Rechercher une mise à jour…**, ou Réglages → À propos.

### Passer à la version 0.4.0 (depuis la 0.3.0)

La 0.4.0 change beaucoup de fichiers (nouveau Nooky « nuage épuré », mode pro / perso,
routines, courses, abonnements, agenda, briefs, concentration, chat gratuit via la maison,
format de synchronisation v2). Le plus simple : **renvoyer tous les fichiers**.

1. Décompresse le nouveau **nooky-desktop.zip** et ouvre le dossier **nooky-desktop**.
2. Sur la page du dépôt : **Add file → Upload files**.
3. Sélectionne **tout le contenu** du dossier (Cmd + A / Ctrl + A) et glisse-le dans la page :
   87 éléments, sous la limite de 100. Les fichiers de même nom sont remplacés, les nouveaux
   sont ajoutés. Clique **Commit changes**.
4. `release.yml` **ne change pas** : rien à faire dans `.github`.
5. **Actions → Construire Nooky → Run workflow**, attends la coche verte (15 à 25 minutes).
6. Nooky 0.3.0 te propose « Installer et relancer ».

Si tu préfères n'envoyer que ce qui a changé, voici la liste exacte (51 fichiers, dont 11
nouveaux ★). Respecte les dossiers : envoie chaque groupe depuis le bon dossier du dépôt (ou
glisse les dossiers `src`, `src-tauri`, `scripts`, `tests` entiers, c'est équivalent).

- Racine : `Cargo.lock`, `Cargo.toml`, `package.json`, `package-lock.json`, `README.md`,
  `SYNC-FORMAT.md`, `GUIDE-GITHUB.md`
- `scripts/` : `gen-icons.mjs`
- `tests/` : `v2.test.ts` ★
- `src-tauri/` : `tauri.conf.json`
- `src-tauri/src/` : `files.rs`, `lib.rs`, `sync.rs`
- `src-tauri/icons/` : `32x32.png`, `64x64.png`, `128x128.png`, `128x128@2x.png`,
  `icon.png`, `icon.ico`, `icon.icns`, `tray-template.png`
- `src/` : `main.ts`, `style.css`
- `src/core/` : `bridge.ts`, `layout.ts`, `mock.ts`, `sound.ts`, `state.ts`,
  `focus.ts` ★, `hours.ts` ★, `mode.ts` ★
- `src/island/` : `island.ts`
- `src/nooky/` : `engine.ts`, `greeting.ts`
- `src/settings/` : `main.ts`, `settings.css`
- `src/tasks/` : `oplog.ts`, `parse.ts`, `reminders.ts`, `store.ts`, `briefs.ts` ★,
  `capture.ts` ★, `records.ts` ★, `routines.ts` ★
- `src/views/` : `cards.ts`, `chat.ts`, `icons.ts`, `upload.ts`, `views.ts`,
  `briefs.ts` ★, `lists.ts` ★, `md.ts` ★

Après la mise à jour : ouvre **Réglages → Rythme et loisirs** pour régler tes heures pro,
l'heure du bilan du soir, tes plateformes de jeu, tes services de streaming et ta zone
scolaire (c'est partagé avec la maison).

---

**Option simple de secours** : les guides GUIDE-MAC.md et GUIDE-WINDOWS.md (construire
Nooky soi-même sur son ordinateur) marchent toujours. Une version construite ainsi ne se met
pas à jour toute seule depuis GitHub.

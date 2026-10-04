# Installer Nooky sur ton Mac (pas à pas)

Ce guide part de zéro : pas besoin d'être développeur. Compte environ **30 minutes** la
première fois (surtout des téléchargements), puis 2 minutes pour les mises à jour.

Tout se fait dans l'app **Terminal** (Applications → Utilitaires → Terminal). Pour chaque
commande : copie-la, colle-la dans le Terminal, appuie sur **Entrée**, attends que le
Terminal te rende la main (la ligne qui se termine par `%` réapparaît).

---

## 1. Installer les outils (une seule fois)

### 1.1 Les outils de développement d'Apple

```bash
xcode-select --install
```

Une fenêtre s'ouvre : clique **Installer**, accepte, attends la fin (5 à 15 min).
Si le Terminal répond « already installed », c'est déjà fait.

### 1.2 Rust (le langage de la partie « système » de Nooky)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Quand il demande, tape **1** puis Entrée (installation par défaut).
Ensuite **ferme le Terminal et rouvre-le**, puis vérifie :

```bash
rustc --version
```

Tu dois voir quelque chose comme `rustc 1.9x.x`.

### 1.3 Node.js 22 (pour l'interface)

Va sur **https://nodejs.org**, télécharge la version **22 LTS** pour macOS (fichier `.pkg`),
ouvre-la et suis l'installation. Puis, dans un **nouveau** Terminal :

```bash
node --version
```

Tu dois voir `v22.x.x`.

## 2. Préparer le projet

1. Double-clique sur **nooky-desktop.zip** pour le décompresser.
2. Range le dossier **nooky-desktop** dans **Documents** (par exemple).
3. Dans le Terminal, tape `cd ` (avec un espace), **glisse le dossier nooky-desktop** depuis
   le Finder dans la fenêtre du Terminal, puis Entrée. Ou directement :

```bash
cd ~/Documents/nooky-desktop
```

4. Installe les dépendances de l'interface :

```bash
npm install
```

## 3. Essayer Nooky (mode développement)

```bash
npm run tauri dev
```

La **première** fois, la compilation prend **5 à 10 minutes** (les fois suivantes, quelques
secondes). Ensuite Nooky apparaît en haut de l'écran : il descend dans l'encoche, te dit
« Bonjour ! » (puis il te demande ton prénom), puis se range dans l'encoche. Passe la souris sur l'encoche pour le
faire sortir, clique pour l'ouvrir.

Pour arrêter : reviens dans le Terminal et appuie sur **Ctrl + C**.

## 4. Fabriquer l'application

```bash
npm run tauri build
```

Compte 5 à 10 minutes. À la fin, tu as :

- l'application : `nooky-desktop/target/release/bundle/macos/Nooky.app`
- l'installeur : `nooky-desktop/target/release/bundle/dmg/Nooky_0.2.0_aarch64.dmg`

Pour ouvrir ce dossier dans le Finder :

```bash
open target/release/bundle
```

## 5. Installer

1. Ouvre le fichier **.dmg**, glisse **Nooky** sur le dossier **Applications**.
2. Lance **Nooky** depuis le Launchpad ou le dossier Applications.

### Premier lancement d'une app non signée

Comme tu as fabriqué l'app toi-même sur ce Mac, macOS l'ouvre en général sans rien dire.
Si macOS affiche « Nooky ne peut pas être ouvert car le développeur ne peut pas être vérifié » :

- **clic droit** (ou Ctrl + clic) sur Nooky dans Applications → **Ouvrir** → **Ouvrir** ;
- ou, si ce bouton n'apparaît pas (macOS 15 et plus) : **Réglages Système →
  Confidentialité et sécurité**, descends jusqu'au message sur Nooky et clique
  **« Ouvrir quand même »**, puis confirme avec ton mot de passe.

C'est à faire une seule fois.

### Autoriser les notifications

Au premier rappel, macOS te demande si Nooky peut envoyer des notifications : réponds
**Autoriser**. Tu peux le changer plus tard dans **Réglages Système → Notifications → Nooky**.

## 6. Utiliser Nooky

- **L'encoche** : passe la souris dessus → Nooky sort (vue compacte : ta progression « 3/7 »).
  Clique → l'île s'ouvre.
- **Premier lancement** : Nooky te demande ton prénom (et, si tu en as un, le lien de ta
  « maison »). Tout se change ensuite dans **Réglages… → Toi**, avec aussi « Ce que Nooky doit
  savoir sur toi » (ton métier, tes projets…), envoyé à Claude avec tes questions.
- **Accueil** : ta journée, les 3 prochaines tâches, « Ma journée », « Chat », et « Ouvrir la
  maison » si tu as mis un lien dans les Réglages.
- **Ma journée** : tape une tâche, par exemple `relancer le client demain 14h`, Entrée.
  « demain », « après-demain », « lundi », « 14h », « 14h30 », « à 9h » sont compris.
  Coche la case ronde quand c'est fait.
- **Chat** : commence un message par `+` pour ajouter une tâche (`+ appeler M6 vendredi`).
- **Glisse un fichier** (PDF, image, texte) sur l'encoche : Nooky l'attrape et tu peux lui
  poser une question dessus.
- **L'icône nuage dans la barre des menus** : *Ouvrir Nooky*, *Réglages…*,
  *Pause / reprendre*, *Quitter Nooky*.
- Nooky n'a pas d'icône dans le Dock : c'est normal.

## 7. Partager ta liste entre le Mac et le PC (Google Drive)

1. Installe **Google Drive pour ordinateur** : https://www.google.com/drive/download/
2. Connecte-toi avec ton compte Google. « Google Drive » apparaît dans la barre latérale du
   Finder.
3. Relance Nooky : il crée tout seul le dossier **Mon Drive → Nooky**.
4. Vérifie dans **Réglages… → Dossier de synchronisation** : la pastille doit dire
   **Google Drive** et le chemin finir par `Mon Drive/Nooky`.
5. Conseillé : dans le Finder, clic droit sur le dossier **Nooky** → **Disponible hors
   connexion**, pour que Nooky lise tes tâches instantanément.

Si la pastille dit **Local**, Google Drive n'a pas été trouvé : tes tâches restent sur ce
Mac. Tu peux aussi choisir un autre dossier avec **Choisir un autre dossier…**.

## 8. (Optionnel) Le chat avec Claude

1. Va sur **https://console.anthropic.com**, connecte-toi, menu **API Keys** →
   **Create Key**, copie la clé (elle commence par `sk-ant-`).
2. Dans **Billing**, fixe une **limite de dépense mensuelle** (par exemple 10 €).
3. Dans Nooky : icône nuage → **Réglages…** → **Clé API** → colle → **Enregistrer**.
   La clé est rangée dans ton **Trousseau macOS**, jamais dans un fichier.
4. Si macOS demande « Nooky souhaite utiliser des informations confidentielles… », clique
   **Toujours autoriser** (et redonne-le après chaque nouvelle fabrication de l'app).

## 9. Lancer Nooky au démarrage

**Réglages… → Général → Lancer au démarrage**. Ça marche quand Nooky est bien installé
dans **Applications**.

## 10. Mettre à jour

Remplace le dossier par la nouvelle version, puis :

```bash
cd ~/Documents/nooky-desktop
npm install
npm run tauri build
```

Et réinstalle le .dmg (quitte d'abord Nooky : icône nuage → Quitter Nooky).

## En cas de souci

- **« command not found: npm »** ou **« cargo »** : ferme et rouvre le Terminal ; sinon
  refais l'étape 1.
- **Erreur de compilation Rust** : mets Rust à jour avec `rustup update`, puis relance
  `npm run tauri build`.
- **Nooky ne sort pas de l'encoche** : approche la souris tout en haut, au centre, pile sur
  l'encoche. Ou icône nuage → **Ouvrir Nooky**.
- **Sur un écran externe** (sans encoche), Nooky se cache dans le bord haut au centre :
  approche la souris du bord pour le faire sortir. Réglages → Écran pour choisir l'écran.
- Le journal de Nooky est ici : `~/Library/Application Support/Nooky/nooky.log`.


---

## Mettre à jour Nooky (les fois suivantes)

Rien à réinstaller : Rust, Node et les outils Apple restent sur ton Mac.

1. Quand je t'envoie une nouvelle version, décompresse-la et **remplace le contenu** de ton dossier `nooky-desktop` par celui du zip. Garde les dossiers `node_modules` et `target` s'ils existent : ils accélèrent la reconstruction.
2. Double-clique sur **« Mettre à jour Nooky.command »** dans le dossier. La première fois, macOS peut refuser : clic droit → **Ouvrir** → **Ouvrir**.
3. Le script reconstruit l'app (2 à 5 minutes), ferme l'ancienne, la remplace dans Applications et relance Nooky.

Tes tâches (dans Google Drive), tes réglages et ta clé API restent en place. macOS peut redemander l'accès au trousseau : réponds **« Toujours autoriser »**.

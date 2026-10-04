# Installer Nooky sur ton PC Windows 11 (pas à pas)

Compte environ **40 minutes** la première fois (surtout des téléchargements).
Tout se fait dans **PowerShell** (menu Démarrer → tape « PowerShell » → Entrée).

---

## 1. Installer les outils (une seule fois)

### 1.1 Visual Studio Build Tools (le compilateur de Microsoft)

1. Va sur **https://visualstudio.microsoft.com/fr/visual-cpp-build-tools/** et télécharge
   **Build Tools pour Visual Studio 2022**.
2. Lance l'installeur, coche la charge de travail **« Développement Desktop en C++ »**
   (laisse les options cochées par défaut, dont le **SDK Windows**), clique **Installer**.
3. Redémarre le PC à la fin si on te le demande.

WebView2 (le moteur d'affichage) est déjà inclus dans Windows 11.

### 1.2 Rust

1. Va sur **https://rustup.rs**, télécharge **rustup-init.exe** (64 bits), lance-le.
2. Tape **1** puis Entrée (installation par défaut).
3. Ferme PowerShell, rouvre-le et vérifie :

```powershell
rustc --version
```

### 1.3 Node.js 22

Va sur **https://nodejs.org**, télécharge la version **22 LTS** pour Windows (`.msi`),
installe-la (options par défaut). Dans un **nouveau** PowerShell :

```powershell
node --version
```

## 2. Préparer le projet

1. Clic droit sur **nooky-desktop.zip** → **Extraire tout…** → dans **Documents**.
2. Dans PowerShell :

```powershell
cd $HOME\Documents\nooky-desktop
npm install
```

> Si PowerShell répond que « l'exécution de scripts est désactivée sur ce système »,
> tape une fois `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, réponds **O**,
> puis recommence. (Ou remplace `npm` par `npm.cmd` dans les commandes.)

## 3. Essayer Nooky

```powershell
npm run tauri dev
```

La première compilation prend 5 à 10 minutes. Nooky apparaît en haut au centre de l'écran,
dit bonjour, puis se cache dans le bord. Approche la souris du **bord haut, au centre** pour
le faire sortir ; clique pour l'ouvrir. Pour arrêter : **Ctrl + C** dans PowerShell.

## 4. Fabriquer l'installeur

```powershell
npm run tauri build
```

L'installeur est ici :
`nooky-desktop\target\release\bundle\nsis\Nooky_0.2.0_x64-setup.exe`

```powershell
explorer target\release\bundle\nsis
```

## 5. Installer

Double-clique sur **Nooky_0.2.0_x64-setup.exe**.

Windows peut afficher **« Windows a protégé votre ordinateur »** (SmartScreen), parce que
l'app n'est pas signée : clique **Informations complémentaires**, puis **Exécuter quand
même**. C'est à faire une seule fois.

L'icône nuage de Nooky est près de l'horloge (si tu ne la vois pas, clique sur la petite
flèche **^** et glisse-la dans la barre). Clic droit : *Ouvrir Nooky*, *Réglages…*,
*Pause / reprendre*, *Quitter Nooky*.

## 6. Partager ta liste avec le Mac (Google Drive)

1. Installe **Google Drive pour ordinateur** : https://www.google.com/drive/download/
2. Connecte-toi avec le **même compte Google** que sur le Mac. Un lecteur **G:** apparaît.
3. Relance Nooky : il utilise **G:\Mon Drive\Nooky** (le même dossier que le Mac).
4. Vérifie dans **Réglages… → Dossier de synchronisation** : la pastille doit dire
   **Google Drive**.

## 7. (Optionnel) Le chat avec Claude

Comme sur le Mac : crée une clé sur **https://console.anthropic.com** (API Keys), fixe une
limite de dépense mensuelle (Billing), puis **Réglages… → Clé API → Enregistrer**. La clé est
rangée dans le **Gestionnaire d'identification Windows**.

## 8. Lancer au démarrage

**Réglages… → Général → Lancer au démarrage**.

## En cas de souci

- **« link.exe not found »** ou erreur MSVC : la charge « Développement Desktop en C++ »
  n'est pas installée → refais l'étape 1.1.
- **Nooky ne sort pas** : icône nuage → **Ouvrir Nooky**.
- Le journal est ici : `%LOCALAPPDATA%\Nooky\nooky.log`.


---

## Mettre à jour Nooky (les fois suivantes)

Rien à réinstaller : Rust, Node et les outils Visual Studio restent sur ton PC.

1. Décompresse la nouvelle version et remplace le contenu de ton dossier `nooky-desktop` (garde `node_modules` et `target` s'ils existent).
2. Clic droit sur **Mettre-a-jour-Nooky.ps1** → **Exécuter avec PowerShell**.
3. Le script ferme Nooky, reconstruit l'installateur et le lance. Tes tâches, réglages et clé restent en place.

#!/bin/bash
# Double-clique sur ce fichier pour installer une nouvelle version de Nooky.
# Il reconstruit l'app à partir de ce dossier et la remplace dans Applications.
# Tes tâches (Google Drive), tes réglages et ta clé API ne sont pas touchés.
set -e
cd "$(dirname "$0")"
echo "☁️  Mise à jour de Nooky…"
echo "1/3  Dépendances de l'interface"
npm install --no-fund --no-audit
echo "2/3  Construction de l'app (quelques minutes)"
npm run tauri build -- --bundles app
APP="target/release/bundle/macos/Nooky.app"
if [ ! -d "$APP" ]; then echo "❌ L'app n'a pas été construite. Copie le message ci-dessus à Claude."; read -n1 -p "Appuie sur une touche pour fermer."; exit 1; fi
echo "3/3  Remplacement dans Applications"
osascript -e 'tell application "Nooky" to quit' >/dev/null 2>&1 || true
sleep 1
rm -rf "/Applications/Nooky.app"
cp -R "$APP" "/Applications/Nooky.app"
open "/Applications/Nooky.app"
echo "✅ Nooky est à jour."

# Clic droit > "Exécuter avec PowerShell" pour installer une nouvelle version de Nooky.
# Tes tâches (Google Drive), tes réglages et ta clé API ne sont pas touchés.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
Write-Host "Mise a jour de Nooky..."
Get-Process -Name "nooky" -ErrorAction SilentlyContinue | Stop-Process -Force
npm install --no-fund --no-audit
npm run tauri build
$exe = Get-ChildItem "target\release\bundle\nsis\*-setup.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $exe) { Write-Host "L'installateur n'a pas ete construit. Copie le message ci-dessus a Claude."; Read-Host "Entree pour fermer"; exit 1 }
Start-Process $exe.FullName -Wait
Write-Host "Nooky est a jour."
Read-Host "Entree pour fermer"

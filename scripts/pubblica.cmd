@echo off
rem Lanciato dall'Utilita di pianificazione di Windows: aggiorna e pubblica il sito, log in pubblica.log
cd /d "%~dp0.."
"C:\Program Files\nodejs\node.exe" server\publish.js >> pubblica.log 2>&1

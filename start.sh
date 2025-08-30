#!/bin/bash

echo "🚀 Avvio YouTubio Addon..."
echo "📦 Controllo aggiornamenti yt-dlp..."

# Aggiorna yt-dlp all'ultima versione disponibile
echo "🔄 Aggiornamento yt-dlp in corso..."
pip3 install --upgrade "yt-dlp[default,curl-cffi]" --break-system-packages

# Verifica versione installata
YTDLP_VERSION=$(yt-dlp --version)
echo "✅ yt-dlp aggiornato alla versione: $YTDLP_VERSION"

# Avvia l'applicazione Node.js
echo "🚀 Avvio applicazione Node.js..."
exec npm start

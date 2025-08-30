#!/bin/bash

echo "🚀 Loading YouTubio Addon..."
echo "📦 Check for update: yt-dlp..."

# Aggiorna yt-dlp all'ultima versione disponibile
echo "🔄 Updating yt-dlp..."
pip3 install --upgrade "yt-dlp[default,curl-cffi]" --break-system-packages

# Verifica versione installata
YTDLP_VERSION=$(yt-dlp --version)
echo "✅ yt-dlp updated to version: $YTDLP_VERSION"

# Avvia l'applicazione Node.js
echo "🚀 Loading Node.js app..."
exec npm start

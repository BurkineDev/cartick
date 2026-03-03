#!/bin/bash
# Script de génération des clés cryptographiques
# À exécuter UNE FOIS en développement — jamais commiter les clés générées

set -euo pipefail

KEYS_DIR="./keys"
mkdir -p "$KEYS_DIR"

echo "🔑 Génération des clés JWT RS256..."
openssl genrsa -out "$KEYS_DIR/jwt_private.pem" 2048 2>/dev/null
openssl rsa -in "$KEYS_DIR/jwt_private.pem" -pubout -out "$KEYS_DIR/jwt_public.pem" 2>/dev/null
echo "✅ Clés JWT RS256 générées: jwt_private.pem / jwt_public.pem"

echo ""
echo "🔑 Génération des clés QR ECDSA P-256..."
# Génère en SEC1, puis convertit en PKCS8 (format requis par la bibliothèque jose)
openssl ecparam -name prime256v1 -genkey -noout -out "$KEYS_DIR/qr_private_sec1.pem" 2>/dev/null
openssl pkcs8 -topk8 -nocrypt -in "$KEYS_DIR/qr_private_sec1.pem" -out "$KEYS_DIR/qr_private.pem" 2>/dev/null
openssl ec -in "$KEYS_DIR/qr_private_sec1.pem" -pubout -out "$KEYS_DIR/qr_public.pem" 2>/dev/null
rm -f "$KEYS_DIR/qr_private_sec1.pem"
echo "✅ Clés ECDSA P-256 générées (format PKCS8): qr_private.pem / qr_public.pem"

echo ""
echo "📋 Contenu à copier dans votre .env:"
echo ""
echo "JWT_PRIVATE_KEY=\"$(awk 'NR==1{printf $0} NR>1{printf "\\n" $0}' "$KEYS_DIR/jwt_private.pem")\""
echo ""
echo "JWT_PUBLIC_KEY=\"$(awk 'NR==1{printf $0} NR>1{printf "\\n" $0}' "$KEYS_DIR/jwt_public.pem")\""
echo ""
echo "QR_SIGNING_PRIVATE_KEY=\"$(awk 'NR==1{printf $0} NR>1{printf "\\n" $0}' "$KEYS_DIR/qr_private.pem")\""
echo ""
echo "QR_SIGNING_PUBLIC_KEY=\"$(awk 'NR==1{printf $0} NR>1{printf "\\n" $0}' "$KEYS_DIR/qr_public.pem")\""

echo ""
echo "⚠️  IMPORTANT: Les fichiers dans $KEYS_DIR sont dans .gitignore"
echo "   Ne jamais commiter les clés privées !"

#!/bin/bash
# Run this on your server to check Pinterest base64 implementation

echo "🔍 Checking Pinterest Provider Implementation..."
echo ""

# Check if the container is running
echo "1️⃣ Checking if Postiz container is running..."
docker ps | grep postiz

echo ""
echo "2️⃣ Checking Pinterest provider file for base64 code..."
# Look for base64 in the running container
docker exec $(docker ps --filter name=postiz -q | head -1) grep -n "base64Image" /app/libraries/nestjs-libraries/src/integrations/social/pinterest.provider.ts 2>/dev/null || echo "⚠️  Container may not have the updated code yet"

echo ""
echo "3️⃣ Checking recent Pinterest posting logs..."
docker logs $(docker ps --filter name=postiz -q | head -1) 2>&1 | grep -i pinterest | tail -20

echo ""
echo "4️⃣ Check if using latest image..."
docker ps --filter name=postiz --format "{{.Image}}"

echo ""
echo "📋 To update to the latest version with base64 support:"
echo "   cd /path/to/your/compose/file"
echo "   docker-compose pull"
echo "   docker-compose up -d --force-recreate"

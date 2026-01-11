#!/bin/bash
##############################################################################
# Diagnostic Script - Pinterest Posts Without Boards
# 
# This script helps diagnose why the frontend shows posts without boards
# but the cleanup script doesn't find them.
##############################################################################

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Configuration
DB_CONTAINER="postiz-postgres"
DB_NAME="postiz-db-local"
DB_USER="postiz-user"

clear
echo -e "${CYAN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║     Pinterest Posts Diagnostics                ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════╝${NC}"
echo ""

# Check if database container is running
if ! docker ps | grep -q "$DB_CONTAINER"; then
    echo -e "${RED}✗${NC} Container '$DB_CONTAINER' is not running!"
    exit 1
fi

echo -e "${GREEN}✓${NC} Database: $DB_CONTAINER"
echo ""

echo "1️⃣  Checking all Pinterest integration provider identifiers..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" << 'EOF'
SELECT DISTINCT "providerIdentifier", COUNT(*) as count
FROM "Integration"
WHERE "providerIdentifier" ILIKE '%pinterest%'
GROUP BY "providerIdentifier";
EOF

echo ""
echo "2️⃣  Checking Pinterest posts by state..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" << 'EOF'
SELECT 
    p.state,
    COUNT(*) as count,
    COUNT(CASE WHEN p."deletedAt" IS NOT NULL THEN 1 END) as deleted_count
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE i."providerIdentifier" ILIKE '%pinterest%'
    AND p."parentPostId" IS NULL
GROUP BY p.state
ORDER BY count DESC;
EOF

echo ""
echo "3️⃣  Sample Pinterest posts settings (first 5)..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" << 'EOF'
SELECT 
    p.id,
    p.state,
    i.name as integration_name,
    i."providerIdentifier",
    p.settings,
    p."deletedAt" IS NOT NULL as is_deleted
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE i."providerIdentifier" ILIKE '%pinterest%'
    AND p."parentPostId" IS NULL
ORDER BY p."createdAt" DESC
LIMIT 5;
EOF

echo ""
echo "4️⃣  Posts with NULL or empty settings..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" << 'EOF'
SELECT 
    p.state,
    COUNT(*) as count
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE i."providerIdentifier" ILIKE '%pinterest%'
    AND p."parentPostId" IS NULL
    AND p."deletedAt" IS NULL
    AND (p.settings IS NULL OR p.settings = '' OR p.settings = '{}')
GROUP BY p.state;
EOF

echo ""
echo "5️⃣  Posts with settings but NO 'board' field..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" << 'EOF'
SELECT 
    p.state,
    COUNT(*) as count
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE i."providerIdentifier" ILIKE '%pinterest%'
    AND p."parentPostId" IS NULL
    AND p."deletedAt" IS NULL
    AND p.settings IS NOT NULL
    AND p.settings != ''
    AND p.settings != '{}'
    AND p.settings NOT LIKE '%"board"%'
GROUP BY p.state;
EOF

echo ""
echo "6️⃣  Posts with empty or null 'board' value..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" << 'EOF'
SELECT 
    p.state,
    COUNT(*) as count
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE i."providerIdentifier" ILIKE '%pinterest%'
    AND p."parentPostId" IS NULL
    AND p."deletedAt" IS NULL
    AND (p.settings LIKE '%"board":""%' OR p.settings LIKE '%"board":null%')
GROUP BY p.state;
EOF

echo ""
echo "7️⃣  ALL Pinterest posts without valid board (any state)..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" << 'EOF'
SELECT 
    p.state,
    COUNT(*) as count,
    MIN(p."publishDate")::date as earliest_date,
    MAX(p."publishDate")::date as latest_date
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE i."providerIdentifier" ILIKE '%pinterest%'
    AND p."parentPostId" IS NULL
    AND p."deletedAt" IS NULL
    AND (p.settings IS NULL 
        OR p.settings = '' 
        OR p.settings = '{}' 
        OR p.settings NOT LIKE '%"board"%'
        OR p.settings LIKE '%"board":""%'
        OR p.settings LIKE '%"board":null%')
GROUP BY p.state
ORDER BY count DESC;
EOF

echo ""
echo "8️⃣  Sample Pinterest posts WITHOUT boards..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" << 'EOF'
SELECT 
    p.id,
    p.state,
    p."publishDate"::date as publish_date,
    i.name as integration_name,
    CASE 
        WHEN p.settings IS NULL THEN 'NULL'
        WHEN p.settings = '' THEN 'EMPTY STRING'
        WHEN p.settings = '{}' THEN 'EMPTY JSON'
        WHEN p.settings NOT LIKE '%"board"%' THEN 'NO BOARD FIELD'
        WHEN p.settings LIKE '%"board":""%' THEN 'EMPTY BOARD'
        WHEN p.settings LIKE '%"board":null%' THEN 'NULL BOARD'
        ELSE 'OTHER'
    END as board_status,
    LEFT(p.settings, 100) as settings_preview
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE i."providerIdentifier" ILIKE '%pinterest%'
    AND p."parentPostId" IS NULL
    AND p."deletedAt" IS NULL
    AND (p.settings IS NULL 
        OR p.settings = '' 
        OR p.settings = '{}' 
        OR p.settings NOT LIKE '%"board"%'
        OR p.settings LIKE '%"board":""%'
        OR p.settings LIKE '%"board":null%')
ORDER BY p."createdAt" DESC
LIMIT 10;
EOF

echo ""
echo -e "${GREEN}✓ Diagnostics complete!${NC}"
echo ""
echo "Review the results above to understand:"
echo "  • What provider identifier is actually used for Pinterest"
echo "  • What states the posts without boards have"
echo "  • What the settings field actually contains"
echo ""

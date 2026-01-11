#!/bin/bash
##############################################################################
# Pinterest Board Validation - Check if stored board IDs still exist
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
echo -e "${CYAN}║     Pinterest Board Validation Check          ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════╝${NC}"
echo ""

# Check if database container is running
if ! docker ps | grep -q "$DB_CONTAINER"; then
    echo -e "${RED}✗${NC} Container '$DB_CONTAINER' is not running!"
    exit 1
fi

echo -e "${GREEN}✓${NC} Database: $DB_CONTAINER"
echo ""

echo "Extracting all unique Pinterest board IDs from posts..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" << 'EOF'
SELECT DISTINCT
    CASE 
        WHEN p.settings IS NULL THEN 'NULL'
        WHEN p.settings = '' THEN 'EMPTY'
        WHEN p.settings = '{}' THEN 'EMPTY_JSON'
        ELSE SUBSTRING(p.settings FROM '"board":"([^"]+)"')
    END as board_id,
    COUNT(*) as post_count,
    MIN(p."publishDate")::date as earliest_post,
    MAX(p."publishDate")::date as latest_post,
    COUNT(CASE WHEN p.state = 'QUEUE' AND p."deletedAt" IS NULL THEN 1 END) as active_queue,
    COUNT(CASE WHEN p.state = 'DRAFT' AND p."deletedAt" IS NULL THEN 1 END) as active_draft
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE i."providerIdentifier" = 'pinterest'
    AND p."parentPostId" IS NULL
GROUP BY board_id
ORDER BY post_count DESC;
EOF

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo -e "${YELLOW}Next Steps:${NC}"
echo "1. Copy the board IDs above"
echo "2. Check them against your current Pinterest boards"
echo "3. Boards that no longer exist will cause validation errors in frontend"
echo ""
echo "To check current boards, run this in Postiz container:"
echo -e "${CYAN}# Get access token from Integration table${NC}"
echo -e "${CYAN}# Then query Pinterest API: GET https://api.pinterest.com/v5/boards${NC}"
echo ""

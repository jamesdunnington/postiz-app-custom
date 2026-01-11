#!/bin/bash
##############################################################################
# Postiz Invalid Posts Cleanup
# 
# Finds and deletes posts with:
#   - Missing images (any platform)
#   - Missing board ID (Pinterest only)
#
# Usage:
#   ./cleanup-invalid-posts.sh              # Interactive mode
#   ./cleanup-invalid-posts.sh --dry-run    # Preview without deleting
#   ./cleanup-invalid-posts.sh --auto       # Auto-delete without prompts
##############################################################################

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Configuration (edit these if your container names are different)
DB_CONTAINER="postiz-postgres"
DB_NAME="postiz-db-local"
DB_USER="postiz-user"

# Parse arguments
DRY_RUN=""
AUTO_CONFIRM=""
if [[ "$1" == "--dry-run" ]]; then
    DRY_RUN="true"
fi
if [[ "$1" == "--auto" ]]; then
    AUTO_CONFIRM="true"
fi

clear
echo -e "${CYAN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║     Postiz Invalid Posts Cleanup              ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════╝${NC}"
echo ""

# Check if Docker is available
if ! command -v docker &> /dev/null; then
    echo -e "${RED}✗${NC} Docker not found. Please install Docker first."
    exit 1
fi

# Check if database container is running
if ! docker ps | grep -q "$DB_CONTAINER"; then
    echo -e "${RED}✗${NC} Container '$DB_CONTAINER' is not running!"
    echo ""
    echo "Available containers:"
    docker ps --format "  • {{.Names}}"
    exit 1
fi

echo -e "${GREEN}✓${NC} Database: $DB_CONTAINER"
echo ""

# Function to run SQL query
run_query() {
    docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -c "$1" 2>/dev/null | xargs || echo "0"
}

# Show mode
echo "Configuration:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ -n "$DRY_RUN" ]; then
    echo -e "  Mode: ${YELLOW}DRY RUN (preview only)${NC}"
elif [ -n "$AUTO_CONFIRM" ]; then
    echo -e "  Mode: ${RED}AUTO-DELETE (no confirmation)${NC}"
else
    echo -e "  Mode: ${GREEN}INTERACTIVE${NC}"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "Analyzing database..."

# Count posts without images
POSTS_WITHOUT_IMAGES=$(run_query "SELECT COUNT(*) FROM \"Post\" WHERE \"deletedAt\" IS NULL AND \"parentPostId\" IS NULL AND state IN ('QUEUE', 'DRAFT') AND (image IS NULL OR image = '' OR image = '[]');")

# Count Pinterest posts without board
POSTS_WITHOUT_BOARD=$(run_query "SELECT COUNT(*) FROM \"Post\" p JOIN \"Integration\" i ON p.\"integrationId\" = i.id WHERE p.\"deletedAt\" IS NULL AND p.\"parentPostId\" IS NULL AND p.state IN ('QUEUE', 'DRAFT') AND i.\"providerIdentifier\" = 'pinterest' AND (p.settings IS NULL OR p.settings = '' OR p.settings = '{}' OR p.settings NOT LIKE '%\"board\"%' OR p.settings LIKE '%\"board\":\"\"%' OR p.settings LIKE '%\"board\":null%');")

# Get total posts for context
TOTAL_POSTS=$(run_query "SELECT COUNT(*) FROM \"Post\" WHERE \"deletedAt\" IS NULL;")
TOTAL_SCHEDULED=$(run_query "SELECT COUNT(*) FROM \"Post\" WHERE \"deletedAt\" IS NULL AND state IN ('QUEUE', 'DRAFT');")

echo ""
echo "Current Statistics:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Total posts: $TOTAL_POSTS"
echo "  Scheduled/Draft posts: $TOTAL_SCHEDULED"
echo -e "  Posts without images: ${YELLOW}$POSTS_WITHOUT_IMAGES${NC}"
echo -e "  Pinterest posts without board: ${YELLOW}$POSTS_WITHOUT_BOARD${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

TOTAL_INVALID=$((POSTS_WITHOUT_IMAGES + POSTS_WITHOUT_BOARD))

if [ "$TOTAL_INVALID" -eq 0 ]; then
    echo -e "${GREEN}✓${NC} No invalid posts found! Your schedule is clean."
    exit 0
fi

echo -e "${YELLOW}⚠${NC} Found $TOTAL_INVALID invalid posts"
echo ""

# Show details
SHOW_DETAILS="n"
if [ -z "$AUTO_CONFIRM" ]; then
    echo "Would you like to see the details? (y/n)"
    read -r SHOW_DETAILS
fi

if [ "$SHOW_DETAILS" = "y" ] || [ -n "$DRY_RUN" ]; then
    echo ""
    echo "Posts Without Images:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" << 'EOF'
SELECT 
    i.name as integration,
    COUNT(*) as count,
    MIN(p."publishDate")::date as earliest_date,
    MAX(p."publishDate")::date as latest_date
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE p."deletedAt" IS NULL 
    AND p."parentPostId" IS NULL
    AND p.state IN ('QUEUE', 'DRAFT')
    AND (p.image IS NULL OR p.image = '' OR p.image = '[]')
GROUP BY i.name
ORDER BY count DESC;
EOF

    echo ""
    echo "Pinterest Posts Without Board ID:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" << 'EOF'
SELECT 
    i.name as integration,
    COUNT(*) as count,
    MIN(p."publishDate")::date as earliest_date,
    MAX(p."publishDate")::date as latest_date
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE p."deletedAt" IS NULL 
    AND p."parentPostId" IS NULL
    AND p.state IN ('QUEUE', 'DRAFT')
    AND i."providerIdentifier" = 'pinterest'
    AND (p.settings IS NULL 
        OR p.settings = '' 
        OR p.settings = '{}' 
        OR p.settings NOT LIKE '%"board"%'
        OR p.settings LIKE '%"board":""%'
        OR p.settings LIKE '%"board":null%')
GROUP BY i.name
ORDER BY count DESC;
EOF
fi

# Exit if dry-run
if [ -n "$DRY_RUN" ]; then
    echo ""
    echo -e "${YELLOW}This was a DRY RUN - nothing was deleted${NC}"
    echo ""
    echo "To actually delete, run:"
    echo -e "  ${CYAN}./cleanup-invalid-posts.sh${NC}"
    exit 0
fi

# Confirm deletion
echo ""
if [ -z "$AUTO_CONFIRM" ]; then
    echo -e "${YELLOW}⚠ WARNING:${NC} This will soft-delete these posts!"
    echo "  • $POSTS_WITHOUT_IMAGES posts without images"
    if [ "$POSTS_WITHOUT_BOARD" -gt 0 ]; then
        echo "  • $POSTS_WITHOUT_BOARD Pinterest posts without board ID"
    fi
    echo ""
    echo "Type 'yes' to confirm:"
    read -r CONFIRM
    
    if [ "$CONFIRM" != "yes" ]; then
        echo -e "${RED}✗${NC} Cancelled."
        exit 0
    fi
fi

# Create log file with timestamp
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
LOG_FILE="$SCRIPT_DIR/cleanup_invalid_${TIMESTAMP}.txt"

echo ""
echo "Running cleanup..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Delete posts without images
if [ "$POSTS_WITHOUT_IMAGES" -gt 0 ]; then
    echo "Deleting posts without images..."
    docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c \
        "UPDATE \"Post\" SET \"deletedAt\" = NOW() WHERE \"deletedAt\" IS NULL AND \"parentPostId\" IS NULL AND state IN ('QUEUE', 'DRAFT') AND (image IS NULL OR image = '' OR image = '[]');" >> "$LOG_FILE" 2>&1
    echo -e "  ${GREEN}✓${NC} Deleted $POSTS_WITHOUT_IMAGES posts without images"
fi

# Delete Pinterest posts without board
if [ "$POSTS_WITHOUT_BOARD" -gt 0 ]; then
    echo "Deleting Pinterest posts without board ID..."
    docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c \
        "UPDATE \"Post\" p SET \"deletedAt\" = NOW() FROM \"Integration\" i WHERE p.\"integrationId\" = i.id AND p.\"deletedAt\" IS NULL AND p.\"parentPostId\" IS NULL AND p.state IN ('QUEUE', 'DRAFT') AND i.\"providerIdentifier\" = 'pinterest' AND (p.settings IS NULL OR p.settings = '' OR p.settings = '{}' OR p.settings NOT LIKE '%\"board\"%' OR p.settings LIKE '%\"board\":\"\"%' OR p.settings LIKE '%\"board\":null%');" >> "$LOG_FILE" 2>&1
    echo -e "  ${GREEN}✓${NC} Deleted $POSTS_WITHOUT_BOARD Pinterest posts without board ID"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Show final statistics
echo ""
echo "Final Statistics:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
FINAL_POSTS=$(run_query "SELECT COUNT(*) FROM \"Post\" WHERE \"deletedAt\" IS NULL;")
FINAL_SCHEDULED=$(run_query "SELECT COUNT(*) FROM \"Post\" WHERE \"deletedAt\" IS NULL AND state IN ('QUEUE', 'DRAFT');")
echo "  Total posts remaining: $FINAL_POSTS"
echo "  Scheduled/Draft posts: $FINAL_SCHEDULED"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo -e "${GREEN}✓ Cleanup complete!${NC}"
echo ""
echo -e "${CYAN}Note:${NC} Posts were soft-deleted (deletedAt set). They still exist in the database."
echo -e "${GREEN}Full output saved to:${NC} $LOG_FILE"
echo ""

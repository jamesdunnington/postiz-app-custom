#!/bin/bash
##############################################################################
# Validate Pinterest Boards Against Live API
# 
# This script fetches current boards from Pinterest API and compares them
# with board IDs stored in posts to find orphaned/invalid boards
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
BACKEND_CONTAINER="postiz"

clear
echo -e "${CYAN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   Pinterest Board Validation Against API      ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════╝${NC}"
echo ""

# Check containers
if ! docker ps | grep -q "$DB_CONTAINER"; then
    echo -e "${RED}✗${NC} Container '$DB_CONTAINER' not running!"
    exit 1
fi

if ! docker ps | grep -q "$BACKEND_CONTAINER"; then
    echo -e "${RED}✗${NC} Container '$BACKEND_CONTAINER' not running!"
    exit 1
fi

echo -e "${GREEN}✓${NC} Containers running"
echo ""

# Get Pinterest integration access token
echo "Fetching Pinterest access token from database..."
ACCESS_TOKEN=$(docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -c \
    "SELECT \"token\" FROM \"Integration\" WHERE \"providerIdentifier\" = 'pinterest' AND disabled = false LIMIT 1;" | xargs)

if [ -z "$ACCESS_TOKEN" ]; then
    echo -e "${RED}✗${NC} No Pinterest integration found or token is empty"
    exit 1
fi

echo -e "${GREEN}✓${NC} Found Pinterest access token"
echo ""

# Fetch current boards from Pinterest API (with pagination)
echo "Fetching current boards from Pinterest API..."
TEMP_FILE=$(mktemp)
ALL_BOARDS_FILE=$(mktemp)

# Pinterest API uses cursor-based pagination
BOOKMARK=""
PAGE=1

echo -n "  Fetching boards"
while true; do
    # Make API request
    if [ -z "$BOOKMARK" ]; then
        curl -s -X GET 'https://api.pinterest.com/v5/boards?page_size=250' \
            -H "Authorization: Bearer $ACCESS_TOKEN" > "$TEMP_FILE"
    else
        curl -s -X GET "https://api.pinterest.com/v5/boards?page_size=250&bookmark=$BOOKMARK" \
            -H "Authorization: Bearer $ACCESS_TOKEN" > "$TEMP_FILE"
    fi
    
    # Check for errors
    if grep -q '"code"' "$TEMP_FILE" && grep -q '"message"' "$TEMP_FILE"; then
        echo ""
        echo -e "${RED}✗${NC} Pinterest API error:"
        cat "$TEMP_FILE"
        rm -f "$TEMP_FILE" "$ALL_BOARDS_FILE"
        exit 1
    fi
    
    # Extract board IDs from this page
    PAGE_BOARDS=$(cat "$TEMP_FILE" | grep -o '"id":"[0-9]*"' | cut -d'"' -f4)
    
    if [ -z "$PAGE_BOARDS" ]; then
        break
    fi
    
    echo "$PAGE_BOARDS" >> "$ALL_BOARDS_FILE"
    echo -n "."
    
    # Check if there's a next page
    BOOKMARK=$(cat "$TEMP_FILE" | grep -o '"bookmark":"[^"]*"' | cut -d'"' -f4 | head -n 1)
    
    if [ -z "$BOOKMARK" ]; then
        break
    fi
    
    PAGE=$((PAGE + 1))
done

echo ""
API_BOARD_IDS=$(cat "$ALL_BOARDS_FILE" | sort)
API_BOARD_COUNT=$(cat "$ALL_BOARDS_FILE" | wc -l)

echo -e "${GREEN}✓${NC} Found $API_BOARD_COUNT boards in Pinterest account (fetched $PAGE pages)"
echo ""

# Save API board IDs to temp file
echo "$API_BOARD_IDS" > "$TEMP_FILE.api"

# Get unique board IDs from database
echo "Extracting board IDs from database posts..."
DB_BOARD_IDS=$(docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -c \
    "SELECT DISTINCT SUBSTRING(p.settings FROM '\"board\":\"([^\"]+)\"') as board_id
     FROM \"Post\" p
     JOIN \"Integration\" i ON p.\"integrationId\" = i.id
     WHERE i.\"providerIdentifier\" = 'pinterest'
       AND p.\"parentPostId\" IS NULL
       AND p.\"deletedAt\" IS NULL
       AND p.state IN ('QUEUE', 'DRAFT')
       AND p.settings IS NOT NULL
     ORDER BY board_id;" | xargs)

echo "$DB_BOARD_IDS" | tr ' ' '\n' > "$TEMP_FILE.db"
DB_BOARD_COUNT=$(cat "$TEMP_FILE.db" | grep -v '^$' | wc -l)

echo -e "${GREEN}✓${NC} Found $DB_BOARD_COUNT unique boards in database posts"
echo ""

# Find orphaned boards (in DB but not in API)
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${YELLOW}Orphaned Boards (No Longer Exist in Pinterest):${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

ORPHANED=0
while IFS= read -r board_id; do
    if [ ! -z "$board_id" ]; then
        if ! grep -q "^${board_id}$" "$TEMP_FILE.api"; then
            # Count posts using this board
            POST_COUNT=$(docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -c \
                "SELECT COUNT(*) FROM \"Post\" p
                 JOIN \"Integration\" i ON p.\"integrationId\" = i.id
                 WHERE i.\"providerIdentifier\" = 'pinterest'
                   AND p.\"deletedAt\" IS NULL
                   AND p.state IN ('QUEUE', 'DRAFT')
                   AND p.settings LIKE '%\"board\":\"${board_id}\"%';" | xargs)
            
            echo "  Board ID: $board_id ($POST_COUNT active posts)"
            ORPHANED=$((ORPHANED + POST_COUNT))
        fi
    fi
done < "$TEMP_FILE.db"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${YELLOW}Summary:${NC}"
echo "  Total boards in Pinterest: $API_BOARD_COUNT"
echo "  Total boards in database: $DB_BOARD_COUNT"
echo -e "  ${RED}Posts with orphaned boards: $ORPHANED${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Cleanup
rm -f "$TEMP_FILE" "$TEMP_FILE.api" "$TEMP_FILE.db" "$ALL_BOARDS_FILE"

if [ "$ORPHANED" -gt 0 ]; then
    echo -e "${YELLOW}⚠ Warning:${NC} $ORPHANED posts reference boards that no longer exist!"
    echo ""
    echo "Options:"
    echo "  1. Delete these posts (they'll fail to publish anyway)"
    echo "  2. Reassign them to a valid board ID"
    echo "  3. Manually fix them in the Postiz frontend"
    echo ""
    echo "To see which integration has the most orphaned posts:"
    echo -e "${CYAN}  ./cleanup-invalid-posts.sh --dry-run${NC}"
else
    echo -e "${GREEN}✓${NC} All posts have valid board IDs!"
fi
echo ""

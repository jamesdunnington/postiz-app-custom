#!/bin/bash
##############################################################################
# Reassign Pinterest Posts to Random Valid Boards
# 
# This script finds posts with invalid/orphaned board IDs OR missing board IDs
# and reassigns them to random valid boards from the SAME Pinterest integration
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

# Parse arguments
DRY_RUN=""
if [[ "$1" == "--dry-run" ]]; then
    DRY_RUN="true"
fi

clear
echo -e "${CYAN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   Reassign Pinterest Boards                    ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════╝${NC}"
echo ""

# Check containers
if ! docker ps | grep -q "$DB_CONTAINER"; then
    echo -e "${RED}✗${NC} Container '$DB_CONTAINER' not running!"
    exit 1
fi

echo -e "${GREEN}✓${NC} Database: $DB_CONTAINER"
echo ""

# Show mode
if [ -n "$DRY_RUN" ]; then
    echo -e "Mode: ${YELLOW}DRY RUN (preview only)${NC}"
else
    echo -e "Mode: ${RED}ACTUAL UPDATE${NC}"
fi
echo ""

# Get all Pinterest integrations
echo "Fetching Pinterest integrations..."
INTEGRATIONS=$(docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A -F'|' -c \
    "SELECT id, \"token\", name FROM \"Integration\" WHERE \"providerIdentifier\" = 'pinterest' AND disabled = false;" | grep -v '^$')

if [ -z "$INTEGRATIONS" ]; then
    echo -e "${RED}✗${NC} No Pinterest integrations found"
    exit 1
fi

INTEGRATION_COUNT=$(echo "$INTEGRATIONS" | wc -l)
echo -e "${GREEN}✓${NC} Found $INTEGRATION_COUNT Pinterest integration(s)"
echo ""

# Fetch boards for each integration
echo "Fetching valid boards for each integration..."
TEMP_FILE=$(mktemp)
declare -A INTEGRATION_BOARDS

while IFS='|' read -r integration_id access_token integration_name; do
    if [ -z "$integration_id" ] || [ -z "$access_token" ]; then
        continue
    fi
    
    echo -n "  $integration_name: "
    
    ALL_BOARDS_FILE=$(mktemp)
    BOOKMARK=""
    
    while true; do
        if [ -z "$BOOKMARK" ]; then
            curl -s -X GET 'https://api.pinterest.com/v5/boards?page_size=250' \
                -H "Authorization: Bearer $access_token" > "$TEMP_FILE"
        else
            curl -s -X GET "https://api.pinterest.com/v5/boards?page_size=250&bookmark=$BOOKMARK" \
                -H "Authorization: Bearer $access_token" > "$TEMP_FILE"
        fi
        
        if grep -q '"code"' "$TEMP_FILE" && grep -q '"message"' "$TEMP_FILE"; then
            echo -e "${RED}✗ API error${NC}"
            break
        fi
        
        PAGE_BOARDS=$(cat "$TEMP_FILE" | grep -o '"id":"[0-9]*"' | cut -d'"' -f4)
        
        if [ -z "$PAGE_BOARDS" ]; then
            break
        fi
        
        echo "$PAGE_BOARDS" >> "$ALL_BOARDS_FILE"
        
        BOOKMARK=$(cat "$TEMP_FILE" | grep -o '"bookmark":"[^"]*"' | cut -d'"' -f4 | head -n 1)
        
        if [ -z "$BOOKMARK" ]; then
            break
        fi
    done
    
    BOARD_COUNT=$(cat "$ALL_BOARDS_FILE" 2>/dev/null | wc -l)
    echo -e "${GREEN}$BOARD_COUNT boards${NC}"
    
    # Store boards for this integration (space-separated)
    INTEGRATION_BOARDS[$integration_id]=$(cat "$ALL_BOARDS_FILE" | tr '\n' ' ')
    rm -f "$ALL_BOARDS_FILE"
done <<< "$INTEGRATIONS"

echo ""

# Get posts with orphaned or missing boards (grouped by integration)
echo "Finding posts with orphaned or missing boards..."
ORPHANED_POSTS=$(docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A -F'|' -c \
    "SELECT 
        p.id,
        COALESCE(SUBSTRING(p.settings FROM '\"board\":\"([^\"]+)\"'), '') as board_id,
        i.id as integration_id,
        i.name as integration_name
     FROM \"Post\" p
     JOIN \"Integration\" i ON p.\"integrationId\" = i.id
     WHERE i.\"providerIdentifier\" = 'pinterest'
       AND p.\"parentPostId\" IS NULL
       AND p.\"deletedAt\" IS NULL
       AND p.state IN ('QUEUE', 'DRAFT')
       AND i.disabled = false;" | grep -v '^$')

# Count orphaned and missing board posts first
TEMP_ORPHANED_COUNT=0
TEMP_MISSING_COUNT=0
declare -A ORPHANED_BY_INTEGRATION
declare -A MISSING_BY_INTEGRATION

while IFS='|' read -r post_id old_board_id integration_id integration_name; do
    if [ -z "$post_id" ] || [ -z "$integration_id" ]; then
        continue
    fi
    
    # Get valid boards for this integration
    VALID_BOARDS="${INTEGRATION_BOARDS[$integration_id]}"
    
    if [ -z "$VALID_BOARDS" ]; then
        if [ -z "$old_board_id" ]; then
            TEMP_MISSING_COUNT=$((TEMP_MISSING_COUNT + 1))
            MISSING_BY_INTEGRATION[$integration_name]=$((${MISSING_BY_INTEGRATION[$integration_name]:-0} + 1))
        else
            TEMP_ORPHANED_COUNT=$((TEMP_ORPHANED_COUNT + 1))
            ORPHANED_BY_INTEGRATION[$integration_name]=$((${ORPHANED_BY_INTEGRATION[$integration_name]:-0} + 1))
        fi
        continue
    fi
    
    # Check if board is missing or orphaned
    if [ -z "$old_board_id" ]; then
        TEMP_MISSING_COUNT=$((TEMP_MISSING_COUNT + 1))
        MISSING_BY_INTEGRATION[$integration_name]=$((${MISSING_BY_INTEGRATION[$integration_name]:-0} + 1))
    else
        # Check if board still exists for this integration
        BOARD_EXISTS=false
        for valid_board in $VALID_BOARDS; do
            if [ "$old_board_id" == "$valid_board" ]; then
                BOARD_EXISTS=true
                break
            fi
        done
        
        if [ "$BOARD_EXISTS" = false ]; then
            TEMP_ORPHANED_COUNT=$((TEMP_ORPHANED_COUNT + 1))
            ORPHANED_BY_INTEGRATION[$integration_name]=$((${ORPHANED_BY_INTEGRATION[$integration_name]:-0} + 1))
        fi
    fi
done <<< "$ORPHANED_POSTS"

TEMP_TOTAL_COUNT=$((TEMP_ORPHANED_COUNT + TEMP_MISSING_COUNT))
echo -e "${YELLOW}⚠${NC} Found $TEMP_TOTAL_COUNT posts needing board assignment"
if [ "$TEMP_ORPHANED_COUNT" -gt 0 ]; then
    echo "    • $TEMP_ORPHANED_COUNT with orphaned boards"
fi
if [ "$TEMP_MISSING_COUNT" -gt 0 ]; then
    echo "    • $TEMP_MISSING_COUNT with missing boards"
fi
echo ""

# Show breakdown by integration
if [ "$TEMP_TOTAL_COUNT" -gt 0 ]; then
    echo "Breakdown by integration:"
    
    # Combine all integration names
    declare -A ALL_INTEGRATIONS
    for integration_name in "${!ORPHANED_BY_INTEGRATION[@]}"; do
        ALL_INTEGRATIONS[$integration_name]=1
    done
    for integration_name in "${!MISSING_BY_INTEGRATION[@]}"; do
        ALL_INTEGRATIONS[$integration_name]=1
    done
    
    for integration_name in "${!ALL_INTEGRATIONS[@]}"; do
        ORPHANED=${ORPHANED_BY_INTEGRATION[$integration_name]:-0}
        MISSING=${MISSING_BY_INTEGRATION[$integration_name]:-0}
        TOTAL=$((ORPHANED + MISSING))
        
        echo -n "  • $integration_name: $TOTAL posts"
        if [ "$ORPHANED" -gt 0 ] && [ "$MISSING" -gt 0 ]; then
            echo " ($ORPHANED orphaned, $MISSING missing)"
        elif [ "$ORPHANED" -gt 0 ]; then
            echo " ($ORPHANED orphaned)"
        elif [ "$MISSING" -gt 0 ]; then
            echo " ($MISSING missing)"
        else
            echo ""
        fi
    done
    echo ""
fi

if [ "$TEMP_TOTAL_COUNT" -eq 0 ]; then
    echo -e "${GREEN}✓${NC} All posts already have valid board IDs!"
    rm -f "$TEMP_FILE"
    exit 0
fi

# Ask for confirmation before proceeding
if [ -z "$DRY_RUN" ]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${YELLOW}⚠ WARNING:${NC} This will reassign boards for $TEMP_TOTAL_COUNT posts!"
    echo ""
    echo "Each post will be assigned to a RANDOM valid board from"
    echo "the SAME Pinterest integration (account)."
    echo ""
    echo -e "${RED}This action cannot be undone!${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Type 'yes' to proceed with random board assignment:"
    read -r CONFIRM
    
    if [ "$CONFIRM" != "yes" ]; then
        echo ""
        echo -e "${RED}✗${NC} Cancelled. No posts were updated."
        echo ""
        echo "To preview changes without updating, run:"
        echo -e "  ${CYAN}./reassign-pinterest-boards.sh --dry-run${NC}"
        echo ""
        rm -f "$TEMP_FILE"
        exit 0
    fi
    echo ""
fi

ORPHANED_COUNT=0
MISSING_COUNT=0
UPDATED_COUNT=0

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Processing posts..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

while IFS='|' read -r post_id old_board_id integration_id integration_name; do
    if [ -z "$post_id" ] || [ -z "$integration_id" ]; then
        continue
    fi
    
    # Get valid boards for this specific integration
    VALID_BOARDS="${INTEGRATION_BOARDS[$integration_id]}"
    
    if [ -z "$VALID_BOARDS" ]; then
        echo -e "  ${RED}✗${NC} $integration_name - No valid boards available (skipping)"
        continue
    fi
    
    # Convert to array
    BOARD_ARRAY=($VALID_BOARDS)
    
    # Check if board is missing or orphaned
    NEEDS_UPDATE=false
    IS_MISSING=false
    
    if [ -z "$old_board_id" ]; then
        NEEDS_UPDATE=true
        IS_MISSING=true
        MISSING_COUNT=$((MISSING_COUNT + 1))
    else
        # Check if board still exists for this integration
        BOARD_EXISTS=false
        for valid_board in "${BOARD_ARRAY[@]}"; do
            if [ "$old_board_id" == "$valid_board" ]; then
                BOARD_EXISTS=true
                break
            fi
        done
        
        if [ "$BOARD_EXISTS" = false ]; then
            NEEDS_UPDATE=true
            ORPHANED_COUNT=$((ORPHANED_COUNT + 1))
        fi
    fi
    
    if [ "$NEEDS_UPDATE" = false ]; then
        continue
    fi
    
    # Select random board from THIS integration's boards only
    RANDOM_INDEX=$((RANDOM % ${#BOARD_ARRAY[@]}))
    NEW_BOARD_ID="${BOARD_ARRAY[$RANDOM_INDEX]}"
    
    if [ -n "$DRY_RUN" ]; then
        echo "  [DRY RUN] $integration_name - Post $post_id"
        if [ "$IS_MISSING" = true ]; then
            echo "    Missing board → New board: $NEW_BOARD_ID"
        else
            echo "    Old board: $old_board_id → New board: $NEW_BOARD_ID"
        fi
    else
        # Update the board ID in settings JSON
        if [ "$IS_MISSING" = true ]; then
            # Add board field if missing
            docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c \
                "UPDATE \"Post\" 
                 SET settings = CASE 
                     WHEN settings IS NULL THEN '{\"board\":\"${NEW_BOARD_ID}\"}' 
                     WHEN settings::text LIKE '%\"board\":%' THEN regexp_replace(settings, '\"board\":\"[^\"]*\"', '\"board\":\"${NEW_BOARD_ID}\"')
                     ELSE regexp_replace(settings::text, '}$', ',\"board\":\"${NEW_BOARD_ID}\"}')::jsonb
                 END
                 WHERE id = '${post_id}';" > /dev/null 2>&1
            
            echo -e "  ${GREEN}✓${NC} Updated $integration_name - Post $post_id"
            echo "    Added board: $NEW_BOARD_ID"
        else
            # Replace existing board field
            docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c \
                "UPDATE \"Post\" 
                 SET settings = regexp_replace(settings, '\"board\":\"${old_board_id}\"', '\"board\":\"${NEW_BOARD_ID}\"')
                 WHERE id = '${post_id}';" > /dev/null 2>&1
            
            echo -e "  ${GREEN}✓${NC} Updated $integration_name - Post $post_id"
            echo "    $old_board_id → $NEW_BOARD_ID"
        fi
        UPDATED_COUNT=$((UPDATED_COUNT + 1))
    fi
done <<< "$ORPHANED_POSTS"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Summary:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Pinterest integrations: $INTEGRATION_COUNT"
if [ "$ORPHANED_COUNT" -gt 0 ]; then
    echo "  Posts with orphaned boards: $ORPHANED_COUNT"
fi
if [ "$MISSING_COUNT" -gt 0 ]; then
    echo "  Posts with missing boards: $MISSING_COUNT"
fi
TOTAL_FOUND=$((ORPHANED_COUNT + MISSING_COUNT))
if [ "$TOTAL_FOUND" -gt 0 ]; then
    echo "  Total posts needing update: $TOTAL_FOUND"
fi

if [ -n "$DRY_RUN" ]; then
    echo ""
    echo -e "${YELLOW}This was a DRY RUN - nothing was updated${NC}"
    echo ""
    echo "To actually reassign boards, run:"
    echo -e "  ${CYAN}./reassign-pinterest-boards.sh${NC}"
else
    echo "  Posts updated: $UPDATED_COUNT"
    echo ""
    if [ "$UPDATED_COUNT" -gt 0 ]; then
        echo -e "${GREEN}✓ Successfully reassigned boards!${NC}"
    else
        echo -e "${GREEN}✓ All posts already have valid board IDs!${NC}"
    fi
fi
echo ""

# Cleanup
rm -f "$TEMP_FILE"

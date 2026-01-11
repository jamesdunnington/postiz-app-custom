#!/bin/bash
##############################################################################
# Pinterest Error Checker - View detailed Pinterest posting errors
##############################################################################

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
NC='\033[0m'

# Configuration
DB_CONTAINER="postiz-postgres"
DB_NAME="postiz-db-local"
DB_USER="postiz-user"

# Parse arguments
LIMIT=10
POST_ID=""
ORG_ID=""
SHOW_BODY=false

while [[ $# -gt 0 ]]; do
    case $1 in
        -l|--limit)
            LIMIT="$2"
            shift 2
            ;;
        -p|--post-id)
            POST_ID="$2"
            shift 2
            ;;
        -o|--org-id)
            ORG_ID="$2"
            shift 2
            ;;
        -b|--show-body)
            SHOW_BODY=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  -l, --limit N       Show N most recent errors (default: 10)"
            echo "  -p, --post-id ID    Show errors for specific post ID"
            echo "  -o, --org-id ID     Show errors for specific organization"
            echo "  -b, --show-body     Show full request body in error details"
            echo "  -h, --help          Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0                              # Show last 10 errors"
            echo "  $0 -l 20                        # Show last 20 errors"
            echo "  $0 -p abc123                    # Show errors for specific post"
            echo "  $0 -o xyz789 -l 5               # Show last 5 errors for org"
            echo "  $0 -p abc123 -b                 # Show post errors with full body"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use -h or --help for usage information"
            exit 1
            ;;
    esac
done

clear
echo -e "${CYAN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║        Pinterest Error Diagnostic Tool        ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════╝${NC}"
echo ""

# Check if database container is running
if ! docker ps | grep -q "$DB_CONTAINER"; then
    echo -e "${RED}✗${NC} Container '$DB_CONTAINER' is not running!"
    exit 1
fi

echo -e "${GREEN}✓${NC} Database: $DB_CONTAINER"
echo ""

# Build WHERE clause based on arguments
WHERE_CLAUSE="WHERE e.platform = 'pinterest'"
if [ ! -z "$POST_ID" ]; then
    WHERE_CLAUSE="$WHERE_CLAUSE AND e.\"postId\" = '$POST_ID'"
fi
if [ ! -z "$ORG_ID" ]; then
    WHERE_CLAUSE="$WHERE_CLAUSE AND e.\"organizationId\" = '$ORG_ID'"
fi

# Query 1: Error Summary
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}Pinterest Error Summary${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" << EOF
SELECT 
    COUNT(*) as total_errors,
    COUNT(DISTINCT e."postId") as affected_posts,
    COUNT(DISTINCT e."organizationId") as affected_orgs,
    MIN(e."createdAt") as first_error,
    MAX(e."createdAt") as latest_error
FROM "Errors" e
$WHERE_CLAUSE;
EOF

echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}Error Types Distribution${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" << EOF
SELECT 
    SUBSTRING(message FROM 1 FOR 100) as error_type,
    COUNT(*) as count
FROM "Errors" e
$WHERE_CLAUSE
GROUP BY SUBSTRING(message FROM 1 FOR 100)
ORDER BY count DESC
LIMIT 5;
EOF

echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}Recent Pinterest Errors (Last $LIMIT)${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

if [ "$SHOW_BODY" = true ]; then
    docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" << EOF
\x on
SELECT 
    e.id as error_id,
    e."createdAt"::timestamp(0) as error_time,
    e."postId" as post_id,
    p."publishDate"::timestamp(0) as scheduled_for,
    p.state as post_state,
    i.name as integration_name,
    e.message as error_message,
    e.body as request_body,
    SUBSTRING(p.content FROM 1 FOR 100) as post_content_preview,
    p.settings as post_settings
FROM "Errors" e
JOIN "Post" p ON e."postId" = p.id
JOIN "Integration" i ON p."integrationId" = i.id
$WHERE_CLAUSE
ORDER BY e."createdAt" DESC
LIMIT $LIMIT;
EOF
else
    docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" << EOF
\x on
SELECT 
    e.id as error_id,
    e."createdAt"::timestamp(0) as error_time,
    e."postId" as post_id,
    p."publishDate"::timestamp(0) as scheduled_for,
    p.state as post_state,
    i.name as integration_name,
    e.message as error_message,
    SUBSTRING(p.content FROM 1 FOR 100) as post_content_preview,
    p.settings as post_settings
FROM "Errors" e
JOIN "Post" p ON e."postId" = p.id
JOIN "Integration" i ON p."integrationId" = i.id
$WHERE_CLAUSE
ORDER BY e."createdAt" DESC
LIMIT $LIMIT;
EOF
fi

echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}Posts Currently in ERROR State${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" << EOF
SELECT 
    p.id as post_id,
    p."publishDate"::timestamp(0) as scheduled_for,
    i.name as integration_name,
    i."providerIdentifier" as provider,
    SUBSTRING(p.content FROM 1 FOR 80) as content_preview,
    SUBSTRING(p.error FROM 1 FOR 150) as error_summary,
    p."updatedAt"::timestamp(0) as error_time
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE p.state = 'ERROR'
    AND i."providerIdentifier" = 'pinterest'
    AND p."deletedAt" IS NULL
    $([ ! -z "$ORG_ID" ] && echo "AND p.\"organizationId\" = '$ORG_ID'")
    $([ ! -z "$POST_ID" ] && echo "AND p.id = '$POST_ID'")
ORDER BY p."updatedAt" DESC
LIMIT $LIMIT;
EOF

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}Tips:${NC}"
echo -e "  • Use ${CYAN}-p POST_ID${NC} to see detailed errors for a specific post"
echo -e "  • Use ${CYAN}-o ORG_ID${NC} to filter by organization"
echo -e "  • Use ${CYAN}-b${NC} to see full request body details"
echo -e "  • Use ${CYAN}-l N${NC} to show more/fewer results"
echo -e "  • Check Sentry for full stack traces and context"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# Interactive retry section
echo ""
echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${MAGENTA}Retry Failed Posts${NC}"
echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# Count ERROR posts
ERROR_COUNT=$(docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A << EOF
SELECT COUNT(*)
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE p.state = 'ERROR'
    AND i."providerIdentifier" = 'pinterest'
    AND p."deletedAt" IS NULL
    $([ ! -z "$ORG_ID" ] && echo "AND p.\"organizationId\" = '$ORG_ID'")
    $([ ! -z "$POST_ID" ] && echo "AND p.id = '$POST_ID'");
EOF
)

if [ "$ERROR_COUNT" -eq 0 ]; then
    echo -e "${GREEN}✓${NC} No Pinterest posts in ERROR state"
else
    echo -e "${YELLOW}Found ${ERROR_COUNT} Pinterest post(s) in ERROR state${NC}"
    echo ""
    
    # Ask for confirmation
    echo -e "${CYAN}Would you like to retry these posts? This will:${NC}"
    echo -e "  1. Change state from ${RED}ERROR${NC} → ${GREEN}QUEUE${NC}"
    echo -e "  2. Clear error messages"
    echo -e "  3. Reschedule to NOW + 2 minutes"
    echo ""
    read -p "$(echo -e ${YELLOW}Retry these posts? [y/N]:${NC} )" -n 1 -r
    echo
    
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo ""
        echo -e "${CYAN}Retrying posts...${NC}"
        
        # Update posts to QUEUE state and reschedule
        UPDATED=$(docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A << EOF
WITH updated_posts AS (
    UPDATE "Post" p
    SET 
        state = 'QUEUE',
        error = NULL,
        "publishDate" = NOW() + INTERVAL '2 minutes',
        "updatedAt" = NOW()
    FROM "Integration" i
    WHERE p."integrationId" = i.id
        AND p.state = 'ERROR'
        AND i."providerIdentifier" = 'pinterest'
        AND p."deletedAt" IS NULL
        $([ ! -z "$ORG_ID" ] && echo "AND p.\"organizationId\" = '$ORG_ID'")
        $([ ! -z "$POST_ID" ] && echo "AND p.id = '$POST_ID'")
    RETURNING p.id
)
SELECT COUNT(*) FROM updated_posts;
EOF
)
        
        if [ "$UPDATED" -gt 0 ]; then
            echo -e "${GREEN}✓${NC} Successfully updated ${GREEN}${UPDATED}${NC} post(s) to QUEUE state"
            echo -e "${GREEN}✓${NC} Posts will be retried in 2 minutes"
            echo ""
            echo -e "${YELLOW}Note:${NC} Posts are scheduled for $(date -d '+2 minutes' '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -v+2M '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo 'NOW + 2 minutes')"
        else
            echo -e "${RED}✗${NC} No posts were updated"
        fi
    else
        echo -e "${YELLOW}Cancelled${NC} - No posts were modified"
    fi
fi

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

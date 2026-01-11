#!/bin/bash
##############################################################################
# Corrupted Image Checker - Find and validate images in the database
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
LIMIT=20
ORG_ID=""
VALIDATE_URLS=false
FIX_MODE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        -l|--limit)
            LIMIT="$2"
            shift 2
            ;;
        -o|--org-id)
            ORG_ID="$2"
            shift 2
            ;;
        -v|--validate-urls)
            VALIDATE_URLS=true
            shift
            ;;
        -f|--fix)
            FIX_MODE=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  -l, --limit N       Check N media items (default: 20)"
            echo "  -o, --org-id ID     Check media for specific organization"
            echo "  -v, --validate-urls Validate URLs are accessible (slower)"
            echo "  -f, --fix           Soft-delete corrupted images"
            echo "  -h, --help          Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0                              # Quick check of 20 media items"
            echo "  $0 -l 100                       # Check 100 items"
            echo "  $0 -o xyz789                    # Check specific org"
            echo "  $0 -v                           # Validate URLs (slow)"
            echo "  $0 -f                           # Soft-delete corrupted images"
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
echo -e "${CYAN}║       Corrupted Image Diagnostic Tool         ║${NC}"
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
WHERE_CLAUSE="WHERE m.\"deletedAt\" IS NULL"
if [ ! -z "$ORG_ID" ]; then
    WHERE_CLAUSE="$WHERE_CLAUSE AND m.\"organizationId\" = '$ORG_ID'"
fi

# Query 1: Media Statistics
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}Media Statistics${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" << EOF
SELECT 
    type,
    COUNT(*) as total,
    COUNT(CASE WHEN "fileSize" = 0 THEN 1 END) as zero_size,
    COUNT(CASE WHEN path !~ '^https?://' THEN 1 END) as invalid_protocol,
    ROUND(AVG("fileSize")::numeric / 1024 / 1024, 2) as avg_size_mb
FROM "Media" m
$WHERE_CLAUSE
GROUP BY type;
EOF
echo ""

# Query 2: Images with Zero File Size
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}Images with Zero File Size${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" << EOF
SELECT 
    m.id,
    m.name,
    m.type,
    LEFT(m.path, 80) as path_preview,
    o.name as org_name,
    m."createdAt"
FROM "Media" m
JOIN "Organization" o ON m."organizationId" = o.id
$WHERE_CLAUSE
AND m."fileSize" = 0
ORDER BY m."createdAt" DESC
LIMIT $LIMIT;
EOF
echo ""

# Query 3: Images with Invalid Paths
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}Images with Invalid Paths/Extensions${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" << EOF
SELECT 
    m.id,
    m.name,
    m.type,
    m.path,
    o.name as org_name,
    m."createdAt",
    CASE 
        WHEN m.path !~ '^https?://' THEN 'Invalid Protocol'
        WHEN m.path !~ '\.(png|jpg|jpeg|gif|mp4)(\?.*)?$' THEN 'Invalid Extension'
        ELSE 'Other'
    END as issue_type
FROM "Media" m
JOIN "Organization" o ON m."organizationId" = o.id
$WHERE_CLAUSE
AND (
    m.path !~ '^https?://'
    OR m.path !~ '\.(png|jpg|jpeg|gif|mp4)(\?.*)?$'
)
ORDER BY m."createdAt" DESC
LIMIT $LIMIT;
EOF
echo ""

# Query 4: Recent Media Items (for manual inspection)
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}Recent Media Items${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" << EOF
SELECT 
    m.id,
    m.name,
    m.type,
    ROUND(m."fileSize"::numeric / 1024 / 1024, 2) as size_mb,
    LEFT(m.path, 80) as path_preview,
    o.name as org_name,
    m."createdAt"
FROM "Media" m
JOIN "Organization" o ON m."organizationId" = o.id
$WHERE_CLAUSE
ORDER BY m."createdAt" DESC
LIMIT $LIMIT;
EOF
echo ""

# Query 5: Summary of Potential Issues
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}Issue Summary${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" << EOF
SELECT 
    COUNT(*) as total_suspicious,
    COUNT(DISTINCT "organizationId") as affected_orgs
FROM "Media" m
$WHERE_CLAUSE
AND (
    m."fileSize" = 0
    OR m.path !~ '^https?://'
    OR m.path !~ '\.(png|jpg|jpeg|gif|mp4)(\?.*)?$'
);
EOF
echo ""

# Fix mode - soft delete corrupted images
if [ "$FIX_MODE" = true ]; then
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${RED}FIX MODE: Soft-deleting corrupted images${NC}"
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}⚠ This will mark corrupted images as deleted${NC}"
    read -p "Are you sure? (yes/no): " confirm
    
    if [ "$confirm" = "yes" ]; then
        docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" << EOF
UPDATE "Media"
SET "deletedAt" = NOW()
$WHERE_CLAUSE
AND (
    "fileSize" = 0
    OR path !~ '^https?://'
    OR path !~ '\.(png|jpg|jpeg|gif|mp4)(\?.*)?$'
)
RETURNING id, name, path;
EOF
        echo -e "${GREEN}✓${NC} Corrupted images have been soft-deleted"
    else
        echo -e "${YELLOW}Cancelled${NC}"
    fi
    echo ""
fi

# URL validation (optional, slower)
if [ "$VALIDATE_URLS" = true ]; then
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}URL Validation (checking accessibility)${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${CYAN}Note: This may take a while...${NC}"
    echo ""
    
    # Get list of URLs to validate
    urls=$(docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A -c \
        "SELECT id || '|' || path FROM \"Media\" m $WHERE_CLAUSE AND path ~ '^https?://' ORDER BY \"createdAt\" DESC LIMIT $LIMIT;")
    
    inaccessible=0
    checked=0
    
    while IFS='|' read -r id url; do
        if [ ! -z "$url" ]; then
            checked=$((checked + 1))
            http_code=$(curl -s -o /dev/null -w "%{http_code}" -L --max-time 5 "$url" || echo "000")
            
            if [ "$http_code" != "200" ]; then
                inaccessible=$((inaccessible + 1))
                echo -e "${RED}✗${NC} [HTTP $http_code] $id"
                echo -e "   ${CYAN}$url${NC}"
            else
                echo -e "${GREEN}✓${NC} [HTTP 200] $id"
            fi
        fi
    done <<< "$urls"
    
    echo ""
    echo -e "${CYAN}Checked: $checked | Inaccessible: $inaccessible${NC}"
    echo ""
fi

echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}Diagnostic complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${CYAN}Tips:${NC}"
echo -e "  • Use ${YELLOW}-v${NC} to validate URLs are accessible (slower)"
echo -e "  • Use ${YELLOW}-f${NC} to soft-delete corrupted images"
echo -e "  • Use ${YELLOW}-l N${NC} to check more items"
echo ""

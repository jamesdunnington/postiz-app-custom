##############################################################################
# Corrupted Image Checker - Find and validate images in the database
##############################################################################

param(
    [int]$Limit = 20,
    [string]$OrgId = "",
    [switch]$ValidateUrls,
    [switch]$Fix,
    [switch]$Help
)

# Configuration
$DB_CONTAINER = "postiz-postgres"
$DB_NAME = "postiz-db-local"
$DB_USER = "postiz-user"

function Show-Help {
    Write-Host ""
    Write-Host "Usage: .\check-corrupted-images.ps1 [OPTIONS]"
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  -Limit N           Check N media items (default: 20)"
    Write-Host "  -OrgId ID          Check media for specific organization"
    Write-Host "  -ValidateUrls      Validate URLs are accessible (slower)"
    Write-Host "  -Fix               Soft-delete corrupted images"
    Write-Host "  -Help              Show this help message"
    Write-Host ""
    Write-Host "Examples:"
    Write-Host "  .\check-corrupted-images.ps1                    # Quick check of 20 media items"
    Write-Host "  .\check-corrupted-images.ps1 -Limit 100         # Check 100 items"
    Write-Host "  .\check-corrupted-images.ps1 -OrgId xyz789      # Check specific org"
    Write-Host "  .\check-corrupted-images.ps1 -ValidateUrls      # Validate URLs (slow)"
    Write-Host "  .\check-corrupted-images.ps1 -Fix               # Soft-delete corrupted images"
    Write-Host ""
    exit 0
}

if ($Help) {
    Show-Help
}

Clear-Host
Write-Host "╔════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║       Corrupted Image Diagnostic Tool         ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Check if database container is running
$containerRunning = docker ps --format "{{.Names}}" | Select-String -Pattern "^$DB_CONTAINER$"
if (-not $containerRunning) {
    Write-Host "✗ Container '$DB_CONTAINER' is not running!" -ForegroundColor Red
    exit 1
}

Write-Host "✓ Database: $DB_CONTAINER" -ForegroundColor Green
Write-Host ""

# Build WHERE clause based on arguments
$WHERE_CLAUSE = 'WHERE m."deletedAt" IS NULL'
if ($OrgId) {
    $WHERE_CLAUSE += " AND m.`"organizationId`" = '$OrgId'"
}

# Query 1: Media Statistics
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow
Write-Host "Media Statistics" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow
$query1 = @"
SELECT 
    type,
    COUNT(*) as total,
    COUNT(CASE WHEN "fileSize" = 0 THEN 1 END) as zero_size,
    COUNT(CASE WHEN path !~ '^https?://' THEN 1 END) as invalid_protocol,
    ROUND(AVG("fileSize")::numeric / 1024 / 1024, 2) as avg_size_mb
FROM "Media" m
$WHERE_CLAUSE
GROUP BY type;
"@
docker exec -i $DB_CONTAINER psql -U $DB_USER -d $DB_NAME -c $query1
Write-Host ""

# Query 2: Images with Zero File Size
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow
Write-Host "Images with Zero File Size" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow
$query2 = @"
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
LIMIT $Limit;
"@
docker exec -i $DB_CONTAINER psql -U $DB_USER -d $DB_NAME -c $query2
Write-Host ""

# Query 3: Images with Invalid Paths
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow
Write-Host "Images with Invalid Paths/Extensions" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow
$query3 = @"
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
LIMIT $Limit;
"@
docker exec -i $DB_CONTAINER psql -U $DB_USER -d $DB_NAME -c $query3
Write-Host ""

# Query 4: Recent Media Items
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow
Write-Host "Recent Media Items" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow
$query4 = @"
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
LIMIT $Limit;
"@
docker exec -i $DB_CONTAINER psql -U $DB_USER -d $DB_NAME -c $query4
Write-Host ""

# Query 5: Summary of Potential Issues
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow
Write-Host "Issue Summary" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow
$query5 = @"
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
"@
docker exec -i $DB_CONTAINER psql -U $DB_USER -d $DB_NAME -c $query5
Write-Host ""

# Fix mode - soft delete corrupted images
if ($Fix) {
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Red
    Write-Host "FIX MODE: Soft-deleting corrupted images" -ForegroundColor Red
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Red
    Write-Host "⚠ This will mark corrupted images as deleted" -ForegroundColor Yellow
    $confirm = Read-Host "Are you sure? (yes/no)"
    
    if ($confirm -eq "yes") {
        $fixQuery = @"
UPDATE "Media"
SET "deletedAt" = NOW()
$WHERE_CLAUSE
AND (
    "fileSize" = 0
    OR path !~ '^https?://'
    OR path !~ '\.(png|jpg|jpeg|gif|mp4)(\?.*)?$'
)
RETURNING id, name, path;
"@
        docker exec -i $DB_CONTAINER psql -U $DB_USER -d $DB_NAME -c $fixQuery
        Write-Host "✓ Corrupted images have been soft-deleted" -ForegroundColor Green
    } else {
        Write-Host "Cancelled" -ForegroundColor Yellow
    }
    Write-Host ""
}

# URL validation (optional, slower)
if ($ValidateUrls) {
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow
    Write-Host "URL Validation (checking accessibility)" -ForegroundColor Yellow
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow
    Write-Host "Note: This may take a while..." -ForegroundColor Cyan
    Write-Host ""
    
    # Get list of URLs to validate
    $urlQuery = @"
SELECT id || '|' || path FROM "Media" m $WHERE_CLAUSE AND path ~ '^https?://' ORDER BY "createdAt" DESC LIMIT $Limit;
"@
    $urls = docker exec -i $DB_CONTAINER psql -U $DB_USER -d $DB_NAME -t -A -c $urlQuery
    
    $inaccessible = 0
    $checked = 0
    
    foreach ($line in $urls -split "`n") {
        if ($line -match '^([^|]+)\|(.+)$') {
            $id = $matches[1].Trim()
            $url = $matches[2].Trim()
            
            if ($url) {
                $checked++
                try {
                    $response = Invoke-WebRequest -Uri $url -Method Head -TimeoutSec 5 -ErrorAction Stop
                    $httpCode = $response.StatusCode
                    
                    if ($httpCode -eq 200) {
                        Write-Host "✓ [HTTP 200] $id" -ForegroundColor Green
                    } else {
                        $inaccessible++
                        Write-Host "✗ [HTTP $httpCode] $id" -ForegroundColor Red
                        Write-Host "   $url" -ForegroundColor Cyan
                    }
                } catch {
                    $inaccessible++
                    Write-Host "✗ [ERROR] $id" -ForegroundColor Red
                    Write-Host "   $url" -ForegroundColor Cyan
                }
            }
        }
    }
    
    Write-Host ""
    Write-Host "Checked: $checked | Inaccessible: $inaccessible" -ForegroundColor Cyan
    Write-Host ""
}

Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host "Diagnostic complete!" -ForegroundColor Green
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host ""
Write-Host "Tips:" -ForegroundColor Cyan
Write-Host "  • Use -ValidateUrls to validate URLs are accessible (slower)" -ForegroundColor White
Write-Host "  • Use -Fix to soft-delete corrupted images" -ForegroundColor White
Write-Host "  • Use -Limit N to check more items" -ForegroundColor White
Write-Host ""

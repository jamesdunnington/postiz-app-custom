#!/usr/bin/env pwsh
##############################################################################
# Pinterest Error Checker - View detailed Pinterest posting errors (PowerShell)
##############################################################################

param(
    [int]$Limit = 10,
    [string]$PostId = "",
    [string]$OrgId = "",
    [switch]$ShowBody = $false,
    [switch]$Help = $false
)

# Configuration
$DB_CONTAINER = "postiz-postgres"
$DB_NAME = "postiz-db-local"
$DB_USER = "postiz-user"

# Show help
if ($Help) {
    Write-Host @"
Usage: .\check-pinterest-errors.ps1 [OPTIONS]

Options:
  -Limit N        Show N most recent errors (default: 10)
  -PostId ID      Show errors for specific post ID
  -OrgId ID       Show errors for specific organization
  -ShowBody       Show full request body in error details
  -Help           Show this help message

Examples:
  .\check-pinterest-errors.ps1                           # Show last 10 errors
  .\check-pinterest-errors.ps1 -Limit 20                 # Show last 20 errors
  .\check-pinterest-errors.ps1 -PostId abc123            # Show errors for specific post
  .\check-pinterest-errors.ps1 -OrgId xyz789 -Limit 5    # Show last 5 errors for org
  .\check-pinterest-errors.ps1 -PostId abc123 -ShowBody  # Show post errors with full body
"@
    exit 0
}

Clear-Host
Write-Host "╔════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║        Pinterest Error Diagnostic Tool        ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Check if database container is running
$containerRunning = docker ps --format "{{.Names}}" | Select-String -Pattern $DB_CONTAINER
if (-not $containerRunning) {
    Write-Host "✗ Container '$DB_CONTAINER' is not running!" -ForegroundColor Red
    exit 1
}

Write-Host "✓ Database: $DB_CONTAINER" -ForegroundColor Green
Write-Host ""

# Build WHERE clause based on arguments
$WHERE_CLAUSE = "WHERE e.platform = 'pinterest'"
if ($PostId) {
    $WHERE_CLAUSE += " AND e.""postId"" = '$PostId'"
}
if ($OrgId) {
    $WHERE_CLAUSE += " AND e.""organizationId"" = '$OrgId'"
}

# Query 1: Error Summary
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow
Write-Host "Pinterest Error Summary" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow

$query1 = @"
SELECT 
    COUNT(*) as total_errors,
    COUNT(DISTINCT e."postId") as affected_posts,
    COUNT(DISTINCT e."organizationId") as affected_orgs,
    MIN(e."createdAt") as first_error,
    MAX(e."createdAt") as latest_error
FROM "Errors" e
$WHERE_CLAUSE;
"@

docker exec -i $DB_CONTAINER psql -U $DB_USER -d $DB_NAME -c $query1

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow
Write-Host "Error Types Distribution" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow

$query2 = @"
SELECT 
    SUBSTRING(message FROM 1 FOR 100) as error_type,
    COUNT(*) as count
FROM "Errors" e
$WHERE_CLAUSE
GROUP BY SUBSTRING(message FROM 1 FOR 100)
ORDER BY count DESC
LIMIT 5;
"@

docker exec -i $DB_CONTAINER psql -U $DB_USER -d $DB_NAME -c $query2

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow
Write-Host "Recent Pinterest Errors (Last $Limit)" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow

if ($ShowBody) {
    $query3 = @"
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
LIMIT $Limit;
"@
} else {
    $query3 = @"
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
LIMIT $Limit;
"@
}

docker exec -i $DB_CONTAINER psql -U $DB_USER -d $DB_NAME -c $query3

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow
Write-Host "Posts Currently in ERROR State" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow

$orgFilter = if ($OrgId) { "AND p.""organizationId"" = '$OrgId'" } else { "" }
$postFilter = if ($PostId) { "AND p.id = '$PostId'" } else { "" }

$query4 = @"
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
    $orgFilter
    $postFilter
ORDER BY p."updatedAt" DESC
LIMIT $Limit;
"@

docker exec -i $DB_CONTAINER psql -U $DB_USER -d $DB_NAME -c $query4

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host "Tips:" -ForegroundColor Green
Write-Host "  • Use " -NoNewline
Write-Host "-PostId POST_ID" -ForegroundColor Cyan -NoNewline
Write-Host " to see detailed errors for a specific post"
Write-Host "  • Use " -NoNewline
Write-Host "-OrgId ORG_ID" -ForegroundColor Cyan -NoNewline
Write-Host " to filter by organization"
Write-Host "  • Use " -NoNewline
Write-Host "-ShowBody" -ForegroundColor Cyan -NoNewline
Write-Host " to see full request body details"
Write-Host "  • Use " -NoNewline
Write-Host "-Limit N" -ForegroundColor Cyan -NoNewline
Write-Host " to show more/fewer results"
Write-Host "  • Check Sentry for full stack traces and context"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green

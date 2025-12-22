# Check for PUBLISHED posts with future schedule dates
# Run this with: powershell -ExecutionPolicy Bypass -File .\check-future-published.ps1

Write-Host "Searching for PUBLISHED posts scheduled in the future..." -ForegroundColor Cyan
Write-Host ""

$query = @"
SELECT 
  id,
  \"integrationId\",
  \"publishDate\",
  \"createdAt\",
  state,
  \"releaseURL\"
FROM \"Post\"
WHERE 
  state = 'PUBLISHED'
  AND \"publishDate\" > NOW()
  AND \"deletedAt\" IS NULL
ORDER BY \"publishDate\" ASC;
"@

docker exec postiz-postgres psql -U postiz -d postiz -c $query

Write-Host ""
Write-Host "To delete these posts, run:" -ForegroundColor Yellow
Write-Host 'docker exec postiz-postgres psql -U postiz -d postiz -c "UPDATE \"Post\" SET \"deletedAt\" = NOW() WHERE state = ''PUBLISHED'' AND \"publishDate\" > NOW() AND \"deletedAt\" IS NULL;"' -ForegroundColor Gray

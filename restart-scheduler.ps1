# Quick script to restart scheduler services
# Run this if the scheduler is not working

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Restarting Postiz Scheduler Services" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Find containers
$cronContainer = docker ps -a --filter "name=cron" --format "{{.Names}}" | Select-Object -First 1
$workersContainer = docker ps -a --filter "name=worker" --format "{{.Names}}" | Select-Object -First 1
$redisContainer = docker ps -a --filter "name=redis" --format "{{.Names}}" | Select-Object -First 1

Write-Host "Found containers:" -ForegroundColor Yellow
if ($cronContainer) { Write-Host "  Cron: $cronContainer" -ForegroundColor Green } else { Write-Host "  Cron: Not found" -ForegroundColor Red }
if ($workersContainer) { Write-Host "  Workers: $workersContainer" -ForegroundColor Green } else { Write-Host "  Workers: Not found" -ForegroundColor Red }
if ($redisContainer) { Write-Host "  Redis: $redisContainer" -ForegroundColor Green } else { Write-Host "  Redis: Not found" -ForegroundColor Red }
Write-Host ""

# Restart services
if ($cronContainer) {
    Write-Host "Restarting cron service..." -ForegroundColor Yellow
    docker restart $cronContainer
    Write-Host "✅ Cron service restarted" -ForegroundColor Green
} else {
    Write-Host "❌ Cron container not found - you need to start it first" -ForegroundColor Red
}

if ($workersContainer) {
    Write-Host "Restarting workers service..." -ForegroundColor Yellow
    docker restart $workersContainer
    Write-Host "✅ Workers service restarted" -ForegroundColor Green
} else {
    Write-Host "❌ Workers container not found - you need to start it first" -ForegroundColor Red
}

if ($redisContainer) {
    Write-Host "Restarting Redis..." -ForegroundColor Yellow
    docker restart $redisContainer
    Write-Host "✅ Redis restarted" -ForegroundColor Green
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Services restarted!" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Monitor the logs with:" -ForegroundColor Yellow
if ($cronContainer) {
    Write-Host "  docker logs -f $cronContainer" -ForegroundColor Cyan
}
if ($workersContainer) {
    Write-Host "  docker logs -f $workersContainer" -ForegroundColor Cyan
}
Write-Host ""
Write-Host "Wait 1-2 minutes and check if posts are being processed." -ForegroundColor Yellow
Write-Host ""

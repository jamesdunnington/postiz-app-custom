# Postiz Scheduler Diagnostic Script
# This script helps diagnose why the scheduler is not posting to social media

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Postiz Scheduler Diagnostic Tool" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if Docker is running
Write-Host "1. Checking Docker status..." -ForegroundColor Yellow
try {
    $dockerVersion = docker --version
    Write-Host "   ✅ Docker is installed: $dockerVersion" -ForegroundColor Green
} catch {
    Write-Host "   ❌ Docker is not installed or not running" -ForegroundColor Red
    exit 1
}

# Check running containers
Write-Host ""
Write-Host "2. Checking running containers..." -ForegroundColor Yellow
$containers = docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
Write-Host $containers

# Check if cron service is running
Write-Host ""
Write-Host "3. Checking for cron service..." -ForegroundColor Yellow
$cronContainer = docker ps --filter "name=cron" --format "{{.Names}}"
if ($cronContainer) {
    Write-Host "   ✅ Cron container found: $cronContainer" -ForegroundColor Green
} else {
    Write-Host "   ❌ Cron container not found!" -ForegroundColor Red
    Write-Host "   The scheduler requires a cron service to be running." -ForegroundColor Yellow
}

# Check if workers service is running
Write-Host ""
Write-Host "4. Checking for workers service..." -ForegroundColor Yellow
$workersContainer = docker ps --filter "name=worker" --format "{{.Names}}"
if ($workersContainer) {
    Write-Host "   ✅ Workers container found: $workersContainer" -ForegroundColor Green
} else {
    Write-Host "   ❌ Workers container not found!" -ForegroundColor Red
    Write-Host "   The scheduler requires a workers service to process posts." -ForegroundColor Yellow
}

# Check Redis
Write-Host ""
Write-Host "5. Checking Redis connection..." -ForegroundColor Yellow
$redisContainer = docker ps --filter "name=redis" --format "{{.Names}}"
if ($redisContainer) {
    Write-Host "   ✅ Redis container found: $redisContainer" -ForegroundColor Green
    
    # Try to ping Redis
    try {
        $redisPing = docker exec $redisContainer redis-cli ping 2>&1
        if ($redisPing -match "PONG") {
            Write-Host "   ✅ Redis is responding" -ForegroundColor Green
        } else {
            Write-Host "   ⚠️  Redis may not be responding correctly" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "   ⚠️  Could not ping Redis" -ForegroundColor Yellow
    }
} else {
    Write-Host "   ❌ Redis container not found!" -ForegroundColor Red
    Write-Host "   Redis is required for the job queue." -ForegroundColor Yellow
}

# Check PostgreSQL
Write-Host ""
Write-Host "6. Checking PostgreSQL connection..." -ForegroundColor Yellow
$postgresContainer = docker ps --filter "name=postgres" --format "{{.Names}}"
if ($postgresContainer) {
    Write-Host "   ✅ PostgreSQL container found: $postgresContainer" -ForegroundColor Green
} else {
    Write-Host "   ❌ PostgreSQL container not found!" -ForegroundColor Red
}

# Check recent logs from cron service
if ($cronContainer) {
    Write-Host ""
    Write-Host "7. Recent cron service logs (last 50 lines)..." -ForegroundColor Yellow
    Write-Host "   Looking for scheduler activity..." -ForegroundColor Cyan
    docker logs --tail 50 $cronContainer
}

# Check recent logs from workers service
if ($workersContainer) {
    Write-Host ""
    Write-Host "8. Recent workers service logs (last 50 lines)..." -ForegroundColor Yellow
    Write-Host "   Looking for post processing activity..." -ForegroundColor Cyan
    docker logs --tail 50 $workersContainer
}

# Check for queued jobs in Redis
if ($redisContainer) {
    Write-Host ""
    Write-Host "9. Checking Redis job queues..." -ForegroundColor Yellow
    try {
        $queueKeys = docker exec $redisContainer redis-cli --scan --pattern "bull:post:*" 2>&1
        if ($queueKeys) {
            Write-Host "   Found job queue keys:" -ForegroundColor Cyan
            Write-Host $queueKeys
            
            # Count jobs in different states
            $waitingCount = docker exec $redisContainer redis-cli llen "bull:post:wait" 2>&1
            $activeCount = docker exec $redisContainer redis-cli llen "bull:post:active" 2>&1
            $delayedCount = docker exec $redisContainer redis-cli zcard "bull:post:delayed" 2>&1
            
            Write-Host ""
            Write-Host "   Queue Statistics:" -ForegroundColor Cyan
            Write-Host "   - Waiting jobs: $waitingCount" -ForegroundColor White
            Write-Host "   - Active jobs: $activeCount" -ForegroundColor White
            Write-Host "   - Delayed jobs: $delayedCount" -ForegroundColor White
        } else {
            Write-Host "   ⚠️  No job queues found in Redis" -ForegroundColor Yellow
            Write-Host "   This could mean no posts are scheduled or the queue is not initialized." -ForegroundColor Yellow
        }
    } catch {
        Write-Host "   ⚠️  Could not check Redis queues" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Diagnostic Summary" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Provide recommendations
Write-Host "Recommendations:" -ForegroundColor Yellow
Write-Host ""

if (-not $cronContainer) {
    Write-Host "❌ CRITICAL: Cron service is not running!" -ForegroundColor Red
    Write-Host "   The cron service is responsible for checking scheduled posts." -ForegroundColor White
    Write-Host "   Action: Start the cron service in your Docker setup." -ForegroundColor White
    Write-Host ""
}

if (-not $workersContainer) {
    Write-Host "❌ CRITICAL: Workers service is not running!" -ForegroundColor Red
    Write-Host "   The workers service processes and publishes posts." -ForegroundColor White
    Write-Host "   Action: Start the workers service in your Docker setup." -ForegroundColor White
    Write-Host ""
}

if (-not $redisContainer) {
    Write-Host "❌ CRITICAL: Redis is not running!" -ForegroundColor Red
    Write-Host "   Redis is required for the job queue system." -ForegroundColor White
    Write-Host "   Action: Start Redis in your Docker setup." -ForegroundColor White
    Write-Host ""
}

Write-Host "Next Steps:" -ForegroundColor Cyan
Write-Host "1. Check the logs above for any error messages" -ForegroundColor White
Write-Host "2. Verify that scheduled posts exist in the database" -ForegroundColor White
Write-Host "3. Check that integrations are properly connected and not disabled" -ForegroundColor White
Write-Host "4. Monitor the logs in real-time: docker logs -f <container-name>" -ForegroundColor White
Write-Host ""
Write-Host "For real-time monitoring, run:" -ForegroundColor Yellow
if ($cronContainer) {
    Write-Host "   docker logs -f $cronContainer" -ForegroundColor Cyan
}
if ($workersContainer) {
    Write-Host "   docker logs -f $workersContainer" -ForegroundColor Cyan
}
Write-Host ""

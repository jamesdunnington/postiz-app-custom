# Scheduler Troubleshooting Guide

## Overview

The Postiz scheduler system consists of three main components:

1. **Cron Service** - Checks for scheduled posts and adds them to the queue
2. **Workers Service** - Processes posts from the queue and publishes to social media
3. **Redis** - Job queue system that connects cron and workers

## Common Issues and Solutions

### Issue 1: Posts Not Being Published

#### Symptoms
- Posts are scheduled but never get published
- No errors shown in the UI
- Posts remain in "QUEUE" state

#### Diagnostic Steps

1. **Run the diagnostic script:**
   ```powershell
   .\diagnose-scheduler.ps1
   ```

2. **Check if all required services are running:**
   ```bash
   docker ps
   ```
   
   You should see containers for:
   - `postiz-cron` or similar (cron service)
   - `postiz-workers` or similar (workers service)
   - `postiz-redis` (Redis)
   - `postiz-postgres` (PostgreSQL)

3. **Check cron service logs:**
   ```bash
   docker logs -f <cron-container-name>
   ```
   
   Look for messages like:
   - `[CHECK MISSING QUEUES] Starting check for missing posts...`
   - `[POST NOW PENDING] Starting check for pending posts...`
   
   If you don't see these messages, the cron jobs are not running.

4. **Check workers service logs:**
   ```bash
   docker logs -f <workers-container-name>
   ```
   
   Look for messages like:
   - `[WORKER] Processing post job:`
   - `[PostsService] Starting post processing for ID:`
   
   If you don't see these, posts are not being processed.

#### Solutions

**Solution A: Services Not Running**

If cron or workers services are not running:

1. Check your Docker Compose file
2. Ensure both services are defined and started
3. Restart the services:
   ```bash
   docker-compose restart cron workers
   ```

**Solution B: Redis Connection Issues**

If Redis is not accessible:

1. Check Redis is running:
   ```bash
   docker exec <redis-container> redis-cli ping
   ```
   Should return `PONG`

2. Check Redis connection in environment variables:
   - `REDIS_HOST`
   - `REDIS_PORT`
   - `REDIS_PASSWORD` (if applicable)

3. Restart Redis:
   ```bash
   docker-compose restart redis
   ```

**Solution C: Database Connection Issues**

If posts are not being found:

1. Check PostgreSQL is running and accessible
2. Verify database connection in environment variables:
   - `DATABASE_URL`
3. Check if posts exist in the database:
   ```sql
   SELECT id, state, "publishDate", "integrationId" 
   FROM "Post" 
   WHERE state = 'QUEUE' 
   AND "deletedAt" IS NULL 
   ORDER BY "publishDate" ASC 
   LIMIT 10;
   ```

**Solution D: Integration Issues**

Posts won't publish if integrations are disabled or need refresh:

1. Check integration status in the database:
   ```sql
   SELECT id, name, "providerIdentifier", disabled, "refreshNeeded" 
   FROM "Integration" 
   WHERE "deletedAt" IS NULL;
   ```

2. If `disabled = true` or `refreshNeeded = true`, reconnect the integration in the UI

**Solution E: Timezone Issues**

Posts might be scheduled in the wrong timezone:

1. Check the `publishDate` in the database is in UTC
2. Verify user timezone settings
3. Check server timezone matches expected timezone

### Issue 2: Duplicate Posts

#### Symptoms
- Same post published multiple times
- Multiple entries in social media

#### Diagnostic Steps

1. Check for duplicate schedules:
   ```sql
   SELECT "integrationId", "publishDate", COUNT(*) as count
   FROM "Post"
   WHERE state = 'QUEUE'
   AND "deletedAt" IS NULL
   GROUP BY "integrationId", "publishDate"
   HAVING COUNT(*) > 1;
   ```

2. Check cron logs for duplicate detection:
   ```bash
   docker logs <cron-container> | grep "DUPLICATE CHECK"
   ```

#### Solutions

The system now includes automatic duplicate detection and resolution:

1. The `CheckDuplicateSchedules` cron job runs hourly
2. It automatically reschedules duplicate posts
3. Monitor logs to see if duplicates are being fixed

If duplicates persist:

1. Manually reschedule duplicate posts
2. Check for race conditions in post creation
3. Verify the cron job is running properly

### Issue 3: Posts Stuck in Queue

#### Symptoms
- Posts remain in "QUEUE" state past their publish time
- No errors shown

#### Diagnostic Steps

1. Check if posts are past their publish time:
   ```sql
   SELECT id, "publishDate", state, "integrationId"
   FROM "Post"
   WHERE state = 'QUEUE'
   AND "publishDate" < NOW()
   AND "deletedAt" IS NULL
   ORDER BY "publishDate" ASC;
   ```

2. Check if jobs exist in Redis:
   ```bash
   docker exec <redis-container> redis-cli llen "bull:post:wait"
   docker exec <redis-container> redis-cli zcard "bull:post:delayed"
   ```

#### Solutions

**Solution A: Missed Posts Recovery**

The system includes automatic recovery on startup:

1. Restart the cron service to trigger recovery:
   ```bash
   docker-compose restart cron
   ```

2. Check logs for recovery messages:
   ```bash
   docker logs <cron-container> | grep "STARTUP CHECK"
   ```

**Solution B: Manual Queue Addition**

If automatic recovery doesn't work:

1. The `PostNowPendingQueues` cron runs every 16 minutes
2. It checks for posts 15-30 minutes old and adds them to queue
3. The `CheckMissingQueues` cron runs hourly for posts in next 3 hours

**Solution C: Force Requeue**

Restart both cron and workers services:
```bash
docker-compose restart cron workers
```

## Monitoring

### Real-time Log Monitoring

Monitor cron service:
```bash
docker logs -f <cron-container-name>
```

Monitor workers service:
```bash
docker logs -f <workers-container-name>
```

### Key Log Messages

**Cron Service:**
- `[CHECK MISSING QUEUES] Starting check...` - Hourly check running
- `[POST NOW PENDING] Starting check...` - Every 16 minutes check running
- `[DUPLICATE CHECK] Starting duplicate schedule check...` - Hourly duplicate check
- `✅ All posts are properly queued` - Everything is working
- `⚠️ Found X posts missing from queue` - Posts being added to queue

**Workers Service:**
- `[WORKER] Processing post job:` - Post being processed
- `[PostsService] Starting post processing for ID:` - Post details being loaded
- `📤 Attempting to post to <platform>...` - Publishing to social media
- `✅ Post X successfully published` - Success!
- `❌ Post X failed` - Error occurred

### Sentry Integration

All errors are now logged to Sentry with detailed context:
- Check your Sentry dashboard for errors
- Look for errors in the `cron` and `workers` projects
- Errors include post ID, integration details, and full stack traces

## Cron Job Schedule

| Cron Job | Schedule | Purpose |
|----------|----------|---------|
| CheckMissingQueues | Every hour (0 * * * *) | Checks for posts in next 3 hours and adds to queue |
| PostNowPendingQueues | Every 16 minutes (*/16 * * * *) | Checks for posts 15-30 minutes old and adds to queue |
| CheckDuplicateSchedules | Every hour (0 * * * *) | Detects and fixes duplicate schedules |
| CheckInvalidTimeSlots | Every hour (0 * * * *) | Checks for posts at invalid time slots |
| RescheduleMissedPostsStartup | On startup | Recovers missed posts on service restart |

## Environment Variables

Ensure these are properly set:

```env
# Database
DATABASE_URL=postgresql://user:password@host:5432/database

# Redis
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=

# Sentry (optional but recommended)
NEXT_PUBLIC_SENTRY_DSN=your-sentry-dsn
SENTRY_DSN=your-sentry-dsn
```

## Testing the Scheduler

1. **Create a test post:**
   - Schedule a post for 2-3 minutes in the future
   - Use a test integration

2. **Monitor the logs:**
   ```bash
   docker logs -f <cron-container> &
   docker logs -f <workers-container> &
   ```

3. **Watch for these events:**
   - Cron detects the post (within 3 hours)
   - Post added to queue
   - Worker picks up the post
   - Post published to social media
   - Post state changed to PUBLISHED

## Getting Help

If you're still experiencing issues:

1. Run the diagnostic script and save the output
2. Check Sentry for error details
3. Collect logs from cron and workers services
4. Check the database for post and integration status
5. Verify all environment variables are correct

## Recent Improvements

The following improvements have been made to help diagnose and fix scheduler issues:

1. **Comprehensive Logging:**
   - All cron jobs now log their activity
   - Workers log post processing steps
   - Errors are logged with full context

2. **Sentry Integration:**
   - All errors sent to Sentry with detailed context
   - Easy to track and debug issues

3. **Automatic Recovery:**
   - Missed posts recovered on startup
   - Duplicate schedules automatically fixed
   - Invalid time slots detected and corrected

4. **Diagnostic Tools:**
   - PowerShell diagnostic script
   - Database queries for troubleshooting
   - Log monitoring commands

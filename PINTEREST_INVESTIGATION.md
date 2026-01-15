# Pinterest Post Investigation

## Run These Diagnostic Queries

### 1. Check All Pinterest Posts Status
```sql
SELECT 
  p.id,
  p."integrationId",
  p."publishDate",
  p.state,
  p."createdAt",
  p."releaseURL",
  p.error,
  i.name as integration_name,
  i."providerIdentifier"
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE 
  i."providerIdentifier" = 'pinterest'
  AND p."deletedAt" IS NULL
  AND p."publishDate" >= NOW() - INTERVAL '24 hours'
ORDER BY p."publishDate" DESC;
```

### 2. Check Posts That Are Stuck in QUEUE
```sql
SELECT 
  p.id,
  p."publishDate",
  p.state,
  p."createdAt",
  p.error,
  EXTRACT(EPOCH FROM (NOW() - p."publishDate"))/60 as minutes_overdue
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE 
  i."providerIdentifier" = 'pinterest'
  AND p.state = 'QUEUE'
  AND p."publishDate" < NOW()
  AND p."deletedAt" IS NULL
ORDER BY p."publishDate" DESC;
```

### 3. Check for Duplicate Job IDs in BullMQ
```bash
# Connect to Redis
redis-cli

# Check for post jobs
KEYS *post*

# Check delayed jobs (scheduled posts)
ZRANGE bull:post:delayed 0 -1 WITHSCORES

# Check waiting jobs
LRANGE bull:post:waiting 0 -1

# Check failed jobs
LRANGE bull:post:failed 0 -1
```

## Most Likely Root Causes

Based on your description (posts created successfully, first posts, second stays in database), here are the most likely issues:

### A. BullMQ Job Not Created
**Symptom**: Post exists in database with state=QUEUE, but never processes

**Check application logs for**:
```
[createPost] Queueing post <post_id> with delay <delay>ms
[createPost] ✓ Post <post_id> queued successfully
```

If you DON'T see these logs, the job was never queued. Possible reasons:
1. `body.type !== 'schedule'` OR `!dayjs(body.date).isAfter(dayjs())`
2. The post was created with a past date
3. There was an error during queue.emit() that was silently caught

**Solution**: Check the post's publishDate and ensure it's in the future when created

### B. Worker Never Processes the Job
**Symptom**: Job is in BullMQ queue, but worker doesn't pick it up

**Check worker logs for**:
```
[WORKER] Processing post job: { id: '<post_id>' }
```

If you DON'T see this, the worker isn't running or isn't processing the queue.

**Solution**: Restart the worker service:
```bash
pm2 restart workers
# or
docker restart postiz-workers
```

### C. Worker Processes But Skips Publishing
**Symptom**: Worker picks up job, but skips posting

**Check logs for these skip reasons**:
```
[PostsService] ⏭️ Skipping post <post_id> - already published
[PostsService] ⚠️ Post <post_id> - integration needs refresh
[PostsService] ⚠️ Post <post_id> - integration is disabled
```

**Solution**: 
- If "already published": Database state is incorrect, manually set state to QUEUE
- If "needs refresh": Reconnect the Pinterest integration
- If "disabled": Enable the integration

### D. Pinterest API Error (Silent Failure)
**Symptom**: Worker tries to post, Pinterest rejects it, error not properly logged

**Check logs for**:
```
[Pinterest API Error]
Pinterest API error (400): <error message>
```

**Common Pinterest errors**:
- Invalid board_id
- Missing required media
- Invalid media format
- Rate limit exceeded (429)
- Board not found / no permission

**Solution**: Check Pinterest settings for the post:
```sql
SELECT 
  p.id,
  p.settings,
  p.error
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE 
  i."providerIdentifier" = 'pinterest'
  AND p.state IN ('QUEUE', 'ERROR')
  AND p."deletedAt" IS NULL;
```

### E. Integration Token Expired
**Symptom**: First post works (uses cached token), second post fails (token expired between requests)

**Check integration status**:
```sql
SELECT 
  id,
  name,
  "providerIdentifier",
  disabled,
  "refreshNeeded",
  "tokenExpiration"
FROM "Integration"
WHERE "providerIdentifier" = 'pinterest'
  AND "deletedAt" IS NULL;
```

If `refreshNeeded = true` or `disabled = true`, this is the issue.

**Solution**: Reconnect Pinterest integration in the UI

## Debugging Steps to Run Now

1. **Check if second post exists in database**:
   ```sql
   SELECT COUNT(*), state 
   FROM "Post" p
   JOIN "Integration" i ON p."integrationId" = i.id
   WHERE i."providerIdentifier" = 'pinterest'
     AND p."publishDate" >= NOW() - INTERVAL '1 hour'
     AND p."deletedAt" IS NULL
   GROUP BY state;
   ```
   Expected: `QUEUE: 1, PUBLISHED: 1` (or similar)

2. **Check application logs** for the specific post ID:
   ```bash
   # Find the post ID of the stuck post from SQL above
   grep "<POST_ID>" /var/log/postiz/app.log
   # or in Docker
   docker logs postiz-backend | grep "<POST_ID>"
   docker logs postiz-workers | grep "<POST_ID>"
   ```

3. **Check Redis for the job**:
   ```bash
   redis-cli
   # Search for the post ID
   KEYS *<POST_ID>*
   ```

4. **Manually re-queue the post** (if stuck):
   ```bash
   # In your backend, call the changeDate API to re-queue
   curl -X POST http://localhost:3000/posts/<POST_ID>/date \\
     -H "Authorization: Bearer <TOKEN>" \\
     -d '{"date": "<FUTURE_DATE>"}'
   ```

## What to Report Back

Please provide:

1. **Result of SQL query #1** (post states)
2. **Result of SQL query #2** (overdue posts)
3. **Application logs** containing the stuck post ID
4. **Redis query results** (does the job exist in queue?)
5. **Integration status** (is it enabled and connected?)

With this information, I can pinpoint the exact issue and provide a fix.

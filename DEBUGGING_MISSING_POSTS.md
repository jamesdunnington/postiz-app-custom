# Debugging Missing Posts Issue

## Problem
When scheduling 2 posts for the same integration 15 seconds apart (e.g., 14:30:00 and 14:30:15), only 1 post is being published.

## Diagnostic Steps

### 1. Check Database
Run this SQL query to see both posts:

```sql
SELECT 
  id,
  "integrationId",
  "publishDate",
  state,
  "createdAt",
  "releaseURL",
  error
FROM "Post"
WHERE 
  "integrationId" = 'YOUR_INTEGRATION_ID'
  AND "publishDate" >= NOW() - INTERVAL '1 hour'
  AND "deletedAt" IS NULL
ORDER BY "publishDate" ASC;
```

**Expected**: You should see BOTH posts in the database
- If you only see 1 post → Creation issue (check frontend/API logs)
- If you see 2 posts with different states → Processing issue (continue below)

### 2. Check Post States

**State Analysis**:
- `QUEUE`: Post is scheduled but not yet processed
- `PUBLISHED`: Post was successfully published
- `ERROR`: Post failed to publish
- `DRAFT`: Post is saved as draft

If both posts exist but one is still `QUEUE`:
```sql
-- Check if the BullMQ job exists
SELECT id, state, "publishDate"  
FROM "Post"
WHERE state = 'QUEUE'
  AND "publishDate" < NOW()
  AND "deletedAt" IS NULL;
```

### 3. Check Application Logs

Look for these log patterns:

**Post Creation Logs**:
```
[createOrUpdatePost] Creating post at <timestamp>
event to dispatch: { pattern: 'post', data: { id: '<post_id>' } }
```

**Worker Processing Logs**:
```
[WORKER] Processing post job: { id: '<post_id>' }
[PostsService] Starting post processing for ID: <post_id>
[PostsService] Post <post_id> details: { state: 'QUEUE', integration: '...' }
```

**Success Logs**:
```
[PostsService] ✅ Post <post_id> successfully published to <platform>
✓ Post <post_id> state updated to PUBLISHED after successful publish
```

**Skip/Ignore Logs**:
```
[PostsService] ⏭️ Skipping post <post_id> - already published
[PostsService] ⚠️ Post <post_id> - integration needs refresh
[PostsService] ⚠️ Post <post_id> - integration is disabled
```

### 4. Check Redis/BullMQ Queue

Connect to Redis and check the queue:

```bash
redis-cli
# List all keys in the 'post' queue
KEYS *post*

# Check waiting jobs
LRANGE bull:post:waiting 0 -1

# Check active jobs
LRANGE bull:post:active 0 -1

# Check delayed jobs
ZRANGE bull:post:delayed 0 -1 WITHSCORES
```

### 5. Check for Errors in Sentry

Look for these error patterns:
- `Failed to update post state after successful publish`
- `Post worker failed`
- `Error processing post`
- Rate limit errors from social media platform

## Common Root Causes

### A. Jobs Are Being Removed Too Quickly
**Symptom**: Both posts created, but second one never processes

**Cause**: In `client.ts:798-801`, the code calls `delete('post', previousPost)` before queueing new job

**Solution**: Check if `previousPost` is accidentally matching the second post's ID

**Fix**: Add logging to see what's being deleted:
```typescript
console.log(`[DEBUG] Deleting previous job: ${previousPost ? previousPost : posts?.[0]?.id}`);
await this._workerServiceProducer.delete(
  'post',
  previousPost ? previousPost : posts?.[0]?.id
);
console.log(`[DEBUG] Queueing new job: ${posts[0].id} with delay ${delay}ms`);
```

### B. Group ID Collision
**Symptom**: Second post gets soft-deleted immediately after creation

**Cause**: Both posts might be assigned the same `group` ID, causing the second to delete the first

**Check**: In your API logs, look for the `rawBody` logged on line 142 of posts.controller.ts:
```json
{
  "posts": [
    { "group": "abc123", ... },  // ← Check if this exists
    { "group": "abc123", ... }   // ← And if they match
  ]
}
```

**Solution**: Ensure each post gets a unique group ID or no group ID at all

### C. BullMQ Job ID Collision
**Symptom**: Second job never appears in Redis

**Cause**: Both posts somehow have the same ID

**Check**: Look for duplicate post IDs in database:
```sql
SELECT id, COUNT(*) 
FROM "Post"
WHERE "deletedAt" IS NULL
GROUP BY id
HAVING COUNT(*) > 1;
```

### D. Social Media Platform Rate Limiting
**Symptom**: First post succeeds, second post fails silently

**Platforms Known to Have Rate Limits**:
- Twitter/X: 300 posts per 3 hours
- Instagram: Unofficial limit ~1 post per minute
- Facebook: Varies by page
- LinkedIn: ~100 posts per day

**Solution**: Add delays between posts to the same integration

### E. Worker Not Processing Delayed Jobs
**Symptom**: Post stuck in `QUEUE` state forever

**Check**: Is the worker running?
```bash
# Check if worker process is running
pm2 list
# or
ps aux | grep worker
```

**Check**: BullMQ worker configuration
```typescript
// In workers/src/main.ts, check concurrency settings
```

## Temporary Workaround

Until the root cause is fixed, you can:

1. **Add a 1-minute gap** between posts to the same integration
2. **Use different integrations** if posting to multiple accounts
3. **Manually reschedule** the missed post using the UI

## Recommended Fix

Based on the analysis, I recommend:

1. **Add unique job tracking**: Generate a unique job ID that includes both post ID and a timestamp
   ```typescript
   jobId: `${packet.data.id}_${Date.now()}`
   ```

2. **Add defensive logging**: Log every step of the post creation and queueing process

3. **Add retry logic**: If a post fails to queue, retry with exponential backoff

4. **Monitor BullMQ health**: Add metrics to track job processing rates and failures

## Testing Script

Run this to test the issue:

```bash
# Create 2 posts 15 seconds apart via API
curl -X POST http://localhost:3000/posts \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "type": "schedule",
    "date": "2026-01-15T14:30:00Z",
    "shortLink": false,
    "tags": [],
    "posts": [{
      "integration": { "id": "YOUR_INTEGRATION_ID" },
      "value": [{ "content": "Test post 1", "image": [] }],
      "settings": {}
    }]
  }'

sleep 15

curl -X POST http://localhost:3000/posts \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "type": "schedule",
    "date": "2026-01-15T14:30:15Z",
    "shortLink": false,
    "tags": [],
    "posts": [{
      "integration": { "id": "YOUR_INTEGRATION_ID" },
      "value": [{ "content": "Test post 2", "image": [] }],
      "settings": {}
    }]
  }'
```

Then check the database and logs to see if both posts were created and processed.

## Next Steps

1. Run the diagnostic SQL queries above
2. Check your application logs for the patterns mentioned
3. Look at Redis to see if jobs are being queued
4. Report back what you find, and we can narrow down the root cause

---

**Note**: The race condition fix I implemented earlier (using transactions) only prevents duplicate time slots. If both posts are 15 seconds apart, they should NOT be affected by that fix since they're at different times.

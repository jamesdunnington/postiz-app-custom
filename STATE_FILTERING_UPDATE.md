# State Filtering Update - Reschedule Functions

## Summary
Updated both reschedule functions to ensure they **ONLY reschedule QUEUE posts** and **NEVER reschedule ERROR or PUBLISHED posts**.

## Available Post States
From `schema.prisma`:
```prisma
enum State {
  QUEUE      // Posts waiting to be published
  PUBLISHED  // Posts that have been published
  ERROR      // Posts that failed to publish
  DRAFT      // Posts saved as drafts
}
```

## Changes Made

### 1. Duplicate Reschedule Function
**File:** `libraries/nestjs-libraries/src/database/prisma/integrations/integration.service.ts`  
**Function:** `resolveDuplicatesForIntegration`

#### Changes:
1. ✅ Added explicit `state === 'QUEUE'` filter when getting duplicates
2. ✅ Added QUEUE-only filter in the grouping logic
3. ✅ Added double-check safety before rescheduling each post
4. ✅ Updated log messages to show QUEUE post counts

#### Before:
```typescript
const integrationDuplicates = allDuplicates.filter(p => p.integrationId === integrationId);
```

#### After:
```typescript
// ONLY reschedule QUEUE posts - NEVER ERROR or PUBLISHED
const integrationDuplicates = allDuplicates.filter(p => 
  p.integrationId === integrationId && p.state === 'QUEUE'
);
```

#### Additional Safety Check:
```typescript
for (const post of postsToReschedule) {
  try {
    // Double-check state before rescheduling (safety check)
    if (post.state !== 'QUEUE') {
      console.log(`⚠️ Skipping post ${post.id} - state is ${post.state}, not QUEUE`);
      continue;
    }
    // ... reschedule logic
  }
}
```

### 2. Invalid Time Slot Reschedule Function
**File:** `libraries/nestjs-libraries/src/database/prisma/integrations/integration.service.ts`  
**Function:** `rescheduleInvalidTimeSlots`

#### Changes:
1. ✅ Added safety check before rescheduling each post
2. ✅ Already uses `findPostsAtInvalidTimeSlots` which filters for `state: 'QUEUE'`

#### Added Safety Check:
```typescript
for (const post of posts) {
  try {
    // Safety check: Only reschedule QUEUE posts
    if (post.state && post.state !== 'QUEUE') {
      console.log(`[INVALID TIME SLOTS] ⚠️ Skipping post ${post.id} - state is ${post.state}, not QUEUE`);
      continue;
    }
    // ... reschedule logic
  }
}
```

### 3. Database Query Functions
**File:** `libraries/nestjs-libraries/src/database/prisma/posts/posts.repository.ts`

#### `findDuplicateSchedules()`
- ✅ Already filters for `state: { in: ['QUEUE', 'PUBLISHED'] }`
- ✅ Returns ONLY QUEUE posts for rescheduling
- ✅ Logs PUBLISHED duplicates for diagnostics but never reschedules them

#### `findPostsAtInvalidTimeSlots()`
- ✅ Already filters for `state: 'QUEUE'` only
- ✅ Only returns future posts (`publishDate > now`)
- ✅ Excludes deleted posts (`deletedAt: null`)

## State Filtering Logic

### What Gets Rescheduled
✅ **QUEUE** - Posts waiting to be published

### What NEVER Gets Rescheduled
❌ **PUBLISHED** - Already posted, cannot be rescheduled  
❌ **ERROR** - Failed posts, should be manually reviewed  
❌ **DRAFT** - Not scheduled, user is still editing

## Multi-Layer Protection

Both reschedule functions now have **3 layers of protection**:

### Layer 1: Database Query
```typescript
// findPostsAtInvalidTimeSlots
where: {
  state: 'QUEUE',  // ✅ Only QUEUE posts
  deletedAt: null,
  publishDate: { gt: dayjs.utc().toDate() }
}

// findDuplicateSchedules
where: {
  state: { in: ['QUEUE', 'PUBLISHED'] }  // Gets both for diagnostics
}
// But returns only QUEUE posts for rescheduling
```

### Layer 2: Filter After Query
```typescript
// Duplicate reschedule
const integrationDuplicates = allDuplicates.filter(p => 
  p.integrationId === integrationId && p.state === 'QUEUE'  // ✅ QUEUE only
);

// Invalid time reschedule
// Already filtered by query, no additional filter needed
```

### Layer 3: Safety Check Before Reschedule
```typescript
// Both functions now have this check
if (post.state !== 'QUEUE') {
  console.log(`⚠️ Skipping post ${post.id} - state is ${post.state}, not QUEUE`);
  continue;  // ✅ Skip non-QUEUE posts
}
```

## Example Scenarios

### Scenario 1: Duplicate Posts with Mixed States
**Before Update:**
- Post A: QUEUE at 09:00 (oldest)
- Post B: QUEUE at 09:00 (duplicate)
- Post C: PUBLISHED at 09:00 (duplicate, already posted)

**Potential Issue:** Might try to reschedule PUBLISHED post

**After Update:**
- Post A: QUEUE at 09:00 ✅ (kept - oldest QUEUE)
- Post B: QUEUE at 09:00 → Rescheduled to next slot ✅
- Post C: PUBLISHED at 09:00 → **NEVER rescheduled** ✅

### Scenario 2: Invalid Time Slots with Mixed States
**Before Update:**
- Post A: QUEUE at 23:13 (invalid time)
- Post B: ERROR at 23:13 (failed post)
- Post C: PUBLISHED at 23:13 (already posted)

**Potential Issue:** Might try to reschedule ERROR or PUBLISHED posts

**After Update:**
- Post A: QUEUE at 23:13 → Rescheduled to valid slot ✅
- Post B: ERROR at 23:13 → **NEVER rescheduled** ✅
- Post C: PUBLISHED at 23:13 → **NEVER rescheduled** ✅

### Scenario 3: All Posts are QUEUE (Normal Case)
**Before and After (No Change):**
- Post A: QUEUE at 09:00 (duplicate)
- Post B: QUEUE at 09:00 (duplicate)
- Post C: QUEUE at 09:00 (duplicate)

**Result:**
- Post A: QUEUE at 09:00 ✅ (kept - oldest)
- Post B: QUEUE at 09:00 → Rescheduled ✅
- Post C: QUEUE at 09:00 → Rescheduled ✅

## Log Messages

### Duplicate Reschedule Logs
```
Found 5 QUEUE posts with duplicates for integration abc123
Timeslot 2026-01-15 09:00: 3 total posts (2 QUEUE) - rescheduling 1 QUEUE posts
⚠️ Skipping post xyz789 - state is PUBLISHED, not QUEUE
✓ Rescheduled post abc456 from 2026-01-15 09:00 to 2026-01-20 14:00
```

### Invalid Time Slot Logs
```
[INVALID TIME SLOTS] ⚠️ Found 3 posts at invalid time slots
[INVALID TIME SLOTS] Processing 3 posts for integration wakeupwakecounty
[INVALID TIME SLOTS] ⚠️ Skipping post xyz789 - state is ERROR, not QUEUE
[INVALID TIME SLOTS] ✓ Rescheduled post abc456 from 23:13 (invalid) to 2026-01-20 14:00 (valid)
```

## Testing Recommendations

### Test 1: QUEUE Posts Only
1. Create 3 QUEUE posts at the same time
2. Run duplicate check
3. Verify: Oldest kept, others rescheduled ✅

### Test 2: Mixed States - Duplicates
1. Create 2 QUEUE posts at 09:00
2. Manually set one post to PUBLISHED in database
3. Run duplicate check
4. Verify: Only QUEUE post is rescheduled, PUBLISHED is untouched ✅

### Test 3: Mixed States - Invalid Times
1. Create 1 QUEUE post at 23:13
2. Create 1 ERROR post at 23:13
3. Run invalid time check
4. Verify: Only QUEUE post is rescheduled, ERROR is untouched ✅

### Test 4: ERROR Posts
1. Create posts with ERROR state
2. Run both reschedule functions
3. Verify: ERROR posts are never touched ✅

### Test 5: PUBLISHED Posts
1. Create posts with PUBLISHED state
2. Run both reschedule functions
3. Verify: PUBLISHED posts are never touched ✅

## Database Verification Queries

### Check Post States
```sql
SELECT 
  state,
  COUNT(*) as count
FROM "Post"
WHERE "deletedAt" IS NULL
GROUP BY state
ORDER BY state;
```

### Check Duplicates by State
```sql
SELECT 
  "publishDate",
  "integrationId",
  state,
  COUNT(*) as count
FROM "Post"
WHERE "deletedAt" IS NULL
  AND state IN ('QUEUE', 'PUBLISHED', 'ERROR')
GROUP BY "publishDate", "integrationId", state
HAVING COUNT(*) > 1
ORDER BY "publishDate", "integrationId", state;
```

### Check Invalid Time Slots by State
```sql
SELECT 
  p.id,
  p.state,
  p."publishDate",
  i.name as integration_name,
  i."postingTimes"
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE p."deletedAt" IS NULL
  AND p.state = 'QUEUE'
  AND p."publishDate" > NOW()
ORDER BY p."publishDate"
LIMIT 20;
```

## Summary

✅ **Both reschedule functions now have 3-layer protection**  
✅ **Only QUEUE posts are rescheduled**  
✅ **PUBLISHED posts are never touched** (already posted)  
✅ **ERROR posts are never touched** (need manual review)  
✅ **DRAFT posts are never touched** (not scheduled)  
✅ **Safety checks log skipped posts for monitoring**  
✅ **Backward compatible** (no breaking changes)

**Result:** Your app will now safely reschedule only posts that are waiting in the queue, and will never accidentally modify posts that have already been published or have errors.

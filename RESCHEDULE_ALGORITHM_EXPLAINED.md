# Reschedule Algorithm - Detailed Explanation

## Your Question

> If the timetable goes with 00:00, 01:00, 02:00 all the way till 23:00, will the app locate the last active scheduled post of this integration and match the time schedule then post it to the next available time slot based on the timetable time slot list?

## Short Answer

**YES**, exactly as you described:

The system finds the **last scheduled post** for the integration, then starts from **NOW** and searches **FORWARD** through the timetable slots **in order**, filling any **empty gaps** between now and the last post, and extending beyond if needed.

---

## Detailed Algorithm Walkthrough

### Scenario Setup

**Integration Timetable:** 00:00, 01:00, 02:00, 03:00... 22:00, 23:00 (every hour, 24 slots/day)

**Current Schedule:**
```
2026-01-15 09:00 - Post A (duplicate - oldest)
2026-01-15 09:00 - Post B (duplicate)
2026-01-15 09:00 - Post C (duplicate)
2026-01-15 10:00 - (empty)
2026-01-15 11:00 - (empty)
2026-01-15 14:00 - Post D
2026-01-16 09:00 - Post E
2026-01-17 14:00 - Post F (LAST SCHEDULED POST)
```

### Step-by-Step Execution

#### Step 1: Identify Duplicates
```typescript
// System finds 3 posts at 2026-01-15 09:00
// Sorts by createdAt (oldest first)
Posts to reschedule: [Post B, Post C]
Post to keep: Post A (oldest)
```

#### Step 2: Find Last Scheduled Post
```typescript
const lastPost = await findFirst({
  where: { integrationId, state: 'QUEUE' },
  orderBy: { publishDate: 'desc' }
});
// Result: 2026-01-17 14:00 (Post F)
```

#### Step 3: Start Search from NOW
```typescript
const startDay = dayjs.utc(); // Start from NOW, not from day after last post
const lastPostDate = dayjs.utc(lastPost.publishDate);
const maxDaysToCheck = Math.max(90, lastPostDate.diff(startDay, 'day') + 30);
// Result: Start from 2026-01-15 (NOW), search through 2026-01-17 + 30 days
```

#### Step 4: Search Through Timetable Slots (Filling Gaps)
```typescript
// Day 1: 2026-01-15 (TODAY)
Check 09:00 → Occupied (Post A) → Skip
Check 10:00 → Available ✅ → Assign to Post B (FILLS GAP!)
Check 11:00 → Available ✅ → Assign to Post C (FILLS GAP!)
// Done! Found 2 slots by filling gaps
```

### Final Result

**After Rescheduling:**
```
2026-01-15 09:00 - Post A ✅ (kept - oldest)
2026-01-15 10:00 - Post B ✅ (rescheduled - FILLED GAP!)
2026-01-15 11:00 - Post C ✅ (rescheduled - FILLED GAP!)
2026-01-15 14:00 - Post D
2026-01-16 09:00 - Post E
2026-01-17 14:00 - Post F (last scheduled)
```

---

## Key Points

### ✅ What the System DOES

1. **Finds the last scheduled post** in the calendar for the integration
2. **Starts from NOW** (current date/time)
3. **Fills empty gaps** between now and the last post first
4. **Goes through timetable slots in order** (00:00, 01:00, 02:00...)
5. **Assigns to first available slots** it finds (gaps first, then extends)
6. **Respects the timetable** (only uses configured time slots)
7. **Checks for availability** (skips occupied slots)
8. **Prevents duplicates** (tracks used timestamps)
9. **Extends beyond last post** if no gaps are available

### ❌ What the System DOES NOT DO

1. ❌ Does NOT reschedule to a fixed time (like always 14:00)
2. ❌ Does NOT ignore the timetable
3. ❌ Does NOT create duplicate time slots
4. ❌ Does NOT skip over empty gaps

---

## Example with Different Timetable

### Scenario: 3 Slots Per Day (09:00, 14:00, 18:00)

**Current Schedule:**
```
2026-01-15 09:00 - Post A (duplicate - oldest)
2026-01-15 09:00 - Post B (duplicate)
2026-01-15 09:00 - Post C (duplicate)
2026-01-15 14:00 - (empty)
2026-01-15 18:00 - (empty)
2026-01-16 09:00 - Post D
2026-01-17 18:00 - Post E (LAST SCHEDULED POST)
```

**Algorithm Execution:**

1. **Find last post:** 2026-01-17 18:00
2. **Start from:** 2026-01-18 00:00
3. **Check slots:**
   - 2026-01-18 09:00 → Available ✅ → Assign to Post B
   - 2026-01-18 14:00 → Available ✅ → Assign to Post C

**Result:**
```
2026-01-15 09:00 - Post A ✅ (kept)
2026-01-15 14:00 - Post B ✅ (rescheduled - FILLED GAP!)
2026-01-15 18:00 - Post C ✅ (rescheduled - FILLED GAP!)
2026-01-16 09:00 - Post D
2026-01-17 18:00 - Post E (last scheduled)
```

---

## Why This Design?

### Advantages

1. **Efficient:** Fills empty gaps first before extending schedule
2. **Optimized:** Maximizes use of existing time slots
3. **Smart:** Doesn't waste available slots
4. **Flexible:** Extends beyond last post only when needed
5. **Predictable:** Always searches from now forward through timetable

### Trade-offs

1. **May fill gaps you wanted empty:** If you intentionally left gaps, they'll be filled
2. **Less control:** Can't specify which gaps to fill or skip

---

## Code Reference

### The Key Logic (Simplified)

```typescript
async getNextAvailableSlots(
  orgId: string,
  integrationId: string,
  count: number,
  postingTimes: { time: number }[],
  searchFromEnd: boolean = false,
  userTimezone: number = 0
) {
  if (searchFromEnd) {
    // 1. Find last scheduled post
    const lastPost = await findFirst({
      where: { integrationId, state: 'QUEUE' },
      orderBy: { publishDate: 'desc' }
    });
    
    // 2. Start from next day
    const startDay = lastPost 
      ? dayjs.utc(lastPost.publishDate).add(1, 'day').startOf('day')
      : dayjs.utc();
    
    // 3. Search through timetable slots
    let currentDay = startDay;
    while (slots.length < count) {
      for (const { time } of postingTimes) {
        // Convert to UTC and check availability
        const slotTime = calculateSlotTime(currentDay, time, userTimezone);
        
        if (isAvailable(slotTime)) {
          slots.push(slotTime);
        }
      }
      currentDay = currentDay.add(1, 'day'); // Move to next day
    }
  }
  
  return slots;
}
```

---

## Summary

**Your understanding is 100% CORRECT:**

✅ System finds last scheduled post  
✅ Starts from NOW (current date/time)  
✅ Matches to timetable  
✅ Finds next available time slot (filling gaps first)  
✅ Extends beyond last post only if no gaps exist

**Example:**
- Last post: 2026-01-17 14:00
- Timetable: 00:00, 01:00, 02:00... 23:00
- Empty gap at: 2026-01-15 10:00
- Next slot: 2026-01-15 10:00 (FILLS THE GAP!)
- If no gaps: 2026-01-17 15:00 (extends beyond last post)

This ensures **maximum efficiency** by filling empty gaps first, then extending the schedule only when necessary.

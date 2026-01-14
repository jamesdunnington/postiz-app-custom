# Timezone Fix Summary

## Issue Description
The timetable time slots in the integration list were showing time in UTC instead of the user's local timezone (GMT+8). When setting 0:00hrs, it was displaying as 08:00hrs in the timetable, even though the calendar correctly showed 0:00hrs.

## Root Cause
The time values stored in the database are already in **local minutes** (0-1439 representing minutes from midnight in the user's timezone). However, the display code was incorrectly treating these values as UTC and converting them to local time again, causing an 8-hour offset for GMT+8 users.

### Example of the Problem:
- User sets: **0:00** (midnight)
- Stored as: **0** minutes (local time)
- Displayed as: **08:00** (incorrectly converted from UTC to GMT+8)
- Should display: **0:00** (direct display of local time)

## Files Modified

### 1. `apps/frontend/src/components/launches/time.table.tsx`
**Changed:** Time display formatting in the timetable component

**Before:**
```tsx
formatted: dayjs
  .utc()
  .startOf('day')
  .add(time, 'minutes')
  .local()
  .format('HH:mm'),
```

**After:**
```tsx
// time is already in local minutes (0-1439), so display directly
formatted: newDayjs()
  .startOf('day')
  .add(time, 'minutes')
  .format('HH:mm'),
```

### 2. `apps/frontend/src/components/launches/calendar.tsx`
**Changed:** Calendar day view time slot display (2 locations)

**Location 1 - Time label display:**
```tsx
// Before
{newDayjs()
  .utc()
  .startOf('day')
  .add(option[0].time, 'minute')
  .local()
  .format(isUSCitizen() ? 'hh:mm A' : 'LT')}

// After
{newDayjs()
  .startOf('day')
  .add(option[0].time, 'minute')
  .format(isUSCitizen() ? 'hh:mm A' : 'LT')}
```

**Location 2 - Calendar column date:**
```tsx
// Before
<CalendarColumn
  getDate={currentDay
    .startOf('day')
    .add(option[0].time, 'minute')
    .local()}
/>

// After
<CalendarColumn
  getDate={currentDay
    .startOf('day')
    .add(option[0].time, 'minute')}
/>
```

## How It Works Now

### Data Flow:
1. **User Input:** User selects time (e.g., 0:00) in their local timezone
2. **Storage:** Time is stored as minutes from midnight (e.g., 0 for midnight)
3. **Display:** Time is displayed directly without timezone conversion
4. **Scheduling:** Backend handles UTC conversion using user's timezone setting

### Backend Timezone Handling:
The backend already correctly handles timezone conversion:
- User's timezone is stored in the database (e.g., 480 minutes for GMT+8)
- When scheduling posts, the backend converts local time to UTC
- When retrieving posts, the backend converts UTC back to local time

## Testing Recommendations

1. **Timetable Display:**
   - Set a time slot at 0:00 - should display as "00:00"
   - Set a time slot at 23:13 - should display as "23:13"
   - Verify all time slots show the exact time you set

2. **Calendar Display:**
   - Check that calendar shows posts at the correct local time
   - Verify day view shows time slots matching the timetable

3. **Scheduling:**
   - Create a post scheduled for 0:00 local time
   - Verify it appears at 0:00 in the calendar
   - Check database to confirm it's stored correctly in UTC

## Related Components

The following components work together for timezone handling:

- **Frontend:**
  - `apps/frontend/src/components/layout/set.timezone.tsx` - Timezone detection
  - `apps/frontend/src/components/settings/metric.component.tsx` - Timezone settings
  - `apps/frontend/src/components/launches/time.table.tsx` - Time slot management
  - `apps/frontend/src/components/launches/calendar.tsx` - Calendar display

- **Backend:**
  - `libraries/nestjs-libraries/src/database/prisma/posts/posts.repository.ts` - Post scheduling
  - `libraries/nestjs-libraries/src/database/prisma/integrations/integration.service.ts` - Integration time slots

## Notes

- The fix ensures consistency between timetable display and calendar display
- No database changes required - the storage format is correct
- User timezone setting (GMT+8 = 480 minutes) is properly used by the backend
- The `newDayjs()` function respects the user's timezone setting from localStorage

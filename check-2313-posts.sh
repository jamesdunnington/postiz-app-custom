#!/bin/bash

# Check for posts scheduled at 23:13 (15:13 UTC for GMT+8)
# This script helps diagnose why validation isn't catching these posts

echo "=== Checking for posts at 23:13 local time (15:13 UTC) ==="
echo ""

# Connect to PostgreSQL and run diagnostic queries
docker exec postiz-postgres psql -U postiz-user -d postiz-db-local << 'EOF'

-- Check timezone setting
SELECT 
    u.timezone,
    CASE 
        WHEN u.timezone = 480 THEN 'GMT+8 (correct)'
        WHEN u.timezone = -480 THEN 'GMT-8 (inverted!)'
        ELSE 'Other: ' || u.timezone || ' minutes'
    END as timezone_interpretation
FROM "User" u
LIMIT 1;

-- Count posts at 15:13 UTC by state
SELECT 
    state,
    COUNT(*) as count,
    MIN("publishDate") as earliest,
    MAX("publishDate") as latest
FROM "Post"
WHERE 
    EXTRACT(HOUR FROM "publishDate" AT TIME ZONE 'UTC') = 15
    AND EXTRACT(MINUTE FROM "publishDate" AT TIME ZONE 'UTC') = 13
    AND "deletedAt" IS NULL
GROUP BY state
ORDER BY state;

-- Show specific posts at 15:13 UTC (should be 23:13 in GMT+8)
SELECT 
    p.id,
    p.state,
    p."publishDate" AT TIME ZONE 'UTC' as utc_time,
    p."publishDate" AT TIME ZONE 'UTC' + INTERVAL '8 hours' as local_gmt8_time,
    EXTRACT(HOUR FROM p."publishDate" AT TIME ZONE 'UTC') * 60 + 
    EXTRACT(MINUTE FROM p."publishDate" AT TIME ZONE 'UTC') as utc_minutes,
    (EXTRACT(HOUR FROM p."publishDate" AT TIME ZONE 'UTC') + 8) * 60 + 
    EXTRACT(MINUTE FROM p."publishDate" AT TIME ZONE 'UTC') as local_minutes,
    i.name as integration_name
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE 
    EXTRACT(HOUR FROM p."publishDate" AT TIME ZONE 'UTC') = 15
    AND EXTRACT(MINUTE FROM p."publishDate" AT TIME ZONE 'UTC') = 13
    AND "deletedAt" IS NULL
    AND p."publishDate" > NOW()  -- Only future posts
ORDER BY p."publishDate"
LIMIT 10;

-- Check if posts are in QUEUE state (validation only checks QUEUE)
SELECT 
    state,
    COUNT(*) as count
FROM "Post"
WHERE 
    EXTRACT(HOUR FROM "publishDate" AT TIME ZONE 'UTC') = 15
    AND EXTRACT(MINUTE FROM "publishDate" AT TIME ZONE 'UTC') = 13
    AND "deletedAt" IS NULL
    AND "publishDate" > NOW()  -- Only future posts
GROUP BY state;

-- Show configured time slots for first integration
SELECT 
    id,
    name,
    "providerIdentifier",
    "postingTimes"
FROM "Integration"
WHERE "deletedAt" IS NULL
LIMIT 1;

EOF

echo ""
echo "=== Analysis ==="
echo "If you see posts at 15:13 UTC (23:13 GMT+8) with state='QUEUE':"
echo "  - They SHOULD be caught by validation"
echo "  - If not caught, the code has a timezone bug"
echo ""
echo "If all posts are PUBLISHED:"
echo "  - Validation correctly ignores PUBLISHED posts"
echo "  - No action needed"

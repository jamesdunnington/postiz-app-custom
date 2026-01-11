# SQL Queries to Find and Delete Invalid Posts

This document provides SQL queries to find and delete posts without images and/or without board IDs (for Pinterest) directly from your database.

## Quick Access to Database

```bash
# Connect to your Postiz database
docker exec -it <postgres-container-name> psql -U postgres -d postiz

# Find your container name
docker ps | grep postgres
```

---

## 1. Find Posts Without Images

```sql
-- View posts without images
SELECT 
    p.id,
    p."publishDate",
    p.state,
    p.content,
    i.name as integration_name,
    i."providerIdentifier",
    p.image,
    p."organizationId"
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE 
    p."deletedAt" IS NULL 
    AND p."parentPostId" IS NULL
    AND p.state IN ('QUEUE', 'DRAFT')
    AND (
        p.image IS NULL 
        OR p.image = '' 
        OR p.image = '[]'
    )
ORDER BY p."publishDate";
```

### Count by Integration
```sql
SELECT 
    i.name as integration_name,
    i."providerIdentifier",
    COUNT(*) as posts_without_images
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE 
    p."deletedAt" IS NULL 
    AND p."parentPostId" IS NULL
    AND p.state IN ('QUEUE', 'DRAFT')
    AND (
        p.image IS NULL 
        OR p.image = '' 
        OR p.image = '[]'
    )
GROUP BY i.name, i."providerIdentifier"
ORDER BY posts_without_images DESC;
```

---

## 2. Find Pinterest Posts Without Board ID

```sql
-- View Pinterest posts without board ID
SELECT 
    p.id,
    p."publishDate",
    p.state,
    p.content,
    i.name as integration_name,
    p.settings,
    p."organizationId"
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE 
    p."deletedAt" IS NULL 
    AND p."parentPostId" IS NULL
    AND p.state IN ('QUEUE', 'DRAFT')
    AND i."providerIdentifier" = 'pinterest'
    AND (
        p.settings IS NULL 
        OR p.settings = ''
        OR p.settings = '{}'
        OR p.settings NOT LIKE '%"board"%'
        OR p.settings LIKE '%"board":""%'
        OR p.settings LIKE '%"board":null%'
    )
ORDER BY p."publishDate";
```

### Count Pinterest Posts Without Board ID
```sql
SELECT 
    i.name as integration_name,
    COUNT(*) as posts_without_board
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE 
    p."deletedAt" IS NULL 
    AND p."parentPostId" IS NULL
    AND p.state IN ('QUEUE', 'DRAFT')
    AND i."providerIdentifier" = 'pinterest'
    AND (
        p.settings IS NULL 
        OR p.settings = ''
        OR p.settings = '{}'
        OR p.settings NOT LIKE '%"board"%'
        OR p.settings LIKE '%"board":""%'
        OR p.settings LIKE '%"board":null%'
    )
GROUP BY i.name
ORDER BY posts_without_board DESC;
```

---

## 3. Find All Invalid Posts (Missing Images OR Missing Board ID)

```sql
-- Comprehensive view of all invalid posts
SELECT 
    p.id,
    p."publishDate",
    p.state,
    p.content,
    i.name as integration_name,
    i."providerIdentifier",
    p.image,
    p.settings,
    p."organizationId",
    p."group",
    CASE 
        WHEN (p.image IS NULL OR p.image = '' OR p.image = '[]') 
        THEN 'Missing Image'
        ELSE 'Has Image'
    END as image_status,
    CASE 
        WHEN i."providerIdentifier" = 'pinterest' 
            AND (
                p.settings IS NULL 
                OR p.settings = ''
                OR p.settings = '{}'
                OR p.settings NOT LIKE '%"board"%'
                OR p.settings LIKE '%"board":""%'
                OR p.settings LIKE '%"board":null%'
            )
        THEN 'Missing Board ID'
        WHEN i."providerIdentifier" = 'pinterest'
        THEN 'Has Board ID'
        ELSE 'N/A'
    END as board_status
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE 
    p."deletedAt" IS NULL 
    AND p."parentPostId" IS NULL
    AND p.state IN ('QUEUE', 'DRAFT')
    AND (
        -- Missing image
        (p.image IS NULL OR p.image = '' OR p.image = '[]')
        OR
        -- Pinterest missing board ID
        (
            i."providerIdentifier" = 'pinterest'
            AND (
                p.settings IS NULL 
                OR p.settings = ''
                OR p.settings = '{}'
                OR p.settings NOT LIKE '%"board"%'
                OR p.settings LIKE '%"board":""%'
                OR p.settings LIKE '%"board":null%'
            )
        )
    )
ORDER BY p."publishDate";
```

### Summary Statistics
```sql
SELECT 
    i."providerIdentifier",
    i.name as integration_name,
    COUNT(*) as total_invalid_posts,
    SUM(CASE WHEN (p.image IS NULL OR p.image = '' OR p.image = '[]') THEN 1 ELSE 0 END) as missing_image,
    SUM(CASE 
        WHEN i."providerIdentifier" = 'pinterest' 
            AND (
                p.settings IS NULL 
                OR p.settings = ''
                OR p.settings = '{}'
                OR p.settings NOT LIKE '%"board"%'
                OR p.settings LIKE '%"board":""%'
                OR p.settings LIKE '%"board":null%'
            )
        THEN 1 
        ELSE 0 
    END) as missing_board_id
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE 
    p."deletedAt" IS NULL 
    AND p."parentPostId" IS NULL
    AND p.state IN ('QUEUE', 'DRAFT')
    AND (
        (p.image IS NULL OR p.image = '' OR p.image = '[]')
        OR
        (
            i."providerIdentifier" = 'pinterest'
            AND (
                p.settings IS NULL 
                OR p.settings = ''
                OR p.settings = '{}'
                OR p.settings NOT LIKE '%"board"%'
                OR p.settings LIKE '%"board":""%'
                OR p.settings LIKE '%"board":null%'
            )
        )
    )
GROUP BY i."providerIdentifier", i.name
ORDER BY total_invalid_posts DESC;
```

---

## 4. Delete Invalid Posts (Soft Delete)

⚠️ **IMPORTANT:** Always verify what will be deleted before running delete commands!

### Step 1: Count posts to be deleted
```sql
SELECT COUNT(*) FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE 
    p."deletedAt" IS NULL 
    AND p."parentPostId" IS NULL
    AND p.state IN ('QUEUE', 'DRAFT')
    AND (
        (p.image IS NULL OR p.image = '' OR p.image = '[]')
        OR
        (
            i."providerIdentifier" = 'pinterest'
            AND (
                p.settings IS NULL 
                OR p.settings = ''
                OR p.settings = '{}'
                OR p.settings NOT LIKE '%"board"%'
                OR p.settings LIKE '%"board":""%'
                OR p.settings LIKE '%"board":null%'
            )
        )
    );
```

### Step 2: Delete posts without images
```sql
-- Soft delete posts without images
UPDATE "Post" 
SET "deletedAt" = NOW()
WHERE "deletedAt" IS NULL 
    AND "parentPostId" IS NULL
    AND state IN ('QUEUE', 'DRAFT')
    AND (image IS NULL OR image = '' OR image = '[]');
```

### Step 3: Delete Pinterest posts without board ID
```sql
-- Soft delete Pinterest posts without board ID
UPDATE "Post" p
SET "deletedAt" = NOW()
FROM "Integration" i
WHERE p."integrationId" = i.id
    AND p."deletedAt" IS NULL 
    AND p."parentPostId" IS NULL
    AND p.state IN ('QUEUE', 'DRAFT')
    AND i."providerIdentifier" = 'pinterest'
    AND (
        p.settings IS NULL 
        OR p.settings = ''
        OR p.settings = '{}'
        OR p.settings NOT LIKE '%"board"%'
        OR p.settings LIKE '%"board":""%'
        OR p.settings LIKE '%"board":null%'
    );
```

### Step 4: Delete all invalid posts at once
```sql
-- Soft delete all invalid posts (images + board IDs)
UPDATE "Post" p
SET "deletedAt" = NOW()
FROM "Integration" i
WHERE p."integrationId" = i.id
    AND p."deletedAt" IS NULL 
    AND p."parentPostId" IS NULL
    AND p.state IN ('QUEUE', 'DRAFT')
    AND (
        (p.image IS NULL OR p.image = '' OR p.image = '[]')
        OR
        (
            i."providerIdentifier" = 'pinterest'
            AND (
                p.settings IS NULL 
                OR p.settings = ''
                OR p.settings = '{}'
                OR p.settings NOT LIKE '%"board"%'
                OR p.settings LIKE '%"board":""%'
                OR p.settings LIKE '%"board":null%'
            )
        )
    );
```

---

## 5. Filter by Organization

Add this to any query to filter by specific organization:

```sql
-- Add to WHERE clause
AND p."organizationId" = 'YOUR_ORGANIZATION_ID'
```

Example:
```sql
SELECT * FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE 
    p."organizationId" = 'YOUR_ORGANIZATION_ID'
    AND p."deletedAt" IS NULL 
    AND p."parentPostId" IS NULL
    AND p.state IN ('QUEUE', 'DRAFT')
    AND (p.image IS NULL OR p.image = '' OR p.image = '[]');
```

---

## 6. Advanced Queries

### Find posts with both issues (missing image AND board ID)
```sql
SELECT 
    p.id,
    p."publishDate",
    i.name,
    i."providerIdentifier",
    p."organizationId"
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE 
    p."deletedAt" IS NULL 
    AND p."parentPostId" IS NULL
    AND p.state IN ('QUEUE', 'DRAFT')
    AND i."providerIdentifier" = 'pinterest'
    AND (p.image IS NULL OR p.image = '' OR p.image = '[]')
    AND (
        p.settings IS NULL 
        OR p.settings = ''
        OR p.settings = '{}'
        OR p.settings NOT LIKE '%"board"%'
        OR p.settings LIKE '%"board":""%'
        OR p.settings LIKE '%"board":null%'
    )
ORDER BY p."publishDate";
```

### Find oldest invalid posts
```sql
SELECT 
    p.id,
    p."publishDate",
    p."createdAt",
    i.name,
    i."providerIdentifier",
    AGE(NOW(), p."createdAt") as age
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE 
    p."deletedAt" IS NULL 
    AND p."parentPostId" IS NULL
    AND p.state IN ('QUEUE', 'DRAFT')
    AND (
        (p.image IS NULL OR p.image = '' OR p.image = '[]')
        OR
        (
            i."providerIdentifier" = 'pinterest'
            AND (
                p.settings IS NULL 
                OR p.settings = ''
                OR p.settings = '{}'
                OR p.settings NOT LIKE '%"board"%'
                OR p.settings LIKE '%"board":""%'
                OR p.settings LIKE '%"board":null%'
            )
        )
    )
ORDER BY p."createdAt" ASC
LIMIT 20;
```

---

## Usage Tips

1. **Always test queries first**: Use `SELECT` queries before `UPDATE` queries
2. **Use transactions**: Wrap DELETE/UPDATE in `BEGIN;` and `COMMIT;` (or `ROLLBACK;`)
3. **Backup first**: Consider backing up your database before bulk deletions
4. **Start small**: Test with one organization or a LIMIT clause first

Example transaction:
```sql
BEGIN;

-- Show what will be deleted
SELECT COUNT(*) FROM "Post" WHERE ...;

-- If count looks correct, run the update
UPDATE "Post" SET "deletedAt" = NOW() WHERE ...;

-- Review the results
SELECT COUNT(*) FROM "Post" WHERE "deletedAt" IS NOT NULL ...;

-- If satisfied: COMMIT;
-- If not satisfied: ROLLBACK;
```

---

## Troubleshooting

### Issue: No posts found
- Verify the organization ID
- Check if posts are in QUEUE or DRAFT state
- Ensure posts haven't already been deleted

### Issue: Too many posts
- Add LIMIT clause to queries for testing
- Filter by specific date range
- Filter by specific integration

### Issue: Can't connect to database
- Check Docker container is running: `docker ps`
- Verify database credentials in your .env file
- Try: `docker logs <postgres-container>`

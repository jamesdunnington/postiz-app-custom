# Cleanup Invalid Posts - Quick Reference

## 🎯 What This Does

Finds and deletes scheduled posts that have:
- ❌ **No images** (any social platform)
- ❌ **No board ID** (Pinterest only)
- ❌ **Both issues** (missing image AND board ID)

## 🚀 Quick Start (Use Right Now - SQL)

**For immediate results, use SQL directly on your VPS:**

```bash
# 1. Connect to database
docker exec -it <postgres-container-name> psql -U postgres -d postiz

# 2. Find your posts without images
SELECT 
    p.id, i.name, p."publishDate", 
    LEFT(p.content, 50) as content_preview
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE p."deletedAt" IS NULL 
    AND p."parentPostId" IS NULL
    AND p.state IN ('QUEUE', 'DRAFT')
    AND (p.image IS NULL OR p.image = '' OR p.image = '[]')
ORDER BY p."publishDate";

# 3. Delete them (after confirming!)
UPDATE "Post" 
SET "deletedAt" = NOW()
WHERE "deletedAt" IS NULL 
    AND "parentPostId" IS NULL
    AND state IN ('QUEUE', 'DRAFT')
    AND (image IS NULL OR image = '' OR image = '[]');
```

**See [SQL_CLEANUP_INVALID_POSTS.md](./SQL_CLEANUP_INVALID_POSTS.md) for complete SQL queries.**

---

## 📦 Future Use (After Deployment)

Once you deploy the code changes, you can use these commands:

### List Invalid Posts
```bash
# Inside Docker container
docker exec -it postiz-commands pnpm run command list:invalid-posts

# For specific organization
docker exec -it postiz-commands pnpm run command list:invalid-posts-by-org YOUR_ORG_ID
```

### Delete Invalid Posts
```bash
# Delete all
docker exec -it postiz-commands pnpm run command cleanup:invalid-posts

# Delete for specific organization
docker exec -it postiz-commands pnpm run command cleanup:invalid-posts-by-org YOUR_ORG_ID
```

---

## 📊 What Gets Detected

### 1. Posts Without Images
- `image` field is `null`
- `image` field is empty string `""`
- `image` field is empty array `[]`
- Applies to **all social platforms**

### 2. Pinterest Posts Without Board ID
- `settings.board` is missing
- `settings.board` is empty string
- `settings.board` is null
- Only applies to **Pinterest** posts

---

## 🔍 Finding Your Organization ID

```bash
# Option 1: SQL
docker exec -it <postgres-container> psql -U postgres -d postiz -c \
  "SELECT id, name FROM \"Organization\";"

# Option 2: From logs or URL when logged into Postiz
# URL format: https://yoursite.com/[org-id]/...
```

---

## 📁 Files Created

1. **Command**: `apps/commands/src/tasks/cleanup.invalid.posts.ts`
   - New command to find & delete invalid posts
   
2. **Repository Method**: `libraries/nestjs-libraries/src/database/prisma/posts/posts.repository.ts`
   - `findInvalidPosts()` - Query for invalid posts
   
3. **Module Registration**: `apps/commands/src/command.module.ts`
   - Registered the new command

4. **Documentation**: 
   - `docs/SQL_CLEANUP_INVALID_POSTS.md` - SQL queries
   - `docs/CLEANUP_INVALID_POSTS_QUICK_REF.md` - This file

---

## ⚠️ Safety Notes

✅ **Safe:**
- All deletions are "soft deletes" (sets `deletedAt` timestamp)
- Only affects `QUEUE` and `DRAFT` posts (not published)
- Can potentially be recovered from database

⚠️ **Important:**
- Always run `list` command first before `cleanup`
- Test with one organization first
- Backup your database before large deletions

---

## 🔧 Deployment Steps

To use the new commands on your VPS:

1. **Commit the changes:**
   ```bash
   git add .
   git commit -m "feat: add command to cleanup invalid posts"
   git push origin main
   ```

2. **Wait for GitHub Actions** to build the Docker image

3. **On your VPS:**
   ```bash
   docker compose pull
   docker compose up -d
   ```

4. **Run the command:**
   ```bash
   docker exec -it postiz-commands pnpm run command list:invalid-posts
   ```

---

## 📖 Complete Documentation

- **SQL Queries**: [SQL_CLEANUP_INVALID_POSTS.md](./SQL_CLEANUP_INVALID_POSTS.md)
- **Original Image Cleanup**: [CLEANUP_POSTS_WITHOUT_IMAGES.md](./CLEANUP_POSTS_WITHOUT_IMAGES.md)

---

## 🆘 Troubleshooting

### Container not found
```bash
# Find the correct container name
docker ps | grep postiz

# Try different names
docker exec -it postiz_commands_1 pnpm run command list:invalid-posts
docker exec -it commands pnpm run command list:invalid-posts
```

### Command not found
Your deployment may not have the new code yet. Use SQL queries instead (see above).

### No posts found
- Check your organization ID is correct
- Verify posts are in QUEUE or DRAFT state
- Posts may have already been deleted

---

## 💡 Example Workflow

```bash
# 1. Quick check with SQL
docker exec -it postgres-container psql -U postgres -d postiz -c \
  "SELECT COUNT(*) FROM \"Post\" WHERE \"deletedAt\" IS NULL 
   AND state IN ('QUEUE', 'DRAFT') 
   AND (image IS NULL OR image = '' OR image = '[]');"

# Result: "105 posts found"

# 2. See details
docker exec -it postgres-container psql -U postgres -d postiz

# Run detailed query from SQL_CLEANUP_INVALID_POSTS.md

# 3. Delete them
UPDATE "Post" SET "deletedAt" = NOW()
WHERE "deletedAt" IS NULL 
  AND state IN ('QUEUE', 'DRAFT')
  AND (image IS NULL OR image = '' OR image = '[]');

# Result: "105 posts deleted"
```

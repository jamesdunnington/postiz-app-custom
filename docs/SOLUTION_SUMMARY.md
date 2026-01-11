# 🎉 Solution Complete: Find and Delete Posts Without Images/Board IDs

## ✅ What Was Created

I've built a comprehensive solution to find and delete scheduled posts that are missing:
- Images (any platform)
- Board IDs (Pinterest only)
- Or both

## 📦 Solution Components

### 1. **Immediate Use: SQL Queries** (Use Now!)
Since your Postiz runs in Docker on a VPS, you can use SQL queries right now without deploying code changes.

**File**: `docs/SQL_CLEANUP_INVALID_POSTS.md`
- Complete SQL queries to find and delete invalid posts
- Queries for images, board IDs, or both
- Organized by integration
- Safe deletion with transaction examples

**Quick Start:**
```bash
# Connect to database
docker exec -it <postgres-container> psql -U postgres -d postiz

# Find posts without images
SELECT p.id, i.name, LEFT(p.content, 50)
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE p."deletedAt" IS NULL 
  AND p.state IN ('QUEUE', 'DRAFT')
  AND (p.image IS NULL OR p.image = '[]')
ORDER BY p."publishDate";

# Delete them (after verifying!)
UPDATE "Post" 
SET "deletedAt" = NOW()
WHERE "deletedAt" IS NULL 
  AND state IN ('QUEUE', 'DRAFT')
  AND (image IS NULL OR image = '[]');
```

### 2. **Future Use: Commands** (After Deployment)
New commands that will be available after you deploy the changes.

**Files Created:**
- `apps/commands/src/tasks/cleanup.invalid.posts.ts` - Main command file
- `apps/commands/src/tasks/cleanup.posts.without.images.ts` - Image-only cleanup
- Updated `apps/commands/src/command.module.ts` - Registered commands
- Updated `libraries/nestjs-libraries/src/database/prisma/posts/posts.repository.ts` - Query methods

**Available Commands:**
```bash
# List all invalid posts
docker exec -it postiz-commands pnpm run command list:invalid-posts

# Delete all invalid posts  
docker exec -it postiz-commands pnpm run command cleanup:invalid-posts

# By organization
docker exec -it postiz-commands pnpm run command list:invalid-posts-by-org <ORG_ID>
docker exec -it postiz-commands pnpm run command cleanup:invalid-posts-by-org <ORG_ID>
```

### 3. **Documentation**
- `docs/SQL_CLEANUP_INVALID_POSTS.md` - Complete SQL query reference
- `docs/CLEANUP_INVALID_POSTS_QUICK_REF.md` - Quick reference guide  
- `docs/CLEANUP_POSTS_WITHOUT_IMAGES.md` - Original image-only documentation

## 🔍 What Gets Detected

### Missing Images (All Platforms)
- `image` field is `null`
- `image` field is empty string `""`
- `image` field is empty array `[]`
- Invalid JSON in image field

### Missing Board ID (Pinterest Only)  
- `settings.board` is missing
- `settings.board` is empty
- `settings.board` is null
- Invalid settings JSON

### Combined Issues
Posts can have both problems (no image AND no board ID)

## 🚀 How to Use Right Now

### Option 1: SQL (Recommended - Works Immediately)

1. **Connect to your database:**
   ```bash
   docker ps | grep postgres  # Find container name
   docker exec -it <container> psql -U postgres -d postiz
   ```

2. **Run a query:**
   ```sql
   -- Count your invalid posts
   SELECT COUNT(*) FROM "Post" p
   WHERE p."deletedAt" IS NULL 
     AND p.state IN ('QUEUE', 'DRAFT')
     AND (p.image IS NULL OR p.image = '[]');
   ```

3. **See the complete SQL guide:**
   Open `docs/SQL_CLEANUP_INVALID_POSTS.md`

### Option 2: Deploy Commands (For Future Use)

1. **Commit and push:**
   ```bash
   git add .
   git commit -m "feat: add commands to cleanup posts without images/board IDs"
   git push origin main
   ```

2. **Wait for GitHub Actions** to build

3. **On your VPS:**
   ```bash
   docker compose pull
   docker compose up -d
   ```

4. **Use the commands:**
   ```bash
   docker exec -it postiz-commands pnpm run command list:invalid-posts
   ```

## 📊 What You'll See

The commands provide organized output like:

```
📋 Found 105 invalid posts:

🔸 Posts without images (87):
   • LinkedIn (linkedin): 45 posts
   • Twitter (twitter): 32 posts
   • Facebook (facebook): 10 posts

🔸 Pinterest posts without board ID (12):
   • Pinterest Board 1 (pinterest): 8 posts
   • Pinterest Board 2 (pinterest): 4 posts

🔸 Posts missing both image AND board ID (6):
   • Pinterest Board 3 (pinterest): 6 posts

📊 Summary by integration:
   • LinkedIn (linkedin): 45 total (45 no image)
   • Twitter (twitter): 32 total (32 no image)
   • Pinterest Board 1 (pinterest): 18 total (4 no image, 14 no board)
```

## ⚠️ Safety Features

✅ **All deletions are SOFT DELETES**
- Sets `deletedAt` timestamp
- Data still in database
- Can be recovered if needed

✅ **Only affects scheduled posts**
- `QUEUE` state (scheduled)
- `DRAFT` state (drafts)
- Never touches `PUBLISHED` posts

✅ **Safe workflow**
- Always list before deleting
- Clear confirmation of what will happen
- Detailed logging with Sentry

## 🎯 Quick Reference

| Task | SQL | Command (After Deploy) |
|------|-----|------------------------|
| **List all invalid posts** | See SQL doc | `list:invalid-posts` |
| **List for one org** | Add `WHERE organizationId = '...'` | `list:invalid-posts-by-org <ID>` |
| **Delete all** | `UPDATE "Post" SET...` | `cleanup:invalid-posts` |
| **Delete for one org** | See SQL doc | `cleanup:invalid-posts-by-org <ID>` |

## 📖 Documentation Files

1. **Quick Reference** → `docs/CLEANUP_INVALID_POSTS_QUICK_REF.md`
2. **SQL Queries** → `docs/SQL_CLEANUP_INVALID_POSTS.md`
3. **Image Cleanup** → `docs/CLEANUP_POSTS_WITHOUT_IMAGES.md`

## 💡 Recommended Workflow

1. **Today (Use SQL):**
   ```bash
   # Connect and run queries from SQL_CLEANUP_INVALID_POSTS.md
   docker exec -it postgres psql -U postgres -d postiz
   ```

2. **Later (After Deploy):**
   ```bash
   # Push code changes
   git push

   # After build completes
   docker compose pull && docker compose up -d

   # Use commands
   docker exec -it postiz-commands pnpm run command list:invalid-posts
   ```

## 🆘 Need Help?

**Can't find container name?**
```bash
docker ps  # List all containers
```

**SQL not working?**
- Check container name is correct
- Verify database name (might be different than `postiz`)
- Try: `docker logs <container-name>`

**Commands not working after deploy?**
- Verify GitHub Actions completed successfully
- Check: `docker exec -it postiz-commands pnpm run command --help`
- May need to rebuild: `docker compose build`

## ✨ Technical Details

- **Pattern**: Similar to existing `cleanup.future.published.ts`
- **Following conventions**: Sentry logging, conventional commits
- **Type-safe**: Proper TypeScript error handling
- **Tested pattern**: Based on working `getOldPosts()` repository method

---

**You're all set!** Start with the SQL queries to clean up your posts immediately, then deploy the commands for easier future use.

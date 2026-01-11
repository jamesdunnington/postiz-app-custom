# Cleanup Posts Without Images

This command helps you find and delete scheduled posts that don't have any images attached.

## Overview

The cleanup tool provides four commands to manage posts without images:

1. **List all posts without images** (across all organizations)
2. **Delete all posts without images** (across all organizations)
3. **List posts without images for a specific organization**
4. **Delete posts without images for a specific organization**

## Commands

### 1. List All Posts Without Images

View all scheduled posts that don't have images attached:

```bash
pnpm --filter ./apps/commands run command list:posts-without-images
```

**What it does:**
- Scans all organizations
- Finds posts in `QUEUE` or `DRAFT` state
- Filters posts where the `image` field is empty or null
- Groups results by integration for easy reading
- Shows post details including content preview and schedule time

**Example output:**
```
📋 Found 15 scheduled posts without images:

🔹 LinkedIn Personal (linkedin):
   Total posts: 8

   • Post ID: abc123...
     Scheduled: 1/1/2026, 10:00:00 AM
     State: QUEUE
     Content preview: Check out this amazing update about our product...

🔹 Twitter Account (twitter):
   Total posts: 7
   ...

💡 To delete these posts, run:
   pnpm --filter ./apps/commands run command cleanup:posts-without-images
```

### 2. Delete All Posts Without Images

⚠️ **Warning:** This permanently deletes posts. Make sure to list them first!

```bash
pnpm --filter ./apps/commands run command cleanup:posts-without-images
```

**What it does:**
- Finds all posts without images
- Deletes them by post group
- Shows progress for each deletion
- Reports total number of deleted posts

### 3. List Posts Without Images by Organization

View posts without images for a specific organization:

```bash
pnpm --filter ./apps/commands run command list:posts-without-images-by-org <ORGANIZATION_ID>
```

Replace `<ORGANIZATION_ID>` with your organization ID (UUID).

**Example:**
```bash
pnpm --filter ./apps/commands run command list:posts-without-images-by-org 550e8400-e29b-41d4-a716-446655440000
```

### 4. Delete Posts Without Images by Organization

⚠️ **Warning:** This permanently deletes posts for the specified organization.

```bash
pnpm --filter ./apps/commands run command cleanup:posts-without-images-by-org <ORGANIZATION_ID>
```

**Example:**
```bash
pnpm --filter ./apps/commands run command cleanup:posts-without-images-by-org 550e8400-e29b-41d4-a716-446655440000
```

## Finding Your Organization ID

You can find your organization ID in several ways:

1. **From the database:**
   ```sql
   SELECT id, name FROM "Organization";
   ```

2. **From the Postiz web interface:**
   - Check the URL when logged in: `https://postiz.com/[org-id]/...`
   - Or check browser DevTools → Application → Local Storage

3. **From the API:**
   ```bash
   curl -H "Authorization: Bearer YOUR_API_KEY" https://api.postiz.com/organizations
   ```

## Use Cases

### Scenario 1: Bulk cleanup across all accounts
```bash
# Step 1: Review what will be deleted
pnpm --filter ./apps/commands run command list:posts-without-images

# Step 2: If the list looks correct, delete them
pnpm --filter ./apps/commands run command cleanup:posts-without-images
```

### Scenario 2: Cleanup for a specific organization
```bash
# Step 1: Review posts for your organization
pnpm --filter ./apps/commands run command list:posts-without-images-by-org YOUR_ORG_ID

# Step 2: Delete if confirmed
pnpm --filter ./apps/commands run command cleanup:posts-without-images-by-org YOUR_ORG_ID
```

### Scenario 3: Audit before major cleanup
```bash
# List and save to file for review
pnpm --filter ./apps/commands run command list:posts-without-images > posts-to-delete.txt

# Review the file
cat posts-to-delete.txt

# If satisfied, proceed with deletion
pnpm --filter ./apps/commands run command cleanup:posts-without-images
```

## Technical Details

### What Counts as "Without Images"?

A post is considered without images if:
- The `image` field is `null`
- The `image` field is an empty string
- The `image` field is an empty JSON array: `[]`
- The `image` field contains invalid JSON

### Which Posts Are Included?

- **Included:** Posts with state `QUEUE` (scheduled) or `DRAFT`
- **Excluded:** 
  - Published posts (`PUBLISHED`)
  - Deleted posts
  - Comment/reply posts (only parent posts are checked)

### How Deletion Works

Posts are deleted by their `group` identifier. This ensures that:
- All posts in a scheduled group are deleted together
- Comments/replies associated with a post are also removed
- The deletion is atomic per group

## Logging

The commands use Sentry for structured logging:
- All operations are logged with context
- Errors are tracked and reported
- You can monitor command execution in your Sentry dashboard

## Safety Features

✅ **Safe defaults:**
- List commands never modify data
- Dry-run capability (use list commands first)
- Clear confirmation messages

⚠️ **Important notes:**
- Deletions are performed via soft delete (`deletedAt` timestamp)
- Posts can potentially be recovered from database if needed
- Always test with a single organization first

## Troubleshooting

### "No posts found"
- Verify your organization ID is correct
- Check if posts actually have empty image fields
- Ensure posts are in `QUEUE` or `DRAFT` state

### "Failed to delete"
- Check database permissions
- Verify the organization ID exists
- Check logs for detailed error messages

### Command not found
Make sure you've built the commands app:
```bash
pnpm --filter ./apps/commands run build
```

## Related Commands

- `cleanup:future-published` - Delete published posts with future dates
- `list:future-published` - List published posts with future dates

## Support

For issues or questions:
- Check Sentry logs for error details
- Review the database schema in `libraries/nestjs-libraries/src/database/prisma/schema.prisma`
- File an issue in the repository

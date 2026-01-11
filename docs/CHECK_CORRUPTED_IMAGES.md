# Corrupted Image Detection and Validation

This document describes how to check for and handle corrupted images in the Postiz database.

## Quick Start

### Bash (Linux/Mac/WSL)
```bash
# Quick check of 20 recent media items
./check-corrupted-images.sh

# Check 100 items with URL validation
./check-corrupted-images.sh -l 100 -v

# Soft-delete corrupted images
./check-corrupted-images.sh -f
```

### PowerShell (Windows)
```powershell
# Quick check of 20 recent media items
.\check-corrupted-images.ps1

# Check 100 items with URL validation
.\check-corrupted-images.ps1 -Limit 100 -ValidateUrls

# Soft-delete corrupted images
.\check-corrupted-images.ps1 -Fix
```

## What Gets Checked

The diagnostic tool identifies several types of corruption:

### 1. **Zero File Size**
Images/videos that have `fileSize = 0` in the database. This usually indicates:
- Failed uploads
- Incomplete file transfers
- Database records created without actual file uploads

### 2. **Invalid Protocol**
Media paths that don't start with `http://` or `https://`, which means:
- Malformed URLs
- Local file paths incorrectly stored
- Corrupted path data

### 3. **Invalid Extensions**
Files that don't end with supported extensions (`.png`, `.jpg`, `.jpeg`, `.gif`, `.mp4`):
- Unsupported file types
- Corrupted filenames
- Missing file extensions

### 4. **URL Accessibility** (Optional)
When using `-v` or `-ValidateUrls`, the tool also checks:
- HTTP 404 (file not found)
- HTTP 403 (access denied)
- Network timeouts
- Server errors

## How Images Are Validated in Postiz

### Upload Validation

**Backend** ([CustomFileValidationPipe](../libraries/nestjs-libraries/src/upload/custom.upload.validation.ts)):
- Images: Max 10MB
- Videos: Max 1GB
- File type validation

**Frontend** ([Media Uploader](../apps/frontend/src/components/media/new.uploader.tsx)):
- Images: Max 30MB
- Videos: Max 1GB
- Drag & drop support
- Batch upload handling

### Extension Validation

Files must have valid extensions ([ValidUrlExtension](../libraries/helpers/src/utils/valid.url.path.ts)):
- `.png`
- `.jpg` / `.jpeg`
- `.gif`
- `.mp4`

### Platform-Specific Validation

Different social media platforms have additional requirements:

**Instagram** ([instagram.provider.tsx](../apps/frontend/src/components/new-launch/providers/instagram/instagram.collaborators.tsx)):
- Stories: Max 60 seconds for videos
- Reels: Max 180 seconds
- Single media per story

**LinkedIn** ([linkedin.provider.tsx](../apps/frontend/src/components/new-launch/providers/linkedin/linkedin.provider.tsx)):
- Carousel: 2+ images, no videos
- Single video: No other media allowed

**Twitter/X** ([x.provider.tsx](../apps/frontend/src/components/new-launch/providers/x/x.provider.tsx)):
- Max 4 images per post
- Max 1 video per post
- Video duration: 140 seconds (varies by account type)

**YouTube** ([youtube.provider.tsx](../apps/frontend/src/components/new-launch/providers/youtube/youtube.provider.tsx)):
- Must be video (`.mp4`)
- Optional thumbnail image

**Reddit** ([reddit.provider.tsx](../apps/frontend/src/components/new-launch/providers/reddit/reddit.provider.tsx)):
- Media posts: Exactly 1 media file
- Videos require thumbnails

## Database Schema

The `Media` table structure:

```prisma
model Media {
  id                 String       @id @default(uuid())
  name               String       // Original filename
  path               String       // Full URL to media
  organizationId     String       // Owner organization
  thumbnail          String?      // Optional thumbnail URL
  thumbnailTimestamp Int?         // Video thumbnail timestamp
  alt                String?      // Alt text for accessibility
  fileSize           Int          @default(0)  // Size in bytes
  type               String       @default("image")  // "image" or "video"
  createdAt          DateTime     @default(now())
  updatedAt          DateTime     @updatedAt
  deletedAt          DateTime?    // Soft delete
}
```

## Diagnostic Output

The tool provides 5 categories of information:

1. **Media Statistics** - Overview by type with averages
2. **Zero File Size** - Items with missing file data
3. **Invalid Paths** - Malformed URLs or extensions
4. **Recent Media** - Latest uploads for manual inspection
5. **Issue Summary** - Total counts of suspicious items

## Fix Mode

The `-f` / `-Fix` flag enables soft-delete mode:
- Marks corrupted images with `deletedAt = NOW()`
- Does NOT permanently delete files
- Requires confirmation before execution
- Can be reverted by setting `deletedAt = NULL`

**Safety Note**: Always review the diagnostic output before running fix mode.

## URL Validation Details

The `-v` / `-ValidateUrls` flag:
- Performs HTTP HEAD requests to check file accessibility
- Uses 5-second timeout per URL
- **Warning**: Can be slow for large datasets
- Recommended for targeted checks with `-l` (limit)

### Common HTTP Status Codes

- **200 OK** - File is accessible
- **403 Forbidden** - Access denied (check CDN/S3 permissions)
- **404 Not Found** - File doesn't exist at URL
- **000** - Network timeout or connection error

## Integration with Logging

All validation failures can be logged to Sentry:

```typescript
import * as Sentry from '@sentry/nextjs';
const { logger } = Sentry;

logger.warn('Corrupted image detected', {
  mediaId: media.id,
  path: media.path,
  issue: 'zero_file_size'
});
```

## Scheduled Checks

Consider setting up periodic validation in the [cron service](../apps/cron/):

```typescript
// Example cron job to check for corrupted images weekly
@Cron('0 0 * * 0') // Every Sunday at midnight
async checkMediaIntegrity() {
  const corruptedMedia = await this.findCorruptedMedia();
  if (corruptedMedia.length > 0) {
    logger.error('Found corrupted media', { count: corruptedMedia.length });
    // Send notification or create issue
  }
}
```

## Prevention Best Practices

1. **Always validate on upload** - Use `CustomFileValidationPipe`
2. **Check file size** - Ensure `fileSize` is populated
3. **Verify URLs** - Test accessibility after upload
4. **Monitor errors** - Track upload failures in Sentry
5. **Regular audits** - Run diagnostic scripts periodically

## Related Files

- [check-corrupted-images.sh](../check-corrupted-images.sh) - Bash diagnostic script
- [check-corrupted-images.ps1](../check-corrupted-images.ps1) - PowerShell diagnostic script
- [schema.prisma](../libraries/nestjs-libraries/src/database/prisma/schema.prisma) - Database schema
- [media.service.ts](../libraries/nestjs-libraries/src/database/prisma/media/media.service.ts) - Media service
- [custom.upload.validation.ts](../libraries/nestjs-libraries/src/upload/custom.upload.validation.ts) - Upload validation

## Troubleshooting

### "Container not running"
```bash
docker compose -f ./docker-compose.dev.yaml up -d
```

### "Permission denied" (Bash)
```bash
chmod +x check-corrupted-images.sh
```

### "Too many items to check"
Use `-l` to limit results:
```bash
./check-corrupted-images.sh -l 50
```

### "URL validation too slow"
- Reduce the limit: `-l 20`
- Check specific org: `-o <org-id>`
- Run during off-peak hours

# Pinterest Batch Scheduling (CSV Upload) — Design Spec

Date: 2026-09-11
Status: Approved for planning

## Purpose

Replace the external `postiz-API` CSV scheduler (a separate Express/React/Postgres
VPS service at `schedule.thecontentwarrior.work`) with a native Postiz tab that
uploads the same CSV format, re-hosts each row's image on Postiz's own storage,
and schedules a real Pinterest post using Postiz's existing internal
slot-finding and post-creation machinery — so it can never collide with manual
scheduling or the two Pinterest deletion queues, and the external VPS service
can be decommissioned once this ships.

This is Pinterest-specific by design (the CSV's `board` column and settings
shape only make sense for Pinterest) — no attempt is made to generalize this to
other providers, since there is no current need for that.

## Existing infrastructure this design builds on

Traced directly from the codebase, not assumed:

- **Image re-hosting**: `IUploadProvider.uploadSimple(url: string): Promise<string>`
  (`libraries/nestjs-libraries/src/upload/local.storage.ts` and
  `cloudflare.storage.ts`) already downloads an arbitrary URL and re-uploads it
  to Postiz's own storage (local disk or R2, whichever `STORAGE_PROVIDER` is
  configured), returning the new public URL. Already used today by
  `MediaService`'s AI-image-generation path
  (`apps/backend/src/api/routes/media.controller.ts:77-84`). No new
  download/upload code needed — this is a direct reuse.
- **Media record creation**: `MediaService.saveFile(orgId, fileName, filePath)`
  → `MediaRepository.saveFile` creates a `Media` row and returns
  `{ id, name, path, thumbnail }`, which is exactly the shape
  `MediaDto` (`libraries/nestjs-libraries/src/dtos/media/media.dto.ts`) needs
  for a post's `image` array.
- **Slot-finding**: `PostsRepository.getNextAvailableSlots(orgId, integrationId,
  count, postingTimes, searchFromEnd, userTimezone, timezoneName?)`
  (`libraries/nestjs-libraries/src/database/prisma/posts/posts.repository.ts:1274`)
  — already used by `RescheduleMissedPostsStartup`
  (`apps/cron/src/tasks/reschedule.missed.posts.startup.ts`). Reads
  `Integration.postingTimes` (a JSON array of `{ time: minutesFromMidnight }`,
  e.g. `[{"time":120},{"time":400},{"time":700}]`), walks forward through those
  daily slots, and skips anything already occupied by an existing `QUEUE`-state
  `Post`. `searchFromEnd: true` mode specifically starts from the account's
  *last currently-scheduled post* and extends forward — the right mode for
  "append this batch after everything already on the calendar," as opposed to
  `searchFromEnd: false` which back-fills the earliest open gaps (used for
  rescuing one individually missed post).
- **Post creation + scheduling**: `PostsService.createPost(orgId, CreatePostDto)`
  (`libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts:787`)
  is the exact same call the compose UI's `POST /posts` route makes
  (`apps/backend/src/api/routes/posts.controller.ts:144-153`, via
  `mapTypeToPost`). It creates the `Post` row and — for `type: 'schedule'` with
  a future date — emits the delayed `'post'` BullMQ job itself. Calling this
  directly means a batch-scheduled pin is indistinguishable from a manually
  scheduled one to every other part of the system.
- **Pinterest post settings shape**: `PinterestSettingsDto`
  (`libraries/nestjs-libraries/src/dtos/posts/providers-settings/pinterest.dto.ts`)
  — fields `title`, `link`, `dominant_color`, `board` (board is a required
  Pinterest board id string). Discriminator value registered as `'pinterest'`
  in `all.providers.settings.ts:55`.
- **House pattern for a queued subsystem**: mirrors
  `PinterestBoardDeleteRepository`/`Service`/`Controller`/worker exactly (see
  `docs/superpowers/specs/2026-09-11-pinterest-timed-deletion-queues-design.md`)
  — same file shapes, same transactional-pointer-free-but-precomputed-schedule
  approach, same self-healing recovery cron pattern, same 7-day purge cron
  pattern. The one deliberate difference: **no artificial pacing**. The
  deletion queues space items out over hours to look human to Pinterest's
  anti-spam detection for a destructive action; scheduling has no such
  concern — the pacing that matters (when Pinterest actually sees the pin) is
  already fully handled by `postingTimes`, so each queue item processes with
  `delay: 0` and just drains as fast as the worker pool allows.

## Scope decisions (confirmed during brainstorming)

- One integration selected at a time from the same sidebar pattern as Pin
  Cleanup / Board Creation / Board Deletion — fully isolated per account,
  switching accounts resets the view. No cross-account data ever shown
  together.
- CSV format matches the existing external tool exactly (no column-mapping
  UI): `content, title, image_url, scheduled_date, board, alt_text, link`.
  Parsed client-side with `papaparse` (new frontend dependency — no CSV
  parsing library exists in this codebase today).
- A row's `scheduled_date`, when present, is used as an exact publish time.
  Blank rows are auto-assigned the account's next available posting-time
  slots, extending forward from whatever is already on the calendar
  (`searchFromEnd: true`), in CSV row order.
- Processing is a plain fast queue (BullMQ `delay: 0`), not a timed one —
  see infrastructure note above for why this differs from the deletion
  queues.
- Per-row failure doesn't block the rest of the batch, and — unlike the
  deletion queues — a failed row gets a manual **Retry** button, since
  retrying a "create" is safe in a way retrying a "delete" against
  Pinterest's rate limits isn't.
- Full per-row visibility in the UI (content preview, assigned date, status,
  error) — not the "failures only" convention used for Pin Cleanup — since
  the user needs to visually confirm boards/dates landed correctly for
  content they want published.
- Self-healing recovery (lost-job re-emission) and a 7-day purge of terminal
  rows, matching the deletion queues' conventions, for consistency and
  because the same failure modes (Redis restart losing a delayed job) apply
  equally here.
- Cap of 500 rows per CSV submission (a sane ceiling, not a real constraint
  at this scale — processing is async/queued so there's no HTTP-timeout
  pressure driving a tighter cap the way there might be for a synchronous
  design).

## Data model

```prisma
model BatchScheduleBatch {
  id              String   @id @default(uuid())
  organizationId  String
  integrationId   String
  createdByUserId String?
  source          String   // "MANUAL"
  submittedCount  Int
  createdAt       DateTime @default(now())

  organization Organization         @relation(fields: [organizationId], references: [id])
  integration  Integration          @relation(fields: [integrationId], references: [id])
  items        BatchScheduleItem[]

  @@index([integrationId, createdAt])
}

model BatchScheduleItem {
  id                  String    @id @default(uuid())
  batchId             String
  integrationId       String
  content             String
  title               String?
  imageUrl            String
  boardId             String
  altText             String?
  link                String?
  assignedPublishDate DateTime  // resolved once at submit time — explicit CSV date or an auto-assigned slot
  status              String    // "PENDING" | "SCHEDULED" | "FAILED"
  postizPostId        String?   // the real Post.id, once created
  errorMessage        String?
  processedAt         DateTime?
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt

  batch       BatchScheduleBatch @relation(fields: [batchId], references: [id], onDelete: Cascade)
  integration Integration        @relation(fields: [integrationId], references: [id])

  @@index([integrationId, status])
}
```

Add to `Integration`: `batchScheduleBatches BatchScheduleBatch[]` and
`batchScheduleItems BatchScheduleItem[]`. Add to `Organization`:
`batchScheduleBatches BatchScheduleBatch[]`.

No chain-pointer field is needed on `Integration` here (unlike the deletion
queues) — there's no artificial timer to chain; `assignedPublishDate` is
computed once from real calendar state (`getNextAvailableSlots`), not from a
per-integration pointer.

## CSV validation

A row is rejected (surfaced as a client-side validation error, never queued)
when:

- `content` is empty.
- `image_url` is empty or not a plausible URL.
- `board` is empty (Pinterest board id is mandatory — `PinterestSettingsDto`
  already enforces this server-side too).
- `scheduled_date` is present but unparseable, or parses to a time in the
  past.

`title`, `alt_text`, and `link` are optional and passed through as-is
(`alt_text` maps to `MediaDto.alt`, `link`/`title` map to
`PinterestSettingsDto.link`/`title`).

## Slot assignment algorithm (runs once, synchronously, at submit time)

```
explicitRows = rows where scheduled_date is present  → assignedPublishDate = parsed date
autoRows     = rows where scheduled_date is blank

if autoRows.length > 0:
  # request a small buffer so we can drop any accidental collision with an
  # explicit date from this same batch (neither is a real Post row yet, so
  # getNextAvailableSlots can't already know about explicitRows on its own)
  candidateSlots = getNextAvailableSlots(
    orgId, integrationId,
    count: autoRows.length + explicitRows.length,
    postingTimes: JSON.parse(integration.postingTimes),
    searchFromEnd: true,
    userTimezone, timezoneName
  )
  explicitTimestamps = Set(explicitRows.map(r => r.assignedPublishDate.getTime()))
  filteredSlots = candidateSlots.filter(s => !explicitTimestamps.has(s.getTime()))
  assign filteredSlots[0..autoRows.length-1] to autoRows, in CSV row order
```

This keeps the whole batch's dates internally consistent and collision-free
against both the real calendar and each other, computed once, before any
queue item is created — mirrors exactly how the deletion queues precompute
`scheduledFor` once at submit time rather than at processing time.

## Backend

- `libraries/nestjs-libraries/src/database/prisma/batch-schedule/batch-schedule.repository.ts`
  — `createBatchWithItems(organizationId, integrationId, createdByUserId,
  source, rows: { content, title?, imageUrl, boardId, altText?, link?,
  assignedPublishDate }[])` (plain create, no transaction/pointer needed —
  see above), `getItemById`, `markItemScheduled(itemId, postizPostId)`,
  `markItemFailed(itemId, errorMessage)`, `findOverdueItems(staleBefore)`,
  `getQueueSummary(integrationId)`, `purgeCompletedItemsOlderThan(cutoff)`.
  `getQueueSummary` shape mirrors the deletion queues:
  `{ queued, done, failed: {...}[], totalEverSubmitted, items: [{ id,
  content, boardId, status, assignedPublishDate, postizPostId,
  errorMessage }] }` (full `items` list, per the full-visibility scope
  decision — no `nextRunAt`/`lastCompletionAt` fields here since there's no
  artificial timer to report).
- `batch-schedule.service.ts` — `createBatch(...)`: validates the
  integration (Pinterest, connected), enforces the 500-row cap, runs the
  slot-assignment algorithm above, creates the batch + items, emits one
  BullMQ `'batch-schedule-item'` job per item with `delay: 0`.
  `processItem(itemId)`: loads the item (clean no-op if purged), calls
  `storage.uploadSimple(item.imageUrl)` → `mediaService.saveFile(...)` →
  builds and calls `postsService.createPost(orgId, { type: 'schedule', date:
  item.assignedPublishDate.toISOString(), shortLink: false, tags: [], posts:
  [{ integration: { id: integrationId }, group: makeId(), value: [{ id:
  makeId(), content: item.content, image: [{ id: media.id, path: media.path,
  alt: item.altText }] }], settings: { __type: 'pinterest', title:
  item.title, link: item.link, board: item.boardId } }] })`; on success,
  `markItemScheduled(itemId, result[0].postId)`; on any failure (image fetch,
  upload, or `createPost` throwing), `markItemFailed` with the error message
  — no auto-retry. `retryItem(itemId)`: re-emits the job for a `FAILED` item
  after resetting it to `PENDING`. `findStalledItemIntegrationIds` /
  `recoverOverdueItems` mirror the deletion queues' self-healing pattern
  exactly (re-emit the job for anything `PENDING` well past a staleness
  threshold, since a delayed-but-immediate job can still be lost to a Redis
  restart mid-flight the same way a genuinely delayed one can).
- `apps/workers/src/app/batch-schedule.controller.ts` — one
  `@EventPattern('batch-schedule-item', Transport.REDIS)` handler calling
  `processItem`.
- `apps/backend/src/api/routes/batch-schedule.controller.ts`:
  - `POST /batch-schedule/batches` — `{ integrationId, rows: [...] }` →
    `createBatch`.
  - `GET /batch-schedule/queue?integrationId=` → `getQueueSummary`.
  - `POST /batch-schedule/items/:id/retry` → `retryItem`.
- New DTOs under `libraries/nestjs-libraries/src/dtos/batch-schedule/` mirroring
  `PinterestBoardDeleteBatchDto`'s validation style (`@ArrayMaxSize(500)` on
  `rows`, per-row nested DTO validating the required fields from the CSV
  validation section above).
- Cron: `check.batch.schedule.stalled.ts` (recovery, `*/5 * * * *`, same
  shape as `check.pinterest.delete.stalled.ts`) and
  `purge.batch.schedule.history.ts` (7-day purge of `SCHEDULED`/`FAILED`
  rows, `0 3 * * *`, same shape as `purge.pinterest.delete.history.ts`) —
  kept as separate files from the Pinterest-delete crons since they operate
  on an unrelated table, per "don't bundle unrelated concerns."
- Module registration follows the exact pattern established this session:
  repository + service added to `database.module.ts` providers, controller
  added to `api.module.ts` and the workers `app.module.ts`, cron tasks added
  to `cron.module.ts`.

## Frontend

- New tab `apps/frontend/src/components/batch-schedule/batch.schedule.component.tsx`,
  same sidebar/channel-picker half as the other three Pinterest tabs.
- CSV upload: a file input parsed client-side with `papaparse`; parsed rows
  render as a preview table (content excerpt, title, board id, thumbnail via
  `image_url` directly — no need to wait for re-hosting to preview — assigned
  date once computed, or "auto" before submission) with inline validation
  errors per the CSV validation rules above; invalid rows are shown but
  excluded from the submit count.
- "Schedule N pins" button → `POST /batch-schedule/batches`.
- Summary strip: `Queued: N · Scheduled: N · Failed: N · Total submitted: N`
  (no next-run/completion-ETA line — this queue drains fast, not over
  hours).
- Full per-row table (same visual style as Board Creation/Board Deletion):
  content excerpt, board id, assigned date, status
  (`Pending`/`Scheduled`/`Failed`), error message + **Retry** button when
  failed, and a link to the real post (`releaseURL`-style, or just the
  `postizPostId`) once scheduled.
- New page `apps/frontend/src/app/(app)/(site)/batch-schedule/page.tsx`,
  new `top.menu.tsx` entry ("Batch Scheduling") after the existing three
  Pinterest tabs, unconditionally shown like the others (no
  integration-count gating — same pattern already established).

## Testing

- Unit tests for the slot-assignment algorithm (pure function extracted from
  the service, given a fake `getNextAvailableSlots` result): explicit-only
  rows, auto-only rows, mixed rows with a forced collision to verify the
  buffer/filter logic actually drops the colliding candidate.
- Unit tests for CSV row validation (missing content/image_url/board,
  unparseable date, past date) — pure function, no DB.
- Unit test: `processItem` success path calls `uploadSimple` then
  `saveFile` then `createPost` with the expected `CreatePostDto` shape, and
  marks the item `SCHEDULED` with the returned `postId`.
- Unit test: `processItem` failure at any stage (image fetch throws,
  `createPost` throws) marks `FAILED` with the error message, no retry
  triggered automatically.
- Unit test: purge cron leaves `PENDING` rows untouched and deletes
  `SCHEDULED`/`FAILED` rows older than 7 days plus now-empty batches.
- Manual end-to-end pass: upload a small real CSV (2-3 rows, mixed
  explicit/auto dates) against a test Pinterest account, confirm the posts
  appear on the Postiz calendar at the right times, confirm they actually
  publish to Pinterest at their scheduled time, force one failure (bad image
  URL) and confirm Retry recovers it after fixing the row.

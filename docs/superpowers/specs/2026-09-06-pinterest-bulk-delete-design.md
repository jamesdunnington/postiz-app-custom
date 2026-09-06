# Pinterest Bulk Pin Deletion — Design Spec

Date: 2026-09-06
Status: Approved for planning

## Purpose

Allow removal of up to 100 externally-flagged Pinterest pins per submission,
safely rate-limited against Pinterest's API and coordinated with Postiz's
existing publish/analytics traffic to the same accounts, with a dedicated
UI tab to monitor progress and detect stalls.

This is **not** a general "delete any post" feature and does not build a
flagging system inside Postiz. The list of pins to delete always originates
outside Postiz (a spreadsheet, another tool, or a script) and is handed to
Postiz as a list of Pinterest pin IDs/URLs. Flagged pins may or may not
correspond to a `Post` Postiz itself created — no existing `Post` record is
assumed or required.

## Scope decisions (confirmed during brainstorming)

- Input sources: both (a) manual paste-list/CSV-upload in a new UI tab, and
  (b) a public API endpoint for the external tool to submit programmatically.
- Every submission is tied to one Pinterest account, explicitly selected
  (dropdown of the org's connected Pinterest integrations) — never inferred.
- A submission batch is capped at 100 pins.
- On a per-pin failure (already gone, API error, auth issue): log it against
  that pin and keep processing the rest of the batch. No batch-wide abort.
- Only one active run (unfinished batch/backlog) per Pinterest account at a
  time. A new submission for an account that already has an active backlog
  appends to it rather than starting a second parallel run.
- Batch history is persisted and stays reviewable in the tab, not just the
  live run.
- **Daily safety cap**: no more than 100 pins may actually be deleted for a
  given Pinterest account within a rolling 24-hour window. This is a hard
  safeguard against triggering Pinterest anti-spam/ban detection, independent
  of and in addition to the existing per-call throttle described below. It
  is a fixed constant for v1 (not user-configurable).
- Deletion calls must share Pinterest's existing per-provider rate limiter
  with live publishing and analytics-sync traffic, not run on a separate
  budget that could starve or collide with them.

## Existing infrastructure this design builds on

- `PinterestProvider` (`libraries/nestjs-libraries/src/integrations/social/pinterest.provider.ts`)
  extends `SocialAbstract`, which has no pin-delete method today — the only
  existing "delete" (`PostsService.deletePost`) removes Postiz's own DB
  record and never calls Pinterest.
- All outbound Pinterest API calls funnel through `SocialAbstract.fetch()`,
  which already retries on 429/5xx with backoff and calls
  `concurrency()` (`libraries/helpers/src/utils/concurrency.service.ts`) — a
  Redis-backed Bottleneck limiter keyed by provider name (`"pinterest"`),
  `maxConcurrentJob = 3`, `minTime: 1000`ms. This bucket is **global across
  all Pinterest accounts and all call types** (post, analytics, and now
  delete). As long as the new delete call goes through this same `fetch()`,
  it automatically shares the budget with live traffic — no separate
  coordination logic is needed for that part.
- BullMQ jobs are dispatched via `BullMqClient` (`bull-mq-transport-new/client.ts`)
  and consumed via `@EventPattern` workers in `apps/workers` (`strategy.ts`,
  fixed `concurrency: 10` per queue, no BullMQ-level rate limiter — throttling
  is delegated entirely to the Bottleneck limiter above).
- `checkQueueHealth()` (`client.ts`) + `GET /monitor/queue/:name`
  (`apps/backend/src/api/routes/monitor.controller.ts`) is the existing
  precedent for exposing "is this queue stuck" — extend this pattern rather
  than inventing a new one.
- Frontend precedent for a polling status widget:
  `apps/frontend/src/components/layout/queue.health.component.tsx` (manual
  `setInterval` poll) and `publishing.paused.banner.tsx` (SWR poll + mutate).
  Tabs are registered in `apps/frontend/src/components/layout/top.menu.tsx`
  with a page under `apps/frontend/src/app/(app)/(site)/<tab>/page.tsx`.

## Data model

Two new Prisma models; two new fields on the existing `Integration` model.
No changes to `Post`.

```prisma
model PinterestDeleteBatch {
  id               String    @id @default(uuid())
  organizationId   String
  integrationId    String
  createdByUserId  String?
  source           String    // "MANUAL" | "API"
  submittedCount   Int
  createdAt        DateTime  @default(now())

  organization     Organization @relation(fields: [organizationId], references: [id])
  integration      Integration  @relation(fields: [integrationId], references: [id])
  items            PinterestDeleteItem[]
}

model PinterestDeleteItem {
  id             String    @id @default(uuid())
  batchId        String
  integrationId  String
  pinId          String    // normalized numeric Pinterest pin id
  rawInput       String    // original pasted value (id or URL), for display
  status         String    // "PENDING" | "QUEUED" | "REMOVED" | "FAILED" | "WAITING_FOR_QUOTA"
  scheduledFor   DateTime? // set when status = WAITING_FOR_QUOTA
  errorMessage   String?
  processedAt    DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  batch          PinterestDeleteBatch @relation(fields: [batchId], references: [id])
  integration    Integration          @relation(fields: [integrationId], references: [id])

  @@index([integrationId, status])
}
```

Additions to `Integration`:

```prisma
pinDeleteWindowCount Int       @default(0)
pinDeleteLastAt      DateTime?
```

These two fields are the entire state needed for the daily cap — no separate
quota table. `pinDeleteWindowCount` counts deletions in the current window;
`pinDeleteLastAt` is the timestamp of the most recent deletion, used both to
detect window expiry and as the anchor for the 24h cooldown.

## Ingestion

One shared service method creates a batch, regardless of source:

`PinterestDeleteService.createBatch(organizationId, integrationId, userId | null, source, rawPinInputs: string[])`

- Validates `integrationId` belongs to the org and is `providerIdentifier === "pinterest"`.
- Rejects if `rawPinInputs.length > 100`.
- Parses each entry as either a bare numeric pin ID or a Pinterest pin URL
  (`https://www.pinterest.com/pin/<id>/...`) via a small regex helper;
  entries that parse to nothing are rejected up front with a clear error
  (not silently dropped).
- Creates one `PinterestDeleteBatch` row and one `PinterestDeleteItem`
  (`status: PENDING`) per parsed pin.
- Enqueues one BullMQ job per item onto a new `pinterest-delete-pin` queue,
  each carrying `{ itemId }`.

Two entry points call this same method:

1. **UI**: new tab, described below.
2. **Public API**: new authenticated route (same auth pattern as the
   existing public API under `apps/backend/src/api/routes/public.controller.ts`
   / SDK), e.g. `POST /public/v1/pinterest/delete-batch` with
   `{ integrationId, pins: string[] }`.

## Daily cap + per-call throttling (the safety core)

Two independent layers, both must pass before a pin is actually deleted:

1. **Per-call throttle (already exists)** — the delete call is made through
   `SocialAbstract.fetch()`, which is already Bottleneck-limited per
   provider. No new code needed here beyond making `deletePin()` use `fetch()`
   like every other Pinterest call.

2. **Daily cap (new)** — enforced inside the `pinterest-delete-pin` job
   handler, immediately before calling `deletePin()`, inside a Prisma
   transaction against the `Integration` row:

   - Re-read `pinDeleteWindowCount` / `pinDeleteLastAt` for the integration.
   - If `pinDeleteLastAt` is null or `now >= pinDeleteLastAt + 24h`: the
     window has expired — reset `pinDeleteWindowCount = 0` and proceed.
   - Else if `pinDeleteWindowCount < 100`: proceed.
   - Else (cap hit and window not yet expired): do **not** call Pinterest.
     Mark the item `WAITING_FOR_QUOTA` with
     `scheduledFor = pinDeleteLastAt + 24h`, and stop (the job ends here;
     it does not retry itself).
   - On successful deletion: increment `pinDeleteWindowCount`, set
     `pinDeleteLastAt = now`, mark the item `REMOVED`.
   - On Pinterest returning "not found"/already-deleted: still counts as
     using a quota slot (it's still an API call against the account) and is
     marked `REMOVED` with a note, not `FAILED`.
   - On any other API failure: mark `FAILED` with `errorMessage`, does
     **not** consume a quota slot (no delete actually happened), item is not
     retried automatically beyond BullMQ's built-in per-job retry.

   Because this state lives on `Integration` rather than per-batch, it
   correctly spans multiple submissions for the same account: a 150-pin
   submission runs 100 now and leaves 50 `WAITING_FOR_QUOTA`; a second
   submission the next day for the same account sees the still-outstanding
   50 and its own new pins compete for quota in submission order.

3. **Recovering `WAITING_FOR_QUOTA` items** — a new cron task, following the
   existing sweep pattern in `apps/cron/src/tasks/`, runs every 5 minutes,
   finds `PinterestDeleteItem` rows with `status = WAITING_FOR_QUOTA` and
   `scheduledFor <= now`, sets them back to `PENDING`, and re-enqueues their
   BullMQ job.

   **Processing order is not guaranteed strict FIFO across batches.** A
   newly submitted batch's jobs run immediately and may acquire a quota slot
   that just opened up before an older `WAITING_FOR_QUOTA` item from an
   earlier batch is swept back in (bounded by the 5-minute cron interval).
   The daily cap exists to protect the account, not to guarantee fairness
   between submissions, so this is an accepted approximation for v1.

## Queue / worker mechanics

- New queue `pinterest-delete-pin`, registered the same way as the existing
  `post` queue (`@EventPattern('pinterest-delete-pin', Transport.REDIS)` in
  `apps/workers`).
- Job payload: `{ itemId: string }`. Handler loads the item + its
  integration, runs the daily-cap check above, calls
  `PinterestProvider.deletePin(integration, pinId)` when allowed, updates the
  item, and updates the parent batch's denormalized counters (see below).
- `PinterestProvider.deletePin(integration, pinId)`: new method calling
  `DELETE https://api.pinterest.com/v5/pins/{pinId}` through the existing
  `this.fetch(...)` helper (same auth header / refresh-token handling as
  every other method on this provider).
- Batch-level counters (`removedCount`, `failedCount`, `waitingCount`,
  `pendingCount`) are **not** stored as separate mutable columns on
  `PinterestDeleteBatch` (avoids write contention); they are computed on read
  by grouping `PinterestDeleteItem` by `batchId` + `status`. Batch volume is
  small (≤100 rows) so this is cheap.
- "Is this run still working or has it stopped": extend the existing
  `checkQueueHealth()`/`/monitor/queue/:name` pattern for the
  `pinterest-delete-pin` queue. Additionally, per-account "stalled" detection:
  if an integration has `PENDING`/`QUEUED` items but no item has transitioned
  status in the last 15 minutes (`updatedAt`) — matching the ~10-minute
  stuck-waiting threshold `checkQueueHealth()` already uses for the `post`
  queue — and it's not legitimately `WAITING_FOR_QUOTA`, flag it as stalled
  in the same cron sweep that recovers quota waits.

## Frontend

- New sidebar entry in `top.menu.tsx`, shown only when the org has at least
  one Pinterest integration (existing conditional-tab pattern).
- New page under `apps/frontend/src/app/(app)/(site)/pinterest-cleanup/page.tsx`.
- Layout:
  - Account picker (dropdown of connected Pinterest integrations).
  - Submission panel: textarea for paste (one pin ID/URL per line) + file
    upload for CSV, client-side pre-count against the 100 limit before
    submitting.
  - Live status panel for the selected account, polling every ~5-10s
    (pattern from `queue.health.component.tsx`): counts of
    removed/failed/waiting-for-quota/pending, and — when
    `WAITING_FOR_QUOTA` items exist — a plain "daily limit reached, resumes
    at [timestamp]" banner so this reads as a deliberate safeguard, not a
    broken feature. A distinct "stalled" indicator (separate from the quota
    banner) if the health check above trips.
  - History list below: past batches for the selected account
    (`createdAt`, `submittedCount`, computed removed/failed counts),
    expandable to see individual pin-level failures.

## Testing

- Unit tests for the daily-cap transaction logic: window not yet started,
  window active under cap, window active at cap (defers), window expired
  (resets and proceeds), concurrent job race on the same integration.
- Unit tests for pin ID/URL parsing (bare ID, full URL, trailing
  slash/query params, invalid input rejected).
- Unit test for the 100-pins-per-submission validation.
- Manual end-to-end pass against a real (test) Pinterest account through the
  new tab: submit a small batch, watch it drain, verify deleted pins are
  actually gone on Pinterest, verify history view after completion.
- Not testing (out of scope): the external flagging tool itself, and any
  in-Postiz UI for marking pins as flagged (explicitly not being built).

# Pinterest Timed Deletion Queues (Pin Cleanup rework + new Board Deletion) — Design Spec

Date: 2026-09-11
Status: Approved for planning

## Purpose

Replace Pin Cleanup's "quota per rolling 24h window" deletion model with a
strict **timer-based, one-item-at-a-time** model, and add a new **Board
Deletion** tab that deletes Pinterest boards on the same kind of timer. Both
exist to make deletions look human (randomized spacing) rather than bursty,
and both should read as a single ongoing, appendable queue per Pinterest
account rather than a list of discrete batches.

This spec builds directly on the existing Pinterest Bulk Pin Deletion feature
(`docs/superpowers/specs/2026-09-06-pinterest-bulk-delete-design.md`) and
Pinterest Board Creation (`libraries/nestjs-libraries/src/database/prisma/pinterest-boards/`).
It replaces that feature's daily-cap/quota mechanism entirely; it does not
touch Board Creation's synchronous (non-queued) flow.

## Scope decisions (confirmed during brainstorming)

- **Pin Cleanup**: exactly 1 pin deleted every random(50–60) minutes per
  Pinterest account, re-rolled per pin. No daily cap concept. Submitting more
  pins appends to that account's ongoing queue and continues the same timing
  chain — it does not restart or run in parallel with what's already queued.
- **Board Deletion (new tab)**: exactly 1 board deleted every random(300–320)
  minutes per Pinterest account, re-rolled per board, same append-to-chain
  behavior. Submissions are capped at 25 boards per submission (soft UI cap,
  enforced server-side too); multiple submissions accumulate in the queue.
- **Reporting**:
  - Pin Cleanup: no per-pin success reporting (matches today's "doesn't need
    to report which pin was deleted"). A running aggregate summary (queued /
    done / failed / total-ever-submitted, next-run time, last-completion
    ETA) plus a list of **failed pins only**, each with its error reason.
  - Board Deletion: same aggregate summary, but — because the user explicitly
    wants to know which boards are done vs. still pending — a full per-board
    table showing status (`Pending` / `Deleted` / `Failed`), with the error
    reason shown for failed rows.
  - Neither feature gets a retry button. A failed item is terminal; if the
    user wants it deleted, they resubmit it as a new queue entry.
- **Board Deletion must support archived boards.** Pinterest's `GET /v5/boards`
  excludes archived boards unless `include_archived=true` is passed. The
  board picker for this tab passes that flag; the existing post-composer
  board dropdown (`PinterestBoard.tsx`, used when composing a pin) is
  untouched and keeps today's behavior (archived boards not offered there).
- **History retention**: completed (`REMOVED`) and failed (`FAILED`) items
  older than 7 days are purged by a daily cron, for both queues. Pending
  items are never purged. This replaces the old "keep 10 most recent
  batches" retention rule for Pin Cleanup (which existed to bound a
  batch-history UI that no longer exists in this design).
- Theme/layout must stay visually identical to the existing Pin Cleanup and
  Board Creation tabs (same sidebar, same form components, same color
  tokens) — no new visual language introduced.

## Data model changes

### `Integration` — replace quota fields with chain pointers

Remove (dead once the quota model is gone):

```prisma
pinDeleteWindowCount  Int       @default(0)
pinDeleteLastAt       DateTime?
```

Add:

```prisma
pinDeleteNextSlot   DateTime?
boardDeleteNextSlot DateTime?
```

Each field holds "the timestamp already promised to the most recently
queued item for this account's queue." A `null` value means the queue is
currently empty/caught up (next item schedules off `now`).

### `PinterestDeleteItem` — simplified status set

`status` values collapse from `"PENDING" | "QUEUED" | "REMOVED" | "FAILED" |
"WAITING_FOR_QUOTA"` to just `"PENDING" | "REMOVED" | "FAILED"`. `scheduledFor`
is now set on every item at creation time (the precomputed chain slot), not
only while quota-blocked. No column shape change beyond what's already
there (`status` and `scheduledFor` already exist as `String` / `DateTime?`)
— this is a behavioral change in what values get written, not a schema
migration for this model.

### New models: Board Deletion (mirrors `PinterestDeleteBatch`/`Item`)

```prisma
model PinterestBoardDeleteBatch {
  id              String    @id @default(uuid())
  organizationId  String
  integrationId   String
  createdByUserId String?
  source          String    // "MANUAL" (UI only for v1; no MCP/public API tool for board deletion)
  submittedCount  Int
  createdAt       DateTime  @default(now())

  organization Organization                @relation(fields: [organizationId], references: [id])
  integration  Integration                 @relation(fields: [integrationId], references: [id])
  items        PinterestBoardDeleteItem[]

  @@index([integrationId, createdAt])
}

model PinterestBoardDeleteItem {
  id            String    @id @default(uuid())
  batchId       String
  integrationId String
  boardId       String
  boardName     String    // captured at queue time — unavailable after deletion
  status        String    // "PENDING" | "REMOVED" | "FAILED"
  scheduledFor  DateTime?
  errorMessage  String?
  processedAt   DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  batch       PinterestBoardDeleteBatch @relation(fields: [batchId], references: [id], onDelete: Cascade)
  integration Integration               @relation(fields: [integrationId], references: [id])

  @@index([integrationId, status])
}
```

Add the inverse relations (`pinterestBoardDeleteBatches`,
`pinterestBoardDeleteItems`) to `Integration`, matching the existing
`pinDeleteBatches`/`pinDeleteItems` pattern.

## Scheduling algorithm (shared logic, parameterized by min/max minutes)

A single helper, e.g. `computeChainedSlots(startingPointer: Date | null, count: number, minMinutes: number, maxMinutes: number): Date[]`,
used by both queues:

```
cursor = max(now, startingPointer ?? now)
for i in 1..count:
  cursor = cursor + randomInt(minMinutes, maxMinutes) minutes
  slots[i] = cursor
return slots  // slots[count] becomes the new pointer value
```

`randomInt` is inclusive on both ends (50..60 or 300..320), freshly rolled
per item — this is the "human-like jitter."

**Concurrency safety**: computing slots and creating items must happen
atomically with respect to the integration's pointer field, so two
submissions for the same account never compute off the same stale pointer.
Implemented with a Prisma interactive transaction
(`this._prisma.$transaction(async (tx) => { ... })`):

1. Read `integration.pinDeleteNextSlot` (or `boardDeleteNextSlot`) inside the
   transaction.
2. Compute the new slots with the helper above.
3. Create the batch + items (status `PENDING`, `scheduledFor` = each
   computed slot) inside the same transaction.
4. Update the integration's pointer field to `slots[count]` inside the same
   transaction.

This is a low-traffic, effectively single-writer-per-account path (a human
submitting a form), so an interactive transaction is simpler and sufficient
— no need for the old lock-free double-conditional-`updateMany` trick that
`reserveQuotaSlot` used under BullMQ worker concurrency.

After the transaction commits, emit one BullMQ delayed job per created item:

```ts
this._workerServiceProducer.emit('pinterest-delete-pin', {
  id: item.id,
  options: { delay: item.scheduledFor.getTime() - Date.now() },
  payload: { itemId: item.id },
});
```

(`'pinterest-delete-board'` / `boardItemId` for the board queue.) This
mirrors the existing recurring-post delay pattern in `PostsService`
(`this._workerServiceProducer.emit('post', { id, options: { delay }, ... })`).

No quota check, no `reserveQuotaSlot`/`releaseQuotaSlot`, no 5-minute
recovery cron for "due" items — BullMQ's own delay mechanism replaces all of
that.

## Backend changes — Pin Cleanup (rework existing)

- `libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete.repository.ts`:
  remove `reserveQuotaSlot`/`releaseQuotaSlot`/`DAILY_CAP`/`WINDOW_MS`;
  remove `findDueWaitingItems`; add `getQueueSummary(integrationId)` (see API
  contract below) and the transactional `createBatchWithItems` described
  above (now also updates the integration pointer in the same transaction).
  Remove `pickBatchIdsToPurge`/batch-retention purge call from
  `createBatch` — replaced by the new daily cron (below).
- `pinterest-delete.service.ts`: `createBatch` keeps its existing signature
  and validation (integration lookup, pin parsing, `MAX_PINS_PER_BATCH`
  cap — unchanged at 200, still a per-submission cap, not a total-queue
  cap). `processItem` drops the quota reservation branch entirely — on job
  fire, just attempt the deletion, mark `REMOVED` or `FAILED`
  (`errorMessage` set on failure), no retry, no requeue.
  `findStalledItemIntegrationIds` stays as an ops signal (item `PENDING` with
  `scheduledFor` more than ~15 minutes in the past — indicates a stuck
  worker, not normal timer waiting).
- `apps/workers/src/app/pinterest-delete.controller.ts`: unchanged shape
  (still one `@EventPattern('pinterest-delete-pin', ...)` handler calling
  `processItem`).
- `apps/cron/src/tasks/recover.pinterest.delete.quota.ts`: remove the
  `recoverDueQuotaWaits` call (nothing left to recover); keep the stalled-
  integration warning sweep, or fold it into the new purge cron (below) to
  avoid an extra cron file — implementer's choice, not architecturally
  significant.
- `apps/backend/src/api/routes/pinterest-delete.controller.ts`: existing
  `POST /pinterest-delete/batches` unchanged. Replace
  `GET /pinterest-delete/batches` (batch-summary list) with
  `GET /pinterest-delete/queue?integrationId=` returning the aggregate shape
  below.
- MCP tool (`pinterest.bulk.delete.pins.tool.ts`): update the `description`
  text to drop the "100 per rolling 24h" language and describe the new
  timer model ("deletes one pin every 50–60 minutes per account; submitting
  more pins appends to that account's ongoing queue"). No input/output
  schema change needed beyond that (still returns `{ batchId,
  submittedCount }`).

## Backend changes — Board Deletion (new)

New files mirroring the pin-delete structure:

- `libraries/nestjs-libraries/src/database/prisma/pinterest-board-delete/pinterest-board-delete.repository.ts`
  — `createBatchWithItems` (same transactional pointer-chaining pattern,
  parameterized 300–320 min), `getItemById`, `markItemRemoved`,
  `markItemFailed`, `getQueueSummary(integrationId)`, plus the shared
  `computeChainedSlots` helper (put it somewhere shared, e.g.
  `pinterest-delete.logic.ts` generalized, or a new
  `pinterest-delete-scheduling.logic.ts` used by both repositories).
- `pinterest-board-delete.service.ts` — `createBatch(organizationId,
  integrationId, createdByUserId, boards: { boardId: string; boardName:
  string }[])`: validates integration (Pinterest, not deleted), caps at 25
  boards per submission, rejects boards already `PENDING` in that
  integration's queue (dedupe check against existing pending items before
  creating), creates batch + items, emits BullMQ jobs. `processItem(itemId)`
  calls the new provider method, marks `REMOVED`/`FAILED`.
- `apps/workers/src/app/pinterest-board-delete.controller.ts` — new
  `@EventPattern('pinterest-delete-board', Transport.REDIS)` handler,
  same shape as the pin one.
- `apps/backend/src/api/routes/pinterest-board-delete.controller.ts` — new:
  - `POST /pinterest-board-delete/batches` — `{ integrationId, boards: {
    boardId, boardName }[] }` → creates batch.
  - `GET /pinterest-board-delete/queue?integrationId=` — aggregate + full
    item list (see API contract below).
- `libraries/nestjs-libraries/src/dtos/pinterest-board-delete/pinterest.board.delete.batch.dto.ts`
  — `integrationId: string`, `boards: { boardId: string; boardName: string
  }[]` (`@ArrayMaxSize(25)`).
- Register the new repository/service/controller in
  `database.module.ts` / `api.module.ts` / the workers module, following
  exactly how `PinterestDeleteRepository`/`Service` are registered today.

## Provider changes (`pinterest.provider.ts`)

- New method:

  ```ts
  async deleteBoard(id: string, accessToken: string, boardId: string): Promise<{ success: boolean }> {
    const response = await this.fetch(
      `https://api.pinterest.com/v5/boards/${boardId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } }
    );
    return { success: response.status === 204 || response.status === 200 };
  }
  ```

  (Mirrors `deletePin` exactly — same status-code check, same shared
  rate-limited `this.fetch()`.)

- `boards()` gains an optional second parameter so it can request archived
  boards **only when explicitly asked**, without changing behavior for
  existing callers:

  ```ts
  async boards(accessToken: string, data?: { includeArchived?: boolean }) { ... }
  ```

  Append `&include_archived=true` to the request URL when
  `data?.includeArchived` is true. This is safe because `/integrations/function`
  (`IntegrationFunctionDto`) already forwards a `data` payload as the
  method's second positional argument — the existing post-composer caller
  (`PinterestBoard.tsx`, `customFunc.get('boards')`) passes no second
  argument today and is unaffected.
- Add `deleteBoard` to the `SocialProvider` interface in
  `social.integrations.interface.ts` as optional (`deleteBoard?(...)`),
  matching how `createBoard?`/`deletePin?` are already declared.

## Cron changes

- Remove the "recover due quota waits" responsibility (nothing to recover
  under the delay-based model).
- New daily cron, e.g. `apps/cron/src/tasks/purge.pinterest.delete.history.ts`:
  `@Cron('0 3 * * *')` — deletes `PinterestDeleteItem` and
  `PinterestBoardDeleteItem` rows where `status IN ('REMOVED','FAILED')` and
  `processedAt < now - 7 days`. Running daily against a 7-day cutoff gives a
  rolling 7-day retention window rather than a literal once-a-week sweep,
  which is the more correct reading of "history older than a week should be
  gone" (nothing sits stale for more than a day past the cutoff). Batches
  left with zero remaining items after this purge are also deleted (cascade
  cleanup), since an empty batch has no display value.
- Keep (or fold into the same cron) the stalled-item warning sweep
  (`findStalledItemIntegrationIds`-equivalent for both queues) — same
  Sentry `captureMessage` pattern as today, just no longer paired with
  quota recovery.

## API contracts

**`GET /pinterest-delete/queue?integrationId=`** and
**`GET /pinterest-board-delete/queue?integrationId=`** share this shape:

```ts
{
  queued: number;        // status PENDING
  done: number;           // status REMOVED
  failed: FailedItem[];   // status FAILED, with reason — full items for board deletion (see below)
  totalEverSubmitted: number; // all rows ever created for this integration (pre-purge; purge only removes REMOVED/FAILED older than 7d, so this undercounts only after that window)
  nextRunAt: string | null;      // earliest PENDING.scheduledFor
  lastCompletionAt: string | null; // latest PENDING.scheduledFor (queue-drain ETA)
}
```

Board deletion's response additionally includes the full item list (not
just failures), since the tab needs to show every board's current status:

```ts
{
  ...same fields as above,
  items: {
    id: string;
    boardId: string;
    boardName: string;
    status: 'PENDING' | 'REMOVED' | 'FAILED';
    scheduledFor: string | null;
    errorMessage: string | null;
  }[];
}
```

`FailedItem` (pin cleanup): `{ id: string; pinId: string; rawInput: string; errorMessage: string; processedAt: string }`.

## Frontend

### Pin Cleanup (`pinterest.cleanup.component.tsx`) — rework

- Same sidebar, same textarea input, same `maxPins`-per-submission control
  (unchanged constants: `ABSOLUTE_MAX_PINS = 200`).
- Replace the batch-history list with:
  - A summary strip: `Queued: N · Done: N · Failed: N · Total submitted: N`.
  - `Next deletion at: <time> · Last one completes: <time>` (from
    `nextRunAt`/`lastCompletionAt`; render "—" when the queue is empty).
  - A "Failed pins" list below (pin id/raw input + error reason), shown only
    when `failed.length > 0`.
- Drop the "daily limit reached, resumes at…" banner entirely (no daily cap
  anymore) and the `DAILY_RATE_LIMIT` messaging block.
- Keep the same SWR polling pattern, pointed at the new
  `/pinterest-delete/queue` endpoint.

### Board Deletion (new tab)

New file `apps/frontend/src/components/pinterest-board-delete/pinterest.board.delete.component.tsx`,
structurally identical to `pinterest.board.creation.component.tsx` for the
sidebar/channel-picker half. Main panel:

- On integration select, fetch boards via
  `useCustomProviderFunction().get('boards', { includeArchived: true })`.
- Render as a checkbox list (search/filter input above it for accounts with
  many boards), each row showing board name + an "Archived" tag when
  applicable (Pinterest's board object exposes this — confirm field name
  when implementing; if unavailable, omit the tag, it's cosmetic only).
  Boards already `PENDING` in this integration's delete queue are shown
  disabled with an "Already queued" label.
- "Queue for deletion (N selected)" button, capped at 25 selections,
  calling `POST /pinterest-board-delete/batches`.
- Below: identical summary strip + next/last-completion times as Pin
  Cleanup, then a table (same visual style as the Board Creation table):
  Board name | Status | Scheduled / completed time | Error (if failed).
  Polled via SWR against `GET /pinterest-board-delete/queue`.
- New page: `apps/frontend/src/app/(app)/(site)/pinterest-board-delete/page.tsx`,
  mirroring `pinterest-boards/page.tsx`.
- New `top.menu.tsx` entry: `name: t('pinterest_board_deletion', 'Board
  Deletion')`, `path: '/pinterest-board-delete'`, positioned after "Board
  Creation," same conditional-visibility rule (shown when the org has a
  Pinterest integration) and icon style as the other two Pinterest tabs.

## Migration / rollout notes

- Schema change is applied via `pnpm run prisma-db-push` (no migration
  history in this repo) — dropping `pinDeleteWindowCount`/`pinDeleteLastAt`
  loses those transient counters, which is fine (they're not meaningful
  historical data).
- Any `PinterestDeleteItem` currently sitting in `WAITING_FOR_QUOTA` at
  deploy time is a status value this design no longer recognizes. Since
  this is a low-volume, effectively single-operator feature (not
  multi-tenant SaaS traffic), the simplest correct handling is a one-off
  cleanup as part of the implementation PR: any item not already
  `REMOVED`/`FAILED` gets folded into a fresh chain computation (treated as
  if newly submitted, in original `createdAt` order) rather than writing
  special migration code that will never run again after this deploy.

## Testing

- Unit tests for `computeChainedSlots`: empty starting pointer, existing
  future pointer (chains off it, not off `now`), existing past pointer
  (chains off `now`), multiple items produce strictly increasing timestamps
  each within `[min, max]` minutes of the previous one.
- Unit test: two concurrent `createBatch` calls for the same integration
  never produce overlapping/duplicate slots (transaction isolation).
- Unit test: submitting a board already `PENDING` in the queue is rejected
  (or skipped) rather than double-queued.
- Unit test: `processItem` for both queues — success path marks
  `REMOVED`/`processedAt` set; failure path marks `FAILED` with
  `errorMessage`, no retry/requeue triggered.
- Unit test: purge cron deletes `REMOVED`/`FAILED` rows older than 7 days
  and leaves `PENDING` rows and rows within the window untouched; deletes
  now-empty batches.
- Unit test: `boards()` appends `include_archived=true` only when
  `includeArchived: true` is passed, and existing no-arg calls are
  byte-identical to today's request.
- Manual end-to-end pass against a real (test) Pinterest account: queue a
  few pins and a few boards (including one archived board), confirm the
  summary counts and ETA look right, wait for at least one real deletion of
  each type to fire and confirm it actually happened on Pinterest, confirm
  a forced-failure case (e.g. an already-deleted board id) shows up in the
  failed list with a reason.

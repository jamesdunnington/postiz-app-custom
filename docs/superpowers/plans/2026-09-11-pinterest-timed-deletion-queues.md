# Pinterest Timed Deletion Queues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework Pinterest Pin Cleanup from a daily-quota deletion model to a randomized 50–60-minute single-pin timer, and add a new Board Deletion tab on a randomized 300–320-minute single-board timer — both as ongoing, appendable per-account queues with a live summary (queued/done/failed/total + completion ETA).

**Architecture:** A shared pure-function scheduler (`computeChainedSlots`) chains each new item's run time off a per-integration pointer field, so submissions append to one continuous timeline instead of resetting it. Each item is precomputed with an exact `scheduledFor` timestamp at submit time and handed to BullMQ as a delayed job (no polling, no quota table). Board Deletion mirrors Pin Cleanup's existing batch/item/repository/service/controller/worker structure end-to-end, parameterized with its own timing constants and its own Prisma models.

**Tech Stack:** NestJS (backend/workers/cron), Prisma/PostgreSQL, BullMQ (`BullMqClient`), Next.js/React frontend, Jest.

**Spec:** [docs/superpowers/specs/2026-09-11-pinterest-timed-deletion-queues-design.md](../specs/2026-09-11-pinterest-timed-deletion-queues-design.md)

## Global Constraints

- Pin Cleanup: 1 pin every random(50–60) minutes per account, re-rolled per pin. No daily cap. `MAX_PINS_PER_BATCH = 200` per submission (unchanged).
- Board Deletion: 1 board every random(300–320) minutes per account, re-rolled per board. `MAX_BOARDS_PER_BATCH = 25` per submission.
- No retry, anywhere. A failed item is terminal.
- Pin Cleanup UI: aggregate counts only, plus a **failed-pins-only** list with error reasons. No per-pin success reporting.
- Board Deletion UI: aggregate counts **plus** a full per-board table (`Pending`/`Deleted`/`Failed`), since the user explicitly wants to see which boards are done vs. pending.
- Board Deletion must be able to target archived Pinterest boards (`GET /v5/boards?include_archived=true`); the existing post-composer board picker (`PinterestBoard.tsx`) must keep behaving exactly as it does today (no archived boards offered there).
- History retention: a daily cron purges `REMOVED`/`FAILED` items older than 7 days, for both queues. `PENDING` items are never purged.
- Visual theme must match the existing Pin Cleanup / Board Creation tabs exactly — same sidebar markup, same form components (`Button`, `Input`, `Textarea`, `Slider`), same Tailwind tokens (`bg-newBgColorInner`, `text-customColor18`, `border-newTableBorder`, `bg-sixth`, `text-red-400`/`text-red-500`, etc.).
- **This repository's local sandbox has no `node_modules` and cannot run `pnpm` commands** (per `CLAUDE.md`: "never attempt `pnpm build`, `tsc --noEmit`, `nest build`, or any compile/type-check command locally... The local machine has no `node_modules`"). Every task below still specifies the exact `pnpm`/`jest` command an engineer would run in a properly set-up environment (or CI) — but in **this** environment, do not attempt to execute them; write the code and tests carefully instead, then push and let GitHub Actions CI run them. Do not fabricate or assume a pass/fail result you did not actually observe.
- `pnpm run prisma-db-push` (applying the schema change to a real database) is a manual step for the user to run themselves when ready to deploy — it is called out explicitly in Task 2 and must not be run automatically by the plan executor.
- Never use `git push`, `gh pr create`, or any command that publishes work, unless the user explicitly asks — this plan's tasks end at "commit," not "push."

---

## Task 1: Shared chained-slot scheduling helper

**Files:**
- Create: `libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete-scheduling.logic.ts`
- Test: `libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete-scheduling.logic.spec.ts`

**Interfaces:**
- Produces: `computeChainedSlots(startingPointer: Date | null, count: number, minMinutes: number, maxMinutes: number, now?: Date, randomFn?: () => number): Date[]` — used by both `pinterest-delete.repository.ts` (Task 3) and `pinterest-board-delete.repository.ts` (Task 10).

- [ ] **Step 1: Write the failing test**

```ts
// libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete-scheduling.logic.spec.ts
import { computeChainedSlots } from './pinterest-delete-scheduling.logic';

describe('computeChainedSlots', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it('chains off `now` when there is no starting pointer', () => {
    const slots = computeChainedSlots(null, 1, 50, 60, now, () => 0);
    expect(slots[0].toISOString()).toBe('2026-01-01T00:50:00.000Z');
  });

  it('chains off `now` when the starting pointer is in the past', () => {
    const pastPointer = new Date('2025-12-31T00:00:00.000Z');
    const slots = computeChainedSlots(pastPointer, 1, 50, 60, now, () => 0);
    expect(slots[0].toISOString()).toBe('2026-01-01T00:50:00.000Z');
  });

  it('chains off the starting pointer when it is in the future', () => {
    const futurePointer = new Date('2026-01-01T02:00:00.000Z');
    const slots = computeChainedSlots(futurePointer, 1, 50, 60, now, () => 0);
    expect(slots[0].toISOString()).toBe('2026-01-01T02:50:00.000Z');
  });

  it('uses the minimum minutes when randomFn returns 0', () => {
    const slots = computeChainedSlots(null, 1, 50, 60, now, () => 0);
    expect(slots[0].getTime() - now.getTime()).toBe(50 * 60_000);
  });

  it('uses the maximum minutes when randomFn returns just under 1', () => {
    const slots = computeChainedSlots(null, 1, 50, 60, now, () => 0.999999);
    expect(slots[0].getTime() - now.getTime()).toBe(60 * 60_000);
  });

  it('produces strictly increasing timestamps, each within [min,max] minutes of the previous one', () => {
    const values = [0, 0.5, 0.99];
    let callIndex = 0;
    const slots = computeChainedSlots(null, 3, 50, 60, now, () => values[callIndex++]);

    expect(slots).toHaveLength(3);
    let previous = now.getTime();
    for (const slot of slots) {
      const diffMinutes = (slot.getTime() - previous) / 60_000;
      expect(diffMinutes).toBeGreaterThanOrEqual(50);
      expect(diffMinutes).toBeLessThanOrEqual(60);
      previous = slot.getTime();
    }
  });

  it('defaults to Math.random and Date.now when not supplied (smoke test only)', () => {
    const slots = computeChainedSlots(null, 1, 50, 60);
    expect(slots).toHaveLength(1);
    expect(slots[0].getTime()).toBeGreaterThan(Date.now());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ./libraries/nestjs-libraries run test -- --testPathPattern="pinterest-delete-scheduling.logic.spec"`
Expected: FAIL with "Cannot find module './pinterest-delete-scheduling.logic'"
(Per Global Constraints, this command cannot actually be executed in this sandbox — verify by inspection that the implementation file does not yet exist, then proceed.)

- [ ] **Step 3: Write the implementation**

```ts
// libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete-scheduling.logic.ts

// Chains `count` new deletion slots off `startingPointer` (the last slot
// already promised to this integration's queue), each one random(minMinutes,
// maxMinutes) after the previous — inclusive on both ends, freshly rolled
// per item, so consecutive real-world gaps look human rather than uniform.
// If the pointer is null or already in the past, the chain starts from `now`
// instead, so a caught-up queue doesn't inherit a stale future/past anchor.
export function computeChainedSlots(
  startingPointer: Date | null,
  count: number,
  minMinutes: number,
  maxMinutes: number,
  now: Date = new Date(),
  randomFn: () => number = Math.random
): Date[] {
  let cursor =
    startingPointer && startingPointer.getTime() > now.getTime()
      ? startingPointer.getTime()
      : now.getTime();

  const spanMinutes = maxMinutes - minMinutes + 1;
  const slots: Date[] = [];
  for (let i = 0; i < count; i++) {
    const minutes = minMinutes + Math.floor(randomFn() * spanMinutes);
    cursor += minutes * 60_000;
    slots.push(new Date(cursor));
  }
  return slots;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ./libraries/nestjs-libraries run test -- --testPathPattern="pinterest-delete-scheduling.logic.spec"`
Expected: PASS (all 7 tests). Per Global Constraints, verify this via CI after pushing, not locally in this sandbox.

- [ ] **Step 5: Commit**

```bash
git add libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete-scheduling.logic.ts libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete-scheduling.logic.spec.ts
git commit -m "feat: add chained-slot scheduling helper for Pinterest deletion queues"
```

---

## Task 2: Prisma schema changes

**Files:**
- Modify: `libraries/nestjs-libraries/src/database/prisma/schema.prisma`

**Interfaces:**
- Produces: `Integration.pinDeleteNextSlot: DateTime?`, `Integration.boardDeleteNextSlot: DateTime?`, new models `PinterestBoardDeleteBatch`/`PinterestBoardDeleteItem`, and the simplified meaning of `PinterestDeleteItem.status` (now only `"PENDING" | "REMOVED" | "FAILED"` — no code/schema enforcement change, just updated comment and consumers in later tasks).

- [ ] **Step 1: Remove the old quota fields and add the chain-pointer fields on `Integration`**

Find this block (around line 339):

```prisma
  pinDeleteWindowCount  Int                    @default(0)
  pinDeleteLastAt       DateTime?
  pinDeleteBatches      PinterestDeleteBatch[]
  pinDeleteItems        PinterestDeleteItem[]
```

Replace with:

```prisma
  pinDeleteNextSlot        DateTime?
  boardDeleteNextSlot      DateTime?
  pinDeleteBatches         PinterestDeleteBatch[]
  pinDeleteItems           PinterestDeleteItem[]
  boardDeleteBatches       PinterestBoardDeleteBatch[]
  boardDeleteItems         PinterestBoardDeleteItem[]
```

- [ ] **Step 2: Add the inverse relation on `Organization`**

Find this line (around line 45):

```prisma
  pinDeleteBatches  PinterestDeleteBatch[]
```

Replace with:

```prisma
  pinDeleteBatches      PinterestDeleteBatch[]
  boardDeleteBatches    PinterestBoardDeleteBatch[]
```

- [ ] **Step 3: Update the `PinterestDeleteItem.status` comment to reflect the simplified status set**

Find (around line 765):

```prisma
  status        String // "PENDING" | "QUEUED" | "REMOVED" | "FAILED" | "WAITING_FOR_QUOTA"
```

Replace with:

```prisma
  status        String // "PENDING" | "REMOVED" | "FAILED"
```

- [ ] **Step 4: Add the two new Board Deletion models**

Add immediately after the `PinterestDeleteItem` model closing brace (around line 777):

```prisma
model PinterestBoardDeleteBatch {
  id              String    @id @default(uuid())
  organizationId  String
  integrationId   String
  createdByUserId String?
  source          String // "MANUAL"
  submittedCount  Int
  createdAt       DateTime  @default(now())

  organization Organization               @relation(fields: [organizationId], references: [id])
  integration  Integration                @relation(fields: [integrationId], references: [id])
  items        PinterestBoardDeleteItem[]

  @@index([integrationId, createdAt])
}

model PinterestBoardDeleteItem {
  id            String    @id @default(uuid())
  batchId       String
  integrationId String
  boardId       String
  boardName     String // captured at queue time — unavailable after deletion
  status        String // "PENDING" | "REMOVED" | "FAILED"
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

- [ ] **Step 5: Regenerate the Prisma client**

Run: `pnpm run prisma-generate`
This cannot be executed in this sandbox (no `node_modules`). Note it here for the engineer/CI running in a properly set-up environment — subsequent tasks' TypeScript assumes the regenerated client (e.g. `tx.pinterestBoardDeleteBatch`, `Integration.pinDeleteNextSlot`).

- [ ] **Step 6: Commit**

```bash
git add libraries/nestjs-libraries/src/database/prisma/schema.prisma
git commit -m "feat: replace pin-delete quota fields with chain pointers, add board-delete models"
```

> **Deferred, manual step — do not run automatically:** applying this to a real database (`pnpm run prisma-db-push`) drops `pinDeleteWindowCount`/`pinDeleteLastAt` and creates the two new tables. This is a real schema change against a shared database — the user runs this themselves when ready to deploy, per the "Executing actions with care" rule on hard-to-reverse, shared-system actions.

---

## Task 3: Rework `PinterestDeleteRepository` — chained scheduling, queue summary, purge

**Files:**
- Modify: `libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete.repository.ts`
- Modify: `libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete.logic.ts`
- Modify: `libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete.logic.spec.ts`

**Interfaces:**
- Consumes: `computeChainedSlots` from Task 1; `PrismaRepository`/`PrismaTransaction` from `@gitroom/nestjs-libraries/database/prisma/prisma.service`.
- Produces: `PinterestDeleteRepository.createBatchWithItems(organizationId, integrationId, createdByUserId, source, parsedPins)` (now transactional, sets `scheduledFor` on every item, no longer purges old batches), `getQueueSummary(integrationId): Promise<QueueSummary>`, `findOverdueItems(staleBefore: Date)`, `purgeCompletedItemsOlderThan(cutoff: Date): Promise<number>`. Removes `reserveQuotaSlot`, `releaseQuotaSlot`, `findDueWaitingItems`, `listBatchIdsForIntegrationNewestFirst`, `deleteBatchesByIds`, `listBatchSummariesForIntegration`, `markItemWaitingForQuota`, `markItemPending`.
- `QueueSummary` shape: `{ queued: number; done: number; failed: { id: string; pinId: string; rawInput: string; errorMessage: string | null; processedAt: Date | null }[]; totalEverSubmitted: number; nextRunAt: Date | null; lastCompletionAt: Date | null }`.

- [ ] **Step 1: Write the failing test for `pickBatchIdsToPurge` removal and keep `parsePinInput` coverage**

`pickBatchIdsToPurge` is no longer used (retention is now time-based, via the new purge cron in Task 6, not a "keep N batches" rule). Update the spec file to drop its tests and keep only `parsePinInput`:

```ts
// libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete.logic.spec.ts
import { parsePinInput } from './pinterest-delete.logic';

describe('parsePinInput', () => {
  it('accepts a bare numeric pin id', () => {
    expect(parsePinInput('123456789012345678')).toBe('123456789012345678');
  });

  it('extracts the id from a full pin URL', () => {
    expect(
      parsePinInput('https://www.pinterest.com/pin/123456789012345678/')
    ).toBe('123456789012345678');
  });

  it('extracts the id from a pin URL with query params and no trailing slash', () => {
    expect(
      parsePinInput(
        'https://www.pinterest.com/pin/123456789012345678?utm=abc'
      )
    ).toBe('123456789012345678');
  });

  it('returns null for an unrecognized string', () => {
    expect(parsePinInput('not-a-pin')).toBeNull();
  });

  it('returns null for an empty or whitespace-only string', () => {
    expect(parsePinInput('   ')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it still passes (no behavior change to `parsePinInput`)**

Run: `pnpm --filter ./libraries/nestjs-libraries run test -- --testPathPattern="pinterest-delete.logic.spec"`
Expected: PASS (5 tests). Verify via CI per Global Constraints.

- [ ] **Step 3: Remove `pickBatchIdsToPurge` from the logic file**

In `pinterest-delete.logic.ts`, delete this function (keep `parsePinInput` untouched):

```ts
// Given an integration's batch ids ordered newest-first, returns the ids
// beyond the retention limit that should be purged.
export function pickBatchIdsToPurge(
  batchIdsNewestFirst: string[],
  keep = 2
): string[] {
  return batchIdsNewestFirst.slice(keep);
}
```

- [ ] **Step 4: Rewrite the repository**

Replace the full contents of `pinterest-delete.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { computeChainedSlots } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete-scheduling.logic';

const PIN_DELETE_MIN_MINUTES = 50;
const PIN_DELETE_MAX_MINUTES = 60;

export interface PinterestDeleteQueueSummary {
  queued: number;
  done: number;
  failed: {
    id: string;
    pinId: string;
    rawInput: string;
    errorMessage: string | null;
    processedAt: Date | null;
  }[];
  totalEverSubmitted: number;
  nextRunAt: Date | null;
  lastCompletionAt: Date | null;
}

@Injectable()
export class PinterestDeleteRepository {
  constructor(
    private _batch: PrismaRepository<'pinterestDeleteBatch'>,
    private _item: PrismaRepository<'pinterestDeleteItem'>,
    private _transaction: PrismaTransaction
  ) {}

  // Computes each new item's slot by chaining off the integration's
  // pinDeleteNextSlot pointer, then creates the batch + items and advances
  // the pointer, all inside one transaction — so two submissions for the
  // same account never compute off the same stale pointer.
  createBatchWithItems(
    organizationId: string,
    integrationId: string,
    createdByUserId: string | null,
    source: 'MANUAL' | 'API' | 'MCP',
    parsedPins: { pinId: string; rawInput: string }[]
  ) {
    return this._transaction.model.$transaction(async (tx) => {
      const integration = await tx.integration.findUniqueOrThrow({
        where: { id: integrationId },
        select: { pinDeleteNextSlot: true },
      });

      const slots = computeChainedSlots(
        integration.pinDeleteNextSlot,
        parsedPins.length,
        PIN_DELETE_MIN_MINUTES,
        PIN_DELETE_MAX_MINUTES
      );

      const batch = await tx.pinterestDeleteBatch.create({
        data: {
          organizationId,
          integrationId,
          createdByUserId,
          source,
          submittedCount: parsedPins.length,
          items: {
            create: parsedPins.map(({ pinId, rawInput }, i) => ({
              integrationId,
              pinId,
              rawInput,
              status: 'PENDING',
              scheduledFor: slots[i],
            })),
          },
        },
        include: { items: true },
      });

      await tx.integration.update({
        where: { id: integrationId },
        data: { pinDeleteNextSlot: slots[slots.length - 1] },
      });

      return batch;
    });
  }

  getItemById(itemId: string) {
    return this._item.model.pinterestDeleteItem.findUnique({
      where: { id: itemId },
      include: { integration: true },
    });
  }

  markItemRemoved(itemId: string) {
    return this._item.model.pinterestDeleteItem.update({
      where: { id: itemId },
      data: { status: 'REMOVED', processedAt: new Date() },
    });
  }

  markItemFailed(itemId: string, errorMessage: string) {
    return this._item.model.pinterestDeleteItem.update({
      where: { id: itemId },
      data: { status: 'FAILED', errorMessage, processedAt: new Date() },
    });
  }

  findOverdueItems(staleBefore: Date) {
    return this._item.model.pinterestDeleteItem.findMany({
      where: { status: 'PENDING', scheduledFor: { lt: staleBefore } },
    });
  }

  async getQueueSummary(
    integrationId: string
  ): Promise<PinterestDeleteQueueSummary> {
    const items = await this._item.model.pinterestDeleteItem.findMany({
      where: { integrationId },
      select: {
        id: true,
        pinId: true,
        rawInput: true,
        status: true,
        scheduledFor: true,
        errorMessage: true,
        processedAt: true,
      },
    });

    const pending = items.filter((i) => i.status === 'PENDING');
    const pendingSorted = [...pending].sort(
      (a, b) =>
        (a.scheduledFor?.getTime() ?? 0) - (b.scheduledFor?.getTime() ?? 0)
    );

    return {
      queued: pending.length,
      done: items.filter((i) => i.status === 'REMOVED').length,
      failed: items
        .filter((i) => i.status === 'FAILED')
        .map(({ id, pinId, rawInput, errorMessage, processedAt }) => ({
          id,
          pinId,
          rawInput,
          errorMessage,
          processedAt,
        })),
      totalEverSubmitted: items.length,
      nextRunAt: pendingSorted[0]?.scheduledFor ?? null,
      lastCompletionAt:
        pendingSorted[pendingSorted.length - 1]?.scheduledFor ?? null,
    };
  }

  // Deletes REMOVED/FAILED items older than `cutoff`, then deletes any
  // batch left with zero remaining items (batches have no display value
  // once empty). PENDING items are never touched regardless of age.
  async purgeCompletedItemsOlderThan(cutoff: Date): Promise<number> {
    const result = await this._item.model.pinterestDeleteItem.deleteMany({
      where: {
        status: { in: ['REMOVED', 'FAILED'] },
        processedAt: { lt: cutoff },
      },
    });
    await this._batch.model.pinterestDeleteBatch.deleteMany({
      where: { items: { none: {} } },
    });
    return result.count;
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete.repository.ts libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete.logic.ts libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete.logic.spec.ts
git commit -m "refactor: rework PinterestDeleteRepository onto chained-slot scheduling"
```

---

## Task 4: Rework `PinterestDeleteService` — drop quota check, expose queue summary

**Files:**
- Modify: `libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete.service.ts`

**Interfaces:**
- Consumes: `PinterestDeleteRepository` methods from Task 3.
- Produces: `PinterestDeleteService.createBatch(...)` (unchanged signature, now emits BullMQ delayed jobs using each item's precomputed `scheduledFor`), `processItem(itemId)` (no quota branch), `findStalledItemIntegrationIds(staleMinutes?)` (now based on overdue `PENDING` items, not `updatedAt`), `listQueueSummary(integrationId)`. Removes `recoverDueQuotaWaits`, `listBatchSummaries`.

- [ ] **Step 1: Replace the full contents of `pinterest-delete.service.ts`**

```ts
import { Injectable } from '@nestjs/common';
import dayjs from 'dayjs';
import * as Sentry from '@sentry/nestjs';
import { Integration } from '@prisma/client';
import { PinterestDeleteRepository } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete.repository';
import { parsePinInput } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete.logic';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { BullMqClient } from '@gitroom/nestjs-libraries/bull-mq-transport-new/client';

// Two rolling 24h windows' worth of pins under the old quota model — kept as
// the per-submission cap under the new timer model too, just as a sane
// upper bound on a single form submission (the queue itself has no total
// size limit; you can submit again to append more).
const MAX_PINS_PER_BATCH = 200;

@Injectable()
export class PinterestDeleteService {
  constructor(
    private _repository: PinterestDeleteRepository,
    private _integrationService: IntegrationService,
    private _integrationManager: IntegrationManager,
    private _workerServiceProducer: BullMqClient
  ) {}

  async createBatch(
    organizationId: string,
    integrationId: string,
    createdByUserId: string | null,
    source: 'MANUAL' | 'API' | 'MCP',
    rawPinInputs: string[]
  ): Promise<{ batchId: string; submittedCount: number }> {
    if (rawPinInputs.length === 0 || rawPinInputs.length > MAX_PINS_PER_BATCH) {
      throw new Error(
        `A batch must contain between 1 and ${MAX_PINS_PER_BATCH} pins`
      );
    }

    const integration = await this._integrationService.getIntegrationById(
      organizationId,
      integrationId
    );
    if (
      !integration ||
      integration.providerIdentifier !== 'pinterest' ||
      integration.deletedAt
    ) {
      throw new Error(
        'Integration not found, not a Pinterest account, or no longer connected'
      );
    }

    const parsedPins = rawPinInputs.map((rawInput) => ({
      rawInput,
      pinId: parsePinInput(rawInput),
    }));

    const invalid = parsedPins.filter((p) => !p.pinId);
    if (invalid.length > 0) {
      throw new Error(
        `Could not recognize ${invalid.length} pin id(s)/url(s): ${invalid
          .map((p) => p.rawInput)
          .join(', ')}`
      );
    }

    const batch = await this._repository.createBatchWithItems(
      organizationId,
      integrationId,
      createdByUserId,
      source,
      parsedPins as { pinId: string; rawInput: string }[]
    );

    for (const item of batch.items) {
      this._workerServiceProducer.emit('pinterest-delete-pin', {
        id: item.id,
        options: { delay: Math.max(0, item.scheduledFor!.getTime() - Date.now()) },
        payload: { itemId: item.id },
      });
    }

    return { batchId: batch.id, submittedCount: batch.items.length };
  }

  async processItem(itemId: string): Promise<void> {
    const item = await this._repository.getItemById(itemId);
    if (!item) {
      // Purged by the retention cron before this job ran. Clean no-op.
      return;
    }

    try {
      const accessToken = await this.getValidAccessToken(item.integration);
      const provider =
        this._integrationManager.getSocialIntegration('pinterest');
      const result = await provider.deletePin?.(
        item.integration.internalId,
        accessToken,
        item.pinId
      );

      if (!result?.success) {
        await this._repository.markItemFailed(
          itemId,
          'Pinterest reported the deletion failed'
        );
        return;
      }

      await this._repository.markItemRemoved(itemId);
    } catch (err) {
      await this._repository.markItemFailed(
        itemId,
        err instanceof Error ? err.message : 'Unknown error'
      );
      Sentry.captureException(err, {
        extra: { context: 'PinterestDeleteService.processItem', itemId },
      });
    }
  }

  // Mirrors the refresh-token orchestration already used for publishing
  // (see PostsService.postSocial in posts.service.ts) rather than extracting
  // a shared helper — kept local and duplicated deliberately, to avoid an
  // unrelated refactor of that already-working, unrelated code path.
  private async getValidAccessToken(
    integration: Integration
  ): Promise<string> {
    const provider =
      this._integrationManager.getSocialIntegration('pinterest');

    if (dayjs(integration.tokenExpiration).isAfter(dayjs())) {
      return integration.token;
    }

    const { accessToken, expiresIn, refreshToken, additionalSettings } =
      await provider.refreshToken(integration.refreshToken!);

    if (!accessToken) {
      await this._integrationService.refreshNeeded(
        integration.organizationId,
        integration.id
      );
      throw new Error('Pinterest token refresh failed');
    }

    await this._integrationService.createOrUpdateIntegration(
      additionalSettings,
      !!provider.oneTimeToken,
      integration.organizationId,
      integration.name,
      integration.picture!,
      'social',
      integration.internalId,
      integration.providerIdentifier,
      accessToken,
      refreshToken,
      expiresIn
    );

    return accessToken;
  }

  async findStalledItemIntegrationIds(staleMinutes = 15): Promise<string[]> {
    const staleBefore = dayjs().subtract(staleMinutes, 'minute').toDate();
    const stalled = await this._repository.findOverdueItems(staleBefore);
    return Array.from(new Set(stalled.map((i) => i.integrationId)));
  }

  listQueueSummary(integrationId: string) {
    return this._repository.getQueueSummary(integrationId);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete.service.ts
git commit -m "refactor: drop quota gating from PinterestDeleteService, add queue summary"
```

---

## Task 5: Update Pin Cleanup backend controller — `GET /pinterest-delete/queue`

**Files:**
- Modify: `apps/backend/src/api/routes/pinterest-delete.controller.ts`

**Interfaces:**
- Consumes: `PinterestDeleteService.listQueueSummary(integrationId)` from Task 4.
- Produces: `GET /pinterest-delete/queue?integrationId=` returning `PinterestDeleteQueueSummary` (see Task 3). Removes `GET /pinterest-delete/batches`.

- [ ] **Step 1: Replace the full contents of the controller**

```ts
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { PinterestDeleteService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete.service';
import { PinterestDeleteBatchDto } from '@gitroom/nestjs-libraries/dtos/pinterest-delete/pinterest.delete.batch.dto';

@Controller('/pinterest-delete')
export class PinterestDeleteController {
  constructor(private _pinterestDeleteService: PinterestDeleteService) {}

  @Post('/batches')
  createBatch(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: PinterestDeleteBatchDto
  ) {
    return this._pinterestDeleteService.createBatch(
      org.id,
      body.integrationId,
      user.id,
      'MANUAL',
      body.pins
    );
  }

  @Get('/queue')
  getQueue(@Query('integrationId') integrationId: string) {
    return this._pinterestDeleteService.listQueueSummary(integrationId);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/backend/src/api/routes/pinterest-delete.controller.ts
git commit -m "feat: replace pin-delete batch history endpoint with a queue summary endpoint"
```

---

## Task 6: Simplify the pin-delete cron (drop quota recovery, keep stalled check)

**Files:**
- Create: `apps/cron/src/tasks/check.pinterest.delete.stalled.ts`
- Delete: `apps/cron/src/tasks/recover.pinterest.delete.quota.ts`
- Modify: `apps/cron/src/cron.module.ts`

**Interfaces:**
- Consumes: `PinterestDeleteService.findStalledItemIntegrationIds()` from Task 4.

- [ ] **Step 1: Create the renamed, simplified cron task**

```ts
// apps/cron/src/tasks/check.pinterest.delete.stalled.ts
import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as Sentry from '@sentry/nestjs';
import { PinterestDeleteService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete.service';

@Injectable()
export class CheckPinterestDeleteStalled {
  constructor(private _pinterestDeleteService: PinterestDeleteService) {}

  @Cron('*/5 * * * *')
  async handleCron() {
    try {
      const stalledIntegrationIds =
        await this._pinterestDeleteService.findStalledItemIntegrationIds();
      if (stalledIntegrationIds.length > 0) {
        console.warn(
          `[PINTEREST DELETE] ${stalledIntegrationIds.length} integration(s) have overdue pending pin-deletion items`,
          { stalledIntegrationIds }
        );
        Sentry.captureMessage('Pinterest pin-delete queue appears stalled', {
          extra: { stalledIntegrationIds },
        });
      }
    } catch (err) {
      console.error('[PINTEREST DELETE] Error in stalled-check cron job:', err);
      Sentry.captureException(err, {
        extra: { context: 'CheckPinterestDeleteStalled cron job failed' },
      });
    }
  }
}
```

- [ ] **Step 2: Delete the old quota-recovery cron file**

Delete `apps/cron/src/tasks/recover.pinterest.delete.quota.ts` — its `recoverDueQuotaWaits` logic no longer exists on the service (removed in Task 4), and its stalled-check responsibility has moved to the new file above.

- [ ] **Step 3: Update `cron.module.ts` registration**

In `apps/cron/src/cron.module.ts`, replace:

```ts
import { RecoverPinterestDeleteQuota } from '@gitroom/cron/tasks/recover.pinterest.delete.quota';
```

with:

```ts
import { CheckPinterestDeleteStalled } from '@gitroom/cron/tasks/check.pinterest.delete.stalled';
```

and replace `RecoverPinterestDeleteQuota` in the `providers` array with `CheckPinterestDeleteStalled`.

- [ ] **Step 4: Commit**

```bash
git add apps/cron/src/tasks/check.pinterest.delete.stalled.ts apps/cron/src/cron.module.ts
git rm apps/cron/src/tasks/recover.pinterest.delete.quota.ts
git commit -m "refactor: replace pin-delete quota-recovery cron with a stalled-item check"
```

---

## Task 7: Update the MCP bulk-delete tool description

**Files:**
- Modify: `libraries/nestjs-libraries/src/chat/tools/pinterest.bulk.delete.pins.tool.ts`

**Interfaces:**
- No signature change — `inputSchema`/`outputSchema`/`execute` are unchanged; only the human-readable `description` and the `pins` field's `.describe(...)` text change, since the old text described the now-removed daily-cap behavior.

- [ ] **Step 1: Update the description strings**

Replace:

```ts
      description: `Submits up to 200 Pinterest pins (by id or URL) for permanent deletion from a specific connected Pinterest account. This is irreversible and rate-limited (at most 100 actual deletions per account per rolling 24 hours; a 200-pin call spans roughly 2 days as a result — extra pins wait for the next window automatically) — always confirm with the user exactly which pins and which Pinterest account before calling this.`,
      inputSchema: z.object({
        integrationId: z
          .string()
          .describe(
            'The id of the Pinterest integration (not internal id), from integrationListTool'
          ),
        pins: z
          .array(z.string())
          .max(200)
          .describe(
            'Pinterest pin ids or pin URLs to delete, up to 200 per call (only 100 actually delete per rolling 24h window; the rest queue for the next window)'
          ),
      }),
```

with:

```ts
      description: `Submits up to 200 Pinterest pins (by id or URL) for permanent deletion from a specific connected Pinterest account. This is irreversible and paced deliberately slowly — one pin is actually deleted every 50-60 minutes per account (randomized), so a large call can take a long time to fully drain; submitting more pins later appends to that account's ongoing queue rather than starting a second one — always confirm with the user exactly which pins and which Pinterest account before calling this.`,
      inputSchema: z.object({
        integrationId: z
          .string()
          .describe(
            'The id of the Pinterest integration (not internal id), from integrationListTool'
          ),
        pins: z
          .array(z.string())
          .max(200)
          .describe(
            'Pinterest pin ids or pin URLs to delete, up to 200 per call — they drain from the queue one at a time, roughly every 50-60 minutes per account'
          ),
      }),
```

- [ ] **Step 2: Commit**

```bash
git add libraries/nestjs-libraries/src/chat/tools/pinterest.bulk.delete.pins.tool.ts
git commit -m "docs: update MCP bulk-delete tool description for the new timer-based queue"
```

---

## Task 8: Provider changes — `deleteBoard`, `boards(includeArchived)`

**Files:**
- Modify: `libraries/nestjs-libraries/src/integrations/social/pinterest.provider.ts`
- Modify: `libraries/nestjs-libraries/src/integrations/social/social.integrations.interface.ts`
- Test: `libraries/nestjs-libraries/src/integrations/social/pinterest.provider.spec.ts`

**Interfaces:**
- Produces: `PinterestProvider.deleteBoard(id: string, accessToken: string, boardId: string): Promise<{ success: boolean }>`; `PinterestProvider.boards(accessToken: string, data?: { includeArchived?: boolean }): Promise<{ name: string; id: string }[]>` (signature widened, existing no-arg call sites unaffected). Adds `deleteBoard?(...)` to the `SocialProvider` interface.

- [ ] **Step 1: Write the failing tests**

This file is new (`pinterest.provider.ts` currently has no spec file), so create it targeting only the two changed/new methods — not a full rewrite of provider tests, which is out of scope here. Mock `this.fetch` via the class's prototype since `fetch()` lives on `SocialAbstract`.

```ts
// libraries/nestjs-libraries/src/integrations/social/pinterest.provider.spec.ts
import { PinterestProvider } from './pinterest.provider';

describe('PinterestProvider.deleteBoard', () => {
  it('reports success on a 204 response', async () => {
    const provider = new PinterestProvider();
    jest
      .spyOn(provider as any, 'fetch')
      .mockResolvedValue({ status: 204 } as any);

    const result = await provider.deleteBoard('internal-id', 'token', 'board-1');

    expect(result).toEqual({ success: true });
    expect((provider as any).fetch).toHaveBeenCalledWith(
      'https://api.pinterest.com/v5/boards/board-1',
      expect.objectContaining({
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
      })
    );
  });

  it('reports failure on a non-2xx response', async () => {
    const provider = new PinterestProvider();
    jest
      .spyOn(provider as any, 'fetch')
      .mockResolvedValue({ status: 404 } as any);

    const result = await provider.deleteBoard('internal-id', 'token', 'board-1');

    expect(result).toEqual({ success: false });
  });
});

describe('PinterestProvider.boards', () => {
  const jsonResponse = (body: any) => ({
    ok: true,
    json: async () => body,
  });

  it('does not request archived boards when includeArchived is not passed', async () => {
    const provider = new PinterestProvider();
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(jsonResponse({ items: [] }) as any);

    await provider.boards('token');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.pinterest.com/v5/boards?page_size=250',
      expect.anything()
    );
    fetchSpy.mockRestore();
  });

  it('requests archived boards when includeArchived is true', async () => {
    const provider = new PinterestProvider();
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(jsonResponse({ items: [] }) as any);

    await provider.boards('token', { includeArchived: true });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.pinterest.com/v5/boards?page_size=250&include_archived=true',
      expect.anything()
    );
    fetchSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ./libraries/nestjs-libraries run test -- --testPathPattern="pinterest.provider.spec"`
Expected: FAIL — `deleteBoard` does not exist yet, and `boards` doesn't accept a second argument / doesn't add `include_archived`. Verify via CI per Global Constraints.

- [ ] **Step 3: Add `deleteBoard` next to `deletePin`**

In `pinterest.provider.ts`, immediately after the existing `deletePin` method:

```ts
  async deleteBoard(
    id: string,
    accessToken: string,
    boardId: string
  ): Promise<{ success: boolean }> {
    const response = await this.fetch(
      `https://api.pinterest.com/v5/boards/${boardId}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    return { success: response.status === 204 || response.status === 200 };
  }
```

- [ ] **Step 4: Widen `boards()` to accept an optional `includeArchived` flag**

Replace the method signature and first page URL construction:

```ts
  @Tool({ description: 'List of boards', dataSchema: [] })
  async boards(accessToken: string, data?: { includeArchived?: boolean }) {
    let allBoards: any[] = [];
    let bookmark: string | undefined = undefined;
    let hasMore = true;
    let pageCount = 0;
    const maxPages = 20; // Safety limit to prevent infinite loops
    const archivedParam = data?.includeArchived ? '&include_archived=true' : '';

    try {
      // Fetch all boards with pagination
      while (hasMore && pageCount < maxPages) {
        const url = bookmark
          ? `https://api.pinterest.com/v5/boards?page_size=250&bookmark=${bookmark}${archivedParam}`
          : `https://api.pinterest.com/v5/boards?page_size=250${archivedParam}`;
```

(The rest of the method body is unchanged.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter ./libraries/nestjs-libraries run test -- --testPathPattern="pinterest.provider.spec"`
Expected: PASS (4 tests). Verify via CI per Global Constraints.

- [ ] **Step 6: Add `deleteBoard?` to the `SocialProvider` interface**

In `social.integrations.interface.ts`, immediately after the existing `createBoard?` declaration:

```ts
  deleteBoard?(
    id: string,
    accessToken: string,
    boardId: string
  ): Promise<{ success: boolean }>;
```

- [ ] **Step 7: Commit**

```bash
git add libraries/nestjs-libraries/src/integrations/social/pinterest.provider.ts libraries/nestjs-libraries/src/integrations/social/pinterest.provider.spec.ts libraries/nestjs-libraries/src/integrations/social/social.integrations.interface.ts
git commit -m "feat: add Pinterest deleteBoard and archived-board listing support"
```

---

## Task 9: Board Deletion DTO

**Files:**
- Create: `libraries/nestjs-libraries/src/dtos/pinterest-board-delete/pinterest.board.delete.batch.dto.ts`

**Interfaces:**
- Produces: `PinterestBoardDeleteItemDto { boardId: string; boardName: string }`, `PinterestBoardDeleteBatchDto { integrationId: string; boards: PinterestBoardDeleteItemDto[] }` (max 25 entries) — consumed by the controller in Task 12.

- [ ] **Step 1: Create the DTO**

```ts
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  ValidateNested,
} from 'class-validator';

export class PinterestBoardDeleteItemDto {
  @IsString()
  boardId: string;

  @IsString()
  boardName: string;
}

export class PinterestBoardDeleteBatchDto {
  @IsString()
  integrationId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(25)
  @ValidateNested({ each: true })
  @Type(() => PinterestBoardDeleteItemDto)
  boards: PinterestBoardDeleteItemDto[];
}
```

- [ ] **Step 2: Commit**

```bash
git add libraries/nestjs-libraries/src/dtos/pinterest-board-delete/pinterest.board.delete.batch.dto.ts
git commit -m "feat: add PinterestBoardDeleteBatchDto"
```

---

## Task 10: Board Deletion repository

**Files:**
- Create: `libraries/nestjs-libraries/src/database/prisma/pinterest-board-delete/pinterest-board-delete.repository.ts`
- Test: `libraries/nestjs-libraries/src/database/prisma/pinterest-board-delete/pinterest-board-delete.repository.spec.ts`

**Interfaces:**
- Consumes: `computeChainedSlots` from Task 1.
- Produces: `PinterestBoardDeleteRepository.createBatchWithItems(...)`, `getItemById(itemId)`, `markItemRemoved(itemId)`, `markItemFailed(itemId, errorMessage)`, `findPendingBoardIds(integrationId): Promise<string[]>`, `findOverdueItems(staleBefore)`, `getQueueSummary(integrationId): Promise<PinterestBoardDeleteQueueSummary>`, `purgeCompletedItemsOlderThan(cutoff): Promise<number>`.
- `PinterestBoardDeleteQueueSummary`: `{ queued: number; done: number; failed: { id: string; boardId: string; boardName: string; errorMessage: string | null; processedAt: Date | null }[]; totalEverSubmitted: number; nextRunAt: Date | null; lastCompletionAt: Date | null; items: { id: string; boardId: string; boardName: string; status: string; scheduledFor: Date | null; errorMessage: string | null }[] }`.

This repository has no live database in this sandbox to test `createBatchWithItems`/`getQueueSummary` against (they need a real Prisma client). Following the existing convention in this codebase (`pinterest-delete.repository.ts` has no spec file — only its pure-logic sibling `pinterest-delete.logic.ts` does), this task's test file covers only the one piece of real logic that doesn't require a database: which boards count as "already pending" is a pure filter, tested via a small extracted helper.

- [ ] **Step 1: Write the failing test for the dedupe helper**

```ts
// libraries/nestjs-libraries/src/database/prisma/pinterest-board-delete/pinterest-board-delete.repository.spec.ts
import { excludeAlreadyPendingBoards } from './pinterest-board-delete.repository';

describe('excludeAlreadyPendingBoards', () => {
  it('keeps boards not already pending', () => {
    const result = excludeAlreadyPendingBoards(
      [
        { boardId: 'b1', boardName: 'Board 1' },
        { boardId: 'b2', boardName: 'Board 2' },
      ],
      ['b3']
    );
    expect(result).toEqual([
      { boardId: 'b1', boardName: 'Board 1' },
      { boardId: 'b2', boardName: 'Board 2' },
    ]);
  });

  it('drops boards already pending', () => {
    const result = excludeAlreadyPendingBoards(
      [
        { boardId: 'b1', boardName: 'Board 1' },
        { boardId: 'b2', boardName: 'Board 2' },
      ],
      ['b1']
    );
    expect(result).toEqual([{ boardId: 'b2', boardName: 'Board 2' }]);
  });

  it('returns an empty array when everything is already pending', () => {
    const result = excludeAlreadyPendingBoards(
      [{ boardId: 'b1', boardName: 'Board 1' }],
      ['b1']
    );
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ./libraries/nestjs-libraries run test -- --testPathPattern="pinterest-board-delete.repository.spec"`
Expected: FAIL — module does not exist yet. Verify via CI per Global Constraints.

- [ ] **Step 3: Write the repository**

```ts
import { Injectable } from '@nestjs/common';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { computeChainedSlots } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete-scheduling.logic';

const BOARD_DELETE_MIN_MINUTES = 300;
const BOARD_DELETE_MAX_MINUTES = 320;

export interface PinterestBoardDeleteQueueSummary {
  queued: number;
  done: number;
  failed: {
    id: string;
    boardId: string;
    boardName: string;
    errorMessage: string | null;
    processedAt: Date | null;
  }[];
  totalEverSubmitted: number;
  nextRunAt: Date | null;
  lastCompletionAt: Date | null;
  items: {
    id: string;
    boardId: string;
    boardName: string;
    status: string;
    scheduledFor: Date | null;
    errorMessage: string | null;
  }[];
}

// Pure filter, extracted so it's testable without a database: drops any
// submitted board whose id is already PENDING in this integration's queue.
export function excludeAlreadyPendingBoards<
  T extends { boardId: string }
>(boards: T[], alreadyPendingBoardIds: string[]): T[] {
  const pendingSet = new Set(alreadyPendingBoardIds);
  return boards.filter((b) => !pendingSet.has(b.boardId));
}

@Injectable()
export class PinterestBoardDeleteRepository {
  constructor(
    private _batch: PrismaRepository<'pinterestBoardDeleteBatch'>,
    private _item: PrismaRepository<'pinterestBoardDeleteItem'>,
    private _transaction: PrismaTransaction
  ) {}

  createBatchWithItems(
    organizationId: string,
    integrationId: string,
    createdByUserId: string | null,
    source: 'MANUAL',
    boards: { boardId: string; boardName: string }[]
  ) {
    return this._transaction.model.$transaction(async (tx) => {
      const integration = await tx.integration.findUniqueOrThrow({
        where: { id: integrationId },
        select: { boardDeleteNextSlot: true },
      });

      const slots = computeChainedSlots(
        integration.boardDeleteNextSlot,
        boards.length,
        BOARD_DELETE_MIN_MINUTES,
        BOARD_DELETE_MAX_MINUTES
      );

      const batch = await tx.pinterestBoardDeleteBatch.create({
        data: {
          organizationId,
          integrationId,
          createdByUserId,
          source,
          submittedCount: boards.length,
          items: {
            create: boards.map(({ boardId, boardName }, i) => ({
              integrationId,
              boardId,
              boardName,
              status: 'PENDING',
              scheduledFor: slots[i],
            })),
          },
        },
        include: { items: true },
      });

      await tx.integration.update({
        where: { id: integrationId },
        data: { boardDeleteNextSlot: slots[slots.length - 1] },
      });

      return batch;
    });
  }

  getItemById(itemId: string) {
    return this._item.model.pinterestBoardDeleteItem.findUnique({
      where: { id: itemId },
      include: { integration: true },
    });
  }

  markItemRemoved(itemId: string) {
    return this._item.model.pinterestBoardDeleteItem.update({
      where: { id: itemId },
      data: { status: 'REMOVED', processedAt: new Date() },
    });
  }

  markItemFailed(itemId: string, errorMessage: string) {
    return this._item.model.pinterestBoardDeleteItem.update({
      where: { id: itemId },
      data: { status: 'FAILED', errorMessage, processedAt: new Date() },
    });
  }

  async findPendingBoardIds(integrationId: string): Promise<string[]> {
    const rows = await this._item.model.pinterestBoardDeleteItem.findMany({
      where: { integrationId, status: 'PENDING' },
      select: { boardId: true },
    });
    return rows.map((r) => r.boardId);
  }

  findOverdueItems(staleBefore: Date) {
    return this._item.model.pinterestBoardDeleteItem.findMany({
      where: { status: 'PENDING', scheduledFor: { lt: staleBefore } },
    });
  }

  async getQueueSummary(
    integrationId: string
  ): Promise<PinterestBoardDeleteQueueSummary> {
    const items = await this._item.model.pinterestBoardDeleteItem.findMany({
      where: { integrationId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        boardId: true,
        boardName: true,
        status: true,
        scheduledFor: true,
        errorMessage: true,
        processedAt: true,
      },
    });

    const pending = items.filter((i) => i.status === 'PENDING');
    const pendingSorted = [...pending].sort(
      (a, b) =>
        (a.scheduledFor?.getTime() ?? 0) - (b.scheduledFor?.getTime() ?? 0)
    );

    return {
      queued: pending.length,
      done: items.filter((i) => i.status === 'REMOVED').length,
      failed: items
        .filter((i) => i.status === 'FAILED')
        .map(({ id, boardId, boardName, errorMessage, processedAt }) => ({
          id,
          boardId,
          boardName,
          errorMessage,
          processedAt,
        })),
      totalEverSubmitted: items.length,
      nextRunAt: pendingSorted[0]?.scheduledFor ?? null,
      lastCompletionAt:
        pendingSorted[pendingSorted.length - 1]?.scheduledFor ?? null,
      items: items.map(
        ({ id, boardId, boardName, status, scheduledFor, errorMessage }) => ({
          id,
          boardId,
          boardName,
          status,
          scheduledFor,
          errorMessage,
        })
      ),
    };
  }

  async purgeCompletedItemsOlderThan(cutoff: Date): Promise<number> {
    const result = await this._item.model.pinterestBoardDeleteItem.deleteMany({
      where: {
        status: { in: ['REMOVED', 'FAILED'] },
        processedAt: { lt: cutoff },
      },
    });
    await this._batch.model.pinterestBoardDeleteBatch.deleteMany({
      where: { items: { none: {} } },
    });
    return result.count;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ./libraries/nestjs-libraries run test -- --testPathPattern="pinterest-board-delete.repository.spec"`
Expected: PASS (3 tests). Verify via CI per Global Constraints.

- [ ] **Step 5: Commit**

```bash
git add libraries/nestjs-libraries/src/database/prisma/pinterest-board-delete/
git commit -m "feat: add PinterestBoardDeleteRepository"
```

---

## Task 11: Board Deletion service

**Files:**
- Create: `libraries/nestjs-libraries/src/database/prisma/pinterest-board-delete/pinterest-board-delete.service.ts`

**Interfaces:**
- Consumes: `PinterestBoardDeleteRepository` (Task 10), `excludeAlreadyPendingBoards` (Task 10).
- Produces: `PinterestBoardDeleteService.createBatch(organizationId, integrationId, createdByUserId, boards): Promise<{ batchId: string; submittedCount: number }>`, `processItem(itemId): Promise<void>`, `findStalledItemIntegrationIds(staleMinutes?)`, `listQueueSummary(integrationId)`.

- [ ] **Step 1: Write the service**

```ts
import { Injectable } from '@nestjs/common';
import dayjs from 'dayjs';
import * as Sentry from '@sentry/nestjs';
import { Integration } from '@prisma/client';
import { PinterestBoardDeleteRepository } from '@gitroom/nestjs-libraries/database/prisma/pinterest-board-delete/pinterest-board-delete.repository';
import { excludeAlreadyPendingBoards } from '@gitroom/nestjs-libraries/database/prisma/pinterest-board-delete/pinterest-board-delete.repository';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { BullMqClient } from '@gitroom/nestjs-libraries/bull-mq-transport-new/client';

const MAX_BOARDS_PER_BATCH = 25;

@Injectable()
export class PinterestBoardDeleteService {
  constructor(
    private _repository: PinterestBoardDeleteRepository,
    private _integrationService: IntegrationService,
    private _integrationManager: IntegrationManager,
    private _workerServiceProducer: BullMqClient
  ) {}

  async createBatch(
    organizationId: string,
    integrationId: string,
    createdByUserId: string | null,
    boards: { boardId: string; boardName: string }[]
  ): Promise<{ batchId: string; submittedCount: number }> {
    if (boards.length === 0 || boards.length > MAX_BOARDS_PER_BATCH) {
      throw new Error(
        `A batch must contain between 1 and ${MAX_BOARDS_PER_BATCH} boards`
      );
    }

    const integration = await this._integrationService.getIntegrationById(
      organizationId,
      integrationId
    );
    if (
      !integration ||
      integration.providerIdentifier !== 'pinterest' ||
      integration.deletedAt
    ) {
      throw new Error(
        'Integration not found, not a Pinterest account, or no longer connected'
      );
    }

    const alreadyPendingBoardIds = await this._repository.findPendingBoardIds(
      integrationId
    );
    const toQueue = excludeAlreadyPendingBoards(boards, alreadyPendingBoardIds);

    if (toQueue.length === 0) {
      throw new Error('All selected boards are already queued for deletion');
    }

    const batch = await this._repository.createBatchWithItems(
      organizationId,
      integrationId,
      createdByUserId,
      'MANUAL',
      toQueue
    );

    for (const item of batch.items) {
      this._workerServiceProducer.emit('pinterest-delete-board', {
        id: item.id,
        options: { delay: Math.max(0, item.scheduledFor!.getTime() - Date.now()) },
        payload: { itemId: item.id },
      });
    }

    return { batchId: batch.id, submittedCount: batch.items.length };
  }

  async processItem(itemId: string): Promise<void> {
    const item = await this._repository.getItemById(itemId);
    if (!item) {
      return;
    }

    try {
      const accessToken = await this.getValidAccessToken(item.integration);
      const provider =
        this._integrationManager.getSocialIntegration('pinterest');
      const result = await provider.deleteBoard?.(
        item.integration.internalId,
        accessToken,
        item.boardId
      );

      if (!result?.success) {
        await this._repository.markItemFailed(
          itemId,
          'Pinterest reported the deletion failed'
        );
        return;
      }

      await this._repository.markItemRemoved(itemId);
    } catch (err) {
      await this._repository.markItemFailed(
        itemId,
        err instanceof Error ? err.message : 'Unknown error'
      );
      Sentry.captureException(err, {
        extra: { context: 'PinterestBoardDeleteService.processItem', itemId },
      });
    }
  }

  // Mirrors PinterestDeleteService.getValidAccessToken — kept local and
  // duplicated deliberately rather than extracting a shared helper, to
  // avoid an unrelated refactor of that already-working, unrelated code path.
  private async getValidAccessToken(
    integration: Integration
  ): Promise<string> {
    const provider =
      this._integrationManager.getSocialIntegration('pinterest');

    if (dayjs(integration.tokenExpiration).isAfter(dayjs())) {
      return integration.token;
    }

    const { accessToken, expiresIn, refreshToken, additionalSettings } =
      await provider.refreshToken(integration.refreshToken!);

    if (!accessToken) {
      await this._integrationService.refreshNeeded(
        integration.organizationId,
        integration.id
      );
      throw new Error('Pinterest token refresh failed');
    }

    await this._integrationService.createOrUpdateIntegration(
      additionalSettings,
      !!provider.oneTimeToken,
      integration.organizationId,
      integration.name,
      integration.picture!,
      'social',
      integration.internalId,
      integration.providerIdentifier,
      accessToken,
      refreshToken,
      expiresIn
    );

    return accessToken;
  }

  async findStalledItemIntegrationIds(staleMinutes = 15): Promise<string[]> {
    const staleBefore = dayjs().subtract(staleMinutes, 'minute').toDate();
    const stalled = await this._repository.findOverdueItems(staleBefore);
    return Array.from(new Set(stalled.map((i) => i.integrationId)));
  }

  listQueueSummary(integrationId: string) {
    return this._repository.getQueueSummary(integrationId);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add libraries/nestjs-libraries/src/database/prisma/pinterest-board-delete/pinterest-board-delete.service.ts
git commit -m "feat: add PinterestBoardDeleteService"
```

---

## Task 12: Board Deletion backend controller + module registrations

**Files:**
- Create: `apps/backend/src/api/routes/pinterest-board-delete.controller.ts`
- Modify: `libraries/nestjs-libraries/src/database/prisma/database.module.ts`
- Modify: `apps/backend/src/api/api.module.ts`

**Interfaces:**
- Consumes: `PinterestBoardDeleteService` (Task 11), `PinterestBoardDeleteRepository` (Task 10), `PinterestBoardDeleteBatchDto` (Task 9).
- Produces: `POST /pinterest-board-delete/batches`, `GET /pinterest-board-delete/queue?integrationId=`.

- [ ] **Step 1: Create the controller**

```ts
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { PinterestBoardDeleteService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-board-delete/pinterest-board-delete.service';
import { PinterestBoardDeleteBatchDto } from '@gitroom/nestjs-libraries/dtos/pinterest-board-delete/pinterest.board.delete.batch.dto';

@Controller('/pinterest-board-delete')
export class PinterestBoardDeleteController {
  constructor(private _pinterestBoardDeleteService: PinterestBoardDeleteService) {}

  @Post('/batches')
  createBatch(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: PinterestBoardDeleteBatchDto
  ) {
    return this._pinterestBoardDeleteService.createBatch(
      org.id,
      body.integrationId,
      user.id,
      body.boards
    );
  }

  @Get('/queue')
  getQueue(@Query('integrationId') integrationId: string) {
    return this._pinterestBoardDeleteService.listQueueSummary(integrationId);
  }
}
```

- [ ] **Step 2: Register the repository and service in `database.module.ts`**

Add imports alongside the existing `PinterestDeleteService`/`PinterestDeleteRepository` imports:

```ts
import { PinterestBoardDeleteService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-board-delete/pinterest-board-delete.service';
import { PinterestBoardDeleteRepository } from '@gitroom/nestjs-libraries/database/prisma/pinterest-board-delete/pinterest-board-delete.repository';
```

Add both to the `providers` array, next to `PinterestDeleteService, PinterestDeleteRepository,`:

```ts
    PinterestDeleteService,
    PinterestDeleteRepository,
    PinterestBoardDeleteService,
    PinterestBoardDeleteRepository,
```

Also add both to the module's `exports` array if `PinterestDeleteService`/`PinterestDeleteRepository` are exported there (check the existing entries in the same file and mirror exactly whichever arrays they appear in).

- [ ] **Step 3: Register the controller in `apps/backend/src/api/api.module.ts`**

Add the import alongside the existing `PinterestDeleteController` import:

```ts
import { PinterestBoardDeleteController } from '@gitroom/backend/api/routes/pinterest-board-delete.controller';
```

Add it to the `controllers` array, next to `PinterestDeleteController,`:

```ts
  PinterestDeleteController,
  PinterestBoardDeleteController,
```

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/api/routes/pinterest-board-delete.controller.ts libraries/nestjs-libraries/src/database/prisma/database.module.ts apps/backend/src/api/api.module.ts
git commit -m "feat: wire up Board Deletion backend endpoints"
```

---

## Task 13: Board Deletion worker

**Files:**
- Create: `apps/workers/src/app/pinterest-board-delete.controller.ts`
- Modify: `apps/workers/src/app/app.module.ts`

**Interfaces:**
- Consumes: `PinterestBoardDeleteService.processItem(itemId)` (Task 11).
- Produces: `@EventPattern('pinterest-delete-board', Transport.REDIS)` handler consuming the jobs emitted in Task 11.

- [ ] **Step 1: Create the worker controller**

```ts
import { Controller } from '@nestjs/common';
import { EventPattern, Transport } from '@nestjs/microservices';
import { PinterestBoardDeleteService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-board-delete/pinterest-board-delete.service';

@Controller()
export class PinterestBoardDeleteController {
  constructor(private _pinterestBoardDeleteService: PinterestBoardDeleteService) {}

  @EventPattern('pinterest-delete-board', Transport.REDIS)
  async pinterestDeleteBoard(data: { itemId: string }) {
    try {
      return await this._pinterestBoardDeleteService.processItem(data.itemId);
    } catch (err) {
      console.log(
        "Unhandled error, let's avoid crashing the pinterest-delete-board worker",
        err
      );
    }
  }
}
```

- [ ] **Step 2: Register it in `apps/workers/src/app/app.module.ts`**

Add the import alongside `PinterestDeleteController`:

```ts
import { PinterestBoardDeleteController } from '@gitroom/workers/app/pinterest-board-delete.controller';
```

Add it to the `controllers` array:

```ts
  controllers: [PostsController, PlugsController, PinterestDeleteController, PinterestBoardDeleteController],
```

- [ ] **Step 3: Commit**

```bash
git add apps/workers/src/app/pinterest-board-delete.controller.ts apps/workers/src/app/app.module.ts
git commit -m "feat: add Board Deletion worker"
```

---

## Task 14: Shared 7-day history purge cron

**Files:**
- Create: `apps/cron/src/tasks/purge.pinterest.delete.history.ts`
- Modify: `apps/cron/src/cron.module.ts`

**Interfaces:**
- Consumes: `PinterestDeleteRepository.purgeCompletedItemsOlderThan(cutoff)` (Task 3), `PinterestBoardDeleteRepository.purgeCompletedItemsOlderThan(cutoff)` (Task 10).

- [ ] **Step 1: Create the cron task**

```ts
import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import dayjs from 'dayjs';
import * as Sentry from '@sentry/nestjs';
import { PinterestDeleteRepository } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete.repository';
import { PinterestBoardDeleteRepository } from '@gitroom/nestjs-libraries/database/prisma/pinterest-board-delete/pinterest-board-delete.repository';

const RETENTION_DAYS = 7;

@Injectable()
export class PurgePinterestDeleteHistory {
  constructor(
    private _pinterestDeleteRepository: PinterestDeleteRepository,
    private _pinterestBoardDeleteRepository: PinterestBoardDeleteRepository
  ) {}

  @Cron('0 3 * * *')
  async handleCron() {
    try {
      const cutoff = dayjs().subtract(RETENTION_DAYS, 'day').toDate();
      const purgedPins =
        await this._pinterestDeleteRepository.purgeCompletedItemsOlderThan(
          cutoff
        );
      const purgedBoards =
        await this._pinterestBoardDeleteRepository.purgeCompletedItemsOlderThan(
          cutoff
        );
      if (purgedPins > 0 || purgedBoards > 0) {
        console.log(
          `[PINTEREST DELETE HISTORY] Purged ${purgedPins} pin item(s) and ${purgedBoards} board item(s) older than ${RETENTION_DAYS} days`
        );
      }
    } catch (err) {
      console.error('[PINTEREST DELETE HISTORY] Error in purge cron job:', err);
      Sentry.captureException(err, {
        extra: { context: 'PurgePinterestDeleteHistory cron job failed' },
      });
    }
  }
}
```

- [ ] **Step 2: Register it in `cron.module.ts`**

Add the import:

```ts
import { PurgePinterestDeleteHistory } from '@gitroom/cron/tasks/purge.pinterest.delete.history';
```

Add `PurgePinterestDeleteHistory` to the `providers` array.

- [ ] **Step 3: Commit**

```bash
git add apps/cron/src/tasks/purge.pinterest.delete.history.ts apps/cron/src/cron.module.ts
git commit -m "feat: add 7-day history purge cron for both Pinterest deletion queues"
```

---

## Task 15: Pin Cleanup frontend — rework onto the queue summary

**Files:**
- Modify: `apps/frontend/src/components/pinterest-cleanup/pinterest.cleanup.component.tsx`

**Interfaces:**
- Consumes: `GET /pinterest-delete/queue?integrationId=` (Task 5), shape `PinterestDeleteQueueSummary` (Task 3).

This is a UI-only change with no test file, matching this component's existing (untested) convention.

- [ ] **Step 1: Replace the batch-history types and summary logic**

Replace:

```tsx
interface PinterestDeleteItemSummary {
  id: string;
  status: 'PENDING' | 'QUEUED' | 'REMOVED' | 'FAILED' | 'WAITING_FOR_QUOTA';
  scheduledFor: string | null;
}

interface PinterestDeleteBatchSummary {
  id: string;
  createdAt: string;
  submittedCount: number;
  source: string;
  items: PinterestDeleteItemSummary[];
}

// Hard ceiling enforced by the backend too (see MAX_PINS_PER_BATCH in
// pinterest-delete.service.ts) — two rolling 24h windows' worth of pins.
const ABSOLUTE_MAX_PINS = 200;
const DEFAULT_MAX_PINS = 100;
// Actual per-account deletions allowed per rolling 24h window (DAILY_CAP in
// pinterest-delete.repository.ts). Not a calendar-day reset — deletions from
// any earlier batch (or MCP/API call) in the last 24h count against it too.
const DAILY_RATE_LIMIT = 100;

function summarize(items: PinterestDeleteItemSummary[]) {
  return {
    removed: items.filter((i) => i.status === 'REMOVED').length,
    failed: items.filter((i) => i.status === 'FAILED').length,
    waiting: items.filter((i) => i.status === 'WAITING_FOR_QUOTA').length,
    pending: items.filter((i) => i.status === 'PENDING' || i.status === 'QUEUED')
      .length,
  };
}
```

with:

```tsx
interface PinterestDeleteFailedItem {
  id: string;
  pinId: string;
  rawInput: string;
  errorMessage: string | null;
  processedAt: string | null;
}

interface PinterestDeleteQueueSummary {
  queued: number;
  done: number;
  failed: PinterestDeleteFailedItem[];
  totalEverSubmitted: number;
  nextRunAt: string | null;
  lastCompletionAt: string | null;
}

// Hard ceiling enforced by the backend too (see MAX_PINS_PER_BATCH in
// pinterest-delete.service.ts) — a sane cap on one form submission. Multiple
// submissions append to the same ongoing per-account queue.
const ABSOLUTE_MAX_PINS = 200;
const DEFAULT_MAX_PINS = 100;
```

- [ ] **Step 2: Point the SWR hook at the new endpoint**

Replace:

```tsx
  const { data: batchesData, mutate: mutateBatches } = useSWR<
    PinterestDeleteBatchSummary[]
  >(
    selectedIntegrationId
      ? `pinterest-delete-batches-${selectedIntegrationId}`
      : null,
    async () =>
      (
        await fetch(
          `/pinterest-delete/batches?integrationId=${selectedIntegrationId}`
        )
      ).json(),
    { refreshInterval: 7000 }
  );
```

with:

```tsx
  const { data: queueData, mutate: mutateQueue } = useSWR<
    PinterestDeleteQueueSummary
  >(
    selectedIntegrationId
      ? `pinterest-delete-queue-${selectedIntegrationId}`
      : null,
    async () =>
      (
        await fetch(`/pinterest-delete/queue?integrationId=${selectedIntegrationId}`)
      ).json(),
    { refreshInterval: 7000 }
  );
```

- [ ] **Step 3: Update the submit handler's mutate call and remove the removed variable references**

Replace `mutateBatches();` (inside `onSubmit`) with `mutateQueue();`.

- [ ] **Step 4: Replace the render section below the submit button**

Replace everything from:

```tsx
            {nextQuotaResume && (
```

through the end of the component's closing `</>` return (i.e. the quota banner + History block) with:

```tsx
            <div className="flex flex-col gap-2">
              <div className="text-lg font-semibold">Queue status</div>
              <div className="border border-newTableBorder bg-sixth rounded p-3 flex flex-col gap-1">
                <div>
                  Queued: {queueData?.queued ?? 0} · Done: {queueData?.done ?? 0} ·
                  Failed: {queueData?.failed.length ?? 0} · Total submitted:{' '}
                  {queueData?.totalEverSubmitted ?? 0}
                </div>
                <div className="text-[12px] text-customColor18">
                  Next deletion at:{' '}
                  {queueData?.nextRunAt
                    ? new Date(queueData.nextRunAt).toLocaleString()
                    : '—'}{' '}
                  · Last one completes:{' '}
                  {queueData?.lastCompletionAt
                    ? new Date(queueData.lastCompletionAt).toLocaleString()
                    : '—'}
                </div>
                <div className="text-[12px] text-customColor18">
                  Pins are deleted one at a time, every 50-60 minutes
                  (randomized) — this keeps deletions from looking spammy to
                  Pinterest. Submitting more pins adds them to this same
                  ongoing queue.
                </div>
              </div>

              {queueData && queueData.failed.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="text-lg font-semibold">Failed pins</div>
                  {queueData.failed.map((item) => (
                    <div
                      key={item.id}
                      className="border border-newTableBorder bg-sixth rounded p-3"
                    >
                      <div className="truncate" title={item.rawInput}>
                        {item.rawInput}
                      </div>
                      <div className="text-red-400 text-[12px]">
                        {item.errorMessage}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
```

Also remove the now-unused `nextQuotaResume`/`batches` local variables above the JSX return (the block computing `const batches = batchesData || [];` and `const nextQuotaResume = ...`), and remove the now-unused `DAILY_RATE_LIMIT`-driven warning block further up in the form section:

```tsx
            {maxPins > DAILY_RATE_LIMIT && (
              <div className="text-[12px] text-customColor18">
                Batches over {DAILY_RATE_LIMIT} pins will span more than one
                day: only {DAILY_RATE_LIMIT} deletions run per rolling 24-hour
                window per Pinterest account. The rest are queued
                automatically and processed once the window rolls forward —
                this keeps deletions from looking spammy to Pinterest.
              </div>
            )}
```

(delete this block entirely).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/components/pinterest-cleanup/pinterest.cleanup.component.tsx
git commit -m "feat: rework Pin Cleanup UI onto the timed-queue summary"
```

---

## Task 16: Board Deletion frontend tab

**Files:**
- Create: `apps/frontend/src/components/pinterest-board-delete/pinterest.board.delete.component.tsx`
- Create: `apps/frontend/src/app/(app)/(site)/pinterest-board-delete/page.tsx`
- Modify: `apps/frontend/src/components/layout/top.menu.tsx`

**Interfaces:**
- Consumes: `/integrations/list`, `/integrations/function` (`name: 'boards'`, `data: { includeArchived: true }`), `POST /pinterest-board-delete/batches`, `GET /pinterest-board-delete/queue?integrationId=` (Task 12).

- [ ] **Step 1: Create the component**

```tsx
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { orderBy } from 'lodash';
import clsx from 'clsx';
import Image from 'next/image';
import useCookie from 'react-use-cookie';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { Slider } from '@gitroom/react/form/slider';
import ImageWithFallback from '@gitroom/react/helpers/image.with.fallback';
import { SVGLine } from '@gitroom/frontend/components/launches/launches.component';

interface IntegrationListItem {
  id: string;
  name: string;
  identifier: string;
  picture: string;
  disabled?: boolean;
  refreshNeeded?: boolean;
  inBetweenSteps?: boolean;
}

interface PinterestBoardOption {
  id: string;
  name: string;
}

interface PinterestBoardDeleteQueueItem {
  id: string;
  boardId: string;
  boardName: string;
  status: 'PENDING' | 'REMOVED' | 'FAILED';
  scheduledFor: string | null;
  errorMessage: string | null;
}

interface PinterestBoardDeleteQueueSummary {
  queued: number;
  done: number;
  failed: {
    id: string;
    boardId: string;
    boardName: string;
    errorMessage: string | null;
  }[];
  totalEverSubmitted: number;
  nextRunAt: string | null;
  lastCompletionAt: string | null;
  items: PinterestBoardDeleteQueueItem[];
}

const MAX_BOARDS_PER_SUBMISSION = 25;

export const PinterestBoardDeleteComponent = () => {
  const fetch = useFetch();
  const toaster = useToaster();
  const [collapseMenu, setCollapseMenu] = useCookie('collapseMenu', '0');
  const [selectedIntegrationId, setSelectedIntegrationId] = useState('');
  const [search, setSearch] = useState('');
  const [selectedBoardIds, setSelectedBoardIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const { data: integrationsData } = useSWR('integrations', async () =>
    (await fetch('/integrations/list')).json()
  );

  const pinterestIntegrations: IntegrationListItem[] = useMemo(
    () =>
      orderBy(
        (integrationsData?.integrations || []).filter(
          (i: IntegrationListItem) => i.identifier === 'pinterest'
        ),
        ['name'],
        ['asc']
      ),
    [integrationsData]
  );

  useEffect(() => {
    if (pinterestIntegrations.length === 0) {
      if (selectedIntegrationId) setSelectedIntegrationId('');
      return;
    }
    if (!pinterestIntegrations.some((i) => i.id === selectedIntegrationId)) {
      setSelectedIntegrationId(pinterestIntegrations[0].id);
    }
  }, [pinterestIntegrations, selectedIntegrationId]);

  useEffect(() => {
    setSelectedBoardIds([]);
    setSearch('');
  }, [selectedIntegrationId]);

  const { data: boardsData } = useSWR<PinterestBoardOption[]>(
    selectedIntegrationId ? `pinterest-boards-${selectedIntegrationId}` : null,
    async () => {
      const response = await fetch('/integrations/function', {
        method: 'POST',
        body: JSON.stringify({
          name: 'boards',
          id: selectedIntegrationId,
          data: { includeArchived: true },
        }),
      });
      return response.json();
    }
  );

  const { data: queueData, mutate: mutateQueue } = useSWR<
    PinterestBoardDeleteQueueSummary
  >(
    selectedIntegrationId
      ? `pinterest-board-delete-queue-${selectedIntegrationId}`
      : null,
    async () =>
      (
        await fetch(
          `/pinterest-board-delete/queue?integrationId=${selectedIntegrationId}`
        )
      ).json(),
    { refreshInterval: 7000 }
  );

  const pendingBoardIds = useMemo(
    () =>
      new Set(
        (queueData?.items || [])
          .filter((i) => i.status === 'PENDING')
          .map((i) => i.boardId)
      ),
    [queueData]
  );

  const filteredBoards = useMemo(
    () =>
      (boardsData || []).filter((b) =>
        b.name.toLowerCase().includes(search.toLowerCase())
      ),
    [boardsData, search]
  );

  const toggleBoard = useCallback((boardId: string, on: boolean) => {
    setSelectedBoardIds((prev) => {
      if (on) {
        if (prev.includes(boardId)) return prev;
        if (prev.length >= MAX_BOARDS_PER_SUBMISSION) {
          return prev;
        }
        return [...prev, boardId];
      }
      return prev.filter((id) => id !== boardId);
    });
  }, []);

  const onQueueForDeletion = useCallback(async () => {
    if (!selectedIntegrationId || selectedBoardIds.length === 0) {
      return;
    }
    const boards = selectedBoardIds
      .map((boardId) => {
        const board = (boardsData || []).find((b) => b.id === boardId);
        return board ? { boardId: board.id, boardName: board.name } : null;
      })
      .filter((b): b is { boardId: string; boardName: string } => !!b);

    setSubmitting(true);
    try {
      const response = await fetch('/pinterest-board-delete/batches', {
        method: 'POST',
        body: JSON.stringify({ integrationId: selectedIntegrationId, boards }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}) as any);
        toaster.show(body.message || 'Failed to queue boards for deletion', 'warning');
        return;
      }

      setSelectedBoardIds([]);
      toaster.show('Boards queued for deletion', 'success');
      mutateQueue();
    } finally {
      setSubmitting(false);
    }
  }, [selectedIntegrationId, selectedBoardIds, boardsData, fetch, toaster, mutateQueue]);

  return (
    <>
      <div
        className={clsx(
          'bg-newBgColorInner p-[20px] flex flex-col gap-[15px] transition-all',
          collapseMenu === '1' ? 'group sidebar w-[100px]' : 'w-[260px]'
        )}
      >
        <div className="flex gap-[12px] flex-col">
          <div className="flex items-center">
            <h2 className="group-[.sidebar]:hidden flex-1 text-[20px] font-[500]">
              Channels
            </h2>
            <div
              onClick={() => setCollapseMenu(collapseMenu === '1' ? '0' : '1')}
              className="group-[.sidebar]:rotate-[180deg] group-[.sidebar]:mx-auto text-btnText bg-btnSimple rounded-[6px] w-[24px] h-[24px] flex items-center justify-center cursor-pointer select-none"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="7"
                height="13"
                viewBox="0 0 7 13"
                fill="none"
              >
                <path
                  d="M6 11.5L1 6.5L6 1.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
          </div>

          {pinterestIntegrations.length === 0 && (
            <div className="group-[.sidebar]:hidden text-[12px] text-customColor18">
              No Pinterest accounts connected yet.
            </div>
          )}

          {pinterestIntegrations.map((integration) => (
            <div
              key={integration.id}
              onClick={() => {
                if (integration.refreshNeeded) {
                  toaster.show(
                    'Please refresh the integration from the calendar',
                    'warning'
                  );
                  return;
                }
                setSelectedIntegrationId(integration.id);
              }}
              className={clsx(
                'flex gap-[12px] items-center group/profile justify-center hover:bg-boxHover rounded-e-[8px]',
                selectedIntegrationId !== integration.id &&
                  'opacity-20 hover:opacity-100 cursor-pointer'
              )}
            >
              <div
                className={clsx(
                  'relative rounded-full flex justify-center items-center gap-[6px]',
                  integration.disabled && 'opacity-50'
                )}
              >
                {(integration.inBetweenSteps || integration.refreshNeeded) && (
                  <div className="absolute start-0 top-0 w-[39px] h-[46px] cursor-pointer">
                    <div className="bg-red-500 w-[15px] h-[15px] rounded-full start-0 -top-[5px] absolute z-[200] text-[10px] flex justify-center items-center">
                      !
                    </div>
                    <div className="bg-primary/60 w-[39px] h-[46px] start-0 top-0 absolute rounded-full z-[199]" />
                  </div>
                )}
                <div className="h-full w-[4px] -ms-[12px] rounded-s-[3px] opacity-0 group-hover/profile:opacity-100 transition-opacity">
                  <SVGLine />
                </div>
                <ImageWithFallback
                  fallbackSrc={`/icons/platforms/${integration.identifier}.png`}
                  src={integration.picture}
                  className="rounded-[8px]"
                  alt={integration.identifier}
                  width={36}
                  height={36}
                />
                <Image
                  src={`/icons/platforms/${integration.identifier}.png`}
                  className="rounded-[8px] absolute z-10 bottom-[5px] -end-[5px] border border-fifth"
                  alt={integration.identifier}
                  width={18.41}
                  height={18.41}
                />
              </div>
              <div
                className={clsx(
                  'flex-1 whitespace-nowrap text-ellipsis overflow-hidden group-[.sidebar]:hidden',
                  integration.disabled && 'opacity-50'
                )}
              >
                {integration.name}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-newBgColorInner flex-1 flex flex-col gap-4 p-6 text-textColor overflow-y-auto">
        <div className="text-xl font-semibold">Pinterest Board Deletion</div>

        {pinterestIntegrations.length === 0 && (
          <div>Connect a Pinterest account first to use this tool.</div>
        )}

        {pinterestIntegrations.length > 0 && !selectedIntegrationId && (
          <div>Select a Pinterest account from the channels on the left.</div>
        )}

        {selectedIntegrationId && (
          <>
            <div className="text-[12px] text-customColor18">
              Boards are deleted one at a time, every 300-320 minutes
              (randomized) per account — including archived boards.
              Submitting more boards adds them to this same ongoing queue.
              There is no retry for a failed deletion.
            </div>

            <div className="max-w-[320px]">
              <Input
                label="Search boards"
                name="boardSearch"
                disableForm={true}
                removeError={true}
                placeholder="Filter by board name"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            {!boardsData && <div>Loading boards…</div>}
            {boardsData && boardsData.length === 0 && (
              <div>No boards found on this account.</div>
            )}

            {boardsData && boardsData.length > 0 && (
              <div className="flex flex-col gap-[6px] max-h-[320px] overflow-y-auto border border-newTableBorder rounded p-2">
                {filteredBoards.map((board) => {
                  const alreadyQueued = pendingBoardIds.has(board.id);
                  const selected = selectedBoardIds.includes(board.id);
                  return (
                    <div
                      key={board.id}
                      className="flex items-center gap-3 px-1 py-1"
                    >
                      <Slider
                        value={selected ? 'on' : 'off'}
                        onChange={(v) => toggleBoard(board.id, v === 'on')}
                      />
                      <div
                        className={clsx(
                          'flex-1 truncate',
                          alreadyQueued && 'opacity-40'
                        )}
                        title={board.name}
                      >
                        {board.name}
                      </div>
                      {alreadyQueued && (
                        <div className="text-[12px] text-customColor18">
                          Already queued
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="flex items-center gap-3">
              <div>
                {selectedBoardIds.length}/{MAX_BOARDS_PER_SUBMISSION} selected
              </div>
              <Button
                disabled={submitting || selectedBoardIds.length === 0}
                loading={submitting}
                onClick={onQueueForDeletion}
              >
                Queue for deletion ({selectedBoardIds.length})
              </Button>
            </div>

            <div className="flex flex-col gap-2">
              <div className="text-lg font-semibold">Queue status</div>
              <div className="border border-newTableBorder bg-sixth rounded p-3 flex flex-col gap-1">
                <div>
                  Queued: {queueData?.queued ?? 0} · Done: {queueData?.done ?? 0} ·
                  Failed: {queueData?.failed.length ?? 0} · Total submitted:{' '}
                  {queueData?.totalEverSubmitted ?? 0}
                </div>
                <div className="text-[12px] text-customColor18">
                  Next deletion at:{' '}
                  {queueData?.nextRunAt
                    ? new Date(queueData.nextRunAt).toLocaleString()
                    : '—'}{' '}
                  · Last one completes:{' '}
                  {queueData?.lastCompletionAt
                    ? new Date(queueData.lastCompletionAt).toLocaleString()
                    : '—'}
                </div>
              </div>
            </div>

            {queueData && queueData.items.length > 0 && (
              <div className="flex flex-col gap-[8px]">
                <div className="grid grid-cols-[2fr,120px,1fr,2fr] gap-[10px] text-[12px] text-customColor18 px-1">
                  <div>Board name</div>
                  <div>Status</div>
                  <div>Scheduled / completed</div>
                  <div>Error</div>
                </div>
                {queueData.items.map((item) => (
                  <div
                    key={item.id}
                    className="grid grid-cols-[2fr,120px,1fr,2fr] gap-[10px] items-center border border-newTableBorder bg-sixth rounded p-2"
                  >
                    <div className="truncate" title={item.boardName}>
                      {item.boardName}
                    </div>
                    <div
                      className={clsx(
                        item.status === 'REMOVED' && 'text-green-400',
                        item.status === 'FAILED' && 'text-red-400',
                        item.status === 'PENDING' && 'text-customColor18'
                      )}
                    >
                      {item.status === 'REMOVED'
                        ? 'Deleted'
                        : item.status === 'FAILED'
                        ? 'Failed'
                        : 'Pending'}
                    </div>
                    <div className="text-[12px]">
                      {item.scheduledFor
                        ? new Date(item.scheduledFor).toLocaleString()
                        : '—'}
                    </div>
                    <div className="text-[12px] text-red-400 truncate" title={item.errorMessage || ''}>
                      {item.errorMessage || ''}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
};
```

- [ ] **Step 2: Create the page**

```tsx
import { PinterestBoardDeleteComponent } from '@gitroom/frontend/components/pinterest-board-delete/pinterest.board.delete.component';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'TheContentWarrior' : 'JDCO'} Pinterest Board Deletion`,
  description: '',
};

export default async function Page() {
  return <PinterestBoardDeleteComponent />;
}
```

- [ ] **Step 3: Add the sidebar menu entry**

In `top.menu.tsx`, immediately after the existing `pinterest_board_creation` entry (the one with `path: '/pinterest-boards'`), add:

```tsx
    {
      name: t('pinterest_board_deletion', 'Board Deletion'),
      icon: (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 20 20"
          fill="none"
        >
          <rect
            x="1"
            y="1"
            width="18"
            height="18"
            rx="3"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M6 10H14"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      ),
      path: '/pinterest-board-delete',
    },
```

(Same square icon as Board Creation, minus the vertical stroke, so it reads as "remove" rather than "add.")

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/components/pinterest-board-delete/ apps/frontend/src/app/\(app\)/\(site\)/pinterest-board-delete/ apps/frontend/src/components/layout/top.menu.tsx
git commit -m "feat: add Pinterest Board Deletion tab"
```

---

## Task 17: End-to-end verification checklist (manual, post-deploy)

This task has no code changes. It's the manual verification pass called for by the spec's Testing section, to run once Task 2's `pnpm run prisma-db-push` has been applied and the branch is deployed.

- [ ] Push the branch and confirm GitHub Actions CI is green (build + all Jest suites from Tasks 1, 8, 10) — do not merge on a red CI run.
- [ ] Run `pnpm run prisma-db-push` against the target database (the user runs this, per Global Constraints) and confirm the app starts cleanly afterward (no missing-column errors in backend/workers/cron logs).
- [ ] In the Pin Cleanup tab, submit 2-3 real pin IDs from a test Pinterest account. Confirm the summary shows `Queued: N`, a `Next deletion at` timestamp roughly 50-60 minutes out, and `Last one completes` roughly `N × 50-60min` out.
- [ ] In the new Board Deletion tab, select 2-3 boards from a test account — including at least one archived board — and confirm the archived board actually appears in the picker (this is the concrete proof `include_archived=true` is wired correctly) and that submitting shows all of them as `Pending` in the table with `Scheduled` timestamps roughly 300-320 minutes apart.
- [ ] Wait for (or manually trigger, if the environment allows shortening the delay for a test job) at least one real pin deletion and one real board deletion; confirm on Pinterest itself that the pin/board is actually gone, and that the item's status flips to `Deleted` in the respective UI on the next poll.
- [ ] Force one failure case (e.g. submit a pin ID that's already deleted, or a fabricated board ID) and confirm it shows up in the Pin Cleanup "Failed pins" list / Board Deletion table as `Failed` with a populated error message, and that it is not automatically retried.
- [ ] Confirm the existing post-composer Pinterest board dropdown (when composing a new pin) still behaves exactly as before — it should still exclude archived boards, proving Task 8's `includeArchived` change didn't leak into that call site.

---

## Plan self-review notes

- **Spec coverage:** every section of the design spec maps to a task — scheduling algorithm (Task 1), schema (Task 2), pin-delete repository/service/controller/cron (Tasks 3-6), MCP tool text (Task 7), provider changes (Task 8), board-delete DTO/repository/service/controller/worker (Tasks 9-13), shared purge cron (Task 14), both frontend tabs (Tasks 15-16), manual end-to-end pass (Task 17).
- **Placeholder scan:** no TBD/TODO/"add appropriate X" phrasing; every step has full code, not a description of code.
- **Type consistency:** `PinterestDeleteQueueSummary` (Task 3) matches the frontend interface of the same shape in Task 15; `PinterestBoardDeleteQueueSummary` (Task 10) matches Task 16's frontend interface, including the `items` array only present on the board side, per the spec's asymmetric reporting requirement. `excludeAlreadyPendingBoards` is defined and exported in Task 10 and imported by name in Task 11 — same name, same signature. Job event names (`'pinterest-delete-pin'`, `'pinterest-delete-board'`) match between each service's `emit()` call and its worker controller's `@EventPattern`.

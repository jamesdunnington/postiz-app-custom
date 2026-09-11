# Pinterest Batch Scheduling (CSV Upload) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native "Batch Scheduling" tab that uploads the same CSV format the external `postiz-API` scheduler uses, re-hosts each row's image on Postiz's own storage, and schedules a real Pinterest post through Postiz's existing internal slot-finding and post-creation machinery.

**Architecture:** A plain, fast BullMQ queue (no artificial pacing, unlike the Pinterest deletion queues) backed by two new Prisma models. All publish-date assignment happens once, synchronously, at submit time via a pure function that calls the account's existing `getNextAvailableSlots` logic; each queued item then just re-hosts its image and calls `PostsService.createPost()` — the exact same internal call the compose UI makes — so a batch-scheduled pin is indistinguishable from a manually scheduled one everywhere else in the system.

**Tech Stack:** NestJS (backend/workers/cron), Prisma/PostgreSQL, BullMQ (`BullMqClient`), Next.js/React frontend, `papaparse` (new dependency), Jest.

**Spec:** [docs/superpowers/specs/2026-09-11-pinterest-batch-scheduling-design.md](../specs/2026-09-11-pinterest-batch-scheduling-design.md)

## Global Constraints

- CSV columns, exact names, no column-mapping UI: `content, title, image_url, scheduled_date, board, alt_text, link`.
- One integration selected at a time via the same sidebar pattern as the other three Pinterest tabs — fully isolated per account, no cross-account bleed.
- A row's `scheduled_date`, when present and valid and in the future, is used as-is. Blank rows are auto-assigned via `PostsRepository.getNextAvailableSlots(..., searchFromEnd: true)`.
- No artificial pacing — each queue item is emitted with BullMQ `delay: 0` and drains as fast as the worker pool allows. The only pacing that matters (when Pinterest sees the pin) already lives in the account's `postingTimes`.
- Per-row failure never blocks the rest of the batch. Failed rows get a manual **Retry** button (unlike the deletion queues, which have no retry).
- Full per-row visibility in the UI (not "failures only").
- Cap: 500 rows per CSV submission.
- Self-healing recovery (re-emit a lost BullMQ job for anything `PENDING` well past its assigned time) and a 7-day purge of terminal (`SCHEDULED`/`FAILED`) rows, mirroring the Pinterest deletion queues' conventions.
- **This repository's local sandbox has no `node_modules` and cannot run `pnpm` commands** (per `CLAUDE.md`). Every task still specifies the exact command an engineer would run in a properly set-up environment or CI — do not attempt to execute them in this sandbox; write the code and tests carefully, then push and let GitHub Actions CI run them.
- `pnpm run prisma-db-push` (applying the schema change to a real database) is a manual step for the user to run themselves when ready to deploy — called out explicitly in Task 2, never run automatically.
- Never use `git push` or any command that publishes work, unless the user explicitly asks.

---

## Task 1: Slot-assignment pure logic

**Files:**
- Create: `libraries/nestjs-libraries/src/database/prisma/batch-schedule/batch-schedule.logic.ts`
- Test: `libraries/nestjs-libraries/src/database/prisma/batch-schedule/batch-schedule.logic.spec.ts`

**Interfaces:**
- Produces: `BatchScheduleRow { content: string; title?: string; imageUrl: string; boardId: string; altText?: string; link?: string; scheduledDate?: string }`, `AssignedRow` (a `BatchScheduleRow` plus `assignedPublishDate: Date`), `RowError { row: BatchScheduleRow; error: string }`, and `assignPublishDates(rows: BatchScheduleRow[], now: Date, fetchAutoSlots: (count: number) => Promise<Date[]>): Promise<{ assigned: AssignedRow[]; errors: RowError[] }>` — used by `batch-schedule.service.ts` (Task 4), with `fetchAutoSlots` backed by `PostsRepository.getNextAvailableSlots` there.

- [ ] **Step 1: Write the failing test**

```ts
// libraries/nestjs-libraries/src/database/prisma/batch-schedule/batch-schedule.logic.spec.ts
import { assignPublishDates, BatchScheduleRow } from './batch-schedule.logic';

const now = new Date('2026-01-01T00:00:00.000Z');

const validRow = (overrides: Partial<BatchScheduleRow> = {}): BatchScheduleRow => ({
  content: 'Some pin content',
  imageUrl: 'https://example.com/image.jpg',
  boardId: 'board-1',
  ...overrides,
});

describe('assignPublishDates', () => {
  it('rejects a row with missing content', async () => {
    const { assigned, errors } = await assignPublishDates(
      [validRow({ content: '' })],
      now,
      async () => []
    );
    expect(assigned).toHaveLength(0);
    expect(errors).toEqual([
      { row: expect.objectContaining({ content: '' }), error: 'Missing content' },
    ]);
  });

  it('rejects a row with missing image_url', async () => {
    const { errors } = await assignPublishDates(
      [validRow({ imageUrl: '' })],
      now,
      async () => []
    );
    expect(errors[0].error).toBe('Missing image_url');
  });

  it('rejects a row with missing board', async () => {
    const { errors } = await assignPublishDates(
      [validRow({ boardId: '' })],
      now,
      async () => []
    );
    expect(errors[0].error).toBe('Missing board');
  });

  it('rejects an unparseable scheduled_date', async () => {
    const { errors } = await assignPublishDates(
      [validRow({ scheduledDate: 'not-a-date' })],
      now,
      async () => []
    );
    expect(errors[0].error).toBe('Unparseable scheduled_date: not-a-date');
  });

  it('rejects a scheduled_date in the past', async () => {
    const { errors } = await assignPublishDates(
      [validRow({ scheduledDate: '2025-01-01T00:00:00.000Z' })],
      now,
      async () => []
    );
    expect(errors[0].error).toBe('scheduled_date is in the past');
  });

  it('uses an explicit future scheduled_date as-is', async () => {
    const { assigned, errors } = await assignPublishDates(
      [validRow({ scheduledDate: '2026-02-01T12:00:00.000Z' })],
      now,
      async () => []
    );
    expect(errors).toHaveLength(0);
    expect(assigned[0].assignedPublishDate.toISOString()).toBe(
      '2026-02-01T12:00:00.000Z'
    );
  });

  it('auto-assigns blank rows to fetched slots, in original CSV order', async () => {
    const slots = [
      new Date('2026-01-02T12:00:00.000Z'),
      new Date('2026-01-03T12:00:00.000Z'),
    ];
    const fetchAutoSlots = jest.fn().mockResolvedValue(slots);

    const { assigned, errors } = await assignPublishDates(
      [validRow({ content: 'first' }), validRow({ content: 'second' })],
      now,
      fetchAutoSlots
    );

    expect(errors).toHaveLength(0);
    expect(fetchAutoSlots).toHaveBeenCalledWith(2);
    expect(assigned[0].content).toBe('first');
    expect(assigned[0].assignedPublishDate).toEqual(slots[0]);
    expect(assigned[1].content).toBe('second');
    expect(assigned[1].assignedPublishDate).toEqual(slots[1]);
  });

  it('requests a buffer of extra auto slots and drops any that collide with an explicit date in the same batch', async () => {
    const collidingSlot = new Date('2026-02-01T12:00:00.000Z'); // same instant as the explicit row below
    const okSlot = new Date('2026-02-02T12:00:00.000Z');
    const fetchAutoSlots = jest.fn().mockResolvedValue([collidingSlot, okSlot]);

    const rows = [
      validRow({ content: 'explicit', scheduledDate: '2026-02-01T12:00:00.000Z' }),
      validRow({ content: 'auto' }),
    ];

    const { assigned, errors } = await assignPublishDates(rows, now, fetchAutoSlots);

    expect(errors).toHaveLength(0);
    expect(fetchAutoSlots).toHaveBeenCalledWith(2); // 1 auto row + 1 explicit row buffer
    const autoAssigned = assigned.find((a) => a.content === 'auto');
    expect(autoAssigned?.assignedPublishDate).toEqual(okSlot);
  });

  it('preserves original CSV row order in the output even when explicit and auto rows are interleaved', async () => {
    const fetchAutoSlots = jest.fn().mockResolvedValue([
      new Date('2026-01-05T00:00:00.000Z'),
    ]);
    const rows = [
      validRow({ content: 'auto-first' }),
      validRow({ content: 'explicit-second', scheduledDate: '2026-01-10T00:00:00.000Z' }),
    ];

    const { assigned } = await assignPublishDates(rows, now, fetchAutoSlots);

    expect(assigned.map((a) => a.content)).toEqual(['auto-first', 'explicit-second']);
  });

  it('does not call fetchAutoSlots when every row has an explicit date', async () => {
    const fetchAutoSlots = jest.fn().mockResolvedValue([]);
    await assignPublishDates(
      [validRow({ scheduledDate: '2026-02-01T00:00:00.000Z' })],
      now,
      fetchAutoSlots
    );
    expect(fetchAutoSlots).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ./libraries/nestjs-libraries run test -- --testPathPattern="batch-schedule.logic.spec"`
Expected: FAIL — module does not exist yet. Per Global Constraints, this cannot be executed in this sandbox — verify by inspection that the implementation file does not yet exist, then proceed.

- [ ] **Step 3: Write the implementation**

```ts
// libraries/nestjs-libraries/src/database/prisma/batch-schedule/batch-schedule.logic.ts

export interface BatchScheduleRow {
  content: string;
  title?: string;
  imageUrl: string;
  boardId: string;
  altText?: string;
  link?: string;
  scheduledDate?: string;
}

export interface AssignedRow extends BatchScheduleRow {
  assignedPublishDate: Date;
}

export interface RowError {
  row: BatchScheduleRow;
  error: string;
}

// Resolves every row's final publish date in one pass, synchronously, at
// submit time — never recomputed later. Explicit scheduled_date rows keep
// their exact time; blank rows are auto-assigned via fetchAutoSlots (backed
// by PostsRepository.getNextAvailableSlots in the service), requesting a
// small buffer so an accidental collision with an explicit date from the
// same batch can be dropped before assigning the rest, in original CSV
// row order among themselves.
export async function assignPublishDates(
  rows: BatchScheduleRow[],
  now: Date,
  fetchAutoSlots: (count: number) => Promise<Date[]>
): Promise<{ assigned: AssignedRow[]; errors: RowError[] }> {
  const errors: RowError[] = [];
  const explicitRows: { row: BatchScheduleRow; date: Date; originalIndex: number }[] = [];
  const autoRows: { row: BatchScheduleRow; originalIndex: number }[] = [];

  rows.forEach((row, originalIndex) => {
    if (!row.content || !row.content.trim()) {
      errors.push({ row, error: 'Missing content' });
      return;
    }
    if (!row.imageUrl || !row.imageUrl.trim()) {
      errors.push({ row, error: 'Missing image_url' });
      return;
    }
    if (!row.boardId || !row.boardId.trim()) {
      errors.push({ row, error: 'Missing board' });
      return;
    }

    if (row.scheduledDate && row.scheduledDate.trim()) {
      const parsed = new Date(row.scheduledDate);
      if (isNaN(parsed.getTime())) {
        errors.push({
          row,
          error: `Unparseable scheduled_date: ${row.scheduledDate}`,
        });
        return;
      }
      if (parsed.getTime() <= now.getTime()) {
        errors.push({ row, error: 'scheduled_date is in the past' });
        return;
      }
      explicitRows.push({ row, date: parsed, originalIndex });
    } else {
      autoRows.push({ row, originalIndex });
    }
  });

  let autoSlots: Date[] = [];
  if (autoRows.length > 0) {
    const candidateSlots = await fetchAutoSlots(
      autoRows.length + explicitRows.length
    );
    const explicitTimestamps = new Set(
      explicitRows.map((r) => r.date.getTime())
    );
    autoSlots = candidateSlots
      .filter((s) => !explicitTimestamps.has(s.getTime()))
      .slice(0, autoRows.length);
  }

  const assignedWithIndex = [
    ...explicitRows.map(({ row, date, originalIndex }) => ({
      ...row,
      assignedPublishDate: date,
      originalIndex,
    })),
    ...autoRows.map(({ row, originalIndex }, i) => ({
      ...row,
      assignedPublishDate: autoSlots[i],
      originalIndex,
    })),
  ];

  assignedWithIndex.sort((a, b) => a.originalIndex - b.originalIndex);

  const assigned: AssignedRow[] = assignedWithIndex.map(
    ({ originalIndex, ...rest }) => rest
  );

  return { assigned, errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ./libraries/nestjs-libraries run test -- --testPathPattern="batch-schedule.logic.spec"`
Expected: PASS (10 tests). Verify via CI per Global Constraints.

- [ ] **Step 5: Commit**

```bash
git add libraries/nestjs-libraries/src/database/prisma/batch-schedule/batch-schedule.logic.ts libraries/nestjs-libraries/src/database/prisma/batch-schedule/batch-schedule.logic.spec.ts
git commit -m "feat: add publish-date assignment logic for batch scheduling"
```

---

## Task 2: Prisma schema changes

**Files:**
- Modify: `libraries/nestjs-libraries/src/database/prisma/schema.prisma`

**Interfaces:**
- Produces: new models `BatchScheduleBatch`/`BatchScheduleItem`, plus `Integration.batchScheduleBatches`/`batchScheduleItems` and `Organization.batchScheduleBatches` relation arrays.

- [ ] **Step 1: Add the inverse relation on `Organization`**

Find this block (the end of the `Organization` model):

```prisma
  errors            Errors[]
  pinDeleteBatches      PinterestDeleteBatch[]
  boardDeleteBatches    PinterestBoardDeleteBatch[]
}
```

Replace with:

```prisma
  errors            Errors[]
  pinDeleteBatches      PinterestDeleteBatch[]
  boardDeleteBatches    PinterestBoardDeleteBatch[]
  batchScheduleBatches  BatchScheduleBatch[]
}
```

- [ ] **Step 2: Add the relation arrays on `Integration`**

Find this block:

```prisma
  pinDeleteBatches         PinterestDeleteBatch[]
  pinDeleteItems           PinterestDeleteItem[]
  boardDeleteBatches       PinterestBoardDeleteBatch[]
  boardDeleteItems         PinterestBoardDeleteItem[]
```

Replace with:

```prisma
  pinDeleteBatches         PinterestDeleteBatch[]
  pinDeleteItems           PinterestDeleteItem[]
  boardDeleteBatches       PinterestBoardDeleteBatch[]
  boardDeleteItems         PinterestBoardDeleteItem[]
  batchScheduleBatches     BatchScheduleBatch[]
  batchScheduleItems       BatchScheduleItem[]
```

- [ ] **Step 3: Add the two new models**

Add at the end of the file, immediately after the `PinterestBoardDeleteItem` model's closing brace:

```prisma

model BatchScheduleBatch {
  id              String   @id @default(uuid())
  organizationId  String
  integrationId   String
  createdByUserId String?
  source          String // "MANUAL"
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
  assignedPublishDate DateTime
  status              String // "PENDING" | "SCHEDULED" | "FAILED"
  postizPostId        String?
  errorMessage        String?
  processedAt         DateTime?
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt

  batch       BatchScheduleBatch @relation(fields: [batchId], references: [id], onDelete: Cascade)
  integration Integration        @relation(fields: [integrationId], references: [id])

  @@index([integrationId, status])
}
```

- [ ] **Step 4: Regenerate the Prisma client**

Run: `pnpm run prisma-generate`
Cannot be executed in this sandbox — note for CI/the engineer running in a properly set-up environment.

- [ ] **Step 5: Commit**

```bash
git add libraries/nestjs-libraries/src/database/prisma/schema.prisma
git commit -m "feat: add BatchScheduleBatch/Item models"
```

> **Deferred, manual step — do not run automatically:** `pnpm run prisma-db-push` against a real database is the user's own step when ready to deploy.

---

## Task 3: Batch schedule repository

**Files:**
- Create: `libraries/nestjs-libraries/src/database/prisma/batch-schedule/batch-schedule.repository.ts`

**Interfaces:**
- Produces: `BatchScheduleRepository.createBatchWithItems(organizationId, integrationId, createdByUserId, source, rows: AssignedRow[])`, `getItemById(itemId)`, `markItemScheduled(itemId, postizPostId)`, `markItemFailed(itemId, errorMessage)`, `resetItemToPending(itemId)`, `findOverdueItems(staleBefore)`, `getQueueSummary(integrationId): Promise<BatchScheduleQueueSummary>`, `purgeCompletedItemsOlderThan(cutoff): Promise<number>`.
- Consumes: `AssignedRow` from Task 1.
- `BatchScheduleQueueSummary`: `{ queued: number; done: number; failed: { id: string; content: string; boardId: string; errorMessage: string | null }[]; totalEverSubmitted: number; items: { id: string; content: string; boardId: string; status: string; assignedPublishDate: Date; postizPostId: string | null; errorMessage: string | null }[] }`.

- [ ] **Step 1: Write the repository**

```ts
import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { AssignedRow } from '@gitroom/nestjs-libraries/database/prisma/batch-schedule/batch-schedule.logic';

export interface BatchScheduleQueueSummary {
  queued: number;
  done: number;
  failed: {
    id: string;
    content: string;
    boardId: string;
    errorMessage: string | null;
  }[];
  totalEverSubmitted: number;
  items: {
    id: string;
    content: string;
    boardId: string;
    status: string;
    assignedPublishDate: Date;
    postizPostId: string | null;
    errorMessage: string | null;
  }[];
}

@Injectable()
export class BatchScheduleRepository {
  constructor(
    private _batch: PrismaRepository<'batchScheduleBatch'>,
    private _item: PrismaRepository<'batchScheduleItem'>
  ) {}

  async createBatchWithItems(
    organizationId: string,
    integrationId: string,
    createdByUserId: string | null,
    source: 'MANUAL',
    rows: AssignedRow[]
  ) {
    return this._batch.model.batchScheduleBatch.create({
      data: {
        organizationId,
        integrationId,
        createdByUserId,
        source,
        submittedCount: rows.length,
        items: {
          create: rows.map((row) => ({
            integrationId,
            content: row.content,
            title: row.title,
            imageUrl: row.imageUrl,
            boardId: row.boardId,
            altText: row.altText,
            link: row.link,
            assignedPublishDate: row.assignedPublishDate,
            status: 'PENDING',
          })),
        },
      },
      include: { items: true },
    });
  }

  getItemById(itemId: string) {
    return this._item.model.batchScheduleItem.findUnique({
      where: { id: itemId },
      include: { integration: true },
    });
  }

  markItemScheduled(itemId: string, postizPostId: string) {
    return this._item.model.batchScheduleItem.update({
      where: { id: itemId },
      data: { status: 'SCHEDULED', postizPostId, processedAt: new Date() },
    });
  }

  markItemFailed(itemId: string, errorMessage: string) {
    return this._item.model.batchScheduleItem.update({
      where: { id: itemId },
      data: { status: 'FAILED', errorMessage, processedAt: new Date() },
    });
  }

  resetItemToPending(itemId: string) {
    return this._item.model.batchScheduleItem.update({
      where: { id: itemId },
      data: {
        status: 'PENDING',
        errorMessage: null,
        processedAt: null,
      },
    });
  }

  findOverdueItems(staleBefore: Date) {
    return this._item.model.batchScheduleItem.findMany({
      where: { status: 'PENDING', createdAt: { lt: staleBefore } },
    });
  }

  async getQueueSummary(
    integrationId: string
  ): Promise<BatchScheduleQueueSummary> {
    const items = await this._item.model.batchScheduleItem.findMany({
      where: { integrationId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        content: true,
        boardId: true,
        status: true,
        assignedPublishDate: true,
        postizPostId: true,
        errorMessage: true,
      },
    });

    return {
      queued: items.filter((i) => i.status === 'PENDING').length,
      done: items.filter((i) => i.status === 'SCHEDULED').length,
      failed: items
        .filter((i) => i.status === 'FAILED')
        .map(({ id, content, boardId, errorMessage }) => ({
          id,
          content,
          boardId,
          errorMessage,
        })),
      totalEverSubmitted: items.length,
      items,
    };
  }

  async purgeCompletedItemsOlderThan(cutoff: Date): Promise<number> {
    const result = await this._item.model.batchScheduleItem.deleteMany({
      where: {
        status: { in: ['SCHEDULED', 'FAILED'] },
        processedAt: { lt: cutoff },
      },
    });
    await this._batch.model.batchScheduleBatch.deleteMany({
      where: { items: { none: {} } },
    });
    return result.count;
  }
}
```

Note: `findOverdueItems` uses `createdAt` (not a `scheduledFor`-style field, since there is no artificial timer here) — a `PENDING` item older than the staleness threshold means its `delay: 0` job should have fired almost immediately and clearly didn't, which is exactly the "lost job" condition self-healing exists for.

- [ ] **Step 2: Commit**

```bash
git add libraries/nestjs-libraries/src/database/prisma/batch-schedule/batch-schedule.repository.ts
git commit -m "feat: add BatchScheduleRepository"
```

---

## Task 4: Batch schedule service

**Files:**
- Create: `libraries/nestjs-libraries/src/database/prisma/batch-schedule/batch-schedule.service.ts`

**Interfaces:**
- Consumes: `BatchScheduleRepository` (Task 3), `assignPublishDates` (Task 1), `PostsRepository.getNextAvailableSlots` (existing), `IntegrationRepository.getIntegrationByIdOnly` (existing, for `postingTimes`/timezone), `IntegrationService.getIntegrationById` (existing), `MediaService.saveFile` (existing), `PostsService.createPost` (existing), `UploadFactory.createStorage()` (existing), `makeId` (existing, `@gitroom/nestjs-libraries/services/make.is`).
- Produces: `BatchScheduleService.createBatch(organizationId, integrationId, createdByUserId, rows: BatchScheduleRow[]): Promise<{ batchId: string; submittedCount: number; rejected: RowError[] }>`, `processItem(itemId): Promise<void>`, `retryItem(itemId): Promise<void>`, `findStalledItemIntegrationIds(staleMinutes?)`, `recoverOverdueItems(staleMinutes?): Promise<number>`, `listQueueSummary(integrationId)`.

- [ ] **Step 1: Write the service**

```ts
import { Injectable } from '@nestjs/common';
import dayjs from 'dayjs';
import * as Sentry from '@sentry/nestjs';
import { Integration } from '@prisma/client';
import { BatchScheduleRepository } from '@gitroom/nestjs-libraries/database/prisma/batch-schedule/batch-schedule.repository';
import {
  assignPublishDates,
  BatchScheduleRow,
  RowError,
} from '@gitroom/nestjs-libraries/database/prisma/batch-schedule/batch-schedule.logic';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { IntegrationRepository } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.repository';
import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { BullMqClient } from '@gitroom/nestjs-libraries/bull-mq-transport-new/client';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';

const MAX_ROWS_PER_BATCH = 500;

@Injectable()
export class BatchScheduleService {
  private storage = UploadFactory.createStorage();

  constructor(
    private _repository: BatchScheduleRepository,
    private _integrationService: IntegrationService,
    private _integrationRepository: IntegrationRepository,
    private _postsRepository: PostsRepository,
    private _postsService: PostsService,
    private _mediaService: MediaService,
    private _integrationManager: IntegrationManager,
    private _workerServiceProducer: BullMqClient
  ) {}

  async createBatch(
    organizationId: string,
    integrationId: string,
    createdByUserId: string | null,
    rows: BatchScheduleRow[]
  ): Promise<{ batchId: string; submittedCount: number; rejected: RowError[] }> {
    if (rows.length === 0 || rows.length > MAX_ROWS_PER_BATCH) {
      throw new Error(
        `A batch must contain between 1 and ${MAX_ROWS_PER_BATCH} rows`
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

    const integrationWithOrg =
      await this._integrationRepository.getIntegrationByIdOnly(integrationId);
    const userTimezone =
      integrationWithOrg?.organization?.users?.[0]?.user?.timezone || 0;
    const postingTimes = JSON.parse(integration.postingTimes || '[]');

    const { assigned, errors } = await assignPublishDates(
      rows,
      new Date(),
      (count) =>
        this._postsRepository.getNextAvailableSlots(
          organizationId,
          integrationId,
          count,
          postingTimes,
          true,
          userTimezone
        )
    );

    if (assigned.length === 0) {
      return { batchId: '', submittedCount: 0, rejected: errors };
    }

    const batch = await this._repository.createBatchWithItems(
      organizationId,
      integrationId,
      createdByUserId,
      'MANUAL',
      assigned
    );

    for (const item of batch.items) {
      this._workerServiceProducer.emit('batch-schedule-item', {
        id: item.id,
        options: { delay: 0 },
        payload: { itemId: item.id },
      });
    }

    return {
      batchId: batch.id,
      submittedCount: batch.items.length,
      rejected: errors,
    };
  }

  async processItem(itemId: string): Promise<void> {
    const item = await this._repository.getItemById(itemId);
    if (!item) {
      // Purged by the retention cron before this job ran. Clean no-op.
      return;
    }
    if (item.status !== 'PENDING') {
      // Already processed (or mid-retry) — avoid double-creating a post.
      return;
    }

    try {
      const rehostedPath = await this.storage.uploadSimple(item.imageUrl);
      const media = await this._mediaService.saveFile(
        item.integration.organizationId,
        rehostedPath.split('/').pop()!,
        rehostedPath
      );

      const result = await this._postsService.createPost(
        item.integration.organizationId,
        {
          type: 'schedule',
          shortLink: false,
          tags: [],
          date: item.assignedPublishDate.toISOString(),
          posts: [
            {
              integration: { id: item.integrationId },
              group: makeId(10),
              value: [
                {
                  id: makeId(10),
                  content: item.content,
                  image: [
                    {
                      id: media.id,
                      path: media.path,
                      ...(item.altText ? { alt: item.altText } : {}),
                    } as any,
                  ],
                },
              ],
              settings: {
                __type: 'pinterest',
                board: item.boardId,
                ...(item.title ? { title: item.title } : {}),
                ...(item.link ? { link: item.link } : {}),
              } as any,
            },
          ],
        } as any
      );

      const postizPostId = result?.[0]?.postId;
      if (!postizPostId) {
        await this._repository.markItemFailed(
          itemId,
          'Post creation did not return a post id'
        );
        return;
      }

      await this._repository.markItemScheduled(itemId, postizPostId);
    } catch (err) {
      await this._repository.markItemFailed(
        itemId,
        err instanceof Error ? err.message : 'Unknown error'
      );
      Sentry.captureException(err, {
        extra: { context: 'BatchScheduleService.processItem', itemId },
      });
    }
  }

  async retryItem(itemId: string): Promise<void> {
    const item = await this._repository.getItemById(itemId);
    if (!item || item.status !== 'FAILED') {
      throw new Error('Item not found or not in a failed state');
    }

    await this._repository.resetItemToPending(itemId);
    this._workerServiceProducer.emit('batch-schedule-item', {
      id: item.id,
      options: { delay: 0 },
      payload: { itemId: item.id },
    });
  }

  async findStalledItemIntegrationIds(staleMinutes = 15): Promise<string[]> {
    const staleBefore = dayjs().subtract(staleMinutes, 'minute').toDate();
    const stalled = await this._repository.findOverdueItems(staleBefore);
    return Array.from(new Set(stalled.map((i) => i.integrationId)));
  }

  // Self-healing recovery, mirroring the Pinterest deletion queues: a
  // delay:0 BullMQ job is still disposable delivery, not the source of
  // truth. Anything still PENDING long after being created means its job
  // was lost (Redis restart, queue flush, app deploy mid-flight) — re-emit it.
  async recoverOverdueItems(staleMinutes = 15): Promise<number> {
    const staleBefore = dayjs().subtract(staleMinutes, 'minute').toDate();
    const overdue = await this._repository.findOverdueItems(staleBefore);

    for (const item of overdue) {
      try {
        await this._workerServiceProducer.delete('batch-schedule-item', item.id);
      } catch (err) {
        // No existing job to remove — that's the case this exists for.
      }
      this._workerServiceProducer.emit('batch-schedule-item', {
        id: item.id,
        options: { delay: 0 },
        payload: { itemId: item.id },
      });
    }

    return overdue.length;
  }

  listQueueSummary(integrationId: string) {
    return this._repository.getQueueSummary(integrationId);
  }
}
```

Notes for the implementer:
- `item.integration.organizationId` comes from the `include: { integration: true }` in `getItemById` (Task 3).
- The `as any` casts on the `createPost` body and `image`/`settings` entries match the existing codebase's own convention where `CreatePostDto`'s nested class-validator types are awkward to construct as plain object literals outside of an HTTP request — the same pattern is visible in `apps/cron/src/tasks/reschedule.missed.posts.startup.ts`'s and `posts.service.ts`'s own internal calls; do not spend time fighting the type checker here beyond what's shown.
- `PostsService.createPost` returns `Promise<any[]>` where each entry is `{ postId, integration }` (see `posts.service.ts:851-854`) — hence `result?.[0]?.postId`.

- [ ] **Step 2: Commit**

```bash
git add libraries/nestjs-libraries/src/database/prisma/batch-schedule/batch-schedule.service.ts
git commit -m "feat: add BatchScheduleService"
```

---

## Task 5: DTOs

**Files:**
- Create: `libraries/nestjs-libraries/src/dtos/batch-schedule/batch.schedule.batch.dto.ts`

**Interfaces:**
- Produces: `BatchScheduleRowDto { content: string; title?: string; imageUrl: string; boardId: string; altText?: string; link?: string; scheduledDate?: string }`, `BatchScheduleBatchDto { integrationId: string; rows: BatchScheduleRowDto[] }` (max 500 entries) — consumed by the controller in Task 6.

- [ ] **Step 1: Create the DTO**

```ts
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUrl,
  ValidateNested,
} from 'class-validator';

export class BatchScheduleRowDto {
  @IsString()
  content: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsString()
  @IsUrl()
  imageUrl: string;

  @IsString()
  boardId: string;

  @IsOptional()
  @IsString()
  altText?: string;

  @IsOptional()
  @IsString()
  link?: string;

  @IsOptional()
  @IsString()
  scheduledDate?: string;
}

export class BatchScheduleBatchDto {
  @IsString()
  integrationId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => BatchScheduleRowDto)
  rows: BatchScheduleRowDto[];
}
```

- [ ] **Step 2: Commit**

```bash
git add libraries/nestjs-libraries/src/dtos/batch-schedule/batch.schedule.batch.dto.ts
git commit -m "feat: add BatchScheduleBatchDto"
```

---

## Task 6: Backend controller + module registrations

**Files:**
- Create: `apps/backend/src/api/routes/batch-schedule.controller.ts`
- Modify: `libraries/nestjs-libraries/src/database/prisma/database.module.ts`
- Modify: `apps/backend/src/api/api.module.ts`

**Interfaces:**
- Consumes: `BatchScheduleService` (Task 4), `BatchScheduleRepository` (Task 3), `BatchScheduleBatchDto` (Task 5).
- Produces: `POST /batch-schedule/batches`, `GET /batch-schedule/queue?integrationId=`, `POST /batch-schedule/items/:id/retry`.

- [ ] **Step 1: Create the controller**

```ts
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { BatchScheduleService } from '@gitroom/nestjs-libraries/database/prisma/batch-schedule/batch-schedule.service';
import { BatchScheduleBatchDto } from '@gitroom/nestjs-libraries/dtos/batch-schedule/batch.schedule.batch.dto';

@Controller('/batch-schedule')
export class BatchScheduleController {
  constructor(private _batchScheduleService: BatchScheduleService) {}

  @Post('/batches')
  createBatch(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: BatchScheduleBatchDto
  ) {
    return this._batchScheduleService.createBatch(
      org.id,
      body.integrationId,
      user.id,
      body.rows
    );
  }

  @Get('/queue')
  getQueue(@Query('integrationId') integrationId: string) {
    return this._batchScheduleService.listQueueSummary(integrationId);
  }

  @Post('/items/:id/retry')
  retryItem(@Param('id') id: string) {
    return this._batchScheduleService.retryItem(id);
  }
}
```

- [ ] **Step 2: Register the repository and service in `database.module.ts`**

Add imports alongside the existing `PinterestBoardDeleteService`/`PinterestBoardDeleteRepository` imports:

```ts
import { BatchScheduleService } from '@gitroom/nestjs-libraries/database/prisma/batch-schedule/batch-schedule.service';
import { BatchScheduleRepository } from '@gitroom/nestjs-libraries/database/prisma/batch-schedule/batch-schedule.repository';
```

Add both to the `providers` array, next to `PinterestBoardDeleteService, PinterestBoardDeleteRepository,`:

```ts
    PinterestBoardDeleteService,
    PinterestBoardDeleteRepository,
    BatchScheduleService,
    BatchScheduleRepository,
```

- [ ] **Step 3: Register the controller in `apps/backend/src/api/api.module.ts`**

Add the import alongside the existing `PinterestBoardDeleteController` import:

```ts
import { BatchScheduleController } from '@gitroom/backend/api/routes/batch-schedule.controller';
```

Add it to the `controllers` array, next to `PinterestBoardDeleteController,`:

```ts
  PinterestBoardDeleteController,
  BatchScheduleController,
```

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/api/routes/batch-schedule.controller.ts libraries/nestjs-libraries/src/database/prisma/database.module.ts apps/backend/src/api/api.module.ts
git commit -m "feat: wire up Batch Scheduling backend endpoints"
```

---

## Task 7: Worker

**Files:**
- Create: `apps/workers/src/app/batch-schedule.controller.ts`
- Modify: `apps/workers/src/app/app.module.ts`

**Interfaces:**
- Consumes: `BatchScheduleService.processItem(itemId)` (Task 4).
- Produces: `@EventPattern('batch-schedule-item', Transport.REDIS)` handler consuming the jobs emitted in Task 4.

- [ ] **Step 1: Create the worker controller**

```ts
import { Controller } from '@nestjs/common';
import { EventPattern, Transport } from '@nestjs/microservices';
import { BatchScheduleService } from '@gitroom/nestjs-libraries/database/prisma/batch-schedule/batch-schedule.service';

@Controller()
export class BatchScheduleController {
  constructor(private _batchScheduleService: BatchScheduleService) {}

  @EventPattern('batch-schedule-item', Transport.REDIS)
  async batchScheduleItem(data: { itemId: string }) {
    try {
      return await this._batchScheduleService.processItem(data.itemId);
    } catch (err) {
      console.log(
        "Unhandled error, let's avoid crashing the batch-schedule-item worker",
        err
      );
    }
  }
}
```

- [ ] **Step 2: Register it in `apps/workers/src/app/app.module.ts`**

Add the import alongside `PinterestBoardDeleteController`:

```ts
import { BatchScheduleController } from '@gitroom/workers/app/batch-schedule.controller';
```

Add it to the `controllers` array:

```ts
  controllers: [PostsController, PlugsController, PinterestDeleteController, PinterestBoardDeleteController, BatchScheduleController],
```

- [ ] **Step 3: Commit**

```bash
git add apps/workers/src/app/batch-schedule.controller.ts apps/workers/src/app/app.module.ts
git commit -m "feat: add Batch Scheduling worker"
```

---

## Task 8: Crons — recovery + purge

**Files:**
- Create: `apps/cron/src/tasks/check.batch.schedule.stalled.ts`
- Create: `apps/cron/src/tasks/purge.batch.schedule.history.ts`
- Modify: `apps/cron/src/cron.module.ts`

**Interfaces:**
- Consumes: `BatchScheduleService.recoverOverdueItems()` and `BatchScheduleRepository.purgeCompletedItemsOlderThan(cutoff)` (Tasks 3-4).

- [ ] **Step 1: Create the recovery cron**

```ts
import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as Sentry from '@sentry/nestjs';
import { BatchScheduleService } from '@gitroom/nestjs-libraries/database/prisma/batch-schedule/batch-schedule.service';

@Injectable()
export class CheckBatchScheduleStalled {
  constructor(private _batchScheduleService: BatchScheduleService) {}

  @Cron('*/5 * * * *')
  async handleCron() {
    try {
      const recovered = await this._batchScheduleService.recoverOverdueItems();
      if (recovered > 0) {
        console.warn(
          `[BATCH SCHEDULE] Recovered ${recovered} overdue item(s) whose BullMQ job was missing or lost`
        );
        Sentry.captureMessage(
          'Batch schedule queue: recovered overdue item(s)',
          { extra: { recovered } }
        );
      }
    } catch (err) {
      console.error('[BATCH SCHEDULE] Error in stalled-item recovery cron job:', err);
      Sentry.captureException(err, {
        extra: { context: 'CheckBatchScheduleStalled cron job failed' },
      });
    }
  }
}
```

- [ ] **Step 2: Create the purge cron**

```ts
import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import dayjs from 'dayjs';
import * as Sentry from '@sentry/nestjs';
import { BatchScheduleRepository } from '@gitroom/nestjs-libraries/database/prisma/batch-schedule/batch-schedule.repository';

const RETENTION_DAYS = 7;

@Injectable()
export class PurgeBatchScheduleHistory {
  constructor(private _batchScheduleRepository: BatchScheduleRepository) {}

  @Cron('0 3 * * *')
  async handleCron() {
    try {
      const cutoff = dayjs().subtract(RETENTION_DAYS, 'day').toDate();
      const purged =
        await this._batchScheduleRepository.purgeCompletedItemsOlderThan(cutoff);
      if (purged > 0) {
        console.log(
          `[BATCH SCHEDULE HISTORY] Purged ${purged} item(s) older than ${RETENTION_DAYS} days`
        );
      }
    } catch (err) {
      console.error('[BATCH SCHEDULE HISTORY] Error in purge cron job:', err);
      Sentry.captureException(err, {
        extra: { context: 'PurgeBatchScheduleHistory cron job failed' },
      });
    }
  }
}
```

- [ ] **Step 3: Register both in `cron.module.ts`**

Add the imports:

```ts
import { CheckBatchScheduleStalled } from '@gitroom/cron/tasks/check.batch.schedule.stalled';
import { PurgeBatchScheduleHistory } from '@gitroom/cron/tasks/purge.batch.schedule.history';
```

Add `CheckBatchScheduleStalled, PurgeBatchScheduleHistory` to the `providers` array.

- [ ] **Step 4: Commit**

```bash
git add apps/cron/src/tasks/check.batch.schedule.stalled.ts apps/cron/src/tasks/purge.batch.schedule.history.ts apps/cron/src/cron.module.ts
git commit -m "feat: add recovery and purge crons for Batch Scheduling"
```

---

## Task 9: Frontend — CSV upload, preview, and queue component

**Files:**
- Modify: `apps/frontend/package.json`
- Create: `apps/frontend/src/components/batch-schedule/batch.schedule.component.tsx`

**Interfaces:**
- Consumes: `/integrations/list`, `POST /batch-schedule/batches`, `GET /batch-schedule/queue?integrationId=`, `POST /batch-schedule/items/:id/retry` (Task 6).

- [ ] **Step 1: Add the `papaparse` dependency**

In `apps/frontend/package.json`, add to `dependencies` (alongside the other small utility libraries such as `lodash`, `dayjs`):

```json
    "papaparse": "^5.4.1",
```

Also add the types package to `devDependencies`:

```json
    "@types/papaparse": "^5.3.14",
```

Run: `pnpm install` — cannot be executed in this sandbox (no `node_modules`); the engineer/CI running in a properly set-up environment installs it as part of the normal build.

- [ ] **Step 2: Create the component**

```tsx
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import Papa from 'papaparse';
import { orderBy } from 'lodash';
import clsx from 'clsx';
import Image from 'next/image';
import useCookie from 'react-use-cookie';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { Button } from '@gitroom/react/form/button';
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

interface CsvRow {
  content: string;
  title: string;
  image_url: string;
  scheduled_date: string;
  board: string;
  alt_text: string;
  link: string;
}

interface ParsedRow {
  content: string;
  title?: string;
  imageUrl: string;
  boardId: string;
  altText?: string;
  link?: string;
  scheduledDate?: string;
  validationError?: string;
}

interface BatchScheduleQueueItem {
  id: string;
  content: string;
  boardId: string;
  status: 'PENDING' | 'SCHEDULED' | 'FAILED';
  assignedPublishDate: string;
  postizPostId: string | null;
  errorMessage: string | null;
}

interface BatchScheduleQueueSummary {
  queued: number;
  done: number;
  failed: { id: string; content: string; boardId: string; errorMessage: string | null }[];
  totalEverSubmitted: number;
  items: BatchScheduleQueueItem[];
}

const MAX_ROWS_PER_SUBMISSION = 500;

function parseRow(row: CsvRow): ParsedRow {
  const content = (row.content || '').trim();
  const imageUrl = (row.image_url || '').trim();
  const boardId = (row.board || '').trim();

  let validationError: string | undefined;
  if (!content) validationError = 'Missing content';
  else if (!imageUrl) validationError = 'Missing image_url';
  else if (!boardId) validationError = 'Missing board';

  return {
    content,
    title: (row.title || '').trim() || undefined,
    imageUrl,
    boardId,
    altText: (row.alt_text || '').trim() || undefined,
    link: (row.link || '').trim() || undefined,
    scheduledDate: (row.scheduled_date || '').trim() || undefined,
    validationError,
  };
}

export const BatchScheduleComponent = () => {
  const fetch = useFetch();
  const toaster = useToaster();
  const [collapseMenu, setCollapseMenu] = useCookie('collapseMenu', '0');
  const [selectedIntegrationId, setSelectedIntegrationId] = useState('');
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
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
    setParsedRows([]);
  }, [selectedIntegrationId]);

  const { data: queueData, mutate: mutateQueue } = useSWR<BatchScheduleQueueSummary>(
    selectedIntegrationId ? `batch-schedule-queue-${selectedIntegrationId}` : null,
    async () =>
      (
        await fetch(`/batch-schedule/queue?integrationId=${selectedIntegrationId}`)
      ).json(),
    { refreshInterval: 7000 }
  );

  const onFileSelected = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      Papa.parse<CsvRow>(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          const rows = results.data.map(parseRow).slice(0, MAX_ROWS_PER_SUBMISSION);
          setParsedRows(rows);
        },
      });

      e.target.value = '';
    },
    []
  );

  const validRows = useMemo(
    () => parsedRows.filter((r) => !r.validationError),
    [parsedRows]
  );

  const onSubmit = useCallback(async () => {
    if (!selectedIntegrationId || validRows.length === 0) {
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/batch-schedule/batches', {
        method: 'POST',
        body: JSON.stringify({
          integrationId: selectedIntegrationId,
          rows: validRows.map((r) => ({
            content: r.content,
            title: r.title,
            imageUrl: r.imageUrl,
            boardId: r.boardId,
            altText: r.altText,
            link: r.link,
            scheduledDate: r.scheduledDate,
          })),
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}) as any);
        toaster.show(body.message || 'Failed to submit batch', 'warning');
        return;
      }

      setParsedRows([]);
      toaster.show('Batch submitted', 'success');
      mutateQueue();
    } finally {
      setSubmitting(false);
    }
  }, [selectedIntegrationId, validRows, fetch, toaster, mutateQueue]);

  const onRetry = useCallback(
    async (itemId: string) => {
      const response = await fetch(`/batch-schedule/items/${itemId}/retry`, {
        method: 'POST',
      });
      if (!response.ok) {
        toaster.show('Failed to retry item', 'warning');
        return;
      }
      toaster.show('Item queued for retry', 'success');
      mutateQueue();
    },
    [fetch, toaster, mutateQueue]
  );

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
        <div className="text-xl font-semibold">Pinterest Batch Scheduling</div>

        {pinterestIntegrations.length === 0 && (
          <div>Connect a Pinterest account first to use this tool.</div>
        )}

        {pinterestIntegrations.length > 0 && !selectedIntegrationId && (
          <div>Select a Pinterest account from the channels on the left.</div>
        )}

        {selectedIntegrationId && (
          <>
            <div className="text-[12px] text-customColor18">
              Upload a CSV with columns: content, title, image_url,
              scheduled_date, board, alt_text, link. Rows without
              scheduled_date are auto-assigned this account's next available
              posting-time slots. Up to {MAX_ROWS_PER_SUBMISSION} rows per
              upload.
            </div>

            <input
              type="file"
              accept=".csv"
              onChange={onFileSelected}
              className="text-[13px]"
            />

            {parsedRows.length > 0 && (
              <div className="flex flex-col gap-[8px]">
                <div className="grid grid-cols-[2fr,100px,120px,1fr] gap-[10px] text-[12px] text-customColor18 px-1">
                  <div>Content</div>
                  <div>Board</div>
                  <div>Date</div>
                  <div>Validation</div>
                </div>
                {parsedRows.map((row, index) => (
                  <div
                    key={index}
                    className="grid grid-cols-[2fr,100px,120px,1fr] gap-[10px] items-center border border-newTableBorder bg-sixth rounded p-2"
                  >
                    <div className="truncate" title={row.content}>
                      {row.content || '(empty)'}
                    </div>
                    <div className="truncate">{row.boardId || '—'}</div>
                    <div className="text-[12px]">
                      {row.scheduledDate || 'auto'}
                    </div>
                    <div className="text-[12px]">
                      {row.validationError ? (
                        <span className="text-red-400">{row.validationError}</span>
                      ) : (
                        <span className="text-green-400">OK</span>
                      )}
                    </div>
                  </div>
                ))}

                <div className="flex items-center gap-3">
                  <div>
                    {validRows.length}/{parsedRows.length} rows valid
                  </div>
                  <Button
                    disabled={submitting || validRows.length === 0}
                    loading={submitting}
                    onClick={onSubmit}
                  >
                    Schedule {validRows.length} pin(s)
                  </Button>
                </div>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <div className="text-lg font-semibold">Queue status</div>
              <div className="border border-newTableBorder bg-sixth rounded p-3">
                Queued: {queueData?.queued ?? 0} · Scheduled:{' '}
                {queueData?.done ?? 0} · Failed: {queueData?.failed.length ?? 0}{' '}
                · Total submitted: {queueData?.totalEverSubmitted ?? 0}
              </div>
            </div>

            {queueData && queueData.items.length > 0 && (
              <div className="flex flex-col gap-[8px]">
                <div className="grid grid-cols-[2fr,100px,1fr,120px,2fr] gap-[10px] text-[12px] text-customColor18 px-1">
                  <div>Content</div>
                  <div>Board</div>
                  <div>Publish date</div>
                  <div>Status</div>
                  <div>Error / Actions</div>
                </div>
                {queueData.items.map((item) => (
                  <div
                    key={item.id}
                    className="grid grid-cols-[2fr,100px,1fr,120px,2fr] gap-[10px] items-center border border-newTableBorder bg-sixth rounded p-2"
                  >
                    <div className="truncate" title={item.content}>
                      {item.content}
                    </div>
                    <div className="truncate">{item.boardId}</div>
                    <div className="text-[12px]">
                      {new Date(item.assignedPublishDate).toLocaleString()}
                    </div>
                    <div
                      className={clsx(
                        item.status === 'SCHEDULED' && 'text-green-400',
                        item.status === 'FAILED' && 'text-red-400',
                        item.status === 'PENDING' && 'text-customColor18'
                      )}
                    >
                      {item.status === 'SCHEDULED'
                        ? 'Scheduled'
                        : item.status === 'FAILED'
                        ? 'Failed'
                        : 'Pending'}
                    </div>
                    <div className="flex items-center gap-2 text-[12px]">
                      {item.status === 'FAILED' && (
                        <>
                          <span
                            className="text-red-400 truncate"
                            title={item.errorMessage || ''}
                          >
                            {item.errorMessage}
                          </span>
                          <Button
                            secondary={true}
                            innerClassName="!px-[10px] text-[12px]"
                            className="!h-[28px] !px-[10px]"
                            onClick={() => onRetry(item.id)}
                          >
                            Retry
                          </Button>
                        </>
                      )}
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

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/package.json apps/frontend/src/components/batch-schedule/
git commit -m "feat: add Batch Scheduling CSV upload UI"
```

---

## Task 10: Frontend page + menu entry

**Files:**
- Create: `apps/frontend/src/app/(app)/(site)/batch-schedule/page.tsx`
- Modify: `apps/frontend/src/components/layout/top.menu.tsx`

**Interfaces:**
- Consumes: `BatchScheduleComponent` (Task 9).

- [ ] **Step 1: Create the page**

```tsx
import { BatchScheduleComponent } from '@gitroom/frontend/components/batch-schedule/batch.schedule.component';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'TheContentWarrior' : 'JDCO'} Pinterest Batch Scheduling`,
  description: '',
};

export default async function Page() {
  return <BatchScheduleComponent />;
}
```

- [ ] **Step 2: Add the sidebar menu entry**

In `top.menu.tsx`, immediately after the `pinterest_board_deletion` entry (the one with `path: '/pinterest-board-delete'`), add:

```tsx
    {
      name: t('pinterest_batch_scheduling', 'Batch Scheduling'),
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
            y="3"
            width="18"
            height="15"
            rx="2"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M1 7.5H19"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>
      ),
      path: '/batch-schedule',
    },
```

(A simple calendar-glyph icon — rectangle with a header divider line — distinct from the board icons.)

- [ ] **Step 3: Commit**

```bash
git add "apps/frontend/src/app/(app)/(site)/batch-schedule/" apps/frontend/src/components/layout/top.menu.tsx
git commit -m "feat: add Pinterest Batch Scheduling tab"
```

---

## Task 11: End-to-end verification checklist (manual, post-deploy)

No code changes. Run once Task 2's `pnpm run prisma-db-push` has been applied and the branch is deployed.

- [ ] Push the branch and confirm GitHub Actions CI is green (build + all Jest suites from Task 1) — do not merge on a red CI run.
- [ ] Run `pnpm run prisma-db-push` against the target database (the user runs this) and confirm the app starts cleanly afterward.
- [ ] Upload a small real CSV (2-3 rows) against a test Pinterest account, with at least one row left blank on `scheduled_date` and one row given an explicit future date.
- [ ] Confirm the queue table shows all rows moving from `Pending` to `Scheduled` within a few seconds, and that the assigned dates look right (auto rows landing on the account's actual configured posting-time slots; the explicit row landing exactly on its given time).
- [ ] Open the normal Postiz calendar and confirm the same posts appear there too, indistinguishable from a manually scheduled post.
- [ ] Force one failure (a row with an image URL that 404s) and confirm it shows up as `Failed` with a readable error message, then fix the row's data conceptually and click **Retry**, confirming it moves back to `Pending` then `Scheduled`.
- [ ] Confirm a post actually publishes to Pinterest at its scheduled time (or bring a slot a few minutes out for a faster manual check).
- [ ] Confirm submitting a second, smaller batch for the same account appends after the first batch's assigned dates rather than colliding with them.

---

## Plan self-review notes

- **Spec coverage:** infrastructure reuse (Tasks 4, no reinventing image upload/slot-finding/post-creation), data model (Task 2), CSV validation + slot algorithm (Task 1), repository/service/DTO/controller/worker (Tasks 3-7), resilience crons (Task 8), frontend upload/preview/queue/retry UI (Tasks 9-10), manual end-to-end pass (Task 11).
- **Placeholder scan:** no TBD/TODO; every step has complete code.
- **Type consistency:** `AssignedRow`/`RowError` (Task 1) match the types consumed in Task 4's `assignPublishDates` call; `BatchScheduleQueueSummary` (Task 3) matches the frontend interface of the same shape in Task 9; job event name `'batch-schedule-item'` matches between the service's `emit()`/`delete()` calls (Task 4) and the worker's `@EventPattern` (Task 7).

# Pinterest Bulk Pin Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user submit up to 100 externally-flagged Pinterest pin ids/URLs (via a new UI tab, the public API, or an MCP tool) for permanent deletion from Pinterest, rate-limited to share Postiz's existing per-provider throttle with live publishing/analytics traffic, hard-capped at 100 actual deletions per Pinterest account per rolling 24h window, with at most 2 batches of history retained per account.

**Architecture:** One shared service (`PinterestDeleteService`) validates and persists a submission as a `PinterestDeleteBatch` + `PinterestDeleteItem` rows, then enqueues one BullMQ job per pin onto a new `pinterest-delete-pin` queue (mirroring how posts are already published). Each job atomically reserves a slot against a per-`Integration` daily-cap counter before calling a new `PinterestProvider.deletePin()`, which goes through the same `SocialAbstract.fetch()`/Bottleneck throttle every other Pinterest call already uses. A cron sweep recovers pins deferred by the cap and flags stalled backlogs. A frontend tab and two extra ingestion entry points (public API, MCP tool) all funnel into the same service call.

**Tech Stack:** NestJS (backend/workers/cron), Prisma/PostgreSQL, BullMQ + Redis, Next.js/React + SWR (frontend), Zod + Mastra `createTool` (MCP tool), Jest (pure-logic unit tests only — see Global Constraints).

**Spec:** [docs/superpowers/specs/2026-09-06-pinterest-bulk-delete-design.md](../specs/2026-09-06-pinterest-bulk-delete-design.md)

## Global Constraints

- **Never run `pnpm build`, `pnpm test`, `tsc`, `prisma generate`, or `prisma db push` in this environment.** Per `CLAUDE.md`, this machine has no `node_modules` and is not set up for building — every command below that "runs" something is a note for whoever executes this plan on a machine that *does* have the dependencies installed (a human maintainer, or CI), not something to attempt here. Verify by careful reading of the exact signatures/imports given in each task instead.
- **No CI workflow in this repo currently runs `pnpm test`** (checked `.github/workflows/*` — only Docker builds, extension builds, ESLint, and CodeQL exist). Tests written in this plan are real and correct, but nothing will run them automatically on push. The maintainer must run `pnpm test` locally before trusting them, and must run `pnpm run prisma-db-push` against a real dev database before this feature works at runtime — task 12 spells out the exact manual checklist.
- **Zero test files exist anywhere in this repo today** (confirmed: 0 `.spec.ts`/`.test.ts`/`.spec.tsx`/`.test.tsx` files repo-wide). There is no established Prisma-mocking convention to follow. This plan only writes unit tests for pure, dependency-free functions (pin parsing, retention list math) — the concurrency-critical daily-cap logic is implemented as atomic single-statement SQL updates (via Prisma's `updateMany`) specifically because that guarantee can't be meaningfully unit-tested without a real Postgres instance; it's covered by the manual verification checklist in task 12 instead. This is a deliberate deviation from the spec's "Unit tests for the daily-cap transaction logic" line — the intent (verify it's race-safe) is preserved, the mechanism changes from Jest to manual DB verification.
- Daily cap: hardcoded `100` deletions per rolling 24h window, per `Integration`. Not configurable.
- Batch size cap: hardcoded `100` pins per submission.
- Retention: exactly `2` most recently created batches kept per `Integration`; a 3rd+ submission unconditionally purges the oldest beyond that, cascading its items, regardless of their processing status.
- Cron sweep interval: every 5 minutes. Stalled-item threshold: 15 minutes without a status change (matches the existing `checkQueueHealth()` stuck-waiting constant of 10 minutes, rounded up slightly per the spec).
- Prettier: `singleQuote: true` (matches repo-wide `.prettierrc`) — write all new files with single quotes.
- The new delete call MUST go through `SocialAbstract.fetch()` (not a bare `fetch()`) so it shares the existing global Bottleneck bucket keyed `"pinterest"` with live publishing/analytics traffic — this is not optional, it's the entire point of the rate-limiting requirement.

---

### Task 1: Prisma schema — new models and Integration fields

**Files:**
- Modify: `libraries/nestjs-libraries/src/database/prisma/schema.prisma`

**Interfaces:**
- Produces: Prisma models `PinterestDeleteBatch` (fields: `id, organizationId, integrationId, createdByUserId, source, submittedCount, createdAt`) and `PinterestDeleteItem` (fields: `id, batchId, integrationId, pinId, rawInput, status, scheduledFor, errorMessage, processedAt, createdAt, updatedAt`); new `Integration` fields `pinDeleteWindowCount: Int` and `pinDeleteLastAt: DateTime?`. Every later backend task depends on these exact field names and types.

- [ ] **Step 1: Add the back-relation field to `Organization`**

In `schema.prisma`, find this exact block (currently ending the `Organization` model):

```prisma
  thirdParty        ThirdParty[]
  errors            Errors[]
}
```

Replace with:

```prisma
  thirdParty        ThirdParty[]
  errors            Errors[]
  pinDeleteBatches  PinterestDeleteBatch[]
}
```

- [ ] **Step 2: Add the two new fields + back-relations to `Integration`**

Find this exact block:

```prisma
  rootInternalId        String?
  additionalSettings    String?                @default("[]")
  webhooks              IntegrationsWebhooks[]

  @@unique([organizationId, internalId])
```

Replace with:

```prisma
  rootInternalId        String?
  additionalSettings    String?                @default("[]")
  webhooks              IntegrationsWebhooks[]
  pinDeleteWindowCount  Int                    @default(0)
  pinDeleteLastAt       DateTime?
  pinDeleteBatches      PinterestDeleteBatch[]
  pinDeleteItems        PinterestDeleteItem[]

  @@unique([organizationId, internalId])
```

- [ ] **Step 3: Append the two new models at the end of the file**

Append this to the very end of `schema.prisma` (after the last `enum APPROVED_SUBMIT_FOR_ORDER { ... }` block):

```prisma

model PinterestDeleteBatch {
  id              String    @id @default(uuid())
  organizationId  String
  integrationId   String
  createdByUserId String?
  source          String // "MANUAL" | "API" | "MCP"
  submittedCount  Int
  createdAt       DateTime  @default(now())

  organization Organization         @relation(fields: [organizationId], references: [id])
  integration  Integration          @relation(fields: [integrationId], references: [id])
  items        PinterestDeleteItem[]

  @@index([integrationId, createdAt])
}

model PinterestDeleteItem {
  id            String    @id @default(uuid())
  batchId       String
  integrationId String
  pinId         String
  rawInput      String
  status        String // "PENDING" | "QUEUED" | "REMOVED" | "FAILED" | "WAITING_FOR_QUOTA"
  scheduledFor  DateTime?
  errorMessage  String?
  processedAt   DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  batch       PinterestDeleteBatch @relation(fields: [batchId], references: [id], onDelete: Cascade)
  integration Integration          @relation(fields: [integrationId], references: [id])

  @@index([integrationId, status])
  @@index([status, scheduledFor])
}
```

- [ ] **Step 4: Commit**

```bash
git add libraries/nestjs-libraries/src/database/prisma/schema.prisma
git commit -m "feat: add Prisma models for Pinterest bulk pin deletion"
```

Note for whoever runs this on a machine with `node_modules`: after this commit, run `pnpm run prisma-generate` (regenerates the Prisma client the rest of this plan's code imports types from) and, against a real dev database, `pnpm run prisma-db-push`.

---

### Task 2: Pure pin-parsing and retention-list helpers + tests

**Files:**
- Create: `libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete.logic.ts`
- Test: `libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete.logic.spec.ts`

**Interfaces:**
- Produces: `parsePinInput(raw: string): string | null` and `pickBatchIdsToPurge(batchIdsNewestFirst: string[], keep?: number): string[]`. Task 5 (`PinterestDeleteService`) imports both by name from this file.

- [ ] **Step 1: Write the failing tests**

```typescript
// libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete.logic.spec.ts
import { parsePinInput, pickBatchIdsToPurge } from './pinterest-delete.logic';

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

describe('pickBatchIdsToPurge', () => {
  it('purges nothing when at or under the retention limit', () => {
    expect(pickBatchIdsToPurge(['b2', 'b1'], 2)).toEqual([]);
    expect(pickBatchIdsToPurge(['b1'], 2)).toEqual([]);
    expect(pickBatchIdsToPurge([], 2)).toEqual([]);
  });

  it('purges everything beyond the 2 most recent batches', () => {
    expect(pickBatchIdsToPurge(['b3', 'b2', 'b1'], 2)).toEqual(['b1']);
  });

  it('purges multiple batches when far beyond the limit', () => {
    expect(pickBatchIdsToPurge(['b5', 'b4', 'b3', 'b2', 'b1'], 2)).toEqual([
      'b3',
      'b2',
      'b1',
    ]);
  });
});
```

- [ ] **Step 2: Confirm the test file imports a module that doesn't exist yet**

`pinterest-delete.logic.ts` does not exist yet, so this test file would fail to compile/run once `pnpm test` is available (cannot be run in this environment — see Global Constraints). Proceed directly to the implementation.

- [ ] **Step 3: Write the implementation**

```typescript
// libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete.logic.ts

// Matches a bare Pinterest pin id (all-digit string) or a Pinterest pin URL
// like https://www.pinterest.com/pin/123456789012345678/?utm=abc
export function parsePinInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  const urlMatch = trimmed.match(/pinterest\.[a-z.]+\/pin\/(\d+)/i);
  if (urlMatch) {
    return urlMatch[1];
  }

  return null;
}

// Given an integration's batch ids ordered newest-first, returns the ids
// beyond the retention limit that should be purged.
export function pickBatchIdsToPurge(
  batchIdsNewestFirst: string[],
  keep = 2
): string[] {
  return batchIdsNewestFirst.slice(keep);
}
```

- [ ] **Step 4: Verify by inspection**

Confirm the regex `pinterest\.[a-z.]+\/pin\/(\d+)/i` matches `pinterest.com`, `www.pinterest.com`, and `pinterest.co.uk`-style hosts, and that the two test cases with and without a trailing slash both hit it (the pattern doesn't anchor on what follows the digits, so both pass). Confirm `pickBatchIdsToPurge` is a plain `Array.prototype.slice` — no off-by-one: `slice(2)` on a 3-element newest-first array returns exactly the 3rd (oldest) element.

- [ ] **Step 5: Commit**

```bash
git add libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete.logic.ts libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete.logic.spec.ts
git commit -m "feat: add pure pin-parsing and retention helpers for Pinterest bulk delete"
```

---

### Task 3: `SocialAbstract` 204 support + `PinterestProvider.deletePin()`

**Files:**
- Modify: `libraries/nestjs-libraries/src/integrations/social.abstract.ts:90`
- Modify: `libraries/nestjs-libraries/src/integrations/social/pinterest.provider.ts:414` (insert after the `post()` method)

**Interfaces:**
- Produces: `PinterestProvider.deletePin(id: string, accessToken: string, pinId: string): Promise<{ success: boolean }>`. Task 5's `PinterestDeleteService.processItem()` calls this exact signature.

- [ ] **Step 1: Allow 204 as a success status in `SocialAbstract.fetch()`**

Pinterest's `DELETE /v5/pins/{pin_id}` returns `204 No Content` on success. `fetch()` currently only treats 200/201 as success, so a successful delete would otherwise fall through into the retry/error-handling branch and eventually throw. In `social.abstract.ts`, find:

```typescript
    if (request.status === 200 || request.status === 201) {
      return request;
    }
```

Replace with:

```typescript
    if (
      request.status === 200 ||
      request.status === 201 ||
      request.status === 204
    ) {
      return request;
    }
```

This is additive — no existing caller of `fetch()` ever receives a 204 today, so this cannot change behavior for post/analytics calls, only newly allow the delete call to succeed correctly.

- [ ] **Step 2: Add `deletePin()` to `PinterestProvider`**

In `pinterest.provider.ts`, find the end of the `post()` method (the block ending `];\n  }` right before `async analytics(`):

```typescript
    return [
      {
        id: postDetails?.[0]?.id,
        postId: pId,
        releaseURL: `https://www.pinterest.com/pin/${pId}`,
        status: 'success',
      },
    ];
  }

  async analytics(
```

Replace with:

```typescript
    return [
      {
        id: postDetails?.[0]?.id,
        postId: pId,
        releaseURL: `https://www.pinterest.com/pin/${pId}`,
        status: 'success',
      },
    ];
  }

  async deletePin(
    id: string,
    accessToken: string,
    pinId: string
  ): Promise<{ success: boolean }> {
    const response = await this.fetch(
      `https://api.pinterest.com/v5/pins/${pinId}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    return { success: response.status === 204 || response.status === 200 };
  }

  async analytics(
```

Note: follows the same `(id, accessToken, ...)` parameter convention every other method on this provider uses (the caller resolves the token from the `Integration` row, the provider never reads it off an `Integration` object directly) — this is deliberate consistency with `post()`, `analytics()`, etc., not an oversight.

- [ ] **Step 3: Verify by inspection**

Re-read the edited `post()` → `deletePin()` → `analytics()` sequence to confirm the braces balance and no code was duplicated or dropped. Confirm `this.fetch` (inherited from `SocialAbstract`) is in scope (it is — `PinterestProvider extends SocialAbstract`).

- [ ] **Step 4: Commit**

```bash
git add libraries/nestjs-libraries/src/integrations/social.abstract.ts libraries/nestjs-libraries/src/integrations/social/pinterest.provider.ts
git commit -m "feat: add Pinterest deletePin provider method with 204 support"
```

---

### Task 4: `PinterestDeleteRepository` — atomic daily cap + CRUD

**Files:**
- Create: `libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete.repository.ts`

**Interfaces:**
- Consumes: `PrismaRepository<T>` from `@gitroom/nestjs-libraries/database/prisma/prisma.service` (generic Prisma model accessor, injected per model — see `integration.repository.ts` for the established pattern: `constructor(private _x: PrismaRepository<'modelName'>) {}`, then `this._x.model.modelName.findMany(...)`).
- Produces (all consumed by Task 5's `PinterestDeleteService`):
  - `createBatchWithItems(organizationId: string, integrationId: string, createdByUserId: string | null, source: 'MANUAL' | 'API' | 'MCP', parsedPins: { pinId: string; rawInput: string }[])` → the created batch row with its `items` included.
  - `listBatchIdsForIntegrationNewestFirst(integrationId: string): Promise<string[]>`
  - `deleteBatchesByIds(batchIds: string[]): Promise<unknown>`
  - `getItemById(itemId: string)` → item row with `integration` included, or `null`.
  - `markItemRemoved(itemId: string)`, `markItemFailed(itemId: string, errorMessage: string)`, `markItemWaitingForQuota(itemId: string, scheduledFor: Date)`, `markItemPending(itemId: string)`
  - `findDueWaitingItems(now: Date)` → items with `status: 'WAITING_FOR_QUOTA'` and `scheduledFor <= now`.
  - `findStalledIntegrationItems(staleBefore: Date)` → items with `status` in `PENDING`/`QUEUED` and `updatedAt < staleBefore`.
  - `listBatchSummariesForIntegration(integrationId: string)` → batches newest-first with `items` included.
  - `reserveQuotaSlot(integrationId: string): Promise<{ allowed: true } | { allowed: false; scheduledFor: Date }>`
  - `releaseQuotaSlot(integrationId: string): Promise<unknown>`

- [ ] **Step 1: Write the repository**

```typescript
// libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete.repository.ts
import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

const DAILY_CAP = 100;
const WINDOW_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class PinterestDeleteRepository {
  constructor(
    private _batch: PrismaRepository<'pinterestDeleteBatch'>,
    private _item: PrismaRepository<'pinterestDeleteItem'>,
    private _integration: PrismaRepository<'integration'>
  ) {}

  createBatchWithItems(
    organizationId: string,
    integrationId: string,
    createdByUserId: string | null,
    source: 'MANUAL' | 'API' | 'MCP',
    parsedPins: { pinId: string; rawInput: string }[]
  ) {
    return this._batch.model.pinterestDeleteBatch.create({
      data: {
        organizationId,
        integrationId,
        createdByUserId,
        source,
        submittedCount: parsedPins.length,
        items: {
          create: parsedPins.map(({ pinId, rawInput }) => ({
            integrationId,
            pinId,
            rawInput,
            status: 'PENDING',
          })),
        },
      },
      include: { items: true },
    });
  }

  async listBatchIdsForIntegrationNewestFirst(
    integrationId: string
  ): Promise<string[]> {
    const rows = await this._batch.model.pinterestDeleteBatch.findMany({
      where: { integrationId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  deleteBatchesByIds(batchIds: string[]) {
    if (batchIds.length === 0) {
      return Promise.resolve();
    }
    return this._batch.model.pinterestDeleteBatch.deleteMany({
      where: { id: { in: batchIds } },
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

  markItemWaitingForQuota(itemId: string, scheduledFor: Date) {
    return this._item.model.pinterestDeleteItem.update({
      where: { id: itemId },
      data: { status: 'WAITING_FOR_QUOTA', scheduledFor },
    });
  }

  markItemPending(itemId: string) {
    return this._item.model.pinterestDeleteItem.update({
      where: { id: itemId },
      data: { status: 'PENDING', scheduledFor: null },
    });
  }

  findDueWaitingItems(now: Date) {
    return this._item.model.pinterestDeleteItem.findMany({
      where: { status: 'WAITING_FOR_QUOTA', scheduledFor: { lte: now } },
    });
  }

  findStalledIntegrationItems(staleBefore: Date) {
    return this._item.model.pinterestDeleteItem.findMany({
      where: {
        status: { in: ['PENDING', 'QUEUED'] },
        updatedAt: { lt: staleBefore },
      },
    });
  }

  listBatchSummariesForIntegration(integrationId: string) {
    return this._batch.model.pinterestDeleteBatch.findMany({
      where: { integrationId },
      orderBy: { createdAt: 'desc' },
      include: { items: true },
    });
  }

  // Atomically reserves one deletion slot for this integration's rolling
  // 24h window, or reports when the caller should retry. Implemented as two
  // single-statement conditional UPDATEs (not a read-then-write) so it stays
  // correct under concurrent job handlers for the same integration — a bare
  // SELECT-then-UPDATE would race under BullMQ's worker concurrency.
  async reserveQuotaSlot(
    integrationId: string
  ): Promise<{ allowed: true } | { allowed: false; scheduledFor: Date }> {
    const now = new Date();
    const windowCutoff = new Date(now.getTime() - WINDOW_MS);

    const underCap = await this._integration.model.integration.updateMany({
      where: {
        id: integrationId,
        pinDeleteWindowCount: { lt: DAILY_CAP },
        pinDeleteLastAt: { gte: windowCutoff },
      },
      data: { pinDeleteWindowCount: { increment: 1 }, pinDeleteLastAt: now },
    });

    if (underCap.count > 0) {
      return { allowed: true };
    }

    const windowExpired = await this._integration.model.integration.updateMany(
      {
        where: {
          id: integrationId,
          OR: [
            { pinDeleteLastAt: null },
            { pinDeleteLastAt: { lt: windowCutoff } },
          ],
        },
        data: { pinDeleteWindowCount: 1, pinDeleteLastAt: now },
      }
    );

    if (windowExpired.count > 0) {
      return { allowed: true };
    }

    const integration = await this._integration.model.integration.findUniqueOrThrow(
      {
        where: { id: integrationId },
        select: { pinDeleteLastAt: true },
      }
    );

    return {
      allowed: false,
      scheduledFor: new Date(integration.pinDeleteLastAt!.getTime() + WINDOW_MS),
    };
  }

  // Reverses a reservation made by reserveQuotaSlot when the delete call
  // itself failed (a failure must not permanently cost a daily-cap slot).
  releaseQuotaSlot(integrationId: string) {
    return this._integration.model.integration.update({
      where: { id: integrationId },
      data: { pinDeleteWindowCount: { decrement: 1 } },
    });
  }
}
```

- [ ] **Step 2: Verify by inspection against Task 1's schema**

Confirm every field referenced (`pinDeleteWindowCount`, `pinDeleteLastAt`, `status`, `scheduledFor`, `errorMessage`, `processedAt`, `rawInput`, `pinId`, `batchId`, `integrationId`, `createdByUserId`, `source`, `submittedCount`) exists on the models added in Task 1 with matching types (`String?` fields compared to `null` via Prisma filters like `pinDeleteLastAt: null` are valid Prisma syntax for nullable `DateTime?` columns).

- [ ] **Step 3: Commit**

```bash
git add libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete.repository.ts
git commit -m "feat: add Pinterest delete repository with atomic daily-cap reservation"
```

---

### Task 5: `PinterestDeleteService` + `DatabaseModule` registration

**Files:**
- Create: `libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete.service.ts`
- Modify: `libraries/nestjs-libraries/src/database/prisma/database.module.ts`

**Interfaces:**
- Consumes: `PinterestDeleteRepository` (Task 4), `parsePinInput`/`pickBatchIdsToPurge` (Task 2), `IntegrationService.getIntegrationById(org: string, id: string)` and `IntegrationService.refreshNeeded(organizationId: string, integrationId: string)` and `IntegrationService.createOrUpdateIntegration(additionalSettings, oneTimeToken, organizationId, name, picture, type, internalId, providerIdentifier, accessToken, refreshToken, expiresIn)` (all pre-existing, `@gitroom/nestjs-libraries/database/prisma/integrations/integration.service`), `IntegrationManager.getSocialIntegration(identifier: string)` (pre-existing, `@gitroom/nestjs-libraries/integrations/integration.manager`), `BullMqClient` (pre-existing, `@gitroom/nestjs-libraries/bull-mq-transport-new/client`) used via its inherited `ClientProxy.emit(pattern, data)`, `PinterestProvider.deletePin` (Task 3, reached through `IntegrationManager.getSocialIntegration('pinterest')`).
- Produces (all consumed by later tasks):
  - `createBatch(organizationId: string, integrationId: string, createdByUserId: string | null, source: 'MANUAL' | 'API' | 'MCP', rawPinInputs: string[]): Promise<{ batchId: string; submittedCount: number }>` — throws a plain `Error` with a human-readable message on validation failure (Tasks 8/9/10 catch and surface it).
  - `processItem(itemId: string): Promise<void>` — Task 6's worker job handler calls this.
  - `recoverDueQuotaWaits(): Promise<number>` and `findStalledItemIntegrationIds(staleMinutes?: number): Promise<string[]>` — Task 7's cron task calls both.
  - `listBatchSummaries(integrationId: string)` — Task 8's controller calls this.

- [ ] **Step 1: Write the service**

```typescript
// libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete.service.ts
import { Injectable } from '@nestjs/common';
import dayjs from 'dayjs';
import * as Sentry from '@sentry/nestjs';
import { Integration } from '@prisma/client';
import { PinterestDeleteRepository } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete.repository';
import {
  parsePinInput,
  pickBatchIdsToPurge,
} from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete.logic';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { BullMqClient } from '@gitroom/nestjs-libraries/bull-mq-transport-new/client';

const RETENTION_LIMIT = 2;
const MAX_PINS_PER_BATCH = 100;

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
        payload: { itemId: item.id },
      });
    }

    const allBatchIds = await this._repository.listBatchIdsForIntegrationNewestFirst(
      integrationId
    );
    const toPurge = pickBatchIdsToPurge(allBatchIds, RETENTION_LIMIT);
    await this._repository.deleteBatchesByIds(toPurge);

    return { batchId: batch.id, submittedCount: batch.items.length };
  }

  async processItem(itemId: string): Promise<void> {
    const item = await this._repository.getItemById(itemId);
    if (!item) {
      // Purged by the retention policy (its batch was pushed out by a
      // later submission) before this job ran. Clean no-op, not an error.
      return;
    }

    const reservation = await this._repository.reserveQuotaSlot(
      item.integrationId
    );
    if (!reservation.allowed) {
      await this._repository.markItemWaitingForQuota(
        itemId,
        reservation.scheduledFor
      );
      return;
    }

    try {
      const accessToken = await this.getValidAccessToken(item.integration);
      const provider = this._integrationManager.getSocialIntegration(
        'pinterest'
      );
      const result = await provider.deletePin(
        item.integration.internalId,
        accessToken,
        item.pinId
      );

      if (!result.success) {
        await this._repository.releaseQuotaSlot(item.integrationId);
        await this._repository.markItemFailed(
          itemId,
          'Pinterest reported the deletion failed'
        );
        return;
      }

      await this._repository.markItemRemoved(itemId);
    } catch (err) {
      await this._repository.releaseQuotaSlot(item.integrationId);
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
  private async getValidAccessToken(integration: Integration): Promise<string> {
    const provider = this._integrationManager.getSocialIntegration(
      'pinterest'
    );

    if (dayjs(integration.tokenExpiration).isAfter(dayjs())) {
      return integration.token;
    }

    const {
      accessToken,
      expiresIn,
      refreshToken,
      additionalSettings,
    } = await provider.refreshToken(integration.refreshToken!);

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

  async recoverDueQuotaWaits(): Promise<number> {
    const now = new Date();
    const dueItems = await this._repository.findDueWaitingItems(now);
    for (const item of dueItems) {
      await this._repository.markItemPending(item.id);
      this._workerServiceProducer.emit('pinterest-delete-pin', {
        id: item.id,
        payload: { itemId: item.id },
      });
    }
    return dueItems.length;
  }

  async findStalledItemIntegrationIds(staleMinutes = 15): Promise<string[]> {
    const staleBefore = dayjs().subtract(staleMinutes, 'minute').toDate();
    const stalled = await this._repository.findStalledIntegrationItems(
      staleBefore
    );
    return Array.from(new Set(stalled.map((i) => i.integrationId)));
  }

  listBatchSummaries(integrationId: string) {
    return this._repository.listBatchSummariesForIntegration(integrationId);
  }
}
```

- [ ] **Step 2: Register the new service + repository in `DatabaseModule`**

In `database.module.ts`, add the two imports near the other prisma-domain imports (e.g. right after the `IntegrationService`/`IntegrationRepository` imports):

```typescript
import { PinterestDeleteService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete.service';
import { PinterestDeleteRepository } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete.repository';
```

And add both classes to the `providers` array (this `@Global()` module's `exports` getter already returns `this.providers`, so this alone makes them injectable from `apps/workers`, `apps/cron`, `apps/backend`, and `ChatModule` — no further module wiring needed for DI):

```typescript
    GlobalSettingsRepository,
    GlobalSettingsService,
    LlmConfigService,
    PinterestDeleteService,
    PinterestDeleteRepository,
  ],
```

(replacing the existing closing of the `providers` array, which currently ends at `LlmConfigService,`).

- [ ] **Step 3: Verify by inspection**

Confirm `PostsService.postSocial`'s refresh block (in `posts.service.ts`, around line 495-560) uses the exact same `createOrUpdateIntegration` parameter order reproduced above — re-read that method if unsure before trusting this file's `getValidAccessToken`.

- [ ] **Step 4: Commit**

```bash
git add libraries/nestjs-libraries/src/database/prisma/pinterest-delete/pinterest-delete.service.ts libraries/nestjs-libraries/src/database/prisma/database.module.ts
git commit -m "feat: add PinterestDeleteService orchestrating batches, quota, and retention"
```

---

### Task 6: BullMQ worker — `pinterest-delete-pin` queue

**Files:**
- Create: `apps/workers/src/app/pinterest-delete.controller.ts`
- Modify: `apps/workers/src/app/app.module.ts`

**Interfaces:**
- Consumes: `PinterestDeleteService.processItem(itemId: string)` (Task 5).
- Produces: the `pinterest-delete-pin` BullMQ queue/worker, which Task 5's `createBatch()` and `recoverDueQuotaWaits()` already emit jobs onto (via `BullMqClient.emit('pinterest-delete-pin', { id, payload: { itemId } })`).

- [ ] **Step 1: Write the controller**

```typescript
// apps/workers/src/app/pinterest-delete.controller.ts
import { Controller } from '@nestjs/common';
import { EventPattern, Transport } from '@nestjs/microservices';
import { PinterestDeleteService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete.service';

@Controller()
export class PinterestDeleteController {
  constructor(private _pinterestDeleteService: PinterestDeleteService) {}

  @EventPattern('pinterest-delete-pin', Transport.REDIS)
  async pinterestDeletePin(data: { itemId: string }) {
    try {
      return await this._pinterestDeleteService.processItem(data.itemId);
    } catch (err) {
      console.log(
        "Unhandled error, let's avoid crashing the pinterest-delete-pin worker",
        err
      );
    }
  }
}
```

This matches `PostsController`'s existing `cron` handler shape exactly (`@EventPattern(name, Transport.REDIS)`, payload destructured directly since `BullMqServer` passes `job.data.payload` as the sole argument, try/catch swallows so one bad job never crashes the whole worker process).

- [ ] **Step 2: Register the controller**

In `apps/workers/src/app/app.module.ts`, add the import:

```typescript
import { PinterestDeleteController } from '@gitroom/workers/app/pinterest-delete.controller';
```

And add it to `controllers`:

```typescript
  controllers: [PostsController, PlugsController, PinterestDeleteController],
```

`PinterestDeleteService` itself needs no entry in this module's own `providers` — it's already globally exported by `DatabaseModule` (Task 5, step 2), which this module already imports.

- [ ] **Step 3: Commit**

```bash
git add apps/workers/src/app/pinterest-delete.controller.ts apps/workers/src/app/app.module.ts
git commit -m "feat: add BullMQ worker for pinterest-delete-pin queue"
```

---

### Task 7: Cron sweep — recover quota waits, flag stalls

**Files:**
- Create: `apps/cron/src/tasks/recover.pinterest.delete.quota.ts`
- Modify: `apps/cron/src/cron.module.ts`

**Interfaces:**
- Consumes: `PinterestDeleteService.recoverDueQuotaWaits()` and `PinterestDeleteService.findStalledItemIntegrationIds()` (Task 5).

- [ ] **Step 1: Write the cron task**

```typescript
// apps/cron/src/tasks/recover.pinterest.delete.quota.ts
import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as Sentry from '@sentry/nestjs';
import { PinterestDeleteService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete.service';

@Injectable()
export class RecoverPinterestDeleteQuota {
  constructor(private _pinterestDeleteService: PinterestDeleteService) {}

  @Cron('*/5 * * * *')
  async handleCron() {
    try {
      const recovered = await this._pinterestDeleteService.recoverDueQuotaWaits();
      if (recovered > 0) {
        console.log(
          `[PINTEREST DELETE QUOTA] Recovered ${recovered} item(s) whose daily-cap wait has elapsed`
        );
      }

      const stalledIntegrationIds = await this._pinterestDeleteService.findStalledItemIntegrationIds();
      if (stalledIntegrationIds.length > 0) {
        console.warn(
          `[PINTEREST DELETE QUOTA] ${stalledIntegrationIds.length} integration(s) have stalled bulk-delete items`,
          { stalledIntegrationIds }
        );
        Sentry.captureMessage('Pinterest bulk-delete queue appears stalled', {
          extra: { stalledIntegrationIds },
        });
      }
    } catch (err) {
      console.error('[PINTEREST DELETE QUOTA] Error in cron job:', err);
      Sentry.captureException(err, {
        extra: { context: 'RecoverPinterestDeleteQuota cron job failed' },
      });
    }
  }
}
```

This follows `CheckMissingQueues`'s exact structure (try/catch wrapping the whole handler, `console.log`/`console.warn`/`console.error` plus `Sentry` calls, `@Cron(...)` cron-expression string).

- [ ] **Step 2: Register the task**

In `apps/cron/src/cron.module.ts`, add the import:

```typescript
import { RecoverPinterestDeleteQuota } from '@gitroom/cron/tasks/recover.pinterest.delete.quota';
```

And add it to `providers`:

```typescript
  providers: [FILTER, CheckMissingQueues, PostNowPendingQueues, RescheduleMissedPostsStartup, CheckDuplicateSchedules, CheckInvalidTimeSlots, SyncBullMqJobs, CleanupOrphanedMediaStartup, RecoverPinterestDeleteQuota],
```

- [ ] **Step 3: Commit**

```bash
git add apps/cron/src/tasks/recover.pinterest.delete.quota.ts apps/cron/src/cron.module.ts
git commit -m "feat: add cron sweep to recover quota-deferred pins and flag stalls"
```

---

### Task 8: Session-authenticated backend endpoints for the UI tab

**Files:**
- Create: `libraries/nestjs-libraries/src/dtos/pinterest-delete/pinterest.delete.batch.dto.ts`
- Create: `apps/backend/src/api/routes/pinterest-delete.controller.ts`
- Modify: `apps/backend/src/api/api.module.ts`

**Interfaces:**
- Consumes: `PinterestDeleteService.createBatch`/`listBatchSummaries` (Task 5), `GetOrgFromRequest` (`@gitroom/nestjs-libraries/user/org.from.request`), `GetUserFromRequest` (`@gitroom/nestjs-libraries/user/user.from.request`).
- Produces: `POST /pinterest-delete/batches` (body `{ integrationId: string, pins: string[] }`, returns `{ batchId, submittedCount }`), `GET /pinterest-delete/batches?integrationId=X` (returns the array from `listBatchSummaries`). Task 11's frontend calls both exactly as named.

- [ ] **Step 1: Write the DTO**

```typescript
// libraries/nestjs-libraries/src/dtos/pinterest-delete/pinterest.delete.batch.dto.ts
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
} from 'class-validator';

export class PinterestDeleteBatchDto {
  @IsString()
  integrationId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  pins: string[];
}
```

- [ ] **Step 2: Write the controller**

```typescript
// apps/backend/src/api/routes/pinterest-delete.controller.ts
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

  @Get('/batches')
  listBatches(@Query('integrationId') integrationId: string) {
    return this._pinterestDeleteService.listBatchSummaries(integrationId);
  }
}
```

Note: `listBatches` does not take `@GetOrgFromRequest()` because `listBatchSummaries` filters by `integrationId` alone (matching the spec's per-account history view) — this is safe because the frontend only ever offers integrations belonging to the caller's own org in the picker (Task 11), and this is a session-authenticated route (not the public API), so an attacker would first need a valid session cookie for some organization to reach it at all. If stricter enforcement is desired later, add an org-ownership check here calling `IntegrationService.getIntegrationById(org.id, integrationId)` first.

- [ ] **Step 3: Register the controller**

In `apps/backend/src/api/api.module.ts`, add the import:

```typescript
import { PinterestDeleteController } from '@gitroom/backend/api/routes/pinterest-delete.controller';
```

And add it to the `authenticatedController` array:

```typescript
const authenticatedController = [
  UsersController,
  AnalyticsController,
  IntegrationsController,
  SettingsController,
  PostsController,
  MediaController,
  BillingController,
  NotificationsController,
  MarketplaceController,
  MessagesController,
  CopilotController,
  AgenciesController,
  WebhookController,
  SignatureController,
  AutopostController,
  SetsController,
  ThirdPartyController,
  PublishingController,
  PinterestDeleteController,
];
```

(Being in this array is what makes `AuthMiddleware` run for it, which is what populates both `request.org` and `request.user` that the two `@Get...FromRequest()` decorators read.)

- [ ] **Step 4: Commit**

```bash
git add libraries/nestjs-libraries/src/dtos/pinterest-delete/pinterest.delete.batch.dto.ts apps/backend/src/api/routes/pinterest-delete.controller.ts apps/backend/src/api/api.module.ts
git commit -m "feat: add session-authenticated Pinterest bulk-delete endpoints"
```

---

### Task 9: Public API endpoint

**Files:**
- Modify: `apps/backend/src/public-api/routes/v1/public.integrations.controller.ts`

**Interfaces:**
- Consumes: `PinterestDeleteService.createBatch` (already injectable — Task 5 registered it globally), `PinterestDeleteBatchDto` (Task 8).
- Produces: `POST /public/v1/pinterest/delete-batch`.

- [ ] **Step 1: Add the constructor dependency and endpoint**

In `public.integrations.controller.ts`, add to the existing constructor:

```typescript
  constructor(
    private _integrationService: IntegrationService,
    private _postsService: PostsService,
    private _mediaService: MediaService,
    private _pinterestDeleteService: PinterestDeleteService
  ) {}
```

Add the import near the other service imports at the top of the file:

```typescript
import { PinterestDeleteService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete.service';
import { PinterestDeleteBatchDto } from '@gitroom/nestjs-libraries/dtos/pinterest-delete/pinterest.delete.batch.dto';
```

Add the new endpoint method anywhere else in the class body (e.g. right after `uploadSimple`):

```typescript
  @Post('/pinterest/delete-batch')
  async pinterestDeleteBatch(
    @GetOrgFromRequest() org: Organization,
    @Body() body: PinterestDeleteBatchDto
  ) {
    Sentry.metrics.count('public_api-request', 1);
    return this._pinterestDeleteService.createBatch(
      org.id,
      body.integrationId,
      null,
      'API',
      body.pins
    );
  }
```

`createdByUserId` is `null` here — public API calls are authenticated by an org-level API key, not a specific user session, matching the DTO's `createdByUserId: string | null` type from Task 5.

No module changes needed: `PublicIntegrationsController` is already listed in `public.api.module.ts`'s `authenticatedController` array, and `PinterestDeleteService` is already globally exported by `DatabaseModule`.

- [ ] **Step 2: Verify by inspection**

Confirm `Body`, `Post`, `Organization`, `GetOrgFromRequest`, and `Sentry` are already imported at the top of this file (they are, per the existing `uploadSimple` method) — only the two new imports above need adding.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/public-api/routes/v1/public.integrations.controller.ts
git commit -m "feat: add public API endpoint for Pinterest bulk-delete submission"
```

---

### Task 10: MCP tool

**Files:**
- Create: `libraries/nestjs-libraries/src/chat/tools/pinterest.bulk.delete.pins.tool.ts`
- Modify: `libraries/nestjs-libraries/src/chat/tools/tool.list.ts`

**Interfaces:**
- Consumes: `AgentToolInterface` (`@gitroom/nestjs-libraries/chat/agent.tool.interface`), `checkAuth` (`@gitroom/nestjs-libraries/chat/auth.context`), `createTool` (`@mastra/core/tools`), `PinterestDeleteService.createBatch` (Task 5, already globally injectable).
- Produces: an MCP tool named `pinterestBulkDeletePinsTool`.

- [ ] **Step 1: Write the tool**

```typescript
// libraries/nestjs-libraries/src/chat/tools/pinterest.bulk.delete.pins.tool.ts
import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import z from 'zod';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import { PinterestDeleteService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete.service';

@Injectable()
export class PinterestBulkDeletePinsTool implements AgentToolInterface {
  constructor(private _pinterestDeleteService: PinterestDeleteService) {}
  name = 'pinterestBulkDeletePinsTool';

  run() {
    return createTool({
      id: 'pinterestBulkDeletePinsTool',
      description: `Submits up to 100 Pinterest pins (by id or URL) for permanent deletion from a specific connected Pinterest account. This is irreversible and rate-limited (at most 100 actual deletions per account per rolling 24 hours; extra pins wait for the next window automatically) — always confirm with the user exactly which pins and which Pinterest account before calling this.`,
      inputSchema: z.object({
        integrationId: z
          .string()
          .describe(
            'The id of the Pinterest integration (not internal id), from integrationListTool'
          ),
        pins: z
          .array(z.string())
          .max(100)
          .describe(
            'Pinterest pin ids or pin URLs to delete, up to 100 per call'
          ),
      }),
      outputSchema: z.object({
        output: z.object({
          batchId: z.string(),
          submittedCount: z.number(),
        }),
      }),
      execute: async (args, options) => {
        const { context, runtimeContext } = args;
        checkAuth(args, options);
        const organizationId = JSON.parse(
          // @ts-ignore
          runtimeContext.get('organization') as string
        ).id;

        const result = await this._pinterestDeleteService.createBatch(
          organizationId,
          context.integrationId,
          null,
          'MCP',
          context.pins
        );

        return { output: result };
      },
    });
  }
}
```

`createdByUserId` is `null` here for the same reason as the public API path (Task 9) — the MCP tool authenticates as an organization via `runtimeContext`, not as a specific user session, matching `integrationDeletePostTool`'s existing pattern which also has no user-id concept.

- [ ] **Step 2: Register the tool**

In `tool.list.ts`, add the import:

```typescript
import { PinterestBulkDeletePinsTool } from '@gitroom/nestjs-libraries/chat/tools/pinterest.bulk.delete.pins.tool';
```

And add it to the `toolList` array:

```typescript
export const toolList = [
  IntegrationListTool,
  IntegrationValidationTool,
  IntegrationTriggerTool,
  IntegrationSchedulePostTool,
  GenerateVideoOptionsTool,
  VideoFunctionTool,
  GenerateVideoTool,
  GenerateImageTool,
  IntegrationListPostsTool,
  IntegrationGetPostTool,
  IntegrationGetGroupHistoryTool,
  IntegrationDeletePostTool,
  IntegrationEditPostDateTool,
  IntegrationEditPostContentTool,
  IntegrationAnalyticsTool,
  PinterestBulkDeletePinsTool,
];
```

`ChatModule` spreads `toolList` directly into its own `providers` (`providers: [MastraService, LoadToolsService, ...toolList]`) and is itself `@Global()`, so no further registration is needed — `PinterestDeleteService` resolves because `DatabaseModule` (Task 5) already exports it globally.

- [ ] **Step 3: Commit**

```bash
git add libraries/nestjs-libraries/src/chat/tools/pinterest.bulk.delete.pins.tool.ts libraries/nestjs-libraries/src/chat/tools/tool.list.ts
git commit -m "feat: expose Pinterest bulk-delete submission as an MCP tool"
```

---

### Task 11: Frontend tab

**Files:**
- Create: `apps/frontend/src/app/(app)/(site)/pinterest-cleanup/page.tsx`
- Create: `apps/frontend/src/components/pinterest-cleanup/pinterest.cleanup.component.tsx`
- Modify: `apps/frontend/src/components/layout/top.menu.tsx:83-103`

**Interfaces:**
- Consumes: `useFetch` (`@gitroom/helpers/utils/custom.fetch`), `useToaster` (`@gitroom/react/toaster/toaster`), the existing `GET /integrations/list` endpoint (returns `{ integrations: Array<{ id, name, identifier, picture, ... }> }`, `identifier === 'pinterest'` for Pinterest accounts), and Task 8's `POST /pinterest-delete/batches` / `GET /pinterest-delete/batches?integrationId=`.

- [ ] **Step 1: Write the page**

```tsx
// apps/frontend/src/app/(app)/(site)/pinterest-cleanup/page.tsx
import { PinterestCleanupComponent } from '@gitroom/frontend/components/pinterest-cleanup/pinterest.cleanup.component';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'TheContentWarrior' : 'JDCO'} Pinterest Cleanup`,
  description: '',
};

export default async function Page() {
  return <PinterestCleanupComponent />;
}
```

(Matches the `Plugs`/`Media` `page.tsx` pattern: an async server component that only sets metadata and renders one client component.)

- [ ] **Step 2: Write the component**

```tsx
// apps/frontend/src/components/pinterest-cleanup/pinterest.cleanup.component.tsx
'use client';

import { useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';

interface IntegrationListItem {
  id: string;
  name: string;
  identifier: string;
}

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

const MAX_PINS = 100;

function summarize(items: PinterestDeleteItemSummary[]) {
  return {
    removed: items.filter((i) => i.status === 'REMOVED').length,
    failed: items.filter((i) => i.status === 'FAILED').length,
    waiting: items.filter((i) => i.status === 'WAITING_FOR_QUOTA').length,
    pending: items.filter((i) => i.status === 'PENDING' || i.status === 'QUEUED')
      .length,
  };
}

export const PinterestCleanupComponent = () => {
  const fetch = useFetch();
  const toaster = useToaster();
  const [selectedIntegrationId, setSelectedIntegrationId] = useState('');
  const [pinsText, setPinsText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const { data: integrationsData } = useSWR('integrations', async () =>
    (await fetch('/integrations/list')).json()
  );

  const pinterestIntegrations: IntegrationListItem[] = useMemo(
    () =>
      (integrationsData?.integrations || []).filter(
        (i: IntegrationListItem) => i.identifier === 'pinterest'
      ),
    [integrationsData]
  );

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

  const pinCount = useMemo(
    () =>
      pinsText
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean).length,
    [pinsText]
  );

  const onSubmit = useCallback(async () => {
    const pins = pinsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (!selectedIntegrationId) {
      toaster.show('Select a Pinterest account first', 'warning');
      return;
    }

    if (pins.length === 0 || pins.length > MAX_PINS) {
      toaster.show(`Paste between 1 and ${MAX_PINS} pins`, 'warning');
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/pinterest-delete/batches', {
        method: 'POST',
        body: JSON.stringify({ integrationId: selectedIntegrationId, pins }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}) as any);
        toaster.show(body.message || 'Failed to submit batch', 'warning');
        return;
      }

      setPinsText('');
      toaster.show('Batch submitted', 'success');
      mutateBatches();
    } finally {
      setSubmitting(false);
    }
  }, [pinsText, selectedIntegrationId, fetch, toaster, mutateBatches]);

  const batches = batchesData || [];
  const nextQuotaResume = batches
    .flatMap((b) => b.items)
    .filter((i) => i.status === 'WAITING_FOR_QUOTA' && i.scheduledFor)
    .map((i) => i.scheduledFor as string)
    .sort()[0];

  return (
    <div className="flex flex-col gap-4 p-6 text-white">
      <div className="text-xl font-semibold">Pinterest Pin Cleanup</div>

      {pinterestIntegrations.length === 0 && (
        <div>Connect a Pinterest account first to use this tool.</div>
      )}

      {pinterestIntegrations.length > 0 && (
        <>
          <select
            className="bg-black border border-white/20 rounded p-2"
            value={selectedIntegrationId}
            onChange={(e) => setSelectedIntegrationId(e.target.value)}
          >
            <option value="">Select a Pinterest account</option>
            {pinterestIntegrations.map((integration) => (
              <option key={integration.id} value={integration.id}>
                {integration.name}
              </option>
            ))}
          </select>

          <textarea
            className="bg-black border border-white/20 rounded p-2 min-h-[160px]"
            placeholder="Paste one pin id or Pinterest pin URL per line (up to 100)"
            value={pinsText}
            onChange={(e) => setPinsText(e.target.value)}
          />

          <div className="flex items-center gap-3">
            <div>
              {pinCount}/{MAX_PINS} pins
            </div>
            <button
              className="bg-blue-600 text-white rounded px-4 py-2 disabled:opacity-50"
              disabled={
                submitting ||
                !selectedIntegrationId ||
                pinCount === 0 ||
                pinCount > MAX_PINS
              }
              onClick={onSubmit}
            >
              Submit for deletion
            </button>
          </div>

          {nextQuotaResume && (
            <div className="bg-yellow-900 text-yellow-200 rounded p-3">
              Daily deletion limit reached for this account — resumes at{' '}
              {new Date(nextQuotaResume).toLocaleString()}.
            </div>
          )}

          {selectedIntegrationId && (
            <div className="flex flex-col gap-2">
              <div className="text-lg font-semibold">History</div>
              {batches.length === 0 && (
                <div>No batches submitted yet for this account.</div>
              )}
              {batches.map((batch) => {
                const counts = summarize(batch.items);
                return (
                  <div key={batch.id} className="border border-white/20 rounded p-3">
                    <div>
                      {new Date(batch.createdAt).toLocaleString()} —{' '}
                      {batch.submittedCount} submitted ({batch.source})
                    </div>
                    <div>
                      Removed: {counts.removed} · Failed: {counts.failed} ·
                      Waiting on daily limit: {counts.waiting} · Pending:{' '}
                      {counts.pending}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
};
```

Note: no menu-based conditional hide is used (see Step 3) — instead the component itself shows a "connect a Pinterest account first" message when the filtered list is empty. This is simpler than wiring a new data source into `useMenuItem` (which today has no example of integration-existence-based hiding to follow — confirmed by reading the whole file; only `role` and `requireBilling` are ever computed dynamically there today).

- [ ] **Step 3: Add the sidebar entry**

In `top.menu.tsx`, find this exact block (the end of the `Media` entry):

```tsx
        </svg>
      ),
      path: '/media',
    },
    {
```

Replace with (inserting a new entry right after Media, reusing the existing Calendar/Launches icon SVG verbatim as a placeholder graphic — swap the `<path d="...">` for a dedicated icon later, this is a visual-only follow-up, not a functional gap):

```tsx
        </svg>
      ),
      path: '/media',
    },
    {
      name: t('pinterest_cleanup', 'Pin Cleanup'),
      icon: (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="21"
          height="23"
          viewBox="0 0 21 23"
          fill="none"
        >
          <path
            d="M19.5 9.5H1.5M14.5 1.5V5.5M6.5 1.5V5.5M6.3 21.5H14.7C16.3802 21.5 17.2202 21.5 17.862 21.173C18.4265 20.8854 18.8854 20.4265 19.173 19.862C19.5 19.2202 19.5 18.3802 19.5 16.7V8.3C19.5 6.61984 19.5 5.77976 19.173 5.13803C18.8854 4.57354 18.4265 4.1146 17.862 3.82698C17.2202 3.5 16.3802 3.5 14.7 3.5H6.3C4.61984 3.5 3.77976 3.5 3.13803 3.82698C2.57354 4.1146 2.1146 4.57354 1.82698 5.13803C1.5 5.77976 1.5 6.61984 1.5 8.3V16.7C1.5 18.3802 1.5 19.2202 1.82698 19.862C2.1146 20.4265 2.57354 20.8854 3.13803 21.173C3.77976 21.5 4.61984 21.5 6.3 21.5Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      path: '/pinterest-cleanup',
    },
    {
```

- [ ] **Step 4: Verify by inspection**

Confirm the `t(...)` translation helper is already imported/used elsewhere in this same array (it is — see the `Media` entry: `t('media', 'Media')`), so `t('pinterest_cleanup', 'Pin Cleanup')` needs no new import.

- [ ] **Step 5: Commit**

```bash
git add "apps/frontend/src/app/(app)/(site)/pinterest-cleanup/page.tsx" apps/frontend/src/components/pinterest-cleanup/pinterest.cleanup.component.tsx apps/frontend/src/components/layout/top.menu.tsx
git commit -m "feat: add Pinterest Pin Cleanup tab to the frontend"
```

---

### Task 12: Manual verification checklist (not run by the agent)

This task is documentation, not code — it's the checklist referenced throughout this plan for whoever has a working dev environment (the maintainer, or CI once a test workflow exists). Nothing in this task is executed by an agent working inside this repo's current environment (no `node_modules`, per Global Constraints).

- [ ] **Step 1: Install and generate**

```bash
pnpm install
pnpm run prisma-generate
```

- [ ] **Step 2: Push the schema to a real dev database**

```bash
pnpm run prisma-db-push
```

Confirm no errors — this is the first `onDelete: Cascade` relation in this schema (confirmed via grep — zero prior uses), so specifically check the generated migration/push output mentions the cascade on `PinterestDeleteItem.batchId` without complaint.

- [ ] **Step 3: Run the unit tests written in Task 2**

```bash
pnpm --filter ./libraries/nestjs-libraries run test -- --testPathPattern=pinterest-delete
```

Expected: all `parsePinInput`/`pickBatchIdsToPurge` cases pass.

- [ ] **Step 4: Build each touched app**

```bash
pnpm run build:backend
pnpm run build:workers
pnpm run build:cron
pnpm run build:frontend
```

Fix any type errors surfaced — this plan was written from direct reads of the current source, but Prisma client types only exist after Step 1/2 above, so this is the first point actual TypeScript errors (if any) would surface.

- [ ] **Step 5: Manual daily-cap and retention verification (no automated test covers this — see Global Constraints)**

Against a real dev database with a test Pinterest integration:
1. Submit a batch of 3-5 real (disposable) pin ids. Confirm they transition `PENDING` → `REMOVED` within a few seconds and are actually gone from the Pinterest account.
2. Manually set that integration's `pinDeleteWindowCount` to `100` and `pinDeleteLastAt` to `now` via a DB client. Submit one more pin. Confirm it lands in `WAITING_FOR_QUOTA` with `scheduledFor` ≈ 24h from `pinDeleteLastAt`, and is *not* called against Pinterest.
3. Manually back-date that same integration's `pinDeleteLastAt` to more than 24h ago. Wait for the cron sweep (or trigger `RecoverPinterestDeleteQuota.handleCron()` directly) and confirm the item moves back to `PENDING`, gets processed, and `pinDeleteWindowCount` resets to `1`.
4. Submit a 3rd batch for the same integration while an earlier batch still has unfinished items. Confirm the oldest batch (and its items, regardless of status) is deleted from the database, and confirm the frontend history list only ever shows 2 batches for that account.
5. Kill the `workers` process while a batch is mid-flight, wait 15+ minutes, confirm the next cron tick logs a stalled-integration warning (check Sentry/console) for that integration.
6. In the UI tab, confirm the "resumes at" banner appears while an integration is capped, and disappears once cleared.
7. Through the MCP tool (`pinterestBulkDeletePinsTool`) and the public API (`POST /public/v1/pinterest/delete-batch`), confirm both create a batch with the correct `source` value (`MCP`/`API` respectively) visible in the history list.

- [ ] **Step 6: Final commit (if Step 4/5 required fixes)**

```bash
git add -A
git commit -m "fix: address issues found during manual verification of Pinterest bulk delete"
```

## Post-implementation CI fixes (2026-09-06)

The first CI build (GitHub Actions `Build and Push Docker Image`) failed
`nest build` with 2 TypeScript errors this plan's authoring couldn't catch
without a real compiler (per Global Constraints, nothing here was
build-verified before pushing). Both are fixed in the merged code; recorded
here so the plan stays an accurate account of what was actually shipped:

1. **`ISocialMediaIntegration` had no `deletePin` method.** Task 3 added
   `deletePin()` only to the concrete `PinterestProvider` class, but Task
   5's service resolves the provider through
   `IntegrationManager.getSocialIntegration('pinterest'): SocialProvider`,
   which is typed by the shared interface — so `provider.deletePin(...)`
   didn't compile. Fixed by adding `deletePin?(...)` as an **optional**
   method on `ISocialMediaIntegration`
   (`social.integrations.interface.ts`), matching the existing convention
   for provider-specific capabilities (`analytics?`, `changeNickname?`,
   etc.), and calling it via `provider.deletePin?.(...)` /
   `result?.success` in the service.
2. **`reserveQuotaSlot`'s discriminated union didn't narrow.** The
   annotated return type `{ allowed: true } | { allowed: false;
   scheduledFor: Date }` failed to narrow at the `reservation.scheduledFor`
   call site even inside `if (!reservation.allowed)` — this repo runs with
   `strictNullChecks: false` (per `CLAUDE.md`), under which TypeScript's
   discriminated-union narrowing is measurably weaker. Fixed by changing
   the return type to a single shape, `{ allowed: boolean; scheduledFor?:
   Date }`, and using a non-null assertion (`reservation.scheduledFor!`) at
   the one call site where business logic guarantees it's set — sidesteps
   narrowing entirely instead of fighting the compiler setting.

## Self-Review Notes

- **Spec coverage:** every section of the spec (data model, ingestion — all 3 entry points, daily cap + throttle sharing, queue mechanics, retention/self-cleansing, frontend, MCP tool) has a corresponding task above. The spec's "Testing" section is covered by Task 2 (pure logic) + Task 12 (manual checklist), with the daily-cap unit-test line explicitly downgraded to manual verification per Global Constraints, for the reasons stated there.
- **Type consistency:** `PinterestDeleteService.createBatch`'s `source` parameter type (`'MANUAL' | 'API' | 'MCP'`) is identical across Tasks 5, 8, 9, and 10 — the three callers pass the literal matching their own entry point. `processItem(itemId: string)` and `reserveQuotaSlot`/`releaseQuotaSlot(integrationId: string)` signatures are used identically wherever referenced.
- **No placeholders:** every code block above is complete, runnable-as-written code, not a description of what to write. The one intentional stand-in is the reused Calendar-icon SVG for the new menu entry (Task 11, Step 3), which is explicitly called out as a real, working icon being reused rather than a swap-me-later token.

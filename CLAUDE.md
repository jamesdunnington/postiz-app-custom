# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Postiz is an AI-powered social media scheduling SaaS (open-source alternative to Buffer/Hypefury). It is a pnpm monorepo with separate apps for the web UI, API server, background workers, and scheduled tasks. Supports 14+ social platforms: X, Instagram, TikTok, LinkedIn, Facebook, Pinterest, Discord, Threads, Slack, Mastodon, Bluesky, YouTube, Dribbble, Reddit.

## Commands

```bash
# Install dependencies (also runs prisma-generate via postinstall)
pnpm install

# Start all services in dev mode (frontend, backend, workers, cron, extension)
pnpm run dev

# Start individual services
pnpm run dev:backend
pnpm run dev:frontend
pnpm run dev:workers
pnpm run dev:cron

# Start local infrastructure (PostgreSQL, Redis, pgAdmin, RedisInsight)
pnpm run dev:docker          # docker compose -f ./docker-compose.dev.yaml up -d

# Build
pnpm run build               # all apps (sequential, workspace-concurrency=1)
pnpm run build:backend
pnpm run build:frontend
pnpm run build:workers
pnpm run build:cron
pnpm run build:extension

# Database (Prisma schema at libraries/nestjs-libraries/src/database/prisma/schema.prisma)
pnpm run prisma-generate     # regenerate Prisma client after schema changes
pnpm run prisma-db-push      # push schema to database
pnpm run prisma-reset        # force-reset + push (destroys all data)

# Tests (output to ./reports/junit.xml)
pnpm test                    # Jest with coverage, all packages

# Run a single test file
pnpm --filter ./apps/backend run test -- --testPathPattern="path/to/test"

# Lint (ESLint flat config)
pnpm --filter ./apps/frontend run lint
```

## Environment

- **Node.js**: 20.17.0 (Volta-locked); package.json also accepts `>=22.12.0 <23.0.0`
- **pnpm**: 10.6.1
- **Prettier**: `singleQuote: true` only — minimal config
- **GitHub CLI**: `gh` is installed. Always use `gh` for all GitHub operations (push, PR creation, issue management, release tagging). Never instruct the user to use raw `git push` to remote — prefer `gh repo sync`, `gh pr create`, etc.

## Architecture

### Monorepo Layout

```
apps/
  backend/    NestJS REST API (port 3000) — auth, posts, integrations, billing, analytics
  frontend/   Next.js 14 web app (port 4200) — dashboard, scheduling UI, analytics
  workers/    NestJS process — BullMQ job consumers (post publishing, social sync)
  cron/       NestJS app-context (no HTTP server) — @nestjs/schedule periodic tasks
  extension/  Vite + React browser extension (Chrome/Firefox)
  sdk/        @postiz/node — public Node.js SDK, published to npm
  commands/   NestJS CLI utilities (nestjs-command)

libraries/
  nestjs-libraries/       Shared NestJS modules: Prisma ORM, Redis/BullMQ, email, uploads, video
  react-shared-libraries/ Shared React components and hooks
  helpers/                Pure utility functions
  plugins/                Custom plugin system
```

### Path Aliases (tsconfig.base.json)

Cross-package imports use `@gitroom/*` aliases:
- `@gitroom/backend/*` → `apps/backend/src/*`
- `@gitroom/frontend/*` → `apps/frontend/src/*`
- `@gitroom/nestjs-libraries/*` → `libraries/nestjs-libraries/src/*`
- `@gitroom/react/*` → `libraries/react-shared-libraries/src/*`
- `@gitroom/helpers/*` → `libraries/helpers/src/*`
- `@gitroom/workers/*`, `@gitroom/cron/*`, `@gitroom/extension/*`, `@gitroom/plugins/*`

### Data Flow

- **Frontend** communicates with **Backend** via REST (JWT auth).
- **Backend** enqueues jobs into **Redis** (BullMQ); **Workers** consume those queues to publish posts to social platforms.
- **Cron** runs on its own schedule for analytics syncing, cleanup, and other periodic work.
- **Database**: PostgreSQL via Prisma. Schema is the single source of truth; always run `prisma-generate` after schema changes.
- **Queues**: BullMQ backed by Redis (`ioredis`). Queue definitions live in `libraries/nestjs-libraries/src/`.
- **Multi-tenancy**: `Organization` is the top-level tenant container — all posts, integrations, billing, and users belong to an organization.

### Key Backend Modules

The backend uses NestJS modules with CASL for role-based access control. Core controllers:
- `auth` — JWT + OAuth (20+ social providers via `ProvidersFactory`)
- `posts` — scheduling, drafts, approval workflows
- `integrations` — social account OAuth connections
- `analytics` — performance metrics
- `billing` — Stripe subscriptions
- `marketplace` — content marketplace
- `copilot` — CopilotKit + LangChain/Mastra AI assistant (`AgentGraphService` + LangGraph workflows)
- `public` — SDK/public API endpoints

### Frontend Stack

Next.js 14 (App Router), React 18, Tailwind CSS 3, Mantine 5, Zustand (state), SWR (data fetching), TipTap (rich text editor), Uppy (file uploads to S3/R2), react-hook-form.

### TypeScript Notes

`tsconfig.base.json` sets `strict: true` but `strictNullChecks: false` — null checks are not enforced across the codebase. `noImplicitAny: true` is enabled.

## Conventions

### Commits
Use conventional commits: `feat:`, `fix:`, `chore:`, `refactor:`, etc.

### Logging with Sentry
All services integrate Sentry. Use the structured logger — **do not use `console.log` for production logging**:

```typescript
import * as Sentry from "@sentry/nextjs"; // or @sentry/nestjs for backend
const { logger } = Sentry;

logger.trace("Starting database connection", { database: "users" });
logger.debug(logger.fmt`Cache miss for user: ${userId}`);
logger.info("Updated profile", { profileId: 345 });
logger.warn("Rate limit reached", { endpoint: "/api/results/" });
logger.error("Failed to process payment", { orderId, amount });
logger.fatal("Database connection pool exhausted", { activeConnections: 100 });
```

Initialize with `enableLogs: true` and optionally `consoleLoggingIntegration`.

### Environment Variables
- Copy `.env.example` → `.env` for local development.
- Always update `.env.example` when adding new environment variables.
- Key vars: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `FRONTEND_URL`, `NEXT_PUBLIC_BACKEND_URL`, `BACKEND_INTERNAL_URL`.
- Storage: `STORAGE_PROVIDER` (`"local"` or `"cloudflare"`), Cloudflare R2 config (`CLOUDFLARE_*`), `UPLOAD_DIRECTORY` for local.
- Optional services: Stripe, OpenAI, Resend (email), short link providers, newsletter integrations.

### Adding a Social Integration
Social platform integrations live under `libraries/nestjs-libraries/src/integrations/`. Each platform implements a shared interface for OAuth, posting, and analytics. Register the provider in the integrations module.

## Docs

- Main docs: https://docs.postiz.com/
- Developer guide: https://docs.postiz.com/developer-guide
- Public API: https://docs.postiz.com/public-api

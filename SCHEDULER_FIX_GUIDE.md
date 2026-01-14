# Postiz Scheduler Fix Guide

## What Happened?

Your Postiz scheduler stopped working because the **cron and workers processes died** inside the Docker container. 

### Your Current Setup

You're running Postiz as a **single Docker container** using **PM2** (Process Manager 2) to manage multiple Node.js processes:

```
┌─────────────────────────────────┐
│   Postiz Docker Container       │
│                                  │
│  ┌────────────────────────────┐ │
│  │         PM2                │ │
│  │  ┌──────────────────────┐ │ │
│  │  │  Frontend (Next.js)  │ │ │
│  │  └──────────────────────┘ │ │
│  │  ┌──────────────────────┐ │ │
│  │  │  Backend (NestJS)    │ │ │
│  │  └──────────────────────┘ │ │
│  │  ┌──────────────────────┐ │ │
│  │  │  Cron (Scheduler) ❌ │ │ │  <- DIED
│  │  └──────────────────────┘ │ │
│  │  ┌──────────────────────┐ │ │
│  │  │  Workers (Poster) ❌ │ │ │  <- DIED
│  │  └──────────────────────┘ │ │
│  └────────────────────────────┘ │
└─────────────────────────────────┘
```

### Why Did It Happen?

PM2 processes can crash due to:
1. **Unhandled exceptions** in the code
2. **Memory issues** (OOM - Out of Memory)
3. **Code changes/rebuilds** during tweaking
4. **Container restarts** without PM2 save
5. **Database connection issues**

When you were "tweaking" the code, you likely:
- Rebuilt the Docker image
- Restarted the container
- Made code changes that caused crashes

**Result:** You have **2,784 delayed jobs** in Redis waiting to be processed, but no workers to process them!

## Quick Fix (Immediate Solution)

### Step 1: Restart the Scheduler Processes

On your VPS, run:

```bash
cd ~/postiz-cleaner  # or wherever you have the scripts
chmod +x fix-scheduler-pm2.sh
./fix-scheduler-pm2.sh
```

This will:
- Find your Postiz container
- Restart the cron and workers PM2 processes
- Show you the current status
- Display recent logs

### Step 2: Verify It's Working

```bash
chmod +x check-scheduler-status.sh
./check-scheduler-status.sh
```

You should now see:
- ✅ Cron service running
- ✅ Workers service running
- Jobs being processed from the queue

### Step 3: Monitor in Real-Time

```bash
chmod +x monitor-scheduler.sh
./monitor-scheduler.sh
```

Watch for these log messages:
- `[CHECK MISSING QUEUES] Starting check...` (every hour)
- `[POST NOW PENDING] Starting check...` (every 16 minutes)
- `[WORKER] Processing post job:` (when posts are being published)
- `✅ Post X successfully published` (success!)

## Long-Term Solutions

### Option 1: Make PM2 Persistent (Recommended for Current Setup)

After fixing the scheduler, save the PM2 configuration:

```bash
docker exec postiz pm2 save
```

This ensures PM2 restarts all processes when the container restarts.

**Add to your container startup:**

Edit your Dockerfile or startup script to include:
```bash
pm2 resurrect  # Restore saved processes
```

### Option 2: Use Separate Docker Containers (Best Practice)

Instead of running everything in one container with PM2, split into separate containers:

```yaml
services:
  postiz-frontend:
    image: ghcr.io/jamesdunnington/postiz-app-custom:latest
    command: pnpm --filter ./apps/frontend run start
    
  postiz-backend:
    image: ghcr.io/jamesdunnington/postiz-app-custom:latest
    command: pnpm --filter ./apps/backend run start
    
  postiz-cron:
    image: ghcr.io/jamesdunnington/postiz-app-custom:latest
    command: pnpm --filter ./apps/cron run start
    restart: always  # Auto-restart if it crashes
    
  postiz-workers:
    image: ghcr.io/jamesdunnington/postiz-app-custom:latest
    command: pnpm --filter ./apps/workers run start
    restart: always  # Auto-restart if it crashes
```

**Benefits:**
- Each service can restart independently
- Better resource isolation
- Easier to scale (multiple workers)
- Clearer logs per service

### Option 3: Add Health Checks and Auto-Restart

Add PM2 auto-restart configuration inside the container:

```javascript
// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'cron',
      script: 'pnpm',
      args: '--filter ./apps/cron run start',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 4000,
    },
    {
      name: 'workers',
      script: 'pnpm',
      args: '--filter ./apps/workers run start',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 4000,
    },
    // ... other apps
  ]
};
```

## Preventing Future Issues

### 1. Monitor PM2 Processes

Create a cron job on your VPS to check PM2 status:

```bash
# Add to crontab: crontab -e
*/5 * * * * docker exec postiz pm2 list | grep -E "errored|stopped" && docker exec postiz pm2 restart all
```

### 2. Set Up Alerts

Use a monitoring service like:
- **UptimeRobot** - Free, checks if your site is up
- **Sentry** - Already integrated, monitors errors
- **PM2 Plus** - PM2's monitoring service

### 3. Regular Health Checks

Add this to your crontab:

```bash
# Check scheduler health every 15 minutes
*/15 * * * * /root/postiz-cleaner/check-scheduler-status.sh >> /var/log/postiz-health.log
```

### 4. Proper Deployment Process

When making code changes:

1. **Test locally first**
2. **Build new image:**
   ```bash
   docker build -t ghcr.io/jamesdunnington/postiz-app-custom:latest .
   ```
3. **Push to registry:**
   ```bash
   docker push ghcr.io/jamesdunnington/postiz-app-custom:latest
   ```
4. **On VPS, pull and restart:**
   ```bash
   docker pull ghcr.io/jamesdunnington/postiz-app-custom:latest
   docker-compose down
   docker-compose up -d
   ```
5. **Verify all PM2 processes started:**
   ```bash
   docker exec postiz pm2 list
   ```
6. **Save PM2 state:**
   ```bash
   docker exec postiz pm2 save
   ```

## Troubleshooting Commands

### Check PM2 Status
```bash
docker exec postiz pm2 list
```

### View PM2 Logs
```bash
docker exec postiz pm2 logs
docker exec postiz pm2 logs cron
docker exec postiz pm2 logs workers
```

### Restart Specific Process
```bash
docker exec postiz pm2 restart cron
docker exec postiz pm2 restart workers
```

### Restart All Processes
```bash
docker exec postiz pm2 restart all
```

### Check Memory Usage
```bash
docker exec postiz pm2 monit
```

### Clear PM2 Logs
```bash
docker exec postiz pm2 flush
```

### Check Redis Queue
```bash
docker exec postiz-redis redis-cli llen "bull:post:wait"
docker exec postiz-redis redis-cli zcard "bull:post:delayed"
```

### Check Database Connection
```bash
docker exec postiz-postgres psql -U postiz -d postiz -c "SELECT COUNT(*) FROM \"Post\" WHERE state = 'QUEUE';"
```

## Understanding the Logs

### Good Signs ✅
```
[CHECK MISSING QUEUES] Starting check for missing posts in next 3 hours...
[CHECK MISSING QUEUES] Found 50 scheduled posts in next 3 hours
[CHECK MISSING QUEUES] ✅ All posts are properly queued

[WORKER] Processing post job: { id: 'abc123' }
[PostsService] Starting post processing for ID: abc123
[PostsService] 📤 Attempting to post to pinterest...
[PostsService] ✅ Post abc123 successfully published to pinterest
```

### Warning Signs ⚠️
```
[CHECK MISSING QUEUES] ⚠️ Found 10 posts missing from queue, adding them...
[PostsService] ⚠️ Post abc123 - integration is disabled
[PostsService] ⚠️ Post abc123 - integration needs refresh
```

### Error Signs ❌
```
[WORKER] ❌ Error processing post: abc123
[PostsService] ❌ Post abc123 failed - no postId or releaseURL returned
Error: ECONNREFUSED - Cannot connect to database
PM2 error: Process cron has stopped
```

## Quick Reference

| Problem | Command | Expected Result |
|---------|---------|-----------------|
| Scheduler not running | `./fix-scheduler-pm2.sh` | Cron and workers restart |
| Check status | `./check-scheduler-status.sh` | Shows all services status |
| Monitor live | `./monitor-scheduler.sh` | Real-time logs |
| Jobs stuck in queue | Restart workers | Jobs start processing |
| PM2 process crashed | `docker exec postiz pm2 restart all` | All processes restart |

## Getting Help

If the scheduler still doesn't work after following this guide:

1. **Collect diagnostics:**
   ```bash
   ./check-scheduler-status.sh > scheduler-status.txt
   docker exec postiz pm2 list > pm2-status.txt
   docker exec postiz pm2 logs --lines 100 > pm2-logs.txt
   ```

2. **Check Sentry** for error details

3. **Verify environment variables** are correct

4. **Check database** for scheduled posts

5. **Review the detailed troubleshooting guide:** `SCHEDULER_TROUBLESHOOTING.md`

## Summary

**What you need to do NOW:**

1. ✅ Run `./fix-scheduler-pm2.sh` to restart the scheduler
2. ✅ Run `./check-scheduler-status.sh` to verify it's working
3. ✅ Run `docker exec postiz pm2 save` to persist the configuration
4. ✅ Monitor logs for a few minutes to ensure posts are being processed
5. ✅ Set up monitoring to prevent this from happening again

**Your 2,784 delayed jobs should start processing immediately!**

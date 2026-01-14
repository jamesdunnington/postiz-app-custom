# 🚨 QUICK FIX: Postiz Scheduler Not Posting

## TL;DR - Fix It NOW

Your scheduler stopped working because the **cron and workers PM2 processes died** inside your Docker container. You have **2,784 jobs waiting** in Redis!

### On Your VPS, Run These Commands:

```bash
cd ~/postiz-cleaner

# 1. Fix the scheduler (restart cron and workers)
chmod +x fix-scheduler-pm2.sh
./fix-scheduler-pm2.sh

# 2. Verify it's working
./check-scheduler-status.sh

# 3. Save PM2 configuration (so it persists)
docker exec postiz pm2 save

# 4. Monitor to confirm posts are being processed
./monitor-scheduler.sh
```

**That's it!** Your scheduler should start processing the 2,784 queued posts immediately.

---

## What Happened?

Your Postiz runs as a **single Docker container** using **PM2** to manage 4 processes:
- ✅ Frontend (working)
- ✅ Backend (working)  
- ❌ **Cron** (died - this checks for scheduled posts)
- ❌ **Workers** (died - this publishes posts to social media)

When you were "tweaking" the code, the cron and workers processes crashed and didn't restart.

---

## Files Created for You

I've created several helper scripts and guides:

### 🔧 Fix Scripts (Use These)
- **`fix-scheduler-pm2.sh`** - Restarts cron and workers processes
- **`check-scheduler-status.sh`** - Checks if everything is running
- **`monitor-scheduler.sh`** - Live monitoring of scheduler logs
- **`diagnose-scheduler.ps1`** - Windows PowerShell diagnostic tool

### 📚 Documentation
- **`SCHEDULER_FIX_GUIDE.md`** - Complete explanation and solutions
- **`SCHEDULER_TROUBLESHOOTING.md`** - Detailed troubleshooting guide
- **`QUICK_FIX_README.md`** - This file

---

## Verify It's Working

After running the fix script, you should see:

```bash
✅ Cron service: postiz (via PM2)
✅ Workers service: postiz (via PM2)
✅ Redis: postiz-redis
✅ PostgreSQL: postiz-postgres

Queue Statistics:
- Waiting jobs: 0
- Active jobs: 5
- Delayed jobs: 2779  # This number should decrease over time
```

Watch the logs for these messages:
```
[CHECK MISSING QUEUES] Starting check for missing posts...
[WORKER] Processing post job: { id: 'abc123' }
[PostsService] 📤 Attempting to post to pinterest...
✅ Post abc123 successfully published to pinterest
```

---

## Prevent This From Happening Again

### Option 1: Quick Fix (Do This Now)
After fixing, save PM2 state:
```bash
docker exec postiz pm2 save
```

### Option 2: Add Monitoring (Recommended)
Set up a cron job to auto-restart if processes die:
```bash
# Add to crontab: crontab -e
*/5 * * * * docker exec postiz pm2 list | grep -E "errored|stopped" && docker exec postiz pm2 restart all
```

### Option 3: Better Architecture (Long-term)
Split into separate Docker containers (see `SCHEDULER_FIX_GUIDE.md`)

---

## Common Issues

### "No cron/workers found"
**Solution:** Run `./fix-scheduler-pm2.sh`

### "Jobs not processing"
**Solution:** 
```bash
docker exec postiz pm2 restart workers
docker exec postiz pm2 logs workers
```

### "Processes keep dying"
**Solution:** Check for errors:
```bash
docker exec postiz pm2 logs cron --err
docker exec postiz pm2 logs workers --err
```

### "Out of memory"
**Solution:** Increase container memory or add swap:
```bash
docker update --memory 2g postiz
```

---

## Quick Commands Reference

```bash
# Check PM2 status
docker exec postiz pm2 list

# View logs
docker exec postiz pm2 logs

# Restart specific process
docker exec postiz pm2 restart cron
docker exec postiz pm2 restart workers

# Restart all
docker exec postiz pm2 restart all

# Check queue
docker exec postiz-redis redis-cli zcard "bull:post:delayed"

# Monitor live
./monitor-scheduler.sh
```

---

## Need More Help?

1. **Read the detailed guide:** `SCHEDULER_FIX_GUIDE.md`
2. **Check troubleshooting:** `SCHEDULER_TROUBLESHOOTING.md`
3. **View Sentry errors:** Check your Sentry dashboard
4. **Collect diagnostics:**
   ```bash
   ./check-scheduler-status.sh > status.txt
   docker exec postiz pm2 logs --lines 200 > logs.txt
   ```

---

## Summary of Changes Made

I've added comprehensive logging to help you diagnose issues:

### Code Changes:
1. ✅ Added Sentry logging to all cron tasks
2. ✅ Added detailed logging to workers
3. ✅ Added logging to PostsService
4. ✅ All errors now sent to Sentry with context

### Scripts Created:
1. ✅ `fix-scheduler-pm2.sh` - Fix script
2. ✅ `check-scheduler-status.sh` - Status checker
3. ✅ `monitor-scheduler.sh` - Live monitor
4. ✅ `diagnose-scheduler.ps1` - Windows diagnostic

### Documentation:
1. ✅ `SCHEDULER_FIX_GUIDE.md` - Complete guide
2. ✅ `SCHEDULER_TROUBLESHOOTING.md` - Troubleshooting
3. ✅ `QUICK_FIX_README.md` - This file

---

## Next Steps

1. ✅ **Run the fix script** (see commands at top)
2. ✅ **Verify it's working** (check logs)
3. ✅ **Save PM2 state** (`docker exec postiz pm2 save`)
4. ✅ **Set up monitoring** (prevent future issues)
5. ✅ **Commit and push** these changes to your repo

**Your scheduler should be working now! 🎉**

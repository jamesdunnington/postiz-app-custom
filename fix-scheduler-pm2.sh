#!/bin/bash

# Fix Postiz Scheduler by Restarting PM2 Processes
# This script restarts the cron and workers processes inside the Postiz container

echo "========================================"
echo "Postiz Scheduler PM2 Fix Script"
echo "========================================"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Find the Postiz container
POSTIZ_CONTAINER=$(docker ps --filter "name=postiz" --format "{{.Names}}" | grep -v postgres | grep -v redis | head -n 1)

if [ -z "$POSTIZ_CONTAINER" ]; then
    echo -e "${RED}❌ Postiz container not found!${NC}"
    echo "Please make sure the Postiz container is running."
    exit 1
fi

echo -e "${GREEN}✅ Found Postiz container: $POSTIZ_CONTAINER${NC}"
echo ""

# Check current PM2 status
echo -e "${YELLOW}1. Checking current PM2 processes...${NC}"
docker exec $POSTIZ_CONTAINER pm2 list

echo ""
echo -e "${YELLOW}2. Checking which processes are running...${NC}"
CRON_STATUS=$(docker exec $POSTIZ_CONTAINER pm2 list | grep cron | awk '{print $12}')
WORKERS_STATUS=$(docker exec $POSTIZ_CONTAINER pm2 list | grep workers | awk '{print $12}')
BACKEND_STATUS=$(docker exec $POSTIZ_CONTAINER pm2 list | grep backend | awk '{print $12}')
FRONTEND_STATUS=$(docker exec $POSTIZ_CONTAINER pm2 list | grep frontend | awk '{print $12}')

echo "   - Cron: $CRON_STATUS"
echo "   - Workers: $WORKERS_STATUS"
echo "   - Backend: $BACKEND_STATUS"
echo "   - Frontend: $FRONTEND_STATUS"

echo ""
echo -e "${YELLOW}3. Restarting cron and workers processes...${NC}"

# Restart cron
echo -e "${CYAN}   Restarting cron...${NC}"
docker exec $POSTIZ_CONTAINER pm2 restart cron 2>&1
if [ $? -eq 0 ]; then
    echo -e "${GREEN}   ✅ Cron restarted successfully${NC}"
else
    echo -e "${RED}   ❌ Failed to restart cron${NC}"
    echo -e "${YELLOW}   Trying to start cron...${NC}"
    docker exec $POSTIZ_CONTAINER sh -c "cd /app/apps/cron && pm2 start pnpm --name cron -- start"
fi

# Restart workers
echo -e "${CYAN}   Restarting workers...${NC}"
docker exec $POSTIZ_CONTAINER pm2 restart workers 2>&1
if [ $? -eq 0 ]; then
    echo -e "${GREEN}   ✅ Workers restarted successfully${NC}"
else
    echo -e "${RED}   ❌ Failed to restart workers${NC}"
    echo -e "${YELLOW}   Trying to start workers...${NC}"
    docker exec $POSTIZ_CONTAINER sh -c "cd /app/apps/workers && pm2 start pnpm --name workers -- start"
fi

echo ""
echo -e "${YELLOW}4. Waiting 5 seconds for processes to start...${NC}"
sleep 5

echo ""
echo -e "${YELLOW}5. Checking PM2 status after restart...${NC}"
docker exec $POSTIZ_CONTAINER pm2 list

echo ""
echo -e "${YELLOW}6. Checking recent cron logs...${NC}"
docker exec $POSTIZ_CONTAINER pm2 logs cron --lines 20 --nostream

echo ""
echo -e "${YELLOW}7. Checking recent workers logs...${NC}"
docker exec $POSTIZ_CONTAINER pm2 logs workers --lines 20 --nostream

echo ""
echo -e "${YELLOW}8. Checking Redis queue status...${NC}"
REDIS_CONTAINER=$(docker ps --filter "name=redis" --format "{{.Names}}" | head -n 1)
if [ ! -z "$REDIS_CONTAINER" ]; then
    WAITING=$(docker exec $REDIS_CONTAINER redis-cli llen "bull:post:wait" 2>&1)
    ACTIVE=$(docker exec $REDIS_CONTAINER redis-cli llen "bull:post:active" 2>&1)
    DELAYED=$(docker exec $REDIS_CONTAINER redis-cli zcard "bull:post:delayed" 2>&1)
    
    echo -e "${CYAN}   Queue Statistics:${NC}"
    echo "   - Waiting jobs: $WAITING"
    echo "   - Active jobs: $ACTIVE"
    echo "   - Delayed jobs: $DELAYED"
fi

echo ""
echo "========================================"
echo -e "${CYAN}Summary${NC}"
echo "========================================"
echo ""
echo -e "${GREEN}✅ Scheduler processes have been restarted${NC}"
echo ""
echo "Next steps:"
echo "1. Monitor the logs to see if posts are being processed:"
echo "   docker exec $POSTIZ_CONTAINER pm2 logs"
echo ""
echo "2. Check specific process logs:"
echo "   docker exec $POSTIZ_CONTAINER pm2 logs cron"
echo "   docker exec $POSTIZ_CONTAINER pm2 logs workers"
echo ""
echo "3. If issues persist, check the full troubleshooting guide:"
echo "   See SCHEDULER_TROUBLESHOOTING.md"
echo ""
echo "4. To save PM2 configuration (so it persists on restart):"
echo "   docker exec $POSTIZ_CONTAINER pm2 save"
echo ""

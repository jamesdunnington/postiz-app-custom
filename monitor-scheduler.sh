#!/bin/bash

# Monitor Postiz Scheduler in Real-Time
# This script shows live logs from cron and workers processes

echo "========================================"
echo "Postiz Scheduler Live Monitor"
echo "========================================"
echo ""
echo "Press Ctrl+C to stop monitoring"
echo ""

# Colors
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Find the Postiz container
POSTIZ_CONTAINER=$(docker ps --filter "name=postiz" --format "{{.Names}}" | grep -v postgres | grep -v redis | head -n 1)

if [ -z "$POSTIZ_CONTAINER" ]; then
    echo "❌ Postiz container not found!"
    exit 1
fi

echo -e "${CYAN}Monitoring PM2 logs from: $POSTIZ_CONTAINER${NC}"
echo ""

# Monitor PM2 logs
docker exec -it $POSTIZ_CONTAINER pm2 logs

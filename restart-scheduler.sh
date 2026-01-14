#!/bin/bash

# Quick script to restart scheduler services on VPS
# Run this if the scheduler is not working

echo "========================================"
echo "Restarting Postiz Scheduler Services"
echo "========================================"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Find containers
CRON_CONTAINER=$(docker ps -a --filter "name=cron" --format "{{.Names}}" | head -n 1)
WORKERS_CONTAINER=$(docker ps -a --filter "name=worker" --format "{{.Names}}" | head -n 1)
REDIS_CONTAINER=$(docker ps -a --filter "name=redis" --format "{{.Names}}" | head -n 1)

echo -e "${YELLOW}Found containers:${NC}"
if [ ! -z "$CRON_CONTAINER" ]; then
    echo -e "${GREEN}  Cron: $CRON_CONTAINER${NC}"
else
    echo -e "${RED}  Cron: Not found${NC}"
fi

if [ ! -z "$WORKERS_CONTAINER" ]; then
    echo -e "${GREEN}  Workers: $WORKERS_CONTAINER${NC}"
else
    echo -e "${RED}  Workers: Not found${NC}"
fi

if [ ! -z "$REDIS_CONTAINER" ]; then
    echo -e "${GREEN}  Redis: $REDIS_CONTAINER${NC}"
else
    echo -e "${RED}  Redis: Not found${NC}"
fi
echo ""

# Restart services
if [ ! -z "$CRON_CONTAINER" ]; then
    echo -e "${YELLOW}Restarting cron service...${NC}"
    docker restart $CRON_CONTAINER
    echo -e "${GREEN}✅ Cron service restarted${NC}"
else
    echo -e "${RED}❌ Cron container not found - you need to start it first${NC}"
fi

if [ ! -z "$WORKERS_CONTAINER" ]; then
    echo -e "${YELLOW}Restarting workers service...${NC}"
    docker restart $WORKERS_CONTAINER
    echo -e "${GREEN}✅ Workers service restarted${NC}"
else
    echo -e "${RED}❌ Workers container not found - you need to start it first${NC}"
fi

if [ ! -z "$REDIS_CONTAINER" ]; then
    echo -e "${YELLOW}Restarting Redis...${NC}"
    docker restart $REDIS_CONTAINER
    echo -e "${GREEN}✅ Redis restarted${NC}"
fi

echo ""
echo "========================================"
echo -e "${CYAN}Services restarted!${NC}"
echo "========================================"
echo ""
echo -e "${YELLOW}Monitor the logs with:${NC}"
if [ ! -z "$CRON_CONTAINER" ]; then
    echo -e "${CYAN}  docker logs -f $CRON_CONTAINER${NC}"
fi
if [ ! -z "$WORKERS_CONTAINER" ]; then
    echo -e "${CYAN}  docker logs -f $WORKERS_CONTAINER${NC}"
fi
echo ""
echo -e "${YELLOW}Wait 1-2 minutes and check if posts are being processed.${NC}"
echo ""

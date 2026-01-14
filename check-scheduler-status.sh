#!/bin/bash

# Postiz Scheduler Status Check Script for VPS
# This script checks if the scheduler is working properly

echo "========================================"
echo "Postiz Scheduler Status Check"
echo "========================================"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Check Docker
echo -e "${YELLOW}1. Checking Docker...${NC}"
if ! command -v docker &> /dev/null; then
    echo -e "${RED}   ❌ Docker is not installed${NC}"
    exit 1
fi
echo -e "${GREEN}   ✅ Docker is installed${NC}"

# List all containers
echo ""
echo -e "${YELLOW}2. Running containers:${NC}"
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"

# Check for required containers
echo ""
echo -e "${YELLOW}3. Checking required services...${NC}"

CRON_CONTAINER=$(docker ps --filter "name=cron" --format "{{.Names}}" | head -n 1)
WORKERS_CONTAINER=$(docker ps --filter "name=worker" --format "{{.Names}}" | head -n 1)
REDIS_CONTAINER=$(docker ps --filter "name=redis" --format "{{.Names}}" | head -n 1)
POSTGRES_CONTAINER=$(docker ps --filter "name=postgres" --format "{{.Names}}" | head -n 1)

if [ -z "$CRON_CONTAINER" ]; then
    echo -e "${RED}   ❌ Cron service not found!${NC}"
    echo -e "${YELLOW}      The scheduler requires a cron service.${NC}"
    MISSING_SERVICES=true
else
    echo -e "${GREEN}   ✅ Cron service: $CRON_CONTAINER${NC}"
fi

if [ -z "$WORKERS_CONTAINER" ]; then
    echo -e "${RED}   ❌ Workers service not found!${NC}"
    echo -e "${YELLOW}      The scheduler requires a workers service.${NC}"
    MISSING_SERVICES=true
else
    echo -e "${GREEN}   ✅ Workers service: $WORKERS_CONTAINER${NC}"
fi

if [ -z "$REDIS_CONTAINER" ]; then
    echo -e "${RED}   ❌ Redis not found!${NC}"
    MISSING_SERVICES=true
else
    echo -e "${GREEN}   ✅ Redis: $REDIS_CONTAINER${NC}"
fi

if [ -z "$POSTGRES_CONTAINER" ]; then
    echo -e "${RED}   ❌ PostgreSQL not found!${NC}"
    MISSING_SERVICES=true
else
    echo -e "${GREEN}   ✅ PostgreSQL: $POSTGRES_CONTAINER${NC}"
fi

# Check Redis connectivity
if [ ! -z "$REDIS_CONTAINER" ]; then
    echo ""
    echo -e "${YELLOW}4. Testing Redis connection...${NC}"
    REDIS_PING=$(docker exec $REDIS_CONTAINER redis-cli ping 2>&1)
    if [[ "$REDIS_PING" == "PONG" ]]; then
        echo -e "${GREEN}   ✅ Redis is responding${NC}"
    else
        echo -e "${RED}   ❌ Redis is not responding: $REDIS_PING${NC}"
    fi
fi

# Check Redis queues
if [ ! -z "$REDIS_CONTAINER" ]; then
    echo ""
    echo -e "${YELLOW}5. Checking job queues in Redis...${NC}"
    
    WAITING=$(docker exec $REDIS_CONTAINER redis-cli llen "bull:post:wait" 2>&1)
    ACTIVE=$(docker exec $REDIS_CONTAINER redis-cli llen "bull:post:active" 2>&1)
    DELAYED=$(docker exec $REDIS_CONTAINER redis-cli zcard "bull:post:delayed" 2>&1)
    
    echo -e "${CYAN}   Queue Statistics:${NC}"
    echo "   - Waiting jobs: $WAITING"
    echo "   - Active jobs: $ACTIVE"
    echo "   - Delayed jobs: $DELAYED"
    
    if [ "$WAITING" = "0" ] && [ "$ACTIVE" = "0" ] && [ "$DELAYED" = "0" ]; then
        echo -e "${YELLOW}   ⚠️  No jobs in queue - this could be normal if no posts are scheduled${NC}"
    fi
fi

# Check cron logs
if [ ! -z "$CRON_CONTAINER" ]; then
    echo ""
    echo -e "${YELLOW}6. Recent cron activity (last 30 lines):${NC}"
    echo -e "${CYAN}   Looking for scheduler checks...${NC}"
    docker logs --tail 30 $CRON_CONTAINER 2>&1 | grep -E "CHECK MISSING|POST NOW PENDING|DUPLICATE CHECK|STARTUP CHECK" || echo "   No scheduler activity found in recent logs"
fi

# Check workers logs
if [ ! -z "$WORKERS_CONTAINER" ]; then
    echo ""
    echo -e "${YELLOW}7. Recent worker activity (last 30 lines):${NC}"
    echo -e "${CYAN}   Looking for post processing...${NC}"
    docker logs --tail 30 $WORKERS_CONTAINER 2>&1 | grep -E "WORKER|PostsService|processing" || echo "   No worker activity found in recent logs"
fi

# Summary
echo ""
echo "========================================"
echo -e "${CYAN}Summary & Recommendations${NC}"
echo "========================================"
echo ""

if [ ! -z "$MISSING_SERVICES" ]; then
    echo -e "${RED}CRITICAL ISSUES FOUND:${NC}"
    echo ""
    if [ -z "$CRON_CONTAINER" ]; then
        echo -e "${RED}❌ Cron service is not running${NC}"
        echo "   Action: Start the cron service"
        echo "   Command: docker-compose up -d cron"
        echo ""
    fi
    if [ -z "$WORKERS_CONTAINER" ]; then
        echo -e "${RED}❌ Workers service is not running${NC}"
        echo "   Action: Start the workers service"
        echo "   Command: docker-compose up -d workers"
        echo ""
    fi
    if [ -z "$REDIS_CONTAINER" ]; then
        echo -e "${RED}❌ Redis is not running${NC}"
        echo "   Action: Start Redis"
        echo "   Command: docker-compose up -d redis"
        echo ""
    fi
else
    echo -e "${GREEN}✅ All required services are running${NC}"
    echo ""
    echo "Next steps to diagnose:"
    echo "1. Check if posts are scheduled in the database"
    echo "2. Verify integrations are connected and enabled"
    echo "3. Monitor logs in real-time:"
    if [ ! -z "$CRON_CONTAINER" ]; then
        echo "   docker logs -f $CRON_CONTAINER"
    fi
    if [ ! -z "$WORKERS_CONTAINER" ]; then
        echo "   docker logs -f $WORKERS_CONTAINER"
    fi
fi

echo ""
echo -e "${CYAN}For detailed troubleshooting, see: SCHEDULER_TROUBLESHOOTING.md${NC}"
echo ""

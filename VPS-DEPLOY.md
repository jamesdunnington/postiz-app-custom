# Quick Deployment Guide for VPS

## 🚀 Fast Setup on Your Docker VPS

### Step 1: Authenticate with GitHub Container Registry

Only needed if your repository is private:

```bash
# Use your GitHub Personal Access Token
docker login ghcr.io -u jamesdunnington -p YOUR_GITHUB_TOKEN
```

### Step 2: Create docker-compose.yml on your VPS

```bash
# Create a new directory
mkdir postiz-custom
cd postiz-custom

# Create docker-compose.yml
nano docker-compose.yml
```

Paste this minimal configuration:

```yaml
version: '3.8'

services:
  postiz:
    image: ghcr.io/jamesdunnington/postiz-app-custom:latest
    container_name: postiz
    restart: unless-stopped
    ports:
      - "3000:3000"
      - "4200:4200"
    environment:
      - BACKEND_URL=http://localhost:4200
      - FRONTEND_URL=http://localhost:3000
      - NEXT_PUBLIC_BACKEND_URL=http://localhost:4200
      - DATABASE_URL=postgresql://postiz:password123@postgres:5432/postiz
      - REDIS_URL=redis://redis:6379
      - JWT_SECRET=change-this-to-random-secret
      - PINTEREST_CLIENT_ID=your_client_id
      - PINTEREST_CLIENT_SECRET=your_client_secret
    depends_on:
      - postgres
      - redis

  postgres:
    image: postgres:15-alpine
    environment:
      - POSTGRES_DB=postiz
      - POSTGRES_USER=postiz
      - POSTGRES_PASSWORD=password123
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data

volumes:
  postgres_data:
  redis_data:
```

### Step 3: Start the Application

```bash
docker-compose up -d
```

### Step 4: Check Status

```bash
# View running containers
docker-compose ps

# View logs
docker-compose logs -f postiz
```

## 🔄 Updating to Latest Version

When a new version is built (after you push to GitHub):

```bash
cd postiz-custom

# Pull latest image
docker-compose pull postiz

# Recreate container with new image
docker-compose up -d --force-recreate postiz

# Verify update
docker-compose logs -f postiz
```

## 📊 Monitoring GitHub Actions

Check build status:
1. Go to: https://github.com/jamesdunnington/postiz-app-custom/actions
2. Look for "Build and Push Docker Image" workflow
3. Wait for green checkmark ✅

## 🌐 Accessing Your Application

- Frontend: http://your-vps-ip:3000
- Backend API: http://your-vps-ip:4200

## 🔐 Production Security Checklist

Before going live:

- [ ] Change `JWT_SECRET` to a random string
- [ ] Update `DATABASE_URL` password
- [ ] Set up a reverse proxy (nginx/traefik)
- [ ] Configure SSL certificates
- [ ] Update URLs to your domain
- [ ] Set up firewall rules
- [ ] Configure backups for postgres_data volume

## 🐛 Common Issues

**Container won't start:**
```bash
docker-compose logs postiz
```

**Database connection issues:**
```bash
docker-compose restart postgres
docker-compose restart postiz
```

**Pull image fails:**
```bash
# Re-authenticate
docker logout ghcr.io
docker login ghcr.io -u jamesdunnington -p YOUR_TOKEN
```

## 📝 Available Image Tags

- `latest` - Most recent build from main branch (recommended)
- `main` - Current main branch
- `main-<sha>` - Specific commit version

Example:
```yaml
image: ghcr.io/jamesdunnington/postiz-app-custom:latest
# or
image: ghcr.io/jamesdunnington/postiz-app-custom:main-a1b2c3d
```

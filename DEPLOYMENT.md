# Postiz App - Custom Build with Pinterest Improvements

This is a customized version of Postiz with enhanced Pinterest integration features.

## 🎯 Custom Features

### Pinterest Improvements
- ✅ **Base64 Image Upload**: More reliable image posting using base64 encoding instead of URL references
- ✅ **Outbound Clicks Analytics**: Track actual clicks to your website/links (replacing pin click rate)
- ✅ **Tentative Data Visualization**: Latest 2 days of analytics show with dotted lines (matching Pinterest's UI)

## 🚀 Automated Docker Builds

This repository automatically builds Docker images on every push using GitHub Actions. The images are published to GitHub Container Registry (GHCR).

### How It Works

1. **Automatic Builds**: Every push to `main` branch triggers a Docker build
2. **GitHub Container Registry**: Images are pushed to `ghcr.io/jamesdunnington/postiz-app-custom`
3. **Multiple Tags**: Each build creates tags for:
   - `latest` - Always points to the most recent main branch build
   - `main` - Current main branch
   - `main-<commit-sha>` - Specific commit version
   - `v*` - Semantic version tags (if you create git tags)

## 📦 Deployment on Your VPS

### Option 1: Using Pre-built Images (Recommended)

1. **Authenticate with GitHub Container Registry** (if repo is private):
   ```bash
   # Create a GitHub Personal Access Token with 'read:packages' scope
   # Go to: https://github.com/settings/tokens
   
   docker login ghcr.io -u jamesdunnington -p YOUR_GITHUB_TOKEN
   ```

2. **Pull the latest image**:
   ```bash
   docker pull ghcr.io/jamesdunnington/postiz-app-custom:latest
   ```

3. **Use the provided docker-compose file**:
   ```bash
   # Copy the sample compose file
   cp docker-compose.ghcr.yml docker-compose.yml
   
   # Edit with your environment variables
   nano docker-compose.yml
   
   # Start the services
   docker-compose up -d
   ```

### Option 2: Quick Update Command

To update to the latest version on your VPS:

```bash
# Pull latest image
docker-compose pull postiz

# Restart with new image
docker-compose up -d --force-recreate postiz
```

## 🔧 Environment Variables

Make sure to configure these essential environment variables in your `docker-compose.yml`:

```yaml
environment:
  # URLs
  - BACKEND_URL=http://your-domain.com:4200
  - FRONTEND_URL=http://your-domain.com:3000
  - NEXT_PUBLIC_BACKEND_URL=http://your-domain.com:4200
  
  # Database
  - DATABASE_URL=postgresql://postiz:password@postgres:5432/postiz
  
  # Redis
  - REDIS_URL=redis://redis:6379
  
  # Security
  - JWT_SECRET=your-super-secret-jwt-key
  
  # Pinterest (for the custom features)
  - PINTEREST_CLIENT_ID=your_client_id
  - PINTEREST_CLIENT_SECRET=your_client_secret
```

## 🏗️ Development Setup

If you want to build locally or contribute:

```bash
# Clone the repository
git clone https://github.com/jamesdunnington/postiz-app-custom.git
cd postiz-app-custom

# Install dependencies
pnpm install

# Copy environment file
cp .env.example .env

# Start development
pnpm run dev
```

## 📋 Docker Image Tags

Available image tags:
- `ghcr.io/jamesdunnington/postiz-app-custom:latest` - Latest stable build
- `ghcr.io/jamesdunnington/postiz-app-custom:main` - Current main branch
- `ghcr.io/jamesdunnington/postiz-app-custom:main-<sha>` - Specific commit

## 🔄 Triggering a New Build

New builds are automatically triggered when you:
1. Push to the `main` branch
2. Create a new tag (e.g., `git tag v1.0.0 && git push --tags`)
3. Manually trigger from GitHub Actions tab

## 📊 Monitoring Builds

Check build status at:
- GitHub Actions: https://github.com/jamesdunnington/postiz-app-custom/actions
- Container Registry: https://github.com/jamesdunnington/postiz-app-custom/pkgs/container/postiz-app-custom

## 🐛 Troubleshooting

### Image Pull Authentication Failed
```bash
# Create a GitHub Personal Access Token with 'read:packages' scope
docker login ghcr.io -u jamesdunnington -p YOUR_GITHUB_TOKEN
```

### Container Won't Start
```bash
# Check logs
docker-compose logs -f postiz

# Verify environment variables
docker-compose config
```

### Pinterest Features Not Working
- Verify `PINTEREST_CLIENT_ID` and `PINTEREST_CLIENT_SECRET` are set
- Check that scopes include: `boards:read`, `boards:write`, `pins:read`, `pins:write`, `user_accounts:read`

## 📝 Credits

Based on [Postiz](https://github.com/gitroomhq/postiz-app) - Open source social media scheduling tool.

Custom improvements by James Dunnington.

## 📄 License

AGPL-3.0 (same as upstream Postiz project)

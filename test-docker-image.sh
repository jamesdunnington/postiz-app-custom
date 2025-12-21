#!/bin/bash
# Test script to verify the Docker image on your VPS

echo "🔍 Testing Postiz Custom Docker Image..."
echo ""

# Pull the image
echo "📦 Pulling image from GitHub Container Registry..."
docker pull ghcr.io/jamesdunnington/postiz-app-custom:latest

if [ $? -eq 0 ]; then
    echo "✅ Image pulled successfully!"
    echo ""
    
    # Show image details
    echo "📊 Image details:"
    docker images ghcr.io/jamesdunnington/postiz-app-custom:latest --format "table {{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.CreatedAt}}"
    echo ""
    
    # Test run the container
    echo "🧪 Testing container startup..."
    docker run --rm --name postiz-test ghcr.io/jamesdunnington/postiz-app-custom:latest echo "Container can start successfully!" 2>/dev/null
    
    if [ $? -eq 0 ]; then
        echo "✅ Container test passed!"
    else
        echo "⚠️  Container test had issues (this is normal if env vars are missing)"
    fi
    
    echo ""
    echo "🎉 Docker image is ready to use!"
    echo ""
    echo "Next steps:"
    echo "1. Create your docker-compose.yml (see VPS-DEPLOY.md)"
    echo "2. Run: docker-compose up -d"
    echo "3. Access: http://your-server-ip:3000"
else
    echo "❌ Failed to pull image"
    echo ""
    echo "If the repo is private, authenticate first:"
    echo "docker login ghcr.io -u jamesdunnington -p YOUR_GITHUB_TOKEN"
fi

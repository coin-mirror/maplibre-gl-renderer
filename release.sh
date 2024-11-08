# !/bin/bash

set -e

# Check if version argument is provided
if [ -z "$1" ]; then
    echo "Please provide version as argument"
    echo "Example: ./release.sh v1.0.0" 
    exit 1
fi

VERSION=$1

# Login to GitHub Container Registry
echo "Logging into GitHub Container Registry..."
if ! docker login ghcr.io; then
    echo "Login failed"
    exit 1
fi

# Multi-Platform Build with BuildX
echo "Starting multi-platform build for version ${VERSION}..."
docker buildx create --use
docker buildx build \
    --platform linux/amd64,linux/arm64 \
    --tag ghcr.io/coin-mirror/maplibre-gl-renderer:${VERSION} \
    --push \
    .

echo "Build and push for version ${VERSION} completed successfully!"


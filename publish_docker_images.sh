#!/bin/bash
set -euo pipefail

# Image version is the first line of VERSION (keep in sync with package.json "version").
VERSION="$(tr -d '[:space:]' < VERSION)"
REGISTRY="ghcr.io/jgilman1337"

# 1. Login (PAT with write:packages, or: gh auth token | docker login ghcr.io -u USERNAME --password-stdin)
echo "$GITHUB_TOKEN" | docker login ghcr.io -u jgilman1337 --password-stdin

# 2. Name images for the registry
docker tag "browser_source-node:${VERSION}" "${REGISTRY}/browser_source-node:${VERSION}"
docker tag browser_source-node:latest "${REGISTRY}/browser_source-node:latest"
docker tag "browser_source-bun:${VERSION}" "${REGISTRY}/browser_source-bun:${VERSION}"
docker tag browser_source-bun:latest "${REGISTRY}/browser_source-bun:latest"

# 3. Push
docker push "${REGISTRY}/browser_source-node:${VERSION}"
docker push "${REGISTRY}/browser_source-node:latest"
docker push "${REGISTRY}/browser_source-bun:${VERSION}"
docker push "${REGISTRY}/browser_source-bun:latest"

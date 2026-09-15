#!/bin/bash
set -euo pipefail

# Image version is the first line of VERSION (keep in sync with package.json "version").
VERSION="$(tr -d '[:space:]' < VERSION)"
REGISTRY="ghcr.io/jgilman1337"
GHCR_USER="jgilman1337"

# 1. Login — token from the environment, or `gh auth token`. docker login cannot prompt in this script.
# GHCR username must match the token owner. Namespace stays ghcr.io/jgilman1337/...
TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
if [[ -z "${TOKEN}" ]] && command -v gh >/dev/null 2>&1; then
	TOKEN="$(gh auth token 2>/dev/null || true)"
fi
if [[ -z "${TOKEN}" ]]; then
	echo "No GitHub token. Export GITHUB_TOKEN (PAT with write:packages) or run: gh auth login" >&2
	exit 1
fi

# Confirm the token works and learn its GitHub username (GHCR login user).
TOKEN_USER="$(
	curl -fsS -H "Authorization: Bearer ${TOKEN}" -H "Accept: application/vnd.github+json" https://api.github.com/user \
		| python3 -c "import json,sys; print(json.load(sys.stdin)['login'])" 2>/dev/null || true
)"
if [[ -z "${TOKEN_USER}" ]]; then
	echo "GitHub token is invalid or expired (API /user failed)." >&2
	echo "Active gh account may be stale. Re-auth as ${GHCR_USER}:" >&2
	echo "  gh auth logout -h github.com -u ${GHCR_USER}" >&2
	echo "  gh auth login -h github.com" >&2
	echo "Scopes needed: write:packages (and repo if the package is tied to a private repo)." >&2
	exit 1
fi
if [[ "${TOKEN_USER}" != "${GHCR_USER}" ]]; then
	echo "Token belongs to '${TOKEN_USER}', but images publish under ghcr.io/${GHCR_USER}/" >&2
	echo "Log in as ${GHCR_USER}:  gh auth login -h github.com" >&2
	exit 1
fi

# Classic PATs advertise scopes in X-OAuth-Scopes. Fine-grained tokens often omit this header.
OAUTH_SCOPES="$(
	curl -fsSI -H "Authorization: Bearer ${TOKEN}" -H "Accept: application/vnd.github+json" https://api.github.com/user \
		| tr -d '\r' | awk -F': ' 'tolower($1)=="x-oauth-scopes" {print $2}'
)"
if [[ -n "${OAUTH_SCOPES}" && "${OAUTH_SCOPES}" != *write:packages* ]]; then
	echo "Token scopes are [${OAUTH_SCOPES}] — GHCR push needs write:packages." >&2
	echo "  gh auth refresh -h github.com -s write:packages -s read:packages" >&2
	echo "Or create a classic PAT with write:packages (and repo if this GitHub repo is private)." >&2
	exit 1
fi

echo "Logging in to ghcr.io as ${TOKEN_USER}" >&2
echo "${TOKEN}" | docker login ghcr.io -u "${TOKEN_USER}" --password-stdin

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

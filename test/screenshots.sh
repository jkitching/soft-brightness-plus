#!/usr/bin/env bash
# Screenshot runner: builds a Docker image and captures docs screenshots
# inside a reproducible GNOME Shell environment.
# Usage: test/screenshots.sh
# Output: updates docs/preferences.png and docs/soft-brightness-plus.png
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
IMAGE="sbp-screenshots"
ZIP="${REPO_ROOT}/build/extension.zip"

command -v docker >/dev/null 2>&1 || { echo "ERROR: docker not found in PATH"; exit 1; }

if [ ! -f "${ZIP}" ]; then
    echo "Building extension zip..."
    make -C "${REPO_ROOT}" zip
fi

echo "Building screenshot container..."
docker build -t "${IMAGE}" "${REPO_ROOT}/test/screenshots/" --quiet

echo "Running screenshots..."
docker run --rm \
    -v "${ZIP}:/ext.zip:ro" \
    -v "${REPO_ROOT}/docs:/docs" \
    "${IMAGE}" \
    /run-screenshots.sh

echo ""
echo "Done. Updated:"
echo "  docs/preferences.png"
echo "  docs/soft-brightness-plus.png"

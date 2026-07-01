#!/usr/bin/env bash
# E2E test runner: builds a Docker image and runs the extension inside
# GNOME Shell in both Wayland headless and X11 (Xvfb) modes.
# Usage: test/e2e.sh [wayland|x11|both]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="sbp-e2e-test"
ZIP="${REPO_ROOT}/build/extension.zip"
MODES="${1:-both}"

command -v docker >/dev/null 2>&1 || { echo "ERROR: docker not found in PATH"; exit 1; }

# Build the extension zip if not present
if [ ! -f "${ZIP}" ]; then
    echo "Building extension zip..."
    make -C "${REPO_ROOT}" zip
fi

echo "Building test container image..."
docker build -t "${IMAGE}" "${REPO_ROOT}/test/e2e/" --quiet

FAILED=0

run_mode() {
    local mode="$1"
    echo ""
    echo "────────────────────────────────────── ${mode}"
    if docker run --rm \
        -v "${ZIP}:/ext.zip:ro" \
        "${IMAGE}" \
        /run-test.sh "${mode}"; then
        echo "── ${mode}: PASSED"
    else
        FAILED=$((FAILED + 1))
        echo "── ${mode}: FAILED"
    fi
}

case "${MODES}" in
    wayland) run_mode wayland ;;
    x11)     run_mode x11 ;;
    both)    run_mode wayland; run_mode x11 ;;
    *)       echo "Usage: $0 [wayland|x11|both]"; exit 1 ;;
esac

echo ""
if [ "${FAILED}" -eq 0 ]; then
    echo "All E2E tests passed."
else
    echo "${FAILED} E2E test(s) failed."
    exit 1
fi

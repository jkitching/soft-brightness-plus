#!/usr/bin/env bash
# E2E test runner: builds a Docker image and runs the extension inside
# GNOME Shell in Wayland headless and (where supported) X11/Xvfb modes.
#
# Usage: test/e2e.sh [wayland|x11|both]
#
# GNOME version matrix: images build on docker.io/jkitching/gnome-shell-XY
# (x11docker-gnome; Fedora N = GNOME N). Select with GNOME_VERSION:
#   GNOME_VERSION=49 test/e2e.sh
#
# GNOME 49+ removed the X11 session upstream, so the x11 lane is skipped
# there automatically — wayland headless (+ mutter screencast pixel checks)
# is the lane that carries forward.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GNOME_VERSION="${GNOME_VERSION:-46}"
IMAGE="sbp-e2e-gnome${GNOME_VERSION}"
ZIP="${REPO_ROOT}/build/extension.zip"
MODES="${1:-both}"

command -v docker >/dev/null 2>&1 || { echo "ERROR: docker not found in PATH"; exit 1; }

# Build the extension zip if not present
if [ ! -f "${ZIP}" ]; then
    echo "Building extension zip..."
    make -C "${REPO_ROOT}" zip
fi

echo "Building test container image (GNOME ${GNOME_VERSION})..."
docker build -t "${IMAGE}" \
    --build-arg "GNOME_VERSION=${GNOME_VERSION}" \
    -f "${REPO_ROOT}/test/e2e/Dockerfile.fedora" \
    "${REPO_ROOT}/test/e2e/" --quiet

FAILED=0

run_mode() {
    local mode="$1"
    echo ""
    echo "────────────────────────────────────── ${mode} (GNOME ${GNOME_VERSION})"
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

x11_supported() {
    [ "${GNOME_VERSION}" -lt 49 ]
}

run_x11() {
    if x11_supported; then
        run_mode x11
    else
        echo ""
        echo "── x11: SKIPPED (GNOME ${GNOME_VERSION} has no X11 session support)"
    fi
}

case "${MODES}" in
    wayland) run_mode wayland ;;
    x11)     run_x11 ;;
    both)    run_mode wayland; run_x11 ;;
    *)       echo "Usage: $0 [wayland|x11|both]"; exit 1 ;;
esac

echo ""
if [ "${FAILED}" -eq 0 ]; then
    echo "All E2E tests passed."
else
    echo "${FAILED} E2E test(s) failed."
    exit 1
fi

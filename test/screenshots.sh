#!/usr/bin/env bash
# Screenshot runner: builds a Docker image and captures docs screenshots
# inside a reproducible GNOME Shell environment.
# Usage: test/screenshots.sh
# Output: updates docs/preferences.png and docs/soft-brightness-plus.png
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
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
# The container runs as its own unprivileged user, which cannot write into
# a bind-mounted docs/ owned by the host user; stage via a chmod-777 temp
# dir and move the results into docs/ afterwards.
OUTDIR="$(mktemp -d)"
chmod 777 "${OUTDIR}"
docker run --rm \
    -v "${ZIP}:/ext.zip:ro" \
    -v "${OUTDIR}:/docs" \
    "${IMAGE}" \
    /run-screenshots.sh
mv "${OUTDIR}/preferences.png" "${OUTDIR}/soft-brightness-plus.png" "${REPO_ROOT}/docs/"
# Keep the diagnostic root capture (if any) out of docs/ but inspectable
[ -f "${OUTDIR}/qs-debug-root.png" ] && mv "${OUTDIR}/qs-debug-root.png" "${REPO_ROOT}/build/" || true
rm -rf "${OUTDIR}"

echo ""
echo "Done. Updated:"
echo "  docs/preferences.png"
echo "  docs/soft-brightness-plus.png"

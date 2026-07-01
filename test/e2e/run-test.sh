#!/usr/bin/env bash
# Runs inside the Docker container. Exit 0 = pass, 1 = fail.
# Usage: run-test.sh <wayland|x11>
set -euo pipefail

MODE="${1:-wayland}"
UUID="soft-brightness-plus@joelkitching.com"
EXT_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"
LOG="/tmp/gnome-shell-${MODE}.log"
SETTLE=12

echo "=== E2E (${MODE}) ==="

# Install extension from the mounted zip
mkdir -p "${EXT_DIR}"
unzip -q /ext.zip -d "${EXT_DIR}"
echo "  installed ${UUID}"

# Start Xvfb for X11 mode before the dbus session
XVFB_PID=""
if [ "${MODE}" = "x11" ]; then
    Xvfb :99 -screen 0 1920x1080x24 -ac -noreset &
    XVFB_PID=$!
    sleep 1
    if ! kill -0 "${XVFB_PID}" 2>/dev/null; then
        echo "  FAIL: Xvfb failed to start"
        exit 1
    fi
    echo "  Xvfb on :99"
fi

cleanup() {
    [ -n "${XVFB_PID}" ] && kill "${XVFB_PID}" 2>/dev/null || true
}
trap cleanup EXIT

# Run GNOME Shell inside a dedicated dbus session
# bash -s passes positional args ($1..$3) to the here-doc script
dbus-run-session -- bash -s "${MODE}" "${UUID}" "${LOG}" "${SETTLE}" <<'INNER'
set -euo pipefail
MODE="$1"; UUID="$2"; LOG="$3"; SETTLE="$4"

# Enable the extension before gnome-shell reads settings
gsettings set org.gnome.shell enabled-extensions "['${UUID}']"

# Start a fake system D-Bus and register a logind stub on it.
# gnome-shell connects to org.freedesktop.login1 on the system bus during
# background init. Without this, it throws an uncaught exception that
# causes a C-level heap abort in the GNOME Shell 46 error path.
FAKE_SYSTEM_BUS=/tmp/fake-system-dbus.sock
dbus-daemon --session \
    --address="unix:path=${FAKE_SYSTEM_BUS}" \
    --print-pid --fork >/dev/null
export DBUS_SYSTEM_BUS_ADDRESS="unix:path=${FAKE_SYSTEM_BUS}"
gjs /fake-logind.js &
LOGIND_PID=$!
sleep 1

if [ "${MODE}" = "x11" ]; then
    DISPLAY=:99 \
    XDG_SESSION_TYPE=x11 \
    LIBGL_ALWAYS_SOFTWARE=1 \
    MUTTER_DISABLE_ANIMATIONS=1 \
        gnome-shell >"${LOG}" 2>&1 &
else
    XDG_SESSION_TYPE=wayland \
    MUTTER_DEBUG_DUMMY_MODE_SPECS="1920x1080" \
    MUTTER_DISABLE_ANIMATIONS=1 \
        gnome-shell --headless >"${LOG}" 2>&1 &
fi
GS_PID=$!

echo "  gnome-shell PID ${GS_PID}, waiting ${SETTLE}s..."
sleep "${SETTLE}"

# Check 1: still alive
if ! kill -0 "${GS_PID}" 2>/dev/null; then
    echo "  FAIL: gnome-shell exited early"
    tail -40 "${LOG}" 2>/dev/null || true
    exit 1
fi
echo "  PASS: gnome-shell alive after ${SETTLE}s"

# Check 2: no extension errors
if grep -qiE \
    "Error in extension ${UUID}|Failed to load extension ${UUID}|extension.*${UUID}.*error" \
    "${LOG}" 2>/dev/null; then
    echo "  FAIL: extension error in log"
    grep -iE "Error|Failed" "${LOG}" | grep -i "${UUID}" || true
    kill "${GS_PID}" 2>/dev/null || true
    exit 1
fi
echo "  PASS: no extension errors"

# Check 3: extension appears in log (informational)
if grep -q "${UUID}" "${LOG}" 2>/dev/null; then
    echo "  INFO: extension UUID found in gnome-shell log"
else
    echo "  INFO: extension UUID not in log (may still be active)"
fi

kill "${GS_PID}" 2>/dev/null || true
wait "${GS_PID}" 2>/dev/null || true
kill "${LOGIND_PID}" 2>/dev/null || true
echo "  PASS: ${MODE} test complete"
INNER

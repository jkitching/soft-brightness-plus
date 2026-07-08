#!/usr/bin/env bash
# Runs inside the screenshot Docker container.
# Produces docs/preferences.png and docs/soft-brightness-plus.png.
set -euo pipefail

UUID="soft-brightness-plus@joelkitching.com"
EXT_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"
SETTLE=15

# Install extension
mkdir -p "${EXT_DIR}"
unzip -q /ext.zip -d "${EXT_DIR}"
# The zip ships only the schema XML; the prefs dialog needs it compiled.
glib-compile-schemas "${EXT_DIR}/schemas/"
echo "Installed extension"

# Start Xvfb (1280x800, enough room for the QS panel to open)
Xvfb :98 -screen 0 1280x800x24 -ac -noreset &
XVFB_PID=$!
sleep 1
export DISPLAY=:98
echo "Xvfb on :98"

cleanup() {
    kill "${XVFB_PID}" 2>/dev/null || true
}
trap cleanup EXIT

dbus-run-session -- bash -s "${UUID}" "${EXT_DIR}" "${SETTLE}" <<'INNER'
set -euo pipefail
UUID="$1"; EXT_DIR="$2"; SETTLE="$3"
export DISPLAY=:98

gsettings set org.gnome.shell enabled-extensions "['${UUID}']"

# Show the extension's independent overlay slider in quick settings
# (the container has no backlight hardware for the default mode).
GSETTINGS_SCHEMA_DIR="${EXT_DIR}/schemas" \
    gsettings set org.gnome.shell.extensions.soft-brightness-plus use-backlight false

# gnome-shell must be running BEFORE the prefs screenshot:
# `gnome-extensions prefs` asks the shell (org.gnome.Shell.Extensions) to
# open the dialog and fails outright with no shell on the bus.

# Accessibility must be live BEFORE gnome-shell starts, or the shell's
# a11y tree registers without usable extents (AT-SPI then reports
# INT_MIN for every widget and find-slider.py cannot work).
gsettings set org.gnome.desktop.interface toolkit-accessibility true
/usr/lib/at-spi2-core/at-spi-bus-launcher --launch-immediately &
AT_SPI_PID=$!
sleep 2

# Fake logind so gnome-shell doesn't crash on missing systemd
FAKE_SYSTEM_BUS=/tmp/fake-system-dbus.sock
dbus-daemon --session \
    --address="unix:path=${FAKE_SYSTEM_BUS}" \
    --print-pid --fork >/dev/null
export DBUS_SYSTEM_BUS_ADDRESS="unix:path=${FAKE_SYSTEM_BUS}"
gjs /fake-logind.js &
LOGIND_PID=$!
sleep 1

DISPLAY=:98 \
XDG_SESSION_TYPE=x11 \
LIBGL_ALWAYS_SOFTWARE=1 \
MUTTER_DISABLE_ANIMATIONS=1 \
    gnome-shell >/tmp/gs.log 2>&1 &
GS_PID=$!
echo "  gnome-shell PID ${GS_PID}, settling ${SETTLE}s..."
sleep "${SETTLE}"

if ! kill -0 "${GS_PID}" 2>/dev/null; then
    echo "  FAIL: gnome-shell exited early"
    tail -30 /tmp/gs.log
    exit 1
fi

# ── Screenshot 1: preferences window ─────────────────────────────────────────
echo ""
echo "=== Preferences screenshot ==="
gnome-extensions prefs "${UUID}" || true
sleep 4

WIN=$(xdotool search --onlyvisible --name "Soft Brightness" 2>/dev/null | head -1 || true)
[ -z "$WIN" ] && \
    WIN=$(xdotool search --onlyvisible --class "org.gnome.Shell.Extensions" 2>/dev/null | head -1 || true)
[ -z "$WIN" ] && \
    WIN=$(xdotool search --onlyvisible --name "Extension" 2>/dev/null | tail -1 || true)

if [ -n "$WIN" ]; then
    NAME=$(xdotool getwindowname "$WIN" 2>/dev/null || echo "unknown")
    echo "  Found window ${WIN}: ${NAME}"
    import -window "$WIN" /docs/preferences.png
    echo "  Saved preferences.png"
    # Close the dialog so it doesn't overlap the QS panel capture below
    xdotool windowkill "$WIN" 2>/dev/null || true
    sleep 1
else
    echo "  WARNING: prefs window not found; listing visible windows:"
    xdotool search --onlyvisible 2>/dev/null | while read -r id; do
        echo "    ${id}: $(xdotool getwindowname "$id" 2>/dev/null || echo '?')"
    done
fi

# ── Screenshot 2: QS brightness slider ───────────────────────────────────────
echo ""
echo "=== QS slider screenshot ==="

# Leave the overview (sessions start there since GNOME 40), capture the
# closed-panel frame, then open quick settings via its keyboard shortcut —
# the panel indicator area is not reliably clickable in this environment.
xdotool key --clearmodifiers Escape
sleep 1
import -window root /tmp/qs-closed.png
xdotool key --clearmodifiers super+s
sleep 2
import -window root /tmp/qs-open.png

# Primary: AT-SPI locates the extension's slider row precisely.
BOUNDS=$(python3 /find-slider.py 2>/tmp/atspi.log || true)
echo "  AT-SPI bounds: '${BOUNDS}'"

if [ -n "${BOUNDS}" ]; then
    read -r SX SY SW SH <<< "${BOUNDS}"
    # AT-SPI reports INT_MIN extents for unrealized widgets; treat any
    # non-positive geometry as a failed lookup so the fallback runs.
    if [ "${SW:-0}" -le 0 ] || [ "${SH:-0}" -le 0 ] || \
       [ "${SX:-0}" -lt 0 ] || [ "${SY:-0}" -lt 0 ]; then
        echo "  AT-SPI bounds invalid — deriving panel region instead"
        BOUNDS=""
    fi
fi

if [ -n "${BOUNDS}" ]; then
    PAD=12
    convert /tmp/qs-open.png \
        -crop "$((SW + PAD*2))x$((SH + PAD*2))+$((SX - PAD))+$((SY - PAD))" \
        /docs/soft-brightness-plus.png
    echo "  Saved soft-brightness-plus.png (slider row ${SW}x${SH} at ${SX},${SY})"
else
    # Fallback: derive the panel region from what actually changed on
    # screen when the panel opened — no assumptions about layout. Use the
    # largest connected changed region so unrelated changes elsewhere on
    # screen (clock tick, indicator highlight) don't inflate the crop.
    cat /tmp/atspi.log >&2 || true
    PANEL=$(convert /tmp/qs-closed.png /tmp/qs-open.png \
        -compose difference -composite -colorspace Gray -threshold 15% \
        -define connected-components:verbose=true \
        -connected-components 8 null: 2>/dev/null | \
        awk '$1 ~ /^[0-9]+:$/ && $5 !~ /gray\(0\)|black/ {
                 if ($4 + 0 > a) { a = $4 + 0; b = $2 }
             } END { print b }')
    if [ -z "${PANEL}" ]; then
        echo "  FAIL: quick settings panel did not open (no screen diff)"
        exit 1
    fi
    convert /tmp/qs-open.png -crop "${PANEL}" /docs/soft-brightness-plus.png
    echo "  Saved soft-brightness-plus.png (derived panel region ${PANEL})"
fi

kill "${GS_PID}" 2>/dev/null || true
kill "${LOGIND_PID}" 2>/dev/null || true
kill "${AT_SPI_PID}" 2>/dev/null || true
INNER

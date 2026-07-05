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

# Compile schemas — the zip ships only the .xml (e.g.o. requirement);
# we must compile locally before GNOME Shell tries to load them.
glib-compile-schemas "${EXT_DIR}/schemas/"

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
EXT_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"
SCHEMA_DIR="${EXT_DIR}/schemas"
SCHEMA_ID="org.gnome.shell.extensions.soft-brightness-plus"

# Enable the extension before gnome-shell reads settings
gsettings set org.gnome.shell enabled-extensions "['${UUID}']"

# Enable extension debug logging so brightness changes appear in gnome-shell log
GSETTINGS_SCHEMA_DIR="${SCHEMA_DIR}" \
    gsettings set "${SCHEMA_ID}" debug true

# Set a vertical-gradient background so brightness changes are visually
# measurable AND the baseline has pixel variation (a solid background makes
# the "screen must not be a solid colour after dimming" check meaningless:
# it cannot distinguish a healthy screen from the full-screen-gray shader bug).
gsettings set org.gnome.desktop.background picture-options 'none'
gsettings set org.gnome.desktop.background primary-color '#202020'
gsettings set org.gnome.desktop.background secondary-color '#e0e0e0'
gsettings set org.gnome.desktop.background color-shading-type 'vertical'

# Kill every daemon we started on any exit path (the failure paths below
# `exit 1` directly and would otherwise orphan pipewire/wireplumber/logind).
GS_PID=""
PIPEWIRE_PID=""
WIREPLUMBER_PID=""
LOGIND_PID=""
inner_cleanup() {
    kill ${GS_PID} ${WIREPLUMBER_PID} ${PIPEWIRE_PID} ${LOGIND_PID} 2>/dev/null || true
}
trap inner_cleanup EXIT

# Start PipeWire inside this session: org.gnome.Mutter.ScreenCast (used for
# the pixel checks below) hands frames over via a PipeWire stream.
# XDG_RUNTIME_DIR is already set by the container.
pipewire >/tmp/pipewire.log 2>&1 &
PIPEWIRE_PID=$!
wireplumber >/tmp/wireplumber.log 2>&1 &
WIREPLUMBER_PID=$!
sleep 1

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
    # --virtual-monitor is required for the pixel checks: plain --headless
    # has zero monitors, so there is nothing to render or screencast.
    # (MUTTER_DEBUG_DUMMY_MODE_SPECS only affects the nested/x11 backend
    # and is a no-op here, so it is not set.)
    XDG_SESSION_TYPE=wayland \
    MUTTER_DISABLE_ANIMATIONS=1 \
        gnome-shell --headless --virtual-monitor 1920x1080 >"${LOG}" 2>&1 &
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

# Check 4: visual pixel checks.
#
# Capture goes through org.gnome.Mutter.ScreenCast + PipeWire + gst-launch
# (see grab-frame.js). org.gnome.Shell.Screenshot is NOT usable here:
# GNOME >= 41 restricts it to an allowlist of senders, and the extension
# itself monkey-patches Shell.Screenshot to hide its dimming during
# screenshots — either one alone would silently defeat the check. The X11
# root window is not usable either: under a compositor it is always black.
#
# Policy: in wayland mode a capture failure is a HARD FAILURE — a silent
# skip here previously let a full-screen-gray shader bug ship. In x11 mode
# (Xvfb) screencast support is less certain, so a capture failure skips
# the pixel checks loudly instead.
SCREEN_BASE="/tmp/screen-base.png"
SCREEN_DIMMED="/tmp/screen-dimmed.png"
PIXEL_CHECKS=true

pixel_capture_failed() {
    if [ "${MODE}" = "wayland" ]; then
        echo "  FAIL: $1 (pixel checks are mandatory in wayland mode — not skippable)"
        tail -20 /tmp/pipewire.log 2>/dev/null || true
        kill "${GS_PID}" 2>/dev/null || true
        exit 1
    fi
    echo "  SKIPPED (x11): $1 — mutter screencast not usable under Xvfb here"
    PIXEL_CHECKS=false
}

if ! gjs /grab-frame.js "${SCREEN_BASE}" auto; then
    pixel_capture_failed "screencast baseline capture failed"
fi

if [ "${PIXEL_CHECKS}" = "true" ]; then
    # Note: the fx symbol is "standard_deviation"; "%[fx:std]" is an
    # undefined-variable error that the "|| echo 0" fallback would mask.
    # -alpha off matters: screencast PNGs are RGBA with constant alpha=1,
    # which would otherwise dilute both the mean drop and the stddev.
    STDDEV_BASE=$(convert "${SCREEN_BASE}" -alpha off -colorspace Gray -format "%[fx:standard_deviation]" info: 2>/dev/null || echo "0")
    MEAN_BASE=$(convert "${SCREEN_BASE}" -alpha off -colorspace Gray -format "%[fx:mean]" info: 2>/dev/null || echo "0")
    echo "  Visual: baseline stddev=${STDDEV_BASE} mean=${MEAN_BASE}"
    BASE_RENDERS=$(awk "BEGIN { print (${STDDEV_BASE} > 0.01) ? \"yes\" : \"no\" }")
    if [ "${BASE_RENDERS}" = "no" ]; then
        pixel_capture_failed "baseline has no pixel variation (stddev=${STDDEV_BASE}) — gradient background did not render"
    fi
fi

# Trigger dimming and verify the extension logs it (always runs)
GSETTINGS_SCHEMA_DIR="${SCHEMA_DIR}" \
    gsettings set "${SCHEMA_ID}" current-brightness 0.5
sleep 3

if grep -q "current-brightness=0.5\|_on_brightness_change.*0.5\|show(0.5\|show.*brightness.*0.5" "${LOG}" 2>/dev/null; then
    echo "  PASS: extension log confirms brightness change was applied"
else
    if grep -q "OverlayManager\|GammaCurveEffect\|soft-brightness.*show\|_on_brightness" "${LOG}" 2>/dev/null; then
        echo "  PASS: extension log shows overlay activity"
    else
        echo "  WARN: could not confirm brightness change in log"
        grep -i "brightness\|overlay\|shader" "${LOG}" 2>/dev/null | tail -10 || true
    fi
fi

if [ "${PIXEL_CHECKS}" = "true" ]; then
    if ! gjs /grab-frame.js "${SCREEN_DIMMED}" auto; then
        pixel_capture_failed "screencast dimmed capture failed"
    fi
fi

if [ "${PIXEL_CHECKS}" = "true" ]; then
    # Visual check A: dimmed screenshot must NOT be solid colour.
    # The shader-on-stage bug produces stddev ≈ 0 (all pixels same grey value).
    # The gradient baseline (checked above) guarantees this is a real signal.
    STDDEV=$(convert "${SCREEN_DIMMED}" -alpha off -colorspace Gray -format "%[fx:standard_deviation]" info: 2>/dev/null || echo "0")
    echo "  Visual: dimmed screenshot stddev=${STDDEV}"
    STDDEV_OK=$(awk "BEGIN { print (${STDDEV} > 0.01) ? \"yes\" : \"no\" }")
    if [ "${STDDEV_OK}" = "no" ]; then
        echo "  FAIL: solid-colour screen after dimming (stddev=${STDDEV} ≤ 0.01)"
        echo "        Baseline had variation but dimmed is solid — GammaCurveEffect shader bug"
        kill "${GS_PID}" 2>/dev/null || true
        exit 1
    fi
    echo "  PASS: screen has pixel variation — not solid colour"

    # Visual check B: dimmed screenshot must be darker than the baseline.
    MEAN_DIMMED=$(convert "${SCREEN_DIMMED}" -alpha off -colorspace Gray -format "%[fx:mean]" info: 2>/dev/null || echo "0")
    echo "  Visual: mean brightness baseline=${MEAN_BASE} dimmed=${MEAN_DIMMED}"
    DIMMED_OK=$(awk "BEGIN { print (${MEAN_DIMMED} < ${MEAN_BASE} * 0.90) ? \"yes\" : \"no\" }")
    if [ "${DIMMED_OK}" = "no" ]; then
        echo "  FAIL: dimming not detected — mean(dimmed)=${MEAN_DIMMED} not below 0.90*mean(base)=${MEAN_BASE}"
        kill "${GS_PID}" 2>/dev/null || true
        exit 1
    fi
    echo "  PASS: screen is measurably dimmer at brightness=0.5"

    # Visual check C: shell chrome (top bar) should dim too. The shader is
    # currently known NOT to dim chrome: window_group lives inside uiGroup,
    # and the uiGroup-level effect does not render its dimming, so only
    # window actors and stage-level children darken. WARN-only until chrome
    # dimming is implemented — then flip this to a hard FAIL.
    BAR_BASE=$(convert "${SCREEN_BASE}" -alpha off -crop 1920x28+0+0 -colorspace Gray -format "%[fx:mean]" info: 2>/dev/null || echo "0")
    BAR_DIMMED=$(convert "${SCREEN_DIMMED}" -alpha off -crop 1920x28+0+0 -colorspace Gray -format "%[fx:mean]" info: 2>/dev/null || echo "0")
    echo "  Visual: top-bar mean baseline=${BAR_BASE} dimmed=${BAR_DIMMED}"
    BAR_MEASURABLE=$(awk "BEGIN { print (${BAR_BASE} > 0.005) ? \"yes\" : \"no\" }")
    if [ "${BAR_MEASURABLE}" = "no" ]; then
        echo "  INFO: top bar has no measurable brightness — skipping chrome check"
    else
        BAR_OK=$(awk "BEGIN { print (${BAR_DIMMED} < ${BAR_BASE} * 0.95) ? \"yes\" : \"no\" }")
        if [ "${BAR_OK}" = "yes" ]; then
            echo "  PASS: shell chrome (top bar) is dimmed"
        else
            echo "  WARN: shell chrome (top bar) is NOT dimmed — known gap in the shader path"
        fi
    fi
fi

kill "${GS_PID}" 2>/dev/null || true
wait "${GS_PID}" 2>/dev/null || true
kill "${LOGIND_PID}" 2>/dev/null || true
kill "${WIREPLUMBER_PID}" "${PIPEWIRE_PID}" 2>/dev/null || true
echo "  PASS: ${MODE} test complete"
INNER

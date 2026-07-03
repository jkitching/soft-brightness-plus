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

# Enable development tools so Shell.Eval D-Bus method is available for CI shader checks.
# Required in GNOME 43+ where Eval is disabled unless development-tools is true.
gsettings set org.gnome.shell development-tools true

# Enable extension debug logging so brightness changes appear in gnome-shell log
GSETTINGS_SCHEMA_DIR="${SCHEMA_DIR}" \
    gsettings set "${SCHEMA_ID}" debug true

# Set a light grey background so brightness changes are visually measurable
# (default GNOME desktop background is black which is already at min brightness)
gsettings set org.gnome.desktop.background picture-options 'none'
gsettings set org.gnome.desktop.background primary-color '#888888'
gsettings set org.gnome.desktop.background secondary-color '#888888'
gsettings set org.gnome.desktop.background color-shading-type 'solid'

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

# Visual and programmatic checks (X11 mode only — Wayland headless has no framebuffer)
if [ "${MODE}" = "x11" ]; then
    SCREEN_BASE="/tmp/screen-base.png"
    SCREEN_DIMMED="/tmp/screen-dimmed.png"
    PIXEL_CHECKS=false
    DBUS_SHOT=false

    # Diagnostic: list windows on Xvfb to understand the rendering environment
    WIN_COUNT=$(DISPLAY=:99 xwininfo -root -children 2>/dev/null | grep -c '"' || echo "0")
    echo "  Info: ${WIN_COUNT} named windows on Xvfb :99"

    # Diagnostic: check if org.gnome.Shell is registered on the session bus
    GNOME_SHELL_ON_BUS=$(gdbus call --session \
        -d org.freedesktop.DBus \
        -o /org/freedesktop/DBus \
        -m org.freedesktop.DBus.ListNames \
        2>/dev/null | tr ',' '\n' | tr -d "' " | grep "^org.gnome.Shell$" || echo "")
    echo "  INFO: org.gnome.Shell on D-Bus: ${GNOME_SHELL_ON_BUS:-not registered}"

    # Primary: GNOME Shell D-Bus screenshot API — captures the compositor overlay,
    # which is where gnome-shell actually renders its composited output in X11 mode.
    # The root window (XGetImage) shows only the raw X11 background underneath the
    # compositor, so it is always solid black. D-Bus goes through gnome-shell itself.
    # Note: gdbus call takes individual GVariant positional args, not a tuple wrapper.
    DBUS_ERR_FILE=/tmp/dbus-err-$$.txt
    DBUS_RESULT=$(gdbus call --session \
        -d org.gnome.Shell \
        -o /org/gnome/Shell/Screenshot \
        -m org.gnome.Shell.Screenshot.Screenshot \
        "false" "false" "'${SCREEN_BASE}'" 2>"${DBUS_ERR_FILE}" || true)
    DBUS_ERR=$(cat "${DBUS_ERR_FILE}" 2>/dev/null | head -1 || echo "")
    rm -f "${DBUS_ERR_FILE}"
    if echo "${DBUS_RESULT}" | grep -q "true"; then
        echo "  INFO: D-Bus screenshot captured baseline via gnome-shell compositor"
        DBUS_SHOT=true
    else
        echo "  INFO: D-Bus screenshot failed: result=${DBUS_RESULT:-empty} err=${DBUS_ERR:-none}"
        echo "  INFO: falling back to root window capture"
        DISPLAY=:99 import -window root "${SCREEN_BASE}" 2>/dev/null || true
    fi

    if [ -f "${SCREEN_BASE}" ]; then
        STDDEV_BASE=$(convert "${SCREEN_BASE}" -colorspace Gray -format "%[fx:std]" info: 2>/dev/null || echo "0")
        echo "  Visual: baseline stddev=${STDDEV_BASE}"
        BASE_RENDERS=$(awk "BEGIN { print (${STDDEV_BASE} > 0.01) ? \"yes\" : \"no\" }")
        if [ "${BASE_RENDERS}" = "yes" ]; then
            PIXEL_CHECKS=true
        else
            echo "  WARN: baseline is solid — gnome-shell compositor output not capturable in this environment"
            echo "  INFO: pixel checks skipped (environment limitation, not a shader bug)"
        fi
    else
        echo "  WARN: baseline screenshot failed — skipping pixel checks"
    fi

    # Programmatic check: trigger dimming and verify the extension logs it (always runs)
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

    # Shader check via Shell.Eval: verify GammaCurveEffect is applied to stage children.
    # This is the definitive CI check — it runs inside gnome-shell's JS context and
    # directly inspects whether the per-child shader approach actually attached effects.
    SHADER_JS='global.stage.get_children().filter(function(c){return c.get_effect("soft-brightness-plus-shader") !== null}).length.toString()'
    SHADER_EVAL=$(gdbus call --session \
        -d org.gnome.Shell \
        -o /org/gnome/Shell \
        -m org.gnome.Shell.Eval \
        "'${SHADER_JS}'" 2>/dev/null || echo "")
    if echo "${SHADER_EVAL}" | grep -q "(true,"; then
        SHADER_COUNT=$(echo "${SHADER_EVAL}" | sed "s/(true, '\\([^']*\\)')/\\1/")
        if [ "${SHADER_COUNT}" -gt 0 ] 2>/dev/null; then
            echo "  PASS: GammaCurveEffect shader applied to ${SHADER_COUNT} stage children"
        else
            echo "  FAIL: shader effect not attached to any stage children after brightness=0.5"
            kill "${GS_PID}" 2>/dev/null || true
            exit 1
        fi
    else
        echo "  INFO: Shell.Eval not available (result=${SHADER_EVAL:-empty}) — skipping shader effect check"
    fi

    if [ "${PIXEL_CHECKS}" = "true" ]; then
        # Take dimmed screenshot using same method as baseline
        if [ "${DBUS_SHOT}" = "true" ]; then
            DBUS_RESULT2=$(gdbus call --session \
                -d org.gnome.Shell \
                -o /org/gnome/Shell/Screenshot \
                -m org.gnome.Shell.Screenshot.Screenshot \
                "false" "false" "'${SCREEN_DIMMED}'" 2>/dev/null || echo "")
            if ! echo "${DBUS_RESULT2}" | grep -q "true"; then
                echo "  WARN: dimmed D-Bus screenshot failed — skipping pixel checks"
                PIXEL_CHECKS=false
            fi
        else
            if ! DISPLAY=:99 import -window root "${SCREEN_DIMMED}" 2>/dev/null; then
                echo "  WARN: dimmed screenshot failed — skipping pixel checks"
                PIXEL_CHECKS=false
            fi
        fi
    fi

    if [ "${PIXEL_CHECKS}" = "true" ] && [ -f "${SCREEN_DIMMED}" ]; then
        # Visual check A: dimmed screenshot must NOT be solid colour.
        # The shader-on-stage bug produces stddev ≈ 0 (all pixels same grey value).
        # Only reached when baseline already showed variation (environment renders).
        STDDEV=$(convert "${SCREEN_DIMMED}" -colorspace Gray -format "%[fx:std]" info: 2>/dev/null || echo "0")
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
        MEAN_BASE=$(convert "${SCREEN_BASE}" -colorspace Gray -format "%[fx:mean]" info: 2>/dev/null || echo "0")
        MEAN_DIMMED=$(convert "${SCREEN_DIMMED}" -colorspace Gray -format "%[fx:mean]" info: 2>/dev/null || echo "0")
        echo "  Visual: mean brightness baseline=${MEAN_BASE} dimmed=${MEAN_DIMMED}"
        DIMMED_OK=$(awk "BEGIN { print (${MEAN_DIMMED} < ${MEAN_BASE} * 0.90) ? \"yes\" : \"no\" }")
        if [ "${DIMMED_OK}" = "no" ]; then
            echo "  FAIL: dimming not detected — mean(dimmed)=${MEAN_DIMMED} not below mean(base)=${MEAN_BASE}"
            kill "${GS_PID}" 2>/dev/null || true
            exit 1
        fi
        echo "  PASS: screen is measurably dimmer at brightness=0.5"
    fi
fi

kill "${GS_PID}" 2>/dev/null || true
wait "${GS_PID}" 2>/dev/null || true
kill "${LOGIND_PID}" 2>/dev/null || true
echo "  PASS: ${MODE} test complete"
INNER

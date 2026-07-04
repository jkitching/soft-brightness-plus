#!/usr/bin/env gjs
// Grab one frame of the compositor output via org.gnome.Mutter.ScreenCast
// (PipeWire + gst-launch-1.0).
//
// Why not org.gnome.Shell.Screenshot? Two reasons:
//   1. GNOME >= 41 restricts that API to an allowlist of senders
//      (org.gnome.Settings, MediaKeys, the screenshot portal), so a test
//      harness calling it over D-Bus is rejected.
//   2. The extension under test monkey-patches Shell.Screenshot methods to
//      hide its own dimming during screenshots, which would defeat the
//      "is the screen darker" check even if the call succeeded.
// Mutter's ScreenCast API bypasses both, and works on a headless
// (MUTTER_DEBUG_DUMMY_MODE_SPECS) session.
//
// NOTE: deliberately does NOT import Gst from gi — gjs Gst.init has
// introspection bugs on some distros. gst-launch-1.0 is spawned instead.
//
// Usage: gjs grab-frame.js OUTPUT.png [CONNECTOR|auto]

const {Gio, GLib} = imports.gi;
const System = imports.system;

const GST_TIMEOUT_SEC = 15;
const STREAM_TIMEOUT_SEC = 10;

if (ARGV.length < 1) {
    printerr('Usage: gjs grab-frame.js OUTPUT.png [CONNECTOR|auto]');
    System.exit(2);
}
const outPath = ARGV[0];
let connector = ARGV[1] || 'auto';

let bus;
try {
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
} catch (e) {
    printerr(`grab-frame: cannot connect to session bus: ${e.message}`);
    System.exit(1);
}

function call(name, objPath, iface, method, params) {
    return bus.call_sync(name, objPath, iface, method, params, null,
        Gio.DBusCallFlags.NONE, 5000, null);
}

// Auto-detect the first monitor's connector. Under headless
// MUTTER_DEBUG_DUMMY_MODE_SPECS this is a virtual connector, so it must
// not be hardcoded.
if (connector === 'auto') {
    try {
        const state = call('org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig',
            'org.gnome.Mutter.DisplayConfig', 'GetCurrentState',
            null).deepUnpack();
        const monitors = state[1];
        if (!monitors || monitors.length === 0) {
            printerr('grab-frame: DisplayConfig reports no monitors');
            System.exit(1);
        }
        connector = monitors[0][0][0];
        printerr(`grab-frame: auto-detected connector: ${connector}`);
    } catch (e) {
        printerr(`grab-frame: GetCurrentState failed: ${e.message}`);
        System.exit(1);
    }
}

let sessionPath = null;
try {
    [sessionPath] = call('org.gnome.Mutter.ScreenCast',
        '/org/gnome/Mutter/ScreenCast',
        'org.gnome.Mutter.ScreenCast', 'CreateSession',
        new GLib.Variant('(a{sv})', [{}])).deepUnpack();
    printerr(`grab-frame: session: ${sessionPath}`);
} catch (e) {
    printerr(`grab-frame: CreateSession failed: ${e.message}`);
    System.exit(1);
}

function stopSession() {
    try {
        call('org.gnome.Mutter.ScreenCast', sessionPath,
            'org.gnome.Mutter.ScreenCast.Session', 'Stop', null);
    } catch (e) {
        printerr(`grab-frame: Session.Stop failed (ignored): ${e.message}`);
    }
}

let streamPath = null;
try {
    [streamPath] = call('org.gnome.Mutter.ScreenCast', sessionPath,
        'org.gnome.Mutter.ScreenCast.Session', 'RecordMonitor',
        new GLib.Variant('(sa{sv})', [connector, {}])).deepUnpack();
    printerr(`grab-frame: stream: ${streamPath}`);
} catch (e) {
    printerr(`grab-frame: RecordMonitor(${connector}) failed: ${e.message}`);
    stopSession();
    System.exit(1);
}

// Subscribe to PipeWireStreamAdded before Start so the signal cannot be
// missed, then run a main loop until it fires (or times out).
let nodeId = null;
const loop = GLib.MainLoop.new(null, false);
bus.signal_subscribe('org.gnome.Mutter.ScreenCast',
    'org.gnome.Mutter.ScreenCast.Stream', 'PipeWireStreamAdded',
    streamPath, null, Gio.DBusSignalFlags.NONE,
    (_conn, _sender, _path, _iface, _signal, params) => {
        nodeId = params.deepUnpack()[0];
        loop.quit();
    });

try {
    call('org.gnome.Mutter.ScreenCast', sessionPath,
        'org.gnome.Mutter.ScreenCast.Session', 'Start', null);
} catch (e) {
    printerr(`grab-frame: Session.Start failed: ${e.message}`);
    stopSession();
    System.exit(1);
}

GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, STREAM_TIMEOUT_SEC, () => {
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();

if (nodeId === null) {
    printerr(`grab-frame: no PipeWireStreamAdded signal within ` +
        `${STREAM_TIMEOUT_SEC}s — is pipewire running?`);
    stopSession();
    System.exit(1);
}
printerr(`grab-frame: pipewire node: ${nodeId}`);

// Pull one frame off the PipeWire stream with gst-launch-1.0, with a
// timeout (a stalled pipeline would otherwise hang the test forever).
function runGst() {
    GLib.unlink(outPath);
    let proc;
    try {
        proc = Gio.Subprocess.new([
            'gst-launch-1.0', '-q',
            'pipewiresrc', `path=${nodeId}`, 'num-buffers=1', '!',
            'videoconvert', '!',
            'pngenc', 'snapshot=true', '!',
            'filesink', `location=${outPath}`,
        ], Gio.SubprocessFlags.NONE);
    } catch (e) {
        printerr(`grab-frame: failed to spawn gst-launch-1.0: ${e.message}`);
        return false;
    }

    let timedOut = false;
    let ok = false;
    const gstLoop = GLib.MainLoop.new(null, false);
    const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
        GST_TIMEOUT_SEC, () => {
            timedOut = true;
            proc.force_exit();
            return GLib.SOURCE_REMOVE;
        });
    proc.wait_check_async(null, (p, res) => {
        try {
            ok = p.wait_check_finish(res);
        } catch (e) {
            printerr(`grab-frame: gst-launch-1.0 failed: ${e.message}`);
            ok = false;
        }
        gstLoop.quit();
    });
    gstLoop.run();
    if (!timedOut)
        GLib.source_remove(timeoutId);
    else
        printerr(`grab-frame: gst-launch-1.0 timed out after ${GST_TIMEOUT_SEC}s`);

    return ok && !timedOut && GLib.file_test(outPath, GLib.FileTest.EXISTS);
}

let ok = runGst();
if (!ok) {
    printerr('grab-frame: first grab failed, retrying once...');
    GLib.usleep(2 * 1000 * 1000);
    ok = runGst();
}

stopSession();

if (!ok) {
    printerr(`grab-frame: FAILED to capture a frame to ${outPath}`);
    System.exit(1);
}
printerr(`grab-frame: wrote ${outPath}`);
System.exit(0);

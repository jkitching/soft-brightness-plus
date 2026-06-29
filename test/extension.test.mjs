import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ── Bug 3: inhibit_cursor_visibility GNOME 46 compat (issues #51, #53) ──
//
// GNOME 46 removed Meta.CursorTracker.inhibit/uninhibit_cursor_visibility.
// The current code calls them unconditionally → TypeError.

class CursorManager_BUGGY {
    constructor(cursorTracker) {
        this._cursorTracker = cursorTracker;
        this._cursorHidden = false;
        this._cursorUnfocusInhibited = false;
    }

    _hideSystemCursor(seat) {
        if (!this._cursorUnfocusInhibited) {
            seat.inhibit_unfocus();
            this._cursorUnfocusInhibited = true;
        }
        if (!this._cursorHidden) {
            this._cursorHidden = true;
            this._cursorTracker.inhibit_cursor_visibility(); // BUG: may not exist
        }
    }

    _showSystemCursor(seat) {
        if (this._cursorUnfocusInhibited) {
            seat.uninhibit_unfocus();
            this._cursorUnfocusInhibited = false;
        }
        if (this._cursorHidden) {
            this._cursorHidden = false;
            this._cursorTracker.uninhibit_cursor_visibility(); // BUG: may not exist
        }
    }
}

class CursorManager_FIXED {
    constructor(cursorTracker) {
        this._cursorTracker = cursorTracker;
        this._cursorHidden = false;
        this._cursorUnfocusInhibited = false;
    }

    _hideSystemCursor(seat) {
        if (!this._cursorUnfocusInhibited) {
            seat.inhibit_unfocus();
            this._cursorUnfocusInhibited = true;
        }
        if (!this._cursorHidden) {
            this._cursorHidden = true;
            if (typeof this._cursorTracker.inhibit_cursor_visibility === 'function')
                this._cursorTracker.inhibit_cursor_visibility();
        }
    }

    _showSystemCursor(seat) {
        if (this._cursorUnfocusInhibited) {
            seat.uninhibit_unfocus();
            this._cursorUnfocusInhibited = false;
        }
        if (this._cursorHidden) {
            this._cursorHidden = false;
            if (typeof this._cursorTracker.uninhibit_cursor_visibility === 'function')
                this._cursorTracker.uninhibit_cursor_visibility();
        }
    }
}

function makeSeat() {
    const calls = [];
    return {
        inhibit_unfocus() { calls.push('inhibit_unfocus'); },
        uninhibit_unfocus() { calls.push('uninhibit_unfocus'); },
        _calls: calls,
    };
}

describe('extension.js – inhibit_cursor_visibility GNOME 46 compat (issues #51, #53)', () => {
    test('BUG: _hideSystemCursor crashes when inhibit_cursor_visibility is missing', () => {
        const tracker = {}; // GNOME 46: method doesn't exist
        const mgr = new CursorManager_BUGGY(tracker);
        assert.throws(() => mgr._hideSystemCursor(makeSeat()), TypeError,
            'confirms bug: TypeError when calling missing method');
    });

    test('BUG: _showSystemCursor crashes when uninhibit_cursor_visibility is missing', () => {
        const tracker = {};
        const mgr = new CursorManager_BUGGY(tracker);
        mgr._cursorHidden = true;
        assert.throws(() => mgr._showSystemCursor(makeSeat()), TypeError,
            'confirms bug: TypeError when calling missing method');
    });

    test('FIXED: _hideSystemCursor is safe when methods are missing', () => {
        const tracker = {};
        const mgr = new CursorManager_FIXED(tracker);
        assert.doesNotThrow(() => mgr._hideSystemCursor(makeSeat()));
        assert.equal(mgr._cursorHidden, true);
    });

    test('FIXED: _showSystemCursor is safe when methods are missing', () => {
        const tracker = {};
        const mgr = new CursorManager_FIXED(tracker);
        mgr._cursorHidden = true;
        assert.doesNotThrow(() => mgr._showSystemCursor(makeSeat()));
        assert.equal(mgr._cursorHidden, false);
    });

    test('FIXED: seat unfocus inhibit still called even when tracker methods are missing', () => {
        const tracker = {};
        const seat = makeSeat();
        const mgr = new CursorManager_FIXED(tracker);
        mgr._hideSystemCursor(seat);
        assert.deepEqual(seat._calls, ['inhibit_unfocus']);
        mgr._showSystemCursor(seat);
        assert.deepEqual(seat._calls, ['inhibit_unfocus', 'uninhibit_unfocus']);
    });

    test('FIXED: hide/show calls tracker methods when they exist (older GNOME)', () => {
        const calls = [];
        const tracker = {
            inhibit_cursor_visibility() { calls.push('inhibit'); },
            uninhibit_cursor_visibility() { calls.push('uninhibit'); },
        };
        const mgr = new CursorManager_FIXED(tracker);
        mgr._hideSystemCursor(makeSeat());
        assert.deepEqual(calls, ['inhibit']);
        mgr._showSystemCursor(makeSeat());
        assert.deepEqual(calls, ['inhibit', 'uninhibit']);
    });
});

// ── MonitorManager.getMonitors() filter logic ──

function makeLogger() {
    return { log() {}, log_debug() {} };
}

function makeSettings(monitors, builtinMonitor) {
    return {
        get_string(key) {
            if (key === 'monitors') return monitors;
            if (key === 'builtin-monitor') return builtinMonitor;
            return '';
        },
    };
}

// Replicate getMonitors() logic from MonitorManager (extension.js:1030-1056)
// We accept layoutMonitors as a parameter instead of reading Main.layoutManager.monitors
// so the test can run without GNOME imports.
function getMonitors(monitorNames, settings, logger, layoutMonitors) {
    if (monitorNames == null) {
        logger.log_debug('getMonitors(): _monitorNames not ready yet, returning null');
        return null;
    }
    const enabledMonitors = settings.get_string('monitors');
    if (enabledMonitors == 'all') {
        return layoutMonitors;
    } else if (enabledMonitors == 'built-in' || enabledMonitors == 'external') {
        const builtinMonitorName = settings.get_string('builtin-monitor');
        const monitors = [];
        for (let i = 0; i < layoutMonitors.length; i++) {
            if ((enabledMonitors == 'built-in' && monitorNames[i] == builtinMonitorName) ||
                (enabledMonitors == 'external' && monitorNames[i] != builtinMonitorName)) {
                monitors.push(layoutMonitors[i]);
            }
        }
        return monitors;
    } else {
        logger.log('Unhandled "monitors" setting = ' + enabledMonitors);
        return null;
    }
}

const LAYOUT_MONITORS = [
    { index: 0 },  // built-in
    { index: 1 },  // external #1
    { index: 2 },  // external #2
];
const MONITOR_NAMES = ['Internal Display', 'Dell P2419H', 'LG Ultra Wide'];

describe('MonitorManager.getMonitors() filter logic', () => {
    test('returns null before monitor names are populated', () => {
        assert.equal(getMonitors(null, makeSettings('all', ''), makeLogger(), LAYOUT_MONITORS), null);
    });

    test('"all" returns all layout monitors', () => {
        const result = getMonitors(MONITOR_NAMES, makeSettings('all', ''), makeLogger(), LAYOUT_MONITORS);
        assert.equal(result, LAYOUT_MONITORS);
        assert.equal(result.length, 3);
    });

    test('"built-in" returns only the matching monitor', () => {
        const result = getMonitors(MONITOR_NAMES, makeSettings('built-in', 'Internal Display'), makeLogger(), LAYOUT_MONITORS);
        assert.equal(result.length, 1);
        assert.equal(result[0], LAYOUT_MONITORS[0]);
    });

    test('"external" returns monitors not matching built-in', () => {
        const result = getMonitors(MONITOR_NAMES, makeSettings('external', 'Internal Display'), makeLogger(), LAYOUT_MONITORS);
        assert.equal(result.length, 2);
        assert.equal(result[0], LAYOUT_MONITORS[1]);
        assert.equal(result[1], LAYOUT_MONITORS[2]);
    });

    test('"built-in" with no matching name returns empty array', () => {
        const result = getMonitors(MONITOR_NAMES, makeSettings('built-in', 'Nonexistent'), makeLogger(), LAYOUT_MONITORS);
        assert.deepEqual(result, []);
    });

    test('"external" with only one monitor treats it as external when name differs', () => {
        const result = getMonitors(['External Only'], makeSettings('external', 'Internal Display'), makeLogger(), [LAYOUT_MONITORS[0]]);
        assert.equal(result.length, 1);
    });

    test('unknown monitors setting returns null', () => {
        const result = getMonitors(MONITOR_NAMES, makeSettings('invalid-value', ''), makeLogger(), LAYOUT_MONITORS);
        assert.equal(result, null);
    });
});

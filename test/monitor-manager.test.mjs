import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Test the MonitorManager null-after-disable race condition (issue #58)
// We replicate the MonitorManager logic with the same async patterns.

// Minimal reproduction of the bug pattern in MonitorManager.disable()
// The real code nulls out this._logger before pending async callbacks complete.

class MonitorManager_BUGGY {
    constructor(logger, settings) {
        this._logger = logger;
        this._settings = settings;
        this._displayConfigProxy = null;
        this._backendManager = null;
        this._monitorNames = null;
        this._changeHookFn = null;
        this._monitorsChangedConnection = null;
        this._pendingCallbacks = [];
    }

    setChangeHook(fn) { this._changeHookFn = fn; }

    enable(newDisplayConfigFn, layoutManager) {
        this._backendManager = { get_monitor_for_connector: (c) => 0 };
        this._monitorsChangedConnection = layoutManager.connect('monitors-changed',
            () => this._on_monitors_change());

        newDisplayConfigFn((proxy, error) => {
            if (error) {
                this._logger.log('error: ' + error); // BUG: _logger may be null
                return;
            }
            this._displayConfigProxy = proxy;
            this._on_monitors_change();
        });
    }

    disable(layoutManager) {
        layoutManager.disconnect(this._monitorsChangedConnection);
        this._logger = null;    // BUG: nulled before async callbacks complete
        this._settings = null;
        this._displayConfigProxy = null;
        this._backendManager = null;
        this._monitorNames = null;
        this._changeHookFn = null;
    }

    _on_monitors_change() {
        if (this._displayConfigProxy == null) {
            this._logger.log_debug('skipping'); // BUG: _logger may be null
            return;
        }
        this._displayConfigProxy.GetResourcesRemote((result, error) => {
            if (error) {
                this._logger.log('error'); // BUG: _logger may be null after disable()
                return;
            }
            const monitorNames = [];
            for (const [name, connector] of result) {
                const idx = this._backendManager.get_monitor_for_connector(connector); // BUG: null
                if (idx >= 0) monitorNames[idx] = name;
            }
            this._monitorNames = monitorNames;
            if (this._changeHookFn !== null) this._changeHookFn();
        });
    }
}

class MonitorManager_FIXED {
    constructor(logger, settings) {
        this._logger = logger;
        this._settings = settings;
        this._displayConfigProxy = null;
        this._backendManager = null;
        this._monitorNames = null;
        this._changeHookFn = null;
        this._monitorsChangedConnection = null;
        this._disabled = false;
    }

    setChangeHook(fn) { this._changeHookFn = fn; }

    enable(newDisplayConfigFn, layoutManager) {
        this._disabled = false;
        this._backendManager = { get_monitor_for_connector: (c) => 0 };
        this._monitorsChangedConnection = layoutManager.connect('monitors-changed',
            () => this._on_monitors_change());

        newDisplayConfigFn((proxy, error) => {
            if (this._disabled) return; // FIX: guard
            if (error) {
                this._logger.log('error: ' + error);
                return;
            }
            this._displayConfigProxy = proxy;
            this._on_monitors_change();
        });
    }

    disable(layoutManager) {
        this._disabled = true; // FIX: set flag before nulling
        layoutManager.disconnect(this._monitorsChangedConnection);
        this._logger = null;
        this._settings = null;
        this._displayConfigProxy = null;
        this._backendManager = null;
        this._monitorNames = null;
        this._changeHookFn = null;
    }

    _on_monitors_change() {
        if (this._disabled) return; // FIX: guard
        if (this._displayConfigProxy == null) {
            this._logger.log_debug('skipping');
            return;
        }
        this._displayConfigProxy.GetResourcesRemote((result, error) => {
            if (this._disabled) return; // FIX: guard in nested callback too
            if (error) {
                this._logger.log('error');
                return;
            }
            const monitorNames = [];
            for (const [name, connector] of result) {
                const idx = this._backendManager.get_monitor_for_connector(connector);
                if (idx >= 0) monitorNames[idx] = name;
            }
            this._monitorNames = monitorNames;
            if (this._changeHookFn !== null) this._changeHookFn();
        });
    }
}

function makeLogger() {
    return { log(m) {}, log_debug(m) {} };
}

function makeLayoutManager() {
    const listeners = new Map();
    let id = 1;
    return {
        connect(signal, fn) { const i = id++; listeners.set(i, fn); return i; },
        disconnect(i) { listeners.delete(i); },
        _fireMonitorsChanged() { for (const fn of listeners.values()) fn(); },
    };
}

describe('MonitorManager – null-after-disable race (issue #58)', () => {
    test('BUG: async newDisplayConfig callback fires after disable() → crashes', () => {
        let pendingCallback = null;
        const asyncNewDisplayConfig = (cb) => { pendingCallback = cb; };
        const lm = makeLayoutManager();
        const mm = new MonitorManager_BUGGY(makeLogger(), {});
        mm.enable(asyncNewDisplayConfig, lm);
        mm.disable(lm);
        // Now fire the async callback — _logger is null
        assert.throws(() => {
            pendingCallback(null, 'some error'); // tries this._logger.log() → null crash
        }, TypeError, 'confirms bug: TypeError on null._logger access');
    });

    test('BUG: GetResourcesRemote callback fires after disable() → crashes', () => {
        let pendingGetResources = null;
        const proxy = {
            GetResourcesRemote(cb) { pendingGetResources = cb; },
        };
        const asyncNewDisplayConfig = (cb) => cb(proxy, null); // fires immediately
        const lm = makeLayoutManager();
        const mm = new MonitorManager_BUGGY(makeLogger(), {});
        mm.enable(asyncNewDisplayConfig, lm);
        // At this point, GetResourcesRemote callback is pending
        mm.disable(lm);
        assert.throws(() => {
            pendingGetResources([['Monitor', 'DP-1']], null); // tries this._backendManager → null
        }, TypeError, 'confirms bug: TypeError on null._backendManager access');
    });

    test('FIXED: async callback after disable() is silently ignored', () => {
        let pendingCallback = null;
        const asyncNewDisplayConfig = (cb) => { pendingCallback = cb; };
        const lm = makeLayoutManager();
        const mm = new MonitorManager_FIXED(makeLogger(), {});
        mm.enable(asyncNewDisplayConfig, lm);
        mm.disable(lm);
        assert.doesNotThrow(() => {
            pendingCallback(null, 'some error'); // should return early
        });
    });

    test('FIXED: GetResourcesRemote callback after disable() is silently ignored', () => {
        let pendingGetResources = null;
        const proxy = {
            GetResourcesRemote(cb) { pendingGetResources = cb; },
        };
        const asyncNewDisplayConfig = (cb) => cb(proxy, null);
        const lm = makeLayoutManager();
        const mm = new MonitorManager_FIXED(makeLogger(), {});
        mm.enable(asyncNewDisplayConfig, lm);
        mm.disable(lm);
        assert.doesNotThrow(() => {
            pendingGetResources([['Monitor', 'DP-1']], null);
        });
    });
});

// ── GLib.source_remove(null) in IndicatorManager ──

describe('IndicatorManager – GLib.source_remove(null)', () => {
    test('BUG: source_remove(null) is called when timeout already fired', () => {
        let removedId = undefined;
        const GLib = {
            PRIORITY_DEFAULT: 0,
            SOURCE_REMOVE: false,
            timeout_add(p, ms, cb) { return 42; },
            source_remove(id) { removedId = id; },
        };

        let storedTimeoutId = null;
        storedTimeoutId = GLib.timeout_add(0, 100, () => {
            storedTimeoutId = null; // callback clears itself
            return GLib.SOURCE_REMOVE;
        });

        // Simulate the callback firing (clears _enableTimeoutId to null)
        storedTimeoutId = null;

        // Now disable() calls GLib.source_remove on the (now null) id
        GLib.source_remove(storedTimeoutId); // source_remove(null)

        assert.equal(removedId, null, 'confirms: source_remove(null) is called');
    });

    test('FIXED: guard prevents source_remove(null)', () => {
        let removedId = 'never-set';
        const GLib = {
            source_remove(id) { removedId = id; },
        };

        let storedTimeoutId = null; // already fired, cleared to null

        // Fixed disable():
        if (storedTimeoutId !== null) {
            GLib.source_remove(storedTimeoutId);
            storedTimeoutId = null;
        }

        assert.equal(removedId, 'never-set', 'source_remove was not called');
    });
});

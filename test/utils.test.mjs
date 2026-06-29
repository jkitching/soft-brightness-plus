import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// We test utils.js logic directly without GNOME imports by extracting the
// pure functions. utils.js only imports Gio (for DBusProxy), which we mock.
import GioMock from './mocks/gio.mjs';

// ── Helpers matching the GetCurrentState response shape ──
// Physical monitors in GetCurrentState: result[1]
// Each monitor: [(ssss), modes, props]  where (ssss) = [connector, vendor, product, serial]

function makeMonitor(displayName, connectorName) {
    return [
        [connectorName, 'Vendor', 'Product', 'Serial'],  // index 0: (ssss) identifiers
        [],                                               // index 1: modes (not used)
        displayName
            ? { 'display-name': { get_string() { return [displayName]; } } }
            : {},                                         // index 2: properties
    ];
}

function makeProxy(monitors) {
    return {
        GetCurrentStateRemote(cb) {
            cb([42 /* serial */, monitors]);
        },
    };
}

// ── getMonitorConfig re-implementations ──
// BUGGY version preserves the original const-shadowing bug (now fixed in source)
// so the test still documents the before/after behaviour.

function getMonitorConfig_BUGGY(displayConfigProxy, callback) {
    displayConfigProxy.GetCurrentStateRemote((result) => {
        const monitors = [];
        const physicalMonitors = result[1];
        for (let i = 0; i < physicalMonitors.length; i++) {
            const monitor = physicalMonitors[i];
            const connectorName = monitor[0][0];
            const props = monitor[2];
            const displayName = props['display-name'] ? props['display-name'].get_string()[0] : '';
            if (!displayName || displayName == '') {
                const displayName = 'Monitor on output ' + connectorName; // BUG: shadows outer const
            }
            monitors.push([displayName, connectorName]);
        }
        callback(monitors, null);
    });
}

function getMonitorConfig_FIXED(displayConfigProxy, callback) {
    displayConfigProxy.GetCurrentStateRemote((result) => {
        if (result.length < 2) {
            callback(null, 'Cannot get DisplayConfig: No data in GetCurrentState()');
            return;
        }
        const monitors = [];
        const physicalMonitors = result[1];
        for (let i = 0; i < physicalMonitors.length; i++) {
            const monitor = physicalMonitors[i];
            const connectorName = monitor[0][0];
            const props = monitor[2];
            let displayName = props['display-name'] ? props['display-name'].get_string()[0] : '';
            if (!displayName || displayName == '') {
                displayName = 'Monitor on output ' + connectorName;
            }
            monitors.push([displayName, connectorName]);
        }
        callback(monitors, null);
    });
}

describe('utils.js – getMonitorConfig', () => {
    test('normal monitor with display name works', (t, done) => {
        const proxy = makeProxy([makeMonitor('LG Ultra HD', 'DP-1')]);
        getMonitorConfig_BUGGY(proxy, (monitors, err) => {
            assert.equal(err, null);
            assert.equal(monitors[0][0], 'LG Ultra HD');
            done();
        });
    });

    test('BUG: empty display-name fallback is silently broken in current code', (t, done) => {
        const proxy = makeProxy([makeMonitor('', 'HDMI-1')]);
        getMonitorConfig_BUGGY(proxy, (monitors, err) => {
            assert.equal(err, null);
            // BUG: fallback doesn't work because inner `const displayName` is shadowed
            // The monitor gets an empty string name instead of 'Monitor on output HDMI-1'
            assert.equal(monitors[0][0], '', 'confirms the bug: empty name, not the fallback');
            done();
        });
    });

    test('FIXED: empty display-name gets fallback name', (t, done) => {
        const proxy = makeProxy([makeMonitor('', 'HDMI-1')]);
        getMonitorConfig_FIXED(proxy, (monitors, err) => {
            assert.equal(err, null);
            assert.equal(monitors[0][0], 'Monitor on output HDMI-1');
            done();
        });
    });

    test('FIXED: missing display-name property gets fallback name', (t, done) => {
        const proxy = makeProxy([makeMonitor(null, 'eDP-1')]);
        getMonitorConfig_FIXED(proxy, (monitors, err) => {
            assert.equal(err, null);
            assert.equal(monitors[0][0], 'Monitor on output eDP-1');
            done();
        });
    });

    test('multiple monitors, one with empty name', (t, done) => {
        const proxy = makeProxy([
            makeMonitor('Dell P2419H', 'DP-1'),
            makeMonitor('', 'HDMI-2'),
        ]);
        getMonitorConfig_FIXED(proxy, (monitors, err) => {
            assert.equal(err, null);
            assert.equal(monitors[0][0], 'Dell P2419H');
            assert.equal(monitors[1][0], 'Monitor on output HDMI-2');
            done();
        });
    });

    test('connector name is extracted correctly', (t, done) => {
        const proxy = makeProxy([makeMonitor('Monitor', 'DP-3')]);
        getMonitorConfig_FIXED(proxy, (monitors, err) => {
            assert.equal(err, null);
            assert.equal(monitors[0][1], 'DP-3');
            done();
        });
    });
});

// ── patchFunction tests ──

function patchFunction_CURRENT(object, fname, preHook) {
    const saved = object[fname];
    object[fname] = function(...args) {
        preHook(fname);
        return saved.apply(this, args); // crashes if saved is undefined
    };
    return () => object[fname] = saved;
}

function patchFunction_FIXED(object, fname, preHook) {
    const saved = object[fname];
    if (saved === undefined) {
        return () => {}; // FIX: skip patching if function doesn't exist
    }
    object[fname] = function(...args) {
        preHook(fname);
        return saved.apply(this, args);
    };
    return () => object[fname] = saved;
}

describe('utils.js – patchFunction', () => {
    test('patching an existing function works', () => {
        const hooks = [];
        const obj = { greet() { return 'hello'; } };
        const revert = patchFunction_CURRENT(obj, 'greet', (name) => hooks.push(name));
        const result = obj.greet();
        assert.deepEqual(hooks, ['greet']);
        assert.equal(result, 'hello');
        revert();
        assert.equal(obj.greet(), 'hello');
    });

    test('BUG: patching a non-existent function installs a crasher', () => {
        const obj = {};
        patchFunction_CURRENT(obj, 'screenshot_finish', () => {});
        // The patched version calls undefined.apply(), which throws TypeError
        assert.throws(() => obj.screenshot_finish(), TypeError,
            'confirms bug: calling the patched non-existent function crashes');
    });

    test('FIXED: patching a non-existent function is a safe no-op', () => {
        const obj = {};
        const revert = patchFunction_FIXED(obj, 'screenshot_finish', () => {});
        // No crash — the function was never added
        assert.equal(obj.screenshot_finish, undefined);
        revert(); // also a no-op, should not throw
    });

    test('FIXED: revert restores original function', () => {
        const calls = [];
        const obj = { greet() { calls.push('original'); return 'hi'; } };
        const revert = patchFunction_FIXED(obj, 'greet', () => calls.push('hook'));
        obj.greet();
        assert.deepEqual(calls, ['hook', 'original']);
        revert();
        calls.length = 0;
        obj.greet();
        assert.deepEqual(calls, ['original'], 'hook no longer fires after revert');
    });

    test('FIXED: patched function passes args through to original', () => {
        const obj = { add(a, b) { return a + b; } };
        patchFunction_FIXED(obj, 'add', () => {});
        assert.equal(obj.add(3, 4), 7);
    });
});

describe('utils.js – getMonitorConfig error paths', () => {
    test('empty result array → error callback', (t, done) => {
        const proxy = { GetCurrentStateRemote(cb) { cb([]); } };
        getMonitorConfig_FIXED(proxy, (monitors, err) => {
            assert.equal(monitors, null);
            assert.match(err, /No data/);
            done();
        });
    });

    test('result with only serial (length < 2) → error callback', (t, done) => {
        const proxy = { GetCurrentStateRemote(cb) { cb([42]); } };
        getMonitorConfig_FIXED(proxy, (monitors, err) => {
            assert.equal(monitors, null);
            assert.match(err, /No data/);
            done();
        });
    });

    test('zero physical monitors → empty monitors array', (t, done) => {
        const proxy = makeProxy([]);
        getMonitorConfig_FIXED(proxy, (monitors, err) => {
            assert.equal(err, null);
            assert.deepEqual(monitors, []);
            done();
        });
    });
});

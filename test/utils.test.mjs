import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// We test utils.js logic directly without GNOME imports by extracting the
// pure functions. utils.js only imports Gio (for DBusProxy), which we mock.
import GioMock from './mocks/gio.mjs';

// ── Re-implement getMonitorConfig as it exists in the source (AS-IS, bugs included) ──
// This lets us confirm the bug, then test the fixed version.

function getMonitorConfig_BUGGY(displayConfigProxy, callback) {
    displayConfigProxy.GetResourcesRemote((result) => {
        if (result.length <= 2) {
            callback(null, 'Cannot get DisplayConfig: No outputs in GetResources()');
        } else {
            const monitors = [];
            for (let i = 0; i < result[2].length; i++) {
                const output = result[2][i];
                if (output.length <= 7) {
                    callback(null, 'Cannot get DisplayConfig: No properties on output #' + i);
                    return;
                }
                const props = output[7];
                const displayName = props['display-name'].get_string()[0];
                const connectorName = output[4];
                if (!displayName || displayName == '') {
                    const displayName = 'Monitor on output ' + connectorName; // BUG: shadows outer const
                }
                monitors.push([displayName, connectorName]);
            }
            callback(monitors, null);
        }
    });
}

function getMonitorConfig_FIXED(displayConfigProxy, callback) {
    displayConfigProxy.GetResourcesRemote((result) => {
        if (result.length <= 2) {
            callback(null, 'Cannot get DisplayConfig: No outputs in GetResources()');
        } else {
            const monitors = [];
            for (let i = 0; i < result[2].length; i++) {
                const output = result[2][i];
                if (output.length <= 7) {
                    callback(null, 'Cannot get DisplayConfig: No properties on output #' + i);
                    return;
                }
                const props = output[7];
                let displayName = props['display-name'].get_string()[0]; // FIX: let instead of const
                const connectorName = output[4];
                if (!displayName || displayName == '') {
                    displayName = 'Monitor on output ' + connectorName; // FIX: assigns to outer variable
                }
                monitors.push([displayName, connectorName]);
            }
            callback(monitors, null);
        }
    });
}

function makeOutput(displayName, connectorName) {
    return [
        null, null, null, null,
        connectorName,          // index 4: connector name
        null, null,
        { 'display-name': { get_string() { return [displayName]; } } }, // index 7: props
    ];
}

function makeProxy(outputs) {
    return {
        GetResourcesRemote(cb) {
            cb([null, null, outputs]);
        },
    };
}

describe('utils.js – getMonitorConfig', () => {
    test('normal monitor with display name works', (t, done) => {
        const proxy = makeProxy([makeOutput('LG Ultra HD', 'DP-1')]);
        getMonitorConfig_BUGGY(proxy, (monitors, err) => {
            assert.equal(err, null);
            assert.equal(monitors[0][0], 'LG Ultra HD');
            done();
        });
    });

    test('BUG: empty display-name fallback is silently broken in current code', (t, done) => {
        const proxy = makeProxy([makeOutput('', 'HDMI-1')]);
        getMonitorConfig_BUGGY(proxy, (monitors, err) => {
            assert.equal(err, null);
            // BUG: fallback doesn't work because inner `const displayName` is shadowed
            // The monitor gets an empty string name instead of 'Monitor on output HDMI-1'
            assert.equal(monitors[0][0], '', 'confirms the bug: empty name, not the fallback');
            done();
        });
    });

    test('FIXED: empty display-name gets fallback name', (t, done) => {
        const proxy = makeProxy([makeOutput('', 'HDMI-1')]);
        getMonitorConfig_FIXED(proxy, (monitors, err) => {
            assert.equal(err, null);
            assert.equal(monitors[0][0], 'Monitor on output HDMI-1');
            done();
        });
    });

    test('multiple monitors, one with empty name', (t, done) => {
        const proxy = makeProxy([
            makeOutput('Dell P2419H', 'DP-1'),
            makeOutput('', 'HDMI-2'),
        ]);
        getMonitorConfig_FIXED(proxy, (monitors, err) => {
            assert.equal(err, null);
            assert.equal(monitors[0][0], 'Dell P2419H');
            assert.equal(monitors[1][0], 'Monitor on output HDMI-2');
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
        const proxy = { GetResourcesRemote(cb) { cb([]); } };
        getMonitorConfig_FIXED(proxy, (monitors, err) => {
            assert.equal(monitors, null);
            assert.match(err, /No outputs/);
            done();
        });
    });

    test('result with 2 elements (length ≤ 2) → error callback', (t, done) => {
        const proxy = { GetResourcesRemote(cb) { cb([null, null]); } };
        getMonitorConfig_FIXED(proxy, (monitors, err) => {
            assert.equal(monitors, null);
            assert.match(err, /No outputs/);
            done();
        });
    });

    test('output missing properties (length ≤ 7) → error callback', (t, done) => {
        const shortOutput = [null, null, null, null, 'DP-1', null, null]; // 7 elements, no index 7
        const proxy = { GetResourcesRemote(cb) { cb([null, null, [shortOutput]]); } };
        getMonitorConfig_FIXED(proxy, (monitors, err) => {
            assert.equal(monitors, null);
            assert.match(err, /No properties on output #0/);
            done();
        });
    });

    test('mixed outputs: one valid, one short → error on second', (t, done) => {
        const validOutput = makeOutput('Dell P2419H', 'DP-1');
        const shortOutput = [null, null, null, null, 'HDMI-1', null, null];
        const proxy = { GetResourcesRemote(cb) { cb([null, null, [validOutput, shortOutput]]); } };
        getMonitorConfig_FIXED(proxy, (monitors, err) => {
            assert.equal(monitors, null);
            assert.match(err, /No properties on output #1/);
            done();
        });
    });
});

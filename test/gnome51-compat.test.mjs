import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// GNOME 51 removed ui/pointerWatcher.js and Clutter.get_default_backend().
// These tests import the REAL extension code and cover the replacements.

import Clutter from './mocks/clutter.mjs';
import {
    CursorTrackerPointerWatcher,
    defineShaderEffectGammaCurve,
    getDefaultSeat,
} from '../src/extension.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeCursorTracker() {
    const handlers = new Map();
    let nextId = 1;
    return {
        connect(signal, fn) {
            const id = nextId++;
            handlers.set(id, { signal, fn });
            return id;
        },
        disconnect(id) {
            handlers.delete(id);
        },
        emit(signal) {
            for (const h of [...handlers.values()]) {
                if (h.signal === signal)
                    h.fn();
            }
        },
        connectionCount(signal) {
            return [...handlers.values()].filter(h => h.signal === signal).length;
        },
    };
}

function makeLaters() {
    const pending = new Map();
    let nextId = 1;
    return {
        add(_type, fn) {
            const id = nextId++;
            pending.set(id, fn);
            return id;
        },
        remove(id) {
            pending.delete(id);
        },
        // Simulate the compositor reaching BEFORE_REDRAW.
        run() {
            const fns = [...pending.values()];
            pending.clear();
            fns.forEach(fn => fn());
        },
        get size() {
            return pending.size;
        },
    };
}

let laters;

beforeEach(() => {
    laters = makeLaters();
    global.compositor = { get_laters: () => laters };
});

// ── CursorTrackerPointerWatcher ──────────────────────────────────────────────

describe('CursorTrackerPointerWatcher (GS 51+ PointerWatcher replacement)', () => {
    test('addWatch connects to position-invalidated', () => {
        const tracker = makeCursorTracker();
        const watcher = new CursorTrackerPointerWatcher(tracker);

        watcher.addWatch(1000 / 60, () => {});

        assert.equal(tracker.connectionCount('position-invalidated'), 1);
    });

    test('callback runs before the next redraw, not synchronously', () => {
        const tracker = makeCursorTracker();
        const watcher = new CursorTrackerPointerWatcher(tracker);
        let calls = 0;
        watcher.addWatch(1000 / 60, () => calls++);

        tracker.emit('position-invalidated');
        assert.equal(calls, 0);

        laters.run();
        assert.equal(calls, 1);
    });

    test('several invalidations within a frame coalesce into one callback', () => {
        const tracker = makeCursorTracker();
        const watcher = new CursorTrackerPointerWatcher(tracker);
        let calls = 0;
        watcher.addWatch(1000 / 60, () => calls++);

        tracker.emit('position-invalidated');
        tracker.emit('position-invalidated');
        tracker.emit('position-invalidated');
        assert.equal(laters.size, 1);

        laters.run();
        assert.equal(calls, 1);

        // A later frame schedules a new callback.
        tracker.emit('position-invalidated');
        laters.run();
        assert.equal(calls, 2);
    });

    test('remove() disconnects and cancels a pending callback', () => {
        const tracker = makeCursorTracker();
        const watcher = new CursorTrackerPointerWatcher(tracker);
        let calls = 0;
        const watch = watcher.addWatch(1000 / 60, () => calls++);

        tracker.emit('position-invalidated');
        watch.remove();

        assert.equal(tracker.connectionCount('position-invalidated'), 0);
        assert.equal(laters.size, 0);
        laters.run();
        tracker.emit('position-invalidated');
        laters.run();
        assert.equal(calls, 0);
    });

    test('watch can be removed and re-added (idle pause/resume)', () => {
        const tracker = makeCursorTracker();
        const watcher = new CursorTrackerPointerWatcher(tracker);
        let calls = 0;

        watcher.addWatch(1000 / 60, () => calls++).remove();
        watcher.addWatch(1000 / 60, () => calls++);

        assert.equal(tracker.connectionCount('position-invalidated'), 1);
        tracker.emit('position-invalidated');
        laters.run();
        assert.equal(calls, 1);
    });
});

// ── getDefaultSeat ───────────────────────────────────────────────────────────

describe('getDefaultSeat()', () => {
    let savedGetDefaultBackend;

    beforeEach(() => {
        savedGetDefaultBackend = Clutter.get_default_backend;
    });

    afterEach(() => {
        Clutter.get_default_backend = savedGetDefaultBackend;
        delete global.stage;
    });

    test('GS 45–50: uses Clutter.get_default_backend()', () => {
        assert.equal(getDefaultSeat(), Clutter._mockSeat);
    });

    test('GS 51+: falls back to global.stage.context.get_backend()', () => {
        const seat = { name: 'gs51-seat' };
        Clutter.get_default_backend = undefined;
        global.stage = {
            context: {
                get_backend() {
                    return { get_default_seat: () => seat };
                },
            },
        };

        assert.equal(getDefaultSeat(), seat);
    });
});

// ── GammaCurveEffect on Clutter.ShaderEffect ─────────────────────────────────

describe('GammaCurveEffect on Clutter.ShaderEffect (GS 51+)', () => {
    const ShaderGammaCurveEffect = defineShaderEffectGammaCurve();

    // Paint into the framebuffer of the stage area `area`: like Clutter, a
    // viewport spanning the whole stage, offset by the area's position.
    function paintContextFor(area) {
        const framebuffer = {
            get_viewport_x: () => -area.x,
            get_viewport_y: () => -area.y,
            get_viewport_width: () => global.stage.width,
            get_width: () => area.width,
            get_height: () => area.height,
        };
        return { get_framebuffer: () => framebuffer };
    }
    function effectOn(brightness, monitorRects) {
        const actor = new Clutter.Actor();
        const e = new ShaderGammaCurveEffect(brightness, monitorRects);
        actor.add_effect_with_name('soft-brightness-plus-shader', e);
        return e;
    }

    const left = { x: 0, y: 0, width: 1920, height: 1080 };
    const right = { x: 1920, y: 0, width: 1680, height: 1050 };
    beforeEach(() => {
        global.stage = { width: 3600, height: 1080 };
    });

    test('extends Clutter.ShaderEffect', () => {
        assert.ok(new ShaderGammaCurveEffect(0.5, []) instanceof Clutter.ShaderEffect);
    });

    test('static snippet is a fragment snippet scaling by u_brightness', () => {
        const snippet = new ShaderGammaCurveEffect(0.5, []).vfunc_get_static_snippet();

        assert.equal(snippet.hook, 'fragment');
        assert.match(snippet.declarations, /uniform float u_brightness;/);
        assert.match(snippet.post, /u_brightness/);
    });

    test('sets u_brightness by name at paint time', () => {
        const e = effectOn(0.5, []);
        e.vfunc_paint_target(null, paintContextFor(left));
        assert.deepEqual(e._uniforms.u_brightness, { size: 1, values: [0.5] });
    });

    test('leaves views of unselected monitors at full brightness', () => {
        const e = effectOn(0.5, [right]);
        e.vfunc_paint_target(null, paintContextFor(right));
        assert.deepEqual(e._uniforms.u_brightness.values, [0.5]);
        e.vfunc_paint_target(null, paintContextFor(left));
        assert.deepEqual(e._uniforms.u_brightness.values, [1.0]);
    });

    test('skips the effect for actors that paint nothing', () => {
        const e = effectOn(0.5, []);
        assert.equal(e.vfunc_pre_paint(null, null), true);
        e.get_actor()._paintVolumeSize = [1024, 0];
        assert.equal(e.vfunc_pre_paint(null, null), false);
    });

    test('update() stores new parameters and queues a repaint', () => {
        const e = effectOn(0.5, []);
        e.update(0.3, []);
        assert.equal(e._repaints, 1);
        e.vfunc_paint_target(null, paintContextFor(left));
        assert.deepEqual(e._uniforms.u_brightness.values, [0.3]);
    });
});

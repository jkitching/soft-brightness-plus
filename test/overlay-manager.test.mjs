import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// These tests import the REAL extension code (via the gi:// mock loader in
// hooks.mjs) rather than replicating logic. They cover the shader dimming
// lifecycle: target selection, the settings-storm dedup guard, actor churn
// (stage children, window creation/destruction), screenshot hiding, monitor
// UV targeting and debug-LUT parsing.
//
// Deliberately NOT covered: the highlight-compression (shader-gamma) curve
// behavior — the curve is still being tuned and its UI is hidden. Tests run
// with shader-gamma = 1.0 (pure backlight-like scaling).

import Clutter from './mocks/clutter.mjs';
import Main from './mocks/main.mjs';
import ShellMock from './mocks/shell.mjs';
import { makeSettings } from './mocks/settings-factory.mjs';
import {
    OverlayManager,
    GammaCurveEffect,
    ScreenshotManager,
    MAX_SHADER_MONITORS,
    CURVE_LUT_SIZE,
} from '../src/extension.js';

const Actor = Clutter.Actor;
const logger = { log() {}, log_debug() {} };

// ── environment helpers ──────────────────────────────────────────────────────

let windowActors;

function setupGlobals() {
    const stage = new Actor();
    stage.name = 'stage';
    stage.width = 1920;
    stage.height = 1080;

    const windowGroup = new Actor();
    windowGroup.name = 'window_group';
    stage.add_child(windowGroup);

    const display = new Actor(); // used only as a signal emitter
    windowActors = [];

    global.stage = stage;
    global.window_group = windowGroup;
    global.display = display;
    global.screen_width = 1920;
    global.screen_height = 1080;
    global.get_window_actors = () => windowActors;

    return { stage, windowGroup, display };
}

function makeOverlay({ settings: overrides = {}, monitors = null } = {}) {
    const settings = makeSettings(overrides);
    const monitorManager = { getMonitors: () => monitors };
    const om = new OverlayManager(logger, settings, monitorManager);
    om.enable();
    return { om, settings, monitorManager };
}

function effectsOf(actor) {
    return actor.get_effects();
}

beforeEach(() => {
    Main._reset();
    setupGlobals();
});

// ── show() target selection and lifecycle ────────────────────────────────────

describe('OverlayManager.show(): shader target selection', () => {
    test('applies shader to stage children and window actors, skips window_group and cursor-clone group', () => {
        const bg = new Actor();
        global.stage.add_child(bg);
        const w1 = new Actor(), w2 = new Actor();
        windowActors.push(w1, w2);

        const { om } = makeOverlay();
        om.show(0.5);

        for (const target of [bg, w1, w2]) {
            assert.equal(effectsOf(target).length, 1);
            assert.ok(effectsOf(target)[0] instanceof GammaCurveEffect);
        }
        assert.equal(effectsOf(global.window_group).length, 0,
            'MetaWindowGroup must not carry the shader (cannot be FBO-redirected)');
        const actorGroup = Main.uiGroup.get_children()
            .find(c => c.name === 'soft-brightness-plus-overlays');
        assert.ok(actorGroup, 'cursor-clone group is hosted in uiGroup');
        assert.equal(effectsOf(actorGroup).length, 0,
            'cursor-clone group must not carry the shader (moves every frame)');
    });

    test('identical repeated show() is a no-op (settings-storm guard)', () => {
        const bg = new Actor();
        global.stage.add_child(bg);
        const { om } = makeOverlay();

        om.show(0.5);
        const effect = effectsOf(bg)[0];
        const repaintsBefore = effect._repaints;

        om.show(0.5);
        assert.equal(effectsOf(bg)[0], effect, 'effect not recreated');
        assert.equal(effect._repaints, repaintsBefore, 'no redundant update/repaint');
    });

    test('brightness change updates existing effects in place', () => {
        const bg = new Actor();
        global.stage.add_child(bg);
        const { om } = makeOverlay();

        om.show(0.5);
        const effect = effectsOf(bg)[0];
        om.show(0.7);

        assert.equal(effectsOf(bg).length, 1);
        assert.equal(effectsOf(bg)[0], effect, 'same effect object reused');
        assert.equal(effect._repaints, 1, 'update() queued exactly one repaint');
        effect.vfunc_paint_target();
        assert.deepEqual(effect._uniforms.u_brightness.values, [0.7]);
    });

    test('show() re-enables effects disabled by hideForScreenshot()', () => {
        const bg = new Actor();
        global.stage.add_child(bg);
        const { om } = makeOverlay();

        om.show(0.5);
        const effect = effectsOf(bg)[0];
        om.hideForScreenshot();
        assert.equal(effect.enabled, false);

        om.show(0.5); // same params — must still re-apply because enabled=false
        assert.equal(effect.enabled, true);
    });

    test('monitor selection matching nothing dims nothing', () => {
        const bg = new Actor();
        global.stage.add_child(bg);
        // 'external' while undocked: getMonitors() returns []
        const { om } = makeOverlay({ settings: { monitors: 'external' }, monitors: [] });

        om.show(0.5);
        assert.equal(effectsOf(bg).length, 0);
        assert.equal(om.initialized(), false);
    });
});

// ── actor churn while dimming ────────────────────────────────────────────────

describe('OverlayManager: stage and window churn', () => {
    test('child added to stage while dimming gets the shader', () => {
        const { om } = makeOverlay();
        om.show(0.5);

        const late = new Actor();
        global.stage.add_child(late); // mock emits child-added
        assert.equal(effectsOf(late).length, 1);
    });

    test('child added while not dimming gets no shader', () => {
        makeOverlay();
        const late = new Actor();
        global.stage.add_child(late);
        assert.equal(effectsOf(late).length, 0);
    });

    test('child removed from stage loses shader and destroy handler', () => {
        const bg = new Actor();
        global.stage.add_child(bg);
        const { om } = makeOverlay();
        om.show(0.5);
        assert.equal(bg._connections.length, 1, 'destroy handler connected');

        global.stage.remove_child(bg); // mock emits child-removed
        assert.equal(effectsOf(bg).length, 0);
        assert.equal(bg._connections.length, 0, 'destroy handler disconnected');
    });

    test('destroyed actor is dropped from shader bookkeeping', () => {
        const w1 = new Actor();
        windowActors.push(w1);
        const { om } = makeOverlay();
        om.show(0.5);
        assert.equal(effectsOf(w1).length, 1);

        w1.destroy(); // mock emits 'destroy'
        assert.equal(effectsOf(w1).length, 0);
        assert.ok(!om._shaderTargets.some(t => t.actor === w1));
    });

    test('window-created applies shader to the new window actor', () => {
        const { om } = makeOverlay();
        om.show(0.5);

        const win = new Actor();
        global.display.emit('window-created', { get_compositor_private: () => win });
        assert.equal(effectsOf(win).length, 1);
        assert.ok(om._shaderTargets.some(t => t.actor === win && t.destroyId));
    });

    test('window-created while not dimming applies nothing', () => {
        makeOverlay();
        const win = new Actor();
        global.display.emit('window-created', { get_compositor_private: () => win });
        assert.equal(effectsOf(win).length, 0);
    });
});

// ── hide() ───────────────────────────────────────────────────────────────────

describe('OverlayManager.hide()', () => {
    test('removes all effects and disconnects destroy handlers', () => {
        const bg = new Actor();
        global.stage.add_child(bg);
        const w1 = new Actor();
        windowActors.push(w1);
        const { om } = makeOverlay();
        om.show(0.5);

        om.hide();
        for (const target of [bg, w1]) {
            assert.equal(effectsOf(target).length, 0);
            assert.equal(target._connections.length, 0);
        }
        assert.equal(om.initialized(), false);
        assert.doesNotThrow(() => om.hide(), 'repeated hide is safe');
    });

    test('show() after hide() re-applies fresh effects', () => {
        const bg = new Actor();
        global.stage.add_child(bg);
        const { om } = makeOverlay();
        om.show(0.5);
        const first = effectsOf(bg)[0];
        om.hide();
        om.show(0.5);
        assert.equal(effectsOf(bg).length, 1);
        assert.notEqual(effectsOf(bg)[0], first, 'new effect after full hide');
    });
});

// ── monitor UV targeting ─────────────────────────────────────────────────────

describe('OverlayManager._getShaderMonitorRects()', () => {
    test("'all' dims entire actors (empty rect list)", () => {
        const { om } = makeOverlay();
        assert.deepEqual(om._getShaderMonitorRects(), []);
    });

    test('selection matching no monitor returns null (dim nothing)', () => {
        const { om } = makeOverlay({ settings: { monitors: 'built-in' }, monitors: [] });
        assert.equal(om._getShaderMonitorRects(), null);
        const { om: om2 } = makeOverlay({ settings: { monitors: 'built-in' }, monitors: null });
        assert.equal(om2._getShaderMonitorRects(), null);
    });

    test('maps monitor geometry to stage-relative UV rects', () => {
        global.stage.width = 3840;
        global.stage.height = 1080;
        const { om } = makeOverlay({
            settings: { monitors: 'external' },
            monitors: [{ x: 1920, y: 0, width: 1920, height: 1080 }],
        });
        assert.deepEqual(om._getShaderMonitorRects(),
            [{ x: 0.5, y: 0, w: 0.5, h: 1 }]);
    });
});

// ── debug curve LUT parsing ──────────────────────────────────────────────────

describe('OverlayManager._getDebugCurveLut()', () => {
    function lutFor(curve) {
        const { om } = makeOverlay({ settings: { 'debug-curve': curve } });
        return om._getDebugCurveLut();
    }

    test('empty setting → null (formula dimming applies)', () => {
        assert.equal(lutFor(''), null);
    });

    test('fewer than 2 valid samples → null', () => {
        assert.equal(lutFor('0.5'), null);
        assert.equal(lutFor('garbage'), null);
    });

    test('two samples resample linearly to the full LUT', () => {
        const lut = lutFor('0,1');
        assert.equal(lut.length, CURVE_LUT_SIZE);
        assert.equal(lut[0], 0);
        assert.equal(lut[CURVE_LUT_SIZE - 1], 1);
        for (let i = 1; i < lut.length; i++)
            assert.ok(lut[i] >= lut[i - 1], 'monotonic for a linear ramp');
    });

    test('samples are clamped to [0, 1]', () => {
        const lut = lutFor('-1,2');
        assert.ok(lut.every(v => v >= 0 && v <= 1));
        assert.equal(lut[0], 0);
        assert.equal(lut[CURVE_LUT_SIZE - 1], 1);
    });
});

// ── GammaCurveEffect uniform packing ─────────────────────────────────────────
// (Curve *behavior* is intentionally untested — see header note.)

describe('GammaCurveEffect uniforms', () => {
    test('packs brightness, monitor count and zero-padded rects', () => {
        const rect = { x: 0.25, y: 0, w: 0.5, h: 1 };
        const e = new GammaCurveEffect(0.5, 1.0, [rect], null);
        e.vfunc_paint_target();

        assert.deepEqual(e._uniforms.u_brightness.values, [0.5]);
        assert.deepEqual(e._uniforms.u_monitor_count.values, [1]);
        const flat = e._uniforms.u_monitor_rects.values;
        assert.equal(flat.length, MAX_SHADER_MONITORS * 4);
        assert.deepEqual(flat.slice(0, 4), [0.25, 0, 0.5, 1]);
        assert.ok(flat.slice(4).every(v => v === 0), 'unused slots zero-padded');
    });

    test('monitor count is clamped to MAX_SHADER_MONITORS', () => {
        const rects = Array.from({ length: 6 }, (_, i) => ({ x: i / 10, y: 0, w: 0.1, h: 1 }));
        const e = new GammaCurveEffect(0.5, 1.0, rects, null);
        e.vfunc_paint_target();
        assert.deepEqual(e._uniforms.u_monitor_count.values, [MAX_SHADER_MONITORS]);
    });

    test('LUT flag reflects presence of a debug curve', () => {
        const noLut = new GammaCurveEffect(0.5, 1.0, [], null);
        noLut.vfunc_paint_target();
        assert.deepEqual(noLut._uniforms.u_lut_on.values, [0]);
        assert.equal(noLut._uniforms.u_lut.values.length, CURVE_LUT_SIZE);

        const lut = Array.from({ length: CURVE_LUT_SIZE }, (_, i) => i / (CURVE_LUT_SIZE - 1));
        const withLut = new GammaCurveEffect(0.5, 1.0, [], lut);
        withLut.vfunc_paint_target();
        assert.deepEqual(withLut._uniforms.u_lut_on.values, [1]);
        assert.deepEqual(withLut._uniforms.u_lut.values, lut);
    });

    test('update() stores new parameters and queues a repaint', () => {
        const e = new GammaCurveEffect(0.5, 1.0, [], null);
        e.update(0.3, 1.0, [], null);
        assert.equal(e._repaints, 1);
        e.vfunc_paint_target();
        assert.deepEqual(e._uniforms.u_brightness.values, [0.3]);
    });
});

// ── ScreenshotManager hook plumbing ──────────────────────────────────────────

describe('ScreenshotManager', () => {
    test('pre/post hooks fire around patched screenshot calls; disable() restores', async () => {
        const proto = ShellMock.Screenshot.prototype;
        const originals = { screenshot: proto.screenshot, screenshot_area: proto.screenshot_area };

        const order = [];
        const sm = new ScreenshotManager(logger);
        sm.setPreCaptureHook(() => order.push('pre'));
        sm.setPostCaptureHook(() => order.push('post'));
        sm.enable();

        assert.notEqual(proto.screenshot, originals.screenshot, 'screenshot patched');
        await proto.screenshot.call({});
        assert.deepEqual(order, ['pre', 'post']);

        sm.disable();
        assert.equal(proto.screenshot, originals.screenshot, 'screenshot restored');
        assert.equal(proto.screenshot_area, originals.screenshot_area, 'screenshot_area restored');
    });
});

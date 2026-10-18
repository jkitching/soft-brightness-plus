import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// These tests import the REAL extension code (via the gi:// mock loader in
// hooks.mjs) rather than replicating logic. They cover the shader dimming
// lifecycle: target selection, the settings-storm dedup guard, actor churn
// (stage, uiGroup and window group children), screenshot hiding and
// per-view monitor targeting.

import Clutter from './mocks/clutter.mjs';
import Main from './mocks/main.mjs';
import Meta from './mocks/meta.mjs';
import ShellMock from './mocks/shell.mjs';
import { makeSettings } from './mocks/settings-factory.mjs';
import {
    OverlayManager,
    GammaCurveEffect,
    ScreenshotManager,
    brightnessForArea,
    paintedStageArea,
} from '../src/extension.js';

const Actor = Clutter.Actor;
const logger = { log() {}, log_debug() {} };

// ── environment helpers ──────────────────────────────────────────────────────

// Mirrors GNOME Shell's real actor tree (ui/layout.js): the window groups
// are children of uiGroup, not of the stage, and the background group lives
// inside window_group.  Like mutter, tests add window actors to
// window_group (or top_window_group for override-redirect windows).
// Unredirection inhibit count, like mutter's disable_unredirect_count.
let unredirectInhibits;

function setupGlobals() {
    unredirectInhibits = 0;
    global.compositor = {
        disable_unredirect() { unredirectInhibits++; },
        enable_unredirect() { unredirectInhibits--; },
    };

    const stage = new Actor();
    stage.name = 'stage';
    stage.width = 1920;
    stage.height = 1080;

    stage.add_child(Main.uiGroup);

    const windowGroup = new Meta.WindowGroup();
    windowGroup.name = 'window_group';
    Main.uiGroup.add_child(windowGroup);

    const backgroundGroup = new Meta.BackgroundGroup();
    windowGroup.add_child(backgroundGroup);

    const topWindowGroup = new Meta.WindowGroup();
    topWindowGroup.name = 'top_window_group';
    Main.uiGroup.add_child(topWindowGroup);

    global.stage = stage;
    global.window_group = windowGroup;
    global.top_window_group = topWindowGroup;
    global.screen_width = 1920;
    global.screen_height = 1080;

    return { stage, windowGroup, topWindowGroup, backgroundGroup };
}

// Every actor on the path from `actor` up to the stage, `actor` included.
function selfAndAncestors(actor) {
    const chain = [];
    for (let a = actor; a; a = a.get_parent() === a ? null : a.get_parent())
        chain.push(a);
    return chain;
}

// Stand-in for the ClutterPaintContext of a paint into the framebuffer of
// the stage area `area` (a monitor's view, or a screencast of it): like
// Clutter, give it a viewport spanning the whole stage, offset by the
// area's position.  null = a framebuffer without such a viewport.
function paintContextFor(area, scale = 1) {
    const framebuffer = area ? {
        get_viewport_x: () => -area.x * scale,
        get_viewport_y: () => -area.y * scale,
        get_viewport_width: () => global.stage.width * scale,
        get_width: () => area.width * scale,
        get_height: () => area.height * scale,
    } : {
        get_viewport_x: () => 0,
        get_viewport_y: () => 0,
        get_viewport_width: () => 0,
        get_width: () => 0,
        get_height: () => 0,
    };
    return { get_framebuffer: () => framebuffer };
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

// A GammaCurveEffect attached to an actor, as the extension paints them.
function attachedEffect(brightness, monitorRects) {
    const effect = new GammaCurveEffect(brightness, monitorRects);
    new Actor().add_effect_with_name('soft-brightness-plus-shader', effect);
    return effect;
}

// Brightness `effect` paints its actor at through a Clutter.Clone of it.
function clonePaintBrightness(effect, paintContext) {
    const actor = effect.get_actor();
    actor._inClonePaint = true;
    try {
        effect.vfunc_paint_target(null, paintContext);
    } finally {
        actor._inClonePaint = false;
    }
    return effect._uniforms.u_brightness.values[0];
}

let tree;

beforeEach(() => {
    Main._reset();
    tree = setupGlobals();
});

// ── show() target selection and lifecycle ────────────────────────────────────

describe('OverlayManager.show(): shader target selection', () => {
    test('applies shader to the children of the stage, uiGroup and the window groups', () => {
        const panel = new Actor();
        Main.uiGroup.add_child(panel);
        const stageLevel = new Actor();
        global.stage.add_child(stageLevel);
        const w1 = new Actor(), w2 = new Actor();
        global.window_group.add_child(w1);
        global.top_window_group.add_child(w2);
        const tilePreview = new Actor();
        global.window_group.add_child(tilePreview);

        const { om } = makeOverlay();
        om.show(0.5);

        for (const target of [panel, stageLevel, tree.backgroundGroup, w1, w2, tilePreview]) {
            assert.equal(effectsOf(target).length, 1);
            assert.ok(effectsOf(target)[0] instanceof GammaCurveEffect);
        }
    });

    test('skips uiGroup, the MetaWindowGroups and the cursor-clone group', () => {
        const { om } = makeOverlay();
        om.show(0.5);

        assert.equal(effectsOf(Main.uiGroup).length, 0,
            'uiGroup contains window_group, so it must not carry the shader');
        assert.equal(effectsOf(global.window_group).length, 0,
            'MetaWindowGroup must not carry the shader (cannot be FBO-redirected)');
        assert.equal(effectsOf(global.top_window_group).length, 0);
        const actorGroup = Main.uiGroup.get_children()
            .find(c => c.name === 'soft-brightness-plus-overlays');
        assert.ok(actorGroup, 'cursor-clone group is hosted in uiGroup');
        assert.equal(effectsOf(actorGroup).length, 0,
            'cursor-clone group must not carry the shader (moves every frame)');
    });

    test('no actor containing window_group carries the shader', () => {
        const w1 = new Actor();
        global.window_group.add_child(w1);
        const { om } = makeOverlay();
        om.show(0.5);

        for (const a of selfAndAncestors(global.window_group))
            assert.equal(effectsOf(a).length, 0, `${a.name} must not be redirected`);
        // ...so a window is dimmed once, by its own effect only.
        const dimmingAncestors = selfAndAncestors(w1).filter(a => effectsOf(a).length > 0);
        assert.deepEqual(dimmingAncestors, [w1]);
    });

    test('a window shown through a clone (overview preview) is dimmed once', () => {
        const w1 = new Actor();
        global.window_group.add_child(w1);
        const overviewGroup = new Actor();
        Main.uiGroup.add_child(overviewGroup);
        const preview = new Clutter.Clone({ source: w1 });
        overviewGroup.add_child(preview);

        const { om } = makeOverlay();
        om.show(0.5);

        // The clone is dimmed by its dimmed ancestor...
        const dimmingAncestors = selfAndAncestors(preview).filter(a => effectsOf(a).length > 0);
        assert.deepEqual(dimmingAncestors, [overviewGroup]);
        // ...so the window's own effect must not dim the clone paint again.
        const left = { x: 0, y: 0, width: 1920, height: 1080 };
        assert.equal(clonePaintBrightness(effectsOf(w1)[0], paintContextFor(left)), 1.0);
        effectsOf(w1)[0].vfunc_paint_target(null, paintContextFor(left));
        assert.deepEqual(effectsOf(w1)[0]._uniforms.u_brightness.values, [0.5],
            'the window itself is still dimmed');
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
        effect.vfunc_paint_target(null, paintContextFor(null));
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
        assert.equal(unredirectInhibits, 0);
    });

    test('inhibits unredirection once while dimming (fullscreen windows stay dimmed)', () => {
        const { om } = makeOverlay();
        om.show(0.5);
        om.show(0.4);
        assert.equal(unredirectInhibits, 1);
        om.hideForScreenshot();
        assert.equal(unredirectInhibits, 1, 'screenshots keep compositing');
        om.hide();
        assert.equal(unredirectInhibits, 0);
        om.hide();
        assert.equal(unredirectInhibits, 0, 'hide() is balanced');
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

    test('child added to uiGroup while dimming gets the shader', () => {
        const { om } = makeOverlay();
        om.show(0.5);

        const popup = new Actor();
        Main.uiGroup.add_child(popup);
        assert.equal(effectsOf(popup).length, 1);
        assert.equal(om._shaderTargets.filter(t => t.actor === popup).length, 1);
    });

    test('windows added to and removed from the window groups follow the shader', () => {
        const { om } = makeOverlay();
        om.show(0.5);

        for (const group of [global.window_group, global.top_window_group]) {
            const win = new Actor();
            group.add_child(win);
            assert.equal(effectsOf(win).length, 1);
            assert.ok(om._shaderTargets.some(t => t.actor === win && t.destroyId));

            group.remove_child(win);
            assert.equal(effectsOf(win).length, 0);
            assert.equal(win._connections.length, 0, 'destroy handler disconnected');
        }
    });

    test('window added while not dimming gets no shader', () => {
        makeOverlay();
        const win = new Actor();
        global.window_group.add_child(win);
        assert.equal(effectsOf(win).length, 0);
    });

    test('MetaWindowGroup added to uiGroup while dimming gets no shader', () => {
        const { om } = makeOverlay();
        om.show(0.5);

        const feedbackGroup = new Meta.WindowGroup();
        Main.uiGroup.add_child(feedbackGroup);
        assert.equal(effectsOf(feedbackGroup).length, 0);
    });

    test('child removed from uiGroup loses shader and destroy handler', () => {
        const popup = new Actor();
        Main.uiGroup.add_child(popup);
        const { om } = makeOverlay();
        om.show(0.5);
        assert.equal(popup._connections.length, 1, 'destroy handler connected');

        Main.uiGroup.remove_child(popup);
        assert.equal(effectsOf(popup).length, 0);
        assert.equal(popup._connections.length, 0, 'destroy handler disconnected');
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
        global.window_group.add_child(w1);
        const { om } = makeOverlay();
        om.show(0.5);
        assert.equal(effectsOf(w1).length, 1);

        w1.destroy(); // mock emits 'destroy'
        assert.equal(effectsOf(w1).length, 0);
        assert.ok(!om._shaderTargets.some(t => t.actor === w1));
    });
});

// ── hide() ───────────────────────────────────────────────────────────────────

describe('OverlayManager.hide()', () => {
    test('removes all effects and disconnects destroy handlers', () => {
        const bg = new Actor();
        global.stage.add_child(bg);
        const w1 = new Actor();
        global.window_group.add_child(w1);
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

    test('disable() disconnects from every container', () => {
        const { om } = makeOverlay();
        om.show(0.5);
        om.disable();
        for (const c of [global.stage, Main.uiGroup, global.window_group, global.top_window_group])
            assert.equal(c._connections.length, 0, `${c.name} still connected`);
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

// ── monitor targeting ────────────────────────────────────────────────────────

describe('OverlayManager._getDimmedMonitorRects()', () => {
    test("'all' dims every monitor (empty rect list)", () => {
        const { om } = makeOverlay();
        assert.deepEqual(om._getDimmedMonitorRects(), []);
    });

    test('selection matching no monitor returns null (dim nothing)', () => {
        const { om } = makeOverlay({ settings: { monitors: 'built-in' }, monitors: [] });
        assert.equal(om._getDimmedMonitorRects(), null);
        const { om: om2 } = makeOverlay({ settings: { monitors: 'built-in' }, monitors: null });
        assert.equal(om2._getDimmedMonitorRects(), null);
    });

    test('returns the selected monitors in stage coordinates', () => {
        const { om } = makeOverlay({
            settings: { monitors: 'external' },
            monitors: [{ x: 1920, y: 0, width: 1920, height: 1080, index: 1 }],
        });
        assert.deepEqual(om._getDimmedMonitorRects(),
            [{ x: 1920, y: 0, width: 1920, height: 1080 }]);
    });
});

describe('brightnessForArea()', () => {
    const left = { x: 0, y: 0, width: 1920, height: 1080 };
    const right = { x: 1920, y: 0, width: 1680, height: 1050 };

    test("'all' dims everywhere", () => {
        assert.equal(brightnessForArea(0.4, [], right), 0.4);
    });

    test('dims only the areas of the selected monitors', () => {
        assert.equal(brightnessForArea(0.4, [right], right), 0.4);
        assert.equal(brightnessForArea(0.4, [right], left), 1.0);
    });

    test('dims when the painted area is unknown', () => {
        assert.equal(brightnessForArea(0.4, [right], null), 0.4);
    });
});

describe('paintedStageArea()', () => {
    test('recovers the painted monitor area from the viewport', () => {
        global.stage.width = 3600;
        const right = { x: 1920, y: 0, width: 1680, height: 1050 };
        assert.deepEqual(paintedStageArea(paintContextFor(right)), right);
    });

    test('accounts for the framebuffer scale (HiDPI)', () => {
        global.stage.width = 3600;
        const right = { x: 1920, y: 0, width: 1680, height: 1050 };
        assert.deepEqual(paintedStageArea(paintContextFor(right, 2)), right);
    });

    test('null without a stage viewport', () => {
        assert.equal(paintedStageArea(paintContextFor(null)), null);
    });
});

describe('OverlayManager.brightnessAt() (cursor clone)', () => {
    test('full brightness when not dimming', () => {
        const { om } = makeOverlay();
        assert.equal(om.brightnessAt(10, 10), 1.0);
    });

    test("'all': current brightness everywhere", () => {
        const { om } = makeOverlay();
        om.show(0.6);
        assert.equal(om.brightnessAt(10, 10), 0.6);
        assert.equal(om.brightnessAt(3000, 10), 0.6);
    });

    test('dims only over the selected monitors', () => {
        const { om } = makeOverlay({
            settings: { monitors: 'external' },
            monitors: [{ x: 1920, y: 0, width: 1920, height: 1080 }],
        });
        om.show(0.6);
        assert.equal(om.brightnessAt(2000, 500), 0.6);
        assert.equal(om.brightnessAt(100, 500), 1.0);
    });
});

// ── GammaCurveEffect uniforms ────────────────────────────────────────────────

describe('GammaCurveEffect.pre_paint', () => {
    test('paints with the effect when the actor has a paint area', () => {
        const actor = new Actor();
        const e = new GammaCurveEffect(0.5, []);
        actor.add_effect_with_name('soft-brightness-plus-shader', e);
        assert.equal(e.vfunc_pre_paint(null, null), true);
    });

    test('skips the effect for actors that paint nothing (no 0-sized FBO)', () => {
        const actor = new Actor();
        const e = new GammaCurveEffect(0.5, []);
        actor.add_effect_with_name('soft-brightness-plus-shader', e);
        for (const size of [[0, 0], [1024, 0], [0, 32]]) {
            actor._paintVolumeSize = size;
            assert.equal(e.vfunc_pre_paint(null, null), false, `paint volume ${size}`);
        }
    });

    test('falls back to the allocation when the paint volume is unknown', () => {
        const actor = new Actor();
        const e = new GammaCurveEffect(0.5, []);
        actor.add_effect_with_name('soft-brightness-plus-shader', e);
        actor._paintVolumeSize = null;
        actor._allocationSize = [1024, 768];
        assert.equal(e.vfunc_pre_paint(null, null), true);
        actor._allocationSize = [1024, 0];
        assert.equal(e.vfunc_pre_paint(null, null), false);
    });
});

describe('OverlayManager: effect removal', () => {
    test('does not remove an effect Clutter already detached', () => {
        const popup = new Actor();
        Main.uiGroup.add_child(popup);
        const { om } = makeOverlay();
        om.show(0.5);
        const effect = effectsOf(popup)[0];

        let removeCalls = 0;
        const removeEffect = popup.remove_effect.bind(popup);
        popup.remove_effect = e => { removeCalls++; removeEffect(e); };
        effect._actor = null; // what Clutter does while destroying the actor

        om.hide();
        assert.equal(removeCalls, 0, 'no "not attached" warning');
    });
});

describe('GammaCurveEffect uniforms', () => {
    const left = { x: 0, y: 0, width: 1920, height: 1080 };
    const right = { x: 1920, y: 0, width: 1920, height: 1080 };

    test('sets the brightness uniform at paint time', () => {
        const e = attachedEffect(0.5, []);
        e.vfunc_paint_target(null, paintContextFor(left));
        assert.deepEqual(e._uniforms.u_brightness.values, [0.5]);
    });

    test('leaves areas of unselected monitors at full brightness', () => {
        global.stage.width = 3840;
        const e = attachedEffect(0.5, [right]);

        e.vfunc_paint_target(null, paintContextFor(right));
        assert.deepEqual(e._uniforms.u_brightness.values, [0.5]);
        e.vfunc_paint_target(null, paintContextFor(left));
        assert.deepEqual(e._uniforms.u_brightness.values, [1.0]);
    });

    test('shader only scales the color by u_brightness', () => {
        const e = new GammaCurveEffect(0.5, []);
        assert.equal(e._snippets.length, 1);
        assert.match(e._snippets[0].declarations, /uniform float u_brightness;/);
        assert.doesNotMatch(e._snippets[0].declarations, /u_monitor/);
    });

    test('paints its actor through a clone at full brightness', () => {
        global.stage.width = 3840;
        for (const rects of [[], [left], [right]]) {
            const e = attachedEffect(0.5, rects);
            assert.equal(clonePaintBrightness(e, paintContextFor(left)), 1.0);
            assert.equal(clonePaintBrightness(e, paintContextFor(right)), 1.0);
        }
    });

    test('update() stores new parameters and queues a repaint', () => {
        const e = attachedEffect(0.5, []);
        e.update(0.3, []);
        assert.equal(e._repaints, 1);
        e.vfunc_paint_target(null, paintContextFor(left));
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

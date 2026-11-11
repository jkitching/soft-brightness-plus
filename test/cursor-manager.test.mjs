import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// These tests import the REAL CursorManager (via the gi:// mock loader in
// hooks.mjs) and drive it through idle/active cycles against a mock
// IdleMonitor that encodes mutter's actual watch semantics:
//
//   - idle watches are RECURRING: they stay registered and fire on every
//     crossing of the idle threshold until remove_watch() is called;
//   - user-active watches are ONE-SHOT: they fire once on the next user
//     activity and are removed automatically.
//
// Getting this wrong caused an exponential leak: _setupCursorIdleWatch()
// assumed idle watches were one-shot and re-added one after every
// idle→active cycle without removing the old (still-registered) one, so the
// number of live watches doubled per cycle — ~16k mutter watches after a
// day of use, each reset on every input event, grinding gnome-shell to a
// halt.  Disabling clone-mouse only removed the two tracked ids, leaving
// the rest leaked until the shell was restarted.

import Clutter from './mocks/clutter.mjs';
import { CursorManager } from '../src/extension.js';

class MockIdleMonitor {
    constructor() {
        this._nextId = 1;
        this.watches = new Map(); // id -> { type: 'idle'|'active', cb }
    }

    add_idle_watch(_timeoutMs, cb) {
        const id = this._nextId++;
        this.watches.set(id, { type: 'idle', cb });
        return id;
    }

    add_user_active_watch(cb) {
        const id = this._nextId++;
        this.watches.set(id, { type: 'active', cb });
        return id;
    }

    remove_watch(id) {
        this.watches.delete(id);
    }

    count(type) {
        return [...this.watches.values()].filter(w => w.type === type).length;
    }

    // User crosses the idle threshold: every registered idle watch fires
    // and stays registered (recurring).
    goIdle() {
        for (const w of [...this.watches.values()]) {
            if (w.type === 'idle')
                w.cb();
        }
    }

    // User becomes active: every user-active watch fires once and is
    // removed (one-shot).
    goActive() {
        for (const [id, w] of [...this.watches.entries()]) {
            if (w.type === 'active') {
                this.watches.delete(id);
                w.cb();
            }
        }
    }
}

function makeCursorTracker() {
    let nextId = 1;
    return {
        _connections: new Map(),
        connect(signal, fn) {
            const id = nextId++;
            this._connections.set(id, { signal, fn });
            return id;
        },
        disconnect(id) {
            this._connections.delete(id);
        },
        get_sprite() { return null; },
        get_hot() { return [0, 0]; },
        get_pointer_visible() { return false; },
        inhibit_cursor_visibility() {},
        uninhibit_cursor_visibility() {},
    };
}

const logger = { log() {}, log_debug() {} };

let idleMonitor;
let cursorTracker;
let overlayActors;

function makeManager() {
    idleMonitor = new MockIdleMonitor();
    cursorTracker = makeCursorTracker();
    overlayActors = [];

    globalThis.global = {
        backend: {
            get_cursor_tracker: () => cursorTracker,
            get_core_idle_monitor: () => idleMonitor,
        },
        get_pointer: () => [100, 100, 0],
    };

    const overlayManager = {
        addActor(actor) { overlayActors.push(actor); },
        removeActor(actor) { overlayActors = overlayActors.filter(a => a !== actor); },
        raiseToTop() {},
    };

    // Bypass enable()'s 500ms startup timeout and settings wiring; drive the
    // cloned state directly like _enable() would with clone-mouse=true.
    const cm = new CursorManager(logger, /* settings */ null, overlayManager);
    cm._cloneMouseSetting = true;
    return cm;
}

describe('CursorManager idle watch lifecycle', () => {
    let cm;

    beforeEach(() => {
        cm = makeManager();
        cm.setActive(true);
    });

    test('enabling cloning registers exactly one idle watch and no active watch', () => {
        assert.equal(idleMonitor.count('idle'), 1);
        assert.equal(idleMonitor.count('active'), 0);
    });

    test('watch count stays bounded across idle/active cycles (exponential leak regression)', () => {
        for (let cycle = 1; cycle <= 6; cycle++) {
            idleMonitor.goIdle();
            // While idle: the recurring idle watch remains, plus one pending
            // one-shot active watch.
            assert.equal(idleMonitor.count('idle'), 1, `cycle ${cycle}: idle watches while idle`);
            assert.equal(idleMonitor.count('active'), 1, `cycle ${cycle}: active watches while idle`);

            idleMonitor.goActive();
            // Back to steady state: just the one idle watch.  The buggy
            // version doubled idle watches every cycle (2^6 = 64 here).
            assert.equal(idleMonitor.count('idle'), 1, `cycle ${cycle}: idle watches after activity`);
            assert.equal(idleMonitor.count('active'), 0, `cycle ${cycle}: active watches after activity`);
        }
    });

    test('repeated idle crossings without activity do not stack active watches', () => {
        // A recurring idle watch can fire again (e.g. after remove/re-add
        // races or spurious resets) while the previous one-shot active watch
        // is still pending.
        idleMonitor.goIdle();
        idleMonitor.goIdle();
        assert.equal(idleMonitor.count('active'), 1);
        assert.equal(idleMonitor.count('idle'), 1);
    });

    test('going idle pauses the pointer watch and hides the clone; activity restores it', () => {
        assert.notEqual(cm._cursorWatch, null);

        idleMonitor.goIdle();
        assert.equal(cm._cursorWatch, null);
        assert.equal(cm._cursorActor.visible, false);

        idleMonitor.goActive();
        assert.notEqual(cm._cursorWatch, null);
        assert.equal(cm._cursorActor.visible, true);
    });

    test('disabling cloning removes all watches from the idle monitor', () => {
        // Steady state
        cm.setActive(false);
        assert.equal(idleMonitor.watches.size, 0);
    });

    test('disabling cloning while idle removes all watches, including the pending active watch', () => {
        idleMonitor.goIdle();
        cm.setActive(false);
        assert.equal(idleMonitor.watches.size, 0);

        // Leaked watches firing after disable was the residual-slowness
        // failure mode; with everything removed these are no-ops.
        idleMonitor.goIdle();
        idleMonitor.goActive();
        assert.equal(idleMonitor.watches.size, 0);
    });

    test('re-enabling after disable registers a fresh single idle watch', () => {
        cm.setActive(false);
        cm.setActive(true);
        assert.equal(idleMonitor.count('idle'), 1);
        assert.equal(idleMonitor.count('active'), 0);
    });
});

describe('CursorManager system cursor seat lookup', () => {
    test('uses global.stage.context backend when Clutter.get_default_backend is gone (GS 51)', () => {
        const cm = makeManager();
        const saved = Clutter.get_default_backend;
        const seat = { inhibit_unfocus() { this.inhibited = true; }, uninhibit_unfocus() { this.inhibited = false; } };
        try {
            delete Clutter.get_default_backend;
            global.stage = { context: { get_backend: () => ({ get_default_seat: () => seat }) } };
            cm.setActive(true);
            assert.equal(seat.inhibited, true);
            cm.setActive(false);
            assert.equal(seat.inhibited, false);
        } finally {
            Clutter.get_default_backend = saved;
        }
    });
});

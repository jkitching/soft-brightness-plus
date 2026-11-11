import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Test the MouseSpriteContent texture freeze bug (issue #52)
// When the same Cogl texture object is set again, the early-return skips
// invalidate(), so the rendered content never updates.

// ── Reproduce the bug with a minimal Content implementation ──

class MouseSpriteContent_BUGGY {
    constructor() {
        this._texture = null;
        this.invalidateCalls = 0;
        this.invalidateSizeCalls = 0;
    }

    get texture() { return this._texture; }

    set texture(coglTexture) {
        if (this._texture === coglTexture)
            return; // BUG: skips invalidate() when same object is reused

        let oldTexture = this._texture;
        this._texture = coglTexture;
        this.invalidateCalls++;

        if (!oldTexture || !coglTexture ||
            oldTexture.width !== coglTexture.width ||
            oldTexture.height !== coglTexture.height) {
            this.invalidateSizeCalls++;
        }
    }
}

class MouseSpriteContent_FIXED {
    constructor() {
        this._texture = null;
        this.invalidateCalls = 0;
        this.invalidateSizeCalls = 0;
    }

    get texture() { return this._texture; }

    set texture(coglTexture) {
        // FIX: always store and invalidate, even if the object reference is the same,
        // because GNOME may update the pixel data in-place.
        let oldTexture = this._texture;
        this._texture = coglTexture;
        this.invalidateCalls++;

        if (!oldTexture || !coglTexture ||
            oldTexture.width !== coglTexture.width ||
            oldTexture.height !== coglTexture.height) {
            this.invalidateSizeCalls++;
        }
    }
}

function makeTexture(width = 32, height = 32) {
    // Simulate a Cogl texture object (same reference, contents can change)
    return { width, height, _pixelData: new Uint8Array(width * height * 4) };
}

describe('cursor.js – MouseSpriteContent texture freeze (issue #52)', () => {
    test('BUG: setting the same texture object twice does not invalidate', () => {
        const content = new MouseSpriteContent_BUGGY();
        const texture = makeTexture();

        content.texture = texture;
        assert.equal(content.invalidateCalls, 1, 'first set invalidates');

        // Simulate cursor shape update: GNOME modifies pixels in the same object
        texture._pixelData[0] = 255; // cursor changed!
        content.texture = texture; // same object reference

        assert.equal(content.invalidateCalls, 1, 'BUG: second set did NOT invalidate');
    });

    test('FIXED: setting the same texture object always invalidates', () => {
        const content = new MouseSpriteContent_FIXED();
        const texture = makeTexture();

        content.texture = texture;
        assert.equal(content.invalidateCalls, 1);

        texture._pixelData[0] = 255;
        content.texture = texture;

        assert.equal(content.invalidateCalls, 2, 'FIXED: second set also invalidates');
    });

    test('null→texture transition invalidates in both versions', () => {
        const buggy = new MouseSpriteContent_BUGGY();
        const fixed = new MouseSpriteContent_FIXED();
        const texture = makeTexture();

        // null→null is a no-op in the buggy version (same reference)
        buggy.texture = null;
        assert.equal(buggy.invalidateCalls, 0);
        buggy.texture = texture;
        assert.equal(buggy.invalidateCalls, 1); // null→texture: different ref, invalidates

        // In the fixed version, every set() calls invalidate (no early return)
        fixed.texture = null;  // null → null: always calls invalidate now
        assert.equal(fixed.invalidateCalls, 1);
        fixed.texture = texture;
        assert.equal(fixed.invalidateCalls, 2);
    });

    test('changing texture size triggers invalidate_size', () => {
        const content = new MouseSpriteContent_FIXED();
        const small = makeTexture(16, 16);
        const large = makeTexture(32, 32);

        content.texture = small;
        assert.equal(content.invalidateSizeCalls, 1); // null→small: size changed

        content.texture = large;
        assert.equal(content.invalidateSizeCalls, 2); // small→large: size changed

        content.texture = large; // same size, same ref
        assert.equal(content.invalidateSizeCalls, 2); // no size change
    });
});

// ── CursorTrackerPointerWatcher (GS 51+ stand-in for ui/pointerWatcher.js) ──

import { CursorTrackerPointerWatcher } from '../src/cursor.js';

function makeLaters() {
    let next = 1;
    const pending = new Map();
    return {
        pending,
        add(_type, fn) { const id = next++; pending.set(id, fn); return id; },
        remove(id) { pending.delete(id); },
        run() { const fns = [...pending.values()]; pending.clear(); fns.forEach(f => f()); },
    };
}

function makeTracker() {
    const handlers = new Map();
    let next = 1;
    return {
        handlers,
        connect(sig, fn) { const id = next++; handlers.set(id, { sig, fn }); return id; },
        disconnect(id) { handlers.delete(id); },
        emit(sig) { for (const h of [...handlers.values()]) if (h.sig === sig) h.fn(); },
    };
}

describe('CursorTrackerPointerWatcher', () => {
    test('coalesces position-invalidated into one callback per redraw; remove() cleans up', () => {
        const laters = makeLaters();
        globalThis.global = { compositor: { get_laters: () => laters } };
        const tracker = makeTracker();
        let calls = 0;
        const watch = new CursorTrackerPointerWatcher(tracker).addWatch(16, () => calls++);

        tracker.emit('position-invalidated');
        tracker.emit('position-invalidated');
        assert.equal(laters.pending.size, 1, 'one later per frame');
        laters.run();
        assert.equal(calls, 1);

        tracker.emit('position-invalidated');
        laters.run();
        assert.equal(calls, 2, 'a new later is queued after the previous ran');

        tracker.emit('position-invalidated');
        watch.remove();
        assert.equal(tracker.handlers.size, 0, 'signal disconnected');
        assert.equal(laters.pending.size, 0, 'pending later removed');
    });
});

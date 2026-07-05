// Mock for gi://Clutter
class Actor {
    constructor(props = {}) {
        Object.assign(this, props);
        this._children = [];
        this._parent = null;
        this._connections = [];
        this._nextHandlerId = 1;
        this._effects = [];
        this.opacity = 255;
        this._position = [0, 0];
        this._size = [0, 0];
    }
    connect(signal, fn) {
        const id = this._nextHandlerId++;
        this._connections.push({ id, signal, fn });
        return id;
    }
    disconnect(id) {
        this._connections = this._connections.filter(c => c.id !== id);
    }
    // Clutter delivers (emitter, ...args) to handlers.
    emit(signal, ...args) {
        for (const c of [...this._connections]) {
            if (c.signal === signal) c.fn(this, ...args);
        }
    }
    add_child(c) {
        this._children.push(c);
        c._parent = this;
        this.emit('child-added', c);
    }
    remove_child(c) {
        this._children = this._children.filter(x => x !== c);
        if (c._parent === this) c._parent = null;
        this.emit('child-removed', c);
    }
    get_children() { return [...this._children]; }
    get_n_children() { return this._children.length; }
    get_child_at_index(i) { return this._children[i]; }
    get_last_child() { return this._children[this._children.length - 1] ?? null; }
    set_child_above_sibling(child, sibling) {
        this._children = this._children.filter(x => x !== child);
        if (sibling == null) {
            this._children.push(child);
        } else {
            this._children.splice(this._children.indexOf(sibling) + 1, 0, child);
        }
    }
    get_parent() { return this._parent; }
    add_effect_with_name(name, effect) { this._effects.push({ name, effect }); }
    remove_effect(effect) { this._effects = this._effects.filter(e => e.effect !== effect); }
    get_effects() { return this._effects.map(e => e.effect); }
    set_position(x, y) { this._position = [x, y]; }
    set_size(w, h) { this._size = [w, h]; }
    set(props) { Object.assign(this, props); }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    destroy() { this.emit('destroy'); }
}

export const invalidateCalls = [];
export const invalidateSizeCalls = [];

class ContentIface {}

class TextureNode {
    constructor(texture, color, minFilter, magFilter) {
        this.texture = texture;
    }
    set_name(name) {}
    add_rectangle(box) {}
    add_child(node) {}
}

const mockSeat = {
    _unfocusInhibited: false,
    inhibit_unfocus() { this._unfocusInhibited = true; },
    uninhibit_unfocus() { this._unfocusInhibited = false; },
};

export default {
    Actor,
    RequestMode: { CONTENT_SIZE: 0 },
    Content: ContentIface,
    // Leave Container undefined to simulate GS 45+ (uses 'child-added'/'child-removed')
    Container: undefined,
    TextureNode,

    get_default_backend() {
        return {
            get_default_seat() { return mockSeat; },
        };
    },

    _mockSeat: mockSeat,
    _invalidateCalls: invalidateCalls,
    _invalidateSizeCalls: invalidateSizeCalls,
    _reset() {
        invalidateCalls.length = 0;
        invalidateSizeCalls.length = 0;
        mockSeat._unfocusInhibited = false;
    },
};

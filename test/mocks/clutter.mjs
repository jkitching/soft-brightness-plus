// Mock for gi://Clutter
class Actor {
    constructor(props = {}) {
        Object.assign(this, props);
        this._children = [];
        this.opacity = 255;
        this._position = [0, 0];
        this._size = [0, 0];
    }
    add_child(c) { this._children.push(c); }
    remove_child(c) { this._children = this._children.filter(x => x !== c); }
    get_n_children() { return this._children.length; }
    get_child_at_index(i) { return this._children[i]; }
    set_position(x, y) { this._position = [x, y]; }
    set_size(w, h) { this._size = [w, h]; }
    set(props) { Object.assign(this, props); }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    destroy() {}
    get_parent() { return null; }
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

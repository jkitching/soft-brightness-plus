// Mock for gi://St
import Clutter from './clutter.mjs';

class Widget extends Clutter.Actor {
    constructor(props = {}) {
        super(props);
        this._connections = [];
        this._parent = null;
    }
    connect(signal, fn) {
        const id = this._connections.length + 1;
        this._connections.push({ id, signal, fn });
        return id;
    }
    disconnect(id) {
        this._connections = this._connections.filter(c => c.id !== id);
    }
    set_size(w, h) { this._size = [w, h]; }
    get_parent() { return this._parent; }
    set_child_above_sibling(child, sibling) {}
    insert_child_at_index(child, idx) {
        this._children.splice(idx, 0, child);
    }
}

class Label extends Widget {
    constructor(props = {}) {
        super();
        this.style = props.style || '';
        this.text = props.text || '';
    }
    set_position(x, y) { this._position = [x, y]; }
    set_width(w) { this._width = w; }
    set_height(h) { this._height = h; }
}

export default { Widget, Label };

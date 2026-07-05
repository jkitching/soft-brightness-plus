// Mock for gi://St
import Clutter from './clutter.mjs';

class Widget extends Clutter.Actor {
    insert_child_at_index(child, idx) {
        this._children.splice(idx, 0, child);
        child._parent = this;
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

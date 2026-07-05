// Mock for gi://GObject
//
// GJS's registerClass wires _init() to run at construction time; without
// that, classes written GJS-style (all setup in _init, no constructor)
// would never initialize. Wrap the class so `new Klass(...args)` calls
// _init(...args), matching GJS semantics closely enough for tests.
function wireInit(klass) {
    if (typeof klass.prototype._init !== 'function') return klass;
    return class extends klass {
        constructor(...args) {
            super();
            this._init(...args);
        }
    };
}

export default {
    registerClass(classInfo, klass) {
        if (typeof classInfo === 'function') return wireInit(classInfo); // single-arg form
        return wireInit(klass);
    },
    Object: class GObject {
        constructor() {}
    },
};

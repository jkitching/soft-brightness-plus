// Mock for gi://GObject
export default {
    registerClass(classInfo, klass) {
        if (typeof classInfo === 'function') return classInfo; // single-arg form
        return klass;
    },
    Object: class GObject {
        constructor() {}
    },
};

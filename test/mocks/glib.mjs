// Mock for gi://GLib
let nextTimeoutId = 1;
export const _timeouts = new Map(); // id -> { interval, callback }
export const _removedTimeouts = new Set();

export default {
    PRIORITY_DEFAULT: 0,
    SOURCE_REMOVE: false,
    SOURCE_CONTINUE: true,

    timeout_add(priority, interval, callback) {
        const id = nextTimeoutId++;
        _timeouts.set(id, { interval, callback });
        return id;
    },

    source_remove(id) {
        _removedTimeouts.add(id);
        _timeouts.delete(id);
    },

    getenv(key) {
        return null;
    },

    // Test helper: fire a pending timeout by id
    _firePendingTimeout(id) {
        const t = _timeouts.get(id);
        if (!t) throw new Error(`No pending timeout with id ${id}`);
        const result = t.callback();
        if (result === false) { // SOURCE_REMOVE
            _timeouts.delete(id);
        }
        return result;
    },

    _reset() {
        nextTimeoutId = 1;
        _timeouts.clear();
        _removedTimeouts.clear();
    },
};

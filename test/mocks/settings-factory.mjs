export function makeSettings(overrides = {}) {
    const data = {
        'debug': false,
        'min-brightness': 0.0,
        'current-brightness': 1.0,
        'monitors': 'all',
        'builtin-monitor': '',
        'use-backlight': false,
        'prevent-unredirect': 'when-correcting',
        'clone-mouse': false,
        ...overrides,
    };
    const listeners = new Map();
    let counter = 1;

    const settings = {
        get_boolean(key) { return !!data[key]; },
        get_double(key) { return Number(data[key]); },
        get_string(key) { return String(data[key] ?? ''); },
        set_boolean(key, val) { data[key] = val; _fire('changed::' + key); },
        set_double(key, val) { data[key] = val; _fire('changed::' + key); },
        set_string(key, val) { data[key] = val; _fire('changed::' + key); },
        connect(signal, fn) {
            const id = counter++;
            listeners.set(id, { signal, fn });
            return id;
        },
        disconnect(id) { listeners.delete(id); },
        _data: data,
    };

    function _fire(signal) {
        for (const { signal: s, fn } of listeners.values()) {
            if (s === signal) fn();
        }
    }

    return settings;
}

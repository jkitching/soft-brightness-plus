// Mock for Config, System, Extension base, PointerWatcher, QuickSlider

export const Config = {
    PACKAGE_VERSION: '46.0',
};

export const System = {
    version: 17802,
};

export class Extension {
    constructor(metadata = {}) {
        this.metadata = { version: 46, vcs_revision: 'test', ...metadata };
        this.path = '/fake/extension/path';
    }
    getSettings() {
        return makeSettings();
    }
}

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
    let listenerIdCounter = 1;

    return {
        get_boolean(key) { return !!data[key]; },
        get_double(key) { return Number(data[key]); },
        get_string(key) { return String(data[key] ?? ''); },
        set_boolean(key, val) {
            data[key] = val;
            fireChanged(key);
        },
        set_double(key, val) {
            data[key] = val;
            fireChanged(key);
        },
        set_string(key, val) {
            data[key] = val;
            fireChanged(key);
        },
        connect(signal, fn) {
            const id = listenerIdCounter++;
            listeners.set(id, { signal, fn });
            return id;
        },
        disconnect(id) {
            listeners.delete(id);
        },
        _data: data,
        _fire(key) { fireChanged(key); },
    };

    function fireChanged(key) {
        for (const { signal, fn } of listeners.values()) {
            if (signal === 'changed::' + key) fn();
        }
    }
}

export const PointerWatcher = {
    getPointerWatcher() {
        return {
            addWatch(interval, fn) {
                return { remove() {} };
            },
        };
    },
};

export class QuickSlider {
    constructor(props = {}) {
        Object.assign(this, props);
        this.menuEnabled = true;
        this.visible = true;
        this._connections = [];
        this._icon = { style: '' };
        this.slider = {
            _connections: [],
            value: 1.0,
            accessible_name: '',
            connect(signal, fn) {
                const id = this._connections.length + 1;
                this._connections.push({ id, signal, fn });
                return id;
            },
            disconnect(id) {
                this._connections = this._connections.filter(c => c.id !== id);
            },
            block_signal_handler(id) {},
            unblock_signal_handler(id) {},
        };
    }
    destroy() {}
}

// Mock for gi://Gio
export const _displayConfigCallbacks = [];

const mockProxyInstance = {
    GetResourcesRemote: null, // set per-test
};

export default {
    DBus: { session: {} },

    DBusProxy: {
        makeProxyWrapper(_xml) {
            return function ProxyClass(_bus, _name, _path, callback) {
                _displayConfigCallbacks.push({ callback, proxy: mockProxyInstance });
                // Don't call callback immediately; tests control timing
            };
        },
    },

    File: {
        new_for_path(path) {
            return {
                load_contents(_cancellable) {
                    // Return empty XML that won't be parsed in tests
                    return [false, null];
                },
            };
        },
    },

    _mockProxy: mockProxyInstance,

    _fireDisplayConfigCallback(error = null) {
        for (const { callback, proxy } of _displayConfigCallbacks) {
            callback(error ? null : proxy, error);
        }
    },

    _reset() {
        _displayConfigCallbacks.length = 0;
        mockProxyInstance.GetResourcesRemote = null;
    },
};

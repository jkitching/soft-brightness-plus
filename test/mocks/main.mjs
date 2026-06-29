// Mock for resource:///org/gnome/shell/ui/main.js
import StMock from './st.mjs';

const layoutManagerListeners = new Map();
let _listenerIdCounter = 1;

const mockStage = new StMock.Widget();
mockStage._parent = mockStage; // stage is its own parent for testing

export const _state = {
    monitors: [{ x: 0, y: 0, width: 1920, height: 1080 }],
    primaryIndex: 0,
    brightnessReady: false,
    sessionMode: 'user',
};

const mockSlider = {
    _connections: [],
    value: 1.0,
    connect(signal, fn) {
        const id = _listenerIdCounter++;
        this._connections.push({ id, signal, fn });
        return id;
    },
    disconnect(id) {
        this._connections = this._connections.filter(c => c.id !== id);
    },
    block_signal_handler(id) {},
    unblock_signal_handler(id) {},
};

const mockBrightnessIndicator = {
    slider: mockSlider,
    _proxy: { Brightness: 80 },
    quickSettingsItems: [null], // set up below
};

const mockGridContainer = new StMock.Widget();
mockGridContainer.layout_manager = {
    child_set_property(container, child, prop, val) {},
};
mockGridContainer._parent = null;
mockGridContainer.get_parent = () => mockGridContainer._parent;

const mockBrightnessQuickSettingsItem = new StMock.Widget();
mockBrightnessQuickSettingsItem.get_parent = () => mockGridContainer;
mockBrightnessIndicator.quickSettingsItems[0] = mockBrightnessQuickSettingsItem;
mockGridContainer._children = [mockBrightnessQuickSettingsItem];

const mockQuickSettings = {
    _brightness: null, // set to { quickSettingsItems: [...] } when ready
    menu: {
        addItem(item) {},
    },
};

export default {
    layoutManager: {
        get monitors() { return _state.monitors; },
        get primaryIndex() { return _state.primaryIndex; },
        connect(signal, fn) {
            const id = _listenerIdCounter++;
            layoutManagerListeners.set(id, { signal, fn });
            return id;
        },
        disconnect(id) {
            layoutManagerListeners.delete(id);
        },
        _fireMonitorsChanged() {
            for (const { signal, fn } of layoutManagerListeners.values()) {
                if (signal === 'monitors-changed') fn();
            }
        },
    },
    panel: {
        statusArea: {
            quickSettings: mockQuickSettings,
        },
    },
    sessionMode: {
        get currentMode() { return _state.sessionMode; },
    },
    brightnessManager: undefined, // override in tests for GNOME 49+ path

    // Test helpers
    _mockSlider: mockSlider,
    _mockBrightnessIndicator: mockBrightnessIndicator,
    _mockQuickSettings: mockQuickSettings,
    _mockGridContainer: mockGridContainer,
    _makeBrightnessReady() {
        mockQuickSettings._brightness = { quickSettingsItems: [mockBrightnessQuickSettingsItem] };
    },
    _reset() {
        layoutManagerListeners.clear();
        _state.monitors = [{ x: 0, y: 0, width: 1920, height: 1080 }];
        _state.primaryIndex = 0;
        mockQuickSettings._brightness = null;
        mockSlider.value = 1.0;
        mockSlider._connections = [];
    },
};

export { mockStage as stage };

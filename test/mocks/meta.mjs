// Mock for gi://Meta
export default {
    // Leave CursorTracker.get_for_display defined (GS < 48 path)
    CursorTracker: {
        get_for_display(_display) {
            return {
                connect(signal, fn) { return 1; },
                disconnect(id) {},
                get_sprite() { return null; },
                get_hot() { return [0, 0]; },
                inhibit_cursor_visibility() {},
                uninhibit_cursor_visibility() {},
            };
        },
    },
    disable_unredirect_for_display(_display) {},
    enable_unredirect_for_display(_display) {},
};

// Mock for gi://Meta
import Clutter from './clutter.mjs';

// MetaWindowGroup (global.window_group, global.top_window_group) and
// MetaBackgroundGroup, as plain actors the extension can instanceof-check.
class WindowGroup extends Clutter.Actor {}
class BackgroundGroup extends Clutter.Actor {}

export default {
    WindowGroup,
    BackgroundGroup,
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
    LaterType: { BEFORE_REDRAW: 2 },
    disable_unredirect_for_display(_display) {},
    enable_unredirect_for_display(_display) {},
};

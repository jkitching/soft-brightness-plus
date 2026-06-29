// Mock for gi://Shell
export const _mockScreenshotProto = {
    screenshot: function(...args) { return Promise.resolve(); },
    screenshot_area: function(...args) { return Promise.resolve(); },
    screenshot_finish: function(...args) {},
    screenshot_area_finish: function(...args) {},
    // screenshot_stage_to_content intentionally absent to test conditional
};

class Screenshot {}
Screenshot.prototype = _mockScreenshotProto;

export default {
    Screenshot,
    util_set_hidden_from_pick(_actor, _hidden) {},
};

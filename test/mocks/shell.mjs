// Mock for gi://Shell
export const _mockScreenshotProto = {
    screenshot: function(...args) { return Promise.resolve(); },
    screenshot_area: function(...args) { return Promise.resolve(); },
    screenshot_finish: function(...args) {},
    screenshot_area_finish: function(...args) {},
    // screenshot_stage_to_content intentionally absent to test conditional
};

function Screenshot() {}
Screenshot.prototype = _mockScreenshotProto;

// Mock of Shell.GLSLEffect (ClutterOffscreenEffect subclass).
// Records snippets and uniform writes so tests can assert on them.
// GJS runs vfunc_build_pipeline during construction; _init mimics that.
export class GLSLEffect {
    constructor() {
        this.enabled = true;
        this._snippets = [];
        this._uniforms = {};
        this._repaints = 0;
    }
    _init() {
        if (typeof this.vfunc_build_pipeline === 'function')
            this.vfunc_build_pipeline();
    }
    get_uniform_location(name) { return name; }
    set_uniform_float(location, size, values) {
        this._uniforms[location] = { size, values: Array.from(values) };
    }
    add_glsl_snippet(hook, declarations, code, isReplace) {
        this._snippets.push({ hook, declarations, code, isReplace });
    }
    queue_repaint() { this._repaints++; }
    vfunc_paint_target(..._args) {}
}

export default {
    Screenshot,
    GLSLEffect,
    util_set_hidden_from_pick(_actor, _hidden) {},
};

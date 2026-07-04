// soft-brightness-plus - Control the display's brightness via an alpha channel.
// Copyright (C) 2023-2024 Joel Kitching (jkitching on Github)
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';

// Copied almost verbatim from GNOME Shell 49 ui/magnifier.js.  Local
// additions: the spriteScale getter (used to normalize the cursor
// hotspot) and the texture node name.
//
// Scale handling: cursor sprite textures arrive at different scales
// depending on the surface under the pointer (shell chrome vs app
// windows vs XWayland).  The content reports its preferred size in
// logical pixels by dividing the texture size by the guessed sprite
// scale, so the rendered cursor size stays constant across surfaces.
export const MouseSpriteContent = GObject.registerClass({
    Implements: [Clutter.Content],
}, class MouseSpriteContent extends GObject.Object {
    _init() {
        super._init();
        this._scale = 1.0;
        this._monitorScale = 1.0;
        this._texture = null;
    }

    // Scale factor from texture pixels to displayed (logical) pixels.
    // Hotspot coordinates arrive in texture pixels and must be divided
    // by this before being used as actor translations.
    get spriteScale() {
        return this._scale;
    }

    vfunc_get_preferred_size() {
        if (!this._texture)
            return [false, 0, 0];

        let width = this._texture.get_width() / this._scale;
        let height = this._texture.get_height() / this._scale;

        return [true, width, height];
    }

    vfunc_paint_content(actor, node, _paintContext) {
        if (!this._texture)
            return;

        let [minFilter, magFilter] = actor.get_content_scaling_filters();
        let textureNode = new Clutter.TextureNode(this._texture,
            null, minFilter, magFilter);
        textureNode.set_name('SoftBrightnessPlusMouseSpriteContent');
        node.add_child(textureNode);

        textureNode.add_rectangle(actor.get_content_box());
    }

    _textureScale() {
        if (!this._texture)
            return 1;

        /* This is a workaround to guess the sprite scale; while it works fine
         * in normal scenarios, it's not guaranteed to work in all the cases,
         * and so we should actually add an API to mutter that will allow us
         * to know the real sprite texture scaling in order to adapt it to the
         * wanted one. */
        let avgSize = (this._texture.get_width() + this._texture.get_height()) / 2;
        return Math.max(1, Math.floor(avgSize / Meta.prefs_get_cursor_size() + .1));
    }

    _recomputeScale() {
        let scale = this._textureScale() / this._monitorScale;

        if (this._scale !== scale) {
            this._scale = scale;
            return true;
        }
        return false;
    }

    get texture() {
        return this._texture;
    }

    set texture(coglTexture) {
        if (this._texture === coglTexture)
            return;

        let oldTexture = this._texture;
        this._texture = coglTexture;
        this.invalidate();

        if (!oldTexture || !coglTexture ||
            oldTexture.get_width() !== coglTexture.get_width() ||
            oldTexture.get_height() !== coglTexture.get_height()) {
            this._recomputeScale();
            this.invalidate_size();
        }
    }

    // Intentionally unused by the extension (kept for upstream parity):
    // the clone lives in uiGroup's logical coordinate space, so the
    // monitor scale stays at 1.0, unlike the magnifier's zoom regions.
    set monitorScale(monitorScale) {
        this._monitorScale = monitorScale;
        if (this._recomputeScale())
            this.invalidate_size();
    }
});

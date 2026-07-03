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
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';

// Copied almost verbatim from ui/magnifier.js, plus dimFactor support:
// the cloned cursor is dimmed by modulating the texture color rather than
// with a shader effect — offscreen effects on an actor that moves every
// frame leave stale trails behind.
export const MouseSpriteContent = GObject.registerClass({
    Implements: [Clutter.Content],
}, class MouseSpriteContent extends GObject.Object {
    _init() {
        super._init();
        this._texture = null;
        this._dimFactor = 1.0;
    }

    get dimFactor() {
        return this._dimFactor;
    }

    set dimFactor(factor) {
        if (this._dimFactor !== factor) {
            this._dimFactor = factor;
            this.invalidate();
        }
    }

    vfunc_get_preferred_size() {
        if (!this._texture)
            return [false, 0, 0];

        return [true, this._texture.get_width(), this._texture.get_height()];
    }

    vfunc_paint_content(actor, node, _paintContext) {
        if (!this._texture)
            return;

        let color = null;
        if (this._dimFactor < 1.0) {
            const v = Math.round(this._dimFactor * 255);
            // In GS 47, Clutter.Color was replaced by Cogl.Color.
            color = Clutter.Color !== undefined
                ? new Clutter.Color({red: v, green: v, blue: v, alpha: 255})
                : new Cogl.Color({red: v, green: v, blue: v, alpha: 255});
        }

        let [minFilter, magFilter] = actor.get_content_scaling_filters();
        let textureNode = new Clutter.TextureNode(this._texture,
            color, minFilter, magFilter);
        textureNode.set_name('SoftBrightnessPlusMouseSpriteContent');
        node.add_child(textureNode);

        textureNode.add_rectangle(actor.get_content_box());
    }

    get texture() {
        return this._texture;
    }

    set texture(coglTexture) {
        let oldTexture = this._texture;
        this._texture = coglTexture;
        this.invalidate();

        if (!oldTexture || !coglTexture ||
            oldTexture.get_width() !== coglTexture.get_width() ||
            oldTexture.get_height() !== coglTexture.get_height())
            this.invalidate_size();
    }
});

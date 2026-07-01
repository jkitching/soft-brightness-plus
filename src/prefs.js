// soft-brightness-plus - Control the display's brightness via an alpha channel.
// Copyright (C) 2019-2022 Philippe Troin (F-i-f on Github)
// Copyright (C) 2023 Joel Kitching (jkitching on Github)
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

import Adw from 'gi://Adw';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';


export default class SoftBrightnessPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.add(new PreferencesPage(this.getSettings(), this.metadata));
    }
}

const PreferencesPage = GObject.registerClass(class PreferencesPage extends Adw.PreferencesPage {
    constructor(settings, metadata) {
        super();

        this._settings = settings;
        this._metadata = metadata;

        {
            const group = new Adw.PreferencesGroup();

            this.title_label = new Gtk.Label({
                use_markup: true,
                label: '<span size="large" weight="heavy">' +
                    _('Soft Brightness Plus') + '</span>',
                hexpand: true,
                halign: Gtk.Align.CENTER,
            });
            group.add(this.title_label);

            const versionString = this._metadata['version'] + ' / git ' + this._metadata['vcs_revision'];
            this.version_label = new Gtk.Label({
                use_markup: true,
                label: '<span size="small">' + _('Version') +
                    ' ' + versionString + '</span>',
                hexpand: true,
                halign: Gtk.Align.CENTER,
            });
            group.add(this.version_label);

            this.link_label = new Gtk.Label({
                use_markup: true,
                label: '<span size="small"><a href="' + this._metadata.url + '">' +
                    this._metadata.url + '</a></span>',
                hexpand: true,
                halign: Gtk.Align.CENTER,
                margin_bottom: this.margin_bottom,
            });
            group.add(this.link_label);

            this.add(group);
        }

        {
            const group = new Adw.PreferencesGroup({
                title: _('Brightness'),
                description: _('Controls overall screen dimming. Use the hardware backlight when available, or let the extension control it independently.'),
            });

            this.enabled_control = new Adw.SwitchRow({
                title: _('Use hardware backlight'),
                subtitle: _('When on, the brightness slider adjusts the hardware backlight. When off, the extension dims via the GPU shader.'),
            });
            this._settings.bind('use-backlight', this.enabled_control, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(this.enabled_control);

            this.min_brightness_control = new Adw.ActionRow({
                title: _('Minimum brightness'),
            });
            const mbScale = new Gtk.Scale({
                orientation: Gtk.Orientation.HORIZONTAL,
                hexpand: true,
                width_request: 160,
                draw_value: false,
                valign: Gtk.Align.CENTER,
                adjustment: new Gtk.Adjustment({
                    lower: 0.0,
                    upper: 1.0,
                    step_increment: 0.01,
                }),
            });
            this.mbLabel = new Gtk.Label({ width_chars: 5, xalign: 1.0, valign: Gtk.Align.CENTER });
            const mbBox = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER });
            mbBox.append(mbScale);
            mbBox.append(this.mbLabel);
            this.min_brightness_control.add_suffix(mbBox);
            this.min_brightness_control.set_activatable_widget(mbScale);
            this._settings.bind('min-brightness', mbScale.get_adjustment(), 'value', Gio.SettingsBindFlags.DEFAULT);
            const mbFmt = (v) => v < 0.005 ? _('Off') : v.toFixed(2);
            this.mbLabel.set_label(mbFmt(mbScale.get_value()));
            mbScale.connect('value-changed', () => this.mbLabel.set_label(mbFmt(mbScale.get_value())));
            group.add(this.min_brightness_control);

            this.white_compression_row = new Adw.ActionRow({
                title: _('White compression'),
                subtitle: _('Softens bright highlights without uniformly darkening the screen. Higher values are more aggressive.'),
            });
            const wcScale = new Gtk.Scale({
                orientation: Gtk.Orientation.HORIZONTAL,
                hexpand: true,
                width_request: 160,
                draw_value: false,
                valign: Gtk.Align.CENTER,
                adjustment: new Gtk.Adjustment({
                    lower: 1.0,
                    upper: 4.0,
                    step_increment: 0.1,
                }),
            });
            this.wcLabel = new Gtk.Label({ width_chars: 4, xalign: 1.0, valign: Gtk.Align.CENTER });
            const wcBox = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER });
            wcBox.append(wcScale);
            wcBox.append(this.wcLabel);
            this.white_compression_row.add_suffix(wcBox);
            this.white_compression_row.set_activatable_widget(wcScale);
            this._settings.bind('shader-gamma', wcScale.get_adjustment(), 'value', Gio.SettingsBindFlags.DEFAULT);
            const wcFmt = (v) => v < 1.001 ? _('Off') : v.toFixed(1);
            this.wcLabel.set_label(wcFmt(wcScale.get_value()));
            wcScale.connect('value-changed', () => this.wcLabel.set_label(wcFmt(wcScale.get_value())));
            group.add(this.white_compression_row);

            this.add(group);
        }

        {
            const group = new Adw.PreferencesGroup({
                title: _('Advanced'),
            });

            this.clone_mouse_control = new Adw.SwitchRow({
                title: _('Apply to mouse cursor:'),
                subtitle: this._getDescription('clone-mouse'),
            });
            this._settings.bind('clone-mouse', this.clone_mouse_control, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(this.clone_mouse_control);

            this.debug_control = new Adw.SwitchRow({
                title: _('Debug logging:'),
                subtitle: this._getDescription('debug'),
            });
            this._settings.bind('debug', this.debug_control, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(this.debug_control);

            this.add(group);
        }

        {
            const group = new Adw.PreferencesGroup();

            const copyright1 = new Gtk.Label({
                use_markup: true,
                label: '<span size="small">' +
                    _('Copyright © 2019-2022 Philippe Troin (<a href="https://github.com/F-i-f">F-i-f</a> on GitHub)') +
                    '</span>',
                hexpand: true,
                halign: Gtk.Align.CENTER,
                margin_top: this.margin_bottom,
            });
            const copyright2 = new Gtk.Label({
                use_markup: true,
                label: '<span size="small">' +
                    _('Copyright © 2022-2024 Joel Kitching (<a href="https://github.com/jkitching">jkitching</a> on GitHub)') +
                    '</span>',
                hexpand: true,
                halign: Gtk.Align.CENTER,
                margin_top: this.margin_bottom,
            });

            group.add(copyright1);
            group.add(copyright2);

            this.add(group);
        }
    }

    _getDescription(name) {
        return _(this._settings.settings_schema.get_key(name).get_description());
    }
});

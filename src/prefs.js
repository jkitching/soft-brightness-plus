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
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
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
            // Inverted binding: when switch is ON, use-backlight is true
            this._settings.bind('use-backlight', this.enabled_control, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(this.enabled_control);

            this.min_brightness_control = new Adw.SpinRow({
                title: _('Minimum brightness:'),
                subtitle: this._getDescription('min-brightness'),
                digits: 2,
                adjustment: new Gtk.Adjustment({
                    lower: 0.0,
                    upper: 1.0,
                    step_increment: 0.01,
                }),
            });
            this._settings.bind('min-brightness', this.min_brightness_control, 'value', Gio.SettingsBindFlags.DEFAULT);
            group.add(this.min_brightness_control);

            this.add(group);
        }

        {
            const group = new Adw.PreferencesGroup({
                title: _('White compression'),
                description: _('Reshapes the brightness curve so whites are less harsh without darkening the whole screen. Applied on top of the brightness setting.'),
            });

            this.shader_gamma_control = new Adw.SpinRow({
                title: _('Strength (1.0 = off, 4.0 = maximum):'),
                subtitle: this._getDescription('shader-gamma'),
                digits: 2,
                adjustment: new Gtk.Adjustment({
                    lower: 1.0,
                    upper: 4.0,
                    step_increment: 0.1,
                }),
            });
            this._settings.bind('shader-gamma', this.shader_gamma_control, 'value', Gio.SettingsBindFlags.DEFAULT);
            group.add(this.shader_gamma_control);

            this.add(group);
        }

        {
            const display = Gdk.Display.get_default();
            const monitors = display ? display.get_monitors() : null;
            const monitorCount = monitors ? monitors.get_n_items() : 0;

            if (monitorCount > 1) {
                const group = new Adw.PreferencesGroup({
                    title: _('Per-monitor white compression'),
                    description: _('Override the white compression strength for individual monitors. Leave at 1.0 to use the global setting above.'),
                });

                for (let i = 0; i < monitorCount; i++) {
                    const mon = monitors.get_item(i);
                    const connector = mon.get_connector ? mon.get_connector() : null;
                    const geo = mon.get_geometry();
                    const label = connector
                        ? `${connector} (${geo.width}×${geo.height})`
                        : `Monitor ${i + 1} (${geo.width}×${geo.height})`;

                    const row = new Adw.SpinRow({
                        title: label,
                        digits: 2,
                        adjustment: new Gtk.Adjustment({
                            lower: 1.0,
                            upper: 4.0,
                            step_increment: 0.1,
                        }),
                    });

                    const perMonitorGammas = this._settings.get_value('per-monitor-gammas').deepUnpack();
                    row.value = (i < perMonitorGammas.length) ? perMonitorGammas[i] : 1.0;

                    row.connect('notify::value', () => {
                        const vals = this._settings.get_value('per-monitor-gammas').deepUnpack();
                        while (vals.length <= i) vals.push(1.0);
                        vals[i] = row.value;
                        this._settings.set_value('per-monitor-gammas',
                            new GLib.Variant('ad', vals));
                    });

                    group.add(row);
                }

                this.add(group);
            }
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

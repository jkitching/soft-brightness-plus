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

import * as Config from 'resource:///org/gnome/Shell/Extensions/js/misc/config.js';

import * as Utils from './utils.js';

// In GS 51, Shell.GLSLEffect was removed; until the shader is ported,
// the extension always uses the overlay there (see SHADER_SUPPORTED in
// extension.js).
const SHADER_AVAILABLE = parseInt(Config.PACKAGE_VERSION) < 51;

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

            this.enabled_control = new Adw.SwitchRow({
                title: _('Control overlay brightness independently'),
                subtitle: _('Show a separate slider in the quick settings menu.'),
            });
            // Inverted binding: when switch is ON, use-backlight is false
            this._settings.bind('use-backlight', this.enabled_control, 'active', Gio.SettingsBindFlags.INVERT_BOOLEAN);
            group.add(this.enabled_control);

            const monitorsModel = new Gtk.StringList();
            monitorsModel.append(_('All'));
            monitorsModel.append(_('Built-in'));
            monitorsModel.append(_('External'));
            this.monitors_control = new Adw.ComboRow({
                title: _('Monitor(s):'),
                subtitle: this._getDescription('monitors'),
                model: monitorsModel,
            });
            this.monitors_control.connect('notify::selected', () => {
                this._settings.set_enum('monitors', this.monitors_control.selected);
            });
            this._settings.connect('changed::monitors', () => {
                this.monitors_control.set_selected(this._settings.get_enum('monitors'));
            });
            group.add(this.monitors_control);

            this.builtinMonitorControl = new Adw.ComboRow({
                title: _('Built-in monitor:'),
                subtitle: this._getDescription('builtin-monitor'),
            });
            Utils.newDisplayConfig(this._metadata['path'], (function(proxy, error) {
                if (error) {
                    console.log('Cannot get DisplayConfig: ' + error);
                    return;
                }
                this.displayConfigProxy = proxy;
                this._bindBuiltinMonitorControl();
                this.displayConfigProxy.connectSignal('MonitorsChanged', this._refreshMonitors.bind(this));
                this._refreshMonitors();
            }).bind(this));
            group.add(this.builtinMonitorControl);

            // Order matches the dimming-mode enum values (overlay=0, shader=1).
            const dimmingModel = new Gtk.StringList();
            dimmingModel.append(_('Overlay'));
            dimmingModel.append(_('Shader'));
            // Short subtitle here; the schema description has the details.
            this.dimming_mode_control = new Adw.ComboRow({
                title: _('Dimming method:'),
                subtitle: SHADER_AVAILABLE
                    ? _('Overlay works everywhere. Shader dims like a backlight, but may glitch on some GPUs.')
                    : _('Shader dimming is not yet available on GNOME 51.'),
                model: dimmingModel,
                selected: SHADER_AVAILABLE ? this._settings.get_enum('dimming-mode') : 0,
                sensitive: SHADER_AVAILABLE,
            });
            this.dimming_mode_control.connect('notify::selected', () => {
                if (this._settings.get_enum('dimming-mode') !== this.dimming_mode_control.selected)
                    this._settings.set_enum('dimming-mode', this.dimming_mode_control.selected);
            });
            this._settings.connect('changed::dimming-mode', () => {
                if (SHADER_AVAILABLE)
                    this.dimming_mode_control.set_selected(this._settings.get_enum('dimming-mode'));
            });
            group.add(this.dimming_mode_control);

            this.add(group);
        }

        {
            const group = new Adw.PreferencesGroup();

            this.min_brightness_control = new Adw.ActionRow({
                title: _('Minimum brightness (0..1):'),
                subtitle: this._getDescription('min-brightness'),
            });
            {
                const scale = new Gtk.Scale({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    adjustment: new Gtk.Adjustment({
                        lower: 0.0, upper: 1.0,
                        step_increment: 0.01, page_increment: 0.1,
                        value: this._settings.get_double('min-brightness'),
                    }),
                    digits: 2,
                    draw_value: true,
                    value_pos: Gtk.PositionType.RIGHT,
                    hexpand: true,
                    width_request: 200,
                    valign: Gtk.Align.CENTER,
                });
                scale.connect('value-changed', () => {
                    this._settings.set_double('min-brightness', scale.get_value());
                });
                this._settings.connect('changed::min-brightness', () => {
                    scale.set_value(this._settings.get_double('min-brightness'));
                });
                this.min_brightness_control.add_suffix(scale);
            }
            group.add(this.min_brightness_control);

            this.clone_mouse_control = new Adw.SwitchRow({
                title: _('Mouse cursor brightness control:'),
                subtitle: _('Dim the cursor with the screen. Turn off if the cursor lags or shows the wrong shape, or if the screen stops sleeping.'),
            });
            this._settings.bind('clone-mouse', this.clone_mouse_control, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(this.clone_mouse_control);

            this.debug_control = new Adw.SwitchRow({
                title: _('Debug:'),
                subtitle: this._getDescription('debug'),
            });
            this._settings.bind('debug', this.debug_control, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(this.debug_control);

            this.add(group);
        }

        {
            const group = new Adw.PreferencesGroup({
                title: _('Keyboard shortcuts'),
                description: _('Default shortcuts use Shift + hardware brightness keys. Clear to disable; use gsettings to set a custom binding.'),
            });

            group.add(this._buildShortcutRow(_('Increase brightness'), 'brightness-up'));
            group.add(this._buildShortcutRow(_('Decrease brightness'), 'brightness-down'));

            this.add(group);
        }

        {
            const group = new Adw.PreferencesGroup();

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
            });
            group.add(this.link_label);

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

    _buildShortcutRow(title, settingKey) {
        const row = new Adw.ActionRow({ title });

        const shortcutLabel = new Gtk.ShortcutLabel({
            disabled_text: _('Disabled'),
            valign: Gtk.Align.CENTER,
        });

        const refresh = () => {
            const vals = this._settings.get_strv(settingKey);
            shortcutLabel.accelerator = vals.length ? vals[0] : '';
        };
        refresh();
        this._settings.connect(`changed::${settingKey}`, refresh);

        const clearButton = new Gtk.Button({
            label: _('Clear'),
            valign: Gtk.Align.CENTER,
        });
        clearButton.add_css_class('flat');
        clearButton.connect('clicked', () => this._settings.set_strv(settingKey, []));

        const resetButton = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
        });
        resetButton.add_css_class('flat');
        resetButton.connect('clicked', () => this._settings.reset(settingKey));

        row.add_suffix(shortcutLabel);
        row.add_suffix(clearButton);
        row.add_suffix(resetButton);
        return row;
    }

    _bindBuiltinMonitorControl() {
        this.builtin_monitor_control_signal = this.builtinMonitorControl.connect('notify::selected', () => {
            this._settings.set_string('builtin-monitor', this.builtinMonitorControl.selected_item.string);
        });
        this.builtin_monitor_settings_signal = this._settings.connect('changed::builtin-monitor', () => {
            this._refreshMonitors();
        });
    }

    _unbindBuiltinMonitorControl() {
        this.builtinMonitorControl.disconnect(this.builtin_monitor_control_signal);
        this._settings.disconnect(this.builtin_monitor_settings_signal);
    }

    _refreshMonitors() {
        Utils.getMonitorConfig(this.displayConfigProxy, (result, error) => {
            if (error) {
                console.log('Cannot get DisplayConfig: ' + error);
                return;
            }
            const builtinMonitorName = this._settings.get_string('builtin-monitor');
            const builtinMonitorModel = new Gtk.StringList();
            this._unbindBuiltinMonitorControl();
            let builtinFound = false;
            let builtinIdx = 0;
            for (let i = 0; i < result.length; i++) {
                const displayName = result[i][0];
                if (displayName == builtinMonitorName) {
                    builtinFound = true;
                    builtinIdx = i;
                }
                builtinMonitorModel.append(displayName);
            }
            if (!builtinFound && builtinMonitorName != '') {
                builtinMonitorModel.append(builtinMonitorName);
                builtinIdx = result.length;
            }
            this.builtinMonitorControl.set_model(builtinMonitorModel);
            this.builtinMonitorControl.set_selected(builtinIdx);
            this._bindBuiltinMonitorControl();
        });
    }
});

// soft-brightness-plus - Control the display's brightness via an alpha channel.
// Copyright (C) 2019, 2021 Philippe Troin (F-i-f on Github)
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

import Gio from 'gi://Gio';

let cachedDisplayConfigProxy = null;

function getDisplayConfigProxy(extPath) {
    if (cachedDisplayConfigProxy == null) {
        let xml = null;
        const file = Gio.File.new_for_path(extPath + '/dbus-interfaces/org.gnome.Mutter.DisplayConfig.xml');
        try {
            const [ok, bytes] = file.load_contents(null);
            if (ok) {
                xml = new TextDecoder().decode(bytes);
            }
        } catch (e) {
            console.error('failed to load DisplayConfig interface XML');
            throw e;
        }
        cachedDisplayConfigProxy = Gio.DBusProxy.makeProxyWrapper(xml);
    }
    return cachedDisplayConfigProxy;
}

export function newDisplayConfig(extPath, callback) {
    const DisplayConfigProxy = getDisplayConfigProxy(extPath);
    new DisplayConfigProxy(
        Gio.DBus.session,
        'org.gnome.Mutter.DisplayConfig',
        '/org/gnome/Mutter/DisplayConfig',
        callback
    );
}

export function getMonitorConfig(displayConfigProxy, callback) {
    displayConfigProxy.GetResourcesRemote((result) => {
        if (result.length <= 2) {
            callback(null, 'Cannot get DisplayConfig: No outputs in GetResources()');
        } else {
            const monitors = [];
            for (let i = 0; i < result[2].length; i++) {
                const output = result[2][i];
                if (output.length <= 7) {
                    callback(null, 'Cannot get DisplayConfig: No properties on output #' + i);
                    return;
                }
                const props = output[7];
                const displayName = props['display-name'].get_string()[0];
                const connectorName = output[4];
                if (!displayName || displayName == '') {
                    const displayName = 'Monitor on output ' + connectorName;
                }
                monitors.push([displayName, connectorName]);
            }
            callback(monitors, null);
        }
    });
}

// Patches the given function with a preHook.  Returns a callback that,
// when run, removes the preHook, and restores original functionality.
export function patchFunction(object, fname, preHook) {
    const saved = object[fname];
    object[fname] = function(...args) {
        preHook(fname);
        return saved.apply(this, args);
    };
    return () => object[fname] = saved;
}

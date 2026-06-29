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
    // GetResources is deprecated and crashes mutter on cold boot (GNOME 46+).
    // GetCurrentState returns physical monitors at result[1], each structured as
    // ((ssss) modes props) where ssss = (connector, vendor, product, serial).
    displayConfigProxy.GetCurrentStateRemote((result) => {
        if (result.length < 2) {
            callback(null, 'Cannot get DisplayConfig: No data in GetCurrentState()');
            return;
        }
        const monitors = [];
        const physicalMonitors = result[1];
        for (let i = 0; i < physicalMonitors.length; i++) {
            const monitor = physicalMonitors[i];
            const connectorName = monitor[0][0];
            const props = monitor[2];
            let displayName = props['display-name'] ? props['display-name'].get_string()[0] : '';
            if (!displayName || displayName == '') {
                displayName = 'Monitor on output ' + connectorName;
            }
            monitors.push([displayName, connectorName]);
        }
        callback(monitors, null);
    });
}

// Patches the given function with a preHook and optional postHook.  Returns a
// callback that, when run, removes the hooks and restores original functionality.
// If the patched function returns a Promise and postHook is provided, postHook is
// chained via .then() so it fires after the async operation completes (including
// on rejection).  This is necessary in GS 46+ where Gio._promisify captures the
// internal _finish callback by reference at startup, making _finish patching
// ineffective.
export function patchFunction(object, fname, preHook, postHook) {
    const saved = object[fname];
    if (saved === undefined) {
        return () => {};
    }
    object[fname] = function(...args) {
        preHook(fname);
        const result = saved.apply(this, args);
        if (postHook !== undefined) {
            if (result !== null && result !== undefined && typeof result.then === 'function') {
                return result.then(
                    r => { postHook(fname); return r; },
                    e => { postHook(fname); throw e; }
                );
            }
            postHook(fname);
        }
        return result;
    };
    return () => object[fname] = saved;
}

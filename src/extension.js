// soft-brightness-plus - Control the display's brightness via an alpha channel.
// Copyright (C) 2019-2022 Philippe Troin (F-i-f on Github)
// Copyright (C) 2022-2024 Joel Kitching (jkitching on Github)
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

import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PointerWatcher from 'resource:///org/gnome/shell/ui/pointerWatcher.js';
import {QuickSlider} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import System from 'system';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Logger from './logger.js';
import * as Utils from './utils.js';
import { MouseSpriteContent } from './cursor.js';

export default class SoftBrightnessExtension extends Extension {
    constructor(...args) {
        super(...args);

        // Set/destroyed by enable/disable
        this._settings = null;
        this._logger = null;
        this._monitorManager = null;
        this._overlayManager = null;
        this._cursorManager = null;
        this._indicatorManager = null;
        this._screenshotManager = null;
        this._removeSettingsCallbacks = [];
    }

    // Base functionality: set-up and tear down logger, settings and debug setting monitoring
    enable() {
        this._settings = this.getSettings();
        this._logger = new Logger.Logger('soft-brightness-plus', this.metadata, Config.PACKAGE_VERSION);
        this._logger.set_debug(this._settings.get_boolean('debug'));
        this._logger.log_debug('enable(), session mode = ' + Main.sessionMode.currentMode);
        this._logger.logVersion();

        this._monitorManager = new MonitorManager(this._logger, this._settings, this.path);
        this._overlayManager = new OverlayManager(this._logger, this._settings, this._monitorManager);
        this._cursorManager = new CursorManager(this._logger, this._settings, this._overlayManager);
        this._indicatorManager = new IndicatorManager(this._logger, this._settings);
        this._screenshotManager = new ScreenshotManager(this._logger);

        this._monitorManager.setChangeHook(() => {
            this._overlayManager.resetSize();
            this._on_brightness_change(true);
        });

        this._cursorManager.setChangeHook(() => {
            this._on_brightness_change(true);
        });

        this._screenshotManager.setPreCaptureHook(() => {
            this._cursorManager.setActive(false);
            this._overlayManager.hideOverlays(false);
        });

        this._screenshotManager.setPostCaptureHook(() => {
            this._cursorManager.setActive(true);
            this._on_brightness_change(false);
        });

        this._monitorManager.enable();
        this._overlayManager.enable();
        this._cursorManager.enable();
        this._indicatorManager.enable();
        this._screenshotManager.enable();

        this._enableSettingsMonitoring();

        this._logger.log_debug('Extension enabled');
    }

    // In order to maintain the same brightness settings when the device is
    // locked and unlocked, "session-modes" includes "unlock-dialog" in
    // metadata.json.  The extension will remain active while the lock screen
    // is shown.
    disable() {
        this._logger.log_debug('disable(), session mode = ' + Main.sessionMode.currentMode);

        this._monitorManager.disable();
        this._overlayManager.disable();
        this._cursorManager.disable();
        this._indicatorManager.disable();
        this._screenshotManager.disable();

        this._disableSettingsMonitoring();

        this._logger.log_debug('Extension disabled');

        this._settings = null;
        this._logger = null;
        this._monitorManager = null;
        this._overlayManager = null;
        this._cursorManager = null;
        this._indicatorManager = null;
        this._screenshotManager = null;
    }

    _on_debug_change() {
        this._logger.set_debug(this._settings.get_boolean('debug'));
        this._logger.log('debug = ' + this._logger.get_debug());
    }

    // Settings monitoring
    _enableSettingsMonitoring() {
        this._logger.log_debug('_enableSettingsMonitoring()');

        const callbacks = {
            'changed::min-brightness': () => this._on_brightness_change(false),
            'changed::current-brightness': () => this._on_brightness_change(false),
            'changed::monitors': () => this._on_brightness_change(true),
            'changed::builtin-monitor': () => this._on_brightness_change(true),
            'changed::use-backlight': () => this._on_brightness_change(true),
            'changed::prevent-unredirect': () => this._on_brightness_change(true),
            'changed::debug': () => this._on_debug_change(),
        }
        this._removeSettingsCallbacks = Object.entries(callbacks).map(
            ([name, fn]) => {
                const conn = this._settings.connect(name, fn);
                return () => this._settings.disconnect(conn);
            }
        );
    }

    _disableSettingsMonitoring() {
        this._logger.log_debug('_disableSettingsMonitoring()');
        this._removeSettingsCallbacks.forEach((fn) => fn());
        this._removeSettingsCallbacks = [];
    }

    _on_brightness_change(force) {
        let curBrightness = this._getBrightnessLevel();
        const minBrightness = this._settings.get_double('min-brightness');

        this._logger.log_debug('_on_brightness_change: current-brightness=' + curBrightness + ', min-brightness=' + minBrightness);
        if (curBrightness < minBrightness) {
            curBrightness = minBrightness;
            this._storeBrightnessLevel(minBrightness);
            return;
        }
        if (curBrightness >= 1) {
            this._overlayManager.hideOverlays(false);
            this._cursorManager.setActive(false);
        } else {
            this._overlayManager.showOverlays(curBrightness, force);
            // Only activate cursor if overlays were successfully created
            this._cursorManager.setActive(this._overlayManager.initialized());
        }
    }

    _getProxy() {
        // Prefer Main.brightnessManager.globalScale if available (GNOME 49+)
        const globalScale = Main.brightnessManager?.globalScale;
        if (globalScale) {
            // Return a proxy-compatible wrapper around globalScale
            // Old proxy API: Brightness property with 0-100 scale
            // New API: value property with 0.0-1.0 scale
            return {
                get Brightness() {
                    return globalScale.value * 100;
                },
                set Brightness(percent) {
                    globalScale.value = percent / 100.0;
                }
            };
        }

        // Fallback to legacy D-Bus proxy
        return this._indicatorManager.getProxy();
    }

    // Utility functions to manage the stored brightness value.
    // If using the backlight, then we use the indicator as the brightness value store, which is linked to gsd.
    // If not using the backlight, the brightness is stored in the extension setting.
    _storeBrightnessLevel(value) {
        const proxy = this._getProxy();
        if (this._settings.get_boolean('use-backlight') && !proxy) {
            this._logger.log_debug('_storeBrightnessLevel still waiting for proxy...');
            return;
        }

        if (this._settings.get_boolean('use-backlight') && proxy.Brightness >= 0) {
            const convertedBrightness = Math.min(100, Math.round(value * 100.0));
            this._logger.log_debug('_storeBrightnessLevel(' + value + ') by proxy -> ' + convertedBrightness);
            proxy.Brightness = convertedBrightness;
        }

        // Always store current-brightness value so that when use-backlight is
        // disabled, there is no jarring shift in the overlay brightness.
        this._logger.log_debug('_storeBrightnessLevel(' + value + ') by setting');
        this._settings.set_double('current-brightness', value);
    }

    _getBrightnessLevel() {
        const proxy = this._getProxy();
        if (this._settings.get_boolean('use-backlight') && !proxy) {
            this._logger.log_debug('_getBrightnessLevel still waiting for proxy...');
            return 0;
        }

        if (this._settings.get_boolean('use-backlight') && proxy.Brightness >= 0) {
            const convertedBrightness = proxy.Brightness / 100.0;
            this._logger.log_debug('_getBrightnessLevel() by proxy = ' + convertedBrightness + ' <- ' + proxy.Brightness);
            return convertedBrightness;
        } else {
            const brightness = this._settings.get_double('current-brightness');
            this._logger.log_debug('_getBrightnessLevel() by setting = ' + brightness);
            return brightness;
        }
    }
}

// Monkey-patched screenshot methods
class ScreenshotManager {
    constructor(logger) {
        this._logger = logger;

        // Set/destroyed by _enableScreenshotPatch/_disableScreenshotPatch
        this._screenshotRevertFns = [];
    }

    setPreCaptureHook(fn) {
        this._preCaptureHookFn = fn;
    }

    setPostCaptureHook(fn) {
        this._postCaptureHookFn = fn;
    }

    enable() {
        const preCapture = (fname) => {
            this._logger.log_debug('Screenshot ' + fname + '(): pre-capture');
            if (this._preCaptureHookFn !== null) {
                this._preCaptureHookFn(fname);
            }
        };
        const postCapture = (fname) => {
            this._logger.log_debug('Screenshot ' + fname + '(): post-capture');
            if (this._postCaptureHookFn !== null) {
                this._postCaptureHookFn(fname);
            }
        };
        // Monkey-patch screenshot capture functions to remove the overlay during
        // area, desktop, and interactive screenshots.  This is unnecessary for
        // window screenshots, so skip the `screenshot_window` function.
        //
        // Note that in GS 3.38+, these screenshot functions return Promises:
        // https://gitlab.gnome.org/GNOME/gnome-shell/-/merge_requests/1126
        // After dropping support for GS 3.36-, consider modifying Utils.patchFunction
        // to support both a pre-hook and a post-hook, using Promise's `then()` to
        // chain the post-hook function.
        this._logger.log_debug('_enableScreenshotPatch()');
        const proto = Shell.Screenshot.prototype;
        const targetFns = [
            'screenshot',
            'screenshot_area',
            ...proto.screenshot_stage_to_content ? ['screenshot_stage_to_content'] : []
        ];
        this._screenshotRevertFns = [
            ...targetFns.map(fname => Utils.patchFunction(proto, fname, preCapture)),
            ...targetFns.map(fname => Utils.patchFunction(proto, fname + '_finish', postCapture)),
        ];
    }

    disable() {
        // Undo monkey-patching of screenshot functions
        this._logger.log_debug('_disableScreenshotPatch()');
        this._screenshotRevertFns.forEach(fn => fn());
        this._screenshotRevertFns = [];
    }
}

// Custom QuickSlider to control overlay brightness independently from hardware brightness
const OverlayBrightnessItem = GObject.registerClass(
class OverlayBrightnessItem extends QuickSlider {
    _init(logger, settings) {
        super._init({
            iconName: 'display-brightness-symbolic',
        });

        this._logger = logger;
        this._settings = settings;

        this.slider.accessible_name = _('Overlay Brightness');

        // Disable the menu button since we don't need per-monitor controls
        this.menuEnabled = false;

        // Color icon to distinguish from hardware brightness slider
        // Using accent color to make it visually distinct
        this._icon.style = 'color: -st-accent-color;';

        // Connect slider value changes to our brightness setter
        this._sliderChangedId = this.slider.connect('notify::value',
            () => this._onSliderChanged());

        // Watch for min-brightness setting changes
        this._minBrightnessChangedId = this._settings.connect('changed::min-brightness',
            () => {
                const minBrightness = this._settings.get_double('min-brightness');
                this._logger.log_debug(`OverlayBrightnessItem: min-brightness changed to ${minBrightness}`);
                // If current brightness is below new minimum, adjust it
                if (this.slider.value < minBrightness) {
                    this._onSliderChanged();
                }
            });

        // Watch for current-brightness setting changes (e.g., from hardware brightness watcher)
        this._brightnessChangedId = this._settings.connect('changed::current-brightness',
            () => {
                this._logger.log_debug('OverlayBrightnessItem: current-brightness changed externally, syncing');
                this._sync();
            });

        // Watch for use-backlight setting changes to show/hide slider
        this._useBacklightChangedId = this._settings.connect('changed::use-backlight',
            () => {
                this._updateVisibility();
            });

        // Set initial value from current brightness
        this._sync();

        // Set initial visibility based on use-backlight setting
        this._updateVisibility();

        // Check if current brightness is below minimum and fix it if needed
        const minBrightness = this._settings.get_double('min-brightness');
        if (this.slider.value < minBrightness) {
            this._logger.log_debug(`OverlayBrightnessItem: initial brightness ${this.slider.value} below minimum ${minBrightness}, correcting`);
            this._onSliderChanged();
        }

        this._logger.log_debug('OverlayBrightnessItem: initialized');
    }

    _onSliderChanged() {
        let value = this.slider.value;
        const minBrightness = this._settings.get_double('min-brightness');

        // Enforce minimum brightness to prevent completely black screen
        if (value < minBrightness) {
            this._logger.log_debug(`OverlayBrightnessItem: slider value ${value} below minimum ${minBrightness}, clamping`);
            value = minBrightness;
            // Update slider to show the clamped value
            this.slider.block_signal_handler(this._sliderChangedId);
            this.slider.value = value;
            this.slider.unblock_signal_handler(this._sliderChangedId);
        }

        this._logger.log_debug(`OverlayBrightnessItem: slider changed to ${value}`);
        // Write directly to the setting - this will trigger overlay updates via changed::current-brightness
        this._settings.set_double('current-brightness', value);
    }

    _sync() {
        // Block signal to avoid feedback loop when updating slider
        this.slider.block_signal_handler(this._sliderChangedId);
        const brightness = this._settings.get_double('current-brightness');
        this.slider.value = brightness;
        this.slider.unblock_signal_handler(this._sliderChangedId);
        this._logger.log_debug(`OverlayBrightnessItem: synced to brightness ${brightness}`);
    }

    _updateVisibility() {
        const useBacklight = this._settings.get_boolean('use-backlight');
        // Show overlay slider only when use-backlight is OFF (overlay-only mode)
        this.visible = !useBacklight;
        this._logger.log_debug(`OverlayBrightnessItem: visibility set to ${this.visible} (use-backlight=${useBacklight})`);
    }

    destroy() {
        if (this._sliderChangedId) {
            this.slider.disconnect(this._sliderChangedId);
            this._sliderChangedId = null;
        }
        if (this._minBrightnessChangedId) {
            this._settings.disconnect(this._minBrightnessChangedId);
            this._minBrightnessChangedId = null;
        }
        if (this._brightnessChangedId) {
            this._settings.disconnect(this._brightnessChangedId);
            this._brightnessChangedId = null;
        }
        if (this._useBacklightChangedId) {
            this._settings.disconnect(this._useBacklightChangedId);
            this._useBacklightChangedId = null;
        }
        this._logger.log_debug('OverlayBrightnessItem: destroyed');
        super.destroy();
    }
});

// Monkey-patched brightness indicator methods
class IndicatorManager {
    constructor(logger, settings) {
        this._logger = logger;
        this._settings = settings;

        this._enableTimeoutId = null;

        // Set/destroyed by _enable/_disable
        this._indicator = null;
        this._slider = null;

        // Custom slider approach
        this._overlayBrightnessItem = null;
        this._hardwareBrightnessChangedId = null;
    }

    getProxy() {
        return this._indicator?._proxy;
    }

    enable() {
        // Subsequent 100ms checks: Wait until the _brightness object has been
        // set on quickSettings.
        let attempt = 0;
        this._enableTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            if (Main.panel.statusArea.quickSettings._brightness) {
                this._logger.log_debug('Brightness slider ready, continue enable procedure');
                this._enableTimeoutId = null;
                this._enable();
                return GLib.SOURCE_REMOVE;
            }

            if (attempt >= 5) {
                this._logger.log_debug('Giving up on brightness slider');
                this._enableTimeoutId = null;
                // TODO: Figure out how to disable the extension.
                return GLib.SOURCE_REMOVE;
            }

            attempt += 1;
            if (attempt >= 1) {
                this._logger.log_debug('Brightness slider not ready, wait (attempt ' + attempt + ')');
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _enable() {
        this._indicator = Main.panel.statusArea.quickSettings._brightness.quickSettingsItems[0];
        this._slider = this._indicator.slider;

        // Watch hardware brightness changes to sync overlay when in "control together" mode
        if (this._slider) {
            this._logger.log_debug('IndicatorManager: connecting to hardware brightness slider');
            this._hardwareBrightnessChangedId = this._slider.connect('notify::value', () => {
                const useBacklight = this._settings.get_boolean('use-backlight');
                const hardwareValue = this._slider.value;
                this._logger.log_debug(`IndicatorManager: hardware brightness changed to ${hardwareValue}, use-backlight=${useBacklight}`);

                // Only sync when use-backlight is ON (control together mode)
                if (useBacklight) {
                    this._logger.log_debug(`IndicatorManager: syncing overlay to hardware brightness ${hardwareValue}`);
                    this._settings.set_double('current-brightness', hardwareValue);
                }
            });
            this._logger.log_debug(`IndicatorManager: hardware brightness watcher connected`);
        } else {
            this._logger.log_debug('IndicatorManager: WARNING - could not find hardware brightness slider to watch');
        }

        // Also add custom overlay brightness slider
        this._addCustomSlider();
    }

    _addCustomSlider() {
        this._logger.log_debug('IndicatorManager: adding custom overlay brightness slider');

        // Create custom slider item
        this._overlayBrightnessItem = new OverlayBrightnessItem(
            this._logger,
            this._settings
        );

        // Add to QuickSettings menu right after hardware brightness slider
        const quickSettings = Main.panel.statusArea.quickSettings;
        const brightnessItem = Main.panel.statusArea.quickSettings._brightness?.quickSettingsItems?.[0];

        // The menu.box contains a grid container (St_Widget) which holds all the quick settings items
        const gridContainer = quickSettings.menu.box.get_child_at_index(0);

        if (gridContainer && brightnessItem) {
            // Find the position of the hardware brightness item in the grid
            let brightnessPosition = -1;
            const nChildren = gridContainer.get_n_children();

            for (let i = 0; i < nChildren; i++) {
                const child = gridContainer.get_child_at_index(i);
                if (child === brightnessItem) {
                    brightnessPosition = i;
                    break;
                }
            }

            if (brightnessPosition >= 0) {
                // Insert right after the hardware brightness slider
                gridContainer.insert_child_at_index(this._overlayBrightnessItem, brightnessPosition + 1);
                // Set column-span to 2 so it takes full width like other sliders
                gridContainer.layout_manager.child_set_property(
                    gridContainer, this._overlayBrightnessItem, 'column-span', 2);
                this._logger.log_debug(`IndicatorManager: custom slider inserted at position ${brightnessPosition + 1}`);
            } else {
                // Fallback: add at beginning
                gridContainer.insert_child_at_index(this._overlayBrightnessItem, 0);
                gridContainer.layout_manager.child_set_property(
                    gridContainer, this._overlayBrightnessItem, 'column-span', 2);
                this._logger.log_debug('IndicatorManager: custom slider added at position 0');
            }
        } else {
            // Last resort: use addItem
            quickSettings.menu.addItem(this._overlayBrightnessItem);
            this._logger.log_debug('IndicatorManager: custom slider added via addItem');
        }

        this._logger.log_debug('IndicatorManager: custom overlay brightness slider added');
    }

    disable() {
        // If _enableTimeoutId is non-null, _enable() has not run yet,
        // and will not run.
        GLib.source_remove(this._enableTimeoutId);
        this._enableTimeoutId = null;

        // Cleanup custom slider
        if (this._overlayBrightnessItem) {
            this._overlayBrightnessItem.destroy();
            this._overlayBrightnessItem = null;
        }

        // Cleanup hardware brightness watcher
        if (this._hardwareBrightnessChangedId) {
            if (this._slider) {
                this._slider.disconnect(this._hardwareBrightnessChangedId);
            }
            this._hardwareBrightnessChangedId = null;
        }

        this._indicator = null;
        this._slider = null;
    }
}

// Cursor handling
class CursorManager {
    constructor(logger, settings, overlayManager) {
        this._logger = logger;
        this._settings = settings;
        this._overlayManager = overlayManager;

        // Set by setChangeHook
        this._changeHookFn = null;

        // State trackers
        this._active = false;
        this._cloned = false;

        // Set/destroyed by enable/disable
        this._enableTimeoutId = null;
        this._cloneMouseSetting = null;
        this._cloneMouseSettingChangedConnection = null;

        // Set/destroyed by _enableCloningMouse/_disableCloningMouse
        this._cursorTracker = null;
        this._cursorSprite = null;
        this._cursorActor = null;
        this._cursorWatcher = null;
        this._cursorWatch = null;
        this._cursorChangedConnection = null;
        this._cursorVisibilityChangedConnection = null;

        // Set/destroyed by _hideSystemCursor/_showSystemCursor
        this._cursorUnfocusInhibited = false;
    }

    setChangeHook(fn) {
        this._changeHookFn = fn;
    }

    enable() {
        // First 500ms: For some reason, starting the mouse cloning at this
        // stage fails when gnome-shell is restarting on x11 and the mouse
        // listener doesn't receive any events.  Adding a small delay before
        // starting the whole mouse cloning business helps.
        this._enableTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            // Wait 500ms before starting to check for the _brightness object.
            this._enableTimeoutId = null;
            this._enable();
            return GLib.SOURCE_REMOVE;
        });
    }

    _enable() {
        this._cloneMouseSetting = this._settings.get_boolean('clone-mouse');
        this.setActive(true);
        this._cloneMouseSettingChangedConnection = this._settings.connect(
            'changed::clone-mouse', this._on_clone_mouse_change.bind(this));
    }

    setActive(active) {
        this._active = active;
        this._update();
    }

    _update() {
        const newCloned = this._cloneMouseSetting && this._active;
        if (newCloned === this._cloned) {
            return;
        }

        if (newCloned) {
            this._logger.log_debug('CursorManager: enable mouse cloning');
            this._enableCloningMouse();
        } else {
            this._logger.log_debug('CursorManager: disable mouse cloning');
            this._disableCloningMouse();
        }
        this._cloned = newCloned;

        if (this._changeHookFn !== null) {
            this._changeHookFn();
        }
    }

    disable() {
        // If _enableTimeoutId is non-null, _enable() has not run yet, and will
        // not run.  Do not run _disable() in this case.
        GLib.source_remove(this._enableTimeoutId);
        if (this._enableTimeoutId !== null) {
            return;
        }
        this._enableTimeoutId = null;
        this._changeHookFn = null;

        this._settings.disconnect(this._cloneMouseSettingChangedConnection);
        this._cloneMouseSettingChangedConnection = null;

        this.setActive(false);
    }


    _on_clone_mouse_change() {
        const cloneMouse = this._settings.get_boolean('clone-mouse');
        if (cloneMouse === this._cloneMouseSetting) {
            this._logger.log_debug('_on_clone_mouse_change(): no setting change, no change');
            return;
        }
        if (cloneMouse) {
            // Starting to clone mouse
            this._logger.log_debug('_on_clone_mouse_change(): starting mouse cloning');
            this._cloneMouseSetting = true;
            this._update();
        } else {
            this._logger.log_debug('_on_clone_mouse_change(): stopping mouse cloning');
            this._cloneMouseSetting = false;
            this._update();
        }
    }

    _enableCloningMouse() {
        this._logger.log_debug('_enableCloningMouse()');

        // In GS 48, CursorTracker.get_for_display was moved to global.backend.get_cursor_tracker.
        this._cursorTracker = global.backend.get_cursor_tracker !== undefined
          ? global.backend.get_cursor_tracker()
          : Meta.CursorTracker.get_for_display(global.display);

        this._cursorSprite = new Clutter.Actor({ request_mode: Clutter.RequestMode.CONTENT_SIZE });
        this._cursorSprite.content = new MouseSpriteContent();

        this._cursorActor = new Clutter.Actor();
        this._cursorActor.add_child(this._cursorSprite);
        this._cursorWatcher = PointerWatcher.getPointerWatcher();

        if (this._cursorWatch == null) {
            this._overlayManager.addActor(this._cursorActor);
            this._cursorChangedConnection = this._cursorTracker.connect(
                'cursor-changed', this._updateMouseSprite.bind(this));
            this._cursorVisibilityChangedConnection = this._cursorTracker.connect(
                'visibility-changed', this._updateMouseSprite.bind(this));
            const interval = 1000 / 60;
            this._logger.log_debug('_startCloningMouse(): watch interval = ' + interval + ' ms');
            this._cursorWatch = this._cursorWatcher.addWatch(interval, this._updateMousePosition.bind(this));

            this._updateMouseSprite();
            this._updateMousePosition();
        }

        this._hideSystemCursor();
    }

    _disableCloningMouse() {
        if (this._cursorWatch != null) {
            this._logger.log_debug('_stopCloningMouse()');

            this._cursorWatch.remove();
            this._cursorWatch = null;

            this._cursorTracker.disconnect(this._cursorChangedConnection);
            this._cursorChangedConnection = null;

            this._cursorTracker.disconnect(this._cursorVisibilityChangedConnection);
            this._cursorVisibilityChangedConnection = null;

            this._overlayManager.removeActor(this._cursorActor);
        }

        this._showSystemCursor();

        this._logger.log_debug('_disableCloningMouse()');

        this._cursorTracker = null;
        this._cursorSprite = null;
        this._cursorActor = null;
        this._cursorWatcher = null;
    }

    _updateMousePosition() {
        const [x, y] = global.get_pointer();
        this._cursorActor.set_position(x, y);
    }

    _updateMouseSprite() {
        const sprite = this._cursorTracker.get_sprite();
        if (sprite) {
            this._cursorSprite.content.texture = sprite;
            this._cursorSprite.show();
        } else {
            this._cursorSprite.hide();
        }

        const [xHot, yHot] = this._cursorTracker.get_hot();
        this._cursorSprite.set({
            translation_x: -xHot,
            translation_y: -yHot,
        });
    }

    _showSystemCursor() {
        const seat = Clutter.get_default_backend().get_default_seat();

        if (this._cursorUnfocusInhibited) {
            seat.uninhibit_unfocus();
            this._cursorUnfocusInhibited = false;
        }

        if (this._cursorVisibilityChangedId) {
            this._cursorTracker.disconnect(this._cursorVisibilityChangedId);
            delete this._cursorVisibilityChangedId;

            // In GS 45, set_pointer_visible was replaced by uninhibit_cursor_visibility.
            if (this._cursorTracker.uninhibit_cursor_visibility !== undefined) {
                this._cursorTracker.uninhibit_cursor_visibility();
            } else {
                this._cursorTracker.set_pointer_visible(true);
            }
        }
    }

    _hideSystemCursor() {
        const seat = Clutter.get_default_backend().get_default_seat();

        if (!this._cursorUnfocusInhibited) {
            seat.inhibit_unfocus();
            this._cursorUnfocusInhibited = true;
        }

        if (!this._cursorVisibilityChangedId) {
            // In GS 45, set_pointer_visible was replaced by inhibit_cursor_visibility.
            if (this._cursorTracker.inhibit_cursor_visibility !== undefined) {
                this._cursorTracker.inhibit_cursor_visibility();
            } else {
                this._cursorTracker.set_pointer_visible(false);
            }
            this._cursorVisibilityChangedId = this._cursorTracker.connect('visibility-changed', () => {
                if (this._cursorTracker.get_pointer_visible())
                    this._cursorTracker.set_pointer_visible(false);
            });
        }
    }
}

// Core functions to show & hide overlays
class OverlayManager {
    constructor(logger, settings, monitorManager) {
        this._logger = logger;
        this._settings = settings;
        this._monitorManager = monitorManager;

        this._overlays = null;
        this._actorGroup = null;
        this._actorAddedConnection = null;
        this._actorRemovedConnection = null;
    }

    enable() {
        this._actorGroup = new St.Widget({ name: 'soft-brightness-plus-overlays' });
        this.resetSize();
        Shell.util_set_hidden_from_pick(this._actorGroup, true);
        global.stage.add_child(this._actorGroup);

        // In GS 45, use of "actor" was renamed to "child".
        const clutterContainer = Clutter.Container !== undefined;
        this._actorAddedConnection = global.stage.connect(
            clutterContainer ? 'actor-added' : 'child-added',
            this._restackOverlays.bind(this),
        );
        this._actorRemovedConnection = global.stage.connect(
            clutterContainer ? 'actor-removed' : 'child-removed',
            this._restackOverlays.bind(this),
        );
    }

    disable() {
        global.stage.disconnect(this._actorAddedConnection);
        global.stage.disconnect(this._actorRemovedConnection);

        this._actorAddedConnection = null;
        this._actorRemovedConnection = null;

        this.hideOverlays(true);
        this._overlays = null;

        global.stage.remove_child(this._actorGroup);
        this._actorGroup.destroy();
        this._actorGroup = null;
    }

    resetSize() {
        this._actorGroup.set_size(global.screen_width, global.screen_height);
    }

    initialized() {
        return this._overlays !== null && this._overlays.length > 0;
    }

    addActor(actor) {
        this._actorGroup.add_child(actor);
    }

    removeActor(actor) {
        // If we have already destroyed the actor group, its child actors
        // are already gone too.
        if (this._actorGroup) {
            this._actorGroup.remove_child(actor);
        }
    }

    _restackOverlays() {
        this._logger.log_debug('_restackOverlays()');
        this._actorGroup.get_parent().set_child_above_sibling(this._actorGroup, null);
        if (this._overlays !== null) {
            for (let i = 0; i < this._overlays.length; i++) {
                this._actorGroup.set_child_above_sibling(this._overlays[i], null);
            }
        }
    }

    showOverlays(brightness, force) {
        this._logger.log_debug('_showOverlays(' + brightness + ', ' + force + ')');
        if (this._overlays == null || force) {
            const monitors = this._monitorManager.getMonitors();
            if (monitors == null) {
                this._logger.log_debug('_showOverlays(): monitors not ready yet, skipping');
                return;
            }
            if (force) {
                this.hideOverlays(false);
            }
            const preventUnredirect = this._settings.get_string('prevent-unredirect');
            switch (preventUnredirect) {
                case 'always':
                case 'when-correcting':
                    this._preventUnredirect();
                    break;
                case 'never':
                    this._allowUnredirect();
                    break;
                default:
                    this._logger.log('_showOverlays(): Unexpected prevent-unredirect="' + preventUnredirect + '"');
                    break;
            }

            this._overlays = [];
            for (let i = 0; i < monitors.length; i++) {
                const monitor = monitors[i];
                this._logger.log_debug('Create overlay #' + i + ': ' + monitor.width + 'x' + monitor.height + '@' + monitor.x + ',' + monitor.y);
                const overlay = new St.Label({
                    style: 'border-radius: 0px; background-color: rgba(0,0,0,1);',
                    text: '',
                });
                overlay.set_position(monitor.x, monitor.y);
                overlay.set_width(monitor.width);
                overlay.set_height(monitor.height);

                this._actorGroup.add_child(overlay);
                this._overlays.push(overlay);
            }
        }

        const opacity = (1.0 - brightness) * 255;
        for (let i = 0; i < this._overlays.length; i++) {
            this._logger.log_debug('_showOverlay(): set opacity ' + opacity + ' on overlay #' + i);
            this._overlays[i].opacity = opacity;
        }
    }

    hideOverlays(forceUnpreventUnredirect) {
        if (this._overlays != null) {
            this._logger.log_debug('_hideOverlays(): drop overlays, count=' + this._overlays.length);
            for (let i = 0; i < this._overlays.length; i++) {
                this._actorGroup.remove_child(this._overlays[i]);
            }
            this._overlays = null;
        }

        let preventUnredirect = this._settings.get_string('prevent-unredirect');
        if (forceUnpreventUnredirect) {
            preventUnredirect = 'never';
        }
        switch (preventUnredirect) {
            case 'always':
                this._preventUnredirect();
                break;
            case 'when-correcting':
            case 'never':
                this._allowUnredirect();
                break;
            default:
                this._logger.log('_hideOverlays(): Unexpected prevent-unredirect="' + preventUnredirect + '"');
                break;
        }
    }

    _preventUnredirect() {
        if (!this._unredirectPrevented) {
            this._logger.log_debug('_preventUnredirect(): disabling unredirects, prevent-unredirect=' + this._settings.get_string('prevent-unredirect'));
            // In GS 48, *_unredirect_for_display functions were moved to global compositor.
            global.compositor.disable_unredirect !== undefined
              ? global.compositor.disable_unredirect()
              : Meta.disable_unredirect_for_display(global.display);
            this._unredirectPrevented = true;
        }
    }

    _allowUnredirect() {
        if (this._unredirectPrevented) {
            this._logger.log_debug('_allowUnredirect(): enabling unredirects, prevent-unredirect=' + this._settings.get_string('prevent-unredirect'));
            // In GS 48, *_unredirect_for_display functions were moved to global compositor.
            global.compositor.enable_unredirect !== undefined
              ? global.compositor.enable_unredirect()
              : Meta.enable_unredirect_for_display(global.display);
            this._unredirectPrevented = false;
        }
    }
}

// Monitor change handling
class MonitorManager {
    constructor(logger, settings, extPath) {
        this._logger = logger;
        this._settings = settings;
        this._extPath = extPath;

        this._monitorsChangedConnection = null;
        this._displayConfigProxy = null;
        this._backendManager = null;
        this._monitorNames = null;
        this._changeHookFn = null;
    }

    enable() {
        this._logger.log_debug('_enableMonitor2ing()');
        this._backendManager = global.backend.get_monitor_manager();
        Utils.newDisplayConfig(this._extPath, (proxy, error) => {
            if (error) {
                this._logger.log('newDisplayConfig() callback: Cannot get Display Config: ' + error);
                return;
            }
            this._logger.log_debug('newDisplayConfig() callback');
            this._displayConfigProxy = proxy;
            this._on_monitors_change();
        });

        this._monitorsChangedConnection = Main.layoutManager.connect('monitors-changed', this._on_monitors_change.bind(this));
    }

    disable() {
        this._logger.log_debug('_disableMonitor2ing()');

        Main.layoutManager.disconnect(this._monitorsChangedConnection);

        this._logger = null;
        this._settings = null;

        this._monitorsChangedConnection = null;
        this._displayConfigProxy = null;
        this._backendManager = null;
        this._monitorNames = null;
        this._changeHookFn = null;
    }

    setChangeHook(fn) {
        this._changeHookFn = fn;
    }

    setPostCallback(callback) {
        this._postCallback = callback;
    }

    getMonitors() {
        if (this._monitorNames == null) {
            this._logger.log_debug('getMonitors(): _monitorNames not ready yet, returning null');
            return null;
        }

        const enabledMonitors = this._settings.get_string('monitors');
        let monitors;
        this._logger.log_debug('_showOverlays(): enabledMonitors="' + enabledMonitors + '"');
        if (enabledMonitors == 'all') {
            monitors = Main.layoutManager.monitors;
        } else if (enabledMonitors == 'built-in' || enabledMonitors == 'external') {
            const builtinMonitorName = this._settings.get_string('builtin-monitor');
            this._logger.log_debug('_showOverlays(): builtinMonitorName="' + builtinMonitorName + '"');
            monitors = [];
            for (let i = 0; i < Main.layoutManager.monitors.length; i++) {
                if ((enabledMonitors == 'built-in' && this._monitorNames[i] == builtinMonitorName) ||
                    (enabledMonitors == 'external' && this._monitorNames[i] != builtinMonitorName)) {
                    monitors.push(Main.layoutManager.monitors[i]);
                }
            }
        } else {
            this._logger.log('_showOverlays(): Unhandled "monitors" setting = ' + enabledMonitors);
            return null;
        }
        return monitors;
    }

    _on_monitors_change() {
        if (this._displayConfigProxy == null) {
            this._logger.log_debug('_on_monitors_change(): skipping run as the proxy hasn\'t been set up yet.');
            return;
        }
        this._logger.log_debug('_on_monitors_change()');
        Utils.getMonitorConfig(this._displayConfigProxy, (result, error) => {
            if (error) {
                this._logger.log('_on_monitors_change(): cannot get Monitor Config: ' + error);
                return;
            }
            const monitorNames = [];
            for (let i = 0; i < result.length; i++) {
                const [monitorName, connectorName] = result[i];
                const monitorIndex = this._backendManager.get_monitor_for_connector(connectorName);
                this._logger.log_debug('_on_monitors_change(): monitor="' + monitorName + '", connector="' + connectorName + '", index=' + monitorIndex);
                if (monitorIndex >= 0) {
                    monitorNames[monitorIndex] = monitorName;
                }
            }
            this._monitorNames = monitorNames;

            // Auto-detect builtin monitor if not set
            const builtinMonitorName = this._settings.get_string('builtin-monitor');
            if ((builtinMonitorName == '' || builtinMonitorName == null) && monitorNames.length > 0) {
                const detectedBuiltin = monitorNames[Main.layoutManager.primaryIndex];
                this._logger.log_debug('_on_monitors_change(): auto-detecting builtin monitor: ' + detectedBuiltin);
                this._settings.set_string('builtin-monitor', detectedBuiltin);
                // The settings callback will trigger _on_brightness_change, so return early
                return;
            }

            if (this._changeHookFn !== null) {
                this._changeHookFn();
            }
        });
    }
}

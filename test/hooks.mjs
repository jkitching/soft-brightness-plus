import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const m = (f) => pathToFileURL(path.join(__dirname, 'mocks', f)).href;

const MAP = {
    'gi://GLib':    m('glib.mjs'),
    'gi://Gio':     m('gio.mjs'),
    'gi://Cogl':    m('cogl.mjs'),
    'gi://GObject': m('gobject.mjs'),
    'gi://Clutter': m('clutter.mjs'),
    'gi://Meta':    m('meta.mjs'),
    'gi://Shell':   m('shell.mjs'),
    'gi://St':      m('st.mjs'),
    'system':       m('system.mjs'),
    'resource:///org/gnome/shell/misc/config.js':          m('config.mjs'),
    'resource:///org/gnome/shell/ui/main.js':              m('main.mjs'),
    'resource:///org/gnome/shell/ui/pointerWatcher.js':    m('pointer-watcher.mjs'),
    'resource:///org/gnome/shell/ui/quickSettings.js':     m('quick-settings.mjs'),
    'resource:///org/gnome/shell/extensions/extension.js': m('extension-base.mjs'),
};

export async function resolve(specifier, context, nextResolve) {
    if (MAP[specifier]) {
        return { shortCircuit: true, url: MAP[specifier] };
    }
    return nextResolve(specifier, context);
}

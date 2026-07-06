#!/usr/bin/env gjs
// Registers minimal org.freedesktop.login1 and org.freedesktop.locale1
// stubs on the system D-Bus. Needed in Docker containers where no systemd
// daemons are running.
//
// - login1: gnome-shell connects to logind during background init; without
//   this it throws an uncaught exception that triggers a C-level heap
//   corruption.
// - locale1: libgnome-desktop queries systemd-localed for the default
//   keyboard input sources at startup; on GNOME 45 and 47 a missing
//   locale1 service makes on_got_localed_proxy_for_getting_default_
//   input_sources() segfault (46/48/49 tolerate its absence).

const { GLib, Gio } = imports.gi;

const XML = `
<node>
  <interface name="org.freedesktop.login1.Manager">
    <method name="GetSession">
      <arg type="s" direction="in" name="session_id"/>
      <arg type="o" direction="out" name="object_path"/>
    </method>
    <method name="GetSessionByPID">
      <arg type="u" direction="in" name="pid"/>
      <arg type="o" direction="out" name="object_path"/>
    </method>
    <signal name="SessionNew">
      <arg type="s" name="session_id"/>
      <arg type="o" name="object_path"/>
    </signal>
    <signal name="SessionRemoved">
      <arg type="s" name="session_id"/>
      <arg type="o" name="object_path"/>
    </signal>
  </interface>
</node>`;

const SESSION_PATH = '/org/freedesktop/login1/session/c1';
const loop = new GLib.MainLoop(null, false);

let registrationId = 0;

function onBusAcquired(conn) {
    const iface = Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0];
    registrationId = conn.register_object(
        '/org/freedesktop/login1',
        iface,
        (_conn, _sender, _path, _iface, _method, _params, invoc) => {
            invoc.return_value(new GLib.Variant('(o)', [SESSION_PATH]));
        },
        null,
        null
    );
}

Gio.bus_own_name(
    Gio.BusType.SYSTEM,
    'org.freedesktop.login1',
    Gio.BusNameOwnerFlags.NONE,
    onBusAcquired,
    null,
    null
);

const LOCALE_XML = `
<node>
  <interface name="org.freedesktop.locale1">
    <property name="Locale" type="as" access="read"/>
    <property name="X11Layout" type="s" access="read"/>
    <property name="X11Model" type="s" access="read"/>
    <property name="X11Variant" type="s" access="read"/>
    <property name="X11Options" type="s" access="read"/>
    <property name="VConsoleKeymap" type="s" access="read"/>
    <property name="VConsoleKeymapToggle" type="s" access="read"/>
  </interface>
</node>`;

const LOCALE_PROPS = {
    'Locale': new GLib.Variant('as', ['LANG=C.UTF-8']),
    'X11Layout': new GLib.Variant('s', 'us'),
    'X11Model': new GLib.Variant('s', ''),
    'X11Variant': new GLib.Variant('s', ''),
    'X11Options': new GLib.Variant('s', ''),
    'VConsoleKeymap': new GLib.Variant('s', 'us'),
    'VConsoleKeymapToggle': new GLib.Variant('s', ''),
};

function onLocaleBusAcquired(conn) {
    const iface = Gio.DBusNodeInfo.new_for_xml(LOCALE_XML).interfaces[0];
    conn.register_object(
        '/org/freedesktop/locale1',
        iface,
        () => {}, // no methods
        (_conn, _sender, _path, _iface, prop) => LOCALE_PROPS[prop] ?? null,
        null // no writable properties
    );
}

Gio.bus_own_name(
    Gio.BusType.SYSTEM,
    'org.freedesktop.locale1',
    Gio.BusNameOwnerFlags.NONE,
    onLocaleBusAcquired,
    null,
    null
);

loop.run();

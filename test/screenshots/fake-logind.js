#!/usr/bin/env gjs
// Registers a minimal org.freedesktop.login1 stub on the system D-Bus.
// Needed in Docker containers where no logind daemon is running.
// gnome-shell connects to logind during background init; without this
// it throws an uncaught exception that triggers a C-level heap corruption.

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

loop.run();

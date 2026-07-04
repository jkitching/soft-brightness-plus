#!/usr/bin/env python3
# Photoshop-style curve editor for soft-brightness-plus dimming.
#
# Writes the curve live to the extension's debug-curve setting as you
# drag, so the screen updates in real time (the extension must be
# enabled and brightness below 1.0 for dimming to be active).
#
# The curve defines the dimming shape at FULL strength; the extension's
# brightness slider blends between no dimming (slider at max) and this
# curve (slider at min), so the slider keeps working while a curve is
# active.  Design with the slider near minimum to see the pure curve.
#
#   - drag points to shape the curve (monotone cubic interpolation)
#   - double-click on the curve to add a point
#   - right-click a point to remove it
#   - "Clear override" returns the extension to formula-based dimming
#
# The x axis is the input pixel value (black → white), the y axis the
# output value. The thin diagonal is the identity (no dimming).

import os
import sys

import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, Gio, GLib  # noqa: E402

SCHEMA_ID = 'org.gnome.shell.extensions.soft-brightness-plus'
SCHEMA_DIR = os.path.expanduser(
    '~/.local/share/gnome-shell/extensions/'
    'soft-brightness-plus@joelkitching.com/schemas')
LUT_SAMPLES = 32
POINT_RADIUS = 6
WRITE_THROTTLE_MS = 50


def get_settings():
    source = Gio.SettingsSchemaSource.new_from_directory(
        SCHEMA_DIR, Gio.SettingsSchemaSource.get_default(), False)
    schema = source.lookup(SCHEMA_ID, False)
    if schema is None:
        sys.exit(f'Schema {SCHEMA_ID} not found in {SCHEMA_DIR}')
    return Gio.Settings.new_full(schema, None, None)


def monotone_cubic(points):
    """Return f(x) interpolating sorted (x, y) points, monotone in each
    interval (Fritsch-Carlson), clamped to [0, 1]."""
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    n = len(xs)
    if n == 1:
        return lambda x: ys[0]
    dx = [xs[i + 1] - xs[i] for i in range(n - 1)]
    dy = [ys[i + 1] - ys[i] for i in range(n - 1)]
    slopes = [dy[i] / dx[i] if dx[i] > 0 else 0 for i in range(n - 1)]
    m = [0.0] * n
    m[0], m[-1] = slopes[0], slopes[-1]
    for i in range(1, n - 1):
        if slopes[i - 1] * slopes[i] <= 0:
            m[i] = 0.0
        else:
            m[i] = (slopes[i - 1] + slopes[i]) / 2
    for i in range(n - 1):
        if slopes[i] == 0:
            m[i] = m[i + 1] = 0.0
        else:
            a, b = m[i] / slopes[i], m[i + 1] / slopes[i]
            s = a * a + b * b
            if s > 9:
                tau = 3 / s ** 0.5
                m[i], m[i + 1] = tau * a * slopes[i], tau * b * slopes[i]

    def f(x):
        if x <= xs[0]:
            return ys[0]
        if x >= xs[-1]:
            return ys[-1]
        lo = 0
        for i in range(n - 1):
            if x < xs[i + 1]:
                lo = i
                break
        h = dx[lo]
        t = (x - xs[lo]) / h
        h00 = (1 + 2 * t) * (1 - t) ** 2
        h10 = t * (1 - t) ** 2
        h01 = t * t * (3 - 2 * t)
        h11 = t * t * (t - 1)
        y = (h00 * ys[lo] + h10 * h * m[lo]
             + h01 * ys[lo + 1] + h11 * h * m[lo + 1])
        return min(1.0, max(0.0, y))

    return f


class CurveEditor(Gtk.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title='Soft Brightness Curve')
        self.settings = get_settings()
        # Control points, always sorted by x, x in [0,1], y in [0,1].
        self.points = [(0.0, 0.0), (0.5, 0.35), (1.0, 0.6)]
        self.drag_index = None
        self.write_pending = False

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6,
                      margin_top=10, margin_bottom=10,
                      margin_start=10, margin_end=10)
        self.set_child(box)

        self.area = Gtk.DrawingArea(content_width=420, content_height=420,
                                    vexpand=True, hexpand=True)
        self.area.set_draw_func(self.on_draw)
        box.append(self.area)

        drag = Gtk.GestureDrag()
        drag.connect('drag-begin', self.on_drag_begin)
        drag.connect('drag-update', self.on_drag_update)
        drag.connect('drag-end', lambda *a: self.push_curve())
        self.area.add_controller(drag)

        click = Gtk.GestureClick(button=0)
        click.connect('pressed', self.on_click)
        self.area.add_controller(click)

        buttons = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        box.append(buttons)
        # Presets are FULL-STRENGTH dimming shapes (what the screen does at
        # slider minimum); the brightness slider blends identity <-> shape.
        # A y=0 line reproduces pure backlight dimming (out = b*c); an
        # identity line would mean "dimming does nothing at any slider
        # position", so there is deliberately no identity preset.
        for label, cb in [
            ('Backlight (linear)', self.preset_backlight),
            ('Keep shadows', self.preset_keep_shadows),
            ('Clear override', self.clear_override),
            ('Print LUT', self.print_lut),
        ]:
            b = Gtk.Button(label=label)
            b.connect('clicked', cb)
            buttons.append(b)

        self.status = Gtk.Label(label='Drag points; changes apply live.',
                                xalign=0)
        box.append(self.status)
        self.push_curve()

    # --- geometry helpers -------------------------------------------------
    def to_screen(self, x, y, w, h):
        return x * w, (1 - y) * h

    def to_curve(self, px, py, w, h):
        return min(1, max(0, px / w)), min(1, max(0, 1 - py / h))

    def hit_test(self, px, py, w, h):
        for i, (x, y) in enumerate(self.points):
            sx, sy = self.to_screen(x, y, w, h)
            if (sx - px) ** 2 + (sy - py) ** 2 <= (POINT_RADIUS * 2.5) ** 2:
                return i
        return None

    # --- drawing ----------------------------------------------------------
    def on_draw(self, area, cr, w, h):
        cr.set_source_rgb(0.12, 0.12, 0.12)
        cr.paint()
        cr.set_line_width(1)
        cr.set_source_rgb(0.25, 0.25, 0.25)
        for i in range(1, 4):
            cr.move_to(w * i / 4, 0); cr.line_to(w * i / 4, h)
            cr.move_to(0, h * i / 4); cr.line_to(w, h * i / 4)
        cr.stroke()
        # identity diagonal
        cr.set_source_rgb(0.35, 0.35, 0.35)
        cr.move_to(0, h); cr.line_to(w, 0); cr.stroke()
        # curve
        f = monotone_cubic(self.points)
        cr.set_source_rgb(0.4, 0.7, 1.0)
        cr.set_line_width(2)
        for i in range(0, w + 1, 2):
            x = i / w
            sx, sy = self.to_screen(x, f(x), w, h)
            (cr.move_to if i == 0 else cr.line_to)(sx, sy)
        cr.stroke()
        # points
        for x, y in self.points:
            sx, sy = self.to_screen(x, y, w, h)
            cr.arc(sx, sy, POINT_RADIUS, 0, 6.2832)
            cr.set_source_rgb(1, 1, 1)
            cr.fill()

    # --- interaction ------------------------------------------------------
    def on_drag_begin(self, gesture, px, py):
        w, h = self.area.get_width(), self.area.get_height()
        self.drag_index = self.hit_test(px, py, w, h)
        self.drag_origin = (px, py)

    def on_drag_update(self, gesture, dx, dy):
        if self.drag_index is None:
            return
        w, h = self.area.get_width(), self.area.get_height()
        px, py = self.drag_origin[0] + dx, self.drag_origin[1] + dy
        x, y = self.to_curve(px, py, w, h)
        i = self.drag_index
        # endpoints stay at x=0 / x=1; middle points stay strictly ordered
        if i == 0:
            x = 0.0
        elif i == len(self.points) - 1:
            x = 1.0
        else:
            x = min(self.points[i + 1][0] - 0.02,
                    max(self.points[i - 1][0] + 0.02, x))
        self.points[i] = (x, y)
        self.area.queue_draw()
        self.schedule_write()

    def on_click(self, gesture, n_press, px, py):
        w, h = self.area.get_width(), self.area.get_height()
        button = gesture.get_current_button()
        idx = self.hit_test(px, py, w, h)
        if button == 3 and idx is not None and 0 < idx < len(self.points) - 1:
            del self.points[idx]
        elif button == 1 and n_press == 2 and idx is None:
            x, y = self.to_curve(px, py, w, h)
            self.points.append((x, y))
            self.points.sort(key=lambda p: p[0])
        else:
            return
        self.area.queue_draw()
        self.push_curve()

    # --- settings i/o -----------------------------------------------------
    def schedule_write(self):
        if not self.write_pending:
            self.write_pending = True
            GLib.timeout_add(WRITE_THROTTLE_MS, self.flush_write)

    def flush_write(self):
        self.write_pending = False
        self.push_curve()
        return GLib.SOURCE_REMOVE

    def lut(self):
        f = monotone_cubic(self.points)
        return [f(i / (LUT_SAMPLES - 1)) for i in range(LUT_SAMPLES)]

    def push_curve(self):
        value = ','.join(f'{v:.4f}' for v in self.lut())
        self.settings.set_string('debug-curve', value)
        self.status.set_text(f'{len(self.points)} points → LUT applied')

    def clear_override(self, _b):
        self.settings.set_string('debug-curve', '')
        self.status.set_text('Override cleared — formula dimming active')

    def print_lut(self, _b):
        print(','.join(f'{v:.4f}' for v in self.lut()))
        print('points:', ' '.join(f'({x:.3f},{y:.3f})' for x, y in self.points))
        self.status.set_text('LUT printed to stdout')

    # --- presets (full-strength dimming shapes) ----------------------------
    def preset_backlight(self, _b):
        # Blended with the slider this is exactly out = brightness * c.
        self.points = [(0.0, 0.0), (1.0, 0.0)]
        self.area.queue_draw(); self.push_curve()

    def preset_keep_shadows(self, _b):
        # Darks survive even at full strength; highlights crushed.
        self.points = [(0.0, 0.0), (0.25, 0.22), (1.0, 0.3)]
        self.area.queue_draw(); self.push_curve()


class App(Gtk.Application):
    def __init__(self):
        super().__init__(application_id='com.joelkitching.SbpCurveEditor')

    def do_activate(self):
        CurveEditor(self).present()


if __name__ == '__main__':
    App().run(sys.argv)

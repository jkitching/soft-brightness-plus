#!/usr/bin/env python3
"""
Locate the Soft Brightness Plus slider in the GNOME Shell quick-settings
panel via AT-SPI and print its screen bounding box: X Y W H

Only sliders that are actually mapped on screen (STATE_SHOWING) with sane
extents are considered: cally reports INT_MIN extents for unmapped actors,
and several hidden sliders (OSD volume, the backlight brightness row) exist
in the tree at all times. Prefers the extension's own slider, which sets
accessible_name = 'Overlay Brightness'.
"""
import sys
import time
import pyatspi


def iter_sliders(node, depth=15):
    if depth <= 0 or node is None:
        return
    try:
        if node.getRoleName() == 'slider':
            yield node
        for i in range(node.childCount):
            yield from iter_sliders(node.getChildAtIndex(i), depth - 1)
    except Exception:
        return


def visible_extents(node):
    """Return (x, y, w, h) if the node is mapped with sane extents, else None."""
    try:
        if not node.getState().contains(pyatspi.STATE_SHOWING):
            return None
        b = node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
        if b.width <= 0 or b.height <= 0 or b.x < 0 or b.y < 0:
            return None
        return (b.x, b.y, b.width, b.height)
    except Exception:
        return None


def row_extents(slider):
    """Extents of the slider's row (parent with siblings) or the slider."""
    parent = slider.parent
    if parent and parent.childCount >= 2:
        ext = visible_extents(parent)
        if ext:
            return ext
    return visible_extents(slider)


time.sleep(1)
desktop = pyatspi.Registry.getDesktop(0)

candidates = []  # (priority, extents)
for app in desktop:
    if not app:
        continue
    try:
        name = (app.name or '').lower()
        if 'gnome-shell' not in name and 'mutter' not in name:
            continue
        for slider in iter_sliders(app):
            ext = row_extents(slider)
            if not ext:
                continue
            sname = (slider.name or '').lower()
            if 'overlay brightness' in sname:
                priority = 0
            elif 'brightness' in sname:
                priority = 1
            else:
                priority = 2
            candidates.append((priority, ext))
    except Exception:
        continue

if not candidates:
    print('no visible slider found', file=sys.stderr)
    sys.exit(1)

candidates.sort(key=lambda c: c[0])
x, y, w, h = candidates[0][1]
print(f'{x} {y} {w} {h}')

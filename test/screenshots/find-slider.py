#!/usr/bin/env python3
"""
Locate the Soft Brightness Plus slider in the GNOME Shell quick-settings
panel via AT-SPI and print its screen bounding box: X Y W H
"""
import sys
import time
import pyatspi


def find_node(node, role_name, name_substr=None, depth=15):
    if depth <= 0:
        return None
    try:
        if node.getRoleName() == role_name:
            if name_substr is None or name_substr.lower() in (node.name or '').lower():
                return node
        for i in range(node.childCount):
            result = find_node(node.getChildAtIndex(i), role_name, name_substr, depth - 1)
            if result:
                return result
    except Exception:
        pass
    return None


def find_slider_row(node, depth=15):
    """Find a slider and return its parent container (the whole row)."""
    slider = find_node(node, 'slider', depth=depth)
    if not slider:
        return None
    parent = slider.parent
    # If parent has a label sibling, it's the row; otherwise use slider bounds
    if parent and parent.childCount >= 2:
        return parent
    return slider


time.sleep(1)
desktop = pyatspi.Registry.getDesktop(0)

row = None
for app in desktop:
    if not app:
        continue
    try:
        name = (app.name or '').lower()
        if 'gnome-shell' not in name and 'mutter' not in name:
            continue
        row = find_slider_row(app)
        if row:
            break
    except Exception:
        continue

if not row:
    print('no slider found', file=sys.stderr)
    sys.exit(1)

try:
    bbox = row.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
    print(f'{bbox.x} {bbox.y} {bbox.width} {bbox.height}')
except Exception as e:
    print(f'getExtents failed: {e}', file=sys.stderr)
    sys.exit(1)

# Development Notes

## Build Process

**For creating a release package:**
```bash
make zip
mv build/extension.zip soft-brightness-plus@joelkitching.com.vXX.shell-extension.zip
```
(Replace `XX` with the appropriate version number)

**For local testing:**
```bash
make install
```
Then restart GNOME Shell (Alt+F2, `r` on X11; logout/login on Wayland)

## Checking Logs and Debugging

**View recent GNOME Shell logs:**
```bash
journalctl -b 0 /usr/bin/gnome-shell | tail -100
```

**Follow logs in real-time:**
```bash
journalctl -b 0 -f /usr/bin/gnome-shell
```

**Search for extension-specific errors:**
```bash
journalctl -b 0 /usr/bin/gnome-shell | grep -i "soft-brightness"
```

**Check extension state:**
```bash
gnome-extensions info soft-brightness-plus@joelkitching.com
```

## Version Bump Process

When releasing a new version, create a **separate commit** after all feature commits with the title "Bump to version XX".

**Files to update:**

1. **Makefile** - Update `VERSION` number (line 1)
2. **README.md** - Add changelog entry and update download links (~line 215 for download link, top of Changelog section)

See commit `8218c77` for an example.

**README changelog format:**
- New section goes above the previous version
- Keep lines wrapped at ~66 characters
- Also update the zip filename in the "Download / Install" section

## GitHub Release Process

After committing, pushing, and building the zip:

```bash
export GITHUB_TOKEN="$GITHUB_TOKEN_RW"
gh release create vXX \
  soft-brightness-plus@joelkitching.com.vXX.shell-extension.zip \
  --repo jkitching/soft-brightness-plus \
  --title "Version XX" \
  --notes "- Changelog bullet 1.
- Changelog bullet 2."
```

- **Title:** `Version XX`
- **Tag:** `vXX`
- **Notes:** bullet points only, unwrapped (no line breaks within bullets)
- **Asset:** the zip file built above
- The RW GitHub token is available in the environment as `GITHUB_TOKEN_RW`

## Backward Compatibility Patterns

To maintain compatibility with older GNOME Shell versions, check for API existence before using:

**Pattern 1: When capturing return value**
```javascript
// In GS XX, old_api was moved to new_location.
const result = object.new_method !== undefined
  ? object.new_method()
  : OldObject.old_method(args);
```

**Pattern 2: When NOT capturing return value**
```javascript
// In GS XX, old_api was replaced by new_api.
if (object.new_method !== undefined) {
    object.new_method();
} else {
    object.old_method();
}
```

**Pattern 3: Property/object existence**
```javascript
// In GS XX, use of "old_name" was renamed to "new_name".
const useNewAPI = NewObject.NewProperty !== undefined;
object.connect(
    useNewAPI ? 'new-signal' : 'old-signal',
    callback
);
```

See `src/extension.js` for examples (search for `// In GS`).

**Migration guide:** https://gjs.guide/extensions/upgrading/

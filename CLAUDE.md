# Development Notes

## Build Process

**For creating a release package:**
```bash
rm build/extension.zip
ninja -C build extension.zip
mv build/extension.zip soft-brightness-plus@joelkitching.com.vXX.shell-extension.zip
```
(Replace `XX` with the appropriate version number)

**For local testing:**
```bash
ninja -C build install
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

1. **meson-gse.build** - Update version number (~line 20)
2. **meson.build** - Update version number (~line 39)
3. **README.md** - Add changelog entry and update download links (~line 215 for download link, top of Changelog section)

See commit `8218c77` for an example.

**README changelog format:**
- New section goes above the previous version
- Keep lines wrapped at ~66 characters
- Also update the zip filename in the "Download / Install" section

## GitHub Release Process

### Before releasing
1. Update `README.md`: add a `### Version XX` changelog section above the previous version, and update the download link (~line 216) to the new zip filename.
2. Commit and push to master. CI must be green.

### Triggering the release
Go to GitHub → Releases → "Draft a new release":
- **Tag:** `vXX` (create new tag on master)
- **Title:** `Version XX`
- **Notes:** changelog bullet points
- Click **Publish release**

The Release workflow fires automatically:
1. **build** job: checks out the tagged commit, runs `make zip VERSION=XX`, attaches the zip to the release. Runs without approval.
2. **ego-deploy** job: pauses for required-reviewer approval (you, via the "ego-deploy" GitHub Environment). Once approved, uploads the same zip to extensions.gnome.org using `EGO_USER`/`EGO_PASSWORD` stored in that environment.

### One-time setup (ego-deploy environment)
In repo Settings → Environments → ego-deploy:
- Add yourself as a required reviewer
- Add `EGO_USER` and `EGO_PASSWORD` secrets

The environment protection means no workflow — including one pushed by an agent — can access those credentials without your explicit approval click.

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

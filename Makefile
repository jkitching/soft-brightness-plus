VERSION  := 52
UUID     := soft-brightness-plus@joelkitching.com
DOMAIN   := soft-brightness-plus

INSTALL_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
BUILD_DIR   := build
ZIP_NAME    := $(UUID).v$(VERSION).shell-extension.zip

# Source lists
JS_SOURCES := src/cursor.js src/extension.js src/logger.js src/prefs.js src/utils.js
SCHEMA_XML := schemas/org.gnome.shell.extensions.soft-brightness-plus.gschema.xml
DBUS_XML   := dbus-interfaces/org.gnome.Mutter.DisplayConfig.xml

# Translations
LINGUAS  := $(shell cat po/LINGUAS)
MO_FILES := $(addprefix $(BUILD_DIR)/locale/,$(addsuffix /LC_MESSAGES/$(DOMAIN).mo,$(LINGUAS)))

# Derive VCS tag from git (falls back to "unknown")
VCS_TAG := $(shell git describe --tags --long --always 2>/dev/null || echo unknown)

.PHONY: all zip dist install clean test test-e2e screenshot

all: $(BUILD_DIR)/metadata.json $(BUILD_DIR)/schemas/gschemas.compiled $(MO_FILES)

# ── metadata.json ─────────────────────────────────────────────────────────────
$(BUILD_DIR)/metadata.json: src/metadata.json.in
	@mkdir -p $(BUILD_DIR)
	sed \
	  -e 's|@version@|$(VERSION)|g' \
	  -e 's|@VCS_TAG@|$(VCS_TAG)|g' \
	  $< > $@

# ── compiled schemas ──────────────────────────────────────────────────────────
$(BUILD_DIR)/schemas/gschemas.compiled: $(SCHEMA_XML)
	@mkdir -p $(BUILD_DIR)/schemas
	cp $(SCHEMA_XML) $(BUILD_DIR)/schemas/
	glib-compile-schemas $(BUILD_DIR)/schemas/

# ── translations ──────────────────────────────────────────────────────────────
$(BUILD_DIR)/locale/%/LC_MESSAGES/$(DOMAIN).mo: po/%.po
	@mkdir -p $(dir $@)
	msgfmt $< -o $@

# ── extension zip ─────────────────────────────────────────────────────────────
zip dist: all
	@rm -f $(ZIP_NAME)
	@TMPDIR=$$(mktemp -d) && \
	  cp $(JS_SOURCES) $(BUILD_DIR)/metadata.json $$TMPDIR/ && \
	  mkdir -p $$TMPDIR/schemas $$TMPDIR/dbus-interfaces && \
	  cp $(SCHEMA_XML) $$TMPDIR/schemas/ && \
	  cp $(DBUS_XML) $$TMPDIR/dbus-interfaces/ && \
	  cp -r $(BUILD_DIR)/locale $$TMPDIR/ && \
	  (cd $$TMPDIR && zip -r $(CURDIR)/$(ZIP_NAME) .) && \
	  rm -rf $$TMPDIR
	@cp $(ZIP_NAME) $(BUILD_DIR)/extension.zip
	@echo "Created $(ZIP_NAME) (also at $(BUILD_DIR)/extension.zip)"

# ── install ───────────────────────────────────────────────────────────────────
install: all
	@mkdir -p $(INSTALL_DIR)/schemas $(INSTALL_DIR)/dbus-interfaces
	cp $(JS_SOURCES) $(BUILD_DIR)/metadata.json $(INSTALL_DIR)/
	cp $(BUILD_DIR)/schemas/gschemas.compiled $(SCHEMA_XML) $(INSTALL_DIR)/schemas/
	cp $(DBUS_XML) $(INSTALL_DIR)/dbus-interfaces/
	cp -r $(BUILD_DIR)/locale $(INSTALL_DIR)/
	@echo "Installed to $(INSTALL_DIR)"

# ── test ──────────────────────────────────────────────────────────────────────
# Requires Node.js >= 20.6 for the module loader register() API.
NODE_MAJOR := $(shell node -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)
NODE_MINOR := $(shell node -e 'process.stdout.write(process.versions.node.split(".")[1])' 2>/dev/null || echo 0)

test: all
	@if [ "$(NODE_MAJOR)" -lt 20 ] || \
	    ( [ "$(NODE_MAJOR)" -eq 20 ] && [ "$(NODE_MINOR)" -lt 6 ] ); then \
	  echo "ERROR: Node.js >= 20.6 required (have $$(node --version 2>/dev/null || echo 'none'))"; \
	  echo "       Install via nvm: nvm install 20"; \
	  exit 1; \
	fi
	node --import ./test/register.mjs --test test/*.test.mjs
	@if command -v gjs >/dev/null 2>&1; then \
	  gjs -m test/gjs-schema.gjs; \
	else \
	  echo "gjs not found — skipping schema validation test"; \
	fi

# ── e2e (container) tests ─────────────────────────────────────────────────────
test-e2e: zip
	test/e2e.sh

# ── screenshot (container) ────────────────────────────────────────────────────
screenshot: zip
	test/screenshots.sh

# ── clean ─────────────────────────────────────────────────────────────────────
clean:
	rm -rf $(BUILD_DIR)

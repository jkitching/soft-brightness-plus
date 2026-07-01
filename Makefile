VERSION  := 50
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

.PHONY: all zip dist install clean test

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
	  cp $(BUILD_DIR)/schemas/gschemas.compiled $(SCHEMA_XML) $$TMPDIR/schemas/ && \
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
test: all
	node --import ./test/register.mjs --test test/*.test.mjs
	@if command -v gjs >/dev/null 2>&1; then \
	  gjs -m test/gjs-schema.gjs; \
	else \
	  echo "gjs not found — skipping schema validation test"; \
	fi

# ── clean ─────────────────────────────────────────────────────────────────────
clean:
	rm -rf $(BUILD_DIR)

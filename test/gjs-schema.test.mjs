#!/usr/bin/env -S gjs -m
// GJS test: validates the GSettings schema using real GLib
// Run with: gjs -m test/gjs-schema.test.mjs
// Requires: glib-compile-schemas and gjs installed

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';

// Compile schema into a temp dir
const schemaDir = GLib.build_filenamev([GLib.get_tmp_dir(), 'sbp-schema-test']);
GLib.mkdir_with_parents(schemaDir, 0o755);

const srcSchemaDir = GLib.build_filenamev([GLib.get_current_dir(), 'schemas']);

const [ok, , , exit] = GLib.spawn_command_line_sync(
    `glib-compile-schemas ${srcSchemaDir} --targetdir ${schemaDir}`
);
if (!ok || exit !== 0) {
    printerr('FAIL: glib-compile-schemas failed');
    System.exit(1);
}

// Load and validate the schema
const source = Gio.SettingsSchemaSource.new_from_directory(
    schemaDir,
    Gio.SettingsSchemaSource.get_default(),
    false
);

const SCHEMA_ID = 'org.gnome.shell.extensions.soft-brightness-plus';
const schema = source.lookup(SCHEMA_ID, false);

if (!schema) {
    printerr(`FAIL: schema '${SCHEMA_ID}' not found`);
    System.exit(1);
}
print(`PASS: schema '${SCHEMA_ID}' loaded`);

// Verify expected keys exist with correct types
const EXPECTED_KEYS = {
    'current-brightness': 'd',
    'min-brightness': 'd',
    'monitors': 's',
    'builtin-monitor': 's',
    'use-backlight': 'b',
    'clone-mouse': 'b',
    'prevent-unredirect': 's',
    'debug': 'b',
};

let allPassed = true;
for (const [key, expectedType] of Object.entries(EXPECTED_KEYS)) {
    const keySchema = schema.get_key(key);
    if (!keySchema) {
        printerr(`FAIL: key '${key}' not found in schema`);
        allPassed = false;
        continue;
    }
    const actualType = keySchema.get_value_type().dup_string();
    if (actualType !== expectedType) {
        printerr(`FAIL: key '${key}' has type '${actualType}', expected '${expectedType}'`);
        allPassed = false;
        continue;
    }
    print(`PASS: key '${key}' type='${actualType}'`);
}

// Validate brightness defaults are in [0,1]
const brightnessDefault = schema.get_key('current-brightness').get_default_value().get_double();
if (brightnessDefault < 0.0 || brightnessDefault > 1.0) {
    printerr(`FAIL: current-brightness default ${brightnessDefault} out of range [0,1]`);
    allPassed = false;
} else {
    print(`PASS: current-brightness default=${brightnessDefault} is in [0,1]`);
}

const minBrightnessDefault = schema.get_key('min-brightness').get_default_value().get_double();
if (minBrightnessDefault < 0.0 || minBrightnessDefault > 1.0) {
    printerr(`FAIL: min-brightness default ${minBrightnessDefault} out of range [0,1]`);
    allPassed = false;
} else {
    print(`PASS: min-brightness default=${minBrightnessDefault} is in [0,1]`);
}

if (!allPassed) {
    System.exit(1);
}
print('All schema tests passed.');

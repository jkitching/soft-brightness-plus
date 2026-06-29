import { makeSettings } from './settings-factory.mjs';

export class Extension {
    constructor(metadata = {}) {
        this.metadata = { version: 46, vcs_revision: 'test', ...metadata };
        this.path = '/fake/extension/path';
        this._settingsOverrides = {};
    }
    getSettings() {
        return makeSettings(this._settingsOverrides);
    }
}

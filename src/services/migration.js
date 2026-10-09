import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {normalizeProviderOrder} from '../core/providerRegistry.js';
import {buildPath, migrateLegacyData} from './files.js';

const LEGACY_UUID = 'freeby@kelvin.local';
const LEGACY_SCHEMA = 'org.gnome.shell.extensions.freeby';
const SETTINGS = Object.freeze([
    'refresh-interval',
    'notifications-enabled',
    'enabled-providers',
    'default-provider',
    'history-retention-days',
    'notification-threshold',
]);

function legacySchemaDirectories() {
    return [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()]
        .map(directory => buildPath(directory, 'gnome-shell', 'extensions', LEGACY_UUID, 'schemas'));
}

function legacySettings(directories = legacySchemaDirectories()) {
    for (const directory of directories) {
        if (!Gio.File.new_for_path(directory).query_exists(null))
            continue;
        try {
            const source = Gio.SettingsSchemaSource.new_from_directory(
                directory, Gio.SettingsSchemaSource.get_default(), false);
            const schema = source.lookup(LEGACY_SCHEMA, false);
            if (schema)
                return new Gio.Settings({settings_schema: schema});
        } catch {
            // A missing or invalid former installation must not block startup.
        }
    }
    return null;
}

export function migrateLegacySettings(settings, directories = undefined) {
    const legacy = legacySettings(directories);
    if (!legacy)
        return 0;
    return copyLegacySettings(settings, legacy);
}

export function copyLegacySettings(settings, legacy) {
    let migrated = 0;
    for (const key of SETTINGS) {
        if (settings.get_user_value(key) !== null)
            continue;
        const value = legacy.get_user_value(key);
        if (value !== null && settings.set_value(key, value))
            migrated++;
    }
    return migrated;
}

export function migrateLegacyInstall(settings) {
    migrateLegacyData();
    migrateLegacySettings(settings);
    migrateProviderOrder(settings);
}

export function migrateProviderOrder(settings) {
    if (settings.get_user_value('provider-order') !== null)
        return false;
    const value = settings.get_user_value('enabled-providers');
    if (value === null)
        return false;
    const enabled = value.deepUnpack?.() ?? value.deep_unpack?.() ?? value;
    settings.set_strv('provider-order', normalizeProviderOrder(enabled));
    return true;
}

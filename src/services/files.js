import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {PROVIDER_IDS} from '../core/providerRegistry.js';

export const buildPath = (...parts) => GLib.build_filenamev(parts);
export const fingerprint = value => GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, String(value), -1);

const PRODUCT_DIRECTORY = 'usagebeam';
const LEGACY_DIRECTORY = 'freeby';

function readBoundedFileText(path, fallback = null, maxBytes = 16 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
        throw new Error('File size limit must be a positive integer');
    try {
        const file = Gio.File.new_for_path(path);
        if (file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size() > maxBytes)
            return fallback;
        const [, bytes] = file.load_contents(null);
        if (bytes.length > maxBytes)
            return fallback;
        return new TextDecoder().decode(bytes);
    } catch {
        return fallback;
    }
}

export function readJson(path, fallback = null, maxBytes = 16 * 1024 * 1024) {
    const text = readBoundedFileText(path, null, maxBytes);
    if (text === null)
        return fallback;
    try {
        return JSON.parse(text);
    } catch {
        return fallback;
    }
}

export function writeJson(path, value) {
    const file = Gio.File.new_for_path(path);
    const parent = file.get_parent();
    const parentPath = parent?.get_path();
    if (!parentPath || GLib.mkdir_with_parents(parentPath, 0o700) < 0 || GLib.chmod(parentPath, 0o700) < 0)
        throw new Error('Could not secure the private data directory');
    file.replace_contents(new TextEncoder().encode(JSON.stringify(value)), null, false,
        Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    if (GLib.chmod(path, 0o600) < 0)
        throw new Error('Could not secure the private data file');
}

export function stateDirectory() {
    return buildPath(GLib.get_user_state_dir(), PRODUCT_DIRECTORY);
}

export function cacheDirectory() {
    return buildPath(GLib.get_user_cache_dir(), PRODUCT_DIRECTORY);
}

export function clearDerivedData({state = stateDirectory(), cache = cacheDirectory()} = {}) {
    const paths = [
        ...PROVIDER_IDS.map(id => buildPath(state, `${id}.json`)),
        ...PROVIDER_IDS.map(id => buildPath(cache, `history-${id}.json`)),
    ];
    let removed = 0;
    for (const path of paths) {
        const file = Gio.File.new_for_path(path);
        try {
            const type = file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            if (![Gio.FileType.REGULAR, Gio.FileType.SYMBOLIC_LINK].includes(type))
                continue;
            file.delete(null);
            removed++;
        } catch {
            // Missing or inaccessible cache files do not make clearing unsafe.
        }
    }
    return removed;
}

export function migrateLegacyData({
    legacyState = buildPath(GLib.get_user_state_dir(), LEGACY_DIRECTORY),
    legacyCache = buildPath(GLib.get_user_cache_dir(), LEGACY_DIRECTORY),
    state = stateDirectory(),
    cache = cacheDirectory(),
} = {}) {
    const groups = [
        {source: legacyState, destination: state, names: PROVIDER_IDS.map(id => `${id}.json`),
            maxBytes: 16 * 1024 * 1024},
        {source: legacyCache, destination: cache, names: PROVIDER_IDS.map(id => `history-${id}.json`),
            maxBytes: 64 * 1024 * 1024},
    ];
    let migrated = 0;
    for (const group of groups) {
        for (const name of group.names) {
            const destination = buildPath(group.destination, name);
            if (Gio.File.new_for_path(destination).query_exists(null))
                continue;
            const value = readJson(buildPath(group.source, name), null, group.maxBytes);
            if (value === null)
                continue;
            try {
                writeJson(destination, value);
                migrated++;
            } catch {
                // Migration is best-effort; collection can rebuild derived data.
            }
        }
    }
    return migrated;
}

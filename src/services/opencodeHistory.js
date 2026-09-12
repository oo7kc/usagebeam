import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {record, recentDates, section, validateRecord} from '../core/usage.js';
import {commandSpec} from './commands.js';
import {cacheDirectory, fingerprint, join, readJson, writeJson} from './files.js';
import {runCommand} from './process.js';

function stamp(path) {
    try {
        const info = Gio.File.new_for_path(path).query_info('standard::size,time::modified,time::modified-usec,' +
            'time::changed,time::changed-usec,id::file', Gio.FileQueryInfoFlags.NONE, null);
        return ['standard::size', 'time::modified', 'time::modified-usec', 'time::changed', 'time::changed-usec', 'id::file']
            .map(name => info.get_attribute_as_string(name));
    } catch {
        return null;
    }
}

function validHistory(history) {
    const value = record('opencode');
    value.capabilities = {limits: false, history: true, models: true};
    value.history = history;
    return validateRecord(value, 'opencode').history;
}

export async function readOpenCodeHistory(script, {cancellable = null, now = Date.now(), path = null,
    cachePath = null} = {}) {
    const root = join(GLib.get_user_data_dir(), 'opencode');
    const configured = path ?? GLib.getenv('OPENCODE_DB') ?? 'opencode.db';
    const database = GLib.path_is_absolute(configured) ? configured : join(root, configured);
    const missing = record('opencode').history;
    const identity = fingerprint(database);
    const destination = cachePath ?? join(cacheDirectory(), 'history-opencode.json');
    const cached = readJson(destination, null, 256 * 1024);
    let saved = null;
    if (cached?.identity === identity) {
        try { saved = validHistory(cached.history); } catch { /* Rebuild invalid cache contents. */ }
    }
    if (configured === ':memory:' || !stamp(database))
        return {...missing, ...section(saved ? 'unavailable' : 'unsupported', saved
            ? 'The OpenCode database is temporarily unavailable.'
            : 'No local OpenCode database found. Run a session in OpenCode to get started.')};
    const signature = () => fingerprint(JSON.stringify([1, database, recentDates(now, 1)[0],
        new Date(now).getTimezoneOffset(),
        stamp(database), stamp(`${database}-wal`)]));
    const before = signature();
    // Recheck periodically even without a file change: clock corrections can
    // make previously future-dated records enter the current window.
    if (cached?.signature === before && saved?.status === 'ready' &&
        saved.updatedAt <= now && now - saved.updatedAt < 300000)
        return {...saved, updatedAt: now, scannedFiles: 0};
    try {
        const output = await runCommand(commandSpec('python3', ['-B', script, database, String(now)]),
            {cancellable, timeout: 18000, maxOutputBytes: 256 * 1024});
        const history = validHistory({...JSON.parse(output), scannedFiles: 1});
        if (history.status === 'ready' && before === signature()) {
            try { writeJson(destination, {identity, signature: before, history}); } catch { /* Current usage remains available. */ }
        }
        return history;
    } catch (error) {
        return {...missing, ...section('unavailable', error.code === 'NOT_FOUND'
            ? 'Python 3.11 or newer with SQLite support is required to read OpenCode activity.'
            : 'OpenCode activity could not be refreshed. Try again shortly.')};
    }
}

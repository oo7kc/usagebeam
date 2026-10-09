import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {aggregateEvents} from '../core/activity.js';
import {getRecentDates} from '../core/dates.js';
import {createUsageSection} from '../core/usage.js';
import {parseSafeInteger} from '../core/values.js';
import {buildPath, cacheDirectory, fingerprint, readJson, writeJson} from './files.js';
import {createHistoryFileState, normalizeCachedHistoryFile, privateIdentity, sanitizeHistoryEvent} from './historyCache.js';
import {readHistoryFile} from './historyReader.js';

const CACHE_VERSION = 6;
const MAX_DEPTH = 12;
const MAX_FILES = 20000;
const MAX_MODELS = 128;
const SCAN_SECONDS = 20;

function fileStamp(info) {
    const modified = info.get_attribute_uint64('time::modified');
    const modifiedUsec = info.get_attribute_uint32('time::modified-usec');
    const changed = info.get_attribute_uint64('time::changed');
    const changedUsec = info.get_attribute_uint32('time::changed-usec');
    return `${modified}:${modifiedUsec}:${changed}:${changedUsec}`;
}

function listFiles(root, output, deadline, depth = 0) {
    if (depth > MAX_DEPTH || output.length >= MAX_FILES || GLib.get_monotonic_time() > deadline)
        throw new Error('History directory exceeds scan bounds');
    const file = Gio.File.new_for_path(root);
    if (!file.query_exists(null))
        return false;
    const iterator = file.enumerate_children('standard::name,standard::type,standard::is-symlink,standard::size,' +
        'time::modified,time::modified-usec,time::changed,time::changed-usec,id::file',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    try {
        let info;
        while ((info = iterator.next_file(null))) {
            if (GLib.get_monotonic_time() > deadline)
                throw new Error('History directory scan timed out');
            if (info.get_is_symlink())
                continue;
            const path = buildPath(root, info.get_name());
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                listFiles(path, output, deadline, depth + 1);
            else if (info.get_file_type() === Gio.FileType.REGULAR && info.get_name().endsWith('.jsonl')) {
                if (output.length >= MAX_FILES)
                    throw new Error('History directory exceeds scan bounds');
                output.push({path, size: info.get_size(), stamp: fileStamp(info),
                    fileId: info.get_attribute_string('id::file') ?? ''});
            }
        }
    } finally {
        iterator.close(null);
    }
    return true;
}

export function scanJsonlHistory(id, roots, parse, {retention = 30, now = Date.now(), cachePath = null,
    oversizedRecordMayAffectUsage = () => true} = {}) {
    if (!Number.isSafeInteger(retention) || retention < 7 || retention > 90 ||
        !Number.isSafeInteger(now) || now <= 0 || !Array.isArray(roots) || !roots.length ||
        roots.some(root => typeof root !== 'string' || !root) || typeof parse !== 'function' ||
        typeof oversizedRecordMayAffectUsage !== 'function' ||
        (cachePath !== null && (typeof cachePath !== 'string' || !cachePath)))
        throw new Error('Invalid history scan options');
    const cutoff = getRecentDates(now, retention)[0];
    const destination = cachePath ?? buildPath(cacheDirectory(), `history-${id}.json`);
    let cached = readJson(destination, {}, 64 * 1024 * 1024);
    const identity = fingerprint(JSON.stringify(roots));
    if (cached?.version !== CACHE_VERSION || cached.identity !== identity || !cached.files || typeof cached.files !== 'object' ||
        Array.isArray(cached.files))
        cached = {version: CACHE_VERSION, identity, files: {}, updatedAt: null};
    const files = [];
    let detected = false;
    let partial = false;
    let parsed = 0;
    const started = GLib.get_monotonic_time();
    const deadline = started + SCAN_SECONDS * 1000000;
    for (const root of roots) {
        try {
            detected = listFiles(root, files, deadline) || detected;
        } catch {
            partial = true;
        }
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const currentKeys = new Set(files.map(file => fingerprint(file.path)));
    for (const file of files) {
        if ((GLib.get_monotonic_time() - started) / 1000000 > SCAN_SECONDS) {
            partial = true;
            break;
        }
        const key = fingerprint(file.path);
        const fallbackSession = privateIdentity(id, key);
        let previous = normalizeCachedHistoryFile(cached.files[key], fallbackSession);
        if (previous?.size === file.size && previous.stamp === file.stamp && previous.fileId === file.fileId) {
            partial ||= previous.partial;
            continue;
        }
        // Changed or truncated files are rebuilt; append-only files resume at the last complete line.
        if (!previous || file.fileId !== previous.fileId || file.size < previous.size || previous.offset > file.size ||
            (file.size === previous.size && file.stamp !== previous.stamp))
            previous = createHistoryFileState(file.fileId, fallbackSession);
        try {
            const result = readHistoryFile(file, previous, {
                providerId: id, fallbackSession, parseEvent: parse, cutoff, deadline, oversizedRecordMayAffectUsage,
            });
            cached.files[key] = result.state;
            partial ||= result.state.partial || result.timedOut;
            parsed++;
        } catch {
            partial = true;
        }
    }
    const events = [];
    for (const [key, file] of Object.entries(cached.files)) {
        const normalized = /^[a-f0-9]{64}$/.test(key) ? normalizeCachedHistoryFile(file, privateIdentity(id, key)) : null;
        if (!normalized) {
            delete cached.files[key];
            partial = true;
            continue;
        }
        cached.files[key] = normalized;
        partial ||= normalized.partial;
        for (const [eventKey, event] of Object.entries(normalized.events)) {
            const valid = sanitizeHistoryEvent(event, id, true);
            if (!valid || event.date < cutoff) {
                delete normalized.events[eventKey];
                partial ||= !valid;
            } else {
                if (eventKey !== valid.id) {
                    delete normalized.events[eventKey];
                    partial = true;
                }
                normalized.events[valid.id] = valid;
                events.push(valid);
            }
        }
        if (!currentKeys.has(key) && !Object.keys(normalized.events).length)
            delete cached.files[key];
    }
    if (files.length)
        cached.updatedAt = now;
    try {
        writeJson(destination, cached);
    } catch {
        partial = true;
    }
    const sourceAvailable = files.length > 0;
    const hasCachedEvents = !sourceAvailable && events.length > 0;
    const status = sourceAvailable ? partial ? 'partial' : 'ready' : hasCachedEvents ? 'stale' : 'unsupported';
    const result = {...createUsageSection(status,
        partial ? 'Some local records could not be read. Totals may be incomplete.' :
            sourceAvailable ? 'Local records only; activity on other devices is not included.' :
                hasCachedEvents ? 'Showing saved local activity; source records are currently unavailable.' :
                    detected ? 'No local usage records found yet.' : 'No local usage records found.'),
    updatedAt: sourceAvailable ? now : hasCachedEvents ? parseSafeInteger(cached.updatedAt) : null,
    scope: 'local', source: `${id} local usage records`,
    ...aggregateEvents(events, now), scannedFiles: parsed};
    if (result.models.length > MAX_MODELS) {
        result.models = result.models.slice(0, MAX_MODELS);
        result.status = 'partial';
        result.message = 'Model totals were truncated to keep local history bounded.';
    }
    if ((!sourceAvailable || partial) && !events.length) {
        result.days = [];
        result.models = [];
        result.period = null;
    }
    return result;
}

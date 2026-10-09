import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {createHistoryFileState, normalizeParserState, privateIdentity, sanitizeHistoryEvent} from './historyCache.js';

const READ_CHUNK_BYTES = 65536;
const MAX_LINE_BYTES = 4 * 1024 * 1024;

function oversizedRecordIsRelevant(bytes, classifier) {
    try {
        // A provider may clear the warning only when it can prove from this
        // bounded prefix that its parser would ignore the complete record.
        return classifier(bytes) !== false;
    } catch {
        return true;
    }
}
function hashPrefix(input, length, deadline) {
    const checksum = new GLib.Checksum(GLib.ChecksumType.SHA256);
    input.seek(0, GLib.SeekType.SET, null);
    let remaining = length;
    while (remaining > 0) {
        if (GLib.get_monotonic_time() > deadline)
            throw new Error('History validation timed out');
        const bytes = input.read_bytes(Math.min(READ_CHUNK_BYTES, remaining), null).toArray();
        if (!bytes.length)
            throw new Error('History changed while validating');
        checksum.update(bytes);
        remaining -= bytes.length;
    }
    return checksum;
}

export function readHistoryFile(file, previous, {
    providerId, fallbackSession, parseEvent, cutoff, deadline, oversizedRecordMayAffectUsage,
}) {
    let input;
    try {
        input = Gio.File.new_for_path(file.path).read(null);
        // Verify the entire committed prefix before resuming. In-place rewrites
        // can grow as well as shrink, so size/mtime or sampled bytes are not proof
        // that a file is append-only. Only a digest reaches the private cache.
        let checksum = hashPrefix(input, previous.offset, deadline);
        if (previous.offset && (!previous.digest || checksum.copy().get_string() !== previous.digest)) {
            previous = createHistoryFileState(file.fileId, fallbackSession);
            checksum = hashPrefix(input, 0, deadline);
        }
        input.seek(previous.offset, GLib.SeekType.SET, null);
        let offset = previous.offset;
        let tail = new Uint8Array();
        let stop = false;
        while (!stop) {
            const bytes = input.read_bytes(READ_CHUNK_BYTES, null).toArray();
            if (!bytes.length)
                break;
            const buffer = new Uint8Array(tail.length + bytes.length);
            buffer.set(tail);
            buffer.set(bytes, tail.length);
            let start = 0;
            // The retained tail was already checked for newlines. Scanning
            // it again on every chunk makes long records quadratic work.
            for (let i = tail.length; i < buffer.length; i++) {
                if (buffer[i] !== 10)
                    continue;
                const line = buffer.subarray(start, i);
                offset += i - start + 1;
                start = i + 1;
                if (previous.skipping || line.length > MAX_LINE_BYTES) {
                    const relevant = previous.skipping ? previous.skippingRelevant :
                        oversizedRecordIsRelevant(line.subarray(0, READ_CHUNK_BYTES), oversizedRecordMayAffectUsage);
                    previous.skipping = false;
                    previous.skippingRelevant = true;
                    previous.partial ||= relevant;
                    continue;
                }
                try {
                    const text = new TextDecoder().decode(line);
                    if (!text.trim())
                        continue;
                    const oldSession = previous.state.session;
                    const event = parseEvent(JSON.parse(text), previous.state);
                    // Provider session identifiers are useful only for
                    // deduplication. Hash them before either parser state or
                    // derived events reach UsageBeam's private cache.
                    if (previous.state.session !== oldSession)
                        previous.state.session = privateIdentity(providerId, previous.state.session);
                    if (event) {
                        const sanitized = sanitizeHistoryEvent(event, providerId);
                        if (!sanitized)
                            previous.partial = true;
                        else if (sanitized.date >= cutoff)
                            previous.events[sanitized.id] = sanitized;
                    }
                } catch {
                    previous.partial = true;
                }
            }
            checksum.update(buffer.subarray(0, start));
            tail = buffer.slice(start);
            if (tail.length > MAX_LINE_BYTES || previous.skipping) {
                // Consume, rather than retry, oversized lines. Persist the skip
                // state across deadlines and appends, never treating their suffix
                // as a new JSON record. Keep processing later complete records.
                const relevant = previous.skipping ? previous.skippingRelevant :
                    oversizedRecordIsRelevant(tail.subarray(0, READ_CHUNK_BYTES), oversizedRecordMayAffectUsage);
                previous.partial ||= relevant;
                previous.skipping = true;
                previous.skippingRelevant = relevant;
                checksum.update(tail);
                offset += tail.length;
                tail = new Uint8Array();
            }
            if (GLib.get_monotonic_time() > deadline) {
                stop = true;
            }
        }
        previous.offset = offset;
        previous.digest = checksum.get_string();
        // A time-limited scan must resume even if the source file has not changed.
        previous.size = stop ? -1 : Math.max(file.size, offset);
        previous.stamp = file.stamp;
        previous.fileId = file.fileId;
        previous.state = normalizeParserState(previous.state, fallbackSession);
        return {state: previous, timedOut: stop};
    } finally {
        input?.close(null);
    }
}

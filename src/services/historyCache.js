import {isIsoDate} from '../core/dates.js';
import {parseSafeInteger} from '../core/values.js';
import {fingerprint} from './files.js';

export function privateIdentity(provider, value) {
    const text = String(value ?? '');
    return /^h:[a-f0-9]{64}$/.test(text) ? text : `h:${fingerprint(`${provider}:${text}`)}`;
}

export function normalizeParserState(value, fallbackSession) {
    const session = typeof value?.session === 'string' && /^h:[a-f0-9]{64}$/.test(value.session)
        ? value.session
        : fallbackSession;
    const state = {session};
    if (typeof value?.model === 'string' && value.model.trim() && value.model.length <= 160 &&
        !/[\u0000-\u001f\u007f]/.test(value.model))
        state.model = value.model;
    if (parseSafeInteger(value?.cumulativeEpoch) !== null)
        state.cumulativeEpoch = parseSafeInteger(value.cumulativeEpoch);
    if (value?.cumulative && typeof value.cumulative === 'object') {
        const fields = ['total_tokens', 'input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_input_tokens'];
        if (fields.every(field => parseSafeInteger(value.cumulative[field]) !== null))
            state.cumulative = Object.fromEntries(fields.map(field => [field, parseSafeInteger(value.cumulative[field])]));
    }
    return state;
}

export function normalizeCachedHistoryFile(value, fallbackSession) {
    if (!value || typeof value !== 'object' || !value.events || typeof value.events !== 'object' ||
        Array.isArray(value.events))
        return null;
    const offset = parseSafeInteger(value.offset);
    const size = value.size === -1 ? -1 : parseSafeInteger(value.size);
    if (offset === null || size === null || typeof value.stamp !== 'string' || typeof value.fileId !== 'string')
        return null;
    return {offset, size, stamp: value.stamp, fileId: value.fileId,
        digest: typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest) ? value.digest : null,
        skipping: value.skipping === true,
        skippingRelevant: value.skippingRelevant !== false,
        state: normalizeParserState(value.state, fallbackSession), events: value.events, partial: value.partial === true};
}

export function createHistoryFileState(fileId, session) {
    return {offset: 0, size: 0, stamp: '', fileId, digest: null, skipping: false, skippingRelevant: true,
        state: {session}, events: {}, partial: false};
}
export function sanitizeHistoryEvent(event, provider, stored = false) {
    if (!event || typeof event !== 'object' || typeof event.id !== 'string' || !event.id ||
        typeof event.session !== 'string' || !event.session || typeof event.model !== 'string' ||
        !event.model.trim() || event.model.length > 160 || event.id.length > 2048 || event.session.length > 2048 ||
        /[\u0000-\u001f\u007f]/.test(event.model) || !isIsoDate(event.date) ||
        (stored && (!/^h:[a-f0-9]{64}$/.test(event.id) || !/^h:[a-f0-9]{64}$/.test(event.session))))
        return null;
    const values = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite']
        .map(field => [field, parseSafeInteger(event[field])]));
    if (Object.values(values).some(value => value === null))
        return null;
    return {...values, date: event.date, model: event.model,
        id: stored ? event.id : privateIdentity(provider, event.id),
        session: stored ? event.session : privateIdentity(provider, event.session)};
}

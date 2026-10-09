import {normalizeTimestamp} from './dates.js';
import {PROVIDER_NAMES, isProviderId} from './providerRegistry.js';
import {parseNonNegativeNumber} from './values.js';

export const USAGE_SCHEMA_VERSION = 2;

export function createUsageSection(status = 'loading', message = '') {
    return {status, message, updatedAt: null};
}

export function createUsageRecord(id) {
    if (!isProviderId(id))
        throw new Error(`Unsupported provider: ${id}`);
    return {
        schemaVersion: USAGE_SCHEMA_VERSION, id, name: PROVIDER_NAMES[id], plan: null, accountKey: null,
        capabilities: {limits: false, history: false, models: false},
        limits: {...createUsageSection(), scope: 'account', source: null, windows: []},
        history: {...createUsageSection('unsupported', 'This provider does not expose local token history.'),
            scope: 'local', period: null, days: [], models: [], source: null},
    };
}

export function createQuotaWindow({id, label, usedPercent, used, limit, unit = 'percent', durationMinutes = null,
    resetsAt = null, unlimited = false}) {
    let percent = parseNonNegativeNumber(usedPercent);
    used = parseNonNegativeNumber(used);
    limit = parseNonNegativeNumber(limit);
    if (percent === null && used !== null && limit > 0)
        percent = used / limit * 100;
    if (percent === null && !unlimited)
        return null;
    const normalizedPercent = unlimited ? null : percent;
    return {id, label, usedPercent: normalizedPercent, used, limit, unit, unlimited,
        state: unlimited ? 'unlimited' : normalizedPercent >= 100 ? 'exhausted' : 'active',
        durationMinutes: parseNonNegativeNumber(durationMinutes), resetsAt: normalizeTimestamp(resetsAt)};
}

export function mergeUsageRecords(previous, next, now = Date.now()) {
    if (!previous || (previous.accountKey && next.accountKey && previous.accountKey !== next.accountKey))
        return next;
    const result = {...next, capabilities: {...next.capabilities}};
    for (const key of ['limits', 'history']) {
        const old = previous[key];
        const current = next[key];
        if (current.status === 'unavailable' && old?.updatedAt &&
            ['ready', 'partial', 'stale'].includes(old.status)) {
            const preserved = key === 'limits'
                ? {...old, windows: old.windows.filter(window => !window.resetsAt || window.resetsAt > now)}
                : old;
            if (key !== 'limits' || preserved.windows.length) {
                result[key] = {...preserved, status: 'stale', message: current.message};
                result.capabilities[key] = previous.capabilities[key];
                if (key === 'history')
                    result.capabilities.models = previous.capabilities.models;
            }
        }
    }
    if (result.limits.status === 'stale') {
        result.plan ??= previous.plan;
        result.accountKey ??= previous.accountKey;
    }
    return result;
}

export function collectionNeedsBackoff(value) {
    return ['limits', 'history'].some(key => value.capabilities[key] &&
        ['unavailable', 'missing-auth'].includes(value[key].status));
}

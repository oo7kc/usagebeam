export const SCHEMA_VERSION = 2;
export const NAMES = Object.freeze({codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode'});
export const PROVIDER_IDS = Object.freeze(Object.keys(NAMES));

const STATES = new Set(['loading', 'ready', 'partial', 'stale', 'missing-auth', 'unsupported', 'unavailable']);
const WINDOW_STATES = new Set(['active', 'exhausted', 'unlimited']);

const MAX_WINDOWS = 32;
const MAX_DAYS = 90;
const MAX_MODELS = 128;
const READY_STATES = new Set(['ready', 'partial', 'stale']);

function fail(message) {
    throw new Error(`Invalid usage record: ${message}`);
}

function shape(value, field, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some(key => !allowed.includes(key)))
        fail(field);
}

function text(value, field, {nullable = false, max = 240} = {}) {
    if (nullable && value === null)
        return;
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value))
        fail(field);
}

function numeric(value, field, {nullable = false, integer = false} = {}) {
    if (nullable && value === null)
        return;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value)))
        fail(field);
}

function isoDate(value, field) {
    const parsed = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? Date.parse(`${value}T00:00:00Z`)
        : NaN;
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value)
        fail(field);
}

export function number(value) {
    if (value === null || value === undefined || typeof value === 'boolean' ||
        !['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim()))
        return null;
    const result = Number(value);
    return Number.isFinite(result) && result >= 0 ? result : null;
}

export function section(status = 'loading', message = '') {
    return {status, message, updatedAt: null};
}

export function isProvider(id) {
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(NAMES, id);
}

export function providerOrder(value = []) {
    const requested = Array.isArray(value) ? value : [];
    return [...new Set([...requested.filter(isProvider), ...PROVIDER_IDS])];
}

export function orderedEnabledProviders(enabled = [], order = []) {
    const selected = new Set(Array.isArray(enabled) ? enabled.filter(isProvider) : []);
    return providerOrder(order).filter(id => selected.has(id));
}

export function record(id) {
    if (!isProvider(id))
        throw new Error(`Unsupported provider: ${id}`);
    return {
        schemaVersion: SCHEMA_VERSION, id, name: NAMES[id], plan: null, accountKey: null,
        capabilities: {limits: false, history: false, models: false},
        limits: {...section(), scope: 'account', source: null, windows: []},
        history: {...section('unsupported', 'This provider does not expose local token history.'),
            scope: 'local', period: null, days: [], models: [], source: null},
    };
}

export function windowUsage({id, label, usedPercent, used, limit, unit = 'percent', durationMinutes = null,
    resetsAt = null, unlimited = false}) {
    let percent = number(usedPercent);
    used = number(used);
    limit = number(limit);
    if (percent === null && used !== null && limit > 0)
        percent = used / limit * 100;
    if (percent === null && !unlimited)
        return null;
    const normalizedPercent = unlimited ? null : percent;
    return {id, label, usedPercent: normalizedPercent, used, limit, unit, unlimited,
        state: unlimited ? 'unlimited' : normalizedPercent >= 100 ? 'exhausted' : 'active',
        durationMinutes: number(durationMinutes), resetsAt: validTime(resetsAt)};
}

export function validTime(value) {
    if (value === null || value === undefined || value === '')
        return null;
    const numeric = typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value).trim()) ? Number(value) : null;
    const ms = numeric !== null ? (numeric < 1e12 ? numeric * 1000 : numeric) : Date.parse(value);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
}

export function validateRecord(value, expectedId) {
    shape(value, 'record shape', [
        'schemaVersion', 'id', 'name', 'plan', 'accountKey', 'capabilities', 'limits', 'history',
    ]);
    if (!value || value.schemaVersion !== SCHEMA_VERSION || value.id !== expectedId || !isProvider(value.id))
        fail('provider identity');
    if (value.name !== NAMES[value.id])
        fail('provider name');
    text(value.plan, 'plan', {nullable: true, max: 80});
    if (value.accountKey !== null && (typeof value.accountKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.accountKey)))
        fail('account key');
    shape(value.capabilities, 'provider capabilities', ['limits', 'history', 'models']);
    if (['limits', 'history', 'models'].some(name => typeof value.capabilities[name] !== 'boolean'))
        fail('provider capabilities');
    for (const name of ['limits', 'history']) {
        shape(value[name], `${name} shape`, name === 'limits'
            ? ['status', 'message', 'updatedAt', 'scope', 'source', 'windows']
            : ['status', 'message', 'updatedAt', 'scope', 'source', 'period', 'days', 'models', 'scannedFiles']);
        if (!value[name] || !STATES.has(value[name].status))
            fail(`${name} state`);
        if (typeof value[name].message !== 'string' || value[name].message.length > 500 ||
            /[\u0000-\u001f\u007f]/.test(value[name].message))
            fail(`${name} message`);
        numeric(value[name].updatedAt, `${name} timestamp`, {nullable: true});
        if (READY_STATES.has(value[name].status) && (!value[name].updatedAt || value[name].updatedAt <= 0))
            fail(`${name} freshness`);
        if (!READY_STATES.has(value[name].status) && value[name].updatedAt !== null)
            fail(`${name} freshness`);
        if (value[name].source !== null)
            text(value[name].source, `${name} source`, {max: 160});
        if (READY_STATES.has(value[name].status) && value[name].source === null)
            fail(`${name} source`);
    }
    if (value.history.scannedFiles !== undefined)
        numeric(value.history.scannedFiles, 'history scanned files', {integer: true});
    if (value.limits.scope !== 'account' || !['local', 'account'].includes(value.history.scope))
        fail('source scope');
    if (!Array.isArray(value.limits.windows) || !Array.isArray(value.history.days) || !Array.isArray(value.history.models))
        fail('usage arrays');
    if (value.limits.windows.length > MAX_WINDOWS || value.history.days.length > MAX_DAYS ||
        value.history.models.length > MAX_MODELS)
        fail('collection bounds');
    if (value.limits.windows.length && !value.capabilities.limits)
        fail('limits capability');
    if (READY_STATES.has(value.limits.status) && !value.limits.windows.length)
        fail('limits readiness');
    if (value.history.days.length && !value.capabilities.history)
        fail('history capability');
    if (value.history.models.length && !value.capabilities.models)
        fail('models capability');
    const windows = new Set();
    for (const item of value.limits.windows) {
        shape(item, 'quota window', [
            'id', 'label', 'usedPercent', 'used', 'limit', 'unit', 'unlimited', 'state', 'durationMinutes', 'resetsAt',
        ]);
        text(item.id, 'quota id', {max: 160});
        text(item.label, 'quota label', {max: 160});
        text(item.unit, 'quota unit', {max: 40});
        if (typeof item.unlimited !== 'boolean' || !WINDOW_STATES.has(item.state))
            fail('quota state');
        numeric(item.usedPercent, 'quota percentage', {nullable: true});
        numeric(item.used, 'quota usage', {nullable: true});
        numeric(item.limit, 'quota limit', {nullable: true});
        numeric(item.durationMinutes, 'quota duration', {nullable: true, integer: true});
        numeric(item.resetsAt, 'quota reset', {nullable: true, integer: true});
        if (item.unlimited ? item.state !== 'unlimited' || item.usedPercent !== null : item.usedPercent === null ||
            item.state !== (item.usedPercent >= 100 ? 'exhausted' : 'active'))
            fail('quota consistency');
        if (windows.has(item.id))
            fail('duplicate quota');
        windows.add(item.id);
    }
    if (value.history.period === null) {
        if (value.history.days.length || value.history.models.length)
            fail('history period');
    } else {
        shape(value.history.period, 'history period', ['start', 'end']);
        isoDate(value.history.period?.start, 'history start date');
        isoDate(value.history.period?.end, 'history end date');
        if (value.history.period.start > value.history.period.end)
            fail('history date order');
    }
    const dates = new Set();
    let previousDate = null;
    for (const item of value.history.days) {
        shape(item, 'daily entry', ['date', 'total', 'sessions', 'events']);
        isoDate(item.date, 'daily date');
        numeric(item.total, 'daily total', {integer: true});
        numeric(item.sessions, 'daily sessions', {integer: true});
        numeric(item.events, 'daily events', {integer: true});
        if (dates.has(item.date) || (previousDate && item.date <= previousDate) ||
            item.date < value.history.period.start || item.date > value.history.period.end)
            fail('daily ordering');
        dates.add(item.date);
        previousDate = item.date;
    }
    const models = new Set();
    for (const item of value.history.models) {
        shape(item, 'model entry', ['model', 'total', 'input', 'output', 'cacheRead', 'cacheWrite']);
        text(item.model, 'model name', {max: 160});
        for (const field of ['total', 'input', 'output', 'cacheRead', 'cacheWrite'])
            numeric(item[field], `model ${field}`, {integer: true});
        if (models.has(item.model) || item.total !== item.input + item.output + item.cacheRead + item.cacheWrite)
            fail('model totals');
        models.add(item.model);
    }
    return value;
}

export function mergeRecord(previous, next, now = Date.now()) {
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

export function localDate(time) {
    if (time === null || time === undefined || time === '')
        return null;
    const d = new Date(time);
    if (!Number.isFinite(d.getTime()))
        return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function recentDates(now, count = 7) {
    const today = new Date(now);
    today.setHours(12, 0, 0, 0);
    return Array.from({length: count}, (_, i) => {
        const day = new Date(today);
        day.setDate(day.getDate() - (count - 1 - i));
        return localDate(day);
    });
}

export function aggregateEvents(events, now = Date.now(), count = 7) {
    const dates = recentDates(now, count);
    const days = new Map(dates.map(date => [date, {date, total: 0, sessions: 0, events: 0}]));
    const models = new Map();
    const seen = new Set();
    const sessions = new Map(dates.map(date => [date, new Set()]));
    for (const event of events) {
        const day = days.get(event.date);
        if (!day || seen.has(event.id))
            continue;
        seen.add(event.id);
        const tokens = ['input', 'output', 'cacheRead', 'cacheWrite'].map(k => number(event[k]) ?? 0);
        const total = tokens.reduce((a, b) => a + b, 0);
        if (!total)
            continue;
        const model = String(event.model || 'Unknown model');
        const bucket = models.get(model) ?? {model, total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0};
        ['input', 'output', 'cacheRead', 'cacheWrite'].forEach((k, i) => { bucket[k] += tokens[i]; });
        bucket.total += total;
        models.set(model, bucket);
        day.total += total;
        day.events++;
        sessions.get(event.date).add(event.session);
        day.sessions = sessions.get(event.date).size;
    }
    return {period: {start: dates[0], end: dates.at(-1)}, days: [...days.values()],
        models: [...models.values()].sort((a, b) => b.total - a.total)};
}

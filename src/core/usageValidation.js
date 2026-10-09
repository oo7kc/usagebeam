import {isIsoDate} from './dates.js';
import {PROVIDER_NAMES, isProviderId} from './providerRegistry.js';
import {USAGE_SCHEMA_VERSION} from './usage.js';

const USAGE_STATUSES = new Set(['loading', 'ready', 'partial', 'stale', 'missing-auth', 'unsupported', 'unavailable']);
const QUOTA_WINDOW_STATES = new Set(['active', 'exhausted', 'unlimited']);

const MAX_WINDOWS = 32;
const MAX_DAYS = 90;
const MAX_MODELS = 128;
const STORED_USAGE_STATUSES = new Set(['ready', 'partial', 'stale']);
function rejectUsageRecord(message) {
    throw new Error(`Invalid usage record: ${message}`);
}

function assertObjectShape(value, field, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some(key => !allowed.includes(key)))
        rejectUsageRecord(field);
}

function assertText(value, field, {nullable = false, max = 240} = {}) {
    if (nullable && value === null)
        return;
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value))
        rejectUsageRecord(field);
}

function assertNonNegativeNumber(value, field, {nullable = false, integer = false} = {}) {
    if (nullable && value === null)
        return;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value)))
        rejectUsageRecord(field);
}

function assertIsoDate(value, field) {
    if (!isIsoDate(value))
        rejectUsageRecord(field);
}

function validateRecordIdentity(value, expectedProviderId) {
    assertObjectShape(value, 'record shape', [
        'schemaVersion', 'id', 'name', 'plan', 'accountKey', 'capabilities', 'limits', 'history',
    ]);
    if (!value || value.schemaVersion !== USAGE_SCHEMA_VERSION || value.id !== expectedProviderId || !isProviderId(value.id))
        rejectUsageRecord('provider identity');
    if (value.name !== PROVIDER_NAMES[value.id])
        rejectUsageRecord('provider name');
    assertText(value.plan, 'plan', {nullable: true, max: 80});
    if (value.accountKey !== null && (typeof value.accountKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.accountKey)))
        rejectUsageRecord('account key');
    assertObjectShape(value.capabilities, 'provider capabilities', ['limits', 'history', 'models']);
    if (['limits', 'history', 'models'].some(name => typeof value.capabilities[name] !== 'boolean'))
        rejectUsageRecord('provider capabilities');
}

function validateUsageSections(value) {
    for (const name of ['limits', 'history']) {
        assertObjectShape(value[name], `${name} shape`, name === 'limits'
            ? ['status', 'message', 'updatedAt', 'scope', 'source', 'windows']
            : ['status', 'message', 'updatedAt', 'scope', 'source', 'period', 'days', 'models', 'scannedFiles']);
        if (!value[name] || !USAGE_STATUSES.has(value[name].status))
            rejectUsageRecord(`${name} state`);
        if (typeof value[name].message !== 'string' || value[name].message.length > 500 ||
            /[\u0000-\u001f\u007f]/.test(value[name].message))
            rejectUsageRecord(`${name} message`);
        assertNonNegativeNumber(value[name].updatedAt, `${name} timestamp`, {nullable: true});
        if (STORED_USAGE_STATUSES.has(value[name].status) && (!value[name].updatedAt || value[name].updatedAt <= 0))
            rejectUsageRecord(`${name} freshness`);
        if (!STORED_USAGE_STATUSES.has(value[name].status) && value[name].updatedAt !== null)
            rejectUsageRecord(`${name} freshness`);
        if (value[name].source !== null)
            assertText(value[name].source, `${name} source`, {max: 160});
        if (STORED_USAGE_STATUSES.has(value[name].status) && value[name].source === null)
            rejectUsageRecord(`${name} source`);
    }
    if (value.history.scannedFiles !== undefined)
        assertNonNegativeNumber(value.history.scannedFiles, 'history scanned files', {integer: true});
    if (value.limits.scope !== 'account' || !['local', 'account'].includes(value.history.scope))
        rejectUsageRecord('source scope');
    if (!Array.isArray(value.limits.windows) || !Array.isArray(value.history.days) || !Array.isArray(value.history.models))
        rejectUsageRecord('usage arrays');
    if (value.limits.windows.length > MAX_WINDOWS || value.history.days.length > MAX_DAYS ||
        value.history.models.length > MAX_MODELS)
        rejectUsageRecord('collection bounds');
    if (value.limits.windows.length && !value.capabilities.limits)
        rejectUsageRecord('limits capability');
    if (STORED_USAGE_STATUSES.has(value.limits.status) && !value.limits.windows.length)
        rejectUsageRecord('limits readiness');
    if (value.history.days.length && !value.capabilities.history)
        rejectUsageRecord('history capability');
    if (value.history.models.length && !value.capabilities.models)
        rejectUsageRecord('models capability');
}

function validateQuotaWindows(value) {
    const windows = new Set();
    for (const item of value.limits.windows) {
        assertObjectShape(item, 'quota window', [
            'id', 'label', 'usedPercent', 'used', 'limit', 'unit', 'unlimited', 'state', 'durationMinutes', 'resetsAt',
        ]);
        assertText(item.id, 'quota id', {max: 160});
        assertText(item.label, 'quota label', {max: 160});
        assertText(item.unit, 'quota unit', {max: 40});
        if (typeof item.unlimited !== 'boolean' || !QUOTA_WINDOW_STATES.has(item.state))
            rejectUsageRecord('quota state');
        assertNonNegativeNumber(item.usedPercent, 'quota percentage', {nullable: true});
        assertNonNegativeNumber(item.used, 'quota usage', {nullable: true});
        assertNonNegativeNumber(item.limit, 'quota limit', {nullable: true});
        assertNonNegativeNumber(item.durationMinutes, 'quota duration', {nullable: true, integer: true});
        assertNonNegativeNumber(item.resetsAt, 'quota reset', {nullable: true, integer: true});
        if (item.unlimited ? item.state !== 'unlimited' || item.usedPercent !== null : item.usedPercent === null ||
            item.state !== (item.usedPercent >= 100 ? 'exhausted' : 'active'))
            rejectUsageRecord('quota consistency');
        if (windows.has(item.id))
            rejectUsageRecord('duplicate quota');
        windows.add(item.id);
    }
}

function validateHistoryPeriod(value) {
    if (value.history.period === null) {
        if (value.history.days.length || value.history.models.length)
            rejectUsageRecord('history period');
    } else {
        assertObjectShape(value.history.period, 'history period', ['start', 'end']);
        assertIsoDate(value.history.period?.start, 'history start date');
        assertIsoDate(value.history.period?.end, 'history end date');
        if (value.history.period.start > value.history.period.end)
            rejectUsageRecord('history date order');
    }
}

function validateDailyActivity(value) {
    const dates = new Set();
    let previousDate = null;
    for (const item of value.history.days) {
        assertObjectShape(item, 'daily entry', ['date', 'total', 'sessions', 'events']);
        assertIsoDate(item.date, 'daily date');
        assertNonNegativeNumber(item.total, 'daily total', {integer: true});
        assertNonNegativeNumber(item.sessions, 'daily sessions', {integer: true});
        assertNonNegativeNumber(item.events, 'daily events', {integer: true});
        if (dates.has(item.date) || (previousDate && item.date <= previousDate) ||
            item.date < value.history.period.start || item.date > value.history.period.end)
            rejectUsageRecord('daily ordering');
        dates.add(item.date);
        previousDate = item.date;
    }
}

function validateModelActivity(value) {
    const models = new Set();
    for (const item of value.history.models) {
        assertObjectShape(item, 'model entry', ['model', 'total', 'input', 'output', 'cacheRead', 'cacheWrite']);
        assertText(item.model, 'model name', {max: 160});
        for (const field of ['total', 'input', 'output', 'cacheRead', 'cacheWrite'])
            assertNonNegativeNumber(item[field], `model ${field}`, {integer: true});
        if (models.has(item.model) || item.total !== item.input + item.output + item.cacheRead + item.cacheWrite)
            rejectUsageRecord('model totals');
        models.add(item.model);
    }
}

export function validateUsageRecord(value, expectedProviderId) {
    validateRecordIdentity(value, expectedProviderId);
    validateUsageSections(value);
    validateQuotaWindows(value);
    validateHistoryPeriod(value);
    validateDailyActivity(value);
    validateModelActivity(value);
    return value;
}

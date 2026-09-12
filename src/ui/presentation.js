import {resetCountdown, resetTime} from '../core/format.js';

const CURRENT_STATES = new Set(['ready', 'partial']);

export function providerStatus(record, refreshing = false) {
    if (CURRENT_STATES.has(record?.limits?.status))
        return 'Live';
    if (CURRENT_STATES.has(record?.history?.status))
        return 'Local';
    if (record?.limits?.status === 'stale' || record?.history?.status === 'stale')
        return 'Cached';
    return refreshing ? 'Sync' : 'Setup';
}

export function latestUpdate(record) {
    const timestamps = [record?.limits?.updatedAt, record?.history?.updatedAt]
        .filter(value => Number.isFinite(value) && value > 0);
    return timestamps.length ? Math.max(...timestamps) : null;
}

export function periodDays(period) {
    const start = Date.parse(`${period?.start ?? ''}T00:00:00Z`);
    const end = Date.parse(`${period?.end ?? ''}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
        return null;
    return Math.round((end - start) / 86400000) + 1;
}

export function historyOverview(history) {
    const days = Array.isArray(history?.days) ? history.days : [];
    const models = Array.isArray(history?.models) ? history.models : [];
    const values = days.length ? days : models;
    if (!values.length)
        return null;

    const total = values.reduce((sum, item) => sum +
        (Number.isFinite(item?.total) ? item.total : 0), 0);
    return {
        days: periodDays(history.period),
        scope: history.scope === 'account' ? 'account' : 'local',
        total,
    };
}

export function quotaName(window) {
    const source = `${window?.id ?? ''} ${window?.label ?? ''}`.toLowerCase();
    if (source.includes('five-hour') || source.includes('5 hours'))
        return '5H Session';
    if (source.includes('reserve') &&
        (source.includes('weekly') || window?.durationMinutes === 10080))
        return 'Weekly Reserve';
    return String(window?.label ?? 'Usage limit');
}

export function quotaPresentation(window, now = Date.now()) {
    if (!window)
        return null;
    if (window.unlimited)
        return {name: quotaName(window), value: 'Unlimited', reset: null};
    if (!Number.isFinite(window.usedPercent))
        return null;
    return {
        name: quotaName(window),
        value: `${Math.round(window.usedPercent)}%`,
        reset: resetTime(window.resetsAt, now),
    };
}

export function panelQuota(record, now = Date.now()) {
    if (!CURRENT_STATES.has(record?.limits?.status))
        return null;
    let window = null;
    let shortest = Infinity;
    for (const candidate of record.limits.windows) {
        if (candidate.unlimited || !Number.isFinite(candidate.usedPercent))
            continue;
        const duration = Number.isFinite(candidate.durationMinutes) &&
            candidate.durationMinutes > 0 ? candidate.durationMinutes : Infinity;
        if (!window || duration < shortest) {
            window = candidate;
            shortest = duration;
        }
    }
    if (!window)
        return null;
    return {
        percent: Math.round(window.usedPercent),
        reset: resetCountdown(window.resetsAt, now),
    };
}

export function chartBarGeometry(value, maximum, width, height, inset = 4) {
    const availableWidth = Math.max(0, width - inset * 2);
    const availableHeight = Math.max(0, height);
    const ratio = maximum > 0 && value > 0 ? Math.min(1, value / maximum) : 0;
    const barHeight = ratio && availableHeight
        ? Math.min(availableHeight, Math.max(3, Math.round(availableHeight * ratio)))
        : 0;
    return {
        x: inset,
        y: availableHeight - barHeight,
        width: availableWidth,
        height: barHeight,
    };
}

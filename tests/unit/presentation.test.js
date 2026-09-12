import test from 'node:test';
import assert from 'node:assert/strict';
import {chartBarGeometry, historyOverview, latestUpdate, panelQuota, periodDays, providerStatus,
    quotaName, quotaPresentation} from '../../src/ui/presentation.js';
import {notificationMilestones, quotaSeverity, QUOTA_THRESHOLDS} from '../../src/core/thresholds.js';

test('provider status distinguishes live, local, cached and setup data', () => {
    const value = {limits: {status: 'ready'}, history: {status: 'ready'}};
    assert.equal(providerStatus(value), 'Live');
    value.limits.status = 'unavailable';
    assert.equal(providerStatus(value), 'Local');
    value.history.status = 'stale';
    assert.equal(providerStatus(value), 'Cached');
    value.history.status = 'unsupported';
    assert.equal(providerStatus(value), 'Setup');
    assert.equal(providerStatus(value, true), 'Sync');
    assert.equal(providerStatus(null, true), 'Sync');
    value.limits.status = 'ready';
    assert.equal(providerStatus(value, true), 'Live');
});

test('presentation helpers derive bounded period and freshness labels', () => {
    assert.equal(latestUpdate({limits: {updatedAt: 10}, history: {updatedAt: 20}}), 20);
    assert.equal(latestUpdate(null), null);
    assert.equal(periodDays({start: '2026-08-31', end: '2026-09-06'}), 7);
    assert.equal(periodDays({start: 'invalid', end: '2026-09-06'}), null);
});

test('history overview summarizes daily activity without double-counting models', () => {
    const history = {
        scope: 'local',
        period: {start: '2026-08-31', end: '2026-09-06'},
        days: [{total: 10}, {total: 20}],
        models: [{total: 30}, {total: 40}],
    };
    assert.deepEqual(historyOverview(history), {days: 7, scope: 'local', total: 30});
    assert.deepEqual(historyOverview({...history, scope: 'account', days: []}),
        {days: 7, scope: 'account', total: 70});
    assert.equal(historyOverview({...history, days: [], models: []}), null);
    assert.equal(historyOverview(null), null);
});

test('quota presentation keeps names concise and reset descriptions explicit', () => {
    const now = 1_000_000;
    const reserve = {id: 'gpt-reserve:primary', label: 'Reserve · Weekly',
        durationMinutes: 10080, usedPercent: 18.2, resetsAt: now + 4 * 86400000 + 22 * 3600000};
    assert.equal(quotaName(reserve), 'Weekly Reserve');
    assert.deepEqual(quotaPresentation(reserve, now), {
        name: 'Weekly Reserve', value: '18%', reset: 'Resets in 4d 22h',
    });
    assert.equal(quotaName({id: 'five-hour', label: 'Session · 5 hours', durationMinutes: 300}),
        '5H Session');
    assert.deepEqual(quotaPresentation({id: 'credits', label: 'Credits', unlimited: true}, now), {
        name: 'Credits', value: 'Unlimited', reset: null,
    });
    assert.equal(quotaPresentation({id: 'broken', label: 'Broken'}, now), null);
    assert.equal(quotaPresentation({...reserve, resetsAt: now - 1}, now).reset,
        'Reset due · awaiting update');
    assert.equal(quotaPresentation({...reserve, resetsAt: null}, now).reset,
        'Reset time unavailable');
});

test('notification milestones follow quota semantics without duplicate levels', () => {
    assert.deepEqual(notificationMilestones(80), [80, 90, 100]);
    assert.deepEqual(notificationMilestones(90), [90, 100]);
    assert.deepEqual(notificationMilestones(95), [95, 100]);
    assert.deepEqual(notificationMilestones(NaN), [90, 100]);
});

test('panel quota prefers the shortest current quota window at every usage level', () => {
    const now = 1_000_000;
    const record = {limits: {status: 'ready', windows: [
        {id: 'weekly', usedPercent: 96, durationMinutes: 10080,
            resetsAt: now + 15 * 3600000 + 59 * 60000},
        {id: 'five-hour', usedPercent: 15, durationMinutes: 300,
            resetsAt: now + 3600000},
        {usedPercent: null, unlimited: true},
    ]}};
    assert.deepEqual(panelQuota(record, now), {percent: 15, reset: '1h 0m'});
    record.limits.windows[1].usedPercent = 100;
    assert.deepEqual(panelQuota(record, now), {percent: 100, reset: '1h 0m'});
    record.limits.windows = [
        {id: 'provider-first', usedPercent: 20},
        {id: 'provider-second', usedPercent: 90},
    ];
    assert.deepEqual(panelQuota(record, now), {percent: 20, reset: null});
    assert.equal(panelQuota({limits: {...record.limits, status: 'stale'}}, now), null);
    assert.equal(panelQuota(null, now), null);
});

test('quota severity uses explicit caution, warning and danger thresholds', () => {
    assert.deepEqual(QUOTA_THRESHOLDS, {caution: 80, warning: 90, danger: 100});
    for (const value of [null, undefined, NaN, 0, 79.9])
        assert.equal(quotaSeverity(value), null);
    assert.equal(quotaSeverity(80), 'caution');
    assert.equal(quotaSeverity(89.9), 'caution');
    assert.equal(quotaSeverity(90), 'warning');
    assert.equal(quotaSeverity(99.9), 'warning');
    assert.equal(quotaSeverity(100), 'danger');
    assert.equal(quotaSeverity(125), 'danger');
});

test('chart geometry gives every non-zero day visible width and bottom alignment', () => {
    assert.deepEqual(chartBarGeometry(70, 70, 50, 64), {x: 4, y: 0, width: 42, height: 64});
    assert.deepEqual(chartBarGeometry(21.7, 70, 50, 64), {x: 4, y: 44, width: 42, height: 20});
    assert.deepEqual(chartBarGeometry(0, 70, 50, 64), {x: 4, y: 64, width: 42, height: 0});
});

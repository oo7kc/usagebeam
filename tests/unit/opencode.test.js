import assert from 'node:assert/strict';
import test from 'node:test';
import {aggregateEvents} from '../../src/core/activity.js';
import {collectionNeedsBackoff, createUsageRecord, mergeUsageRecords} from '../../src/core/usage.js';
import {validateUsageRecord} from '../../src/core/usageValidation.js';
import {collectOpenCode} from '../../src/providers/opencode.js';
import {getPanelQuota, getProviderStatus} from '../../src/ui/presentation.js';

test('OpenCode local activity never becomes an account quota or requires credentials', async () => {
    const history = {...createUsageRecord('opencode').history, ...aggregateEvents([]),
        status: 'ready', message: '', source: 'OpenCode local activity', updatedAt: Date.now()};
    const result = await collectOpenCode({openCodeHistory: async () => history});
    assert.equal(validateUsageRecord(result, 'opencode'), result);
    assert.deepEqual(result.capabilities, {limits: false, history: true, models: true});
    assert.equal(result.limits.status, 'unsupported');
    assert.equal(result.accountKey, null);
    assert.equal(getPanelQuota(result), null);
    assert.equal(getProviderStatus(result), 'Local');
    assert.equal(collectionNeedsBackoff(result), false);
});

test('OpenCode history failures remain explicit instead of appearing as zero usage', async () => {
    const history = {...createUsageRecord('opencode').history, status: 'unavailable', message: 'Database is busy.'};
    const result = await collectOpenCode({openCodeHistory: async () => history});
    assert.equal(validateUsageRecord(result, 'opencode'), result);
    assert.deepEqual(result.history.days, []);
    assert.equal(result.history.status, 'unavailable');
    assert.equal(getProviderStatus(result), 'Setup');
    assert.equal(collectionNeedsBackoff(result), true);
});

test('temporary collection failures preserve OpenCode activity and its capabilities', async () => {
    const history = {...createUsageRecord('opencode').history, ...aggregateEvents([]),
        status: 'ready', message: '', source: 'OpenCode local activity', updatedAt: Date.now()};
    const previous = await collectOpenCode({openCodeHistory: async () => history});
    const failure = createUsageRecord('opencode');
    failure.history.status = 'unavailable';
    const merged = mergeUsageRecords(previous, failure);
    assert.equal(validateUsageRecord(merged, 'opencode'), merged);
    assert.equal(merged.history.status, 'stale');
    assert.equal(merged.capabilities.history, true);
    assert.equal(merged.capabilities.models, true);
});

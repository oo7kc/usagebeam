import test from 'node:test';
import assert from 'node:assert/strict';
import {collectOpenCode} from '../../src/providers/opencode.js';
import {aggregateEvents, collectionNeedsBackoff, mergeRecord, record, validateRecord} from '../../src/core/usage.js';
import {panelQuota, providerStatus} from '../../src/ui/presentation.js';

test('OpenCode local activity never becomes an account quota or requires credentials', async () => {
    const history = {...record('opencode').history, ...aggregateEvents([]),
        status: 'ready', message: '', source: 'OpenCode local activity', updatedAt: Date.now()};
    const result = await collectOpenCode({openCodeHistory: async () => history});
    assert.equal(validateRecord(result, 'opencode'), result);
    assert.deepEqual(result.capabilities, {limits: false, history: true, models: true});
    assert.equal(result.limits.status, 'unsupported');
    assert.equal(result.accountKey, null);
    assert.equal(panelQuota(result), null);
    assert.equal(providerStatus(result), 'Local');
    assert.equal(collectionNeedsBackoff(result), false);
});

test('OpenCode history failures remain explicit instead of appearing as zero usage', async () => {
    const history = {...record('opencode').history, status: 'unavailable', message: 'Database is busy.'};
    const result = await collectOpenCode({openCodeHistory: async () => history});
    assert.equal(validateRecord(result, 'opencode'), result);
    assert.deepEqual(result.history.days, []);
    assert.equal(result.history.status, 'unavailable');
    assert.equal(providerStatus(result), 'Setup');
    assert.equal(collectionNeedsBackoff(result), true);
});

test('temporary collection failures preserve OpenCode activity and its capabilities', async () => {
    const history = {...record('opencode').history, ...aggregateEvents([]),
        status: 'ready', message: '', source: 'OpenCode local activity', updatedAt: Date.now()};
    const previous = await collectOpenCode({openCodeHistory: async () => history});
    const failure = record('opencode');
    failure.history.status = 'unavailable';
    const merged = mergeRecord(previous, failure);
    assert.equal(validateRecord(merged, 'opencode'), merged);
    assert.equal(merged.history.status, 'stale');
    assert.equal(merged.capabilities.history, true);
    assert.equal(merged.capabilities.models, true);
});

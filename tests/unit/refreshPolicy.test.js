import assert from 'node:assert/strict';
import test from 'node:test';
import {getRefreshDelayMs} from '../../src/core/refreshPolicy.js';

test('automatic retry backoff grows per failure and stops at one hour', () => {
    assert.equal(getRefreshDelayMs(120, 0), 120000);
    assert.equal(getRefreshDelayMs(120, 1), 240000);
    assert.equal(getRefreshDelayMs(120, 4), 1920000);
    assert.equal(getRefreshDelayMs(3600, 4), 3600000);
});

test('manual refresh keeps its cooldown independently of automatic backoff', () => {
    for (const failures of [0, 1, 4])
        assert.equal(getRefreshDelayMs(3600, failures, true), 2000);
});

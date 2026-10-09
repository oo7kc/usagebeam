import assert from 'node:assert/strict';
import test from 'node:test';
import {parseSafeInteger, sanitizeText} from '../../src/core/values.js';
import {isIsoDate} from '../../src/core/dates.js';

test('provider text is trimmed and bounded without accepting control characters', () => {
    assert.equal(sanitizeText('  Pro  '), 'Pro');
    assert.equal(sanitizeText('a'.repeat(100)), 'a'.repeat(80));
    assert.equal(sanitizeText('bad\nvalue', 'Unknown'), 'Unknown');
    assert.equal(sanitizeText(null), null);
    assert.equal(sanitizeText('a'.repeat(200), null, 160), 'a'.repeat(160));
});

test('cached counters reject fractional, unsafe, and coercible values', () => {
    for (const value of [false, '1', 1.5, -1, Infinity, Number.MAX_SAFE_INTEGER + 1])
        assert.equal(parseSafeInteger(value), null);
    assert.equal(parseSafeInteger(0), 0);
    assert.equal(parseSafeInteger(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});

test('ISO dates reject calendar rollover and malformed representations', () => {
    assert.equal(isIsoDate('2024-02-29'), true);
    for (const value of ['2026-02-29', '2026-04-31', '2026-1-01', '', null])
        assert.equal(isIsoDate(value), false);
});

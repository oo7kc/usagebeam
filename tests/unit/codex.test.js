import assert from 'node:assert/strict';
import test from 'node:test';
import {
    codexOversizedRecordMayAffectUsage,
    collectCodex,
    parseCodexEvent,
    parseCodexLimits,
} from '../../src/providers/codex.js';

const tokenEvent = (input, output, cache, total) => ({timestamp: '2026-09-06T12:00:00Z', type: 'event_msg', payload: {type: 'token_count',
    info: {total_token_usage: {input_tokens: input, output_tokens: output, cached_input_tokens: cache, total_tokens: total}}}});

test('reads all quota buckets and derives labels from real window durations', () => {
    const result = parseCodexLimits({rateLimitsByLimitId: {codex: {primary: {usedPercent: 10, windowDurationMins: 300, resetsAt: 1800000000},
        secondary: {usedPercent: 100, windowDurationMins: 10080}}}}, 100);
    assert.equal(result.windows.length, 2);
    assert.equal(result.windows[0].resetsAt, 1800000000000);
    assert.equal(result.windows[0].durationMinutes, 300);
    assert.equal(result.windows[1].label, 'Weekly');
    assert.equal(result.windows[1].usedPercent, 100);
    assert.equal(result.status, 'ready');
});

test('empty Codex response is unavailable, not zero usage', () => {
    assert.equal(parseCodexLimits({}).status, 'unavailable');
    assert.equal(parseCodexLimits({rateLimits: {primary: {}}}).windows.length, 0);
});

test('cumulative token deltas and cached input are counted once', () => {
    const state = {session: 'session-1', model: 'model-a'};
    const first = parseCodexEvent(tokenEvent(100, 20, 40, 120), state);
    assert.equal(first.input, 60);
    assert.equal(first.cacheRead, 40);
    assert.equal(parseCodexEvent(tokenEvent(100, 20, 40, 120), state), null);
    const second = parseCodexEvent(tokenEvent(180, 35, 60, 215), state);
    assert.equal(second.input + second.output + second.cacheRead, 95);
    const reset = parseCodexEvent(tokenEvent(20, 5, 8, 25), state);
    assert.equal(reset.input + reset.output + reset.cacheRead, 25);
    assert.equal(state.cumulativeEpoch, 1);
    assert.deepEqual(Object.keys(state.cumulative).sort(), [
        'cache_write_input_tokens', 'cached_input_tokens', 'input_tokens', 'output_tokens', 'total_tokens',
    ]);
});

test('multi-bucket response falls back to the compatible quota view when empty', () => {
    const result = parseCodexLimits({rateLimitsByLimitId: {}, rateLimits: {
        primary: {usedPercent: 12, windowDurationMins: 300},
    }}, 100);
    assert.equal(result.status, 'ready');
    assert.equal(result.windows[0].label, 'Session · 5 hours');
});

test('primary Codex limits remain first when the app server reorders buckets', () => {
    const result = parseCodexLimits({rateLimitsByLimitId: {
        reserve: {limitName: 'Reserve', primary: {usedPercent: 1, windowDurationMins: 10080}},
        codex: {primary: {usedPercent: 2, windowDurationMins: 300}},
    }});
    assert.equal(result.windows[0].id, 'codex:primary');
    assert.equal(result.windows[1].label, 'Reserve · Weekly');
});

test('record parsing tracks model and stable session identity', () => {
    const state = {session: 'file-hash'};
    parseCodexEvent({type: 'session_meta', payload: {id: 'native-session'}}, state);
    parseCodexEvent({type: 'turn_context', payload: {model: 'model-b'}}, state);
    const event = parseCodexEvent(tokenEvent(10, 2, 0, 12), state);
    assert.equal(event.model, 'model-b');
    assert.equal(event.session, 'native-session');
});

test('oversized Codex records are ignored only when their top-level type is known to carry no usage', () => {
    const bytes = value => new TextEncoder().encode(value);
    assert.equal(codexOversizedRecordMayAffectUsage(bytes(
        '{"type":"compacted","payload":{"message":"summary"}}')), false);
    assert.equal(codexOversizedRecordMayAffectUsage(bytes(
        '{"timestamp":"2026-09-06T12:00:00Z","type":"response_item","payload":{}}')), false);
    assert.equal(codexOversizedRecordMayAffectUsage(bytes(
        '{"payload":{"type":"compacted"},"type":"event_msg"}')), true);
    assert.equal(codexOversizedRecordMayAffectUsage(bytes(
        '{"items":[{"type":"compacted"}],"type":"event_msg"}')), true);
    assert.equal(codexOversizedRecordMayAffectUsage(bytes('{"type":')), true);
    assert.equal(codexOversizedRecordMayAffectUsage('not bytes'), true);
});

test('local history survives missing account authentication and closes RPC', async () => {
    let closed = false;
    const history = {status: 'ready', days: [], models: []};
    const result = await collectCodex({scan: () => history,
        codexClient: () => ({request: async method => method === 'account/read' ? {account: null} : {},
            notify: () => {}, close: () => { closed = true; }})});
    assert.equal(result.limits.status, 'missing-auth');
    assert.equal(result.history, history);
    assert.equal(closed, true);
});

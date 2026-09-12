import {localDate, number, record, section, windowUsage} from '../core/usage.js';

const MAX_WINDOWS = 32;

function jsonStringEnd(text, start) {
    let escaped = false;
    for (let index = start + 1; index < text.length; index++) {
        if (escaped) {
            escaped = false;
        } else if (text[index] === '\\') {
            escaped = true;
        } else if (text[index] === '"') {
            return index;
        }
    }
    return -1;
}

function topLevelString(text, property) {
    const stack = [];
    let expectsKey = false;
    for (let index = 0; index < text.length; index++) {
        const character = text[index];
        if (character === '"') {
            const end = jsonStringEnd(text, index);
            if (end < 0)
                return null;
            if (stack.length === 1 && stack[0] === '{' && expectsKey) {
                let key;
                try { key = JSON.parse(text.slice(index, end + 1)); } catch { return null; }
                let cursor = end + 1;
                while (/\s/.test(text[cursor] ?? ''))
                    cursor++;
                if (text[cursor] !== ':')
                    return null;
                cursor++;
                while (/\s/.test(text[cursor] ?? ''))
                    cursor++;
                if (key === property) {
                    if (text[cursor] !== '"')
                        return null;
                    const valueEnd = jsonStringEnd(text, cursor);
                    if (valueEnd < 0)
                        return null;
                    try { return JSON.parse(text.slice(cursor, valueEnd + 1)); } catch { return null; }
                }
                expectsKey = false;
            }
            index = end;
        } else if (character === '{' || character === '[') {
            stack.push(character);
            if (stack.length === 1 && character === '{')
                expectsKey = true;
        } else if (character === '}' || character === ']') {
            const expected = character === '}' ? '{' : '[';
            if (stack.at(-1) !== expected)
                return null;
            stack.pop();
            if (!stack.length)
                return null;
        } else if (stack.length === 1 && stack[0] === '{' && character === ',') {
            expectsKey = true;
        }
    }
    return null;
}

export function codexOversizedRecordMayAffectUsage(prefix) {
    if (!(prefix instanceof Uint8Array))
        return true;
    const type = topLevelString(new TextDecoder().decode(prefix), 'type');
    return type !== 'compacted' && type !== 'response_item';
}

function shortText(value, fallback = null, max = 80) {
    if (typeof value !== 'string')
        return fallback;
    const text = value.trim();
    return text && !/[\u0000-\u001f\u007f]/.test(text) ? text.slice(0, max) : fallback;
}

function compareBuckets([left], [right]) {
    if (left === 'codex')
        return -1;
    if (right === 'codex')
        return 1;
    return left.localeCompare(right);
}

export function codexLimits(response, now = Date.now()) {
    const scoped = response?.rateLimitsByLimitId && typeof response.rateLimitsByLimitId === 'object' &&
        !Array.isArray(response.rateLimitsByLimitId)
        ? Object.entries(response.rateLimitsByLimitId).sort(compareBuckets)
        : [];
    const buckets = scoped.length ? scoped : [['codex', response?.rateLimits]];
    const windows = [];
    let truncated = false;
    for (const [bucketId, bucket] of buckets) {
        if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket))
            continue;
        for (const key of ['primary', 'secondary']) {
            if (windows.length >= MAX_WINDOWS) {
                truncated = true;
                break;
            }
            const w = bucket?.[key];
            if (!w || typeof w !== 'object' || Array.isArray(w))
                continue;
            const reportedMinutes = number(w.windowDurationMins);
            const mins = Number.isSafeInteger(reportedMinutes) ? reportedMinutes : null;
            const duration = mins === 10080 ? 'Weekly' : mins === 300 ? 'Session · 5 hours'
                : mins ? `${mins >= 60 ? `${mins / 60} hours` : `${mins} minutes`}` : key === 'primary' ? 'Primary window' : 'Secondary window';
            const safeBucketId = shortText(bucketId, 'quota', 120);
            const bucketName = shortText(bucket.limitName,
                safeBucketId === 'codex' ? null : safeBucketId, 120);
            const item = windowUsage({id: `${safeBucketId}:${key}`,
                label: buckets.length > 1 && bucketName ? `${bucketName} · ${duration}` : duration,
                usedPercent: w.usedPercent, durationMinutes: mins,
                resetsAt: w.resetsAt});
            if (item)
                windows.push(item);
        }
        if (truncated)
            break;
    }
    return windows.length
        ? {...section(truncated ? 'partial' : 'ready',
            truncated ? 'Some Codex quota windows were omitted to keep the response bounded.' : ''),
        updatedAt: now, scope: 'account', source: 'Codex app-server', windows}
        : {...section('unavailable', 'Codex did not report quota windows for this account.'),
        scope: 'account', source: 'Codex app-server', windows: []};
}

export function parseCodexEvent(entry, state) {
    if (entry?.type === 'session_meta')
        state.session = entry.payload?.id || state.session;
    if (entry?.type === 'turn_context')
        state.model = entry.payload?.model || entry.payload?.model_slug || state.model;
    const payload = entry?.payload;
    if (payload?.type !== 'token_count' || !payload.info)
        return null;
    const cumulative = payload.info.total_token_usage;
    let usage = payload.info.last_token_usage;
    let identity;
    if (cumulative && number(cumulative.total_tokens) !== null) {
        const fields = ['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_input_tokens'];
        const current = Object.fromEntries(fields.map(field => [field, number(cumulative[field]) ?? 0]));
        current.total_tokens = Number(cumulative.total_tokens);
        if (state.cumulative && current.total_tokens === state.cumulative.total_tokens)
            return null;
        if (state.cumulative && current.total_tokens < state.cumulative.total_tokens) {
            state.cumulativeEpoch = (number(state.cumulativeEpoch) ?? 0) + 1;
            usage = current;
        } else {
            const previous = state.cumulative ?? {};
            usage = Object.fromEntries(fields.map(field =>
                [field, Math.max(0, current[field] - (number(previous[field]) ?? 0))]));
        }
        state.cumulative = current;
        identity = `total:${state.cumulativeEpoch ?? 0}:${current.total_tokens}`;
    } else {
        identity = `${entry.timestamp}:${JSON.stringify(usage)}`;
    }
    if (!usage || !localDate(entry.timestamp))
        return null;
    const input = number(usage.input_tokens) ?? 0;
    const cacheRead = Math.min(input, number(usage.cached_input_tokens) ?? 0);
    const cacheWrite = Math.min(input - cacheRead, number(usage.cache_write_input_tokens) ?? 0);
    return {id: `${state.session}:${identity}`, session: state.session, date: localDate(entry.timestamp),
        model: state.model || 'Unknown model', input: input - cacheRead - cacheWrite,
        output: number(usage.output_tokens) ?? 0, cacheRead, cacheWrite};
}

export async function collectCodex(io) {
    const now = io.now?.() ?? Date.now();
    const result = record('codex');
    result.capabilities = {limits: true, history: true, models: true};
    result.history = io.scan('codex', ['sessions', 'archived_sessions'], parseCodexEvent,
        {oversizedRecordMayAffectUsage: codexOversizedRecordMayAffectUsage});
    let rpc;
    try {
        rpc = io.codexClient();
        await rpc.request('initialize', {clientInfo: {name: 'usagebeam', title: 'UsageBeam', version: '2.0.0'},
            capabilities: {experimentalApi: false}});
        rpc.notify('initialized', {});
        const account = await rpc.request('account/read', {refreshToken: false});
        if (!account?.account) {
            result.limits = {...result.limits, ...section('missing-auth', 'Sign in with codex login to read account limits.')};
            return result;
        }
        result.plan = shortText(account.account.planType ?? account.account.type);
        const accountIdentity = shortText(account.account.email ?? account.account.chatgptAccountId, null, 320);
        result.accountKey = accountIdentity ? io.fingerprint(accountIdentity) : null;
        const limits = await rpc.request('account/rateLimits/read', {});
        result.limits = codexLimits(limits, now);
        const scopedLimits = limits?.rateLimitsByLimitId && typeof limits.rateLimitsByLimitId === 'object' &&
            !Array.isArray(limits.rateLimitsByLimitId) ? Object.values(limits.rateLimitsByLimitId) : [];
        result.plan = shortText(limits?.rateLimits?.planType ??
            scopedLimits.find(bucket => bucket?.planType)?.planType, result.plan);
    } catch (error) {
        result.limits = {...result.limits, ...section(error.code === 'NOT_FOUND' ? 'unsupported' : 'unavailable',
            error.code === 'NOT_FOUND' ? 'Install the Codex CLI to read account limits.' : 'Could not read Codex limits. Check CLI sign-in and compatibility.')};
    } finally {
        rpc?.close();
    }
    return result;
}

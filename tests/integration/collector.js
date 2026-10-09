import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import {createQuotaWindow, createUsageRecord} from '../../src/core/usage.js';
import {loadProviderSnapshot, saveProviderSnapshot} from '../../src/services/snapshotStore.js';
import {parseClaudeEvent} from '../../src/providers/claude.js';
import {parseCodexEvent} from '../../src/providers/codex.js';
import {createCommandSpec, findCommand} from '../../src/services/commands.js';
import {buildPath, clearDerivedData, migrateLegacyData, readJson, writeJson} from '../../src/services/files.js';
import {scanJsonlHistory} from '../../src/services/history.js';
import {requestJson} from '../../src/services/http.js';
import {copyLegacySettings, migrateProviderOrder} from '../../src/services/migration.js';
import {runCommand} from '../../src/services/process.js';
import {RpcClient} from '../../src/services/rpcClient.js';
import {UsageService} from '../../src/services/usageService.js';

function assert(value, message) {
    if (!value)
        throw new Error(message);
}
const scratch = GLib.dir_make_tmp('usagebeam-integration-XXXXXX');
const sessions = buildPath(scratch, 'sessions');
GLib.mkdir_with_parents(sessions, 0o700);
const fixture = buildPath(sessions, 'synthetic.jsonl');
const cachePath = buildPath(scratch, 'cache.json');
const now = new Date('2026-09-06T12:00:00').getTime();
const event = total => JSON.stringify({type: 'event_msg', timestamp: '2026-09-06T10:00:00Z', payload: {type: 'token_count',
    info: {total_token_usage: {input_tokens: total, output_tokens: 0, cached_input_tokens: 0, total_tokens: total}}}});
const text = `${JSON.stringify({type: 'session_meta', payload: {id: 'synthetic'}})}\n${event(100)}\n`;
GLib.file_set_contents(fixture, text);
const first = scanJsonlHistory('codex', [sessions], parseCodexEvent, {now, cachePath});
assert(first.days.at(-1).total === 100, 'initial scan');
const second = scanJsonlHistory('codex', [sessions], parseCodexEvent, {now, cachePath});
assert(second.scannedFiles === 0 && second.days.at(-1).total === 100, 'unchanged file must reuse cache');
GLib.file_set_contents(fixture, `${text}${event(180)}\n{"partial":`);
const third = scanJsonlHistory('codex', [sessions], parseCodexEvent, {now, cachePath});
assert(third.days.at(-1).total === 180, 'append must count delta only');
const cache = readJson(cachePath);
assert(cache.version === 6, 'versioned cache');
assert(!JSON.stringify(cache).includes('synthetic'), 'session identity must be sanitized in cache');
assert(third.days.at(-1).sessions === 1, 'resumed scans must retain one stable private session identity');
const privateDirectory = buildPath(scratch, 'private-state');
GLib.mkdir_with_parents(privateDirectory, 0o755);
GLib.chmod(privateDirectory, 0o755);
const privateRecord = buildPath(privateDirectory, 'record.json');
writeJson(privateRecord, {safe: true});
assert(readJson(privateRecord).safe, 'atomic JSON roundtrip');
const directoryInfo = Gio.File.new_for_path(privateDirectory).query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null);
assert((directoryInfo.get_attribute_uint32('unix::mode') & 0o777) === 0o700, 'private JSON directory mode');
const stateInfo = Gio.File.new_for_path(privateRecord).query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null);
assert((stateInfo.get_attribute_uint32('unix::mode') & 0o777) === 0o600, 'private JSON file mode');
print('PASS: GJS history initial scan, cached scan, append, partial line, and private JSON cache');

const snapshotDirectory = buildPath(scratch, 'snapshots');
const snapshot = createUsageRecord('codex');
snapshot.capabilities.limits = true;
snapshot.limits = {...snapshot.limits, status: 'ready', updatedAt: now, source: 'Synthetic account limits',
    windows: [createQuotaWindow({id: 'weekly', label: 'Weekly', usedPercent: 25, resetsAt: now + 60000})]};
assert(saveProviderSnapshot(snapshot, snapshotDirectory), 'snapshot persistence must succeed in a private directory');
const restoredSnapshot = loadProviderSnapshot('codex', snapshotDirectory);
assert(restoredSnapshot.limits.status === 'stale' && restoredSnapshot.limits.updatedAt === now &&
    restoredSnapshot.limits.windows[0].usedPercent === 25,
    'snapshot restore must retain usage and freshness while marking saved data stale');
writeJson(buildPath(snapshotDirectory, 'codex.json'), {rawResponse: 'REJECTED_SYNTHETIC_FIELD'});
assert(loadProviderSnapshot('codex', snapshotDirectory).limits.status === 'loading',
    'invalid snapshots must produce an empty contract instead of exposing unknown fields');
assert(!saveProviderSnapshot(snapshot, privateRecord),
    'snapshot persistence failures must remain independent from live usage');
print('PASS: GJS snapshot validation, stale restoration, and persistence failure isolation');

const legacyState = buildPath(scratch, 'legacy-state');
const legacyCache = buildPath(scratch, 'legacy-cache');
const migratedState = buildPath(scratch, 'usagebeam-state');
const migratedCache = buildPath(scratch, 'usagebeam-cache');
writeJson(buildPath(legacyState, 'codex.json'), {provider: 'codex'});
writeJson(buildPath(legacyCache, 'history-codex.json'), {version: 4});
writeJson(buildPath(legacyState, 'unrelated.json'), {private: true});
assert(migrateLegacyData({legacyState, legacyCache, state: migratedState, cache: migratedCache}) === 2,
    'legacy migration must copy only recognized derived data');
assert(readJson(buildPath(migratedState, 'codex.json')).provider === 'codex', 'provider state migration');
assert(readJson(buildPath(migratedCache, 'history-codex.json')).version === 4, 'history cache migration');
assert(!Gio.File.new_for_path(buildPath(migratedState, 'unrelated.json')).query_exists(null),
    'legacy migration must ignore unrelated files');
assert(migrateLegacyData({legacyState, legacyCache, state: migratedState, cache: migratedCache}) === 0,
    'legacy migration must not overwrite migrated data');
print('PASS: GJS legacy derived-data migration');

const clearState = buildPath(scratch, 'clear-state');
const clearCache = buildPath(scratch, 'clear-cache');
writeJson(buildPath(clearState, 'codex.json'), {provider: 'codex'});
writeJson(buildPath(clearCache, 'unrelated.json'), {preserve: true});
GLib.mkdir_with_parents(buildPath(clearState, 'claude.json'), 0o700);
Gio.File.new_for_path(buildPath(clearCache, 'history-claude.json'))
    .make_symbolic_link(buildPath(clearCache, 'unrelated.json'), null);
assert(clearDerivedData({state: clearState, cache: clearCache}) === 2,
    'clear data must remove only recognized regular files and links');
assert(!Gio.File.new_for_path(buildPath(clearState, 'codex.json')).query_exists(null),
    'clear data must remove provider state');
assert(!Gio.File.new_for_path(buildPath(clearCache, 'history-claude.json'))
    .query_exists(null), 'clear data must unlink recognized cache links');
assert(Gio.File.new_for_path(buildPath(clearState, 'claude.json')).query_exists(null) &&
    readJson(buildPath(clearCache, 'unrelated.json')).preserve,
    'clear data must retain directories and unrelated files');
print('PASS: GJS safe derived-data clearing');

const currentSettings = new Map([['default-provider', 'claude']]);
const formerSettings = new Map([['default-provider', 'codex'], ['refresh-interval', 30]]);
const fakeSettings = values => ({
    get_user_value: key => values.get(key) ?? null,
    set_value(key, value) { values.set(key, value); return true; },
});
assert(copyLegacySettings(fakeSettings(currentSettings), fakeSettings(formerSettings)) === 1,
    'settings migration must copy only missing explicit values');
assert(currentSettings.get('default-provider') === 'claude' && currentSettings.get('refresh-interval') === 30,
    'settings migration must preserve UsageBeam values');
print('PASS: GJS legacy settings migration policy');

const providerSettings = new Map([['enabled-providers', {
    deepUnpack: () => ['claude', 'codex'],
}]]);
const orderSettings = {
    get_user_value: key => providerSettings.get(key) ?? null,
    set_strv(key, value) { providerSettings.set(key, [...value]); },
};
assert(migrateProviderOrder(orderSettings), 'provider order migration must preserve an explicit legacy order');
assert(JSON.stringify(providerSettings.get('provider-order')) === '["claude","codex","opencode"]',
    'provider order migration must retain the existing provider sequence');
assert(!migrateProviderOrder(orderSettings), 'provider order migration must not overwrite an explicit value');
print('PASS: GJS provider order migration');

let cancelledJob = false;
let changedRecords = 0;
let forcedRefresh = null;
const previousThresholds = {};
const service = Object.assign(Object.create(UsageService.prototype), {
    _destroyed: false,
    _enabledProviderIds: ['claude', 'codex'],
    _pendingCollections: new Map([['codex', {cancel: () => { cancelledJob = true; }}]]),
    _lastAttemptAt: new Map([['codex', 1]]),
    _failureCounts: new Map([['codex', 2]]),
    _thresholdTracker: previousThresholds,
    _recordsByProvider: {codex: {saved: true}},
    _emitChanged: () => { changedRecords++; },
    refreshAll: force => { forcedRefresh = force; },
});
service.clearSavedData();
assert(cancelledJob && !service._pendingCollections.size && !service._lastAttemptAt.size && !service._failureCounts.size,
    'clear data must cancel in-flight work and reset scheduler state');
assert(Object.keys(service._recordsByProvider).join(',') === 'claude,codex' &&
    Object.values(service._recordsByProvider).every(value => value.schemaVersion === 2),
    'clear data must replace saved records with clean provider contracts');
assert(service._thresholdTracker !== previousThresholds && changedRecords === 1 && forcedRefresh,
    'clear data must reset alerts, update the panel and rebuild provider data');
print('PASS: GJS in-memory usage clearing');

const replacementRoot = buildPath(scratch, 'replacement');
GLib.mkdir_with_parents(replacementRoot, 0o700);
const replacement = buildPath(replacementRoot, 'same-size.jsonl');
const replacementCache = buildPath(scratch, 'replacement-cache.json');
GLib.file_set_contents(replacement, `${event(100)}\n`);
assert(scanJsonlHistory('codex', [replacementRoot], parseCodexEvent, {now, cachePath: replacementCache})
    .days.at(-1).total === 100, 'same-size baseline');
GLib.usleep(2000);
GLib.file_set_contents(replacement, `${event(200)}\n`);
assert(scanJsonlHistory('codex', [replacementRoot], parseCodexEvent, {now, cachePath: replacementCache})
    .days.at(-1).total === 200, 'same-size replacement must invalidate the cache');
Gio.File.new_for_path(replacement).delete(null);
const saved = scanJsonlHistory('codex', [replacementRoot], parseCodexEvent, {now: now + 1000, cachePath: replacementCache});
assert(saved.status === 'stale' && saved.days.at(-1).total === 200, 'missing source must retain recent cached history');
print('PASS: GJS history replacement detection and stale-source recovery');

const claudeProjects = buildPath(scratch, 'claude-projects');
GLib.mkdir_with_parents(claudeProjects, 0o700);
const claudeLine = JSON.stringify({type: 'assistant', sessionId: 'claude-session', timestamp: '2026-09-06T11:00:00Z',
    message: {id: 'claude-message', role: 'assistant', model: 'claude-test', usage: {input_tokens: 2,
        output_tokens: 3, cache_read_input_tokens: 40, cache_creation_input_tokens: 5}}});
GLib.file_set_contents(buildPath(claudeProjects, 'session.jsonl'), `${claudeLine}\n${claudeLine}\n`);
const claudeCache = buildPath(scratch, 'claude-cache.json');
const claude = scanJsonlHistory('claude', [claudeProjects], parseClaudeEvent, {now, cachePath: claudeCache});
assert(claude.days.at(-1).total === 50, 'duplicate Claude messages must count once');
assert(claude.models[0].cacheRead === 40 && claude.models[0].cacheWrite === 5, 'Claude cache categories');
assert(!JSON.stringify(readJson(claudeCache)).includes('claude-session'), 'Claude session identity must be sanitized');
print('PASS: GJS Claude history deduplication, model totals, and private cache');

for (const version of ['v20.12.0', 'v24.16.0']) {
    const bin = buildPath(scratch, '.local', 'share', 'fnm', 'node-versions', version, 'installation', 'bin');
    GLib.mkdir_with_parents(bin, 0o700);
    const command = buildPath(bin, 'fixture-cli');
    GLib.file_set_contents(command, '#!/usr/bin/env fixture-runtime\n');
    GLib.chmod(command, 0o700);
    const runtime = buildPath(bin, 'fixture-runtime');
    GLib.file_set_contents(runtime, `#!/bin/sh\nprintf '${version}'\n`);
    GLib.chmod(runtime, 0o700);
}
assert(findCommand('fixture-cli', {home: scratch, usePath: false}).includes('v24.16.0'),
    'version-manager lookup must choose the newest installed runtime');
let invalidName = false;
try {
    findCommand('..');
} catch {
    invalidName = true;
}
assert(invalidName, 'command discovery must reject path-like command names');
const fixtureSpec = createCommandSpec('fixture-cli', ['status'], {home: scratch, usePath: false});
assert(fixtureSpec.argv[0].endsWith('/fixture-cli') && fixtureSpec.argv[1] === 'status',
    'version-managed command must retain its native entry point');
assert(fixtureSpec.environment.PATH.split(':')[0].endsWith('/v24.16.0/installation/bin'),
    'version-managed command directory must lead the child search path');
const npmBin = buildPath(scratch, '.npm-global', 'bin');
GLib.mkdir_with_parents(npmBin, 0o700);
const runtimeCli = buildPath(npmBin, 'runtime-cli');
GLib.file_set_contents(runtimeCli, '#!/usr/bin/env fixture-runtime\n');
GLib.chmod(runtimeCli, 0o700);
const runtimeSpec = createCommandSpec('runtime-cli', [],
    {home: scratch, usePath: false, runtimes: ['fixture-runtime']});
assert(runtimeSpec.environment.PATH.includes('/v24.16.0/installation/bin'),
    'user-local commands must receive a discovered runtime path');
print('PASS: GJS version-manager command discovery');

const loop = new GLib.MainLoop(null, false);
let failed = false;
(async () => {
    try {
        assert((await runCommand(['/bin/echo', 'fixture'])).trim() === 'fixture', 'subprocess output');
        assert((await runCommand(fixtureSpec)).trim() === 'v24.16.0',
            'command environment must resolve its sibling runtime');
        assert((await runCommand(runtimeSpec)).trim() === 'v24.16.0',
            'user-local command environment must resolve a version-managed runtime');
        let invalidEnvironment = false;
        try {
            await runCommand({argv: ['/bin/echo', 'fixture'], environment: {PATH: 10}});
        } catch (error) {
            invalidEnvironment = error.code === 'INVALID_COMMAND';
        }
        assert(invalidEnvironment, 'subprocess environments must contain only strings');
        let timedOut = false;
        try {
            await runCommand(['/bin/sleep', '5'], {timeout: 50});
        } catch (error) {
            timedOut = error.code === 'TIMED_OUT';
        }
        assert(timedOut, 'subprocess timeout');
        let limited = false;
        try {
            await runCommand(['/bin/echo', 'too-large'], {maxOutputBytes: 3});
        } catch (error) {
            limited = error.code === 'OUTPUT_LIMIT';
        }
        assert(limited, 'subprocess output limit');
        const cancelled = new Gio.Cancellable();
        cancelled.cancel();
        let cancellationReported = false;
        try {
            await runCommand(['/bin/sleep', '5'], {cancellable: cancelled});
        } catch (error) {
            cancellationReported = error.code === 'CANCELLED';
        }
        assert(cancellationReported, 'pre-cancelled subprocess must report cancellation');
        const rpc = new RpcClient(['/bin/cat'], cancelled);
        assert(rpc.isClosed, 'pre-cancelled RPC client must close during construction');
        rpc.close();
        let insecureEndpoint = false;
        try {
            await requestJson('http://example.invalid');
        } catch (error) {
            insecureEndpoint = error.message.includes('HTTPS');
        }
        assert(insecureEndpoint, 'provider requests must reject insecure endpoints before network access');
        print('PASS: GJS subprocess communication, deadline and termination');
    } catch (error) {
        printerr(error.message);
        failed = true;
    } finally {
        loop.quit();
    }
})();
loop.run();
function remove(file) {
    if (file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) === Gio.FileType.DIRECTORY) {
        const entries = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let entry;
        while ((entry = entries.next_file(null)))
            remove(file.get_child(entry.get_name()));
        entries.close(null);
    }
    file.delete(null);
}
remove(Gio.File.new_for_path(scratch));
System.exit(failed ? 1 : 0);

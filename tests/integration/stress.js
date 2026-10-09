// Explicit stress suite, separate from the fast release checks. Synthetic data only.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import {QuotaThresholdTracker} from '../../src/core/notifications.js';
import {codexOversizedRecordMayAffectUsage, parseCodexEvent} from '../../src/providers/codex.js';
import {buildPath, readJson} from '../../src/services/files.js';
import {scanJsonlHistory} from '../../src/services/history.js';
import {runCommand} from '../../src/services/process.js';
import {RpcClient} from '../../src/services/rpcClient.js';

const scratch = GLib.dir_make_tmp('usagebeam-data-stress-XXXXXX');
const now = new Date('2026-09-06T12:00:00Z').getTime();
const results = [];
const assert = (value, message) => { if (!value) throw new Error(message); };
const event = total => JSON.stringify({type: 'event_msg', timestamp: '2026-09-06T10:00:00Z', payload: {type: 'token_count',
    info: {total_token_usage: {input_tokens: total, output_tokens: 0, cached_input_tokens: 0, total_tokens: total}}}});
const total = record => record.days.reduce((sum, day) => sum + day.total, 0);
const fixture = name => {
    const root = buildPath(scratch, name);
    GLib.mkdir_with_parents(root, 0o700);
    const cachePath = buildPath(scratch, `${name}-cache.json`);
    return {root, path: buildPath(root, 'fixture.jsonl'), cachePath,
        scan: () => scanJsonlHistory('codex', [root], parseCodexEvent, {now, cachePath})};
};
async function test(name, callback) {
    const start = GLib.get_monotonic_time();
    try {
        const details = await callback();
        results.push({name, ok: true, details});
    } catch (error) {
        results.push({name, ok: false, error: error.message});
    }
    results.at(-1).milliseconds = Math.round((GLib.get_monotonic_time() - start) / 1000);
    print(JSON.stringify(results.at(-1)));
}
function remove(file) {
    if (file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) === Gio.FileType.DIRECTORY) {
        const iterator = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        try {
            let entry;
            while ((entry = iterator.next_file(null)))
                remove(file.get_child(entry.get_name()));
        } finally {
            iterator.close(null);
        }
    }
    file.delete(null);
}

async function run() {
    await test('50,000 cumulative events across 50 files; warm cache and privacy', () => {
        const source = fixture('volume');
        const contents = Array.from({length: 1000}, (_, index) => event((index + 1) * 10)).join('\n') + '\n';
        for (let file = 0; file < 50; file++)
            GLib.file_set_contents(buildPath(source.root, `${file}.jsonl`), contents);
        const cold = source.scan();
        assert(total(cold) === 500000 && cold.status === 'ready', 'Cold scan lost cumulative events');
        const warm = source.scan();
        assert(total(warm) === 500000 && warm.scannedFiles === 0, 'Warm scan recounted unchanged files');
        assert(!JSON.stringify(readJson(source.cachePath)).includes(source.root), 'Cache exposes source paths');
        return {events: 50000, files: 50, total: total(warm)};
    });
    await test('same-inode same-length rewrite invalidates cached totals', () => {
        const source = fixture('rewrite');
        GLib.file_set_contents(source.path, `${event(100)}\n`);
        assert(total(source.scan()) === 100, 'Baseline differs');
        GLib.usleep(2000);
        const stream = Gio.File.new_for_path(source.path).open_readwrite(null);
        try {
            stream.get_output_stream().write_all(new TextEncoder().encode(`${event(200)}\n`), null);
        } finally {
            stream.close(null);
        }
        const actual = total(source.scan());
        assert(actual === 200, `Expected 200 after in-place rewrite, got ${actual}`);
    });
    await test('oversized local line does not permanently hide later valid usage', () => {
        const source = fixture('oversized');
        GLib.file_set_contents(source.path, `${event(100)}\n${' '.repeat(5 * 1024 * 1024)}\n${event(200)}\n`);
        source.scan();
        const next = source.scan();
        assert(total(next) === 200, `Expected recovery to 200, got ${total(next)} (${next.status})`);
    });
    await test('oversized non-usage Codex records do not mark complete totals partial', () => {
        const source = fixture('oversized-ignored');
        const ignored = JSON.stringify({type: 'compacted', payload: {message: 'x'.repeat(5 * 1024 * 1024)}});
        GLib.file_set_contents(source.path, `${event(100)}\n${ignored}\n${event(200)}\n`);
        const result = scanJsonlHistory('codex', [source.root], parseCodexEvent, {
            now,
            cachePath: source.cachePath,
            oversizedRecordMayAffectUsage: codexOversizedRecordMayAffectUsage,
        });
        assert(total(result) === 200 && result.status === 'ready',
            `Known non-usage record produced ${result.status} history`);
        const warm = scanJsonlHistory('codex', [source.root], parseCodexEvent, {
            now,
            cachePath: source.cachePath,
            oversizedRecordMayAffectUsage: codexOversizedRecordMayAffectUsage,
        });
        assert(warm.status === 'ready' && warm.scannedFiles === 0,
            'Ignored-record status was not stable in cache');
    });
    await test('growing in-place rewrite verifies the entire committed prefix', () => {
        const source = fixture('growing-rewrite');
        GLib.file_set_contents(source.path, `${event(100)}\n`);
        assert(total(source.scan()) === 100, 'Baseline differs');
        const stream = Gio.File.new_for_path(source.path).open_readwrite(null);
        try {
            stream.get_output_stream().write_all(new TextEncoder().encode(`${event(300)}\n${event(400)}\n`), null);
        } finally { stream.close(null); }
        assert(total(source.scan()) === 400, 'Growing rewrite was mistaken for an append');
    });
    await test('oversized unterminated record resumes past its later newline', () => {
        const source = fixture('oversized-append');
        GLib.file_set_contents(source.path, `${event(100)}\n${' '.repeat(5 * 1024 * 1024)}`);
        assert(total(source.scan()) === 100, 'Oversized incomplete line changed usage');
        const output = Gio.File.new_for_path(source.path).append_to(Gio.FileCreateFlags.NONE, null);
        try {
            output.write_all(new TextEncoder().encode(`remaining oversized text\n${event(200)}\n`), null);
        } finally { output.close(null); }
        const result = source.scan();
        assert(total(result) === 200 && result.status === 'partial', 'Skip state was not retained across scans');
    });
    await test('null or malformed cache is safely rebuilt', () => {
        const source = fixture('bad-cache');
        GLib.file_set_contents(source.path, `${event(100)}\n`);
        for (const value of ['null', '{"files":null}', 'not json']) {
            GLib.file_set_contents(source.cachePath, value);
            assert(total(source.scan()) === 100, 'Bad cache prevented source recovery');
        }
    });
    await test('malformed JSON preserves readable events with partial status', () => {
        const source = fixture('malformed');
        GLib.file_set_contents(source.path, `${event(100)}\nnot json\n${event(200)}\n`);
        const result = source.scan();
        assert(total(result) === 200 && result.status === 'partial', 'Malformed line corrupted readable usage');
    });
    await test('incomplete write resumes after append without double counting', () => {
        const source = fixture('append');
        const next = `${event(200)}\n`;
        GLib.file_set_contents(source.path, `${event(100)}\n${next.slice(0, 50)}`);
        assert(total(source.scan()) === 100, 'Partial write was counted');
        const output = Gio.File.new_for_path(source.path).append_to(Gio.FileCreateFlags.NONE, null);
        try {
            output.write_all(new TextEncoder().encode(next.slice(50)), null);
        } finally {
            output.close(null);
        }
        assert(total(source.scan()) === 200 && total(source.scan()) === 200, 'Append lost or duplicated usage');
    });
    const createThresholdRecord = (percent, period = 1, count = 1) => ({id: 'codex', name: 'Codex', accountKey: '0'.repeat(64),
        limits: {status: 'ready', windows: Array.from({length: count}, (_, index) => ({id: `window-${index}`,
            label: `Allowance ${index}`, resetsAt: period, usedPercent: percent, unlimited: false}))}});
    await test('10,000 repeated reads emit each milestone exactly once per period', () => {
        const tracker = new QuotaThresholdTracker();
        const alerts = [];
        for (const percent of [0, 80, 79, 80, 90, 89, 90, 100])
            alerts.push(...tracker.update(createThresholdRecord(percent), 80));
        for (let index = 0; index < 10000; index++)
            alerts.push(...tracker.update(createThresholdRecord(index % 2 ? 100 : 79), 80));
        assert(alerts.map(alert => alert.threshold).join(',') === '80,90,100', 'Milestone alerts repeat');
    });
    await test('notification state stays bounded after 1,000 quota resets', () => {
        const tracker = new QuotaThresholdTracker();
        for (let period = 1; period <= 1000; period++)
            tracker.update(createThresholdRecord(20, period, 32), 80);
        assert(tracker.trackedWindowCount <= 200, `Expected at most 200 retained keys, got ${tracker.trackedWindowCount}`);
    });
    await test('20 concurrent subprocesses and 20 RPC lifecycles', async () => {
        const output = await Promise.all(Array.from({length: 20}, () => runCommand(['/bin/echo', 'synthetic'])));
        assert(output.every(value => value.trim() === 'synthetic'), 'Concurrent output mismatch');
        for (let index = 0; index < 20; index++) {
            const rpc = new RpcClient(['/bin/cat'], null, 500);
            try { await rpc.request('synthetic'); } finally { rpc.close(); }
            assert(rpc.isClosed && rpc.pendingRequestCount === 0, 'RPC retained requests after close');
        }
    });
    await test('20 in-flight cancellations terminate promptly', async () => {
        const jobs = Array.from({length: 20}, async () => {
            const cancellation = new Gio.Cancellable();
            const promise = runCommand(['/bin/sleep', '5'], {cancellable: cancellation});
            cancellation.cancel();
            try {
                await promise; return false;
            } catch (error) {
                return error.code === 'CANCELLED';
            }
        });
        assert((await Promise.all(jobs)).every(Boolean), 'Cancellation was lost');
    });
    await test('stdout cap is enforced before producer exit', async () => {
        // Finite output and a short deadline: exercises pressure without risking OOM.
        let code;
        try {
            await runCommand(['/usr/bin/python3', '-c',
                'import sys,time; sys.stdout.write("x" * 1048576); sys.stdout.flush(); time.sleep(2)'],
            {maxOutputBytes: 1024, timeout: 1000});
        } catch (error) { code = error.code; }
        assert(code === 'OUTPUT_LIMIT', `Expected early OUTPUT_LIMIT, got ${code}`);
    });
    await test('Unicode crossing read boundaries and large stdin round-trip intact', async () => {
        const input = 'x'.repeat(65535) + '🛰'.repeat(20000);
        const actual = await runCommand(['/bin/cat'], {input});
        assert(actual === input, 'Chunk boundaries corrupted Unicode');
    });
    await test('RPC output and queued writes remain bounded', async () => {
        const rpc = new RpcClient(['/usr/bin/python3', '-c',
            'import sys,time; sys.stdout.write("x" * 9437184); sys.stdout.flush(); time.sleep(2)'], null, 5000);
        try {
            let closed = false;
            try {
                await rpc.request('synthetic');
            } catch (error) {
                closed = error.code === 'RPC_CLOSED';
            }
            assert(closed && rpc.pendingRequestCount === 0, 'Oversized RPC response was not rejected');
        } finally { rpc.close(); }
        const stalled = new RpcClient(['/bin/sleep', '5'], null, 500);
        try {
            let bounded = false;
            try {
                for (let index = 0; index < 65; index++)
                    stalled.notify('synthetic', {value: index});
            } catch (error) { bounded = error.code === 'OUTPUT_LIMIT'; }
            assert(bounded, 'RPC notification queue is unbounded');
        } finally { stalled.close(); }
    });
}
const loop = new GLib.MainLoop(null, false);
run().catch(error => results.push({name: 'stress harness', ok: false, error: error.message})).finally(() => {
    try {
        if (ARGV[0])
            GLib.file_set_contents(ARGV[0], JSON.stringify(results, null, 2));
        remove(Gio.File.new_for_path(scratch));
    } finally {
        loop.quit();
    }
});
loop.run();
System.exit(results.every(result => result.ok) ? 0 : 1);

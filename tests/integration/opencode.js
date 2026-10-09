import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import {createUsageRecord, mergeUsageRecords} from '../../src/core/usage.js';
import {validateUsageRecord} from '../../src/core/usageValidation.js';
import {buildPath, clearDerivedData, readJson, writeJson} from '../../src/services/files.js';
import {readOpenCodeHistory} from '../../src/services/opencodeHistory.js';
import {runCommand} from '../../src/services/process.js';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const scratch = GLib.dir_make_tmp('usagebeam-opencode-XXXXXX');
const path = buildPath(scratch, 'opencode.db');
const cachePath = buildPath(scratch, 'history-opencode.json');
const script = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_parent()
    .get_child('src/collector/opencode_history.py').get_path();
const now = new Date('2026-09-12T12:00:00').getTime();
const options = {path, cachePath, now};
const loop = new GLib.MainLoop(null, false);
let failed = false;

async function test() {
    await runCommand(['python3', '-c', `import sqlite3, json, sys
c = sqlite3.connect(sys.argv[1])
c.execute('CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
data = dict(role='assistant', modelID='synthetic-model', tokens=dict(input=100, output=20, reasoning=10,
    cache=dict(read=40, write=5)), content='PRIVATE_SENTINEL')
c.execute('INSERT INTO message VALUES (?, ?, ?, ?)', ('private-message', 'private-session', int(sys.argv[2])-1000, json.dumps(data)))
c.commit(); c.close()`, path, String(now)]);
    const first = await readOpenCodeHistory(script, options);
    assert(first.status === 'ready' && first.days.at(-1).total === 175, 'OpenCode initial collection');
    const warm = await readOpenCodeHistory('/missing-script', options);
    assert(warm.status === 'ready' && warm.scannedFiles === 0, 'Unchanged database must use its validated cache');
    const serialized = JSON.stringify(readJson(cachePath));
    assert(!['PRIVATE_SENTINEL', 'private-message', 'private-session', path].some(value => serialized.includes(value)),
        'Cache must contain only aggregate usage and hashed source identity');
    const info = Gio.File.new_for_path(cachePath).query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null);
    assert((info.get_attribute_uint32('unix::mode') & 0o777) === 0o600, 'OpenCode cache must be private');

    await runCommand(['python3', '-c', `import sqlite3, sys
c=sqlite3.connect(sys.argv[1])
c.execute("UPDATE message SET data=json_set(data, '$.tokens.input', 200)")
c.commit(); c.close()`, path]);
    const updated = await readOpenCodeHistory(script, options);
    assert(updated.status === 'ready' && updated.scannedFiles === 1 && updated.days.at(-1).total === 275,
        'Modified messages must replace cached totals');
    const invalid = readJson(cachePath);
    invalid.history.raw = 'unexpected field';
    writeJson(cachePath, invalid);
    assert((await readOpenCodeHistory(script, options)).scannedFiles === 1, 'Invalid cache must rebuild');
    assert((await readOpenCodeHistory(script, {...options, now: now + 86400000})).period.end === '2026-09-13',
        'Calendar rollover must invalidate the aggregate cache');
    assert((await readOpenCodeHistory(script, {...options, cachePath: buildPath(scratch, 'missing-cache.json'),
        path: buildPath(scratch, 'absent.db')})).status === 'unsupported', 'Absent initial source must be explicit');
    const renamed = buildPath(scratch, 'saved.db');
    Gio.File.new_for_path(path).move(Gio.File.new_for_path(renamed), Gio.FileCopyFlags.NONE, null, null);
    const unavailable = await readOpenCodeHistory(script, options);
    assert(unavailable.status === 'unavailable', 'Missing previous source must preserve saved activity');
    const previous = createUsageRecord('opencode');
    previous.capabilities = {limits: false, history: true, models: true};
    previous.history = first;
    const next = {...previous, history: unavailable};
    assert(validateUsageRecord(mergeUsageRecords(previous, next), 'opencode').history.status === 'stale', 'Failure must retain valid saved activity');
    Gio.File.new_for_path(renamed).move(Gio.File.new_for_path(path), Gio.FileCopyFlags.NONE, null, null);
    const cancelled = new Gio.Cancellable();
    cancelled.cancel();
    const stopped = await readOpenCodeHistory(script, {...options,
        cachePath: buildPath(scratch, 'cancelled.json'), cancellable: cancelled});
    assert(stopped.status === 'unavailable' && !Gio.File.new_for_path(buildPath(scratch, 'cancelled.json')).query_exists(null),
        'Cancellation must not commit a new cache');
    clearDerivedData({state: scratch, cache: scratch});
    assert(Gio.File.new_for_path(path).query_exists(null), 'Clearing UsageBeam data must preserve the OpenCode database');
    print('PASS: OpenCode GJS collection, cache invalidation, rollover, privacy, cancellation and saved-data recovery');
}

test().catch(error => { printerr(error.message); failed = true; }).finally(() => {
    const root = Gio.File.new_for_path(scratch);
    const entries = root.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    try {
        let entry;
        while ((entry = entries.next_file(null)))
            root.get_child(entry.get_name()).delete(null);
    } finally {
        entries.close(null);
        root.delete(null);
        loop.quit();
    }
});
loop.run();
System.exit(failed ? 1 : 0);

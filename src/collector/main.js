import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';
import System from 'system';
import {record, section, validateRecord} from '../core/usage.js';
import {collectClaude} from '../providers/claude.js';
import {collectCodex} from '../providers/codex.js';
import {collectOpenCode} from '../providers/opencode.js';
import {commandSpec, findCommand} from '../services/commands.js';
import {fingerprint, join, readJson} from '../services/files.js';
import {scanHistory} from '../services/history.js';
import {readOpenCodeHistory} from '../services/opencodeHistory.js';
import {requestJson} from '../services/http.js';
import {RpcClient} from '../services/process.js';

const COLLECTORS = Object.freeze({codex: collectCodex, claude: collectClaude, opencode: collectOpenCode});
const HISTORY_ROOTS = {
    codex: GLib.getenv('CODEX_HOME') || join(GLib.get_home_dir(), '.codex'),
    claude: GLib.getenv('CLAUDE_CONFIG_DIR') || join(GLib.get_home_dir(), '.claude'),
};
const id = ARGV[0];
if (!Object.prototype.hasOwnProperty.call(COLLECTORS, id)) {
    printerr('Usage: gjs -m src/collector/main.js <codex|claude|opencode> [retention-days]');
    System.exit(2);
}
const retentionText = ARGV[1] ?? '';
const requestedRetention = /^\d+$/.test(retentionText) ? Number(retentionText) : 30;
const retention = Math.max(7, Math.min(90, Number.isSafeInteger(requestedRetention) ? requestedRetention : 30));
const cancellable = new Gio.Cancellable();
const loop = new GLib.MainLoop(null, false);
let signal = GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 15, () => {
    signal = 0;
    cancellable.cancel();
    return GLib.SOURCE_REMOVE;
});
const io = {
    fingerprint,
    now: () => Date.now(),
    openCodeHistory: () => readOpenCodeHistory(Gio.File.new_for_uri(import.meta.url)
        .get_parent().get_child('opencode_history.py').get_path(), {cancellable}),
    hasCommand(name) {
        try { findCommand(name); return true; } catch { return false; }
    },
    scan(provider, suffixes, parser, options = {}) {
        const root = HISTORY_ROOTS[provider];
        if (!root)
            throw new Error(`Unsupported local history provider: ${provider}`);
        return scanHistory(provider, suffixes.map(suffix => join(root, suffix)), parser, {...options, retention});
    },
    credentials(provider) {
        if (provider === 'claude')
            return readJson(join(HISTORY_ROOTS.claude, '.credentials.json'), null, 1024 * 1024);
        return null;
    },
    codexClient: () => new RpcClient(commandSpec('codex', ['app-server'], {runtimes: ['node']}), cancellable),
    http: (url, options) => requestJson(url, {...options, cancellable}),
};

(async () => {
    try {
        const result = validateRecord(await COLLECTORS[id](io), id);
        if (!cancellable.is_cancelled())
            print(JSON.stringify(result));
    } catch {
        const result = record(id);
        result.limits = {...result.limits, ...section('unavailable', 'Could not collect usage. Retry or check provider sign-in.')};
        result.history = {...result.history, ...section('unavailable', 'Could not collect local history.')};
        if (!cancellable.is_cancelled())
            print(JSON.stringify(result));
    } finally {
        if (signal)
            GLib.source_remove(signal);
        loop.quit();
    }
})();
loop.run();

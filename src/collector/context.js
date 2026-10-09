import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {createCommandSpec, findCommand} from '../services/commands.js';
import {buildPath, fingerprint, readJson} from '../services/files.js';
import {scanJsonlHistory} from '../services/history.js';
import {requestJson} from '../services/http.js';
import {readOpenCodeHistory} from '../services/opencodeHistory.js';
import {RpcClient} from '../services/rpcClient.js';

// Adapters receive capabilities, never Shell actors or scheduling state.
export function createCollectorContext({cancellable, retentionDays}) {
    const historyRoots = {
        codex: GLib.getenv('CODEX_HOME') || buildPath(GLib.get_home_dir(), '.codex'),
        claude: GLib.getenv('CLAUDE_CONFIG_DIR') || buildPath(GLib.get_home_dir(), '.claude'),
    };
    const helperPath = Gio.File.new_for_uri(import.meta.url)
        .get_parent().get_child('opencode_history.py').get_path();

    return {
        fingerprint,
        now: () => Date.now(),
        openCodeHistory: () => readOpenCodeHistory(helperPath, {cancellable}),
        hasCommand(name) {
            try {
                findCommand(name);
                return true;
            } catch {
                return false;
            }
        },
        scan(providerId, suffixes, parser, options = {}) {
            const root = historyRoots[providerId];
            if (!root)
                throw new Error(`Unsupported local history provider: ${providerId}`);
            const roots = suffixes.map(suffix => buildPath(root, suffix));
            return scanJsonlHistory(providerId, roots, parser, {...options, retention: retentionDays});
        },
        credentials(providerId) {
            return providerId === 'claude'
                ? readJson(buildPath(historyRoots.claude, '.credentials.json'), null, 1024 * 1024)
                : null;
        },
        codexClient: () => new RpcClient(
            createCommandSpec('codex', ['app-server'], {runtimes: ['node']}), cancellable),
        http: (url, options) => requestJson(url, {...options, cancellable}),
    };
}

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';
import System from 'system';
import {createUsageRecord, createUsageSection} from '../core/usage.js';
import {validateUsageRecord} from '../core/usageValidation.js';
import {collectClaude} from '../providers/claude.js';
import {collectCodex} from '../providers/codex.js';
import {collectOpenCode} from '../providers/opencode.js';
import {createCollectorContext} from './context.js';

const COLLECTORS = Object.freeze({codex: collectCodex, claude: collectClaude, opencode: collectOpenCode});
const providerId = ARGV[0];
if (!Object.prototype.hasOwnProperty.call(COLLECTORS, providerId)) {
    printerr('Usage: gjs -m src/collector/main.js <codex|claude|opencode> [retention-days]');
    System.exit(2);
}
const retentionText = ARGV[1] ?? '';
const requestedRetention = /^\d+$/.test(retentionText) ? Number(retentionText) : 30;
const retentionDays = Math.max(7, Math.min(90, Number.isSafeInteger(requestedRetention) ? requestedRetention : 30));
const cancellable = new Gio.Cancellable();
const mainLoop = new GLib.MainLoop(null, false);
let terminationSignalId = GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 15, () => {
    terminationSignalId = 0;
    cancellable.cancel();
    return GLib.SOURCE_REMOVE;
});

async function collectAndPrintUsage() {
    try {
        const context = createCollectorContext({cancellable, retentionDays});
        const result = validateUsageRecord(await COLLECTORS[providerId](context), providerId);
        if (!cancellable.is_cancelled())
            print(JSON.stringify(result));
    } catch {
        const result = createUsageRecord(providerId);
        result.limits = {...result.limits,
            ...createUsageSection('unavailable', 'Could not collect usage. Retry or check provider sign-in.')};
        result.history = {...result.history, ...createUsageSection('unavailable', 'Could not collect local history.')};
        if (!cancellable.is_cancelled())
            print(JSON.stringify(result));
    } finally {
        if (terminationSignalId)
            GLib.source_remove(terminationSignalId);
        mainLoop.quit();
    }
}

collectAndPrintUsage();
mainLoop.run();

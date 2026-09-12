import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {collectionNeedsBackoff, mergeRecord, orderedEnabledProviders, record, section, validateRecord} from '../core/usage.js';
import {ThresholdTracker} from '../core/notifications.js';
import {commandSpec} from './commands.js';
import {join, readJson, stateDirectory, writeJson} from './files.js';
import {runCommand} from './process.js';

const SCHEDULER_TICK_SECONDS = 15;
const MANUAL_REFRESH_COOLDOWN_MS = 2000;
const MAX_BACKOFF_SECONDS = 3600;

export class UsageService {
    constructor(settings, directory, changed, alerts) {
        this._settings = settings;
        this._directory = directory;
        this._changed = changed;
        this._alerts = alerts;
        this._records = {};
        this._jobs = new Map();
        this._attempts = new Map();
        this._failures = new Map();
        this._thresholds = new ThresholdTracker();
        this._closed = false;
        this._enabled = [];
        this.configure();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SCHEDULER_TICK_SECONDS, () => {
            for (const id of this._enabled)
                this.refresh(id);
            return GLib.SOURCE_CONTINUE;
        });
        this._sleepId = Gio.DBus.system.signal_subscribe('org.freedesktop.login1', 'org.freedesktop.login1.Manager',
            'PrepareForSleep', '/org/freedesktop/login1', null, Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _path, _interface, _signal, params) => {
                if (!params.get_child_value(0).get_boolean())
                    this.refreshAll(true);
            });
    }

    get enabledProviders() {
        return [...this._enabled];
    }

    recordFor(id) {
        return this._records[id] ?? null;
    }

    isRefreshing(id) {
        return this._jobs.has(id);
    }

    _emitChanged() {
        try {
            this._changed();
        } catch (error) {
            console.error('UsageBeam could not update its panel', error);
        }
    }

    _emitAlerts(alerts) {
        try {
            this._alerts(alerts);
        } catch (error) {
            console.error('UsageBeam could not display a usage alert', error);
        }
    }

    configure() {
        if (this._closed)
            return;
        this._enabled = orderedEnabledProviders(this._settings.get_strv('enabled-providers'),
            this._settings.get_strv('provider-order'));
        for (const [id, job] of this._jobs) {
            if (!this._enabled.includes(id)) {
                job.cancel();
                this._jobs.delete(id);
            }
        }
        for (const id of Object.keys(this._records)) {
            if (!this._enabled.includes(id)) {
                delete this._records[id];
                this._attempts.delete(id);
                this._failures.delete(id);
            }
        }
        for (const id of this._enabled) {
            if (this._records[id])
                continue;
            try {
                const cached = validateRecord(readJson(join(stateDirectory(), `${id}.json`)), id);
                for (const key of ['limits', 'history']) {
                    if (['ready', 'partial', 'stale'].includes(cached[key].status))
                        cached[key] = {...cached[key], ...section('stale', 'Showing saved usage while refreshing.'), updatedAt: cached[key].updatedAt};
                }
                this._records[id] = cached;
            } catch {
                this._records[id] = record(id);
            }
        }
    }

    refreshAll(force = false) {
        for (const id of this._enabled)
            this.refresh(id, force);
    }

    clearSavedData() {
        if (this._closed)
            return;
        for (const job of this._jobs.values())
            job.cancel();
        this._jobs.clear();
        this._attempts.clear();
        this._failures.clear();
        this._thresholds = new ThresholdTracker();
        this._records = Object.fromEntries(this._enabled.map(id => [id, record(id)]));
        this._emitChanged();
        this.refreshAll(true);
    }

    async refresh(id, force = false) {
        if (this._closed || !this._enabled.includes(id) || this._jobs.has(id))
            return;
        const now = Date.now();
        const elapsed = now - (this._attempts.get(id) ?? 0);
        const wait = Math.min(MAX_BACKOFF_SECONDS,
            this._settings.get_int('refresh-interval') * 2 ** (this._failures.get(id) ?? 0));
        if (elapsed >= 0 && elapsed < (force ? MANUAL_REFRESH_COOLDOWN_MS : wait * 1000))
            return;
        const job = new Gio.Cancellable();
        this._jobs.set(id, job);
        this._attempts.set(id, now);
        this._emitChanged();
        try {
            const collector = commandSpec('gjs', ['-m', join(this._directory, 'src', 'collector', 'main.js'),
                id, String(this._settings.get_int('history-retention-days'))]);
            const stdout = await runCommand(collector, {cancellable: job, timeout: 45000});
            if (this._closed || job.is_cancelled() || this._jobs.get(id) !== job)
                return;
            const result = validateRecord(JSON.parse(stdout), id);
            const failed = collectionNeedsBackoff(result);
            this._failures.set(id, failed ? Math.min(4, (this._failures.get(id) ?? 0) + 1) : 0);
            const alerts = this._thresholds.update(result, this._settings.get_int('notification-threshold'));
            this._records[id] = mergeRecord(this._records[id], result);
            try {
                writeJson(join(stateDirectory(), `${id}.json`), this._records[id]);
            } catch {
                // Cache failure must not hide current usage.
            }
            if (this._settings.get_boolean('notifications-enabled') && alerts.length)
                this._emitAlerts(alerts);
        } catch {
            if (!this._closed && !job.is_cancelled()) {
                const failure = record(id);
                failure.limits = {...failure.limits,
                    ...section('unavailable', 'Collection failed or timed out. Retry from the panel.')};
                failure.history = {...failure.history, ...section('unavailable', 'History could not be refreshed.')};
                this._records[id] = mergeRecord(this._records[id], failure);
                this._failures.set(id, Math.min(4, (this._failures.get(id) ?? 0) + 1));
            }
        } finally {
            if (this._jobs.get(id) === job)
                this._jobs.delete(id);
            if (!this._closed)
                this._emitChanged();
        }
    }

    destroy() {
        if (this._closed)
            return;
        this._closed = true;
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
        if (this._sleepId) {
            Gio.DBus.system.signal_unsubscribe(this._sleepId);
            this._sleepId = 0;
        }
        for (const job of this._jobs.values())
            job.cancel();
        this._jobs.clear();
        this._changed = () => {};
        this._alerts = () => {};
    }
}

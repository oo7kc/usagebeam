import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import {formatCompactTokenCount} from '../core/format.js';
import {PROVIDERS, PROVIDER_NAMES} from '../core/providerRegistry.js';
import {quotaSeverity} from '../core/thresholds.js';
import {getHistoryOverview, getPanelQuota} from './presentation.js';
import {createLabel, createMetricLabel, createProviderIcon} from './widgets.js';

export const UsageBeamPanelReadout = GObject.registerClass(class UsageBeamPanelReadout extends St.Widget {
    _init(extensionPath) {
        super._init({style_class: 'usagebeam-panel-slot', layout_manager: new Clutter.BinLayout()});
        this._extensionPath = extensionPath;
        this.statusRow = new St.BoxLayout({style_class: 'usagebeam-panel-status',
            x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        this.iconBin = new St.Bin({style_class: 'usagebeam-panel-icon-slot', y_align: Clutter.ActorAlign.CENTER});
        this.providerLabel = createLabel('UsageBeam', 'usagebeam-panel-provider');
        this.providerLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.valueLabel = createMetricLabel('—', 'usagebeam-panel-value');
        this.resetLabel = createMetricLabel('—', 'usagebeam-panel-reset');
        this.separator = createLabel('·', 'usagebeam-panel-separator');
        this._metricsRow = new St.BoxLayout({style_class: 'usagebeam-panel-metrics',
            y_align: Clutter.ActorAlign.CENTER});
        for (const actor of [this.valueLabel, this.separator, this.resetLabel])
            this._metricsRow.add_child(actor);
        for (const actor of [this.iconBin, this.providerLabel, this._metricsRow])
            this.statusRow.add_child(actor);
        this._providerId = null;
        // An invisible overlay reserves the widest supported readout. This keeps
        // the calendar fixed while allowing the configured system font to size
        // the indicator naturally instead of relying on a hard-coded width.
        // Center the visible row so unused reservation is shared by both ends.
        this._measurementActor = new St.Widget({
            opacity: 0,
            reactive: false,
            accessible_role: Atk.Role.REDUNDANT_OBJECT,
            layout_manager: new Clutter.BinLayout(),
        });
        this.add_child(this._measurementActor);
        this.add_child(this.statusRow);
    }

    update(enabledProviders, id, record) {
        this._syncSizer(enabledProviders);
        const name = PROVIDERS[id]?.label ?? 'UsageBeam';
        if (this._providerId !== id) {
            this.iconBin.get_child()?.destroy();
            this.iconBin.set_child(createProviderIcon(id, this._extensionPath, 'usagebeam-panel-icon') ??
                createLabel(PROVIDERS[id]?.mark ?? 'AI', 'usagebeam-panel-mark'));
            this._providerId = id;
        }
        this.providerLabel.text = name;
        const quota = getPanelQuota(record);
        const localOnly = record?.capabilities.limits === false && record?.capabilities.history === true;
        const activity = localOnly ? getHistoryOverview(record.history) : null;
        this.valueLabel.text = quota ? `${quota.percent}%` : activity ? formatCompactTokenCount(activity.total) : '—';
        const severity = quotaSeverity(quota?.percent);
        this.valueLabel.style_class = `usagebeam-panel-value${severity ? ` usagebeam-${severity}` : ''}`;
        this.resetLabel.text = localOnly ? '7d' : quota?.reset ?? '—';
        const resetDescription = quota?.reset === 'due' ? ', reset due' :
            quota?.reset ? `, resets in ${quota.reset}` : '';
        return `UsageBeam, ${name}${quota ? `, ${quota.percent} percent used${resetDescription}` :
            activity ? `, ${activity.total} local tokens in the last 7 days` : ''}`;
    }

    _syncSizer(enabled) {
        const providers = enabled.length ? enabled : Object.keys(PROVIDER_NAMES);
        const key = providers.join('\u0000');
        if (this._measurementKey === key)
            return;
        this._measurementKey = key;
        this._measurementActor.destroy_all_children();
        // Units have different widths in system fonts. Compact formatting
        // removes the decimal when a value rounds up to 1000 of its unit.
        const samples = providers.flatMap(id => id === 'opencode'
            ? ['K', 'M', 'B', 'T', 'P'].map(unit => [id, `999.9${unit}`]) : [[id, '999%']]);
        for (const [id, sample] of samples) {
            const row = new St.BoxLayout({style_class: 'usagebeam-panel-status'});
            const icon = new St.Bin({style_class: 'usagebeam-panel-icon-slot',
                y_align: Clutter.ActorAlign.CENTER});
            icon.set_child(createProviderIcon(id, this._extensionPath, 'usagebeam-panel-icon') ??
                createLabel(PROVIDERS[id]?.mark ?? 'AI', 'usagebeam-panel-mark'));
            const metrics = new St.BoxLayout({style_class: 'usagebeam-panel-metrics',
                y_align: Clutter.ActorAlign.CENTER});
            metrics.add_child(createMetricLabel(sample, 'usagebeam-panel-value'));
            metrics.add_child(createLabel('·', 'usagebeam-panel-separator'));
            metrics.add_child(createMetricLabel(id === 'opencode' ? '7d' : '99d 23h', 'usagebeam-panel-reset'));
            for (const actor of [icon, createLabel(PROVIDERS[id]?.label, 'usagebeam-panel-provider'), metrics])
                row.add_child(actor);
            this._measurementActor.add_child(row);
        }
    }

});

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {getRecentDates} from '../core/dates.js';
import {formatModelName, formatTokenCount, formatUpdateAge} from '../core/format.js';
import {PROVIDERS, PROVIDER_NAMES} from '../core/providerRegistry.js';
import {quotaSeverity} from '../core/thresholds.js';
import {createInitialLayout, getNextLayout, getPageSlice} from './layoutPolicy.js';
import {UsageBeamPanelReadout} from './panelReadout.js';
import {
    getHistoryOverview,
    getLatestUpdate,
    getPeriodDays,
    getProviderStatus,
    getQuotaPresentation,
} from './presentation.js';
import {
    createActionButton,
    createDayChart,
    createDisclosureButton,
    createLabel,
    createLimitRow,
    createMetricLabel,
    createModelRow,
    createPageControls,
    createProviderIcon,
    createProviderTab,
    createQuotaMeter,
} from './widgets.js';

export const UsageBeamIndicator = GObject.registerClass(class UsageBeamIndicator extends PanelMenu.Button {
    _init(settings, extensionPath, openPreferences) {
        super._init(0.5, 'UsageBeam usage monitor');
        this.add_style_class_name('usagebeam-panel-button');
        this._settings = settings;
        this._extensionPath = extensionPath;
        this._openPreferences = openPreferences;
        this._service = null;
        this._detailsExpanded = false;
        this._limitPage = 0;
        this._activityPage = 0;
        this._modelPage = 0;
        this._sectionPage = 0;
        this._panelReadout = new UsageBeamPanelReadout(extensionPath);
        this.add_child(this._panelReadout);
        this.menu.actor.add_style_class_name('usagebeam-menu');
        this._syncColorScheme();
        const section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(section);
        // `content` is an inherited Clutter.Actor property whose value must be
        // ClutterContent, so keep the menu actor under an unambiguous name.
        this._contentBox = new St.BoxLayout({vertical: true, style_class: 'usagebeam-content', x_expand: true});
        section.box.add_child(this._contentBox);
        const restyle = () => {
            this._syncColorScheme();
            this._layout = null;
            this.render();
        };
        Main.layoutManager.connectObject('monitors-changed', restyle, this);
        St.ThemeContext.get_for_stage(global.stage).connectObject('changed', restyle, this);
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._layout = null;
                this.resize();
                this._service?.refreshAll();
                this.render();
            } else {
                this._detailsExpanded = false;
                this._layout = null;
            }
        });
    }

    _syncColorScheme() {
        const light = Main.getStyleVariant() === 'light';
        this.remove_style_class_name(light ? 'usagebeam-panel-dark' : 'usagebeam-panel-light');
        this.add_style_class_name(light ? 'usagebeam-panel-light' : 'usagebeam-panel-dark');
        this.menu.actor.remove_style_class_name(light ? 'usagebeam-dark' : 'usagebeam-light');
        this.menu.actor.add_style_class_name(light ? 'usagebeam-light' : 'usagebeam-dark');
    }

    resize() {
        const monitor = Main.layoutManager.findMonitorForActor(this) ?? Main.layoutManager.primaryMonitor;
        const work = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const availableWidth = Math.max(160, Math.floor(work.width / scale) - 64);
        this._contentBox.style = `width: ${Math.min(392, availableWidth)}px;`;
        // Allow for the native popup frame, panel gap, and our content padding.
        this._contentHeightBudget = Math.max(80, work.height - 48 * scale);
    }

    attach(service) {
        this._service = service;
        this.render();
    }

    render() {
        if (!this._contentBox)
            return;
        const focus = global.stage.get_key_focus();
        const restoreName = this._pendingFocusName ??
            (focus && this._contentBox.contains(focus) ? focus.accessible_name : null);
        this._pendingFocusName = null;
        const enabled = this._service?.enabledProviders ?? [];
        const requested = this._settings.get_string('default-provider');
        const id = enabled.includes(requested) ? requested : enabled[0];
        const record = this._service?.recordFor(id);
        const busy = this._service?.isRefreshing(id) ?? false;
        const providerChanged = this._renderedProvider !== id;
        if (providerChanged) {
            this._limitPage = this._activityPage = this._modelPage = this._sectionPage = 0;
            this._layout = null;
            this._renderedProvider = id;
        }
        const layoutKey = JSON.stringify([record?.plan, record?.limits.status, record?.limits.message,
            record?.limits.windows.map(window => [window.label, window.unlimited]),
            record?.history.status, record?.history.message,
            record?.history.days.length, record?.history.models.map(model => model.model)]);
        if (this._layoutKey !== layoutKey) {
            this._layoutKey = layoutKey;
            this._layout = null;
            this._limitPage = this._modelPage = this._sectionPage = 0;
        }
        this.accessible_name = this._panelReadout.update(enabled, id, record);
        // Background collection only needs the panel readout. Build fresh popup
        // actors on opening instead of rebuilding a hidden menu for every job.
        if (!this.menu.isOpen)
            return;
        this.resize();
        // Keep page sizes stable while navigating, even on a shorter last page.
        // A new opening, provider, theme or monitor starts a fresh measurement.
        this._layout ??= createInitialLayout();
        // Fit before the next paint. Never rebuild from allocation callbacks,
        // which caused the old bar flicker and recursive growth.
        while (this._layout) {
            this._contentBox.destroy_all_children();
            this._contentBox.style_class = `usagebeam-content${this._layout.compact ? ' usagebeam-compact' : ''}`;
            this._buildContent(enabled, id, record, busy);
            const width = this._contentBox.get_preferred_width(-1)[1];
            if (this._contentBox.get_preferred_height(width)[1] <= this._contentHeightBudget)
                break;
            const next = getNextLayout(this._layout, this._detailsExpanded);
            if (!next)
                break;
            this._layout = next;
        }
        this._restoreFocus(restoreName);
        this._animateProviderChange(providerChanged);
    }

    _buildContent(enabled, id, record, busy) {
        this._renderHeader(id, record, busy);
        if (enabled.length > 1)
            this._renderSelector(enabled, id);
        if (record) {
            if (this._layout.splitSections)
                this._contentBox.add_child(createPageControls('View', this._sectionPage, 2, value => {
                    this._sectionPage = value;
                    this.render();
                }));
            if (!this._layout.splitSections || this._sectionPage === 0)
                this._renderLimits(record.limits);
            if (!this._layout.splitSections || this._sectionPage === 1)
                this._renderHistory(record.history);
        } else {
            this._message('Choose your providers in preferences to get started.');
        }
        this._renderFooter(record, busy);
    }

    _renderHeader(id, record, busy) {
        const header = new St.BoxLayout({style_class: 'usagebeam-header', x_expand: true});
        const icon = createProviderIcon(id, this._extensionPath, 'usagebeam-header-icon');
        if (icon)
            header.add_child(icon);
        else
            header.add_child(createLabel(PROVIDERS[id]?.mark ?? 'AI', 'usagebeam-provider-mark'));
        const identity = new St.BoxLayout({vertical: true, style_class: 'usagebeam-identity', x_expand: true});
        identity.add_child(createLabel(PROVIDERS[id]?.label ?? record?.name ?? 'UsageBeam', 'usagebeam-title'));
        const plan = createLabel(record?.plan ? String(record.plan) : 'Usage monitor', 'usagebeam-caption');
        plan.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        identity.add_child(plan);
        header.add_child(identity);
        const statusText = getProviderStatus(record, busy);
        header.add_child(createLabel(`● ${statusText}`, `usagebeam-status usagebeam-status-${statusText.toLowerCase()}`));
        this._contentBox.add_child(header);
    }

    _renderSelector(enabled, selected) {
        const selector = new St.Widget({style_class: 'usagebeam-selector', x_expand: true,
            layout_manager: new Clutter.BoxLayout({orientation: Clutter.Orientation.HORIZONTAL,
                homogeneous: true, spacing: 8})});
        enabled.forEach((provider, index) => {
            const name = `Show ${PROVIDER_NAMES[provider]} usage`;
            selector.add_child(createProviderTab(PROVIDERS[provider]?.label,
                () => this._settings.set_string('default-provider', provider),
                direction => {
                    const next = direction === -Infinity ? 0 : direction === Infinity ? enabled.length - 1
                        : (index + direction + enabled.length) % enabled.length;
                    const target = enabled[next];
                    this._pendingFocusName = `Show ${PROVIDER_NAMES[target]} usage`;
                    this._settings.set_string('default-provider', target);
                }, {active: provider === selected, name}));
        });
        this._contentBox.add_child(selector);
    }

    _renderLimits(limits) {
        this._heading('Limits');
        const page = getPageSlice(limits.windows.filter(window => getQuotaPresentation(window)), this._limitPage, this._layout.limits);
        for (const window of page.items) {
            const box = new St.BoxLayout({vertical: true, style_class: 'usagebeam-window'});
            const view = getQuotaPresentation(window);
            if (!view)
                continue;
            const severity = quotaSeverity(window.usedPercent);
            box.add_child(createLimitRow(view.name, view.value, severity));
            if (!window.unlimited) {
                box.add_child(createQuotaMeter(window.usedPercent / 100,
                    `${view.name}: ${view.value} used, ${view.reset.toLowerCase()}`,
                    severity ? `usagebeam-${severity}` : ''));
                box.add_child(createLabel(view.reset, 'usagebeam-limit-reset'));
            }
            this._contentBox.add_child(box);
        }
        if (page.pages > 1)
            this._contentBox.add_child(createPageControls('Limits', page.page, page.pages, value => {
                this._limitPage = value;
                this.render();
            }));
        if (limits.status !== 'ready') {
            this._message(limits.message ||
                (limits.status === 'loading' ? 'Checking account limits…' : 'Limits unavailable'));
        }
        if (limits.status === 'stale')
            this._message(`Saved limits · ${formatUpdateAge(limits.updatedAt).toLowerCase()}`);
    }

    _renderHistory(history) {
        const overview = getHistoryOverview(history);
        if (overview) {
            this._contentBox.add_child(createDisclosureButton(this._detailsExpanded, () => {
                this._detailsExpanded = !this._detailsExpanded;
                this._layout = null;
                this._limitPage = this._activityPage = this._modelPage = this._sectionPage = 0;
                this.render();
            }));

            if (this._detailsExpanded)
                this._renderActivity(history);
        }
        if (history.message && history.status !== 'ready')
            this._message(history.message);
    }

    _renderActivity(history) {
        const details = new St.BoxLayout({vertical: true, style_class: 'usagebeam-details', x_expand: true});
        const split = this._layout.splitActivity && history.days.length && history.models.length;
        if (split)
            details.add_child(createPageControls('Activity', this._activityPage, 2, value => {
                this._activityPage = value;
                this.render();
            }));
        if (history.days.length && (!split || this._activityPage === 0))
            this._renderDays(history, details);
        if (history.models.length && (!split || this._activityPage === 1))
            this._renderModels(history, details);
        this._contentBox.add_child(details);
    }

    _renderDays(history, parent = this._contentBox) {
        const overview = getHistoryOverview(history);
        this._heading(`Last ${overview?.days ?? history.days.length} days · ${formatTokenCount(overview?.total ?? 0)} tokens`, parent);
        const today = getRecentDates(Date.now(), 1)[0];
        parent.add_child(createDayChart(history.days, today));
    }

    _renderModels(history, parent = this._contentBox) {
        const modelScope = history.scope === 'account' ? 'Account' : 'Local';
        const days = getPeriodDays(history.period);
        const heading = new St.BoxLayout({style_class: 'usagebeam-section-title usagebeam-model-heading'});
        heading.add_child(createLabel('Tokens by model', '', true));
        heading.add_child(createLabel(`${days ? `${days}d · ` : ''}${modelScope}`, 'usagebeam-model-scope'));
        parent.add_child(heading);
        const page = getPageSlice(history.models, this._modelPage, this._layout.models);
        for (const model of page.items) {
            const displayName = formatModelName(model.model);
            const cache = model.cacheRead + model.cacheWrite;
            const accessible = `${displayName}, ${model.total} tokens. Input ${model.input}, output ${model.output}, cache ${cache}.`;
            parent.add_child(createModelRow(displayName, formatTokenCount(model.total), accessible));
        }
        if (page.pages > 1)
            parent.add_child(createPageControls('Models', page.page, page.pages, value => {
                this._modelPage = value;
                this.render();
            }));
    }

    _renderFooter(record, busy) {
        const actions = new St.BoxLayout({style_class: 'usagebeam-actions', x_expand: true});
        actions.add_child(createLabel(formatUpdateAge(getLatestUpdate(record)), 'usagebeam-caption', true));
        const refresh = createActionButton(busy ? 'Refreshing…' : 'Refresh',
            () => this._service?.refreshAll(true), 'Refresh usage');
        refresh.reactive = !busy;
        refresh.can_focus = !busy;
        if (busy)
            refresh.add_style_pseudo_class('insensitive');
        actions.add_child(refresh);
        actions.add_child(createActionButton('Settings', () => { this.menu.close(); this._openPreferences(); },
            'Open extension settings'));
        this._contentBox.add_child(actions);
    }

    _restoreFocus(name) {
        if (!name)
            return;
        const actors = [];
        const visit = actor => { actors.push(actor); actor.get_children().forEach(visit); };
        visit(this._contentBox);
        const opposite = name.startsWith('Next ') ? name.replace('Next ', 'Previous ')
            : name.startsWith('Previous ') ? name.replace('Previous ', 'Next ') : null;
        const target = [name, opposite].filter(Boolean).map(candidate =>
            actors.find(actor => actor.can_focus && actor.accessible_name === candidate)).find(Boolean);
        target?.grab_key_focus();
    }

    _animateProviderChange(changed) {
        this._contentBox.remove_all_transitions();
        this._contentBox.opacity = 255;
        if (!changed || !this.menu.isOpen || !St.Settings.get().enable_animations)
            return;
        this._contentBox.opacity = 220;
        this._contentBox.ease({
            opacity: 255,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _heading(text, parent = this._contentBox) {
        parent.add_child(createLabel(text, 'usagebeam-section-title'));
    }

    _message(text) {
        const message = createLabel(text, 'usagebeam-message');
        message.clutter_text.line_wrap = true;
        this._contentBox.add_child(message);
    }

    destroy() {
        Main.layoutManager.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        super.destroy();
    }
});

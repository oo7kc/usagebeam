// Loaded only by tools/smoke-shell.py in its isolated, synthetic desktop.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {runStress} from './stress.js';

const UUID = 'usagebeam@oo7kc.github.io';
const descendants = actor => [actor, ...actor.get_children().flatMap(descendants)];
const matching = (actor, style) => descendants(actor).filter(child => child.has_style_class_name?.(style));
const bounds = actor => {
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    return {x, y, width, height};
};
const textWidth = actor => actor.clutter_text.get_preferred_width(-1)[1];
const midpoint = actor => {
    const box = bounds(actor);
    return box.y + box.height / 2;
};
const textBaseline = actor => {
    const text = actor.clutter_text;
    const [, logical] = text.get_layout().get_pixel_extents();
    const ratio = text.get_preferred_height(-1)[1] / logical.height;
    return bounds(text).y + text.get_layout().get_baseline() / Pango.SCALE * ratio;
};
const assert = (condition, message) => {
    if (!condition)
        throw new Error(message);
};

export default class UsageBeamUITest extends Extension {
    enable() {
        this._timers = new Map();
        this._output = GLib.getenv('USAGEBEAM_TEST_OUTPUT');
        if (!this._output)
            throw new Error('UI tests require a private test output directory');
        this._run().then(result => this._save({ok: true, ...result})).catch(async error => {
            try {
                await this._screenshot('failure');
            } finally {
                this._save({ok: false, error: `${error}\n${error.stack ?? ''}`});
            }
        });
    }

    _save(result) {
        GLib.file_set_contents(`${this._output}/ui-results.json`, JSON.stringify(result, null, 2));
    }

    _wait(milliseconds = 150) {
        return new Promise((resolve, reject) => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
                this._timers.delete(id);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._timers.set(id, reject);
        });
    }

    async _screenshot(name) {
        const file = Gio.File.new_for_path(`${this._output}/${name}.png`);
        const stream = file.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        try {
            await new Shell.Screenshot().screenshot(false, stream);
        } finally {
            stream.close(null);
        }
    }

    _displayCall(method, parameters = null) {
        return new Promise((resolve, reject) => Gio.DBus.session.call('org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig', 'org.gnome.Mutter.DisplayConfig', method,
            parameters, null, Gio.DBusCallFlags.NONE, 5000, null, (connection, result) => {
                try {
                    resolve(connection.call_finish(result).deep_unpack());
                } catch (error) {
                    reject(error);
                }
            }));
    }

    _checkMenuSurface(indicator, variant) {
        const reference = new St.Widget({style_class: 'popup-menu panel-menu', visible: false});
        const surface = new St.BoxLayout({style_class: 'popup-menu-content'});
        reference.add_child(surface);
        Main.uiGroup.add_child(reference);
        try {
            assert(indicator.menu.actor.has_style_class_name(`usagebeam-${variant}`),
                `${variant}: menu controls do not follow the Shell theme`);
            assert(indicator.has_style_class_name(`usagebeam-panel-${variant}`),
                `${variant}: panel warning colors do not follow the Shell theme`);
            const actual = indicator.menu.box.get_theme_node();
            const expected = surface.get_theme_node();
            assert(actual.get_background_color().to_string() === expected.get_background_color().to_string(),
                `${variant}: popup background overrides the native Shell surface`);
            assert(actual.get_foreground_color().to_string() === expected.get_foreground_color().to_string(),
                `${variant}: popup text overrides the native Shell foreground`);
            assert(actual.get_border_color(St.Side.TOP).to_string() ===
                expected.get_border_color(St.Side.TOP).to_string(),
            `${variant}: popup border overrides the native Shell border`);
        } finally {
            reference.destroy();
        }
    }

    _checkPanelSpacing(indicator, calendar, position, textScale) {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const provider = bounds(indicator._panelReadout.providerLabel);
        const value = bounds(indicator._panelReadout.valueLabel);
        const separator = bounds(indicator._panelReadout.separator);
        const reset = bounds(indicator._panelReadout.resetLabel);
        const button = bounds(indicator);
        const icon = bounds(indicator._panelReadout.iconBin);
        const leftPadding = icon.x - button.x;
        const rightPadding = button.x + button.width - reset.x - reset.width;
        assert(leftPadding >= 0 && rightPadding >= 0 && Math.abs(leftPadding - rightPadding) <= 1,
            `${position}: panel end padding is uneven (${leftPadding}px / ${rightPadding}px)`);
        const rowMidpoint = midpoint(indicator._panelReadout.providerLabel);
        for (const actor of [indicator._panelReadout.iconBin.get_child(), indicator._panelReadout.valueLabel,
            indicator._panelReadout.separator, indicator._panelReadout.resetLabel]) {
            const offset = midpoint(actor) - rowMidpoint;
            assert(Math.abs(offset) <= scale,
                `${position}: panel actor midpoint differs by ${offset}px`);
        }
        const baseline = textBaseline(indicator._panelReadout.valueLabel);
        assert(Math.abs(textBaseline(indicator._panelReadout.resetLabel) - baseline) <= 1,
            `${position}: reset time does not share the metric baseline`);
        assert(Math.abs(baseline - textBaseline(indicator._panelReadout.providerLabel)) <= 1,
            `${position}: provider and metrics do not share their baseline`);
        const providerFont = indicator._panelReadout.providerLabel.get_theme_node().get_font();
        for (const actor of [indicator._panelReadout.valueLabel, indicator._panelReadout.resetLabel]) {
            assert(actor.get_theme_node().get_font().get_size() === providerFont.get_size(),
                `${position}: panel text uses inconsistent sizes`);
        }
        const panelColor = indicator.get_theme_node().get_foreground_color().to_string();
        for (const actor of [indicator._panelReadout.providerLabel, indicator._panelReadout.resetLabel]) {
            assert(actor.get_theme_node().get_foreground_color().to_string() === panelColor,
                `${position}: panel text overrides its native foreground`);
        }
        const valueLabel = indicator._panelReadout.valueLabel;
        if (!['caution', 'warning', 'danger'].some(severity => valueLabel.has_style_class_name(`usagebeam-${severity}`)))
            assert(valueLabel.get_theme_node().get_foreground_color().to_string() === panelColor,
                `${position}: normal usage is not using native panel text`);
        assert(value.x - provider.x - provider.width <= 6 * scale,
            `${position}: provider and percentage are spaced too far apart`);
        assert(Math.abs(separator.x - value.x - value.width -
            (reset.x - separator.x - separator.width)) <= 1,
        `${position}: panel separator spacing is uneven`);
        assert(bounds(indicator.container).width / scale < 180 * textScale,
            `${position}: panel indicator is not compact (${bounds(indicator.container).width / scale}px)`);
        for (const actor of [indicator._panelReadout.providerLabel, indicator._panelReadout.valueLabel, indicator._panelReadout.resetLabel]) {
            assert(!actor.clutter_text.get_layout().is_ellipsized(), `${position}: panel text clipped`);
            assert(textWidth(actor) <= actor.width + 1,
                `${position}: panel text exceeds its allocation`);
        }
        if (!position.includes('calendar'))
            return null;
        const clockLabels = descendants(calendar).filter(actor =>
            actor instanceof St.Label && actor.visible && actor.mapped && actor.width > 0);
        assert(clockLabels.length > 0, 'Calendar has no visible label');
        const clockLeft = Math.min(...clockLabels.map(actor => bounds(actor).x));
        const clockRight = Math.max(...clockLabels.map(actor => bounds(actor).x + actor.width));
        // Measure the visible text, not the label's allocated expansion space.
        const resetRight = reset.x + textWidth(indicator._panelReadout.resetLabel);
        const gap = position === 'left-of-calendar' ? clockLeft - resetRight
            : bounds(indicator._panelReadout.iconBin).x - clockRight;
        const readout = indicator._panelReadout;
        const reservedPadding = Math.max(0, readout.width - readout.statusRow.width) / 2;
        assert(gap >= 0 && gap <= 20 * scale + reservedPadding + 1,
            `${position}: calendar/readout gap exceeds balanced width reservation: ${gap / scale}`);
        return gap / scale;
    }

    async _run() {
        let indicator;
        for (let attempt = 0; attempt < 80 && !indicator; attempt++) {
            await this._wait();
            indicator = Main.panel.statusArea[UUID];
        }
        assert(indicator, 'UsageBeam did not appear in the panel');
        indicator._service.destroy();
        const [, fixture] = GLib.file_get_contents(`${this._output}/ui-fixtures.json`);
        const records = JSON.parse(new TextDecoder().decode(fixture));
        indicator.attach({enabledProviders: ['codex', 'claude', 'opencode'], recordFor: id => records[id],
            isRefreshing: () => false, refreshAll: () => {}});
        const settings = indicator._settings;
        const calendar = Main.panel.statusArea.dateMenu.container;
        const positions = ['left', 'right', 'left-of-calendar', 'right-of-calendar'];
        const placement = [];
        Main.overview.hide();
        await this._wait(500);
        // Configure only these private virtual monitors, temporarily. Setting just
        // St's scale factor would scale lengths without updating the font DPI.
        const expectedScale = Number(GLib.getenv('USAGEBEAM_TEST_SCALE') ?? 1);
        const multipleMonitors = GLib.getenv('USAGEBEAM_SECONDARY_MONITOR') === '1';
        if (expectedScale !== 1 || multipleMonitors) {
            const [serial, monitors] = await this._displayCall('GetCurrentState');
            let x = 0;
            const configuration = monitors.map(([[connector], modes], index) => {
                const [mode, width] = modes.find(item => item[5].includes(expectedScale)) ?? [];
                assert(mode, `Virtual monitor does not support scale ${expectedScale}`);
                const entry = [x, 0, expectedScale, 0, index === monitors.length - 1, [[connector, mode, {}]]];
                x += Math.round(width / expectedScale);
                return entry;
            });
            await this._displayCall('ApplyMonitorsConfig', new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})',
                [serial, 1, configuration, {}]));
            await this._wait(500);
            if (multipleMonitors) {
                assert(monitors.length === 2, 'Expected two independent virtual monitors');
                for (const primary of [0, 1]) {
                    const [currentSerial] = await this._displayCall('GetCurrentState');
                    for (let index = 0; index < configuration.length; index++)
                        configuration[index][4] = index === primary;
                    await this._displayCall('ApplyMonitorsConfig', new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})',
                        [currentSerial, 1, configuration, {}]));
                    await this._wait(500);
                    for (const position of ['left-of-calendar', 'right-of-calendar']) {
                        settings.set_string('panel-position', position);
                        await this._wait();
                        const slot = bounds(indicator.container);
                        const clock = bounds(calendar);
                        const monitor = Main.layoutManager.findMonitorForActor(Main.panel);
                        const center = (Math.min(slot.x, clock.x) +
                            Math.max(slot.x + slot.width, clock.x + clock.width)) / 2;
                        assert(Math.abs(center - monitor.x - monitor.width / 2) <= 1,
                            `${position}: group moved off-center when changing the primary monitor`);
                    }
                }
            }
        }
        const [, , logicalMonitors] = await this._displayCall('GetCurrentState');
        const monitorScale = logicalMonitors.find(monitor => monitor[4])[2];
        assert(monitorScale === expectedScale, `Expected monitor scale ${expectedScale}, got ${monitorScale}`);
        const interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const textScale = interfaceSettings.get_double('text-scaling-factor');
        if (GLib.getenv('USAGEBEAM_STRESS') === '1')
            return runStress({indicator, records, settings, calendar,
                wait: milliseconds => this._wait(milliseconds), screenshot: name => this._screenshot(name),
                checkPanel: position => this._checkPanelSpacing(indicator, calendar, position, textScale),
                monitorScale, textScale});
        for (const position of positions) {
            settings.set_string('panel-position', position);
            settings.set_string('default-provider', 'codex');
            await this._wait();
            const parent = position === 'left' ? Main.panel._leftBox : position === 'right'
                ? Main.panel._rightBox : Main.panel._centerBox;
            assert(indicator.container.get_parent() === parent, `${position}: wrong panel area`);
            const before = bounds(indicator.container);
            const clockBefore = bounds(calendar);
            const gaps = [this._checkPanelSpacing(indicator, calendar, position, textScale)];
            // Check both a different provider and unavailable quota text.
            const original = records.claude;
            for (const available of [true, false]) {
                records.claude = available ? original : {...original,
                    limits: {...original.limits, windows: []}};
                settings.set_string('default-provider', 'claude');
                indicator.render();
                await this._wait();
                gaps.push(this._checkPanelSpacing(indicator, calendar, position, textScale));
                assert(Math.abs(bounds(calendar).x - clockBefore.x) <= 1,
                    `${position}: calendar moved on provider change`);
                assert(Math.abs(bounds(indicator.container).width - before.width) <= 1,
                    `${position}: indicator width changed`);
                assert(!indicator._panelReadout.providerLabel.clutter_text.get_layout().is_ellipsized(),
                    `${position}: panel provider name clipped: ${JSON.stringify({
                        status: indicator._panelReadout.statusRow.width,
                        children: indicator._panelReadout.statusRow.get_children().map(actor =>
                            ({style: actor.style_class, width: actor.width, preferred: actor.get_preferred_width(-1)})),
                    })}`);
            }
            records.claude = original;
            if (position.includes('calendar')) {
                const children = parent.get_children();
                const offset = children.indexOf(indicator.container) - children.indexOf(calendar);
                assert(offset === (position === 'left-of-calendar' ? -1 : 1), 'Calendar adjacency lost');
            }
            if (position.includes('calendar')) {
                const monitor = Main.layoutManager.findMonitorForActor(Main.panel);
                const groupCenter = (Math.min(before.x, clockBefore.x) +
                    Math.max(before.x + before.width, clockBefore.x + clockBefore.width)) / 2;
                assert(Math.abs(groupCenter - (monitor.x + monitor.width / 2)) <= 1,
                    `${position}: calendar/indicator group is not centered (${groupCenter})`);
            }
            settings.set_string('default-provider', 'codex');
            await this._wait();
            if (position.includes('calendar'))
                await this._screenshot(position);
            placement.push({position, indicator: before, calendar: clockBefore, visualGaps: gaps});
        }
        for (const provider of ['codex', 'claude']) {
            const windows = records[provider].limits.windows;
            const shortest = windows.reduce((selected, window) =>
                window.durationMinutes < selected.durationMinutes ? window : selected);
            const longer = windows.find(window => window.durationMinutes > shortest.durationMinutes);
            const original = [shortest.usedPercent, longer.usedPercent];
            settings.set_string('default-provider', provider);
            shortest.usedPercent = 0;
            longer.usedPercent = 100;
            indicator.render();
            await this._wait();
            assert(indicator._panelReadout.valueLabel.text === '0%',
                `${provider}: panel did not prefer the freshly reset short window`);
            shortest.usedPercent = 100;
            longer.usedPercent = 0;
            indicator.render();
            await this._wait();
            assert(indicator._panelReadout.valueLabel.text === '100%',
                `${provider}: panel dropped the exhausted short window`);
            [shortest.usedPercent, longer.usedPercent] = original;
        }
        settings.set_string('default-provider', 'codex');
        indicator.menu.open(0);
        await this._wait();
        await this._screenshot('collapsed');
        const providerTabs = matching(indicator._contentBox, 'usagebeam-provider-tab');
        assert(providerTabs.length === 3, 'Expected one provider tab per enabled provider');
        assert(providerTabs.filter(tab => tab.checked).length === 1,
            'Provider selector must expose exactly one active tab');
        const disclosure = matching(indicator._contentBox, 'usagebeam-disclosure')[0];
        assert(disclosure.height / St.ThemeContext.get_for_stage(global.stage).scale_factor <= 32,
            `Activity disclosure is not compact: ${disclosure.height}px`);
        disclosure.emit('clicked', 1);
        await this._wait();
        assert(indicator._detailsExpanded, 'Activity button did not expand');
        const content = indicator._contentBox;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const initial = bounds(indicator.menu.actor);
        assert(initial.height / scale < 720 * textScale, `Expanded menu too tall: ${initial.height / scale}`);
        assert(!descendants(content).some(actor => actor instanceof St.ScrollView), 'Activity is scrollable');
        const models = matching(content, 'usagebeam-model-row');
        assert(models.length === 3, 'Expected three synthetic models');
        for (const actor of models) {
            assert(actor.height / scale >= 22 && actor.height / scale <= 36 * textScale,
                `Model row height is not compact: ${actor.height / scale}`);
            const [name, total] = actor.get_children();
            assert(name instanceof St.Label && total instanceof St.Label,
                'Model row must contain its name and token total');
            assert(actor.accessible_name.includes('tokens. Input'), 'Model token breakdown is not accessible');
            assert(Math.abs(bounds(total).x + total.width - bounds(actor).x - actor.width) <= 1,
                'Model total is not right-aligned');
        }
        assert(matching(content, 'usagebeam-model-track').length === 0, 'Model progress tracks remain');
        const plots = matching(content, 'usagebeam-chart-plot');
        assert(plots.length === 7, 'Expected seven chart columns');
        for (const plot of plots) {
            assert(plot.height / scale === 52, `Unexpected chart height: ${plot.height / scale}`);
            assert(plot._fill.visible === (plot._fraction > 0), 'Incorrect zero/nonzero bar visibility');
            if (plot._fraction > 0)
                assert(plot._fill.width > 0 && plot._fill.height > 0, 'Daily bar has no area');
        }
        for (const window of matching(content, 'usagebeam-window')) {
            const [row, track, reset] = window.get_children();
            const percent = matching(row, 'usagebeam-limit-percent')[0];
            assert(!percent.clutter_text.get_layout().is_ellipsized(), 'Quota percentage clipped');
            assert(!reset.clutter_text.get_layout().is_ellipsized(), 'Reset description clipped');
            const trackBox = bounds(track);
            const resetBox = bounds(reset);
            const valueBox = bounds(percent);
            const valueWidth = textWidth(percent);
            assert(Math.abs(valueBox.x + valueWidth - trackBox.x - trackBox.width) <= 1,
                'Quota percentage does not align with the right edge of its bar');
            assert(resetBox.y >= trackBox.y + trackBox.height && Math.abs(resetBox.x - trackBox.x) <= 1,
                'Reset description should be left-aligned below its bar');
            assert(/^Resets in \d+[dhm]/.test(reset.text), 'Reset description lacks its explanatory prefix');
        }
        const dots = matching(content, 'usagebeam-separator-dot');
        for (const dot of dots) {
            const dotBounds = bounds(dot);
            const coreBounds = bounds(dot.get_child());
            assert(Math.abs(coreBounds.x + coreBounds.width / 2 - (dotBounds.x + dotBounds.width / 2)) <= 1 &&
                Math.abs(coreBounds.y + coreBounds.height / 2 - (dotBounds.y + dotBounds.height / 2)) <= 1,
            'Separator dot is not optically centered');
        }
        const limitName = matching(content, 'usagebeam-limit-name')[0];
        const limitValue = matching(content, 'usagebeam-limit-percent')[0];
        assert(limitValue.get_theme_node().get_font().get_size() <
            limitName.get_theme_node().get_font().get_size(), 'Limit metrics lack font hierarchy');
        assert(matching(content, 'usagebeam-disclosure-summary').length === 0,
            'Collapsed activity control should not repeat detail metadata');
        assert(matching(content, 'usagebeam-disclosure-icon').length === 1,
            'Activity control should retain its disclosure affordance');
        assert(matching(content, 'usagebeam-history-scope').length === 0,
            'Expanded activity should not repeat its local source scope');
        const todayColumns = matching(content, 'usagebeam-today');
        assert(todayColumns.length === 1,
            'Daily activity should distinguish exactly one current-day column');
        assert(matching(content, 'usagebeam-chart-bar').length === 7,
            'Every daily activity column should use the same bar style');
        for (const severity of ['caution', 'warning', 'danger']) {
            const actors = matching(content, `usagebeam-${severity}`);
            assert(actors.some(actor => actor.has_style_class_name('usagebeam-limit-percent')),
                `${severity}: percentage does not expose quota severity`);
            assert(actors.some(actor => actor.has_style_class_name('usagebeam-track')),
                `${severity}: meter does not expose quota severity`);
        }
        assert(indicator._panelReadout.valueLabel.has_style_class_name('usagebeam-danger'),
            'Panel indicator does not expose the shortest quota severity');
        const [modelName, modelTotal] = models[0].get_children();
        assert(modelTotal.get_theme_node().get_font().get_weight() ===
            modelName.get_theme_node().get_font().get_weight(), 'Model names and totals use inconsistent emphasis');
        assert(modelName.get_theme_node().get_font().get_weight() >= 600,
            'Model names are too light for surrounding content');
        const modelScope = matching(content, 'usagebeam-model-scope')[0];
        assert(modelScope.get_theme_node().get_font().get_weight() >= 600,
            'Model period and source metadata should be bold');
        const heights = models.map(actor => actor.height);
        for (let frame = 0; frame < 8; frame++) {
            content.queue_relayout();
            await this._wait(60);
            assert(Math.abs(bounds(indicator.menu.actor).height - initial.height) <= 1,
                'Menu geometry drifts on repeated layout');
            models.forEach((actor, index) => assert(actor.height === heights[index], 'Model row grows on layout'));
        }
        const font = content.get_theme_node().get_font().to_string();
        const expectedFont = GLib.getenv('USAGEBEAM_EXPECTED_FONT');
        assert(expectedFont && font.includes(expectedFont),
            `Configured system font ${expectedFont} was overridden: ${font}`);
        const originalColorScheme = interfaceSettings.get_string('color-scheme');
        try {
            for (const variant of ['dark', 'light', 'dark']) {
                interfaceSettings.set_string('color-scheme', `prefer-${variant}`);
                await this._wait();
                this._checkMenuSurface(indicator, variant);
                await this._screenshot(`expanded-${variant}`);
            }
        } finally {
            interfaceSettings.set_string('color-scheme', originalColorScheme);
        }
        settings.set_string('default-provider', 'opencode');
        await this._wait();
        assert(indicator._panelReadout.valueLabel.text === '109.2M' && indicator._panelReadout.resetLabel.text === '7d',
            'OpenCode panel must show local tokens and period');
        assert(matching(indicator._contentBox, 'usagebeam-window').length === 0,
            'OpenCode must not fabricate quota meters');
        this._checkPanelSpacing(indicator, calendar, 'right-of-calendar', textScale);
        await this._screenshot('opencode');
        indicator.menu.close(0);
        return {placement, expanded: initial, modelHeights: heights,
            font, scale, monitorScale, textScale};
    }

    disable() {
        for (const [id, reject] of this._timers) {
            GLib.source_remove(id);
            reject(new Error('UI check disabled before completion'));
        }
        this._timers.clear();
    }
}

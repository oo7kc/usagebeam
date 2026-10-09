// Runs only in the synthetic private desktop; never imported by the product.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const descendants = actor => [actor, ...actor.get_children().flatMap(descendants)];
const matching = (actor, style) => descendants(actor).filter(child => child.has_style_class_name?.(style));
const bounds = actor => {
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    return {x, y, width, height};
};
const copy = value => JSON.parse(JSON.stringify(value));

export async function runStress({indicator, records, settings, calendar, wait, screenshot,
    checkPanel, monitorScale, textScale}) {
    const checks = [];
    const geometry = [];
    const check = (name, ok, details = {}) => checks.push({name, ok: Boolean(ok), ...details});
    const baseline = copy(records);
    const performance = {};
    const buildContent = indicator._buildContent;
    let closedBuilds = 0;
    indicator.menu.close(0);
    indicator._buildContent = function (...args) {
        closedBuilds++;
        return buildContent.apply(this, args);
    };
    const closedStart = GLib.get_monotonic_time();
    for (let iteration = 0; iteration < 100; iteration++)
        indicator.render();
    performance.closedRefresh = {milliseconds: (GLib.get_monotonic_time() - closedStart) / 1000,
        builds: closedBuilds, refreshes: 100};
    indicator._buildContent = buildContent;
    check('closed-menu refreshes do not rebuild popup actors', closedBuilds === 0);
    const work = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const textFits = actor => actor.clutter_text.get_preferred_width(-1)[1] <= actor.width + 1;
    const fit = async name => {
        // Software-rendered test desktops may not allocate a newly rebuilt
        // footer within one fixed delay. Wait for finite geometry, still
        // failing if allocation never arrives or the result exceeds the screen.
        let footer = bounds(indicator._contentBox.get_last_child());
        for (let attempt = 0; attempt < 25 && !Object.values(footer).every(Number.isFinite); attempt++) {
            await wait(20);
            footer = bounds(indicator._contentBox.get_last_child());
        }
        const popup = bounds(indicator.menu.actor);
        const inside = rect => rect.x >= work.x - 1 && rect.y >= work.y - 1 &&
            rect.x + rect.width <= work.x + work.width + 1 &&
            rect.y + rect.height <= work.y + work.height + 1;
        check(`${name}: popup and footer fit work area`, inside(popup) && inside(footer), {popup, footer});
        geometry.push({name, popup, footer});
    };

    for (const position of ['left', 'right', 'left-of-calendar', 'right-of-calendar']) {
        settings.set_string('panel-position', position);
        settings.set_string('default-provider', 'codex');
        await wait(150);
        const clock = bounds(calendar);
        const slot = bounds(indicator.container);
        for (const provider of ['claude', 'opencode', 'codex']) {
            settings.set_string('default-provider', provider);
            await wait(100);
            check(`${position}/${provider}: clock and slot stable`,
                Math.abs(bounds(calendar).x - clock.x) <= 1 &&
                Math.abs(bounds(indicator.container).width - slot.width) <= 1,
                {clockOffset: bounds(calendar).x - clock.x,
                    widthChange: bounds(indicator.container).width - slot.width});
            check(`${position}/${provider}: panel labels fit`,
                [indicator._panelReadout.providerLabel, indicator._panelReadout.valueLabel, indicator._panelReadout.resetLabel].every(textFits));
            checkPanel(position);
        }
        if (position.includes('calendar')) {
            const monitor = Main.layoutManager.findMonitorForActor(Main.panel);
            const center = (Math.min(slot.x, clock.x) + Math.max(slot.x + slot.width, clock.x + clock.width)) / 2;
            check(`${position}: combined group centered`, Math.abs(center - monitor.x - monitor.width / 2) <= 1,
                {groupCenter: center, monitorCenter: monitor.x + monitor.width / 2});
        }
        indicator.menu.open(0);
        await wait(100);
        await fit(`${position}/collapsed`);
        indicator.menu.close(0);
    }
    indicator.menu.open(0);
    matching(indicator._contentBox, 'usagebeam-disclosure')[0].emit('clicked', 1);
    await wait(150);
    await fit('expanded');
    const normalHeight = bounds(indicator.menu.actor).height;
    const actorCount = descendants(indicator._contentBox).length;
    await screenshot('stress-expanded');
    const plots = matching(indicator._contentBox, 'usagebeam-chart-plot');
    check('seven daily bars allocate correctly', plots.length === 7 && plots.every(plot =>
        plot.height / scale === 52 && (plot._fraction === 0 || (plot._fill.width > 0 && plot._fill.height > 0))));
    check('activity has no nested scrolling', !descendants(indicator._contentBox).some(actor => actor instanceof St.ScrollView));
    const modelRows = matching(indicator._contentBox, 'usagebeam-model-row');
    check('model totals use two-column rows without progress tracks',
        matching(indicator._contentBox, 'usagebeam-model-track').length === 0 &&
        modelRows.every(row => row.get_children().length === 2));
    for (let iteration = 0; iteration < 100; iteration++) {
        settings.set_string('default-provider', ['codex', 'claude', 'opencode'][iteration % 3]);
        indicator.render();
        matching(indicator._contentBox, 'usagebeam-disclosure')[0].emit('clicked', 1);
        matching(indicator._contentBox, 'usagebeam-disclosure')[0].emit('clicked', 1);
        await wait(16);
    }
    // Rendering queues allocation; measure only after the final layout has settled.
    await wait(150);
    check('100 refresh/switch/expand cycles retain actor count', descendants(indicator._contentBox).length === actorCount);
    const finalHeight = bounds(indicator.menu.actor).height;
    check('100 refresh/switch/expand cycles retain height', Math.abs(finalHeight - normalHeight) <= 1,
        {initialHeight: normalHeight, finalHeight});

    settings.set_string('default-provider', 'opencode');
    await wait(100);
    const openCodeWidth = bounds(indicator.container).width;
    for (const total of [0, 999, 999949, 999999, 999949999, 999999999, Number.MAX_SAFE_INTEGER]) {
        records.opencode = copy(baseline.opencode);
        records.opencode.history.days = records.opencode.history.days.map((day, index) =>
            ({...day, total: index === 0 ? total : 0}));
        indicator.render();
        await wait(40);
        check(`opencode-${total}: panel width remains reserved`,
            Math.abs(bounds(indicator.container).width - openCodeWidth) <= 1);
        checkPanel('right-of-calendar');
    }
    for (const state of ['ready', 'stale', 'partial', 'unavailable', 'unsupported']) {
        records.opencode = copy(baseline.opencode);
        records.opencode.history.status = state;
        if (['unavailable', 'unsupported'].includes(state)) {
            records.opencode.history.days = [];
            records.opencode.history.models = [];
            records.opencode.history.period = null;
        }
        indicator.render();
        await wait(70);
        await fit(`opencode-${state}`);
        check(`opencode-${state}: no fabricated quota`,
            !indicator._panelReadout.valueLabel.text.includes('%') &&
            matching(indicator._contentBox, 'usagebeam-window').length === 0);
        checkPanel('right-of-calendar');
    }
    records.opencode = copy(baseline.opencode);
    settings.set_string('default-provider', 'codex');

    for (const state of ['loading', 'unavailable', 'missing-auth', 'unsupported', 'stale', 'partial']) {
        records.codex = copy(baseline.codex);
        records.codex.limits.status = state;
        records.codex.history.status = state;
        records.codex.limits.message = 'Synthetic provider state; no account was contacted.';
        records.codex.history.message = 'Synthetic local history state.';
        if (!['stale', 'partial'].includes(state))
            records.codex.limits.windows = [];
        indicator.render();
        await wait(70);
        await fit(state);
        check(`${state}: panel text fits`, [indicator._panelReadout.valueLabel, indicator._panelReadout.resetLabel].every(textFits));
    }

    records.codex = copy(baseline.codex);
    records.codex.plan = 'A long synthetic subscription plan '.repeat(2);
    records.codex.limits.windows[0].label = 'A provider-specific allowance with an unusually long display name';
    records.codex.history.models[0].model = 'synthetic-model-with-a-very-long-name-and-preview-version-2026';
    indicator.render();
    await wait(100);
    await fit('long-labels');
    check('long labels retain bounded popup width', bounds(indicator.menu.actor).width <= work.width);

    records.codex = copy(baseline.codex);
    records.codex.limits.windows = Array.from({length: 32}, (_, index) =>
        ({...baseline.codex.limits.windows[0], id: `synthetic-${index}`, label: `Allowance ${index + 1}`}));
    indicator.render();
    await wait(100);
    await fit('maximum-32-allowances');
    const seenAllowances = new Set();
    for (let page = 0; page < 32; page++) {
        matching(indicator._contentBox, 'usagebeam-limit-name').forEach(actor => seenAllowances.add(actor.text));
        const next = descendants(indicator._contentBox).find(actor =>
            actor.accessible_name === 'Next limits page' && actor.reactive);
        if (!next)
            break;
        next.grab_key_focus();
        next.emit('clicked', 1);
        await wait(60);
        await fit(`allowances-page-${page + 2}`);
    }
    check('all 32 allowances reachable without scrolling', seenAllowances.size === 32, {seen: seenAllowances.size});
    check('quota pagination retains keyboard focus', Boolean(global.stage.get_key_focus()?.can_focus));
    records.codex = copy(baseline.codex);
    records.codex.history.models = Array.from({length: 12}, (_, index) =>
        ({...baseline.codex.history.models[0], model: `synthetic-model-${index + 1}`}));
    indicator._limitPage = 0;
    indicator._sectionPage = 1;
    indicator._activityPage = 1;
    indicator.render();
    await wait(100);
    const seenModels = new Set();
    for (let page = 0; page < 12; page++) {
        matching(indicator._contentBox, 'usagebeam-model-name').forEach(actor => seenModels.add(actor.text));
        const next = descendants(indicator._contentBox).find(actor =>
            actor.accessible_name === 'Next models page' && actor.reactive);
        if (!next)
            break;
        next.emit('clicked', 1);
        await wait(60);
        await fit(`models-page-${page + 2}`);
    }
    check('all model pages reachable without scrolling', seenModels.size === 12, {seen: seenModels.size});
    indicator._activityPage = indicator._modelPage = 0;
    records.codex = copy(baseline.codex);
    indicator.render();
    await wait(100);
    indicator.menu.actor.remove_style_class_name('usagebeam-dark');
    indicator.menu.actor.add_style_class_name('usagebeam-light');
    await wait(100);
    await fit('light-theme');
    await screenshot('stress-light');
    indicator.menu.close(0);

    // Other center-panel extensions must not invalidate our alignment math.
    const neighbor = new St.Bin({width: 80, height: 20});
    Main.panel._centerBox.add_child(neighbor);
    try {
        for (const position of ['left-of-calendar', 'right-of-calendar']) {
            settings.set_string('panel-position', position);
            await wait(100);
            const slot = bounds(indicator.container);
            const clock = bounds(calendar);
            const monitor = Main.layoutManager.findMonitorForActor(Main.panel);
            const center = (Math.min(slot.x, clock.x) + Math.max(slot.x + slot.width, clock.x + clock.width)) / 2;
            check(`${position}: centered with neighboring extension`, Math.abs(center - monitor.x - monitor.width / 2) <= 1,
                {offset: center - monitor.x - monitor.width / 2});
            neighbor.width = 120;
            await wait(100);
            const afterSlot = bounds(indicator.container);
            const afterClock = bounds(calendar);
            const afterCenter = (Math.min(afterSlot.x, afterClock.x) +
                Math.max(afterSlot.x + afterSlot.width, afterClock.x + afterClock.width)) / 2;
            check(`${position}: neighboring resize remains centered`, Math.abs(afterCenter - monitor.x - monitor.width / 2) <= 1);
            neighbor.width = 80;
        }
    } finally {
        neighbor.destroy();
    }
    const panelMonitor = Main.layoutManager.findMonitorForActor(Main.panel);
    const checkGroupCenter = name => {
        const slot = bounds(indicator.container);
        const clock = bounds(calendar);
        const center = (Math.min(slot.x, clock.x) + Math.max(slot.x + slot.width, clock.x + clock.width)) / 2;
        const monitor = Main.layoutManager.findMonitorForActor(Main.panel);
        check(name, Math.abs(center - monitor.x - monitor.width / 2) <= 1,
            {groupCenter: center, monitorCenter: monitor.x + monitor.width / 2});
    };
    const originalDirection = Main.panel._centerBox.get_text_direction();
    try {
        Main.panel._centerBox.set_text_direction(Clutter.TextDirection.RTL);
        await wait(150);
        checkGroupCenter('right-to-left allocation keeps the combined group centered');
    } finally {
        Main.panel._centerBox.set_text_direction(originalDirection);
    }
    const dock = new St.Widget({x: panelMonitor.x, y: panelMonitor.y + Main.panel.height,
        width: 48, height: panelMonitor.height - Main.panel.height});
    Main.layoutManager.addChrome(dock, {affectsStruts: true, trackFullscreen: false});
    try {
        await wait(250);
        check('synthetic left dock offsets the work area',
            Main.layoutManager.getWorkAreaForMonitor(panelMonitor.index).x > panelMonitor.x);
        checkGroupCenter('left dock does not move the pair away from monitor center');
        dock.x = panelMonitor.x + panelMonitor.width - dock.width;
        await wait(250);
        checkGroupCenter('right dock does not move the pair away from monitor center');
    } finally {
        Main.layoutManager.removeChrome(dock);
        dock.destroy();
    }
    await wait(150);
    checkGroupCenter('removing a dock restores the centered group');
    return {ok: checks.every(result => result.ok), checks, geometry,
        workArea: {x: work.x, y: work.y, width: work.width, height: work.height}, monitorScale, textScale, performance};
}

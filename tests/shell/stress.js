// Runs only in the synthetic private desktop; never imported by the product.
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
    const work = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const textFits = actor => actor.clutter_text.get_preferred_width(-1)[1] <= actor.width + 1;
    const fit = name => {
        const popup = bounds(indicator.menu.actor);
        const footer = bounds(indicator._contentBox.get_last_child());
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
        for (const provider of ['claude', 'codex']) {
            settings.set_string('default-provider', provider);
            await wait(100);
            check(`${position}/${provider}: clock and slot stable`,
                Math.abs(bounds(calendar).x - clock.x) <= 1 &&
                Math.abs(bounds(indicator.container).width - slot.width) <= 1);
            check(`${position}/${provider}: panel labels fit`,
                [indicator._panelProvider, indicator._panelValue, indicator._panelReset].every(textFits));
            checkPanel(position);
        }
        if (position.includes('calendar')) {
            const panel = bounds(Main.panel);
            const left = position === 'left-of-calendar' ? slot : clock;
            const right = position === 'left-of-calendar' ? clock : slot;
            const center = (left.x + left.width + right.x) / 2;
            check(`${position}: gap centered`, Math.abs(center - panel.x - panel.width / 2) <= 1);
        }
        indicator.menu.open(0);
        await wait(100);
        fit(`${position}/collapsed`);
        indicator.menu.close(0);
    }
    indicator.menu.open(0);
    matching(indicator._contentBox, 'usagebeam-disclosure')[0].emit('clicked', 1);
    await wait(150);
    fit('expanded');
    const normalHeight = bounds(indicator.menu.actor).height;
    const actorCount = descendants(indicator._contentBox).length;
    await screenshot('stress-expanded');
    const plots = matching(indicator._contentBox, 'usagebeam-chart-plot');
    check('seven daily bars allocate correctly', plots.length === 7 && plots.every(plot =>
        plot.height / scale === 52 && (plot._fraction === 0 || (plot._fill.width > 0 && plot._fill.height > 0))));
    check('activity has no nested scrolling', !descendants(indicator._contentBox).some(actor => actor instanceof St.ScrollView));
    const modelTracks = matching(indicator._contentBox, 'usagebeam-model-track');
    check('visible model totals use compact progress tracks', (modelTracks.length === 0 || modelTracks.length === 3) &&
        modelTracks.every(track => track.height / scale === 3 && track._fill.width > 0));
    for (let iteration = 0; iteration < 100; iteration++) {
        settings.set_string('default-provider', iteration % 2 ? 'codex' : 'claude');
        indicator.render();
        matching(indicator._contentBox, 'usagebeam-disclosure')[0].emit('clicked', 1);
        matching(indicator._contentBox, 'usagebeam-disclosure')[0].emit('clicked', 1);
        await wait(16);
    }
    check('100 refresh/switch/expand cycles retain actor count', descendants(indicator._contentBox).length === actorCount);
    check('100 refresh/switch/expand cycles retain height', Math.abs(bounds(indicator.menu.actor).height - normalHeight) <= 1);

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
        fit(state);
        check(`${state}: panel text fits`, [indicator._panelValue, indicator._panelReset].every(textFits));
    }

    records.codex = copy(baseline.codex);
    records.codex.plan = 'A long synthetic subscription plan '.repeat(2);
    records.codex.limits.windows[0].label = 'A provider-specific allowance with an unusually long display name';
    records.codex.history.models[0].model = 'synthetic-model-with-a-very-long-name-and-preview-version-2026';
    indicator.render();
    await wait(100);
    fit('long-labels');
    check('long labels retain bounded popup width', bounds(indicator.menu.actor).width <= work.width);

    records.codex = copy(baseline.codex);
    records.codex.limits.windows = Array.from({length: 32}, (_, index) =>
        ({...baseline.codex.limits.windows[0], id: `synthetic-${index}`, label: `Allowance ${index + 1}`}));
    indicator.render();
    await wait(100);
    fit('maximum-32-allowances');
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
        fit(`allowances-page-${page + 2}`);
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
        fit(`models-page-${page + 2}`);
    }
    check('all model pages reachable without scrolling', seenModels.size === 12, {seen: seenModels.size});
    indicator._activityPage = indicator._modelPage = 0;
    records.codex = copy(baseline.codex);
    indicator.render();
    await wait(100);
    indicator.menu.actor.remove_style_class_name('usagebeam-dark');
    indicator.menu.actor.add_style_class_name('usagebeam-light');
    await wait(100);
    fit('light-theme');
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
            const panel = bounds(Main.panel);
            const center = position === 'left-of-calendar' ? (slot.x + slot.width + clock.x) / 2
                : (clock.x + clock.width + slot.x) / 2;
            check(`${position}: centered with neighboring extension`, Math.abs(center - panel.x - panel.width / 2) <= 1,
                {offset: center - panel.x - panel.width / 2});
            neighbor.width = 120;
            await wait(100);
            const afterSlot = bounds(indicator.container);
            const afterClock = bounds(calendar);
            const afterCenter = position === 'left-of-calendar' ? (afterSlot.x + afterSlot.width + afterClock.x) / 2
                : (afterClock.x + afterClock.width + afterSlot.x) / 2;
            check(`${position}: neighboring resize remains centered`, Math.abs(afterCenter - panel.x - panel.width / 2) <= 1);
            neighbor.width = 80;
        }
    } finally {
        neighbor.destroy();
    }
    return {ok: checks.every(result => result.ok), checks, geometry,
        workArea: {x: work.x, y: work.y, width: work.width, height: work.height}, monitorScale, textScale};
}

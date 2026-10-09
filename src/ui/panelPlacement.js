import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {getPanelBalance} from './panelGeometry.js';

const CALENDAR_POSITIONS = new Set(['left-of-calendar', 'right-of-calendar']);

export function clearIndicatorPlacement(indicator) {
    const state = indicator?._usageBeamPlacement;
    if (!state)
        return;
    if (state.pendingUpdate)
        GLib.source_remove(state.pendingUpdate);
    for (const [actor, signal] of state.signals)
        actor.disconnect(signal);
    for (const spacer of state.spacers)
        spacer.destroy();
    delete indicator._usageBeamPlacement;
}

function centerCalendarGroup(indicator, calendar, target, position) {
    // GNOME centers the entire box in its work area. Balance other extensions
    // around our pair and compensate for side docks that offset that work area.
    const leading = new St.Widget({style_class: 'usagebeam-center-balance'});
    const trailing = new St.Widget({style_class: 'usagebeam-center-balance'});
    const leftIsIndicator = position === 'left-of-calendar';
    const state = {signals: [], spacers: [leading, trailing], pendingUpdate: 0};
    const signalsByActor = new Map();
    const synchronizeGroup = () => {
        const children = target.get_children().filter(actor => actor.visible);
        const widths = children.map(actor => state.spacers.includes(actor) ? 0 : actor.get_preferred_width(-1)[1]);
        const indicatorIndex = children.indexOf(indicator.container);
        const calendarIndex = children.indexOf(calendar);
        if (indicatorIndex < 0 || calendarIndex < 0)
            return;
        const monitor = Main.layoutManager.findMonitorForActor(Main.panel);
        const workArea = monitor && Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const balance = getPanelBalance({
            widths,
            spacing: target.get_theme_node().get_length('spacing'),
            firstIndex: Math.min(indicatorIndex, calendarIndex),
            lastIndex: Math.max(indicatorIndex, calendarIndex),
            centerOffset: workArea ? 2 * (workArea.x - monitor.x) + workArea.width - monitor.width : 0,
            rtl: target.get_text_direction() === Clutter.TextDirection.RTL,
        });
        if (leading.width !== balance.leading)
            leading.set_width(balance.leading);
        if (trailing.width !== balance.trailing)
            trailing.set_width(balance.trailing);
    };
    const queueUpdate = () => {
        // Theme and allocation signals can arrive together. Rebalance outside
        // allocation so measuring siblings never recursively changes layout.
        if (state.pendingUpdate)
            return;
        state.pendingUpdate = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            state.pendingUpdate = 0;
            synchronizeGroup();
            return GLib.SOURCE_REMOVE;
        });
    };
    const calendarIndex = target.get_children().indexOf(calendar);
    target.insert_child_at_index(leading, calendarIndex);
    target.insert_child_at_index(indicator.container, calendarIndex + (leftIsIndicator ? 1 : 2));
    target.insert_child_at_index(trailing, calendarIndex + 3);
    const observeNeighbors = () => {
        const children = target.get_children().filter(actor => !state.spacers.includes(actor));
        for (const [actor, signals] of signalsByActor) {
            if (children.includes(actor))
                continue;
            for (const signal of signals) {
                actor.disconnect(signal);
                state.signals = state.signals.filter(pair => pair[0] !== actor || pair[1] !== signal);
            }
            signalsByActor.delete(actor);
        }
        for (const actor of children) {
            if (signalsByActor.has(actor))
                continue;
            const signals = ['notify::width', 'notify::visible'].map(name => actor.connect(name, queueUpdate));
            signalsByActor.set(actor, signals);
            state.signals.push(...signals.map(signal => [actor, signal]));
        }
        queueUpdate();
    };
    for (const signal of ['child-added', 'child-removed'])
        state.signals.push([target, target.connect(signal, observeNeighbors)]);
    for (const [object, signal] of [
        [target, 'notify::allocation'],
        [target, 'style-changed'],
        [Main.layoutManager, 'monitors-changed'],
        [global.display, 'workareas-changed'],
        [St.ThemeContext.get_for_stage(global.stage), 'changed'],
    ])
        state.signals.push([object, object.connect(signal, queueUpdate)]);
    indicator._usageBeamPlacement = state;
    observeNeighbors();
}

export function placeIndicator(indicator, position) {
    clearIndicatorPlacement(indicator);
    const container = indicator.container;
    const calendar = Main.panel.statusArea.dateMenu?.container;
    const boxes = {left: Main.panel._leftBox, right: Main.panel._rightBox};
    const resolved = CALENDAR_POSITIONS.has(position) || position in boxes
        ? position : 'right-of-calendar';
    const besideCalendar = CALENDAR_POSITIONS.has(resolved);
    const target = besideCalendar ? calendar?.get_parent() ?? Main.panel._centerBox : boxes[resolved];
    container.get_parent()?.remove_child(container);
    if (besideCalendar && calendar) {
        centerCalendarGroup(indicator, calendar, target, resolved);
        return;
    }
    const siblings = target.get_children();
    const index = resolved === 'right' ? 0 : siblings.length;
    target.insert_child_at_index(container, index);
}

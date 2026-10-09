import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';
import {formatCompactTokenCount} from '../core/format.js';
import {PROVIDERS} from '../core/providerRegistry.js';
import {UsageBeamProgressBar} from './bar.js';

const TAB_DIRECTIONS = new Map([
    [Clutter.KEY_Left, -1],
    [Clutter.KEY_Right, 1],
    [Clutter.KEY_Home, -Infinity],
    [Clutter.KEY_End, Infinity],
]);

export function createLabel(text, style = '', expand = false) {
    return new St.Label({text: String(text ?? ''), style_class: style,
        y_align: Clutter.ActorAlign.CENTER, x_expand: expand});
}

export function createMetricLabel(text, style = '', expand = false) {
    const actor = createLabel(text, style, expand);
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return actor;
}

export function createSeparatorDot(style = '') {
    const dot = new St.Widget({style_class: 'usagebeam-separator-dot-core'});
    return new St.Bin({
        child: dot,
        style_class: `usagebeam-separator-dot ${style}`.trim(),
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

export function createProviderIcon(provider, extensionPath, style = '') {
    if (!Object.prototype.hasOwnProperty.call(PROVIDERS, provider))
        return null;
    return new St.Icon({
        gicon: new Gio.FileIcon({
            file: Gio.File.new_for_path(`${extensionPath}/icons/${PROVIDERS[provider].icon}`),
        }),
        style_class: `usagebeam-provider-icon usagebeam-${provider}-icon ${style}`.trim(),
    });
}

export function createLimitRow(name, value, severity = null) {
    const box = new St.BoxLayout({style_class: 'usagebeam-limit-row', x_expand: true});
    const title = createLabel(name, 'usagebeam-limit-name', true);
    title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    box.add_child(title);
    box.add_child(createMetricLabel(value,
        `usagebeam-limit-percent${severity ? ` usagebeam-${severity}` : ''}`));
    return box;
}

export function createQuotaMeter(fraction, name, style = '') {
    return new UsageBeamProgressBar({fraction, name, style: `usagebeam-track ${style}`, fillStyle: 'usagebeam-fill'});
}

export function createModelRow(model, total, description) {
    const row = new St.BoxLayout({
        style_class: 'usagebeam-model-row',
        x_expand: true,
        accessible_name: description,
        accessible_role: Atk.Role.LIST_ITEM,
    });
    const title = createLabel(model, 'usagebeam-model-name', true);
    title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    row.add_child(title);
    row.add_child(createMetricLabel(total, 'usagebeam-model-total'));
    return row;
}

export function createDayChart(days, today) {
    const values = Array.isArray(days) ? days : [];
    const max = Math.max(1, ...values.map(day => day.total));
    const chart = new St.Widget({
        style_class: 'usagebeam-day-chart',
        x_expand: true,
        layout_manager: new Clutter.BoxLayout({
            homogeneous: true,
            orientation: Clutter.Orientation.HORIZONTAL,
            spacing: 6,
        }),
        accessible_name: 'Daily token activity chart',
        accessible_role: Atk.Role.PANEL,
    });
    for (const day of values) {
        const isToday = day.date === today;
        const weekday = new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, {weekday: 'short'});
        const column = new St.BoxLayout({
            vertical: true,
            style_class: `usagebeam-chart-column${isToday ? ' usagebeam-today' : ''}${day.total ? '' : ' usagebeam-empty'}`,
            x_expand: true,
            accessible_name: `${isToday ? 'Today, ' : ''}${weekday}, ${day.total} tokens, ${day.sessions ?? 0} sessions`,
        });
        column.add_child(createLabel(formatCompactTokenCount(day.total), 'usagebeam-chart-value'));
        const plot = new UsageBeamProgressBar({
            fraction: day.total / max,
            name: `${day.date}: ${day.total} tokens`,
            style: `usagebeam-chart-plot${day.total ? '' : ' usagebeam-empty'}`,
            fillStyle: 'usagebeam-chart-bar',
            vertical: true,
        });
        column.add_child(plot);
        column.add_child(createLabel(weekday, 'usagebeam-chart-day'));
        chart.add_child(column);
    }
    return chart;
}

export function createButton(text, callback, {active = false, name = text} = {}) {
    const actor = new St.Button({label: text, can_focus: true, reactive: true, track_hover: true,
        accessible_name: name, style_class: 'usagebeam-button', x_expand: true});
    if (active)
        actor.add_style_pseudo_class('checked');
    actor.connect('clicked', callback);
    return actor;
}

export function createProviderTab(text, callback, navigate, {active = false, name = text} = {}) {
    const actor = new St.Button({
        label: text,
        accessible_name: name,
        accessible_role: Atk.Role.PAGE_TAB,
        can_focus: true,
        checked: active,
        reactive: true,
        style_class: 'usagebeam-provider-tab',
        track_hover: true,
        x_expand: true,
    });
    if (active)
        actor.add_style_pseudo_class('checked');
    actor.connect('clicked', callback);
    actor.connect('key-press-event', (_button, event) => {
        const direction = TAB_DIRECTIONS.get(event.get_key_symbol());
        if (direction === undefined)
            return Clutter.EVENT_PROPAGATE;
        navigate(direction);
        return Clutter.EVENT_STOP;
    });
    return actor;
}

export function createDisclosureButton(expanded, callback) {
    const actor = new St.Button({
        accessible_name: 'Activity details',
        accessible_role: Atk.Role.TOGGLE_BUTTON,
        can_focus: true,
        checked: expanded,
        reactive: true,
        style_class: 'usagebeam-disclosure',
        toggle_mode: true,
        track_hover: true,
        x_expand: true,
    });
    const content = new St.BoxLayout({style_class: 'usagebeam-disclosure-content', x_expand: true});
    content.add_child(createLabel('Activity', 'usagebeam-disclosure-title', true));
    content.add_child(new St.Icon({
        icon_name: expanded ? 'pan-up-symbolic' : 'pan-down-symbolic',
        style_class: 'usagebeam-disclosure-icon',
    }));
    actor.set_child(content);
    actor.connect('clicked', callback);
    return actor;
}

export function createActionButton(text, callback, name = text) {
    const actor = createButton(text, callback, {name});
    actor.x_expand = false;
    actor.add_style_class_name('usagebeam-action-button');
    return actor;
}

export function createPageControls(name, page, pages, changed) {
    const row = new St.BoxLayout({style_class: 'usagebeam-pagination', x_expand: true});
    for (const direction of [-1, 0, 1]) {
        if (!direction) {
            row.add_child(createLabel(`${name} · ${page + 1} / ${pages}`, 'usagebeam-page-label', true));
            continue;
        }
        const control = createActionButton(direction < 0 ? '‹' : '›', () => changed(page + direction),
            `${direction < 0 ? 'Previous' : 'Next'} ${name.toLowerCase()} page`);
        control.reactive = page + direction >= 0 && page + direction < pages;
        control.can_focus = control.reactive;
        if (!control.reactive)
            control.add_style_pseudo_class('insensitive');
        row.add_child(control);
    }
    return row;
}

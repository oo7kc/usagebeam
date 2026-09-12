import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import {NAMES, orderedEnabledProviders, providerOrder} from '../core/usage.js';

const POSITIONS = Object.freeze(['left', 'right', 'left-of-calendar', 'right-of-calendar']);
const POSITION_NAMES = Object.freeze(['Left panel', 'Right panel', 'Left of calendar', 'Right of calendar']);

function moveButton(icon, tooltip, enabled, callback) {
    const button = new Gtk.Button({icon_name: icon, tooltip_text: tooltip, sensitive: enabled,
        valign: Gtk.Align.CENTER, css_classes: ['flat', 'circular']});
    button.connect('clicked', callback);
    return button;
}

function providerGroup(page, settings, signals) {
    const group = new Adw.PreferencesGroup({title: 'Providers',
        description: 'Choose which providers appear and how they are ordered'});
    page.add(group);
    let rows = [];
    let defaultRow = null;
    let syncing = false;

    const enabled = () => orderedEnabledProviders(settings.get_strv('enabled-providers'),
        settings.get_strv('provider-order'));
    const render = () => {
        syncing = true;
        if (defaultRow)
            group.remove(defaultRow);
        rows.forEach(row => group.remove(row));
        rows = [];
        const order = providerOrder(settings.get_strv('provider-order'));
        const selected = new Set(settings.get_strv('enabled-providers'));
        order.forEach((id, index) => {
            const row = new Adw.SwitchRow({title: NAMES[id],
                subtitle: 'Account limits and local activity', active: selected.has(id)});
            row.add_suffix(moveButton('go-up-symbolic', `Move ${NAMES[id]} up`, index > 0, () => {
                const next = [...order];
                [next[index - 1], next[index]] = [next[index], next[index - 1]];
                settings.set_strv('provider-order', next);
            }));
            row.add_suffix(moveButton('go-down-symbolic', `Move ${NAMES[id]} down`, index < order.length - 1, () => {
                const next = [...order];
                [next[index], next[index + 1]] = [next[index + 1], next[index]];
                settings.set_strv('provider-order', next);
            }));
            row.connect('notify::active', () => {
                if (syncing)
                    return;
                const next = new Set(settings.get_strv('enabled-providers'));
                if (row.active)
                    next.add(id);
                else
                    next.delete(id);
                const ordered = order.filter(provider => next.has(provider));
                settings.set_strv('enabled-providers', ordered);
                if (ordered.length && !next.has(settings.get_string('default-provider')))
                    settings.set_string('default-provider', ordered[0]);
            });
            group.add(row);
            rows.push(row);
        });
        if (defaultRow)
            group.add(defaultRow);
        syncing = false;
    };
    render();
    signals.push(settings.connect('changed::provider-order', render));
    signals.push(settings.connect('changed::enabled-providers', render));

    defaultRow = new Adw.ComboRow({title: 'Default provider',
        subtitle: 'Shown when UsageBeam starts'});
    let syncingDefault = false;
    const syncDefault = () => {
        syncingDefault = true;
        const providers = enabled();
        defaultRow.model = Gtk.StringList.new(providers.length
            ? providers.map(id => NAMES[id]) : ['No provider enabled']);
        defaultRow.sensitive = providers.length > 0;
        const selected = providers.indexOf(settings.get_string('default-provider'));
        defaultRow.selected = Math.max(0, selected);
        syncingDefault = false;
    };
    defaultRow.connect('notify::selected', () => {
        if (syncingDefault)
            return;
        const providers = enabled();
        if (providers[defaultRow.selected])
            settings.set_string('default-provider', providers[defaultRow.selected]);
    });
    for (const key of ['enabled-providers', 'provider-order', 'default-provider'])
        signals.push(settings.connect(`changed::${key}`, syncDefault));
    syncDefault();
    group.add(defaultRow);
}

function panelGroup(page, settings, signals) {
    const group = new Adw.PreferencesGroup({title: 'Panel'});
    page.add(group);
    const positionRow = new Adw.ComboRow({title: 'Panel position',
        subtitle: 'Choose a side area or place usage beside the calendar',
        model: Gtk.StringList.new(POSITION_NAMES)});
    let syncing = false;
    const syncPosition = () => {
        syncing = true;
        const selected = POSITIONS.indexOf(settings.get_string('panel-position'));
        positionRow.selected = selected >= 0 ? selected : 3;
        syncing = false;
    };
    positionRow.connect('notify::selected', () => {
        if (!syncing)
            settings.set_string('panel-position', POSITIONS[positionRow.selected]);
    });
    signals.push(settings.connect('changed::panel-position', syncPosition));
    syncPosition();
    group.add(positionRow);

    const intervalRow = new Adw.SpinRow({title: 'Refresh interval',
        subtitle: 'Seconds between automatic usage checks',
        adjustment: new Gtk.Adjustment({lower: 30, upper: 3600, step_increment: 10, page_increment: 60})});
    settings.bind('refresh-interval', intervalRow, 'value', 0);
    group.add(intervalRow);
}

function alertsGroup(page, window, settings, clearData) {
    const group = new Adw.PreferencesGroup({title: 'Alerts &amp; Data'});
    page.add(group);
    const notifyRow = new Adw.SwitchRow({title: 'Usage notifications',
        subtitle: 'Alert once when each warning milestone is reached'});
    settings.bind('notifications-enabled', notifyRow, 'active', 0);
    group.add(notifyRow);
    const thresholdRow = new Adw.SpinRow({title: 'First warning',
        subtitle: 'Usage percentage for the first notification',
        adjustment: new Gtk.Adjustment({lower: 50, upper: 100, step_increment: 5, page_increment: 10})});
    settings.bind('notification-threshold', thresholdRow, 'value', 0);
    settings.bind('notifications-enabled', thresholdRow, 'sensitive', 0);
    group.add(thresholdRow);
    const retentionRow = new Adw.SpinRow({title: 'History retention',
        subtitle: 'Days of derived activity metadata to keep',
        adjustment: new Gtk.Adjustment({lower: 7, upper: 90, step_increment: 1, page_increment: 7})});
    settings.bind('history-retention-days', retentionRow, 'value', 0);
    group.add(retentionRow);

    const clearRow = new Adw.ActionRow({title: 'Clear saved usage',
        subtitle: 'Remove UsageBeam data without touching provider history'});
    const clearButton = new Gtk.Button({label: 'Clear…', valign: Gtk.Align.CENTER,
        css_classes: ['destructive-action']});
    clearButton.connect('clicked', () => {
        const dialog = new Adw.AlertDialog({heading: 'Clear saved UsageBeam data?',
            body: 'Account snapshots and derived history caches will be removed. Provider history remains unchanged.'});
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('clear', 'Clear Data');
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');
        dialog.set_response_appearance('clear', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', (_dialog, response) => {
            if (response !== 'clear')
                return;
            const removed = clearData();
            settings.set_uint('clear-data-generation',
                (settings.get_uint('clear-data-generation') + 1) >>> 0);
            clearRow.subtitle = removed
                ? 'Saved data cleared; activity rebuilds on the next refresh'
                : 'No saved UsageBeam data was present';
        });
        dialog.present(window);
    });
    clearRow.add_suffix(clearButton);
    group.add(clearRow);
}

export function buildPreferencesWindow(window, settings, clearData) {
    const page = new Adw.PreferencesPage();
    const signals = [];
    providerGroup(page, settings, signals);
    panelGroup(page, settings, signals);
    alertsGroup(page, window, settings, clearData);
    window.add(page);
    window.connect('close-request', () => {
        signals.splice(0).forEach(id => settings.disconnect(id));
        return false;
    });
    return page;
}

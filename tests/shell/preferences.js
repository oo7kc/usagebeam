// Builds the packaged preferences UI against an isolated in-memory schema.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

const assert = (condition, message) => {
    if (!condition)
        throw new Error(message);
};

function descendants(widget) {
    const values = [widget];
    for (let child = widget.get_first_child?.(); child; child = child.get_next_sibling())
        values.push(...descendants(child));
    return values;
}

Gtk.init();
Adw.init();
const extensionPath = GLib.getenv('USAGEBEAM_INSTALL_PATH');
assert(extensionPath, 'Preferences smoke test requires the packaged extension path');
const moduleUri = Gio.File.new_for_path(`${extensionPath}/src/ui/preferences.js`).get_uri();
const {buildPreferencesWindow} = await import(moduleUri);
const settings = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.usagebeam'});
const window = new Adw.PreferencesWindow();
const page = buildPreferencesWindow(window, settings, () => 0);

let widgets = descendants(page);
assert(widgets.filter(widget => widget instanceof Adw.PreferencesGroup).length === 3,
    'Preferences must retain three focused groups');
assert(widgets.filter(widget => widget instanceof Adw.SwitchRow).length === 3,
    'Preferences must expose two providers and notification control');
assert(widgets.filter(widget => widget instanceof Adw.SpinRow).length === 3,
    'Preferences must expose refresh, warning and retention controls');

settings.set_strv('provider-order', ['claude', 'codex']);
settings.set_strv('enabled-providers', ['claude']);
while (GLib.MainContext.default().iteration(false));
widgets = descendants(page);
const providers = widgets.filter(widget => widget instanceof Adw.SwitchRow &&
    ['Claude Code', 'Codex'].includes(widget.title));
assert(providers.map(row => row.title).join(',') === 'Claude Code,Codex',
    'Provider rows must follow the configured order');
const defaultRow = widgets.find(widget => widget instanceof Adw.ComboRow &&
    widget.title === 'Default provider');
assert(defaultRow?.model?.get_n_items() === 1,
    'Default-provider choices must include enabled providers only');

window.destroy();
print('PASS: packaged preferences construct and react to provider settings');

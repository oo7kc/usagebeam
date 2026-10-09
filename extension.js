import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {formatNotificationBody} from './src/core/notifications.js';
import {UsageBeamIndicator} from './src/ui/indicator.js';
import {clearIndicatorPlacement, placeIndicator} from './src/ui/panelPlacement.js';
import {migrateLegacyInstall} from './src/services/migration.js';
import {UsageService} from './src/services/usageService.js';

export default class UsageBeamExtension extends Extension {
    enable() {
        this._settings = this.getSettings('org.gnome.shell.extensions.usagebeam');
        migrateLegacyInstall(this._settings);
        this._indicator = new UsageBeamIndicator(this._settings, this.path, () => this.openPreferences());
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'center');
        this._placeIndicator();
        this._service = new UsageService({
            settings: this._settings,
            extensionPath: this.path,
            onChanged: () => this._indicator?.render(),
            onAlerts: alerts => {
                const message = formatNotificationBody(alerts);
                if (message)
                    Main.notify('UsageBeam usage alert', message);
            },
        });
        this._indicator.attach(this._service);
        this._settingsIds = [];
        const configureProviders = () => {
            this._service.configure();
            this._indicator.render();
            this._service.refreshAll();
        };
        for (const key of ['enabled-providers', 'provider-order'])
            this._settingsIds.push(this._settings.connect(`changed::${key}`, configureProviders));
        this._settingsIds.push(this._settings.connect('changed::default-provider', () => this._indicator.render()));
        this._settingsIds.push(this._settings.connect('changed::panel-position', () => this._placeIndicator()));
        this._settingsIds.push(this._settings.connect('changed::clear-data-generation', () =>
            this._service.clearSavedData()));
        this._settingsIds.push(this._settings.connect('changed::history-retention-days', () =>
            this._service.refreshAll(true)));
        this._service.refreshAll();
    }

    _placeIndicator() {
        placeIndicator(this._indicator, this._settings.get_string('panel-position'));
    }

    disable() {
        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = null;
        this._service?.destroy();
        this._service = null;
        clearIndicatorPlacement(this._indicator);
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}

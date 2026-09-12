import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

// Center the visible glyphs. A font's line box includes unused ascent/descent
// space, which differs between provider names and the smaller metric text.
export const PanelLabel = GObject.registerClass(class PanelLabel extends St.Label {
    _init(text, style) {
        super._init({text, style_class: style, y_align: Clutter.ActorAlign.CENTER});
    }

    vfunc_allocate(box) {
        super.vfunc_allocate(box);
        const text = this.clutter_text;
        const [ink, logical] = text.get_layout().get_pixel_extents();
        if (!ink.height || !logical.height)
            return;
        const scale = text.get_preferred_height(-1)[1] / logical.height;
        text.translation_y = Math.round(this.height / 2 - text.y - (ink.y + ink.height / 2) * scale);
    }
});

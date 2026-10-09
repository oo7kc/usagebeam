import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import {getChartBarGeometry} from './presentation.js';

// Fills are allocated, never sized from allocation notifications. Their geometry
// must not contribute to preferred size or trigger a layout feedback loop.
export const UsageBeamProgressBar = GObject.registerClass(class UsageBeamProgressBar extends St.Widget {
    _init({fraction, style, fillStyle, name, content = null, vertical = false}) {
        super._init({style_class: style, x_expand: true,
            accessible_name: name, accessible_role: Atk.Role.PROGRESS_BAR});
        this._fraction = Math.max(0, Math.min(1, Number(fraction) || 0));
        this._vertical = vertical;
        this._fill = new St.Widget({style_class: fillStyle, visible: this._fraction > 0});
        this._overlay = content;
        this.add_child(this._fill);
        if (content)
            this.add_child(content);
    }

    vfunc_get_preferred_width(forHeight) {
        const node = this.get_theme_node();
        const sizes = this._overlay?.get_preferred_width(node.adjust_for_height(forHeight)) ?? [0, 0];
        return node.adjust_preferred_width(...sizes);
    }

    vfunc_get_preferred_height(forWidth) {
        const node = this.get_theme_node();
        const sizes = this._overlay?.get_preferred_height(node.adjust_for_width(forWidth)) ?? [0, 0];
        return node.adjust_preferred_height(...sizes);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const contentBox = this.get_theme_node().get_content_box(box);
        const [width, height] = contentBox.get_size();
        const scale = St.ThemeContext.get_for_stage(this.get_stage()).scale_factor;
        const geometry = this._vertical
            ? Object.fromEntries(Object.entries(getChartBarGeometry(this._fraction, 1, width / scale, height / scale))
                .map(([key, value]) => [key, value * scale]))
            : {x: 0, y: 0, width: Math.round(width * this._fraction), height};
        const fillBox = new Clutter.ActorBox();
        fillBox.x1 = contentBox.x1 + geometry.x;
        fillBox.y1 = contentBox.y1 + geometry.y;
        fillBox.x2 = fillBox.x1 + geometry.width;
        fillBox.y2 = fillBox.y1 + geometry.height;
        this._fill.allocate(fillBox);
        this._overlay?.allocate(contentBox);
    }
});

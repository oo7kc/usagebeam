import assert from 'node:assert/strict';
import test from 'node:test';
import {getPanelBalance} from '../../src/ui/panelGeometry.js';

test('unequal clock and usage widths need no padding to center their combined group', () => {
    for (const widths of [[0, 147, 173, 0], [0, 173, 147, 0]]) {
        assert.deepEqual(getPanelBalance({widths, spacing: 0, firstIndex: 1, lastIndex: 2}),
            {leading: 0, trailing: 0});
    }
});

test('center-panel neighbors are balanced outside the pair, including theme spacing', () => {
    assert.deepEqual(getPanelBalance({widths: [40, 0, 147, 173, 0, 100], spacing: 6, firstIndex: 2, lastIndex: 3}),
        {leading: 60, trailing: 0});
    assert.deepEqual(getPanelBalance({widths: [0, 147, 173, 0, 100], spacing: 6, firstIndex: 1, lastIndex: 2}),
        {leading: 106, trailing: 0});
});

test('work-area offsets are compensated in either text direction and at fractional scales', () => {
    for (const scale of [1, 1.25, 1.5, 2]) {
        for (const rtl of [false, true]) {
            for (const offset of [-72, 72]) {
                const result = getPanelBalance({widths: [0, 147 * scale, 173 * scale, 0],
                    spacing: 4 * scale, firstIndex: 1, lastIndex: 2, centerOffset: offset * scale, rtl});
                const shift = (result.leading - result.trailing) / 2 * (rtl ? -1 : 1);
                assert.equal(shift + offset * scale / 2, 0);
            }
        }
    }
});

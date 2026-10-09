import assert from 'node:assert/strict';
import test from 'node:test';
import {createInitialLayout, getNextLayout, getPageSlice} from '../../src/ui/layoutPolicy.js';

test('adaptive layout is finite and preserves readable text rather than scaling it down', () => {
    for (const expanded of [false, true]) {
        let layout = createInitialLayout();
        let attempts = 0;
        while (layout) {
            assert.ok(layout.limits >= 1 && layout.models >= 1);
            assert.ok(++attempts <= 10, 'Layout must converge without allocation feedback');
            layout = getNextLayout(layout, expanded);
        }
    }
});

test('pagination reaches every item and clamps pages after a data change', () => {
    const items = Array.from({length: 32}, (_, index) => index);
    const seen = [];
    for (let page = 0; page < 11; page++)
        seen.push(...getPageSlice(items, page, 3).items);
    assert.deepEqual(seen, items);
    assert.deepEqual(getPageSlice([1], 10, 3), {items: [1], page: 0, pages: 1});
    assert.deepEqual(getPageSlice([], -1, 3), {items: [], page: 0, pages: 1});
});

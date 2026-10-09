// Widths follow the box's child order, with both balancing spacers set to zero.
// centerOffset is twice GNOME's work-area center offset from the panel monitor.
export function getPanelBalance({widths, spacing, firstIndex, lastIndex, centerOffset = 0, rtl = false}) {
    const beforePair = widths.slice(0, firstIndex).reduce((sum, width) => sum + width, 0) + spacing * firstIndex;
    const throughPair = widths.slice(0, lastIndex + 1).reduce((sum, width) => sum + width, 0) + spacing * lastIndex;
    const total = widths.reduce((sum, width) => sum + width, 0) + spacing * Math.max(0, widths.length - 1);
    const difference = beforePair + throughPair - total + (rtl ? -centerOffset : centerOffset);
    return {leading: Math.max(0, -difference), trailing: Math.max(0, difference)};
}

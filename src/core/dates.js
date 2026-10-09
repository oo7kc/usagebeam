export function normalizeTimestamp(value) {
    if (value === null || value === undefined || value === '')
        return null;
    const numeric = typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value).trim()) ? Number(value) : null;
    const timestampMs = numeric !== null ? (numeric < 1e12 ? numeric * 1000 : numeric) : Date.parse(value);
    return Number.isFinite(timestampMs) && timestampMs > 0 ? timestampMs : null;
}

export function getLocalDate(time) {
    if (time === null || time === undefined || time === '')
        return null;
    const date = new Date(time);
    if (!Number.isFinite(date.getTime()))
        return null;
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function getRecentDates(now, count = 7) {
    const today = new Date(now);
    today.setHours(12, 0, 0, 0);
    return Array.from({length: count}, (_, index) => {
        const day = new Date(today);
        day.setDate(day.getDate() - (count - 1 - index));
        return getLocalDate(day);
    });
}

export function isIsoDate(value) {
    const parsed = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? Date.parse(`${value}T00:00:00Z`)
        : NaN;
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

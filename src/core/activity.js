import {getRecentDates} from './dates.js';
import {parseNonNegativeNumber} from './values.js';

export function aggregateEvents(events, now = Date.now(), count = 7) {
    const dates = getRecentDates(now, count);
    const days = new Map(dates.map(date => [date, {date, total: 0, sessions: 0, events: 0}]));
    const models = new Map();
    const seen = new Set();
    const sessions = new Map(dates.map(date => [date, new Set()]));
    for (const event of events) {
        const day = days.get(event.date);
        if (!day || seen.has(event.id))
            continue;
        seen.add(event.id);
        const tokens = ['input', 'output', 'cacheRead', 'cacheWrite'].map(k => parseNonNegativeNumber(event[k]) ?? 0);
        const total = tokens.reduce((a, b) => a + b, 0);
        if (!total)
            continue;
        const model = String(event.model || 'Unknown model');
        const bucket = models.get(model) ?? {model, total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0};
        ['input', 'output', 'cacheRead', 'cacheWrite'].forEach((k, i) => { bucket[k] += tokens[i]; });
        bucket.total += total;
        models.set(model, bucket);
        day.total += total;
        day.events++;
        sessions.get(event.date).add(event.session);
        day.sessions = sessions.get(event.date).size;
    }
    return {period: {start: dates[0], end: dates.at(-1)}, days: [...days.values()],
        models: [...models.values()].sort((a, b) => b.total - a.total)};
}

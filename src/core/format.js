export function formatTokenCount(value) {
    if (!Number.isFinite(value))
        return '—';
    for (const [unit, divisor] of [['P', 1e15], ['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]]) {
        if (value >= divisor)
            return `${(value / divisor).toFixed(1)}${unit}`;
    }
    return String(Math.round(value));
}

export function formatCompactTokenCount(value) {
    return formatTokenCount(value).replace(/\.0(?=[PTBMK]$)/, '');
}

export function formatResetTime(time, now = Date.now()) {
    if (!Number.isFinite(time) || time <= 0)
        return 'Reset time unavailable';
    const minutes = Math.ceil((time - now) / 60000);
    if (minutes <= 0)
        return 'Reset due · awaiting update';
    if (minutes >= 1440)
        return `Resets in ${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`;
    if (minutes >= 60)
        return `Resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    return `Resets in ${minutes}m`;
}

export function formatResetCountdown(time, now = Date.now()) {
    const value = formatResetTime(time, now);
    if (value.startsWith('Resets in '))
        return value.slice('Resets in '.length);
    if (value.startsWith('Reset due'))
        return 'due';
    return null;
}

export function formatUpdateAge(time, now = Date.now()) {
    if (!time)
        return 'Never updated';
    const minutes = Math.max(0, Math.floor((now - time) / 60000));
    if (!minutes)
        return 'Updated just now';
    if (minutes < 60)
        return `Updated ${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `Updated ${hours}h ago` : `Updated ${Math.floor(hours / 24)}d ago`;
}

export function formatModelName(value) {
    const acronyms = new Map([['gpt', 'GPT'], ['api', 'API']]);
    return String(value || 'Unknown model').replaceAll(/[-_/]+/g, ' ').split(/\s+/).filter(Boolean)
        .map(word => acronyms.get(word.toLowerCase()) ?? word[0].toUpperCase() + word.slice(1)).join(' ');
}

export function parseNonNegativeNumber(value) {
    if (value === null || value === undefined || typeof value === 'boolean' ||
        !['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim()))
        return null;
    const result = Number(value);
    return Number.isFinite(result) && result >= 0 ? result : null;
}

export function sanitizeText(value, fallback = null, maxLength = 80) {
    if (typeof value !== 'string')
        return fallback;
    const text = value.trim();
    return text && !/[\u0000-\u001f\u007f]/.test(text) ? text.slice(0, maxLength) : fallback;
}

export function parseSafeInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

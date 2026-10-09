const MANUAL_REFRESH_COOLDOWN_MS = 2000;
const MAX_BACKOFF_SECONDS = 3600;
export const MAX_CONSECUTIVE_FAILURES = 4;

export function getRefreshDelayMs(intervalSeconds, failureCount, force = false) {
    return force ? MANUAL_REFRESH_COOLDOWN_MS
        : Math.min(MAX_BACKOFF_SECONDS, intervalSeconds * 2 ** failureCount) * 1000;
}

import {createUsageRecord, createUsageSection} from '../core/usage.js';
import {validateUsageRecord} from '../core/usageValidation.js';
import {buildPath, readJson, stateDirectory, writeJson} from './files.js';

export function loadProviderSnapshot(providerId, directory = stateDirectory()) {
    try {
        const cached = validateUsageRecord(readJson(buildPath(directory, `${providerId}.json`)), providerId);
        for (const name of ['limits', 'history']) {
            if (['ready', 'partial', 'stale'].includes(cached[name].status)) {
                cached[name] = {
                    ...cached[name],
                    ...createUsageSection('stale', 'Showing saved usage while refreshing.'),
                    updatedAt: cached[name].updatedAt,
                };
            }
        }
        return cached;
    } catch {
        return createUsageRecord(providerId);
    }
}

export function saveProviderSnapshot(record, directory = stateDirectory()) {
    try {
        writeJson(buildPath(directory, `${record.id}.json`), record);
        return true;
    } catch {
        // Persistence failures must not hide the current provider result.
        return false;
    }
}

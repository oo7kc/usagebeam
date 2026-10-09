import {createUsageRecord, createUsageSection} from '../core/usage.js';

export async function collectOpenCode(context) {
    const result = createUsageRecord('opencode');
    result.capabilities = {limits: false, history: true, models: true};
    result.limits = {...result.limits, ...createUsageSection('unsupported',
        'OpenCode does not report account quota limits. Activity reflects sessions on this device.')};
    result.history = await context.openCodeHistory();
    return result;
}

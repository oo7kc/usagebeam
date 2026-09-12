import {record, section} from '../core/usage.js';

export async function collectOpenCode(io) {
    const result = record('opencode');
    result.capabilities = {limits: false, history: true, models: true};
    result.limits = {...result.limits, ...section('unsupported',
        'OpenCode does not report account quota limits. Activity reflects sessions on this device.')};
    result.history = await io.openCodeHistory();
    return result;
}

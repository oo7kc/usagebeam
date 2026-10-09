import Gio from 'gi://Gio';

export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MAX_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export class ProcessError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ProcessError';
        this.code = code;
    }
}

function normalizeCommandSpec(spec) {
    const value = Array.isArray(spec) ? {argv: spec, environment: {}} : spec;
    if (!value || !Array.isArray(value.argv) || !value.argv.length ||
        value.argv.some(argument => typeof argument !== 'string' || !argument))
        throw new ProcessError('INVALID_COMMAND', 'Command arguments must be non-empty strings');
    if (value.environment && (typeof value.environment !== 'object' || Array.isArray(value.environment)))
        throw new ProcessError('INVALID_COMMAND', 'Command environment must be an object');
    for (const [name, entry] of Object.entries(value.environment ?? {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof entry !== 'string')
            throw new ProcessError('INVALID_COMMAND', 'Command environment entries must be named strings');
    }
    return {argv: value.argv, environment: value.environment ?? {}};
}

export function spawnSubprocess(spec, flags) {
    const {argv, environment} = normalizeCommandSpec(spec);
    const launcher = new Gio.SubprocessLauncher({flags});
    for (const [name, value] of Object.entries(environment))
        launcher.setenv(name, value, true);
    return launcher.spawnv(argv);
}

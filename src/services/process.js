import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {readStreamText, waitForProcess, writeStreamText} from './streams.js';
import {DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES, MAX_TIMEOUT_MS, ProcessError, spawnSubprocess} from './subprocess.js';

export async function runCommand(spec, {input = null, timeout = 15000, cancellable = null,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES} = {}) {
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS ||
        !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > MAX_OUTPUT_BYTES)
        throw new ProcessError('INVALID_OPTIONS', 'Process limits are outside the supported range');
    if (input !== null && typeof input !== 'string')
        throw new ProcessError('INVALID_OPTIONS', 'Process input must be text or null');

    const process = spawnSubprocess(spec, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE |
        (input === null ? 0 : Gio.SubprocessFlags.STDIN_PIPE));
    const local = new Gio.Cancellable();
    let completed = false;
    let cancellation = null;
    const externalId = cancellable?.connect(() => {
        cancellation = 'CANCELLED';
        local.cancel();
    });
    if (cancellable?.is_cancelled()) {
        cancellation = 'CANCELLED';
        local.cancel();
    }
    let timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout, () => {
        timer = 0;
        cancellation = 'TIMED_OUT';
        local.cancel();
        return GLib.SOURCE_REMOVE;
    });
    try {
        const writeInput = async () => {
            if (input === null)
                return;
            const stdin = process.get_stdin_pipe();
            await writeStreamText(stdin, input, local);
            stdin.close(null);
        };
        const [stdout] = await Promise.all([
            readStreamText(process.get_stdout_pipe(), maxOutputBytes, local,
                () => new ProcessError('OUTPUT_LIMIT', 'Command output exceeded the configured limit')),
            writeInput(),
            waitForProcess(process, local).then(() => { completed = true; }),
        ]);
        if (!process.get_successful())
            throw new ProcessError('FAILED', 'Command exited unsuccessfully');
        return stdout;
    } catch (error) {
        if (cancellation === 'TIMED_OUT')
            throw new ProcessError('TIMED_OUT', 'Command timed out');
        if (cancellation === 'CANCELLED')
            throw new ProcessError('CANCELLED', 'Command was cancelled');
        throw error;
    } finally {
        if (timer)
            GLib.source_remove(timer);
        if (externalId)
            cancellable.disconnect(externalId);
        // Abort remaining stream operations on every failure, including output overflow.
        local.cancel();
        // Give managed collectors time to cancel and reap their own CLI child.
        if (!completed) {
            try {
                process.send_signal(15);
            } catch {
                /* The child exited between callbacks. */
            }
            let killTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                killTimer = 0;
                process.force_exit();
                return GLib.SOURCE_REMOVE;
            });
            let reaped = false;
            try {
                await waitForProcess(process);
                reaped = true;
            } finally {
                if (killTimer)
                    GLib.source_remove(killTimer);
                if (!reaped)
                    process.force_exit();
            }
        }
    }
}

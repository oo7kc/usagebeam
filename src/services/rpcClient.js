import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {readStreamLines, writeStreamText} from './streams.js';
import {DEFAULT_MAX_OUTPUT_BYTES, MAX_TIMEOUT_MS, ProcessError, spawnSubprocess} from './subprocess.js';

const MAX_PENDING_REQUESTS = 64;
const MAX_QUEUED_MESSAGES = 64;

export class RpcClient {
    constructor(spec, cancellable, timeout = 8000) {
        if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS)
            throw new ProcessError('INVALID_OPTIONS', 'RPC timeout is outside the supported range');
        this._process = spawnSubprocess(spec, Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE |
            Gio.SubprocessFlags.STDERR_SILENCE);
        this._stdoutStream = this._process.get_stdout_pipe();
        this._cancellable = new Gio.Cancellable();
        this._parentCancellable = cancellable;
        this._requestTimeoutMs = timeout;
        this._nextRequestId = 0;
        this._pendingRequests = new Map();
        this._closed = false;
        this._writes = Promise.resolve();
        this._queuedBytes = 0;
        this._queuedMessages = 0;
        this._parentCancellationId = cancellable?.connect(() => this.close()) ?? 0;
        if (!this._closed)
            this._readResponses();
    }

    get isClosed() {
        return this._closed;
    }

    get pendingRequestCount() {
        return this._pendingRequests.size;
    }

    _sendMessage(value) {
        if (this._closed)
            throw new Error('RPC closed');
        const text = `${JSON.stringify(value)}\n`;
        const size = new TextEncoder().encode(text).length;
        if (this._queuedMessages >= MAX_QUEUED_MESSAGES || this._queuedBytes + size > DEFAULT_MAX_OUTPUT_BYTES)
            throw new ProcessError('OUTPUT_LIMIT', 'RPC request exceeded the configured limit');
        this._queuedBytes += size;
        this._queuedMessages++;
        this._writes = this._writes.then(() => {
            if (!this._closed)
                return writeStreamText(this._process.get_stdin_pipe(), text, this._cancellable);
        }).catch(() => this.close()).finally(() => {
            this._queuedBytes -= size;
            this._queuedMessages--;
        });
    }

    notify(method, params) {
        this._sendMessage({method, params});
    }

    request(method, params = {}) {
        if (this._closed || this._pendingRequests.size >= MAX_PENDING_REQUESTS)
            return Promise.reject(new ProcessError('RPC_CLOSED', 'RPC unavailable or too many pending requests'));
        return new Promise((resolve, reject) => {
            const id = ++this._nextRequestId;
            const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._requestTimeoutMs, () => {
                this._pendingRequests.delete(id);
                reject(new ProcessError('RPC_TIMEOUT', `RPC request timed out: ${method}`));
                return GLib.SOURCE_REMOVE;
            });
            this._pendingRequests.set(id, {resolve, reject, timer});
            try {
                this._sendMessage({id, method, params});
            } catch (error) {
                this._pendingRequests.delete(id);
                GLib.source_remove(timer);
                reject(error);
            }
        });
    }

    async _readResponses() {
        try {
            for await (const line of readStreamLines(this._stdoutStream, DEFAULT_MAX_OUTPUT_BYTES, this._cancellable,
                () => new ProcessError('OUTPUT_LIMIT', 'RPC response exceeded the configured limit'))) {
                if (this._closed)
                    return;
                const value = JSON.parse(line);
                const pending = this._pendingRequests.get(value.id);
                if (pending) {
                    this._pendingRequests.delete(value.id);
                    GLib.source_remove(pending.timer);
                    if (value.error) {
                        const message = String(value.error.message || 'RPC request unavailable').slice(0, 240);
                        const error = new ProcessError('RPC_ERROR', message);
                        error.rpcCode = value.error.code ?? null;
                        pending.reject(error);
                    } else {
                        pending.resolve(value.result);
                    }
                }
            }
        } catch {
            // Malformed, oversized and interrupted streams all close pending work.
        } finally {
            this.close();
        }
    }

    close() {
        if (this._closed)
            return;
        this._closed = true;
        for (const pending of this._pendingRequests.values()) {
            GLib.source_remove(pending.timer);
            pending.reject(new ProcessError('RPC_CLOSED', 'RPC connection closed'));
        }
        this._pendingRequests.clear();
        this._cancellable.cancel();
        this._process.force_exit();
        this._process.wait_async(null, (process, result) => {
            try {
                process.wait_finish(result);
            } catch {
                // The child may already have been reaped.
            }
        });
        // Disconnecting inside a Gio.Cancellable callback deadlocks; defer it.
        if (this._parentCancellationId) {
            const id = this._parentCancellationId;
            this._parentCancellationId = 0;
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._parentCancellable.disconnect(id);
                return GLib.SOURCE_REMOVE;
            });
        }
    }
}

import GLib from 'gi://GLib';

const CHUNK_BYTES = 65536;

export function readStreamChunk(stream, cancellable) {
    return new Promise((resolve, reject) => {
        stream.read_bytes_async(CHUNK_BYTES, GLib.PRIORITY_DEFAULT, cancellable, (input, result) => {
            try {
                resolve(input.read_bytes_finish(result).toArray());
            } catch (error) {
                reject(error);
            }
        });
    });
}

export async function readStreamText(stream, maxBytes, cancellable, limitError) {
    const parts = [];
    let size = 0;
    while (true) {
        const bytes = await readStreamChunk(stream, cancellable);
        if (!bytes.length)
            break;
        size += bytes.length;
        if (size > maxBytes)
            throw limitError();
        parts.push(bytes);
    }
    // GJS does not support TextDecoder's streaming option. Decode only after
    // joining the already-bounded bytes so split multibyte characters survive.
    const output = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
    }
    return new TextDecoder('utf-8', {fatal: true}).decode(output);
}

// RPC lines are bounded before decoding or parsing, including unterminated lines.
export async function* readStreamLines(stream, maxBytes, cancellable, limitError) {
    let parts = [];
    let size = 0;
    while (true) {
        const bytes = await readStreamChunk(stream, cancellable);
        if (!bytes.length) {
            if (size)
                throw new Error('Incomplete RPC message');
            return;
        }
        let start = 0;
        for (let i = 0; i < bytes.length; i++) {
            if (bytes[i] === 10) {
                const part = bytes.subarray(start, i);
                size += part.length;
                if (size > maxBytes)
                    throw limitError();
                const line = new Uint8Array(size);
                let offset = 0;
                for (const entry of [...parts, part]) {
                    line.set(entry, offset);
                    offset += entry.length;
                }
                yield new TextDecoder('utf-8', {fatal: true}).decode(line);
                parts = [];
                size = 0;
                start = i + 1;
            }
        }
        if (start < bytes.length) {
            const part = bytes.slice(start);
            parts.push(part);
            size += part.length;
        }
        if (size > maxBytes)
            throw limitError();
    }
}

export function writeStreamText(stream, text, cancellable) {
    return new Promise((resolve, reject) => {
        stream.write_all_async(new TextEncoder().encode(text), GLib.PRIORITY_DEFAULT, cancellable,
            (output, result) => {
                try {
                    output.write_all_finish(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
    });
}

export function waitForProcess(process, cancellable = null) {
    return new Promise((resolve, reject) => {
        process.wait_async(cancellable, (child, result) => {
            try {
                child.wait_finish(result);
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    });
}

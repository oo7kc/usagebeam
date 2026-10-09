import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export async function requestJson(url, {method = 'GET', headers = {}, body = null, cancellable = null,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES} = {}) {
    if (typeof url !== 'string' || !url.startsWith('https://'))
        throw new Error('Only HTTPS provider endpoints are allowed');
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0 || maxResponseBytes > MAX_RESPONSE_BYTES)
        throw new Error('HTTP response limit is outside the supported range');
    if (typeof method !== 'string' || !/^[A-Z]+$/.test(method) || !headers ||
        typeof headers !== 'object' || Array.isArray(headers))
        throw new Error('Invalid provider request options');
    for (const [key, value] of Object.entries(headers)) {
        if (!/^[A-Za-z0-9-]+$/.test(key) || typeof value !== 'string' || /[\r\n]/.test(value))
            throw new Error('Invalid provider request header');
    }

    const message = Soup.Message.new(method, url);
    if (!message)
        throw new Error('Invalid provider endpoint');
    const session = new Soup.Session({timeout: 12});
    try {
        for (const [key, value] of Object.entries(headers))
            message.request_headers.append(key, value);
        if (body !== null)
            message.set_request_body_from_bytes('application/json',
                new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body))));
        const bytes = await new Promise((resolve, reject) => {
            session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (session, result) => {
                try {
                    resolve(session.send_and_read_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
        });
        if (bytes.get_size() > maxResponseBytes)
            throw new Error('Provider response exceeded the configured limit');
        let data = null;
        try {
            data = JSON.parse(new TextDecoder().decode(bytes.toArray()));
        } catch {
            /* Status remains available for error handling. */
        }
        return {status: message.status_code, data};
    } finally {
        session.abort();
    }
}

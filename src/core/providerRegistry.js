// Provider identity is shared by collectors, preferences, and Shell widgets.
export const PROVIDERS = Object.freeze({
    codex: Object.freeze({name: 'Codex', label: 'Codex', mark: '>_', icon: 'codex-symbolic.svg'}),
    claude: Object.freeze({name: 'Claude Code', label: 'Claude', mark: '✦', icon: 'claude.svg'}),
    opencode: Object.freeze({name: 'OpenCode', label: 'OpenCode', mark: 'AI', icon: 'opencode-symbolic.svg'}),
});
export const PROVIDER_NAMES = Object.freeze(Object.fromEntries(
    Object.entries(PROVIDERS).map(([id, provider]) => [id, provider.name])));
export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));

export function isProviderId(id) {
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(PROVIDER_NAMES, id);
}

export function normalizeProviderOrder(value = []) {
    const requested = Array.isArray(value) ? value : [];
    return [...new Set([...requested.filter(isProviderId), ...PROVIDER_IDS])];
}

export function getEnabledProviders(enabled = [], order = []) {
    const selected = new Set(Array.isArray(enabled) ? enabled.filter(isProviderId) : []);
    return normalizeProviderOrder(order).filter(id => selected.has(id));
}

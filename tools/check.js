import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {resolve, dirname, join, relative} from 'node:path';
import {execFileSync} from 'node:child_process';

function walk(directory) {
    return readdirSync(directory, {withFileTypes: true}).flatMap(entry => entry.isDirectory()
        ? walk(join(directory, entry.name)) : [join(directory, entry.name)]);
}
const files = ['extension.js', 'prefs.js', ...walk('src'), ...walk('tests'), ...walk('tools')].filter(file => file.endsWith('.js'));
for (const file of walk('src')) {
    if (!file.endsWith('.js'))
        throw new Error(`Unexpected non-runtime file under src/: ${file}`);
}
const allowedRuntimeImports = {
    core: new Set(['core']),
    providers: new Set(['core', 'providers']),
    services: new Set(['core', 'services']),
    collector: new Set(['core', 'providers', 'services', 'collector']),
    ui: new Set(['core', 'ui']),
};
const runtimeLayer = file => file.startsWith('src/') ? file.split('/')[1] : null;
for (const file of files) {
    const text = readFileSync(file, 'utf8');
    execFileSync(process.execPath, ['--check', file], {stdio: 'pipe'});
    if (!text.endsWith('\n') || /[ \t]+$/m.test(text))
        throw new Error(`${file}: trailing whitespace or missing final newline`);
    for (const [, target] of text.matchAll(/from ['"]([.][^'"]+)['"]/g)) {
        const absolute = resolve(dirname(file), target);
        if (!existsSync(absolute))
            throw new Error(`${file}: missing import ${target}`);
        const source = runtimeLayer(file);
        const destination = runtimeLayer(relative('.', absolute));
        if (source && destination && !allowedRuntimeImports[source]?.has(destination))
            throw new Error(`${file}: ${source} modules cannot import the ${destination} layer`);
    }
}
for (const entrypoint of ['extension.js', 'prefs.js']) {
    if (readFileSync(entrypoint, 'utf8').split('\n').length > 120)
        throw new Error(`${entrypoint}: GNOME entry points must remain thin`);
}
const metadata = JSON.parse(readFileSync('metadata.json', 'utf8'));
if (metadata.uuid !== 'usagebeam@oo7kc.github.io')
    throw new Error('Extension identity changed without a migration');
if (metadata.name !== 'UsageBeam' || metadata['settings-schema'] !== 'org.gnome.shell.extensions.usagebeam')
    throw new Error('UsageBeam product metadata is inconsistent');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (!readFileSync('meson.build', 'utf8').includes(`version: '${version}'`))
    throw new Error('Meson and package versions differ');
const stylesheet = readFileSync('stylesheet.css', 'utf8');
if (/font-family\s*:/.test(stylesheet))
    throw new Error('The extension must inherit the configured GNOME system font');

const required = ['README.md', 'CHANGELOG.md',
    'docs/providers/codex.md', 'docs/providers/claude.md'];
for (const file of required) {
    if (!existsSync(file))
        throw new Error(`Missing product documentation: ${file}`);
}
const schemas = walk('schemas').filter(file => file.endsWith('.xml'));
if (schemas.length !== 1 || schemas[0] !== 'schemas/org.gnome.shell.extensions.usagebeam.gschema.xml')
    throw new Error('Unexpected extension schema input');
const icons = walk('icons');
if (icons.length !== 2 || !icons.includes('icons/claude.svg') ||
    !icons.includes('icons/codex-symbolic.svg'))
    throw new Error('Unexpected runtime icon input');
const providerFiles = walk('src/providers').filter(file => file.endsWith('.js')).sort();
if (providerFiles.join(',') !== 'src/providers/claude.js,src/providers/codex.js')
    throw new Error(`Unverified provider adapters must not ship: ${providerFiles.join(', ')}`);
const obsolete = ['plan.md', 'indicator.js', 'src/providers/legacy.js', 'scripts/freeby.sh',
    'src/providers/cursor.js', 'src/providers/copilot.js', 'scripts/copilot-setup.sh',
    'tests/freeby.bats', 'docs/README.md', 'docs/assets', 'docs/providers/README.md',
    'docs/s1.png', 'docs/s2.png', 'CONTRIBUTING.md'];
for (const file of obsolete) {
    if (existsSync(file))
        throw new Error(`Obsolete repository path returned: ${file}`);
}
const markdown = ['README.md', 'CHANGELOG.md', ...walk('docs')]
    .filter(file => file.endsWith('.md'));
for (const file of markdown) {
    const text = readFileSync(file, 'utf8');
    for (const [, target] of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        if (/^(?:https?:|#|mailto:)/.test(target))
            continue;
        const path = target.split('#')[0];
        if (path && !existsSync(resolve(dirname(file), path)))
            throw new Error(`${file}: broken relative link ${target}`);
    }
}
execFileSync('glib-compile-schemas', ['--strict', '--dry-run', 'schemas']);
console.log(`Syntax, imports, formatting, repository layout, links, release metadata and schema checks passed (${files.length} JavaScript files).`);

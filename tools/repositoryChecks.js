import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {listFiles} from './sourceChecks.js';

function checkRuntimeLayout() {
    for (const file of listFiles('src')) {
        if (!file.endsWith('.js') && file !== 'src/collector/opencode_history.py')
            throw new Error(`Unexpected non-runtime file under src/: ${file}`);
    }
    for (const entrypoint of ['extension.js', 'prefs.js', 'src/collector/main.js']) {
        if (readFileSync(entrypoint, 'utf8').split('\n').length > 120)
            throw new Error(`${entrypoint}: GNOME entry points must remain thin`);
    }
    const providerFiles = listFiles('src/providers').filter(file => file.endsWith('.js')).sort();
    if (providerFiles.join(',') !== 'src/providers/claude.js,src/providers/codex.js,src/providers/opencode.js')
        throw new Error(`Unverified provider adapters must not ship: ${providerFiles.join(', ')}`);
    const schemas = listFiles('schemas').filter(file => file.endsWith('.xml'));
    if (schemas.length !== 1 || schemas[0] !== 'schemas/org.gnome.shell.extensions.usagebeam.gschema.xml')
        throw new Error('Unexpected extension schema input');
    const icons = listFiles('icons').sort();
    if (icons.join(',') !== 'icons/claude.svg,icons/codex-symbolic.svg,icons/opencode-symbolic.svg')
        throw new Error('Unexpected runtime icon input');
}

function checkProductIdentity() {
    const metadata = JSON.parse(readFileSync('metadata.json', 'utf8'));
    if (metadata.uuid !== 'usagebeam@oo7kc.github.io')
        throw new Error('Extension identity changed without a migration');
    if (metadata.name !== 'UsageBeam' || metadata['settings-schema'] !== 'org.gnome.shell.extensions.usagebeam')
        throw new Error('UsageBeam product metadata is inconsistent');
    const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
    if (!readFileSync('meson.build', 'utf8').includes(`version: '${version}'`))
        throw new Error('Meson and package versions differ');
    if (/font-family\s*:/.test(readFileSync('stylesheet.css', 'utf8')))
        throw new Error('The extension must inherit the configured GNOME system font');
}

function checkDocumentation() {
    const required = ['README.md', 'CHANGELOG.md', 'docs/development.md',
        'docs/providers/codex.md', 'docs/providers/claude.md', 'docs/providers/opencode.md'];
    for (const file of required) {
        if (!existsSync(file))
            throw new Error(`Missing product documentation: ${file}`);
    }
    const markdownFiles = ['README.md', 'CHANGELOG.md', ...listFiles('docs')]
        .filter(file => file.endsWith('.md'));
    for (const file of markdownFiles) {
        for (const [, target] of readFileSync(file, 'utf8').matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
            if (/^(?:https?:|#|mailto:)/.test(target))
                continue;
            const path = target.split('#')[0];
            if (path && !existsSync(resolve(dirname(file), path)))
                throw new Error(`${file}: broken relative link ${target}`);
        }
    }
}

function checkObsoletePaths() {
    const obsolete = ['plan.md', 'indicator.js', 'src/providers/legacy.js', 'scripts/freeby.sh',
        'src/providers/cursor.js', 'src/providers/copilot.js', 'scripts/copilot-setup.sh',
        'tests/freeby.bats', 'docs/README.md', 'docs/assets', 'docs/providers/README.md',
        'docs/s1.png', 'docs/s2.png', 'CONTRIBUTING.md'];
    for (const file of obsolete) {
        if (existsSync(file))
            throw new Error(`Obsolete repository path returned: ${file}`);
    }
}

export function checkRepository() {
    checkRuntimeLayout();
    checkProductIdentity();
    checkDocumentation();
    checkObsoletePaths();
    execFileSync('glib-compile-schemas', ['--strict', '--dry-run', 'schemas']);
}

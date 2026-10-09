import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';

const LAYER_IMPORTS = {
    core: new Set(['core']),
    providers: new Set(['core', 'providers']),
    services: new Set(['core', 'services']),
    collector: new Set(['core', 'providers', 'services', 'collector']),
    ui: new Set(['core', 'ui']),
};

export function listFiles(directory) {
    return readdirSync(directory, {withFileTypes: true}).flatMap(entry => entry.isDirectory()
        ? listFiles(join(directory, entry.name)) : [join(directory, entry.name)]);
}

function runtimeLayer(file) {
    return file.startsWith('src/') ? file.split('/')[1] : null;
}

function checkNamedImports(file, members, target) {
    const targetSource = readFileSync(target, 'utf8');
    const exported = new Set([...targetSource.matchAll(
        /export\s+(?:async\s+)?(?:const|class|function\s*\*?)\s+(\w+)/g)].map(match => match[1]));
    for (const member of members.split(',').map(value => value.trim()).filter(Boolean)) {
        const name = member.split(/\s+as\s+/)[0];
        if (!exported.has(name))
            throw new Error(`${file}: ${relative('.', target)} does not export ${name}`);
    }
}

function checkDependencyCycles(graph) {
    const visited = new Set();
    const active = new Set();
    function visit(file, path) {
        if (active.has(file))
            throw new Error(`Circular runtime dependency: ${[...path, file].join(' -> ')}`);
        if (visited.has(file))
            return;
        active.add(file);
        for (const target of graph.get(file) ?? [])
            visit(target, [...path, file]);
        active.delete(file);
        visited.add(file);
    }
    for (const file of graph.keys())
        visit(file, []);
}

export function checkJavaScript(files) {
    const graph = new Map();
    for (const file of files) {
        const source = readFileSync(file, 'utf8');
        execFileSync(process.execPath, ['--check', file], {stdio: 'pipe'});
        if (!source.endsWith('\n') || /[ \t]+$/m.test(source))
            throw new Error(`${file}: trailing whitespace or missing final newline`);
        const imports = [];
        for (const [, target] of source.matchAll(
            /^import\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([.][^'"]+)['"]/gm)) {
            const absolute = resolve(dirname(file), target);
            if (!existsSync(absolute))
                throw new Error(`${file}: missing import ${target}`);
            const sourceLayer = runtimeLayer(file);
            const targetFile = relative('.', absolute);
            const targetLayer = runtimeLayer(targetFile);
            if (sourceLayer && targetLayer) {
                if (!LAYER_IMPORTS[sourceLayer]?.has(targetLayer))
                    throw new Error(`${file}: ${sourceLayer} modules cannot import the ${targetLayer} layer`);
                imports.push(targetFile);
            }
        }
        for (const [, members, target] of source.matchAll(/^import\s*\{([^}]+)\}\s*from\s*['"]([.][^'"]+)['"]/gm))
            checkNamedImports(file, members, resolve(dirname(file), target));
        if (runtimeLayer(file))
            graph.set(file, imports);
    }
    checkDependencyCycles(graph);
}

export function checkPython(files) {
    execFileSync('python3', ['-B', '-c',
        'import pathlib, sys; [compile(pathlib.Path(p).read_text(), p, "exec") for p in sys.argv[1:]]',
        ...files], {stdio: 'pipe'});
}

import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import test from 'node:test';
import {checkJavaScript} from '../../tools/sourceChecks.js';

function withSourceFixture(files, check) {
    const directory = mkdtempSync(join(tmpdir(), 'usagebeam-source-check-'));
    const originalDirectory = process.cwd();
    try {
        for (const [path, source] of Object.entries(files)) {
            const destination = join(directory, path);
            mkdirSync(dirname(destination), {recursive: true});
            writeFileSync(destination, source);
        }
        process.chdir(directory);
        check(Object.keys(files));
    } finally {
        process.chdir(originalDirectory);
        rmSync(directory, {recursive: true, force: true});
    }
}

test('named-import checks accept async generator exports and aliases', () => {
    withSourceFixture({
        'src/core/streams.js': 'export async function* readLines() { yield "synthetic"; }\n',
        'src/core/consumer.js': 'import {readLines as readMessages} from "./streams.js";\n',
    }, files => assert.doesNotThrow(() => checkJavaScript(files)));
});

test('named-import checks reject symbols absent from the owning module', () => {
    withSourceFixture({
        'src/core/source.js': 'export const present = true;\n',
        'src/core/consumer.js': 'import {missing} from "./source.js";\n',
    }, files => assert.throws(() => checkJavaScript(files), /does not export missing/));
});

test('runtime checks reject dependency cycles and imports across forbidden layers', () => {
    withSourceFixture({
        'src/core/first.js': 'import {second} from "./second.js";\nexport const first = true;\n',
        'src/core/second.js': 'import {first} from "./first.js";\nexport const second = true;\n',
    }, files => assert.throws(() => checkJavaScript(files), /Circular runtime dependency/));
    withSourceFixture({
        'src/ui/actor.js': 'export const actor = true;\n',
        'src/core/domain.js': 'import {actor} from "../ui/actor.js";\n',
    }, files => assert.throws(() => checkJavaScript(files), /core modules cannot import the ui layer/));
});

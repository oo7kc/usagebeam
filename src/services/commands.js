import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {buildPath} from './files.js';

const STATIC_DIRECTORIES = [
    '.local/bin',
    '.cargo/bin',
    '.npm-global/bin',
    '.volta/bin',
    '.asdf/shims',
    '.local/share/mise/shims',
    '.bun/bin',
];

const VERSIONED_DIRECTORIES = [
    ['.local/share/fnm/node-versions', ['installation', 'bin']],
    ['.nvm/versions/node', ['bin']],
    ['.local/share/mise/installs/node', ['bin']],
    ['.asdf/installs/nodejs', ['bin']],
];

function validCommandName(name) {
    return typeof name === 'string' && /^[A-Za-z0-9._+-]+$/.test(name) && name !== '.' && name !== '..';
}

function executable(path) {
    return GLib.file_test(path, GLib.FileTest.IS_REGULAR) &&
        GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE) ? path : null;
}

function versionParts(value) {
    return (String(value).match(/\d+/g) ?? []).map(Number);
}

function compareVersions(a, b) {
    const left = versionParts(a);
    const right = versionParts(b);
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
        const difference = (left[index] ?? 0) - (right[index] ?? 0);
        if (difference)
            return difference;
    }
    return String(a).localeCompare(String(b));
}

function commandDirectories(command) {
    const directories = [];
    let current = command;
    for (let depth = 0; depth < 8; depth++) {
        const directory = GLib.path_get_dirname(current);
        if (!directories.includes(directory))
            directories.push(directory);
        if (!GLib.file_test(current, GLib.FileTest.IS_SYMLINK))
            break;
        try {
            const target = GLib.file_read_link(current);
            current = GLib.canonicalize_filename(target, GLib.path_get_dirname(current));
        } catch {
            break;
        }
    }
    return directories;
}

function versionedCommand(root, suffix, name) {
    const directory = Gio.File.new_for_path(root);
    if (!directory.query_exists(null))
        return null;

    const candidates = [];
    let iterator = null;
    try {
        iterator = directory.enumerate_children('standard::name,standard::type,standard::is-symlink',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let info;
        while ((info = iterator.next_file(null))) {
            if (info.get_is_symlink() || info.get_file_type() !== Gio.FileType.DIRECTORY)
                continue;
            const path = executable(buildPath(root, info.get_name(), ...suffix, name));
            if (path)
                candidates.push({version: info.get_name(), path});
        }
    } catch {
        return null;
    } finally {
        iterator?.close(null);
    }

    candidates.sort((a, b) => compareVersions(b.version, a.version));
    return candidates[0]?.path ?? null;
}

export function findCommand(name, {home = GLib.get_home_dir(), usePath = true} = {}) {
    if (!validCommandName(name))
        throw new Error('Invalid command name');

    const found = usePath ? GLib.find_program_in_path(name) : null;
    if (found)
        return found;

    for (const directory of STATIC_DIRECTORIES) {
        const path = executable(buildPath(home, directory, name));
        if (path)
            return path;
    }

    for (const [directory, suffix] of VERSIONED_DIRECTORIES) {
        const path = versionedCommand(buildPath(home, directory), suffix, name);
        if (path)
            return path;
    }

    const error = new Error(`${name} is not installed`);
    error.code = 'NOT_FOUND';
    throw error;
}

export function createCommandSpec(name, args = [], {runtimes = [], ...options} = {}) {
    if (!Array.isArray(args) || args.some(value => typeof value !== 'string' &&
        (typeof value !== 'number' || !Number.isFinite(value))))
        throw new Error('Command arguments must be strings or numbers');
    if (!Array.isArray(runtimes) || runtimes.some(runtime => !validCommandName(runtime)))
        throw new Error('Command runtimes must be command names');
    const command = findCommand(name, options);
    const directories = commandDirectories(command);
    for (const runtime of runtimes) {
        try {
            const directory = GLib.path_get_dirname(findCommand(runtime, options));
            if (!directories.includes(directory))
                directories.push(directory);
        } catch {
            // The command may be native or resolve its own runtime.
        }
    }
    const inheritedPath = GLib.getenv('PATH') || '/usr/local/bin:/usr/bin:/bin';
    const path = [...directories, ...inheritedPath.split(':').filter(entry => entry && !directories.includes(entry))].join(':');
    return {argv: [command, ...args.map(String)], environment: {PATH: path}};
}

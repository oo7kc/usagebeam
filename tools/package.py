#!/usr/bin/env python3
"""Create a deterministic GNOME extension archive from an explicit allowlist."""

import argparse
import json
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path


def checked_file(source, path):
    """Return a regular, repository-owned packaging input."""
    if path.is_symlink() or not path.is_file():
        raise RuntimeError(f"Invalid packaging input: {path}")
    try:
        path.resolve().relative_to(source)
    except ValueError as error:
        raise RuntimeError(
            f"Packaging input escapes the source tree: {path}"
        ) from error
    return path


def package(source, output):
    source = source.resolve()
    metadata_file = checked_file(source, source / "metadata.json")
    package_file = checked_file(source, source / "package.json")
    metadata = json.loads(metadata_file.read_text())
    version = json.loads(package_file.read_text())["version"]
    uuid = metadata.get("uuid")
    if not isinstance(uuid, str) or not re.fullmatch(
        r"[A-Za-z0-9._-]+@[A-Za-z0-9._-]+", uuid
    ):
        raise RuntimeError("metadata.json contains an invalid extension UUID")
    if not isinstance(version, str) or not re.fullmatch(
        r"[0-9A-Za-z][0-9A-Za-z.+-]*", version
    ):
        raise RuntimeError("package.json contains an invalid release version")
    files = [
        source / name
        for name in (
            "extension.js",
            "prefs.js",
            "metadata.json",
            "stylesheet.css",
            "LICENSE",
        )
    ]
    files.extend(sorted((source / "src").rglob("*.js")))
    files.append(source / "src" / "collector" / "opencode_history.py")
    files.extend(sorted((source / "icons").glob("*.svg")))
    schema = metadata.get("settings-schema")
    if schema != "org.gnome.shell.extensions.usagebeam":
        raise RuntimeError("metadata.json contains an unexpected settings schema")
    files.append(source / "schemas" / f"{schema}.gschema.xml")
    files = [checked_file(source, file) for file in files]
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f"{uuid}-{version}.zip"
    if archive.is_symlink():
        raise RuntimeError(f"Refusing to overwrite archive symlink: {archive}")
    with tempfile.TemporaryDirectory(prefix="usagebeam-schemas-") as scratch:
        subprocess.run(
            [
                "glib-compile-schemas",
                "--strict",
                "--targetdir",
                scratch,
                str(source / "schemas"),
            ],
            check=True,
        )
        payloads = [
            (file.relative_to(source).as_posix(), file.read_bytes()) for file in files
        ]
        payloads.append(
            (
                "schemas/gschemas.compiled",
                (Path(scratch) / "gschemas.compiled").read_bytes(),
            )
        )
        expected = {name for name, _payload in payloads}
        if len(expected) != len(payloads):
            raise RuntimeError("Duplicate paths in extension package")
        with zipfile.ZipFile(
            archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
        ) as target:
            for name, payload in sorted(payloads):
                info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                target.writestr(info, payload)
        with zipfile.ZipFile(archive) as check:
            names = check.namelist()
            if check.testzip() is not None:
                raise RuntimeError("Extension archive failed its integrity check")
            if set(names) != expected:
                raise RuntimeError(
                    "Extension archive contents differ from the runtime allowlist"
                )
            if any(
                name.startswith((".AGENTS/", ".github/", "docs/", "tests/", "tools/"))
                for name in names
            ):
                raise RuntimeError(
                    "Repository-only content entered the extension archive"
                )
    print(archive.resolve())
    return archive


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source", type=Path, default=Path(__file__).resolve().parent.parent
    )
    parser.add_argument("--output", type=Path, default=Path("dist"))
    args = parser.parse_args()
    package(args.source.resolve(), args.output.resolve())

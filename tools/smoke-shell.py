#!/usr/bin/env python3
"""Exercise the packaged extension in a private headless GNOME session."""

import argparse
import json
import os
import shutil
import signal
import subprocess
import tempfile
import time
import zipfile
from datetime import date, timedelta
from pathlib import Path
from xml.sax.saxutils import escape

UUID = "usagebeam@oo7kc.github.io"
SCHEMA = "org.gnome.shell.extensions.usagebeam"
PRODUCT_DIRECTORY = "usagebeam"
TEST_UUID = "usagebeam-ui-test@tests.invalid"


def run(command, env, **options):
    return subprocess.run(
        command, env=env, text=True, capture_output=True, timeout=15, **options
    )


def install(source, archive, prefix, destination):
    extension = prefix / "share" / "gnome-shell" / "extensions" / UUID
    if archive:
        with zipfile.ZipFile(archive) as payload:
            for entry in payload.infolist():
                parts = Path(entry.filename).parts
                if entry.is_dir():
                    continue
                if Path(entry.filename).is_absolute() or ".." in parts:
                    raise RuntimeError(f"Unsafe archive entry: {entry.filename}")
                target = extension.joinpath(*parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(payload.read(entry))
        return
    build = destination / "build"
    subprocess.run(
        ["meson", "setup", str(build), str(source), f"--prefix={prefix}"],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    subprocess.run(
        ["meson", "install", "-C", str(build)], check=True, stdout=subprocess.DEVNULL
    )


def seed_usage(destination):
    """Populate non-personal records so every primary popup widget is constructed."""
    now = int(time.time() * 1000)
    dates = [
        (date.today() - timedelta(days=offset)).isoformat()
        for offset in range(6, -1, -1)
    ]

    def record(provider, name, plan, percentages, models):
        days = [
            {
                "date": day,
                "total": [0, 0, 0, 0, 0, 70_700_000, 38_500_000][index],
                "sessions": index + 1,
                "events": index + 2,
            }
            for index, day in enumerate(dates)
        ]
        return {
            "schemaVersion": 2,
            "id": provider,
            "name": name,
            "plan": plan,
            "accountKey": "0" * 64,
            "capabilities": {"limits": True, "history": True, "models": True},
            "limits": {
                "status": "ready",
                "message": "",
                "updatedAt": now,
                "scope": "account",
                "source": "Synthetic smoke fixture",
                "windows": [
                    {
                        "id": f"{provider}:session",
                        "label": "Session · 5 hours",
                        "usedPercent": percentages[0],
                        "used": None,
                        "limit": None,
                        "unit": "percent",
                        "unlimited": False,
                        "state": "exhausted" if percentages[0] >= 100 else "active",
                        "durationMinutes": 300,
                        "resetsAt": now + 7_200_000,
                    },
                    {
                        "id": f"{provider}:weekly",
                        "label": "Weekly",
                        "usedPercent": percentages[1],
                        "used": None,
                        "limit": None,
                        "unit": "percent",
                        "unlimited": False,
                        "state": "exhausted" if percentages[1] >= 100 else "active",
                        "durationMinutes": 10_080,
                        "resetsAt": now + 172_800_000,
                    },
                    {
                        "id": f"{provider}:reserve",
                        "label": "Weekly reserve",
                        "usedPercent": percentages[2],
                        "used": None,
                        "limit": None,
                        "unit": "percent",
                        "unlimited": False,
                        "state": "exhausted" if percentages[2] >= 100 else "active",
                        "durationMinutes": 10_080,
                        "resetsAt": now + 604_800_000,
                    },
                ],
            },
            "history": {
                "status": "ready",
                "message": "",
                "updatedAt": now,
                "scope": "local",
                "period": {"start": dates[0], "end": dates[-1]},
                "days": days,
                "models": models,
                "source": "Synthetic smoke fixture",
            },
        }

    models = [
        {
            "model": "gpt-5.6-sol",
            "total": 77_200_000,
            "input": 190_000,
            "output": 68_000,
            "cacheRead": 76_942_000,
            "cacheWrite": 0,
        },
        {
            "model": "codex-auto-review",
            "total": 24_100_000,
            "input": 97_000,
            "output": 8_000,
            "cacheRead": 23_995_000,
            "cacheWrite": 0,
        },
        {
            "model": "gpt-6-astra",
            "total": 7_900_000,
            "input": 42_000,
            "output": 62_000,
            "cacheRead": 7_796_000,
            "cacheWrite": 0,
        },
    ]
    target = destination / "state" / PRODUCT_DIRECTORY
    target.mkdir(parents=True, exist_ok=True)
    records = {
        "codex": record("codex", "Codex", "Plus", (100, 94, 83), models),
        "claude": record("claude", "Claude Code", "Pro", (46, 7, 0), models),
        "opencode": record("opencode", "OpenCode", None, (0, 0, 0), models),
    }
    records["opencode"]["accountKey"] = None
    records["opencode"]["capabilities"]["limits"] = False
    records["opencode"]["limits"].update(status="unsupported", windows=[], updatedAt=None,
                                         message="OpenCode account limits are unavailable.")
    for provider, data in records.items():
        (target / f"{provider}.json").write_text(json.dumps(data))
    # Separate fixtures survive asynchronous collector updates to the cache.
    (destination / "ui-fixtures.json").write_text(json.dumps(records))


def smoke(source, archive, destination, scale=1, text_scale=1.0, *,
          width=1280, height=1024, system_fonts=False, stress=False):
    destination.mkdir(parents=True, exist_ok=True)
    prefix = destination / "install"
    install(source, archive, prefix, destination)
    shutil.copytree(
        source / "tests/shell", prefix / "share/gnome-shell/extensions" / TEST_UUID
    )
    isolated_home = destination / "home"
    isolated_home.mkdir(parents=True, exist_ok=True)
    runtime = destination / "runtime"
    runtime.mkdir(mode=0o700)
    seed_usage(destination)
    env = {
        **os.environ,
        "HOME": str(isolated_home),
        "PATH": "/usr/bin:/bin",
        "XDG_CONFIG_HOME": str(destination / "config"),
        "XDG_DATA_HOME": str(prefix / "share"),
        "XDG_CACHE_HOME": str(destination / "cache"),
        "XDG_STATE_HOME": str(destination / "state"),
        "GSETTINGS_BACKEND": "keyfile",
        "XDG_RUNTIME_DIR": str(runtime),
        "GSETTINGS_SCHEMA_DIR": str(
            prefix / "share/gnome-shell/extensions" / UUID / "schemas"
        ),
        "LIBGL_ALWAYS_SOFTWARE": "1",
        "USAGEBEAM_TEST_OUTPUT": str(destination),
        "USAGEBEAM_TEST_SCALE": str(scale),
        "USAGEBEAM_STRESS": "1" if stress else "0",
        "USAGEBEAM_INSTALL_PATH": str(prefix / "share/gnome-shell/extensions" / UUID),
        "WAYLAND_DISPLAY": "usagebeam-test",
    }
    # Never let inherited provider paths expose the real account to a test shell.
    for name in ("CODEX_HOME", "CLAUDE_CONFIG_DIR"):
        env.pop(name, None)
    # Exercise both a user-installed font and a system fallback without copying
    # or distributing font files. The extension must inherit either choice.
    font_request = "Noto Sans" if system_fonts else "SF Pro Text"
    font = run(
        ["fc-match", "-f", "%{file}", "SF Pro Text"], os.environ, check=True
    ).stdout
    font_config = destination / "fonts.conf"
    extra_fonts = "" if system_fonts else f"<dir>{escape(str(Path(font).parent))}</dir>"
    font_config.write_text(
        "<fontconfig><include>/etc/fonts/fonts.conf</include>"
        f"{extra_fonts}</fontconfig>"
    )
    env["FONTCONFIG_FILE"] = str(font_config)
    resolved_font = run(
        ["fc-match", "-f", "%{family}", font_request], env, check=True
    ).stdout
    if system_fonts and "SF Pro" in resolved_font:
        raise RuntimeError("System-font case still resolves SF Pro; font fallback was not isolated")
    configured_font = resolved_font.split(",", 1)[0].strip()
    if not configured_font:
        raise RuntimeError(f"Could not resolve configured font: {font_request}")
    env["USAGEBEAM_EXPECTED_FONT"] = configured_font
    run(
        [
            "gsettings",
            "set",
            "org.gnome.desktop.interface",
            "scaling-factor",
            str(scale),
        ],
        env,
        check=True,
    )
    run(
        [
            "gsettings",
            "set",
            "org.gnome.desktop.interface",
            "font-name",
            f"'{configured_font} 11'",
        ],
        env,
        check=True,
    )
    run(
        [
            "gsettings",
            "set",
            "org.gnome.desktop.interface",
            "text-scaling-factor",
            str(text_scale),
        ],
        env,
        check=True,
    )
    run(
        ["gsettings", "set", SCHEMA, "enabled-providers", "['codex', 'claude', 'opencode']"],
        env,
        check=True,
    )
    run(
        ["gsettings", "set", SCHEMA, "panel-position", "'left-of-calendar'"],
        env,
        check=True,
    )
    run(
        [
            "gsettings",
            "set",
            "org.gnome.shell",
            "enabled-extensions",
            f"['{UUID}', '{TEST_UUID}']",
        ],
        env,
        check=True,
    )
    run(
        [
            "gsettings",
            "set",
            "org.gnome.shell",
            "welcome-dialog-last-shown-version",
            "999",
        ],
        env,
    )
    bus = subprocess.Popen(
        ["dbus-daemon", "--session", "--nofork", "--print-address=1"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    env["DBUS_SESSION_BUS_ADDRESS"] = bus.stdout.readline().strip()
    log_path = destination / "shell.log"
    shell = None
    try:
        with log_path.open("w") as log:
            shell = subprocess.Popen(
                [
                    "gnome-shell",
                    "--headless",
                    "--no-x11",
                    "--virtual-monitor",
                    f"{width * scale}x{height * scale}",
                    "--wayland-display",
                    "usagebeam-test",
                ],
                env=env,
                stdout=log,
                stderr=log,
                start_new_session=True,
            )
        command = [
            "gdbus",
            "call",
            "--session",
            "--dest",
            "org.gnome.Shell.Extensions",
            "--object-path",
            "/org/gnome/Shell/Extensions",
            "--method",
            "org.gnome.Shell.Extensions.GetExtensionInfo",
            UUID,
        ]
        deadline = time.monotonic() + 30
        info = ""
        while time.monotonic() < deadline and shell.poll() is None:
            result = run(command, env)
            info = result.stdout
            if "'state': <1.0>" in info:
                break
            if "'state': <3.0>" in info:
                raise RuntimeError(f"Extension failed: {info}")
            time.sleep(0.4)
        else:
            raise RuntimeError(f"Extension did not become active: {info}")
        print("PASS: packaged extension loads in a private GNOME Shell session")
        results_path = destination / "ui-results.json"
        deadline = time.monotonic() + (90 if stress else 25)
        while (
            time.monotonic() < deadline
            and not results_path.exists()
            and shell.poll() is None
        ):
            time.sleep(0.2)
        if not results_path.exists():
            raise RuntimeError(f"UI tests did not complete; inspect {log_path}")
        results = json.loads(results_path.read_text())
        if not results["ok"] and not stress:
            raise RuntimeError(f"UI check failed: {results['error']}")
        if results["ok"]:
            print("PASS: private-shell UI assertions")
        preferences = run(
            ["gjs", "-m", str(source / "tests/shell/preferences.js")],
            {**env, "GSETTINGS_BACKEND": "memory"},
        )
        if preferences.returncode:
            raise RuntimeError(
                "Preferences smoke test failed:\n"
                f"{preferences.stdout}{preferences.stderr}"
            )
        print(preferences.stdout.strip())
        print(f"UI geometry and screenshots: {destination}")
        run(["gnome-extensions", "disable", TEST_UUID], env, check=True)
        cycles = 10 if stress else 1
        for cycle in range(cycles):
            run(["gnome-extensions", "disable", UUID], env, check=True)
            disabled = run(command, env, check=True).stdout
            if "'state': <2.0>" not in disabled:
                raise RuntimeError(f"Disable cycle {cycle + 1} did not reach INACTIVE")
            run(["gnome-extensions", "enable", UUID], env, check=True)
            enabled = run(command, env, check=True).stdout
            if "'state': <1.0>" not in enabled:
                raise RuntimeError(f"Enable cycle {cycle + 1} did not reach ACTIVE")
        print(f"PASS: {cycles} verified disable/re-enable cycles")
        # Leave no collector running while the private shell itself shuts down.
        run(["gnome-extensions", "disable", UUID], env, check=True)
    finally:
        if shell and shell.poll() is None:
            os.killpg(shell.pid, signal.SIGTERM)
            try:
                shell.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(shell.pid, signal.SIGKILL)
                shell.wait()
        bus.terminate()
        bus.wait(timeout=5)
        print(f"GNOME log: {log_path}")
    contents = log_path.read_text(errors="replace")
    if "Gjs-CRITICAL" in contents and UUID in contents:
        raise RuntimeError(f"Extension emitted a GJS critical; inspect {log_path}")
    if (
        "St-WARNING" in contents
        or "UsageBeam could not" in contents
        or "JS ERROR" in contents
    ):
        raise RuntimeError(f"UI, stylesheet, or JavaScript warning; inspect {log_path}")
    results.update(resolvedFont=resolved_font, lifecycleCycles=cycles)
    (destination / "ui-results.json").write_text(json.dumps(results, indent=2))
    if not results["ok"]:
        raise RuntimeError(f"UI stress failures; inspect {destination / 'ui-results.json'}")


def matrix(source, archive, destination, selected=None):
    cases = [
        ("desktop-sf", 1280, 1024, 1, 1.0, False),
        ("laptop-fallback", 1366, 768, 1, 1.0, True),
        ("small-fallback", 1024, 600, 1, 1.0, True),
        ("large-text", 1920, 1080, 1, 1.5, True),
        ("hidpi-fallback", 1920, 1080, 2, 1.0, True),
        ("hidpi-large-text", 1280, 1024, 2, 1.25, False),
    ]
    outcomes = []
    for name, width, height, scale, text_scale, fallback in cases:
        if selected and name != selected:
            continue
        print(f"CASE: {name} ({width}x{height} logical, scale {scale}, text {text_scale})", flush=True)
        try:
            smoke(source, archive, destination / name, scale, text_scale,
                  width=width, height=height, system_fonts=fallback, stress=True)
            outcomes.append({"case": name, "ok": True})
        except (RuntimeError, subprocess.SubprocessError) as error:
            outcomes.append({"case": name, "ok": False, "error": str(error)})
            print(f"FAIL: {name}: {error}", flush=True)
    (destination / "matrix-results.json").write_text(json.dumps(outcomes, indent=2))
    return all(result["ok"] for result in outcomes)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source", type=Path, default=Path(__file__).resolve().parent.parent
    )
    parser.add_argument(
        "--archive",
        type=Path,
        help="Test an already-built release archive instead of a Meson install",
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument("--matrix", action="store_true", help="Run isolated portability stress cases")
    parser.add_argument("--case", choices=["desktop-sf", "laptop-fallback", "small-fallback",
                        "large-text", "hidpi-fallback", "hidpi-large-text"], help="Select one matrix case")
    parser.add_argument(
        "--scale",
        type=int,
        choices=[1, 2],
        default=1,
        help="Private virtual-monitor scale",
    )
    parser.add_argument(
        "--text-scale",
        type=float,
        choices=[1.0, 1.25],
        default=1.0,
        help="Accessibility text scale",
    )
    args = parser.parse_args()
    if args.case and not args.matrix:
        parser.error("--case requires --matrix")
    if args.matrix:
        output = args.output.resolve() if args.output else Path(tempfile.mkdtemp(prefix="usagebeam-stress-"))
        raise SystemExit(0 if matrix(args.source.resolve(), args.archive.resolve() if args.archive else None, output, args.case) else 1)
    smoke(
        args.source.resolve(),
        args.archive.resolve() if args.archive else None,
        args.output.resolve()
        if args.output
        else Path(tempfile.mkdtemp(prefix="usagebeam-shell-")),
        args.scale,
        args.text_scale,
    )

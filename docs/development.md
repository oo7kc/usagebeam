# Development

UsageBeam is a GNOME Shell extension with no runtime package dependencies.
Node runs the pure JavaScript tests and repository checks. GJS runs collection
and integration tests. Python reads OpenCode SQLite history and packages the
extension.

## Architecture

`extension.js` owns Shell enable/disable, settings signals, and notifications.
`prefs.js` opens the GTK preferences UI. Both entry points delegate implementation
to modules under `src/`.

- `core/` contains provider identity, normalization, dates, token aggregation,
  record construction and validation, formatting, quota thresholds, and refresh
  policy. These modules are pure JavaScript and run in both Node and GJS.
- `providers/` translates provider responses and history entries into the shared
  usage contract. Adapters receive an explicit collector context; they do not
  access Shell actors, manage refresh timers, or persist credentials.
- `services/` handles private files, snapshot persistence, incremental JSONL
  history, OpenCode collection, HTTP, bounded streams, subprocesses, and RPC.
  `UsageService` owns scheduling, cancellation, retry state, and notifications.
- `collector/` composes provider adapters with their I/O context and owns the
  subprocess entry point. The OpenCode helper selects only usage fields from
  SQLite through a read-only connection.
- `ui/` contains the panel readout, popup controller, widget factories,
  presentation helpers, adaptive layout, placement, and preferences.

Core modules import only core modules. Providers import core and provider
modules. Services import core and service modules. UI imports core and UI
modules. The collector composes core, providers, services, and collector modules.
Repository checks enforce these boundaries, named imports, and acyclic runtime
dependencies.

Account limits and local activity remain separate. The record validator is the
boundary for collector results and saved snapshots. Record version, cache
versions, settings keys, provider units, and token semantics are compatibility
contracts; refactoring must preserve them.

## Conventions

Use four spaces in JavaScript and Python, single quotes in JavaScript, and
descriptive lowerCamelCase JavaScript module and function names. Python follows
snake_case. Classes use PascalCase; constants use UPPER_SNAKE_CASE. Keep native
GNOME API names and provider field names in their original form.

Name factories `create…`, presentation helpers `get…`, text formatters `format…`,
parsers `parse…`, and validators `validate…` or `assert…`. Internal class fields
use an underscore prefix. Include units in names such as `timeoutMs` and
`maxOutputBytes`. Prefer named options when constructors need several unrelated
dependencies.

Keep modules focused on one responsibility. Use explicit imports from the module
that owns a capability instead of barrel exports. Expand asynchronous callbacks
and error handling so cleanup paths are visible. Comments explain constraints or
reasoning; they should not narrate obvious statements. User-facing copy describes
usage and actionable states without exposing implementation details.

The popup inherits its surface from GNOME Shell so system colors and configured
popup blur can style it. Widget styles retain the existing layout, accessibility,
accent controls, and quota severity.

## Verification and installation

Run `npm run check` for syntax, module boundaries, schemas, pure unit tests, GJS
integration, and Python SQLite tests. Run `npm run test:stress` after changing
collection bounds, caches, cancellation, or RPC. All fixtures must be synthetic
and must exclude credentials and conversation content.

Run `npm run pack`, then test that exact archive with
`python3 tools/smoke-shell.py --archive dist/usagebeam@oo7kc.github.io-2.0.0-alpha.5-dev.0.zip`.
Use `--matrix` for the monitor, font, scaling, constrained-layout, and repeated
lifecycle profiles. The harness runs in a private desktop with synthetic usage.
The matrix includes fractional scaling and an ultrawide monitor; use
`--secondary-monitor` separately to exercise a second monitor and primary-display
changes. Placement assertions measure the combined calendar/indicator bounds
against the hosting monitor's center, including work-area changes from side docks.

Install the verified archive with
`gnome-extensions install --force dist/usagebeam@oo7kc.github.io-2.0.0-alpha.5-dev.0.zip`.
Existing preferences and usage data are retained. A new GNOME login is needed to
ensure a replacement extension's JavaScript modules are loaded.

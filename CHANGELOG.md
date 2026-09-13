# Changelog

All notable UsageBeam changes are documented here.

## Unreleased

### Added

- Optional OpenCode support with a seven-day panel total, daily activity, model
  breakdowns, and the native OpenCode icon.
- Read-only OpenCode activity collection with no credential access or extra
  Python packages. Requires Python 3.11 or newer with SQLite support.
- Provider enablement, ordering, and default-provider controls in preferences.
- Notification threshold, history retention, and safe saved-data controls.
- Clear-data requests also discard in-memory snapshots before activity rebuilds.

### Changed

- UsageBeam now follows the configured GNOME system font while retaining
  tabular figures for usage metrics.
- Refined the panel, provider selector, quota meters, activity chart, model
  totals, status colors, and responsive hierarchy around a shared Beam accent.
- Refresh feedback and provider transitions remain compact and avoid animating
  popup geometry.
- Background refreshes update the panel without rebuilding a closed popup.
- Large transcript records are scanned once per chunk, reducing collection work.

### Fixed

- Provider names now align optically with the smaller panel statistics,
  including when the configured font or display scale changes.
- Oversized Codex records unrelated to token usage no longer cause a persistent
  incomplete-history warning.
- Local-only providers retain saved activity during temporary failures and
  reduce retry frequency when their source is unavailable.

## 2.0.0-alpha.3 - 2026-09-09

### Added

- UsageBeam product identity with the permanent extension UUID
  `usagebeam@oo7kc.github.io` and settings schema
  `org.gnome.shell.extensions.usagebeam`.
- Active-provider panel readout with provider icon, shortest current quota, and
  reset countdown.
- Left area, right area, left-of-calendar, and right-of-calendar placement.
- Expandable seven-day activity chart and compact per-model token totals.
- Native preferences for placement, refresh interval, and notifications.
- Explicit quota severity states: caution at 80%, warning at 90%, and exhausted
  at 100%.
- Product screenshots for the panel indicator, account limits, and local
  activity views.

### Changed

- Rebuilt the popup as a compact, accent-aware GNOME surface with aligned quota
  metrics and stable panel geometry.
- Account limits, local activity, and saved results now remain available
  independently when one source cannot refresh.
- Codex discovery supports common user-local and Node version-manager layouts.
- Recognized Freeby alpha settings and derived data migrate without copying
  credentials or overwriting existing UsageBeam data.

### Fixed

- Expanded menus adapt to smaller work areas with keyboard-accessible pagination,
  preserving access to all quotas and model totals without nested scrolling.
- Calendar-gap centering now accounts for neighboring panel extensions and their
  size changes.
- Local activity totals recover when provider history files are rewritten or
  contain an unreadable record.
- Large or malformed provider responses no longer interrupt future refreshes.
- Calendar-side readouts anchor toward the clock on both sides, keeping reserved
  width outside the visible gap when provider names and countdowns change.
- Each quota now shows its reset countdown below the bar as `Resets in …`, with
  its percentage right-aligned above the bar.
- Daily chart columns allocate visible bottom-aligned bars for non-zero activity.
- Model fills remain compact and stable across repeated layout passes.
- Calendar placement remains fixed while providers and quota values change.
- Reset values, percentages, and separator dots retain consistent alignment.
- The active-provider readout uses compact internal and calendar-side spacing,
  while retaining a fixed width across provider changes.
- Panel usage metrics share the provider label's visual baseline.
- The panel always prefers the shortest available quota period, even at 0% or
  100%, instead of switching to a longer window with higher usage.
- Seven-day activity emphasizes its local/account scope without repeating a
  date range already represented by the chart.
- The activity disclosure now shows only its title and chevron; period, totals,
  and source remain in the expanded content where they are needed.
- Usage alerts now progress through configured, warning, and exhausted milestones
  once per quota period and combine simultaneous crossings into one notification.
- Quota labels use compact `5H Session` and `Weekly Reserve` names, while expanded
  activity keeps scope implicit and gives the chart more breathing room.
- Expired quota windows are not presented as current cached data.
- Empty, malformed, or unavailable provider responses are never shown as zero
  usage.

### Removed

- Unverified Cursor and Copilot preview adapters. Providers now ship only after
  their data sources and failure states have completed validation.
- Superseded runtime scripts and historical UI artifacts that were not part of
  the product.

## 2.0.0-alpha.2 - 2026-09-06

### Added

- Claude Code installation and saved OAuth sign-in detection.
- Supported 5-hour, weekly, and model-scoped Claude quota windows.
- Incremental Claude Code activity with per-model input, output, cache-read, and
  cache-write totals.
- Shared provider switching between Codex and Claude Code.

### Fixed

- Expired cached quota windows are discarded after their reset time.
- Missing, absent, and expired Claude authentication remain distinct states.

### Compatibility

- Tested with Claude Code 2.1.218.
- Supports standard and model-scoped limits, expired sign-ins, duplicate local
  activity records, and separate cache-token categories.
- Live account-limit validation was not available for this prerelease.

## 2.0.0-alpha.1 - 2026-09-06

### Added

- Codex account limits with distinct quota periods and reset times.
- Incremental local Codex history with seven-day and model aggregates.
- Private local storage and temporary saved-value recovery during refresh
  failures.

### Fixed

- Refresh occurs after resume instead of before suspend.
- Repeated refreshes no longer overlap.
- Notifications appear once for each reached milestone and quota period.

## 1.0.2 - 2026-04-27

- Added GNOME 49 and 50 metadata compatibility and removed deprecated extension
  version metadata.
- Kept the dropdown open after manual refresh and fixed an invalid popup
  accessibility property.

Earlier history remains available in the repository's Git tags and releases.

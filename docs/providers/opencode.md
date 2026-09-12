# OpenCode support

UsageBeam shows seven days of OpenCode token activity and totals by model from
sessions saved on this device. Select OpenCode to see its token total in the
panel; **7d** identifies the period.

## Get started

1. Run a session in OpenCode.
2. Enable OpenCode in UsageBeam preferences.
3. Select OpenCode and choose **Refresh**.

Python 3.11 or newer with SQLite support is required. No extra Python packages are needed.
OpenCode is optional and can be enabled without changing your current provider
order or default provider.

## What is included

- A daily token chart and model totals across local projects.
- Input, output, reasoning, and cache tokens as recorded by OpenCode. Reasoning
  is included in output totals.
- Saved activity during temporary read failures.

OpenCode does not provide a supported account-quota feed for this integration.
UsageBeam therefore shows no subscription percentage, reset countdown, or quota
alerts for OpenCode. Its local activity does not require access to API keys or
sign-in tokens.

## Compatibility and privacy

Validated with OpenCode 1.18.29 and its local SQLite message history. UsageBeam
opens the database read-only and saves only aggregate usage. It does not start
OpenCode, load its plugins, change its database, or read its credentials.

The standard location is `$XDG_DATA_HOME/opencode/opencode.db` (normally
`~/.local/share/opencode/opencode.db`). A custom `OPENCODE_DB` path is supported
when it is available to the GNOME session. Legacy JSON storage and experimental
v2 activity formats are not yet supported; incomplete coverage is shown clearly.
Imported or forked sessions can include copied activity in their saved records.

If no database is found, run OpenCode once using the same desktop account. If
reading fails temporarily, refresh again after OpenCode finishes saving.

See [OpenCode's documentation](https://opencode.ai/docs/troubleshooting/) for
its storage locations and [CLI guide](https://opencode.ai/docs/cli/) for setup.

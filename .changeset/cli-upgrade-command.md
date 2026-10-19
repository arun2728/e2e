---
"e2e": patch
---

Add `e2e upgrade` (alias `e2e update`): upgrades `e2e` to the latest release, a dist-tag such as `nightly`, or one version, and moves every `@e2e-dev/*` package in the project to the newest release whose peer ranges accept it. The project's package manager installs them; `--dry-run` prints the plan. Each upgrade sends an `e2e_upgrade_completed` telemetry event with the result and the `e2e` versions before and after. The update notice now suggests `e2e upgrade` instead of an install command for `e2e` alone.

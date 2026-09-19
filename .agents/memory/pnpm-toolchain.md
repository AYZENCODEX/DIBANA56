---
name: Imported pnpm toolchain
description: Environment constraint when validating this imported pnpm workspace.
---

The imported workspace pins a specific pnpm release in its root package manifest. In environments where that release is not already cached, the available pnpm wrapper attempts to bootstrap it before running scripts; offline validation can therefore fail before TypeScript or tests start.

**Why:** Full verification was blocked before command execution because the pinned package-manager bootstrap could not complete offline.

**How to apply:** Check whether the pinned pnpm release is available before relying on workspace scripts; do not treat a bootstrap failure as an application-code failure.
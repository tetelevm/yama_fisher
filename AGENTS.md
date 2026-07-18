# AGENTS.md — repository workflow rules

## Before making changes

1. Read `docs/business.md` for product requirements and `docs/technical.md` for
   the architecture, contracts, and code map.
2. Read `manifest.json`, every affected file, and the producers and consumers
   of any data you plan to change.
3. Inspect the current diff and preserve unrelated user changes.
4. Identify the context that owns the behavior before editing.

Do not guess contracts that are already defined. Do not fix behavior from an
isolated code fragment.

## Changes

- Follow the context boundaries, file responsibilities, and invariants in
  `docs/technical.md`.
- When changing a shared contract, update every producer and consumer.
- Preserve stored-state compatibility or add an explicit migration.
- Update `docs/business.md` when user-visible behavior changes.
- Update `docs/technical.md` when architecture, contracts, or responsibilities
  change.
- Do not add a package manager, build system, TypeScript, settings page, store
  publishing, a new page type, or another browser target without an explicit
  request.
- Do not edit `assets/vendor/` unless the task requires it.
- Do not perform unrelated formatting or renaming.
- Do not delete or overwrite unrelated user changes.
- Do not use destructive Git commands.

## Style

- Preserve the existing plain JavaScript style.
- Keep project-owned JS, CSS, and HTML lines within 100 characters. Vendor
  files are exempt.
- Give every user-facing value populated or replaced at runtime in an HTML
  template a representative valid example, including text and visual state
  classes. Do not leave dynamic text empty. Internal command attributes and
  containers populated only with cloned child templates are exempt.
- Create a helper only when it clarifies a contract or removes duplication.
- Comment non-obvious invariants, not obvious operations.
- Keep `README.md` in English and `README_RU.md` in Russian.

## Verification

After changing JavaScript, check every project-owned JavaScript file:

```bash
find src -name '*.js' -print0 | xargs -0 -n1 node --check
```

Always check the diff and line lengths:

```bash
git diff --check
rg -n '.{101}' src popup --glob '*.js' --glob '*.css' --glob '*.html'
```

After changing `manifest.json` or script order, validate the manifest and
background script paths:

```bash
python3 -m json.tool manifest.json >/dev/null
node - <<'NODE'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
for (const file of manifest.background.scripts) {
    if (!fs.existsSync(file)) throw new Error(`Missing background script: ${file}`);
}
NODE
```

For changed behavior, run a focused check of the corresponding documented
invariant.

If browser behavior changed, reload the temporary extension. After changing
the manifest, content script, or MAIN-world scripts, also reload the Yandex
Music tab. Account for previously stored jobs.

## Before finishing

- Confirm that the request is fully implemented in the correct context.
- Confirm that contracts, documentation, and all affected consumers agree.
- Run the required and focused checks.
- State the result and any required reload step in the final response.

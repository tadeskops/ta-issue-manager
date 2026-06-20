# Repository instructions for AI coding agents

These rules apply to **every** task in this repository (issue triage,
feature work, refactors, bug fixes, doc edits, anything). They are
binding — do not skip them because the user did not restate them in the
current request.

## 0. Repository scope & two-repo workspace boundary

This workspace contains **two sibling repos** under `C:\CR7\TAMC\IRP_Repo\`:

| Folder | Repo | Spec file | Stack |
|---|---|---|---|
| `ta-issue-manager/` (this repo) | `github.com/tadeskops/ta-issue-manager` | `requirement.md` | Handover track — Google Apps Script + Sheet + Form + Drive |
| `ta-society-helpdesk/` (sibling) | `github.com/tadeskops/ta-society-helpdesk` | `tsh_requirement.md` | Daily track — GitHub Pages + Issues + Cloudflare Worker |

**Hard boundary rules — do not cross them:**

1. **Edits scope to one repo per turn.** When the user's request touches
   files inside this repo (`ta-issue-manager/...`), all edits, commits,
   and pushes happen here. When the request touches files inside
   `ta-society-helpdesk/`, switch to that repo's working directory and
   follow **its** `.github/copilot-instructions.md`. **Never make the
   same change in both repos in one push** unless the user explicitly
   asks for a coordinated change.

2. **Spec file = `requirement.md` for this repo only.** Updates to
   handover-track behavior (roles, sheets, API, config, Apps Script
   triggers) go into `requirement.md` here. The daily-track spec
   (`tsh_requirement.md`) lives in the sibling repo and is **out of
   scope** for changes made here. Do not edit `tsh_requirement.md` from
   this repo's working tree even if a stale copy is present.

3. **Push target for this repo.** Every `git push` from this repo goes
   to `origin` = `github.com/tadeskops/ta-issue-manager` only. Verify
   with `git remote get-url origin` before any push (per §3.3).

4. **Cross-repo references are link-only.** When the handover landing
   page needs to point at the daily track (or vice-versa), use a
   plain `<a href="https://tadeskops.github.io/ta-society-helpdesk/...">`
   link configured via a CONFIG row (`DAILY_TRACK_URL` — see
   `requirement.md` §5.1). Do not import code, copy assets verbatim,
   or share build steps across the two repos.

5. **If the user asks an ambiguous question** that could apply to
   either repo, infer scope from the working directory of the file the
   user attached (or last edited). When uncertain, ask once before
   making changes.

6. **Commit AND push identity is non-negotiable for BOTH repos.** Every
   commit AND every push from either `ta-issue-manager` or
   `ta-society-helpdesk` must originate from the `tadeskops` GitHub
   account (`ta.deskops@gmail.com`). Before **any** `git commit` or
   `git push`, run the identity check in §3.3 — if `user.name` /
   `user.email` do not match, abort and tell the user. Never bypass,
   never silently reconfigure global git identity to satisfy it, and
   never commit or push with a different account "just this once".
   The fix is **always** local-scope:
   `git -C <repo-path> config user.name tadeskops` and
   `git -C <repo-path> config user.email ta.deskops@gmail.com`,
   never `git config --global`.

7. **`tadeskops`-only services. No corporate accounts, registries, or
   tooling — ever.** This is a personal `tadeskops` project hosted on
   free public infrastructure. The workstation running the agent may
   also be a corporate dev machine (with its own GitHub Enterprise
   account, internal npm registry, internal PyPI mirror, internal
   container registry, internal CA bundle, VPN-only DNS, etc.). None
   of that may bleed into this repo.

   **Allowed services for this repo:**
   - `github.com/tadeskops/*` only (never any GHE/internal mirror).
   - Public npm registry: `https://registry.npmjs.org/` only — applies
     to any future `clasp`/Node tooling (`clasp` itself comes from
     `@google/clasp` on public npm).
   - Public Google account `ta.deskops@gmail.com` for the Apps Script
     project, Sheet, Form, and Drive folders.
   - Public GitHub Actions runners (`ubuntu-latest`, etc.) — no
     self-hosted corporate runners.

   **Forbidden — refuse, surface to user, do NOT silently work around:**
   - Any corporate / internal package registry (npm, PyPI, NuGet,
     Maven, container, etc.).
   - Any corporate Git remote (GHE, Bitbucket Server, internal GitLab).
   - Any corporate identity (work email as commit author, work Google
     account on Apps Script / Sheet / Form / Drive).
   - Any corporate CI runner, build farm, secret store, or VPN-gated
     resource.

   **Concrete defences (apply when adding/changing tooling):**
   - Any committed `.npmrc` MUST pin `registry=https://registry.npmjs.org/`
     and clear auth tokens. The repo-local `.npmrc` overrides the
     user-global one, so a corporate `~/.npmrc` cannot redirect this
     project's installs.
   - If a command in this repo ever hits a corporate hostname (e.g.
     `*.deere.com`, `artifactory.*`, internal `*.corp.*`), that is a
     bug. Stop, tell the user, and fix the registry pinning.
   - GitHub Actions workflows MUST use `runs-on: ubuntu-latest` (or
     equivalent public runner), never `runs-on: self-hosted` or any
     corporate runner label.
   - Never import or read `~/.gitconfig`, `~/.npmrc`, `~/.clasprc.json`
     from a corporate Google account, or any other user-global config
     to "make it work" — that is exactly how corporate config leaks
     in. The `clasp` token in `~/.clasprc.json` MUST belong to the
     `ta.deskops@gmail.com` account.

   The reverse direction is also forbidden: do not use the `tadeskops`
   identity, this repo's Google Apps Script project, or any other
   personal resource for corporate work. The two contexts are
   airtight.

## 1. `requirement.md` is the spec — keep it in sync

`requirement.md` at the repo root is the **single source of truth** for
this project's behavior, roles, sheet schemas, API actions, config keys,
and feature flags. Any code change that affects observable behavior MUST
be reflected in `requirement.md` in the same change.

### When you MUST update `requirement.md`

Update it whenever a change touches any of the following:

- **Roles or capabilities** — a role gains/loses an action, a new role is
  added, the role-resolution logic changes.
- **API actions** — a new `case` is added to `api_call` in
  [`src/Router.gs`](../src/Router.gs), an action is renamed/removed, its
  allow-list (`COMMITTEE_ONLY` / `BUILDER_ALLOWED` / `RESIDENT_ALLOWED`)
  changes, or its payload shape changes.
- **Sheet schemas** — a column is added/removed/reordered in any of
  `PENDING_REVIEW`, `LIVE_ISSUES`, `CLOSED_ISSUES`, `ARCHIVES_ISSUES`,
  `CATEGORY_MASTER`, `CONFIG`, or `Form Responses 1`. Update the
  corresponding `*_COL` constant table description.
- **Config keys** — a new row in `DEFAULT_FEATURES`, `DEFAULT_TUNABLES`,
  or any other `CONFIG`-sheet key consumed by code.
- **Pages / routing** — a page is added/removed from `PAGE_MAP`, the URL
  contract changes, or a feature flag starts/stops gating a page.
- **External integrations** — Drive folder layout, Google Form fields,
  scopes added to `appsscript.json`, etc.
- **Setup runbook** — a new bootstrap function appears (`setupX`,
  `migrateY`). It MUST be added both to `requirement.md`'s setup section
  and to the **Apps Script setup runbook** table in `README.md`.

### When you do NOT need to update `requirement.md`

- Pure refactors with zero observable change.
- Cosmetic changes (whitespace, comment clarification, typo fixes in
  source comments).
- Local-dev / preview-server / build-script edits that don't ship to
  Apps Script.

### How to update

1. Read the existing `requirement.md` section that is affected.
2. Edit **in place** — preserve heading numbering and the tabular style.
   Do not append "changelog" entries; the file is a spec, not a log.
3. If the change is substantial (new role, new action set, new sheet),
   add a new numbered subsection in the appropriate top-level section
   rather than overloading an existing bullet.
4. Cross-check that the README's setup runbook is also up-to-date if a
   new function needs to be run by an operator.

### How to verify before finishing the task

Before reporting a task as complete, mentally walk through this
checklist:

- [ ] Did this change touch a `case` in `api_call`, a `*_COL` constant,
      a `DEFAULT_FEATURES` / `DEFAULT_TUNABLES` key, a `PAGE_MAP` entry,
      or a `setup*` / `migrate*` function?
- [ ] If yes → is `requirement.md` updated in the same commit?
- [ ] If a new operator-run function exists → is the **README runbook
      table** updated too?

If any answer is "no", finish the doc update before closing out.

## 2. Other standing rules

- **Do not create stray markdown files** to document changes — keep
  history in commit messages / PR descriptions. The only docs that ship
  with the repo are `README.md`, `requirement.md`, and the files under
  `.github/`. Anything else under `docs/` or root should be discussed
  with the user first.
- **`.gs` files are not parsed locally.** After editing function
  boundaries (signatures, braces, top-level returns), audit the file
  with a brace-depth scan before pushing — Apps Script will only surface
  the syntax error after `clasp push`.
- **Honor existing patterns.** Sheet reads use `*_COL` constants, never
  magic indices. API calls use `API.call(action, payload)` from
  [`src/partials/api.html`](../src/partials/api.html), never raw
  `google.script.run`. Drive sharing goes through
  `uploadSubmissionPhotos_` / `driveImageUrl_`, never inline.
- **Server-trust user identity.** Email/role come from
  `Session.getActiveUser()` + `getUserRole()`, never from a
  client-supplied payload field.

## 2.1 Significant new features must be feature-flag gated

Any change that adds a **significant new feature** must ship behind a
`FEATURE_*` flag in `DEFAULT_FEATURES` (`src/Config.gs`), enforced on
both server and client, and the agent must explicitly justify the
chosen default in the PR/commit body.

### How to decide if a change qualifies

A change qualifies as "significant" — and therefore needs a flag —
if **any** of the following is true:

- It adds a new API action (a new `case` in `api_call`).
- It adds a new UI affordance the user can interact with (a new button,
  panel, page, modal, drag-drop zone, file picker, etc.).
- It writes to a sheet, Drive, or any external system in a code path
  that did not previously write there.
- It changes a role's capabilities (committee/builder/resident gains a
  new action).
- It is opinionated enough that an operator might reasonably want to
  turn it off in production without a code change (regulatory, scope,
  cost, perf, or "we don't want this team to see it yet" reasons).

A change does **not** need a flag if it is purely:

- A bug fix that restores documented behavior.
- A refactor with zero observable change.
- Cosmetic (whitespace, copy edits, log message tweaks).
- A schema migration / setup helper that an operator runs explicitly.
- A change to local-dev / preview tooling that doesn't ship to Apps
  Script.

### Default-state policy

When a flag is added, the agent must choose a default and **state the
reason** in the commit message:

| Default the flag to… | …when |
|---|---|
| `false` (off, opt-in) | The feature is new, write-capable, role-scoped, irreversible (writes to live sheets / Drive / sends notifications), or the user hasn't asked for it to be enabled by default. **This is the safe default.** |
| `true` (on) | The user has explicitly asked for it on by default, OR the feature is purely additive read-only UX with negligible blast radius (e.g. a new sort option on an existing list), AND turning it off would leave the page in a broken state. |

**Default to `false` when in doubt.** A flag that ships off can be
turned on by editing the `CONFIG` sheet; a flag that ships on and
breaks something requires a redeploy to fix.

### Implementation requirements

1. Add the flag to `DEFAULT_FEATURES` in `src/Config.gs` with a one-line
   comment describing what it gates.
2. Server-side: every API action that participates in the feature must
   call `getFeatureFlag("FEATURE_X")` and return a clear error when
   it's off (`"<Feature> is disabled. Enable FEATURE_X in CONFIG."`).
   Do not rely on the client gate alone — the API can be called by any
   authenticated user with the network panel open.
3. Client-side: the relevant page must read `window.IRP_CLIENT_CONFIG.features.FEATURE_X`
   (loaded via `API.getClientConfig()`) and:
   - hide / not render the affordance when the flag is false;
   - re-check the flag inside the action handler as a defensive guard
     against stale renders.
4. `requirement.md` updates: add a row to §19.7 (or the relevant
   tunables/features table) with the default value and effect; if the
   feature exposes a new API action, note both the role allow-list AND
   the gating flag(s) in §7.
5. If two flags both gate the action (e.g. a master switch + a global
   kill-switch), say so explicitly in `requirement.md` — both must be
   true for the action to run.

### How to verify before finishing the task

- [ ] Did this change add a new `case` in `api_call`, a new visible UI
      affordance, or a new external write path?
- [ ] If yes → is there a `FEATURE_*` row in `DEFAULT_FEATURES`?
- [ ] Is the flag enforced on both server (`getFeatureFlag`) and client
      (render gate + handler re-check)?
- [ ] Is the default explicitly justified in the commit body?
- [ ] Is `requirement.md` updated with the new flag row?

If any answer is "no", finish the gating before closing out.

## 3. Source-control & push policy

These rules apply to **every** git/clasp operation the agent runs in
this repo. They are non-negotiable.

### 3.1 `ref/` is local-only — never push

The repo-root `ref/` folder holds working reference material (sample
PDFs, exported CSVs, WhatsApp photo dumps, scratch notes). It is listed
in [`.gitignore`](../.gitignore) and **must never** be committed or
pushed under any circumstance.

- Do not `git add ref/`, `git add -f ref/`, or run `git add .` from
  inside `ref/`.
- Do not propose moving files out of `ref/` into a tracked folder
  without the user's explicit instruction.
- If a file under `ref/` is genuinely needed in the deployed app, copy
  it into `assets/` (or another tracked folder) and reference the copy.

### 3.2 Always list changes and ask before pushing

The agent must **not** run any push command on its own initiative.
Before any of the following, stop and present the user with a confirmation
prompt that lists every change:

- `git push` (any remote, any branch)
- `git push --force` / `--force-with-lease` (in addition, call out the
  destructive nature explicitly)
- `clasp push` / `clasp push -f` (deploys to Apps Script)
- `clasp deploy` / `clasp version`
- Any GitHub Actions or CI trigger that pushes to a remote

#### Confirmation template

Use exactly this shape — adapt the bullets to the actual diff:

```
Ready to push. Please confirm.

Target:      <github / apps-script / both>
Remote:      <e.g. origin (https://github.com/tadeskops/ta-issue-manager.git)>
Branch:      <e.g. main>
Git account: tadeskops <ta.deskops@gmail.com>   ← must be tadeskops

Files changed (vs origin/<branch>):
  M src/Main.gs              — added addPhotosToIssue + Drive URL normalizer
  M src/Router.gs            — wired addPhotosToIssue + allow-list
  M src/Config.gs            — setupAttachmentFolder, makeAttachmentFolderPublic
  M src/pages/committee-dashboard.html — Upload Photo button in detail view
  M README.md                — setup runbook
  M requirement.md           — §5.1 / §7 / §13.1 / §19.13

Commit message (proposed):
  feat(committee): attach photos to existing issues + Drive public-view

Proceed? (yes / no / edit)
```

The user must answer **yes** (or an equivalent like "push it") before
the agent runs the push. "no" / silence / a question = do not push.

If the user gives a blanket "push everything you do" instruction at any
point, the agent still lists the changes once per push but may skip the
explicit yes/no prompt for that session only.

### 3.3 Pushes must use the `tadeskops` git account

Every push to GitHub from this repo must originate from the `tadeskops`
account (`ta.deskops@gmail.com`). Before any `git push`:

1. Run a pre-push identity check:

   ```powershell
   git config user.name      # must be exactly: tadeskops
   git config user.email     # must be exactly: ta.deskops@gmail.com
   git remote get-url origin # must point at github.com/tadeskops/ta-issue-manager
   ```

2. If any of those three values does not match, **abort the push** and
   tell the user which value is wrong and how to fix it (`git config
   user.name tadeskops`, etc.). Do not "fix it silently" — the user
   may have other repos that should keep a different identity.

3. **Wrong-repo guard.** If `git remote get-url origin` returns a
   `ta-society-helpdesk` URL, abort immediately — you are in the
   sibling daily-track repo by mistake. See §0.

4. Never reconfigure `user.name`, `user.email`, the remote URL, or
   credentials without explicit user instruction in the same turn.

5. If a future commit's `Author:` would not be `tadeskops`, surface
   that fact in the confirmation block in §3.2 (`Git account:` line
   highlights the mismatch) and ask the user how to proceed.

### 3.4 Apps Script (`clasp`) pushes — same rules

`clasp push` deploys directly to the live Apps Script project — there
is no PR review buffer. Follow §3.2 for confirmation, and additionally:

- Run the `.gs` brace-depth audit (per §2) on every changed `.gs` file
  *before* prompting the user.
- Mention which Apps Script deployment will be affected (the secure
  deployment, the public one, or both — see `requirement.md` §19.8).
- After a successful `clasp push`, list any operator-run functions
  that must be re-run (`setupConfigSheet`, `setupAttachmentFolder`,
  `makeAttachmentFolderPublic`, etc. — see README runbook).

## 4. Intermediate scratch space (`temp/`) and per-turn context loading

Long implementations often need scratch context that should survive
between turns but never ship to the live Apps Script project or to
GitHub — design notes, in-progress sheet-schema sketches, half-resolved
open questions, intermediate config drafts, captured tool outputs that
will inform a later step.

### 4.1 Always use `temp/` for intermediate context

- Write all such intermediate scratch under the repo-root `temp/`
  folder. Create it on first use; it is gitignored and **must never**
  be committed or pushed (see `.gitignore`).
- One file per topic; use short kebab-case names
  (`temp/sheet-schema-draft.md`, `temp/role-matrix.md`,
  `temp/upload-flow.md`). Append to existing files when the topic
  continues; do not spawn duplicates.
- Keep entries terse — bullet points, tables, JSON snippets — not
  prose. The point is to recall context cheaply, not to write a book.
- When an intermediate decision graduates into a real change, fold it
  into `requirement.md` (or the relevant code) and **delete the
  matching `temp/` file** in the same turn. Stale scratch files are
  worse than no scratch files.
- Do not put secrets, OAuth client secrets, GitHub PATs, or real
  resident PII in `temp/`. The folder is local-only but still on the
  developer's workstation; treat it as untrusted.

### 4.2 Per-turn context loading (token-efficient)

At the start of every turn, before producing any plan or making any
change, the agent must consider — in this order:

1. **`requirement.md`** — the spec is the source of truth. If the
   relevant section is already in attached context, do not re-read it;
   if it is not, read only the section(s) the current request touches
   (use the file's heading numbering, not a full read).
2. **`temp/`** — list the directory; read only files whose name is
   relevant to the current request. Do not bulk-read every file.
3. **The user's current request.**

This ordering keeps token use bounded:

- Spec sections are referenced by §-number, never reproduced verbatim
  unless an edit requires it.
- `temp/` files are loaded on-demand by topic, not eagerly.
- The agent should prefer to update an existing `temp/` file over
  pasting the same context into the chat reply.

### 4.3 What belongs in `temp/` vs `requirement.md`

| Goes in `temp/` | Goes in `requirement.md` |
|---|---|
| Open questions still being negotiated with the user | Final, agreed behavior |
| `google.script.run` payload sketches mid-iteration | The final API surface once accepted |
| Notes on _why_ a default was chosen during exploration | The final default in the feature-flag table |
| Cross-turn TODOs the user hasn't approved yet | Acceptance criteria once approved |
| Intermediate diffs / proposed wording for review | The committed wording |

### 4.4 Verification before finishing the task

- [ ] Did this turn produce intermediate notes that the next turn
      will need? → Saved under `temp/` with a clear name?
- [ ] Did any `temp/` content graduate into the spec or code this
      turn? → Corresponding `temp/` file deleted?
- [ ] Was anything from `temp/` accidentally staged for commit?
      `git status` must show no `temp/` paths in the staged set.



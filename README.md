# Issue Addressal Portal (IRP)

Google Apps Script web app for the Address residents' issue tracker. 

## Layout

```
/
├── appsscript.json          Apps Script manifest (clasp / editor entry)
├── requirement.md           Primary specification
├── src/
│   ├── Main.gs              Sheet readers/writers, form trigger, submitIssue
│   ├── Router.gs            doGet, doPost, role-based PAGE_MAP, api_call switch
│   ├── Config.gs            CONFIG sheet reader, feature flags, tunables
│   ├── pages/               Top-level HTML routed by Router.PAGE_MAP
│   │   ├── index.html
│   │   ├── submit-issue.html
│   │   ├── submitted-issues.html
│   │   ├── committee-dashboard.html
│   │   ├── builder-dashboard.html
│   │   └── admin-dashboard.html
│   └── partials/            Inlined via `<?!= include('src/partials/NAME') ?>`
│       └── api.html
├── assets/                  Static assets (local dev preview only)
│   ├── images/
│   └── js/api.js
└── temp/
    ├── docs/                Historical write-ups
    └── reference/           Form PDF, sample CSV exports, brochure
```

## Deploy

Use clasp (`clasp push` from project root). Filenames in Apps Script preserve
their `src/...` prefix; `HtmlService.createTemplateFromFile("src/pages/index")`
resolves correctly.

Run `setupConfigSheet` once after the first deploy to seed the CONFIG sheet
(idempotent — preserves existing edits).

## Apps Script setup runbook

All functions below live in `src/Config.gs` (or are referenced from it) and
are runnable from the Apps Script editor: pick the function name in the
**function dropdown** (top toolbar) → **Run**. Authorize the requested
scopes the first time each one runs. All functions are **idempotent** — re-
running is always safe.

| # | When to run | Function | What it does |
|---|---|---|---|
| 1 | First deploy, or after pulling new `DEFAULT_FEATURES` / `DEFAULT_TUNABLES` keys | `setupConfigSheet` | Creates / repopulates the `CONFIG` tab. Preserves existing operator-edited values; only missing keys are appended with defaults. |
| 2 | First deploy, or if the attachment folder ID is blank | `setupAttachmentFolder` | Walks `My Drive / TA_HANDOVER / ISSUE_UPLOADS / TA Issue Reporting Portal / Upload Photos/Video` (tolerating the auto-appended ` (File responses)` suffix) and writes the resolved folder ID into the `ATTACHMENT_FOLDER_ID` row of CONFIG. Logs the full path + URL. |
| 3 | First deploy, or after any new files were added to the attachment folder by Google Forms / Drive | `makeAttachmentFolderPublic` | Sets the attachment folder **and every file inside it** to "Anyone with the link – Viewer" so all photos render inside the web app for any visitor. Falls back to `ANYONE` if the strict variant is blocked, and logs a clear warning if both are blocked by a Workspace policy. |
| — | Anytime, to confirm where uploads will land | `whereDoUploadsGo` | Read-only. Prints the configured attachment folder's full path + URL. Does **not** change anything. |
| — | After editing a CONFIG row by hand | `clearConfigCache` | Forces the next API call to re-read the `CONFIG` sheet (otherwise the cached values stay for up to 5 minutes). |

### One-time bootstrap order (fresh deployment)

```
clasp push
  → in the Apps Script editor:
      1. setupConfigSheet           (seed CONFIG sheet)
      2. setupAttachmentFolder      (pin the Drive folder ID)
      3. makeAttachmentFolderPublic (open up sharing for the web app)
      4. whereDoUploadsGo           (verify path + URL in the log)
```

After step 3, every photo — old Form-uploaded ones, prior in-portal
submissions, and committee-side uploads added later — renders publicly in
the web app's `<img>` tags. The URLs stored in the sheet are normalized to
the Drive thumbnail endpoint (`https://drive.google.com/thumbnail?id=...&sz=w2000`)
by `splitPhotoLinks_` / `driveImageUrl_` in `src/Main.gs`, so no front-end
change is needed when adding new readers.

## Configuration

Every developer- / manager-tunable input lives in the **CONFIG** sheet:
identity (emails), assets (folder/logo), feature flags, numeric tunables.
See `src/Config.gs` (`DEFAULT_FEATURES`, `DEFAULT_TUNABLES`) for the full list.
Feature flags hide UI but leave internal helpers callable for dependent
modules.

---

## Specification

The single source of truth for behavior is [`requirement.md`](./requirement.md).
**Keep it updated whenever a feature, role capability, API action, sheet
column, or config key changes.** See [`.github/copilot-instructions.md`](./.github/copilot-instructions.md)
for the agent rule that enforces this.


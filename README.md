# Issue Addressal Portal (IRP)

Google Apps Script web app for the Address residents' issue tracker. 

## Architecture at a glance

The portal is a single Apps Script web-app with a Google Sheet as its
database, Google Drive as its blob store, and a Google Form as one of two
intake channels. Everything else is wallpaper.

```mermaid
flowchart LR
    subgraph "Intake"
        F[Google Form] -->|onFormSubmit trigger| PR[(PENDING_REVIEW)]
        SI[submit-issue.html<br/>in-portal form] -->|submitIssue| PR
        SI -. photos .-> DR[(Drive folder)]
        F  -. photos .-> DR
    end

    subgraph "Lifecycle (strict-move sheets)"
        PR -->|approveIssue| LI[(LIVE_ISSUES)]
        PR -->|rejectIssue|  AR[(ARCHIVES_ISSUES)]
        LI -->|closeIssue|   CI[(CLOSED_ISSUES)]
        CI -->|reopenIssue|  LI
    end

    subgraph "Read paths"
        LI --> CD[committee-dashboard.html]
        PR --> CD
        CI --> CD
        LI --> BD[builder-dashboard.html]
        CI --> BD
        PR --> SUB[submitted-issues.html<br/>read-only]
        LI --> SUB
        AR -. opt-in .-> SUB
    end

    subgraph "Auth + config"
        S[Session.getActiveUser] --> R[Router.gs<br/>doGet + api_call]
        CFG[(CONFIG sheet)] --> R
        R --> CD
        R --> BD
        R --> SUB
        R --> SI
    end

    DR -. getReportPhotoB64 .-> PDF[PDF Export Wizard<br/>partials/pdf-report.html]
    CD --> PDF
    BD --> PDF
    SUB --> PDF
```

### Feature umbrellas

Every feature lives under one of four umbrellas. Each row links to the
gating flag in `DEFAULT_FEATURES` (`src/Config.gs`), the spec sub-section
in `requirement.md`, and the touch-points in code.

| Umbrella | Feature | Flag(s) | Touch-points |
|---|---|---|---|
| **Intake** | Google Form → `PENDING_REVIEW` (always on) | — | `onFormSubmit`, `Form Responses 1` |
| | In-portal submit page | `FEATURE_IN_PORTAL_SUBMIT` | `pages/submit-issue.html`, `submitIssue` |
| | Photo upload (Form + portal) | `FEATURE_PHOTO_UPLOAD` | `uploadSubmissionPhotos_`, `splitPhotoLinks_`, `driveImageUrl_` |
| | Auto-save draft on submit page | `FEATURE_AUTOSAVE_DRAFT` | `pages/submit-issue.html` |
| **Lifecycle** | Approve / reject pending | — (committee-only) | `approveIssue`, `rejectIssue`, `PENDING_COL`, `LIVE_COL` |
| | Builder status updates (assigned → in progress → completed) | — (committee + builder) | `updateBuilderStatus`, `LIVE_COL.BUILDER_STATUS` |
| | Close / reopen issue | — | `closeIssue`, `reopenIssue`, `CLOSED_ISSUES` |
| | SLA dates + breach surfaces | `FEATURE_SLA` | `calculateSLADate`, `getDashboardMetrics.slaBreaches`, dashboard KPIs |
| | Committee can attach photos to existing issues | `FEATURE_COMMITTEE_PHOTO_ATTACH` + `FEATURE_PHOTO_UPLOAD` | `addPhotosToIssue`, `pages/committee-dashboard.html` |
| **Read paths** | Committee dashboard (queue + active + closed) | — | `pages/committee-dashboard.html` |
| | Builder dashboard | `FEATURE_BUILDER_DASHBOARD` | `pages/builder-dashboard.html` |
| | Admin dashboard (KPIs, charts) | `FEATURE_ADMIN_DASHBOARD` | `pages/admin-dashboard.html` |
| | Read-only submitted-issues view | `FEATURE_SUBMITTED_PAGE` | `pages/submitted-issues.html`, `getSubmittedIssues` |
| | Severity column on submitted view | `FEATURE_SHOW_SEVERITY_ON_SUBMITTED` | `pages/submitted-issues.html` |
| | Rejected-issues filter | `FEATURE_REJECTED_FILTER` | `pages/committee-dashboard.html` |
| **Reporting & ops** | PDF export wizard (committee / builder / submitted) | `FEATURE_PDF_REPORT` + `FEATURE_PHOTO_UPLOAD` (for inline photos) | `partials/pdf-report.html`, `getReportPhotoB64` |
| | Setup runbook (folder, public-share, config) | — | `src/Config.gs` (see runbook below) |
| | Recovery (renumber / re-import) | — | `src/Recovery.gs` (see runbook below) |
| | Weekly PDF status report → GitHub (anonymised + full) | `FEATURE_WEEKLY_REPORT_BACKUP` + `WEEKLY_REPORT_PUBLIC_URL` + `FULL_REPORT_PUBLIC_URL` | `src/WeeklyReport.gs` (see runbook below) |
| | Auth / role resolution | — | `Router.gs` (`doGet`, `api_call`, `isActionAllowed_`), `Config.gs.getUserRole` |

### Photo data flow (where it gets tricky)

Three writers and three readers need to agree on one shape:

```
                      writers                                              readers
 Form upload  ────►  Drive  ────► splitPhotoLinks_ ────► sheet PHOTO col
 Portal upload  ──►  Drive  ────► splitPhotoLinks_ ────► sheet PHOTO col
 Committee attach► Drive  ────► splitPhotoLinks_ ────► sheet PHOTO col
                                                              │
                                                              ▼
                                       getPendingIssues / getLiveIssues / getClosedIssues / getSubmittedIssues
                                                              │
                                  ┌───────────────────────────┴────────────────────────────┐
                                  ▼                                                        ▼
                       i.issue.photoLinks (canonical — array of thumbnail URLs)   i.attachments (legacy root field; submitted-issues only)
                                  │                                                        │
                                  ▼                                                        ▼
                       PDF Export Wizard                                        Submitted-issues detail modal
                       (COLUMN_CATALOG.photos.read)                             (`issue.attachments` HTML)
                                  │
                                  ▼
                       _prefetchPhotos → API.getReportPhotoB64
                                  │
                                  ▼
                       UrlFetchApp(drive.google.com/thumbnail)  +  bearer OAuth token
                                  │
                                  ▼
                       jsPDF.addImage(dataUrl, format, ...)        ← format MUST match bytes (JPEG/PNG/WEBP/GIF)
```

The two non-obvious failure modes: (1) `i.issue.photoLinks` is the
canonical shape — all readers must populate it (the legacy
`i.attachments` is kept at the root for the submitted-issues detail
modal), and (2) `addImage`'s format flag must match the actual bytes —
hardcoding `"JPEG"` while the bytes are PNG silently throws inside
jsPDF and the cell renders the "photo unavailable" placeholder.

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

The portal is one Apps Script project (standalone — NOT a container-bound
script under the sheet's Extensions menu) with **two** web-app deployments
cut from it. Both share identical code and manifest scopes; only the
per-deployment `Execute as` + `Who has access` differ. See
[`docs/deployments.md`](docs/deployments.md) for the URL registry and
[`requirement.md`](./requirement.md) §19.8 for the design rationale.

| Deployment | `Execute as` | `Who has access` | Purpose |
|---|---|---|---|
| **Public** | `Me` (`USER_DEPLOYING`) | `Anyone` (`ANYONE_ANONYMOUS`) | Landing page, read-only board (`?page=submitted`), full-report PDF link, resident submit form |
| **Secure** | `User accessing the web app` (`USER_ACCESSING`) | `Anyone with a Google account` (`ANYONE`) | Committee / Builder / Admin dashboards — role is enforced by `getUserRole()` *and* Google's sheet ACL |

### First-time clasp setup

```powershell
# 1. Copy the scriptId template — .clasp.json is gitignored on purpose so
#    every deployer picks the same canonical project instead of accidentally
#    creating (or reviving) a second one.
Copy-Item .clasp.example.json .clasp.json
# 2. Edit .clasp.json and fill in "scriptId" with the standalone project id.
#    Do NOT use a container-bound script id (opened via a Sheet's Extensions
#    menu) — that is a different project and pushes will drift.
clasp push -f
```

### Cutting both deployments (one-time, per project)

1. Open the standalone Apps Script project in the editor.
2. **Deploy → New deployment → Web app.**
   - Description: `Public (anonymous landing + submitted)`
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Copy the resulting `.../exec` URL — this is `PUBLIC_WEBAPP_URL`.
3. **Deploy → New deployment → Web app** again.
   - Description: `Secure (committee/builder/admin)`
   - Execute as: **User accessing the web app**
   - Who has access: **Anyone with Google account**
   - Copy the resulting `.../exec` URL — this is `TECH_WEBAPP_URL`.
4. In the CONFIG sheet, populate both rows:
   - `PUBLIC_WEBAPP_URL` = the public `.../exec`
   - `TECH_WEBAPP_URL`   = the secure `.../exec`
   - Then run `clearConfigCache` from the editor.
5. Verify with the deployment fingerprint diagnostic (see below).

### Updating both deployments (every code change)

`clasp push` uploads code but does **not** publish new deployment versions.
You must bump each deployment separately:

```
Deploy → Manage deployments → (edit pencil on each) → Version: New version → Deploy
```

Both deployments run the same code — you always bump both together.

### Verifying the deployments

Open **each** `AKfycbz…/exec` URL in a separate incognito window with
`?diag=deployment` appended:

- The **public** URL should return `mode: "USER_DEPLOYING"` with an
  empty `activeEmail` and the deployer's email as `effectiveEmail`.
- The **secure** URL should force Google sign-in first, then return
  `mode: "USER_ACCESSING"` with `activeEmail` == `effectiveEmail` ==
  your signed-in address.

If those don't match expectations, the URL is not what you think it is.
Note: this test is **only conclusive from an incognito window with no Google
sign-in**. On the public deployment Google trusts the deployer's own account
and returns their email for both fields, which looks identical to the secure
deployment's signed-in case.

> `clasp push` preserves the `src/...` prefix on filenames, so
> `HtmlService.createTemplateFromFile("src/pages/index")` resolves correctly
> once pushed. See the **Apps Script setup runbook** below for the
> post-push bootstrap steps (starting with `setupConfigSheet`).

## Apps Script setup runbook

All functions below live in `src/Config.gs` (or are referenced from it) and
are runnable from the Apps Script editor: pick the function name in the
**function dropdown** (top toolbar) → **Run**. Authorize the requested
scopes the first time each one runs. All functions are **idempotent** — re-
running is always safe.

| # | When to run | Function | What it does |
|---|---|---|---|
| 1 | First deploy, or after pulling new `DEFAULT_FEATURES` / `DEFAULT_TUNABLES` keys | `setupConfigSheet` | Creates / repopulates the `CONFIG` tab. Preserves existing operator-edited values; only missing keys are appended with defaults. |
| 2 | **First deploy, or after re-binding to a different spreadsheet / form** — without this, form submissions land in `Form Responses 1` but **never become tickets** | `installFormSubmitTrigger` (`src/Main.gs`) | Idempotent. Removes any prior `onFormSubmit` triggers on this script project and creates a fresh spreadsheet-form-submit trigger so each new Google Form response runs `onFormSubmit(e)` → `createPendingIssue_()` → row appended to `PENDING_REVIEW` with a fresh `TKT-NNNNN` id. Returns `{success, message, data:{removed, triggerId}}`. Run `listProjectTriggers` afterwards to confirm. |
| — | _Diagnostic_ — confirm form-submit / weekly-backup / weekly-report triggers are wired up | `listProjectTriggers` (`src/Main.gs`) | Read-only. Lists every trigger on the script project (`handler`, `type`, `triggerSource`, `sourceId`, `uniqueId`). If `onFormSubmit` is missing from the output, run `installFormSubmitTrigger` — submissions are not creating tickets. |
| — | _Optional_ — pre-seed the attachment folder ID so the first upload doesn't have to walk Drive | `setupAttachmentFolder` | Walks `My Drive / TA_HANDOVER / ISSUE_UPLOADS / TA Issue Reporting Portal / Upload Photos/Video` (tolerating the ` (File responses)` suffix), writes the ID into `ATTACHMENT_FOLDER_ID`, and forces public-view on the folder. **Not required** — `uploadSubmissionPhotos_` calls the same resolver lazily on first upload and persists the result. |
| — | _Optional_ — bulk-publish legacy / Form-uploaded files already inside the folder | `makeAttachmentFolderPublic` | Sets the folder **and every file currently inside it** to "Anyone with the link – Viewer". New uploads are made public automatically by `trySharePublic_`; this only matters for files Google Forms / Drive added before public-view was wired in. Falls back to `ANYONE` if the strict variant is blocked, and logs a clear warning if both are blocked by a Workspace policy. |
| — | Anytime, to confirm where uploads will land | `whereDoUploadsGo` | Read-only. Prints the configured attachment folder's full path + URL. Does **not** change anything. |
| — | After editing a CONFIG row by hand | `clearConfigCache` | Forces the next API call to re-read the `CONFIG` sheet (otherwise the cached values stay for up to 5 minutes). |
| — | After adding or upgrading a scope in `appsscript.json` (e.g. `drive.readonly` → `drive`) — before you'll notice via `syncRoleAccessNow` throwing "Required permissions" | `checkOAuthScopes` (`src/Config.gs`) | Read-only self-check. Fetches the current deployer's OAuth token, expands it via Google's `tokeninfo` endpoint, and diffs the granted scopes against the manifest. Logs `ok=false` + `missing=[…]` when the deployer needs to re-consent. Remediation: run any function that uses the missing scope (typically `syncRoleAccessNow`) from the editor, accept the fresh consent dialog, then bump both deployment versions so the URLs pick up the refreshed grant. |
| — | **Recovery** — when ticket ids have drifted, duplicated, or the counter is desynced | `renumberAllTicketIds` (`src/Recovery.gs`) | Takes a full XLSX backup to GitHub, then rewrites `TICKET_ID` across `PENDING_REVIEW` + `LIVE_ISSUES` + `CLOSED_ISSUES` + `ARCHIVES_ISSUES` as a single monotonic `TKT-NNNNN` series sorted by `DATE_REPORTED`. Resets the `TICKET_COUNTER` ScriptProperty to the new max. Drive folder names are not renamed (existing photos still resolve by id). |
| — | **Recovery** — when `PENDING_REVIEW` is corrupted / missing rows but `Form Responses 1` is intact | `recoverPendingFromForm` (`src/Recovery.gs`) | Takes a backup, wipes `PENDING_REVIEW` data rows, then re-imports every form row whose `{timestamp,resident,flat}` signature is **not** already in `LIVE_ISSUES` / `CLOSED_ISSUES`. Drops the cached `TICKET_COUNTER` so new pending ids are minted from the surviving live/closed max. |
| — | **Recovery** — when an external paste / CSV import has seeded duplicate `TICKET_ID`s (e.g. three rows with the same legacy `TA-0001`) | `dedupeTicketIds` (`src/Recovery.gs`) | Surgical fix — takes a backup, scans all four issue sheets, keeps the row with the earliest `DATE_REPORTED` for each id, and assigns a fresh `TKT-NNNNN` id (via `generateTicketID()`) to every other occurrence. Non-duplicated rows are untouched, so existing photo folders and external references survive. Returns `{success, data:{renamed:[{sheet,row,oldId,newId}], scanned}, error}`. |
| — | **Recovery** — when assessment / audit data was pasted into a sheet with legacy ids (e.g. `TA-0001`, `TA-13`) — singletons included, even when not duplicated | `normalizeLegacyTicketIds` (`src/Recovery.gs`) | Takes a backup, scans all four issue sheets, and reissues a fresh `TKT-NNNNN` id (via `generateTicketID()`) for **every** row whose id does not match `^TKT-\d{5}$`. Catches singleton legacy ids that `dedupeTicketIds` won't touch. Returns `{success, data:{renamed:[{sheet,row,oldId,newId}], scanned, skipped}, error}`. |
| — | **Sheet backup → GitHub** — schedule the XLSX snapshot trigger (or re-install after editing `REPORT_BACKUP_FREQUENCY`) | `installWeeklyBackupTrigger` (`src/Backup.gs`) | Schedules `weeklyBackupJob` (XLSX export of the bound spreadsheet → `backups/ta-issue-manager.xlsx` in `BACKUP_REPO`). Cadence follows the `REPORT_BACKUP_FREQUENCY` tunable: **`"3x-daily"` (default)** installs `.everyHours(8)` so the snapshot fires ≈ 3 times per 24 h; `"daily"` installs an every-day trigger at ~02:00 in the script TZ; `"weekly"` reverts to the legacy Mondays-only schedule. Idempotent — removes any prior `weeklyBackupJob` trigger before creating the new one. Requires `GITHUB_TOKEN` to be set under Project Settings. Re-run whenever `REPORT_BACKUP_FREQUENCY` changes. |
| — | **PDF status reports → GitHub** — only when `FEATURE_WEEKLY_REPORT_BACKUP=true`; also re-run after editing `REPORT_BACKUP_FREQUENCY` | `installWeeklyReportTrigger` (`src/WeeklyReport.gs`) | Schedules `weeklyReportJob`. Cadence follows the `REPORT_BACKUP_FREQUENCY` tunable: **`"3x-daily"` (default)** installs `.everyHours(8)` so the report fires ≈ 3 times per 24 h — fresh `TA_IAP_Full_Report.pdf` every ~8 h; `"daily"` installs an every-day trigger at ~03:00 in the script TZ (one hour after the daily sheet backup so it picks up that day's snapshot); `"weekly"` reverts to Mondays only. Each run rebuilds **two** files server-side and commits both to the same `BACKUP_REPO` branch as the sheet backup (overwritten every run): `backups/TA_IAP_Report.pdf` (anonymised, pending+active only — resident name and flat number redacted to `—`) and `backups/TA_IAP_Full_Report.pdf` (full content including closed+rejected, names, flats, **and inline photos** — the server cron now fetches Drive thumbnails authenticated via `UrlFetchApp` + `ScriptApp.getOAuthToken` and embeds them via `Body.appendImage`, capped at 4 photos per issue / 60 per report). The full file is **also** overwritten on demand whenever a committee/builder clicks **Export Report** on a signed-in dashboard — the wizard streams its rendered PDF back via `commitFullReportPdf`. Reuses the same `GITHUB_TOKEN` script property as the sheet backup. See `requirement.md` §19.14. |
| — | **Report / backup — manual one-shot** (test the build before scheduling, or push an off-cycle update) | `generateWeeklyReportPdf` *or* `generateFullReportPdf` (`src/WeeklyReport.gs`), or `backupSheetToGit` (`src/Backup.gs`) | Ad-hoc runs of the same builds the scheduled triggers execute. Each function targets one file. Both report builders return `{success, data:{path, commit, url, totals}}` on success and abort with a clear error if `FEATURE_WEEKLY_REPORT_BACKUP` is off or `GITHUB_TOKEN` is unset. |

### One-time bootstrap order (fresh deployment)

```
clasp push
  → in the Apps Script editor:
      1. setupConfigSheet           (seed CONFIG sheet — required)
      2. installFormSubmitTrigger   (REQUIRED — without it, form
                                     submissions never become tickets)
      3. listProjectTriggers        (verify onFormSubmit shows up)
  → photo uploads work immediately. On the first upload the script
    auto-resolves the canonical Drive path, persists the folder ID into
    CONFIG, and forces public-view on the folder.
  → optional follow-ups:
      • setupAttachmentFolder       (pre-seed the ID without an upload)
      • makeAttachmentFolderPublic  (retro-publish files added before this build)
      • whereDoUploadsGo            (verify path + URL in the log)
```

Every photo — old Form-uploaded ones, prior in-portal submissions, and
committee-side uploads added later — renders publicly in the web app's
`<img>` tags. The URLs stored in the sheet are normalized to the Drive
thumbnail endpoint (`https://drive.google.com/thumbnail?id=...&sz=w2000`)
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


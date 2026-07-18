# Issue Addressal Portal (IRP) — Requirements

> Lightweight, serverless issue-management workflow for the residential society.
> One Google Sheet is the database; one Apps Script project is the host (UI + API + auth).

---

## 1. System Overview

| Aspect            | Valueare                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| Purpose           | Track resident-reported issues from intake → committee approval → builder execution → closure |
| Hosting           | Single Apps Script web app (HtmlService)                                                         |
| Storage           | One bound Google Sheet (7 tabs incl.`CONFIG`)                                                  |
| Identity          | Google account sign-in (`Session.getActiveUser()`)                                             |
| Authorization     | Role lookup against the`CONFIG` sheet                                                          |
| Cost              | Free (Google Sheets + Apps Script quotas only)                                                   |
| External services | None — no Firebase, no OAuth Client ID, no GitHub Pages                                         |

---

## 2. Roles

`getUserRole(email)` in [src/Config.gs](src/Config.gs) resolves the role. It returns one of `COMMITTEE | BUILDER | RESIDENT | UNKNOWN`; `UNKNOWN` is reserved for the anonymous (no-email) caller of the public deployment.

| Role                | How identified                                                                | Capabilities                                                                 |
| ------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Resident            | Signed-in Google user whose email is not in `COMMITTEE_EMAILS` / `BUILDER_EMAIL` | Submit issues (in-portal + Google Form), read submitted-issues, category master, client config |
| Technical Committee | Google email listed in `CONFIG.COMMITTEE_EMAILS`                              | Approve/reject pending, view all dashboards, close/reopen, delete, full read |
| Builder             | Google email matching `CONFIG.BUILDER_EMAIL`                                  | Read assigned issues, update builder status / comment / vendor, close/reopen |
| Unknown (anonymous) | No verified email — the public (`USER_DEPLOYING` / `ANYONE_ANONYMOUS`) deployment | Read-only access to the actions in `PUBLIC_ACTIONS` (submitted-issues, category master, client config, `getReportPhotoB64`, `commitFullReportPdf`, `diag`). Every other action is denied. |

> Committee membership and builder email are runtime-editable via the `CONFIG` sheet.
> No code changes required to onboard or remove a member. Google Form intake
> still flows through `onFormSubmit` regardless of the submitter's portal role.

---

## 3. Authentication & Authorization (Google Auth — MANDATORY)

### 3.1 Authentication

- Web app deployed with `executeAs: USER_ACCESSING`, `access: ANYONE` (any Google account).
- Google forces sign-in before any request reaches the script.
- Server reads identity via `Session.getActiveUser().getEmail()` — **must not** be supplied by the client.
- Browser must never send `userEmail` in a payload; if present, it is ignored.

### 3.2 Authorization

- `getUserRole(email)` (see [config.gs](config.gs)) resolves `COMMITTEE | BUILDER | UNKNOWN`.
- Per-action allow-list enforced server-side in `isActionAllowed_(action, role)` (see [Router.gs](Router.gs)).
- `UNKNOWN` is denied on every action and is shown an access-denied landing page.

### 3.3 Sign-out

- No programmatic sign-out for an Apps Script web app session.
- Logout button triggers `API.signOut()` which redirects through Google's account-chooser.

### 3.4 What is forbidden

- Client-typed email + role form (removed).
- `sessionStorage` for identity (removed).
- "Allow all as COMMITTEE" fallback in `validateUserAccess` (removed).
- Trusting `payload.userEmail` in `doPost` (removed).

---

## 4. Architecture

```
┌────────────┐    1. GET /exec     ┌────────────────────────────┐
│  Browser   │ ──────────────────▶ │ Apps Script Web App (Router.gs)
│            │                     │   doGet(e)                 │
│            │ ◀────HTML page──── │   - Session.getActiveUser()│
│            │                     │   - getUserRole(email)     │
│            │                     │   - serve role-specific UI │
│            │                     └────────────┬───────────────┘
│            │  2. google.script.run.api_call(action, payload)  │
│            │ ───────────────────────────────▶│
│            │                                  │ api_call()
│            │                                  │ - Session-trusted email
│            │                                  │ - isActionAllowed_
│            │                                  │ - dispatch to handler in
│            │                                  │   apps-script.gs
│            │ ◀──────────JSON result──────────┘
└────────────┘
        │
        │  Legacy / local-dev only: fetch(API.ENDPOINT) → doPost(e)
        │     (still gated by Session-trusted email)
```

### 4.1 File map

| File                                                             | Role                                                                                                                                                                   |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [appsscript.json](appsscript.json)                                | Manifest — web app deploy config + OAuth scopes                                                                                                                       |
| [src/Router.gs](src/Router.gs)                                    | `doGet`, `?diag=*` handlers, role-based routing, `api_call`, `api_whoAmI`, `isActionAllowed_` allow-list                                                     |
| [src/Config.gs](src/Config.gs)                                    | CONFIG-sheet reader, `getUserRole()`, cache, `setupConfigSheet()`, `DEFAULT_FEATURES` / `DEFAULT_TUNABLES`, role-access sync trigger                       |
| [src/Main.gs](src/Main.gs)                                        | `SHEET_ID`, `SHEETS`, sheet schemas (`PENDING_COL` / `LIVE_COL`), business logic, sheet handlers, form trigger installer, safe-str / drive-URL helpers         |
| [src/Backup.gs](src/Backup.gs)                                    | `backup_props_`, GitHub Contents API helpers (`backup_putToGit_`, `putBinaryB64`) used by both the XLSX weekly backup and the PDF report                        |
| [src/WeeklyReport.gs](src/WeeklyReport.gs)                        | Scheduled PDF report job (`weeklyReportJob`), `commitFullReportPdf`, `weeklyReport_commitMonthly_`, `installWeeklyReportTrigger`                             |
| [src/Recovery.gs](src/Recovery.gs)                                | Operator recovery tools: `renumberAllTicketIds`, `recoverPendingFromForm`, `dedupeTicketIds`, `normalizeLegacyTicketIds`                                     |
| [src/pages/index.html](src/pages/index.html)                      | Landing / access-denied / "Switch account"                                                                                                                             |
| [src/pages/committee-dashboard.html](src/pages/committee-dashboard.html) | Committee queue + active + closed tabs                                                                                                                          |
| [src/pages/builder-dashboard.html](src/pages/builder-dashboard.html)     | Builder task list + status updates                                                                                                                              |
| [src/pages/admin-dashboard.html](src/pages/admin-dashboard.html)         | Admin analytics (committee only)                                                                                                                                 |
| [src/pages/submitted-issues.html](src/pages/submitted-issues.html)       | Read-only view of `PENDING_REVIEW` enriched with downstream LIVE / CLOSED status (severity hidden by default — controlled by `FEATURE_SHOW_SEVERITY_ON_SUBMITTED`) |
| [src/pages/submit-issue.html](src/pages/submit-issue.html)               | In-portal intake form (gated by `FEATURE_IN_PORTAL_SUBMIT`) — used by residents, committee, and builder                                                        |
| [src/partials/api.html](src/partials/api.html)                    | Client `API` shim (`google.script.run` in production, `fetch(API.ENDPOINT)` locally); reads `window.IRP_WEBAPP_URL` when present                             |
| [src/partials/theme.html](src/partials/theme.html)                | Shared theme tokens + font-scale switcher                                                                                                                            |
| [src/partials/pdf-report.html](src/partials/pdf-report.html)      | PDF export wizard (column catalog, image-quality selector, `commitFullReportPdf` post-hook)                                                                        |

---

## 5. Google Sheet Schema (8 tabs)

| # | Tab                  | Purpose                                                                                                                 |
| - | -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1 | `Form Responses 1` | Raw form intake (auto-populated by Google Forms)                                                                        |
| 2 | `PENDING_REVIEW`   | Issues**currently** awaiting committee approval. Rows leave this sheet on approve/reject (strict move).           |
| 3 | `LIVE_ISSUES`      | Approved, active issues (builder updates here). Rows leave on close. **Builder dashboard reads this directly** via `getLiveIssues()` — no intermediate view sheet. |
| 4 | `ARCHIVES_ISSUES`  | **Rejected** issues (moved here from `PENDING_REVIEW` on reject). Read-only from the app.                       |
| 5 | `CLOSED_ISSUES`    | Resolved, archived issues. Layout =`LIVE_COL` + 4 closure columns `[reason, closedDate, closedBy, resolutionDays]`. |
| 6 | `CATEGORY_MASTER`  | Dropdown values                                                                                                         |
| 7 | `DASHBOARD`        | Formula-only metric tab                                                                                                 |
| 8 | `CONFIG`           | Runtime config: identity, assets, feature flags, tunables                                                               |

`SHEET_ID` is hardcoded in [src/Main.gs](src/Main.gs#L4); all sheet names live in the `SHEETS` constant.

### 5.1 CONFIG tab layout

| Key                      | Value                                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMMITTEE_EMAILS`     | `a@x.com, b@x.com`                  | Comma- or newline-separated                                                                                                                                                                                                                                                                                                                                                                                     |
| `BUILDER_EMAIL`        | `builder@x.com`                     | Single email                                                                                                                                                                                                                                                                                                                                                                                                    |
| `LOGO_URL`             | `https://drive.google.com/uc?id=…` | Optional — falls back to bundled asset                                                                                                                                                                                                                                                                                                                                                                         |
| `ATTACHMENT_FOLDER_ID` | `1AbC…xyz`                         | Drive folder ID for**all** in-portal photo uploads (resident submit page + committee "attach later" uploader). **Auto-populated on first upload** by `resolveAttachmentFolder_({ autoSetup: true })` — walks the canonical path under My Drive and persists the result. Operators can pre-seed it via `setupAttachmentFolder` (see §13.1) or override it with a different folder id manually. |

Feature flags and numeric tunables are stored as additional rows; their canonical defaults live in `DEFAULT_FEATURES` / `DEFAULT_TUNABLES` (`src/Config.gs`). Cached 5 min in `CacheService`; `clearConfigCache()` forces refresh.

---

## 6. Web App URL Routes (`doGet` parameters)

Routed through the `PAGE_MAP` table in [src/Router.gs](src/Router.gs).

| URL                      | Behaviour                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/exec`                  | Landing / login screen (`src/pages/index.html`). **Not** role-auto-routed — the user picks a destination explicitly (public submitted view vs. tech mode). |
| `/exec?page=committee`   | Force committee dashboard (committee only)                                                                                                                   |
| `/exec?page=builder`     | Force builder dashboard (builder or committee); gated by `FEATURE_BUILDER_DASHBOARD`                                                                       |
| `/exec?page=admin`       | Admin analytics (committee only); gated by `FEATURE_ADMIN_DASHBOARD`                                                                                       |
| `/exec?page=submitted`   | Read-only submitted-issues table; gated by `FEATURE_SUBMITTED_PAGE`; `public: true` so anonymous callers on the public deployment can also load it     |
| `/exec?page=submit`      | In-portal intake form (RESIDENT / COMMITTEE / BUILDER); gated by `FEATURE_IN_PORTAL_SUBMIT`                                                                |
| `/exec?diag=whoami`      | JSON diagnostic — the resolved `email` + `role` for the caller                                                                                           |
| `/exec?diag=sheets`      | JSON diagnostic — header rows + sample data per sheet                                                                                                      |
| `/exec?diag=deployment`  | JSON diagnostic — deployment shape (`USER_DEPLOYING` vs `USER_ACCESSING`) fingerprinted via `Session.getActiveUser` vs `getEffectiveUser`              |

Unauthorized requests for a page never reach the HTML — `Router.gs` substitutes the denied page. `?diag=*` handlers are wrapped in a top-level try/catch so any thrown error still returns a JSON error blob (CI/probes parse these strictly).

---

## 7. Server API Surface (`google.script.run.api_call`)

All requests pass through `api_call(action, payload)` in [Router.gs](Router.gs).
`isActionAllowed_(action, role)` is the single source of truth for capabilities.

| Action                                                                          | Committee | Builder | Resident |
| ------------------------------------------------------------------------------- | :-------: | :-----: | :------: |
| `getFormResponses`                                                            |    ✅    |   ✅   |    —    |
| `getIssuesWithStatus`                                                         |    ✅    |   ✅   |    ✅    |
| `getSubmittedIssues`                                                          |    ✅    |   ✅   |    ✅    |
| `getPendingIssues`                                                            |    ✅    |   —   |    —    |
| `approveIssue` (payload: `{ticketId, severity}`)                            |    ✅    |   —   |    —    |
| `rejectIssue`                                                                 |    ✅    |   —   |    —    |
| `getLiveIssues`                                                               |    ✅    |   ✅   |    —    |
| `getClosedIssues`                                                             |    ✅    |   ✅   |    —    |
| `updateBuilderStatus`                                                         |    ✅    |   ✅   |    —    |
| `closeIssue`                                                                  |    ✅    |   ✅   |    —    |
| `reopenIssue`                                                                 |    ✅    |   ✅   |    —    |
| `deleteIssue`                                                                 |    ✅    |   —   |    —    |
| `generateTicketId`                                                            |    ✅    |   —   |    —    |
| `approveIssueWithTicketId` _(deprecated shim → `approveIssue`)_          |    ✅    |   —   |    —    |
| `getDashboardMetrics`                                                         |    ✅    |   ✅   |    —    |
| `syncFormResponses`                                                           |    ✅    |   —   |    —    |
| `submitIssue`                                                                 |    ✅    |   ✅   |    ✅    |
| `addPhotosToIssue` (payload: `{ticketId, sheet, photos:[{name,mime,b64}]}`) |    ✅    |   —   |    —    |
| `getReportPhotoB64` (payload: `{fileId, maxW}`)                             |    ✅    |   ✅   |    ✅    |
| `commitFullReportPdf` (payload: `{b64, source}`)                            |    ✅    |   ✅   |    ✅    |
| `getCategoryMaster`                                                           |    ✅    |   ✅   |    ✅    |
| `getClientConfig`                                                             |    ✅    |   ✅   |    ✅    |
| `validateUserAccess`                                                          |    ✅    |   ✅   |    ✅    |
| `diag`                                                                        |    ✅    |   ✅   |    ✅    |

> **Anonymous-visitor allow-list (`PUBLIC_ACTIONS` in [src/Router.gs](src/Router.gs)).** When the caller has no verified email (role `UNKNOWN` — the public deployment), the per-role allow-list is bypassed for a small whitelist: `getSubmittedIssues`, `getClientConfig`, `getCategoryMaster`, `diag`, `getReportPhotoB64`, `commitFullReportPdf`. Every other action returns `Unauthorized`. Note that this bypass applies to `UNKNOWN` only; a signed-in `RESIDENT` still needs the action in `RESIDENT_ALLOWED` (`submitIssue`, `getCategoryMaster`, `getIssuesWithStatus`, `getSubmittedIssues`, `validateUserAccess`, `getClientConfig`, `getReportPhotoB64`). In particular, `commitFullReportPdf` is only reachable by COMMITTEE, BUILDER, or an anonymous caller — not by a signed-in RESIDENT.

> **`diag`** returns the same payload as `api_diag()` — identity, deployment mode, webapp URL, and a sample `getPendingIssues` probe — so client code can surface why an action is failing without opening the Apps Script editor.

`addPhotosToIssue` lets the committee attach photos to an existing issue that was submitted without any (e.g. bulk Form imports). `sheet` must be one of `PENDING_REVIEW`, `LIVE_ISSUES`, or `CLOSED_ISSUES`. New URLs are appended (comma-separated) to the row's existing `PHOTO` column. Gated by **two** flags — both must be true: `FEATURE_COMMITTEE_PHOTO_ATTACH` (master switch for this feature, **default OFF**) and `FEATURE_PHOTO_UPLOAD` (global photo kill-switch). The committee dashboard also hides the **Upload Photo** button client-side when `FEATURE_COMMITTEE_PHOTO_ATTACH` is false.

`getReportPhotoB64` is the photo-fetch helper for the **Export Report** PDF wizard. It takes a Drive file id (or any drive URL containing one) and an optional max-width hint, fetches the JPEG bytes server-side via `UrlFetchApp` (avoids browser CORS issues that prevent jsPDF from embedding Drive thumbnails), and returns `{ mimeType, b64, sourceId }`. Gated by **two** flags — both must be true: `FEATURE_PDF_REPORT` (master switch for the report wizard, **default OFF**) and `FEATURE_PHOTO_UPLOAD` (global photo kill-switch). Available to all roles **including anonymous visitors** (role UNKNOWN) so the Export Report wizard on the public `submitted-issues.html` page can embed photo thumbnails — the underlying Drive attachment folder is already shared "Anyone with the link – Viewer" via `makeAttachmentFolderPublic`, so this exposes nothing that wasn't already publicly viewable via the issue-card thumbnails.

`commitFullReportPdf` accepts the wizard-rendered PDF bytes and overwrites `backups/TA_IAP_Full_Report.pdf`. **Allowed for every role — committee, builder, and anonymous — unconditionally.** Every export from every view (committee dashboard, builder dashboard, public submitted-issues) is fire-and-forget pushed to GitHub as the canonical `TA_IAP_Full_Report.pdf`, so the **View Full Report** pill on every page always reflects the freshest export regardless of who ran it. Access-policy gating (previously `FEATURE_PUBLIC_FULL_REPORT` for anonymous and `FEATURE_WEEKLY_REPORT_BACKUP` as master kill-switch) has been lifted from this endpoint per operator requirement. The handler retains integrity checks only: `GITHUB_TOKEN` script property must be set, 30 MB size cap, `%PDF` magic-byte check. `FEATURE_PUBLIC_FULL_REPORT` now only governs whether `getSubmittedIssues` includes CLOSED tickets in the anonymous feed; `FEATURE_WEEKLY_REPORT_BACKUP` now only gates the scheduled `weeklyReportJob` cron.

Response envelope: `{ success: boolean, data: any, error: string|null }`
(some legacy actions return `{ success, responses, count, error }` — the
client shim normalises both).

`api_whoAmI()` is a separate endpoint that returns `{ email, role }` for the
signed-in user (used by `API.whoAmI()` on page load).

---

## 8. Issue Lifecycle (state machine)

Strict-move semantics: every state transition is `appendRow(target); deleteRow(source)`.
No in-place state flips. A ticket lives on exactly one sheet at a time.

```
Form intake (severity BLANK)
  → PENDING_REVIEW
        ├─▶ approveIssue   → LIVE_ISSUES   (severity set, SLA computed)
        └─▶ rejectIssue    → ARCHIVES_ISSUES (audit, read-only)

LIVE_ISSUES (builder updates STATUS column in place):
  ASSIGNED → IN_PROGRESS → WORK_COMPLETED
        └─▶ closeIssue   → CLOSED_ISSUES

CLOSED_ISSUES:
  └─▶ reopenIssue    → LIVE_ISSUES (status = IN_PROGRESS)
```

> Severity & SLA are set **on approval**, not on intake. `approveIssue`
> requires `{ ticketId, severity }`; the server validates severity and
> computes `slaDate = calculateSLADate(severity, reportedDate)` before
> writing to `LIVE_ISSUES`.

### 8.1 Per-page data sources

Every page must fetch from **every** lifecycle sheet it surfaces — do not
infer counts from `getDashboardMetrics` alone.

| Page                         | Fetches                                                                                                              | Renders                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `committee-dashboard.html` | `getPendingIssues` (PENDING + ARCHIVES) + `getLiveIssues('ALL')` + `getClosedIssues` + `getDashboardMetrics` | Pending tab (filter: Pending/Rejected/All), Active tab, Closed tab                                |
| `builder-dashboard.html`   | `getLiveIssues('BUILDER')` + `getClosedIssues`                                                                   | Merged into single table; "Work Completed" filter covers both builder-marked and committee-closed |
| `admin-dashboard.html`     | `getDashboardMetrics` + `getLiveIssues('ALL')`                                                                   | KPIs + charts + aging/SLA tables                                                                  |
| `submitted-issues.html`    | `getSubmittedIssues` (unions PENDING + LIVE + optional ARCHIVES)                                                   | Single table with Status filter; archives gated by`SUBMITTED_INCLUDE_REJECTED`                  |
| `submit-issue.html`        | `getClientConfig` + `getCategoryMaster`                                                                          | Intake form                                                                                       |

> **Photo array shape (canonical).** Every reader emits the photo URLs as
> `i.issue.photoLinks` (array of normalized Drive thumbnail URLs).
> `getSubmittedIssues` additionally retains a root-level `attachments`
> array for the legacy submitted-issues detail-modal renderer; new
> consumers must read `i.issue.photoLinks`. The PDF Export wizard
> (`partials/pdf-report.html` `COLUMN_CATALOG.photos.read`) reads only
> the canonical field — root-only `attachments` will produce empty Photo
> cells.

---

## 9. Ticket IDs

- Generated by `generateTicketID()` at **intake** (Form trigger + in-portal submit).
- Format: `TKT-00001`, `TKT-00002`, … (5-digit, zero-padded).
- **Source of truth:** a `TICKET_COUNTER` value in
  `PropertiesService.getScriptProperties()`. Each call lifts the counter
  to `max(counter, scannedMax) + 1` and writes it back atomically
  inside a `LockService.getScriptLock()` critical section, so two
  concurrent intakes can never mint the same id and a manual sheet
  edit (paste, row-delete, re-import) can never collide either.
- `scannedMax` is computed across `PENDING_REVIEW` (the primary intake
  sheet — every new ticket lands here first), `LIVE_ISSUES`, and
  `CLOSED_ISSUES`, recognising both `TKT-` and legacy `TA-` prefixes.
- The ticket id **does not change** on approval. `approveIssueWithTicketId`
  is a deprecated shim retained for any legacy clients — it ignores
  `newTicketId` and delegates to `approveIssue`.

### 9.1 Recovery functions

When the spreadsheet drifts (duplicate ids, missing pending rows, etc.)
operators run these from the Apps Script editor — both take a full XLSX
backup to GitHub before any write:

- `renumberAllTicketIds()` (`src/Recovery.gs`) — rewrites `TICKET_ID`
  across `PENDING_REVIEW` + `LIVE_ISSUES` + `CLOSED_ISSUES` +
  `ARCHIVES_ISSUES` as a single monotonic `TKT-NNNNN` series sorted by
  `DATE_REPORTED` ascending. Resets `TICKET_COUNTER` to the new max.
  Drive folder names are **not** renamed; existing photos still resolve
  because they reference the folder by Drive id, not name.
- `recoverPendingFromForm()` (`src/Recovery.gs`) — wipes
  `PENDING_REVIEW` data rows and re-imports every row from
  `Form Responses 1` whose `{timestamp,resident,flat}` signature is not
  already present in `LIVE_ISSUES` or `CLOSED_ISSUES` (so already-
  promoted tickets are not duplicated). Drops the cached
  `TICKET_COUNTER` so new pending ids are minted from the surviving
  live/closed max via `generateTicketID()`.
- `dedupeTicketIds()` (`src/Recovery.gs`) — surgical fix for the
  "external paste introduced duplicate ids" scenario (e.g. an assessment
  CSV import seeded three rows with the same legacy `TA-0001`). Scans
  all four issue sheets, keeps the row with the earliest
  `DATE_REPORTED` for each id (tiebreak: sheet order in
  `RECOVERY_TICKET_SHEETS`, then row index), and assigns a fresh
  `TKT-NNNNN` id (via `generateTicketID()`) to every other occurrence.
  Non-duplicated rows are never touched, so existing photo folders and
  external references survive intact.
- `normalizeLegacyTicketIds()` (`src/Recovery.gs`) — companion to
  `dedupeTicketIds()` for the "external paste introduced bad-shape ids"
  scenario, **including singletons** (e.g. one-off `TA-0001` audit row
  pasted from an assessment dump). Scans all four issue sheets and
  reissues a fresh `TKT-NNNNN` id (via `generateTicketID()`) for every
  row whose id does not match `^TKT-\d{5}$`. Use after any direct
  paste of legacy / audit data into the sheets — `dedupeTicketIds`
  alone will not catch a unique `TA-0001` because there's nothing to
  deduplicate against.

---

## 10. SLA Rules

| Severity | Days |
| -------- | ---- |
| Critical | 1    |
| High     | 3    |
| Medium   | 7    |
| Low      | 15   |

Auto-calculated on approval (`calculateSLADate`). Dashboard surfaces breaches.

---

## 11. Google Form Fields (7)

Resident Name · Flat Number · Category · Sub-Category · Tower · Exact Location/Comment · Upload Photos/Video.

> Severity is **not** a form question. It is assigned by the Technical Committee
> on approval (see §8). The `Severity` column is retained in `Form Responses 1`
> and `PENDING_REVIEW` for historical rows and remains blank for new intake.
>
> Email and Phone are not collected by the form. Resident identity in the
> in-portal submit path comes from `Session.getActiveUser().getEmail()`.

`onFormSubmit` trigger writes a new `PENDING_APPROVAL` row.

---

## 12. Apps Script Triggers

| Trigger                                                                       | Schedule                                                                                                                                                                                                                                           | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `onFormSubmit`                                                              | On form submit                                                                                                                                                                                                                                     | Create ticket in`PENDING_REVIEW`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `clearConfigCache` *(optional)*                                           | Hourly                                                                                                                                                                                                                                             | Pick up CONFIG edits without manual run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `weeklyBackupJob` *(optional)*                                            | `REPORT_BACKUP_FREQUENCY` (default `"3x-daily"`) — every 8 hours by default; once per day at ~02:00 IST when `"daily"`; Mondays only at ~02:00 when `"weekly"`                                                                            | XLSX snapshot of the spreadsheet committed to`backups/ta-issue-manager.xlsx`. Installed by `installWeeklyBackupTrigger` once `GITHUB_TOKEN` is set. Re-run the installer after editing the tunable so the trigger is recreated with the new cadence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `weeklyReportJob` *(optional, gated by `FEATURE_WEEKLY_REPORT_BACKUP`)* | `REPORT_BACKUP_FREQUENCY` (default `"3x-daily"`) — every 8 hours by default; once per day at ~03:00 IST when `"daily"` (one hour after the daily sheet backup so it picks up that day's snapshot); Mondays only at ~03:00 when `"weekly"` | Builds the full PDF status report server-side (pending + active + closed + rejected, photos embedded inline) and commits it to GitHub as**two files** in `backups/`: the canonical live copy `TA_IAP_Full_Report.pdf` (overwritten every run) and the per-month archive `TA_IAP_Full_Report_<Mon>_<YYYY>.pdf` (e.g. `..._Jul_2026.pdf`) which freezes at month rollover because the filename changes. The same file is also overwritten on demand whenever any view's **Export Report** wizard finishes (committee, builder, or the public submitted page — the wizard streams jsPDF bytes back via `commitFullReportPdf`, and the monthly copy is written alongside). The scheduled trigger is the fallback when nobody exported in the last interval. Installed by `installWeeklyReportTrigger`; re-run after editing `REPORT_BACKUP_FREQUENCY`. See §19.14. |

---

## 13. Deployment (mandatory settings)

| Setting         | Value                                                                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Manifest        | [appsscript.json](appsscript.json) (`USER_ACCESSING`, `ANYONE`)                                                                                                                                                             |
| Required scopes | `spreadsheets`, `userinfo.email`, `script.container.ui`, `script.send_mail`, `drive` (read + write for uploads)                                                                                                      |
| Deploy as       | Web app,*Execute as: User accessing the web app*, *Who has access: Anyone with a Google account* (secure deployment) plus a sibling public deployment (`USER_DEPLOYING` / `ANYONE_ANONYMOUS`) for intake — see §19.8 |

### 13.1 Apps Script setup runbook (one-time, in order)

All functions live in `src/Config.gs`. Run from the Apps Script editor → function dropdown → Run. All are idempotent.

| #  | When                                                                                                                                                                            | Function                                       | What it does                                                                                                                                                                                                                                                                                                                                                                                       |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | Fresh deploy, or after pulling new`DEFAULT_FEATURES` / `DEFAULT_TUNABLES`                                                                                                   | `setupConfigSheet`                           | Seeds the`CONFIG` tab. Preserves existing operator values; appends only missing keys with defaults.                                                                                                                                                                                                                                                                                              |
| 2  | **Fresh deploy, or after re-binding to a different spreadsheet / form** — without this, form submissions land in `Form Responses 1` but **never become tickets** | `installFormSubmitTrigger` (`src/Main.gs`) | Idempotent. Removes any prior`onFormSubmit` triggers on this script project and creates a fresh spreadsheet-form-submit trigger so each new Google Form response runs `onFormSubmit(e)` → `createPendingIssue_()` → row appended to `PENDING_REVIEW` with a fresh `TKT-NNNNN` id. Returns `{success, message, data:{removed, triggerId}}`.                                           |
| — | _Diagnostic_ — confirm form / weekly / report triggers are wired up                                                                                                          | `listProjectTriggers` (`src/Main.gs`)      | Read-only. Lists every trigger on the script project (`handler`, `type`, `triggerSource`, `sourceId`, `uniqueId`). If `onFormSubmit` is missing, run `installFormSubmitTrigger`.                                                                                                                                                                                                     |
| — | _Optional_ — pre-seed `ATTACHMENT_FOLDER_ID` without waiting for the first upload                                                                                          | `setupAttachmentFolder`                      | Walks`My Drive / TA_HANDOVER / ISSUE_UPLOADS / TA Issue Reporting Portal / Upload Photos/Video` (tolerating ` (File responses)` suffix), persists the folder id in CONFIG, and forces public-view on the folder. **Not required** — `uploadSubmissionPhotos_` calls the same resolver lazily on first upload via `resolveAttachmentFolder_({ autoSetup: true, makePublic: true })`. |
| — | _Optional_ — bulk-publish files already inside the attachment folder (Form-uploaded, etc.)                                                                                   | `makeAttachmentFolderPublic`                 | Walks every file in the folder and re-applies*Anyone with link → Viewer*. New uploads after this build are made public automatically by `trySharePublic_` in the upload path. Falls back to `ANYONE` if domain policy blocks link sharing.                                                                                                                                                  |
| — | Anytime, to verify                                                                                                                                                              | `whereDoUploadsGo`                           | Read-only. Prints the configured folder's full path + URL. Does not change anything.                                                                                                                                                                                                                                                                                                               |
| — | After editing CONFIG by hand                                                                                                                                                    | `clearConfigCache`                           | Forces the next call to re-read CONFIG (5-min cache otherwise).                                                                                                                                                                                                                                                                                                                                    |

Full operator steps in the **Apps Script setup runbook** table in `README.md`.

---

## 14. Security Requirements

- ✅ Identity comes only from `Session.getActiveUser().getEmail()`.
- ✅ All actions pass through `api_call` → role-based allow-list.
- ✅ Client payloads MUST NOT contain `userEmail`; backend MUST ignore it.
- ✅ Committee/builder emails managed via CONFIG sheet (no code change to add/remove).
- ✅ No PII in `sessionStorage`, `localStorage`, or query strings.
- ✅ "Switch account" available on every page (`API.signOut()`).
- ✅ Defaults in [config.gs](config.gs) are FALLBACK ONLY (used if CONFIG sheet missing).
- ❌ No client-typed email/role login form.
- ❌ No "allow all as COMMITTEE" testing bypass in production.

---

## 15. Frontend Requirements

- Single-page-per-role design. Pages are loaded as Apps Script HTML files.
- All API calls go through the `API` shim in [assets/js/api.js](assets/js/api.js).
- `window.IRP_USER = { email, role }` is populated on page load via `API.whoAmI()`.
- Every dashboard runs an `ensureAuthorized()` IIFE before loading data and
  redirects to the landing page if the role is wrong.
- Tailwind via CDN, Font Awesome via CDN, Chart.js via CDN. No build step.
- Mobile breakpoints: 375px (iPhone SE), 360px (Android), 768px (iPad).
- Page weight target: < 200 KB compressed per page.

---

## 16. Non-Goals / Out of Scope

- Password-based authentication.
- Workspace-domain restriction (achievable later by changing deploy access setting; not required now).
- Mobile native apps.
- Multi-building / multi-tenant support.
- Real-time push (auto-refresh polling is sufficient).

---

## 17. Rollback Plan

Re-deploy with **Execute as: Me** + **Access: Anyone**, restore the
"BYPASS AUTHENTICATION" block in `validateUserAccess`, and the legacy client
flow still works. CONFIG sheet is backward-compatible.

---

## 18. Acceptance Criteria

1. Opening `/exec` while signed in as a committee member loads the committee dashboard with no email/role prompt.
2. Opening `/exec` while signed in as the builder loads the builder dashboard.
3. Opening `/exec` while signed in as an unauthorized Google account shows the access-denied landing with the verified email and a "Switch account" button.
4. A builder who manipulates DevTools to call `API.call('approveIssue', …)` receives `Forbidden for role BUILDER: approveIssue`.
5. Removing an email from `CONFIG.COMMITTEE_EMAILS` and running `clearConfigCache` revokes that user's access within seconds.
6. No `sessionStorage`/`localStorage` key contains an email after any flow.
7. `doPost` ignores any `userEmail` field in the request body and uses `Session.getActiveUser().getEmail()`.

---

## 19. Critical Issues & Lessons Learned

This section records bugs whose root cause was non-obvious. Re-read before
touching the affected area.

### 19.1 `google.script.run` silently returns `null` on Invalid Date

**Symptom:** `api_call('getX')` resolves to `null` on the client even though
the server function returns a populated `{success, data, error}` object.
No error, no console log, no stack trace.

**Root cause:** Apps Script cannot serialize `new Date(NaN)` across the
`google.script.run` bridge. If **any** field in the response is an Invalid
Date, the *entire* response is dropped and the success handler receives
`null`. Invalid Dates are produced when reading empty date-formatted Sheet
cells with `getValues()`.

**Rule:** Every value returned to the client must pass through the helpers
in `src/Main.gs`:

- `safeStr_(v)` — coerce to string, blank for null/undefined.
- `safeDateIso_(v)` — ISO string, or `""` if invalid/empty.

Applies to **all** server functions that read from sheets:
`getPendingIssues`, `getLiveIssues`, `getClosedIssues`,
`getSubmittedIssues`, `getFormResponses`, `getIssuesWithStatus`, etc.

### 19.2 Strict-move semantics for sheet-based state transitions

**Symptom:** Committee "Pending Only" filter showed approved tickets.
Rows appeared on multiple tabs at once.

**Root cause:** `approveIssue` was flipping a `STATE=APPROVED` column in
place on `PENDING_REVIEW` and **also** appending to `LIVE_ISSUES`. The
same ticket existed on two sheets.

**Rule:** Every transition is `appendRow(target); deleteRow(source)` —
in that order, inside one function. Never leave a logical state flag on
the source row. A ticket lives on exactly one sheet at a time.

Applies to: `approveIssue`, `rejectIssue`, `closeIssue`, `reopenIssue`,
`deleteIssue`.

### 19.3 Never silently swap in mock data on API failure

**Symptom:** Dashboard "worked" with plausible-looking content while the
real backend was broken (permission denied, null response, etc.).
Real failures went undetected for days.

**Rule:** On API failure, render empty state + a visible toast carrying
the real error message. Mock data is for local development only and must
never be used as a runtime fallback. If permissions are the likely cause,
append a hint ("your Google account may not have access…").

Reference implementation: `committee-dashboard.html → loadData()` catch
block.

### 19.4 Per-page data audit — fetch from every relevant lifecycle sheet

**Symptom:** Committee "Closed" tab was permanently empty. Builder
"Work Completed" filter only showed builder-marked rows, not committee-closed
tickets.

**Root cause:** Pages were sourcing counts from `getDashboardMetrics`
(which has aggregates but not row data) instead of fetching the actual
sheet via `getClosedIssues`.

**Rule:** When a page surfaces rows from a lifecycle state, it must call
the dedicated getter for that sheet. See §8.1 for the per-page matrix.
When adding a new state or sheet, update that matrix and audit every page.

### 19.5 Sheet column layouts diverge per tab — don't share a single map

`PENDING_REVIEW` uses `PENDING_COL` (width `PENDING_WIDTH = 17`).
`LIVE_ISSUES` and `CLOSED_ISSUES` use `LIVE_COL` (width `LIVE_WIDTH = 20`).
`ARCHIVES_ISSUES` reuses `PENDING_COL`.
`CLOSED_ISSUES` extends `LIVE_COL` with 4 trailing columns:
`[reason, closedDate, closedBy, resolutionDays]` at indices
`LIVE_WIDTH .. LIVE_WIDTH+3`.

Functions that union rows across sheets (e.g. `getSubmittedIssues`) must
use a per-sheet mapper — do not index `row[]` with a single shared map.

### 19.6 `submitIssue` writes blank severity

Severity is assigned by the committee on approval, not by the resident.
`submitIssue` and the form trigger both force `severity = ""` regardless
of any client-supplied value. The submit form has no severity field.

### 19.7 Tunables that gate visibility

| Tunable (CONFIG sheet)                 | Default        | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUBMITTED_INCLUDE_REJECTED`         | `"false"`    | When`"true"`, `getSubmittedIssues` also unions `ARCHIVES_ISSUES`. Read-only submitted view hides rejected rows by default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `FEATURE_SHOW_SEVERITY_ON_SUBMITTED` | `"false"`    | When`"true"`, severity column is visible on the submitted-issues page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `FEATURE_OPEN_SHEET_LINK`            | `"false"`    | When`"true"`, the public submitted-issues page renders the **Open in Sheets** pill (linking to the underlying spreadsheet) on the title row. Default OFF — opt-in. The button is server-rendered, so when off it is absent from the HTML entirely (no client-side gate to bypass).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `FEATURE_COMMITTEE_PHOTO_ATTACH`     | `"false"`    | When`"true"`, committee detail view shows an **Upload Photo** button on issues without photos and the `addPhotosToIssue` API accepts writes. Default OFF — opt-in via the CONFIG sheet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `FEATURE_PDF_REPORT`                 | `"true"`     | When`"true"` (the default), every list view (Committee / Builder / Submitted read-only) shows an **Export Report** button that opens a shared PDF wizard (sources, columns, embedded photos, image quality) and the `getReportPhotoB64` API accepts requests. **Full-privileges model:** every view now surfaces the **full 17-column catalog** in the wizard's Advanced Options — pages only pass `columnDefaultsOn` to pre-check the columns most useful for that view, and the operator can enable anything else (resident, action-by, rejection, subcategory, SLA, etc.) before rendering. The column catalog and per-view defaults live in `src/partials/pdf-report.html` and each page's `openExportReport()`. The first page opens with a compact title header (portal + title band + single meta line of generated/by/source-counts/filters) and the first section's list begins immediately below — no full cover page. Photos are embedded **only inline in the Photos column** (thumbnail grid sized by `INLINE_THUMB`); there is no separate end-of-section gallery. Each thumbnail in the PDF is a **clickable hyperlink** — clicking (in any PDF reader) opens the full-resolution image in the Drive viewer (`https://drive.google.com/file/d/<ID>/view`), where the built-in pan/zoom controls are available; placeholders for missing photos are also clickable and resolve to the same viewer URL. **Image-quality selector** (wizard → Advanced Options → *Image quality* radios): `Low` = 400 px thumbs (~30 KB/photo, **default**), `Medium` = 900 px (~90 KB/photo), `High` = 1600 px (~250 KB/photo); the selected width is sent as the `maxW` payload to `getReportPhotoB64`. The wizard's "Include photos" master switch gates inline rendering and, when off, also drops the Photos column from the table and greys out the quality selector. Default ON — turn off in the CONFIG sheet to hide the wizard. |
| `FEATURE_WEEKLY_REPORT_BACKUP`       | `"true"`     | When`"true"` (the default), the scheduled `weeklyReportJob` cron commits the full PDF status report to GitHub as **two files** in `backups/`: the canonical live copy `TA_IAP_Full_Report.pdf` (overwritten every run — pending + active + closed + rejected, resident names / flats / descriptions kept as-is, photos embedded inline via authenticated `UrlFetchApp` + script OAuth Drive thumbnail fetch, capped at 4 photos per issue / 60 per report) and the per-month archive `TA_IAP_Full_Report_<Mon>_<YYYY>.pdf` (e.g. `TA_IAP_Full_Report_Jul_2026.pdf`) which is overwritten within the same calendar month and freezes at month rollover. All five pages (login, submitted, committee, builder, admin) expose the canonical file via a small **View Full Report** pill that resolves to `FULL_REPORT_PUBLIC_URL` (auto-derived from `BACKUP_REPO` + `BACKUP_BRANCH` when the tunable is empty). The pill renders **whenever the URL resolves** and is independent of this flag. **This flag now gates the scheduled cron only** — it no longer gates the on-demand wizard commit path, which fires from every view / every role unconditionally (see `commitFullReportPdf` in §7). The cron still requires the `GITHUB_TOKEN` script property and a configured `BACKUP_REPO`. Default ON — turn off in the CONFIG sheet to pause the scheduled cron (wizard exports continue to overwrite the canonical + monthly files on demand).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `FEATURE_PUBLIC_FULL_REPORT`         | `"true"`     | When`"true"` (the default), the anonymous `submitted-issues.html` feed matches the committee/builder data scope: `getSubmittedIssues` unions `CLOSED_ISSUES` (alongside pending + live + the existing `SUBMITTED_INCLUDE_REJECTED` gate on rejected), so the wizard's PDF covers the full ticket lifecycle. **This flag no longer gates `commitFullReportPdf`** — every view (including anonymous) unconditionally pushes the rendered PDF to GitHub as `TA_IAP_Full_Report.pdf` (see §7). Flip OFF in CONFIG if the anonymous data scope should exclude closed tickets — the wizard commit itself keeps firing, and its integrity checks (`%PDF` magic, 30 MB cap, `GITHUB_TOKEN` required) remain the only defences.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `FULL_REPORT_PUBLIC_URL`             | `""`         | Raw URL where`TA_IAP_Full_Report.pdf` (the full report including names, flats, closed/rejected rows, **and embedded photos**) lands. Recommended: `https://raw.githubusercontent.com/tadeskops/ta-issue-manager/main/backups/TA_IAP_Full_Report.pdf`. **When empty, the server auto-derives this URL from `BACKUP_REPO` + `BACKUP_BRANCH`** unconditionally so the **View Full Report** pill on every page works out-of-the-box. **Privacy note:** the full file contains residents' names and flat numbers — keep the backup repo private, or override this tunable to point at an authenticated mirror, before sharing widely. The per-month archives (`TA_IAP_Full_Report_<Mon>_<YYYY>.pdf`) sit next to the canonical file at the same base URL and can be linked directly (`…/backups/TA_IAP_Full_Report_Jul_2026.pdf`) when a specific month's snapshot is needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `REPORT_BACKUP_FREQUENCY`            | `"3x-daily"` | Cadence for**both** scheduled trigger jobs that commit to the GitHub mirror — the XLSX sheet backup (`weeklyBackupJob`, ~02:00 anchor) and the PDF report job (`weeklyReportJob`, ~03:00 anchor). Accepted values: **`"3x-daily"` (default)** installs `.everyHours(8)` so each job fires roughly **3 times per 24 h** — chosen so the canonical `backups/TA_IAP_Full_Report.pdf` and `backups/ta-issue-manager.xlsx` stay fresh enough for an end-of-shift snapshot model without crossing the Apps Script daily-trigger quota; Apps Script `.everyHours()` cannot be pinned to a specific wall-clock hour, so the actual fire times depend on when the trigger was installed. `"daily"` falls back to once per day at the legacy ~02:00 / ~03:00 slot via `.everyDays(1).atHour(...)`. `"weekly"` reverts to the historic Mondays-only schedule. Any other value (typo, blank, common spelling variants like `"3x"` or `"thrice-daily"` are tolerated; everything else) is treated as `"3x-daily"`. Apps Script time-based triggers are independent objects — **editing this tunable does not move an already-installed trigger.** Re-run `installWeeklyBackupTrigger` and `installWeeklyReportTrigger` from the Apps Script editor after changing the value so each installer wipes its prior trigger and recreates it with the new cadence. The function names retain the `weekly` prefix for backward compatibility; only the schedule changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `FEATURE_SLA`                        | `"false"`    | When`"true"`, every list view (Committee / Builder / Admin) shows SLA breach KPI cards, the **SLA Days** column, the **SLA Breached** filter option, the **SLA Status / Due Date / Days Remaining** detail-modal block, and the PDF wizard exposes `slaDue` + `breached` columns. The `getLiveIssues` API still returns a `sla:{}` sub-object (with placeholder `dueDate:""`, `breached:false`, `daysRemaining:null` when off), and `getDashboardMetrics.slaBreaches` is forced to `0` when off so existing clients don't NPE. SLA due-date is still **computed and written** to `LIVE_ISSUES.SLA_DATE` at `approveIssue` time regardless of the flag, so flipping it on later "just works". The approve-modal severity labels also drop the `(SLA X day)` suffix and the helper note `SLA due date is computed…` when off. Default OFF — opt-in via the CONFIG sheet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Defaults live in `DEFAULT_TUNABLES` (`src/Config.gs`); CONFIG sheet values
override.

### 19.8 Two deployments — public vs secure

The app is published as two web-app deployments and CI keeps both in sync
via `clasp 3.3.0`:

| Deployment | `executeAs`      | `access`           | Purpose                                   |
| ---------- | ------------------ | -------------------- | ----------------------------------------- |
| Public     | `USER_DEPLOYING` | `ANYONE_ANONYMOUS` | Landing + intake form (no Google sign-in) |
| Secure     | `USER_ACCESSING` | `ANYONE`           | All authenticated dashboards              |

`signOut()` and "Back to Login" redirect to `PUBLIC_WEBAPP_URL`. Do not
merge these into a single deployment — the public one must not require
Google sign-in.

### 19.9 Status enum — only what the server actually writes

UI dropdowns, badge maps and fallback labels must list **only** the states
the server writes. Inventing extra states (e.g. `NEW`) causes filters to
show empty results and confuses users.

Canonical status set (single source of truth):

| Status               | Set by                        | Lives on            |
| -------------------- | ----------------------------- | ------------------- |
| `PENDING_APPROVAL` | form intake /`onFormSubmit` | `PENDING_REVIEW`  |
| `REJECTED`         | `rejectIssue`               | `ARCHIVES_ISSUES` |
| `ASSIGNED`         | `approveIssue`              | `LIVE_ISSUES`     |
| `IN_PROGRESS`      | builder update                | `LIVE_ISSUES`     |
| `WORK_COMPLETED`   | builder update                | `LIVE_ISSUES`     |
| `REOPENED`         | `reopenIssue`               | `LIVE_ISSUES`     |
| `CLOSED`           | `closeIssue`                | `CLOSED_ISSUES`   |

When adding a new state, update **every** page's filter dropdown,
`getStatusBadge()`, `getStatusIcon()`, and any `status || 'FALLBACK'`
default. When removing a state, sweep the codebase first
(`grep -rE "['\"]STATE['\"]" src/`).

### 19.10 `.gs` files have no local JS parser — `clasp push` is the syntax check

**Symptom:** Local edits to `src/Main.gs` looked fine in VS Code, all
"No errors found", but CI failed with:
`Syntax error: SyntaxError: Illegal return statement line: NNNN file: src/Main.gs`

**Root cause:** Apps Script `.gs` files are not parsed by any local
tool — VS Code's JS language service does not load them by default, so
orphan `return` statements, missing function headers and unbalanced
braces only surface when the V8 runtime parses them server-side after
`clasp push`. In this incident an earlier refactor stripped the
`function reopenIssue(...) {` header and left its body as top-level code.

**Rule:** After any edit that touches function boundaries in a `.gs`
file, run a quick brace/return audit before committing:

```powershell
node -e "const s=require('fs').readFileSync('src/Main.gs','utf8');let d=0;s.split('\n').forEach((l,i)=>{const o=(l.match(/{/g)||[]).length,c=(l.match(/}/g)||[]).length;d+=o-c;if(/^\s*return\b/.test(l)&&d===0)console.log('TOP-LEVEL RETURN at',i+1)});console.log('depth='+d)"
```

`depth` must end at `0`, and there must be no top-level returns.

### 19.11 CI: never let `bash -e` swallow command output

**Symptom:** Workflow step showed only `Process completed with exit code 1`,
no diagnostic from the failing command.

**Root cause:** `OUTPUT=$(cmd 2>&1); echo "$OUTPUT"` under `bash -e`
aborts the script on the assignment line the moment `cmd` exits non-zero,
so `echo` never runs and the captured stderr is lost.

**Rule:** Wrap any capture-then-inspect pattern in `set +e … set -e`:

```bash
set +e
OUTPUT=$(clasp push -f 2>&1)
EC=$?
set -e
echo "$OUTPUT"
echo "exit code: $EC"
[ $EC -ne 0 ] && { echo "::error::cmd failed"; exit $EC; }
```

### 19.12 `clasp 3.x` `.claspignore` uses strict gitignore semantics

**Symptom:** `clasp push -f` reported `Pushed 0 files` and CI failed.

**Root cause:** clasp 3.x switched its ignore parser to strict gitignore
rules: *"It is not possible to re-include a file if a parent directory of
that file is excluded."* The legacy whitelist pattern

```
**
!appsscript.json
!src/**
```

excludes the `src/` directory itself, so `!src/**` has no effect — and
older clasp versions silently tolerated this.

**Rule:** Use root-anchored ignores so parent dirs are never excluded:

```
/*
/.*

!/appsscript.json
!/src
```

`/*` only matches top-level non-hidden entries; `/.*` covers root-level
dotfiles (`.github`, `.gitignore`, `.claspignore`). The `src/` directory
is then never excluded, so its full contents are walked and pushed.

### 19.13 Drive `/file/d/<id>/view` URLs do **not** render in `<img>` tags

**Symptom:** Photos uploaded via the Google Form (or older portal
submissions) showed as broken images in the web app, even though clicking
the link in a new tab worked.

**Root cause:** `DriveApp.File.getUrl()` returns the **HTML viewer** URL
(`https://drive.google.com/file/d/<id>/view?...`). The browser fetches an
entire Drive HTML page, not the image bytes, so `<img src=...>` fails.
Additionally, the legacy `?export=view` endpoint sometimes triggers a
redirect chain that the Apps Script iframe blocks.

**Rule:** Every photo URL returned to the client must be normalized via
`driveImageUrl_(url)` in `src/Main.gs`, which rewrites any Drive URL
(`/file/d/<id>/view`, `?id=<id>`, `/open?id=<id>`, `/uc?...`) to the
thumbnail endpoint:

```
https://drive.google.com/thumbnail?id=<ID>&sz=w2000
```

This endpoint streams JPEG bytes, honors *Anyone with the link* sharing,
and works inside `<img>`. `splitPhotoLinks_` applies the normalization
automatically for **every** reader (`getPendingIssues`, `getLiveIssues`,
`getClosedIssues`, `getFormResponses`, etc.), so callers never need to
convert URLs themselves.

**Companion rule:** Files in the attachment folder must be publicly
viewable for any web-app visitor (the public deployment serves anonymous
users — see §19.8). `uploadSubmissionPhotos_` forces
`ANYONE_WITH_LINK → VIEW` on every new upload (falling back to `ANYONE`
and logging on policy block). For legacy / Form-uploaded files, run
`makeAttachmentFolderPublic` once (§13.1) to retroactively open up the
entire folder.

### 19.14 Full PDF status report — single canonical file + monthly archive

**Goal.** Operators want a static PDF snapshot of the issue queue
checked into the GitHub mirror so it survives Sheet edits, accidental
deletions, and Apps Script outages, and is linked from **every** page
(login, submitted, committee, builder, admin) via a small **View Full
Report** pill. The anonymised variant has been retired — every view,
every role, and the scheduled cron all converge on the same full report,
so there is only one artifact to reason about. The cron is gated by
`FEATURE_WEEKLY_REPORT_BACKUP` (default **on**) and ships **two files at
the same `BACKUP_REPO`** — a live canonical copy and a per-month archive:

| File path (in repo)                             | Overwrite policy                                                                                                                                           | Content                                                                                                                                                                                                                                                                                                                                                                                                       | Surfaced where                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `backups/TA_IAP_Full_Report.pdf`              | Overwritten by every commit (wizard export or cron run)                                                                                                    | Pending + Active + Closed + Rejected. Per-issue table including resident name, full Tower / Flat, descriptions,**and inline photos** (server-side cron fetches Drive thumbnails authenticated via `UrlFetchApp` + script OAuth and embeds them via `Body.appendImage`, capped at 4 photos per issue / 60 per report; the wizard-pushed copy is even richer thanks to jsPDF's clickable thumbnails). | **All five pages** (login, submitted, committee, builder, admin) via a small **View Full Report** pill that resolves to `FULL_REPORT_PUBLIC_URL` (auto-derived from `BACKUP_REPO` + `BACKUP_BRANCH` when the tunable is empty). The pill is **independent of `FEATURE_WEEKLY_REPORT_BACKUP`** — it renders whenever the URL resolves so the link keeps working even after the cron is paused. |
| `backups/TA_IAP_Full_Report_<Mon>_<YYYY>.pdf` | Overwritten within the same calendar month;**freezes at month rollover** because the filename changes (`..._Jul_2026.pdf` → `..._Aug_2026.pdf`) | Identical bytes to the canonical file at commit time.                                                                                                                                                                                                                                                                                                                                                         | No UI surface — consumed by operators via the GitHub file browser (or by linking`…/backups/TA_IAP_Full_Report_<Mon>_<YYYY>.pdf` directly when a specific month's snapshot is needed). Kept forever — small PDFs, ~12 files per year.                                                                                                                                                                                |

**Two write paths, both write both files.**

1. **Wizard auto-commit.** Whenever ANY view's **Export Report** wizard
   finishes rendering — committee, builder, or the anonymous public
   `submitted-issues.html` — the client (jsPDF + `jspdf-autotable`,
   optional photos) base64-encodes the bytes and calls
   `commitFullReportPdf(b64, source)` on the server fire-and-forget.
   The server validates the `%PDF` magic bytes, enforces a 30 MB size
   cap, checks `GITHUB_TOKEN` is set, and upserts the canonical file
   via the existing `backup_putToGit_` helper. Immediately after,
   `weeklyReport_commitMonthly_` writes the same bytes to
   `TA_IAP_Full_Report_<Mon>_<YYYY>.pdf`; a failure there is logged
   but does not fail the primary commit. Failures never block the
   user's local download / preview. **No feature flag or per-page
   opt-in gates this write** — every view pushes the same canonical
   `TA_IAP_Full_Report.pdf` (and the corresponding monthly file) so
   the **View Full Report** pill on every page always reflects the
   freshest export. The router lists `commitFullReportPdf` in
   `PUBLIC_ACTIONS` (unconditional anonymous access);
   `FEATURE_PUBLIC_FULL_REPORT` now only governs whether
   `getSubmittedIssues` includes CLOSED tickets in the anonymous
   feed; `FEATURE_WEEKLY_REPORT_BACKUP` now only gates the
   scheduled cron (path 2 below).
2. **Scheduled server fallback.** A time-based trigger
   `weeklyReportJob` runs on a schedule controlled by
   `REPORT_BACKUP_FREQUENCY` and rebuilds the full report using
   `DocumentApp` server-side, then commits both files (canonical +
   monthly). **Default `"3x-daily"` installs `.everyHours(8)`** so
   each scheduled run refreshes `backups/TA_IAP_Full_Report.pdf`
   roughly three times every 24 h — a quiet shift never goes longer
   than ~8 h without a fresh snapshot, and the **View Full Report**
   pill on every page picks up the latest content automatically.
   `"daily"` reverts to once per day at ~03:00 IST (one hour after
   the daily sheet backup so it picks up that day's snapshot);
   `"weekly"` keeps the legacy Mondays-only schedule. The companion
   `weeklyBackupJob` (XLSX snapshot, ~02:00 anchor) reads the same
   tunable so the sheet backup and PDF report stay aligned. The
   canonical file overwrites every run; the monthly file overwrites
   within the current calendar month and starts a fresh file at
   month rollover. **Editing `REPORT_BACKUP_FREQUENCY` does not move
   an already-installed trigger** — re-run both
   `installWeeklyBackupTrigger` and `installWeeklyReportTrigger`
   after changing the value so each installer wipes its prior
   trigger and recreates it with the new cadence. The function names
   retain the `weekly` prefix for backward compatibility; only the
   schedule changes.

**Implementation pointers.** All logic lives in
[`src/WeeklyReport.gs`](../src/WeeklyReport.gs):

- `weeklyReport_props_()` reads `GITHUB_TOKEN` / `BACKUP_REPO` /
  `BACKUP_BRANCH` from script properties (reusing
  `backup_props_()` from `src/Backup.gs`) plus `WEEKLY_REPORT_DIR`
  (default `backups`) and `FULL_REPORT_FILE` (default
  `TA_IAP_Full_Report.pdf`).
- `weeklyReport_monthlyFile_(when, baseName)` inserts the
  `_<Mon>_<YYYY>` suffix before the extension — e.g.
  `TA_IAP_Full_Report.pdf` → `TA_IAP_Full_Report_Jul_2026.pdf` — using
  the script time zone so month rollover matches operator wall-clock.
- `weeklyReport_commitMonthly_(cfg, when, bytes, message)` upserts
  the monthly file via `backup_putToGit_`; wraps any error so a
  failure there never breaks the primary canonical-file commit.
- `weeklyReport_renderPdfBlob_(rows, stats)` builds the full-report
  PDF (no `variant` parameter — anonymised branch was removed).
- `generateFullReportPdf(reason)` is the standalone runnable for
  one-off rebuilds (operator runbook in `README.md`); it writes
  both files.
- `commitFullReportPdf(b64, source)` accepts the wizard's bytes;
  rejects anything where the first three decoded bytes don't match
  the `%PDF` signature (37 80 68 70) or where the payload exceeds
  30 MB; on success writes both canonical and monthly files.

**Privacy stance.** The full report contains residents' names, flat
numbers, and complaint descriptions. Keep the backup repo private, or
override `FULL_REPORT_PUBLIC_URL` to point at an authenticated mirror,
before sharing the pill widely. The monthly archive files inherit the
same privacy properties (same bytes, same folder).

# Issue Addressal Portal (IRP) — Requirements

> Lightweight, serverless issue-management workflow for the residential society.
> One Google Sheet is the database; one Apps Script project is the host (UI + API + auth).

---

## 1. System Overview

| Aspect | Value |
|---|---|
| Purpose | Track resident-reported issues from intake → committee approval → builder execution → closure |
| Hosting | Single Apps Script web app (HtmlService) |
| Storage | One bound Google Sheet (7 tabs incl. `CONFIG`) |
| Identity | Google account sign-in (`Session.getActiveUser()`) |
| Authorization | Role lookup against the `CONFIG` sheet |
| Cost | Free (Google Sheets + Apps Script quotas only) |
| External services | None — no Firebase, no OAuth Client ID, no GitHub Pages |

---

## 2. Roles

| Role | How identified | Capabilities |
|---|---|---|
| Resident | Submits Google Form (no sign-in to portal) | Submit issues only |
| Technical Committee | Google email listed in `CONFIG.COMMITTEE_EMAILS` | Approve/reject pending, view all dashboards, close/reopen, delete, full read |
| Builder | Google email matching `CONFIG.BUILDER_EMAIL` | Read assigned issues, update builder status / comment / vendor, close/reopen |
| Unknown | Any signed-in Google user not in CONFIG | Denied — sees a "not authorized" landing page |

> Committee membership and builder email are runtime-editable via the `CONFIG` sheet.
> No code changes required to onboard or remove a member.

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

| File | Role |
|---|---|
| [appsscript.json](appsscript.json) | Manifest — web app deploy config + OAuth scopes |
| [Router.gs](Router.gs) | `doGet`, role-based routing, `api_call`, `api_whoAmI`, allow-list |
| [config.gs](config.gs) | CONFIG-sheet reader, `getUserRole()`, cache, `setupConfigSheet()` |
| [apps-script.gs](apps-script.gs) | Business logic, sheet handlers, hardened `doPost` |
| [assets/js/api.js](assets/js/api.js) | Transport shim: `google.script.run` in prod, `fetch` for local dev |
| [index.html](index.html) | Landing / access-denied / "Switch account" |
| [committee-dashboard.html](committee-dashboard.html) | Committee queue + active issues |
| [builder-dashboard.html](builder-dashboard.html) | Builder task list + status updates |
| [dashboard.html](dashboard.html) | Admin analytics (committee only) |
| [submitted-issues.html](src/pages/submitted-issues.html) | Read-only view of `PENDING_REVIEW` enriched with downstream LIVE / CLOSED status (severity hidden by default — controlled by `FEATURE_SHOW_SEVERITY_ON_SUBMITTED`) |
| [DEPLOYMENT_AUTH.md](DEPLOYMENT_AUTH.md) | Deploy steps for the auth model |

---

## 5. Google Sheet Schema (9 tabs)

| # | Tab | Purpose |
|---|---|---|
| 1 | `Form Responses 1` | Raw form intake (auto-populated by Google Forms) |
| 2 | `PENDING_REVIEW` | Issues **currently** awaiting committee approval. Rows leave this sheet on approve/reject (strict move). |
| 3 | `LIVE_ISSUES` | Approved, active issues (builder updates here). Rows leave on close. |
| 4 | `BUILDER_VIEW` | Spreadsheet-side formula view of `LIVE_ISSUES` for the builder — no code reader |
| 5 | `ARCHIVES_ISSUES` | **Rejected** issues (moved here from `PENDING_REVIEW` on reject). Read-only from the app. |
| 6 | `CLOSED_ISSUES` | Resolved, archived issues. Layout = `LIVE_COL` + 4 closure columns `[reason, closedDate, closedBy, resolutionDays]`. |
| 7 | `CATEGORY_MASTER` | Dropdown values |
| 8 | `DASHBOARD` | Formula-only metric tab |
| 9 | `CONFIG` | Runtime config: identity, assets, feature flags, tunables |

`SHEET_ID` is hardcoded in [src/Main.gs](src/Main.gs#L4); all sheet names live in the `SHEETS` constant.

### 5.1 CONFIG tab layout

| Key | Value | Notes |
|---|---|---|
| `COMMITTEE_EMAILS` | `a@x.com, b@x.com` | Comma- or newline-separated |
| `BUILDER_EMAIL` | `builder@x.com` | Single email |
| `LOGO_URL` | `https://drive.google.com/uc?id=…` | Optional — falls back to bundled asset |
| `ATTACHMENT_FOLDER_ID` | `1AbC…xyz` | Drive folder ID for **all** in-portal photo uploads (resident submit page + committee "attach later" uploader). **Auto-populated on first upload** by `resolveAttachmentFolder_({ autoSetup: true })` — walks the canonical path under My Drive and persists the result. Operators can pre-seed it via `setupAttachmentFolder` (see §13.1) or override it with a different folder id manually. |

Feature flags and numeric tunables are stored as additional rows; their canonical defaults live in `DEFAULT_FEATURES` / `DEFAULT_TUNABLES` (`src/Config.gs`). Cached 5 min in `CacheService`; `clearConfigCache()` forces refresh.

---

## 6. Web App URL Routes (`doGet` parameters)

| URL | Behaviour |
|---|---|
| `/exec` | Role-based landing — committee → committee dashboard, builder → builder dashboard, unknown → denied page |
| `/exec?page=committee` | Force committee dashboard (committee only) |
| `/exec?page=builder` | Force builder dashboard (builder or committee) |
| `/exec?page=admin` | Admin analytics (committee only) |
| `/exec?page=submitted` | Read-only submitted-issues table (committee or builder) |

Unauthorized requests for a page never reach the HTML — `Router.gs` substitutes the denied page.

---

## 7. Server API Surface (`google.script.run.api_call`)

All requests pass through `api_call(action, payload)` in [Router.gs](Router.gs).
`isActionAllowed_(action, role)` is the single source of truth for capabilities.

| Action | Committee | Builder | Resident |
|---|:---:|:---:|:---:|
| `getFormResponses` | ✅ | ✅ | — |
| `getIssuesWithStatus` | ✅ | ✅ | ✅ |
| `getSubmittedIssues` | ✅ | ✅ | ✅ |
| `getPendingIssues` | ✅ | — | — |
| `approveIssue` (payload: `{ticketId, severity}`) | ✅ | — | — |
| `rejectIssue` | ✅ | — | — |
| `getLiveIssues` | ✅ | ✅ | — |
| `getClosedIssues` | ✅ | ✅ | — |
| `updateBuilderStatus` | ✅ | ✅ | — |
| `closeIssue` | ✅ | ✅ | — |
| `reopenIssue` | ✅ | ✅ | — |
| `deleteIssue` | ✅ | — | — |
| `generateTicketId` | ✅ | — | — |
| `approveIssueWithTicketId` _(deprecated shim → `approveIssue`)_ | ✅ | — | — |
| `getDashboardMetrics` | ✅ | ✅ | — |
| `syncFormResponses` | ✅ | — | — |
| `submitIssue` | ✅ | ✅ | ✅ |
| `addPhotosToIssue` (payload: `{ticketId, sheet, photos:[{name,mime,b64}]}`) | ✅ | — | — |
| `getReportPhotoB64` (payload: `{fileId, maxW}`) | ✅ | ✅ | ✅ |
| `getCategoryMaster` | ✅ | ✅ | ✅ |
| `getClientConfig` | ✅ | ✅ | ✅ |
| `validateUserAccess` | ✅ | ✅ | ✅ |

`addPhotosToIssue` lets the committee attach photos to an existing issue that was submitted without any (e.g. bulk Form imports). `sheet` must be one of `PENDING_REVIEW`, `LIVE_ISSUES`, or `CLOSED_ISSUES`. New URLs are appended (comma-separated) to the row's existing `PHOTO` column. Gated by **two** flags — both must be true: `FEATURE_COMMITTEE_PHOTO_ATTACH` (master switch for this feature, **default OFF**) and `FEATURE_PHOTO_UPLOAD` (global photo kill-switch). The committee dashboard also hides the **Upload Photo** button client-side when `FEATURE_COMMITTEE_PHOTO_ATTACH` is false.

`getReportPhotoB64` is the photo-fetch helper for the **Export Report** PDF wizard. It takes a Drive file id (or any drive URL containing one) and an optional max-width hint, fetches the JPEG bytes server-side via `UrlFetchApp` (avoids browser CORS issues that prevent jsPDF from embedding Drive thumbnails), and returns `{ mimeType, b64, sourceId }`. Gated by **two** flags — both must be true: `FEATURE_PDF_REPORT` (master switch for the report wizard, **default OFF**) and `FEATURE_PHOTO_UPLOAD` (global photo kill-switch). Available to all roles because the report wizard ships on the committee, builder, and read-only submitted views.

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

| Page | Fetches | Renders |
|---|---|---|
| `committee-dashboard.html` | `getPendingIssues` (PENDING + ARCHIVES) + `getLiveIssues('ALL')` + `getClosedIssues` + `getDashboardMetrics` | Pending tab (filter: Pending/Rejected/All), Active tab, Closed tab |
| `builder-dashboard.html` | `getLiveIssues('BUILDER')` + `getClosedIssues` | Merged into single table; "Work Completed" filter covers both builder-marked and committee-closed |
| `admin-dashboard.html` | `getDashboardMetrics` + `getLiveIssues('ALL')` | KPIs + charts + aging/SLA tables |
| `submitted-issues.html` | `getSubmittedIssues` (unions PENDING + LIVE + optional ARCHIVES) | Single table with Status filter; archives gated by `SUBMITTED_INCLUDE_REJECTED` |
| `submit-issue.html` | `getClientConfig` + `getCategoryMaster` | Intake form |

---

## 9. Ticket IDs

- Generated by `generateTicketID()` at **intake** (Form trigger + in-portal submit).
- Format: `TKT-00001`, `TKT-00002`, … (5-digit, zero-padded).
- Computed as `max(existing) + 1` across `PENDING_REVIEW`, `LIVE_ISSUES`,
  and `CLOSED_ISSUES`, recognising both `TKT-` and legacy `TA-` prefixes.
- The ticket id **does not change** on approval. `approveIssueWithTicketId`
  is a deprecated shim retained for any legacy clients — it ignores
  `newTicketId` and delegates to `approveIssue`.

---

## 10. SLA Rules

| Severity | Days |
|---|---|
| Critical | 1 |
| High | 3 |
| Medium | 7 |
| Low | 15 |

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

| Trigger | Schedule | Purpose |
|---|---|---|
| `onFormSubmit` | On form submit | Create ticket in `PENDING_REVIEW` |
| `clearConfigCache` *(optional)* | Hourly | Pick up CONFIG edits without manual run |

---

## 13. Deployment (mandatory settings)

| Setting | Value |
|---|---|
| Manifest | [appsscript.json](appsscript.json) (`USER_ACCESSING`, `ANYONE`) |
| Required scopes | `spreadsheets`, `userinfo.email`, `script.container.ui`, `script.send_mail`, `drive` (read + write for uploads) |
| Deploy as | Web app, *Execute as: User accessing the web app*, *Who has access: Anyone with a Google account* (secure deployment) plus a sibling public deployment (`USER_DEPLOYING` / `ANYONE_ANONYMOUS`) for intake — see §19.8 |

### 13.1 Apps Script setup runbook (one-time, in order)

All functions live in `src/Config.gs`. Run from the Apps Script editor → function dropdown → Run. All are idempotent.

| # | When | Function | What it does |
|---|---|---|---|
| 1 | Fresh deploy, or after pulling new `DEFAULT_FEATURES` / `DEFAULT_TUNABLES` | `setupConfigSheet` | Seeds the `CONFIG` tab. Preserves existing operator values; appends only missing keys with defaults. |
| — | _Optional_ — pre-seed `ATTACHMENT_FOLDER_ID` without waiting for the first upload | `setupAttachmentFolder` | Walks `My Drive / TA_HANDOVER / ISSUE_UPLOADS / TA Issue Reporting Portal / Upload Photos/Video` (tolerating ` (File responses)` suffix), persists the folder id in CONFIG, and forces public-view on the folder. **Not required** — `uploadSubmissionPhotos_` calls the same resolver lazily on first upload via `resolveAttachmentFolder_({ autoSetup: true, makePublic: true })`. |
| — | _Optional_ — bulk-publish files already inside the attachment folder (Form-uploaded, etc.) | `makeAttachmentFolderPublic` | Walks every file in the folder and re-applies *Anyone with link → Viewer*. New uploads after this build are made public automatically by `trySharePublic_` in the upload path. Falls back to `ANYONE` if domain policy blocks link sharing. |
| — | Anytime, to verify | `whereDoUploadsGo` | Read-only. Prints the configured folder's full path + URL. Does not change anything. |
| — | After editing CONFIG by hand | `clearConfigCache` | Forces the next call to re-read CONFIG (5-min cache otherwise). |

Full operator steps in [DEPLOYMENT_AUTH.md](DEPLOYMENT_AUTH.md) and the **Apps Script setup runbook** table in `README.md`.

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

| Tunable (CONFIG sheet) | Default | Effect |
|---|---|---|
| `SUBMITTED_INCLUDE_REJECTED` | `"false"` | When `"true"`, `getSubmittedIssues` also unions `ARCHIVES_ISSUES`. Read-only submitted view hides rejected rows by default. |
| `FEATURE_SHOW_SEVERITY_ON_SUBMITTED` | `"false"` | When `"true"`, severity column is visible on the submitted-issues page. |
| `FEATURE_COMMITTEE_PHOTO_ATTACH` | `"false"` | When `"true"`, committee detail view shows an **Upload Photo** button on issues without photos and the `addPhotosToIssue` API accepts writes. Default OFF — opt-in via the CONFIG sheet. |
| `FEATURE_PDF_REPORT` | `"false"` | When `"true"`, every list view (Committee / Builder / Submitted read-only) shows an **Export Report** button that opens a PDF wizard (sources, columns, embedded photos) and the `getReportPhotoB64` API accepts requests. Each view scopes its own column menu (Committee = full 16; Builder drops committee-only fields; Submitted read-only shows Ticket ID + Title + form-entry fields + Status only) — the column catalog and per-view defaults live in `src/partials/pdf-report.html` and each page's `openExportReport()`. Photos are always embedded inline under each section. Default OFF — opt-in via the CONFIG sheet. |
| `FEATURE_SLA` | `"false"` | When `"true"`, every list view (Committee / Builder / Admin) shows SLA breach KPI cards, the **SLA Days** column, the **SLA Breached** filter option, the **SLA Status / Due Date / Days Remaining** detail-modal block, and the PDF wizard exposes `slaDue` + `breached` columns. The `getLiveIssues` API still returns a `sla:{}` sub-object (with placeholder `dueDate:""`, `breached:false`, `daysRemaining:null` when off), and `getDashboardMetrics.slaBreaches` is forced to `0` when off so existing clients don't NPE. SLA due-date is still **computed and written** to `LIVE_ISSUES.SLA_DATE` at `approveIssue` time regardless of the flag, so flipping it on later "just works". The approve-modal severity labels also drop the `(SLA X day)` suffix and the helper note `SLA due date is computed…` when off. Default OFF — opt-in via the CONFIG sheet. |

Defaults live in `DEFAULT_TUNABLES` (`src/Config.gs`); CONFIG sheet values
override.

### 19.8 Two deployments — public vs secure

The app is published as two web-app deployments and CI keeps both in sync
via `clasp 3.3.0`:

| Deployment | `executeAs` | `access` | Purpose |
|---|---|---|---|
| Public  | `USER_DEPLOYING` | `ANYONE_ANONYMOUS` | Landing + intake form (no Google sign-in) |
| Secure  | `USER_ACCESSING` | `ANYONE` | All authenticated dashboards |

`signOut()` and "Back to Login" redirect to `PUBLIC_WEBAPP_URL`. Do not
merge these into a single deployment — the public one must not require
Google sign-in.

### 19.9 Status enum — only what the server actually writes

UI dropdowns, badge maps and fallback labels must list **only** the states
the server writes. Inventing extra states (e.g. `NEW`) causes filters to
show empty results and confuses users.

Canonical status set (single source of truth):

| Status | Set by | Lives on |
|---|---|---|
| `PENDING_APPROVAL` | form intake / `onFormSubmit` | `PENDING_REVIEW` |
| `REJECTED` | `rejectIssue` | `ARCHIVES_ISSUES` |
| `ASSIGNED` | `approveIssue` | `LIVE_ISSUES` |
| `IN_PROGRESS` | builder update | `LIVE_ISSUES` |
| `WORK_COMPLETED` | builder update | `LIVE_ISSUES` |
| `REOPENED` | `reopenIssue` | `LIVE_ISSUES` |
| `CLOSED` | `closeIssue` | `CLOSED_ISSUES` |

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

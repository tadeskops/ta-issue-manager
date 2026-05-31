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
| 2 | `PENDING_REVIEW` | Issues awaiting committee approval (also acts as the weekly-review snapshot) |
| 3 | `LIVE_ISSUES` | Approved, active issues (builder updates here) |
| 4 | `BUILDER_VIEW` | Spreadsheet-side formula view of `LIVE_ISSUES` for the builder — no code reader |
| 5 | `ARCHIVES_ISSUES` | Spreadsheet-side formula archive view — no code reader |
| 6 | `CLOSED_ISSUES` | Resolved, archived issues |
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

Cached 5 min in `CacheService`; `clearConfigCache()` forces refresh.

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
| `updateBuilderStatus` | ✅ | ✅ | — |
| `closeIssue` | ✅ | ✅ | — |
| `reopenIssue` | ✅ | ✅ | — |
| `deleteIssue` | ✅ | — | — |
| `generateTicketId` | ✅ | — | — |
| `approveIssueWithTicketId` _(deprecated shim → `approveIssue`)_ | ✅ | — | — |
| `getDashboardMetrics` | ✅ | ✅ | — |
| `syncFormResponses` | ✅ | — | — |
| `submitIssue` | ✅ | ✅ | ✅ |
| `getCategoryMaster` | ✅ | ✅ | ✅ |
| `getClientConfig` | ✅ | ✅ | ✅ |
| `validateUserAccess` | ✅ | ✅ | ✅ |

Response envelope: `{ success: boolean, data: any, error: string|null }`
(some legacy actions return `{ success, responses, count, error }` — the
client shim normalises both).

`api_whoAmI()` is a separate endpoint that returns `{ email, role }` for the
signed-in user (used by `API.whoAmI()` on page load).

---

## 8. Issue Lifecycle (state machine)

```
PENDING_APPROVAL  (intake — severity BLANK)
  ├─▶ APPROVED (committee assigns severity → SLA computed)  → LIVE_ISSUES
  └─▶ REJECTED (committee)  → row retained in PENDING_REVIEW for audit

LIVE_ISSUES:
  ASSIGNED → IN_PROGRESS → WORK_COMPLETED → CLOSED

CLOSED → REOPENED (committee) → LIVE_ISSUES (status = IN_PROGRESS)
```

> Severity & SLA are set **on approval**, not on intake. `approveIssue`
> requires `{ ticketId, severity }`; the server validates severity and
> computes `slaDate = calculateSLADate(severity, reportedDate)` before
> writing to `LIVE_ISSUES`.

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
| Required scopes | `spreadsheets`, `userinfo.email`, `script.container.ui`, `script.send_mail`, `drive.readonly` |
| One-time | Run `setupConfigSheet` to create the `CONFIG` tab |
| Deploy as | Web app, *Execute as: User accessing the web app*, *Who has access: Anyone with a Google account* |

Full steps in [DEPLOYMENT_AUTH.md](DEPLOYMENT_AUTH.md).

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

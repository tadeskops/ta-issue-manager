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

## Configuration

Every developer- / manager-tunable input lives in the **CONFIG** sheet:
identity (emails), assets (folder/logo), feature flags, numeric tunables.
See `src/Config.gs` (`DEFAULT_FEATURES`, `DEFAULT_TUNABLES`) for the full list.
Feature flags hide UI but leave internal helpers callable for dependent
modules.

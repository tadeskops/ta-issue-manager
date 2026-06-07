/**
 * ============================================================================
 *  CONFIG - Central runtime configuration (CONFIG sheet)
 * ============================================================================
 *  Single source of truth for every developer- or manager-tunable input.
 *  All values are read at runtime from the "CONFIG" tab of the bound
 *  spreadsheet and cached for `CONFIG_CACHE_TTL` seconds.
 *
 *  Three concern groups live in the same sheet:
 *    1. Identity / routing (committee emails, builder email)
 *    2. Asset locations    (attachment folder, logo url)
 *    3. Feature flags + numeric tunables (one row each, see DEFAULT_FEATURES
 *       and DEFAULT_TUNABLES below for the canonical list).
 *
 *  Feature-flag philosophy (per project requirement):
 *    - A feature flag set to FALSE hides the UI / blocks the public API,
 *      but the underlying helpers (createPendingIssue_, sheet writers,
 *      Form trigger, etc.) continue to work so dependent modules are
 *      never broken.
 *    - Numeric tunables (limits, sizes) flow to the client via
 *      `getClientConfig()` so the browser uses identical thresholds to
 *      the server validator.
 *
 *  FIRST-TIME SETUP:
 *      Run `setupConfigSheet` once from the Apps Script editor. It seeds
 *      every row below. Edit the sheet directly afterward; run
 *      `clearConfigCache()` to force a re-read.
 *
 *  PUBLIC GETTERS:
 *      getConfig()             // full config object
 *      getCommitteeEmails()
 *      getBuilderEmail()
 *      getUserRole(email)
 *      getAttachmentFolderId()
 *      getLogoUrl()
 *      getFeatureFlag(name)    // -> boolean
 *      getTunable(name)        // -> number | string
 *      getClientConfig()       // sanitized blob for the browser
 * ============================================================================
 */

// ----- Fallback defaults (used only if CONFIG sheet missing / row blank) -----
const DEFAULT_COMMITTEE_EMAILS = [
    "vibhumaitreya@gmail.com",
    "ta.deskops@gmail.com"
];
const DEFAULT_BUILDER_EMAIL = "vibhumaitreya@gmail.com";

// Feature flags: master switches for optional modules. UI is hidden when
// false; backend helpers remain callable from dependent modules.
const DEFAULT_FEATURES = {
    FEATURE_IN_PORTAL_SUBMIT:   true,  // submit-issue.html + submitIssue API
    FEATURE_PHOTO_UPLOAD:       true,  // photo field on submit page
    FEATURE_AUTOSAVE_DRAFT:     true,  // localStorage draft on submit page
    FEATURE_REJECTED_FILTER:    true,  // Rejected filter chip on committee dashboard
    FEATURE_BUILDER_DASHBOARD:  true,  // builder-dashboard page accessible
    FEATURE_ADMIN_DASHBOARD:    true,  // admin-dashboard page (analytics) accessible
    FEATURE_SUBMITTED_PAGE:     true,  // submitted-issues.html accessible
    FEATURE_OPEN_SHEET_LINK:    false, // "Open in Sheets" pill on the public submitted-issues page. OFF by default — opt-in (the link points at the underlying spreadsheet, anyone with the link can view it).
    FEATURE_SHOW_SEVERITY_ON_SUBMITTED: false,  // show severity badge/filter/sort on submitted-issues page
    FEATURE_COMMITTEE_PHOTO_ATTACH: false,  // committee "Upload Photo" button in detail view + addPhotosToIssue API. OFF by default — opt-in.
    FEATURE_PDF_REPORT:         true,   // Export Report wizard (committee/builder/submitted views) + getReportPhotoB64 API. ON by default.
    FEATURE_WEEKLY_REPORT_BACKUP: true,  // Weekly PDF committed to GitHub (TA_IAP_Full_Report.pdf with embedded photos) + cross-page "View Full Report" pill. ON by default; operator still needs GITHUB_TOKEN + an installed trigger for the cron itself to run.
    FEATURE_SLA:                false   // SLA KPIs, SLA Days column, BREACHED filter, and sla:{} sub-object on issue APIs. OFF by default — opt-in.
};

// Numeric / string tunables consumed by both server validators and the
// browser client (via getClientConfig).
const DEFAULT_TUNABLES = {
    SUBMIT_RATE_LIMIT_SECONDS: 20,         // min gap between submits per user
    SUBMIT_DAILY_LIMIT:        20,         // max submissions per user per UTC day
    SUBMIT_MAX_PHOTOS:         5,          // max photos per submission
    SUBMIT_MAX_PHOTO_MB:       5,          // max size per photo (decoded)
    SUBMIT_PHOTO_MAX_DIM:      1600,       // client-side resize target (px)
    SUBMIT_PHOTO_JPEG_QUALITY: 0.85,       // canvas.toDataURL quality
    SUBMIT_DESC_MIN:           5,          // description min length
    SUBMIT_DESC_MAX:           1000,       // description max length
    CONFIG_CACHE_TTL_SECONDS:  300,        // cache TTL (also informational)
    DEFAULT_THEME:             "light",     // high (original dark) | light | medium
    DEFAULT_FONT_SCALE:        "xl",        // md (16px) | lg (17.5px, ~+9%) | xl (19px, ~+19%) — applied to <html data-fontsize>; user can override via the on-page A/A/A switcher (persisted to localStorage)
    TECH_WEBAPP_URL:           "",           // separate deployment URL that requires Google sign-in (committee/builder). Empty = same URL.
    PUBLIC_WEBAPP_URL:         "",           // public (anonymous) deployment URL — used as the landing page after sign-out. Empty = current URL.
    SUBMITTED_INCLUDE_REJECTED: "false",     // read-only "Submitted Issues" view: include rejected (archived) rows. Default off → public sees only pending + live.
    WEEKLY_REPORT_PUBLIC_URL:  "",           // Raw URL to TA_IAP_Report.pdf (anonymised, pending+active only). When non-empty AND FEATURE_WEEKLY_REPORT_BACKUP is on, the login page shows a small "View Report" link beside the read-only button. Recommended: https://raw.githubusercontent.com/tadeskops/ta-issue-manager/main/backups/TA_IAP_Report.pdf
    FULL_REPORT_PUBLIC_URL:    ""            // Raw URL to TA_IAP_Full_Report.pdf (full content incl. closed+rejected). When non-empty AND FEATURE_WEEKLY_REPORT_BACKUP is on, dashboard pages show a small "View Full Report" icon. Distribute the URL only to authorised personnel — the file contains resident names and flat numbers. Recommended: https://raw.githubusercontent.com/tadeskops/ta-issue-manager/main/backups/TA_IAP_Full_Report.pdf
};

// ----- Internal constants -----
const CONFIG_SHEET_NAME = "CONFIG";
const CONFIG_CACHE_KEY  = "IRP_CONFIG_V2";
const CONFIG_CACHE_TTL  = 300; // seconds (5 min)

/**
 * Returns the full config object. Cached.
 *   { committeeEmails, builderEmail, attachmentFolderId, logoUrl,
 *     features: {...}, tunables: {...} }
 */
function getConfig() {
    try {
        const cache = CacheService.getScriptCache();
        const cached = cache.get(CONFIG_CACHE_KEY);
        if (cached) return JSON.parse(cached);

        const cfg = readConfigFromSheet_();
        cache.put(CONFIG_CACHE_KEY, JSON.stringify(cfg), CONFIG_CACHE_TTL);
        return cfg;
    } catch (e) {
        Logger.log("getConfig() fallback to defaults: " + e);
        return fallbackConfig_();
    }
}

function fallbackConfig_() {
    return {
        committeeEmails: DEFAULT_COMMITTEE_EMAILS.slice(),
        builderEmail: DEFAULT_BUILDER_EMAIL,
        attachmentFolderId: "",
        logoUrl: "",
        features: Object.assign({}, DEFAULT_FEATURES),
        tunables: Object.assign({}, DEFAULT_TUNABLES)
    };
}

function getCommitteeEmails()  { return getConfig().committeeEmails; }
function getBuilderEmail()     { return getConfig().builderEmail; }
function getAttachmentFolderId() { return getConfig().attachmentFolderId || ""; }
function getLogoUrl()          { return getConfig().logoUrl || ""; }

/**
 * Returns boolean for a feature flag. Unknown names default to TRUE so a
 * forgotten/misspelled key never silently disables a working module.
 */
function getFeatureFlag(name) {
    const f = getConfig().features || {};
    if (Object.prototype.hasOwnProperty.call(f, name)) return !!f[name];
    if (Object.prototype.hasOwnProperty.call(DEFAULT_FEATURES, name)) return !!DEFAULT_FEATURES[name];
    return true;
}

/**
 * Returns the tunable value (number or string). Falls back to DEFAULT_TUNABLES.
 */
function getTunable(name) {
    const t = getConfig().tunables || {};
    if (Object.prototype.hasOwnProperty.call(t, name)) return t[name];
    return DEFAULT_TUNABLES[name];
}

/**
 * Sanitized config blob served to the browser. Never includes emails or
 * folder ids — only feature flags and numeric tunables the UI needs.
 */
function getClientConfig() {
    try {
        const cfg = getConfig();
        const features = Object.assign({}, DEFAULT_FEATURES, cfg.features || {});
        const tunables = Object.assign({}, DEFAULT_TUNABLES, cfg.tunables || {});
        // Auto-derive the two report URLs from the GitHub backup config
        // when the operator hasn't set them explicitly. The PDFs land at
        // a known path inside the backup repo, so a default raw URL is
        // safe — operators can still override per-tunable to point at a
        // different mirror or a CDN. Always filled in (independent of
        // FEATURE_WEEKLY_REPORT_BACKUP) so the View Full Report pill
        // works even on pages that don't gate by the flag — the link
        // resolves to whatever the cron last committed.
        try {
            const bp = backup_props_();
            const dir = (bp.dir || "backups").replace(/^\/+|\/+$/g, "");
            const base = "https://raw.githubusercontent.com/" + bp.repo + "/" + bp.branch + "/" + dir + "/";
            if (!tunables.WEEKLY_REPORT_PUBLIC_URL) tunables.WEEKLY_REPORT_PUBLIC_URL = base + "TA_IAP_Report.pdf";
            if (!tunables.FULL_REPORT_PUBLIC_URL)   tunables.FULL_REPORT_PUBLIC_URL   = base + "TA_IAP_Full_Report.pdf";
        } catch (e) { /* non-fatal — tunables stay empty, buttons stay hidden */ }
        return {
            success: true,
            data: {
                features: features,
                tunables: tunables,
                logoUrl:  cfg.logoUrl || "",
                attachmentFolderUrl: cfg.attachmentFolderId
                    ? "https://drive.google.com/drive/folders/" + cfg.attachmentFolderId
                    : ""
            },
            error: null
        };
    } catch (e) {
        return { success: false, data: null, error: e.toString() };
    }
}

/**
 * Returns the role for a given email: COMMITTEE | BUILDER | RESIDENT | UNKNOWN.
 */
function getUserRole(email) {
    if (!email) return "UNKNOWN";
    const normalized = String(email).trim().toLowerCase();
    const cfg = getConfig();
    const committee = cfg.committeeEmails.map(e => String(e).trim().toLowerCase());
    if (committee.indexOf(normalized) !== -1) return "COMMITTEE";
    if (normalized === String(cfg.builderEmail).trim().toLowerCase()) return "BUILDER";
    return "RESIDENT";
}

/**
 * Clears the cached config so the next call re-reads from the CONFIG sheet.
 */
function clearConfigCache() {
    CacheService.getScriptCache().remove(CONFIG_CACHE_KEY);
    Logger.log("Config cache cleared.");
}

/**
 * Creates / repopulates the CONFIG sheet with every row this project
 * understands. Safe to re-run — existing values for known keys are
 * preserved; only missing keys are appended with their defaults.
 */
function setupConfigSheet() {
    const ss = getSpreadsheet();
    let sheet = ss.getSheetByName(CONFIG_SHEET_NAME);
    const isNew = !sheet;
    if (isNew) sheet = ss.insertSheet(CONFIG_SHEET_NAME);

    // Read existing values (if any) so we don't clobber operator edits.
    const existing = {};
    if (!isNew) {
        const v = sheet.getDataRange().getValues();
        for (let i = 1; i < v.length; i++) {
            const k = String(v[i][0] || "").trim().toUpperCase();
            if (k) existing[k] = v[i][1];
        }
    }

    // Master row list (Key, DefaultValue, Notes).
    const ROWS = [
        ["COMMITTEE_EMAILS", DEFAULT_COMMITTEE_EMAILS.join(", "),
            "Comma-separated list of Technical Committee emails"],
        ["BUILDER_EMAIL", DEFAULT_BUILDER_EMAIL,
            "Single builder / contractor email"],
        ["LOGO_URL", "",
            "Optional. Publicly shared image URL for the dashboard logo. Blank = bundled asset."],
        ["ATTACHMENT_FOLDER_ID", "",
            "Drive folder ID for in-portal photo uploads. Blank = portal uploads disabled."]
    ];

    // Feature flags
    Object.keys(DEFAULT_FEATURES).forEach(k => {
        ROWS.push([k, String(DEFAULT_FEATURES[k]),
            "Feature flag (true/false). Disables UI; internal helpers remain available."]);
    });

    // Tunables
    Object.keys(DEFAULT_TUNABLES).forEach(k => {
        ROWS.push([k, String(DEFAULT_TUNABLES[k]),
            "Numeric tunable. Applied to both server validators and the browser client."]);
    });

    sheet.clear();
    const header = [["Key", "Value", "Notes"]];
    const filled = ROWS.map(r => {
        const k = r[0];
        const v = Object.prototype.hasOwnProperty.call(existing, k) && existing[k] !== "" && existing[k] != null
            ? existing[k]
            : r[1];
        return [k, v, r[2]];
    });
    sheet.getRange(1, 1, header.length + filled.length, 3).setValues(header.concat(filled));
    sheet.getRange(1, 1, 1, 3).setFontWeight("bold");
    sheet.setColumnWidth(1, 240);
    sheet.setColumnWidth(2, 380);
    sheet.setColumnWidth(3, 460);
    sheet.setFrozenRows(1);

    clearConfigCache();
    Logger.log("CONFIG sheet ready (" + filled.length + " keys).");
}

// ----- Internal: read CONFIG sheet -----
function readConfigFromSheet_() {
    const result = fallbackConfig_();
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName(CONFIG_SHEET_NAME);
    if (!sheet) return result; // pure defaults

    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
        const key = String(values[i][0] || "").trim().toUpperCase();
        const rawVal = values[i][1];
        const val = rawVal === null || rawVal === undefined ? "" : String(rawVal).trim();
        if (!key) continue;

        if (key === "COMMITTEE_EMAILS") {
            if (!val) continue;
            const list = val.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
            if (list.length) result.committeeEmails = list;
        } else if (key === "BUILDER_EMAIL") {
            if (val) result.builderEmail = val;
        } else if (key === "ATTACHMENT_FOLDER_ID") {
            result.attachmentFolderId = val;
        } else if (key === "LOGO_URL") {
            result.logoUrl = val;
        } else if (Object.prototype.hasOwnProperty.call(DEFAULT_FEATURES, key)) {
            result.features[key] = parseBool_(val, DEFAULT_FEATURES[key]);
        } else if (Object.prototype.hasOwnProperty.call(DEFAULT_TUNABLES, key)) {
            const def = DEFAULT_TUNABLES[key];
            if (typeof def === "number") {
                const n = Number(val);
                result.tunables[key] = (val !== "" && !isNaN(n)) ? n : def;
            } else {
                result.tunables[key] = val !== "" ? val : def;
            }
        }
        // Unknown keys are silently ignored — operators can add notes safely.
    }
    return result;
}

function parseBool_(val, fallback) {
    if (val === true || val === false) return val;
    const s = String(val).trim().toLowerCase();
    if (["true", "yes", "1", "on", "enabled"].indexOf(s) !== -1)  return true;
    if (["false", "no", "0", "off", "disabled"].indexOf(s) !== -1) return false;
    return !!fallback;
}

/**
 * One-shot setup helper for in-portal photo uploads.
 *
 * Resolves the canonical attachment path
 *     My Drive / TA_HANDOVER / ISSUE_UPLOADS
 *               / TA Issue Reporting Portal (File responses)
 *               / Upload Photos/Video (File responses)
 * and writes its folder id into the CONFIG sheet row ATTACHMENT_FOLDER_ID.
 *
 * The two "(File responses)" suffixes are auto-generated by Google Forms
 * and may render slightly differently in the UI (trailing space, missing
 * suffix on rename, etc.), so the lookup matches the leading folder name
 * case-insensitively and tolerates the suffix being absent.
 *
 * Safe to re-run; idempotent. **NOT required** for normal operation —
 * `uploadSubmissionPhotos_` calls `resolveAttachmentFolder_({ autoSetup:
 * true })` lazily on the first upload and persists the result. Operators
 * only need this function if they want to pre-seed the value or
 * re-resolve after moving the folder in Drive.
 */
function setupAttachmentFolder() {
    const r = resolveAttachmentFolder_({ autoSetup: true, makePublic: true, verbose: true });
    Logger.log("Attachment folder set:");
    Logger.log("  Path:     " + r.path);
    Logger.log("  Folder:   " + r.folder.getName());
    Logger.log("  ID:       " + r.folderId);
    Logger.log("  URL:      " + r.url);
    return { path: r.path, folderId: r.folderId, url: r.url };
}

// Default canonical Drive path for in-portal photo uploads. Override by
// editing this array if your folder layout changes.
const ATTACHMENT_FOLDER_PATH = [
    "TA_HANDOVER",
    "ISSUE_UPLOADS",
    "TA Issue Reporting Portal",        // suffix "(File responses)" tolerated
    "Upload Photos/Video"               // suffix "(File responses)" tolerated
];

/**
 * Returns the attachment folder, auto-resolving and persisting the id on
 * first use so operators don't have to run a separate setup function.
 *
 * Resolution order:
 *   1. If `ATTACHMENT_FOLDER_ID` row in CONFIG is set AND opens cleanly,
 *      return that folder.
 *   2. Otherwise (blank / opens-fails), if `opts.autoSetup` is truthy,
 *      walk `ATTACHMENT_FOLDER_PATH` from My Drive root, persist the
 *      resolved id back into CONFIG, and return the folder. The walk
 *      tolerates the Google-Forms "(File responses)" suffix.
 *   3. If `opts.makePublic` is truthy, force the resolved folder to
 *      "Anyone with link → Viewer" so web-app visitors can render the
 *      uploaded images. Falls back to ANYONE; logs on policy block.
 *
 * Throws a clear error if the path cannot be resolved (e.g. the script
 * account does not have access to the Form's File-responses folder).
 *
 * Caches the resolution in ScriptProperties for ~5 min to avoid the
 * Drive walk on every upload in a burst.
 */
function resolveAttachmentFolder_(opts) {
    opts = opts || {};
    const cache = CacheService.getScriptCache();
    const CACHE_KEY = "IRP_RESOLVED_ATTACHMENT_FOLDER";

    // 1. Try the configured id first.
    const configuredId = getAttachmentFolderId();
    if (configuredId) {
        try {
            const f = DriveApp.getFolderById(configuredId);
            if (opts.makePublic) trySharePublic_(f, "folder " + f.getName());
            return _wrapFolder_(f, configuredId);
        } catch (e) {
            Logger.log("Configured ATTACHMENT_FOLDER_ID (" + configuredId + ") could not be opened: " + e);
            // fall through to autoSetup
        }
    }

    if (!opts.autoSetup) {
        throw new Error("ATTACHMENT_FOLDER_ID not set in CONFIG sheet");
    }

    // 2. Cached resolution from a previous walk in the last few minutes.
    try {
        const hit = cache.get(CACHE_KEY);
        if (hit) {
            const cached = JSON.parse(hit);
            if (cached && cached.id) {
                try {
                    const f = DriveApp.getFolderById(cached.id);
                    return _wrapFolder_(f, cached.id);
                } catch (e2) { /* cache stale — fall through and re-walk */ }
            }
        }
    } catch (e3) { /* cache miss is fine */ }

    // 3. Walk the canonical path.
    if (opts.verbose) Logger.log("Auto-resolving attachment folder by path...");
    let cur = DriveApp.getRootFolder();
    const trail = ["My Drive"];
    for (let i = 0; i < ATTACHMENT_FOLDER_PATH.length; i++) {
        const seg = ATTACHMENT_FOLDER_PATH[i];
        const next = _findChildFolder_(cur, seg);
        if (!next) {
            throw new Error(
                "Cannot auto-resolve attachment folder. Missing: " +
                trail.join(" / ") + " / " + seg + ". " +
                "Either create the folder, share it with the script's effective " +
                "account, or set ATTACHMENT_FOLDER_ID in the CONFIG sheet manually."
            );
        }
        cur = next;
        trail.push(cur.getName());
    }

    const folderId = cur.getId();

    // 4. Persist into CONFIG so future calls skip the walk entirely.
    try {
        const ss = getSpreadsheet();
        const sheet = ss.getSheetByName(CONFIG_SHEET_NAME);
        if (sheet) {
            const values = sheet.getDataRange().getValues();
            let rowIdx = -1;
            for (let i = 1; i < values.length; i++) {
                if (String(values[i][0] || "").trim().toUpperCase() === "ATTACHMENT_FOLDER_ID") {
                    rowIdx = i; break;
                }
            }
            if (rowIdx === -1) {
                sheet.appendRow(["ATTACHMENT_FOLDER_ID", folderId,
                    "Drive folder ID for in-portal photo uploads (auto-resolved on first upload)."]);
            } else {
                sheet.getRange(rowIdx + 1, 2).setValue(folderId);
            }
            clearConfigCache();
        } else {
            Logger.log("CONFIG sheet missing — could not persist auto-resolved folder id. Run setupConfigSheet().");
        }
    } catch (e4) {
        Logger.log("Could not persist ATTACHMENT_FOLDER_ID to CONFIG: " + e4);
        // Non-fatal: still return the folder so the upload succeeds.
    }

    try { cache.put(CACHE_KEY, JSON.stringify({ id: folderId }), 300); } catch (e5) { /* noop */ }

    if (opts.makePublic) trySharePublic_(cur, "folder " + cur.getName());

    const wrapped = _wrapFolder_(cur, folderId);
    wrapped.path = trail.join(" / ");
    return wrapped;
}

function _findChildFolder_(parent, wantedName) {
    const want = String(wantedName).toLowerCase();
    const it = parent.getFolders();
    const candidates = [];
    while (it.hasNext()) {
        const f = it.next();
        const n = f.getName().toLowerCase();
        if (n === want) return f;
        if (n.indexOf(want) === 0) candidates.push(f); // tolerates " (File responses)" suffix
    }
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
        throw new Error("Ambiguous folder under '" + parent.getName() +
            "': " + candidates.map(c => c.getName()).join(" | "));
    }
    return null;
}

function _wrapFolder_(folder, id) {
    return {
        folder: folder,
        folderId: id,
        url: folder.getUrl(),
        path: ""    // populated by walker; "" when returned from configured-id branch
    };
}

// Force "Anyone with the link → Viewer" sharing, falling back to ANYONE
// when domain policy blocks link sharing. Used by upload paths and the
// makeAttachmentFolderPublic helper. Never throws — failures are logged.
function trySharePublic_(node, label) {
    try {
        node.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        return "ANYONE_WITH_LINK";
    } catch (e1) {
        try {
            node.setSharing(DriveApp.Access.ANYONE, DriveApp.Permission.VIEW);
            return "ANYONE";
        } catch (e2) {
            Logger.log("trySharePublic_ failed for " + (label || "node") + ": " + e2);
            return "FAILED";
        }
    }
}

/**
 * Read-only diagnostic: prints (and returns) the currently configured
 * attachment folder's full path. Use this to confirm where new committee
 * uploads will land without changing anything.
 */
function whereDoUploadsGo() {
    const id = getAttachmentFolderId();
    if (!id) {
        Logger.log("ATTACHMENT_FOLDER_ID is BLANK — uploads will fail. Run setupAttachmentFolder().");
        return { configured: false };
    }
    let f;
    try { f = DriveApp.getFolderById(id); }
    catch (e) {
        Logger.log("Cannot open folder " + id + ": " + e);
        return { configured: true, accessible: false, folderId: id, error: String(e) };
    }
    const parts = [f.getName()];
    let p = f.getParents();
    while (p.hasNext()) { const par = p.next(); parts.unshift(par.getName()); p = par.getParents(); }
    parts.unshift("My Drive");
    const path = parts.join(" / ");
    Logger.log("Attachment folder: " + path);
    Logger.log("URL:               " + f.getUrl());
    return { configured: true, accessible: true, folderId: id, path: path, url: f.getUrl() };
}

/**
 * One-shot Drive permission hardening:
 *   1. Sets the configured ATTACHMENT_FOLDER_ID folder to
 *      "Anyone with the link – Viewer" so new uploads inherit access.
 *   2. Walks every file currently in that folder and forces the same
 *      sharing, so legacy uploads (and Google-Forms-managed files) also
 *      render inside the web app's <img> tags for any visitor.
 *
 * Run once from the Apps Script editor after setupAttachmentFolder().
 * Re-run is idempotent and safe. Stops on any non-permission error so
 * partial folders are reported in the log.
 *
 * NOTE: If your Google Workspace admin blocks ANYONE_WITH_LINK, this
 * helper falls back to DriveApp.Access.ANYONE (search-indexable). If
 * that is also blocked, the file is left untouched and a warning is
 * logged — you must adjust the domain sharing policy.
 */
function makeAttachmentFolderPublic() {
    // Auto-resolve if needed (no setupAttachmentFolder prerequisite).
    const r = resolveAttachmentFolder_({ autoSetup: true, makePublic: true });
    const folder = r.folder;
    const id = r.folderId;

    Logger.log("Folder: " + folder.getName() + " (" + id + ")");

    let fileCount = 0, sharedCount = 0;
    const files = folder.getFiles();
    while (files.hasNext()) {
        const f = files.next();
        fileCount++;
        const result = trySharePublic_(f, f.getName());
        if (result !== "FAILED") sharedCount++;
    }
    Logger.log("Files processed: " + sharedCount + " of " + fileCount + " set to public-view.");
    return { folderId: id, filesProcessed: fileCount, filesShared: sharedCount };
}

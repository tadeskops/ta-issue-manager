// ===== CONFIG (Update these values) =====
// NOTE: COMMITTEE_EMAILS and BUILDER_EMAIL are now defined in `config.gs`.
//       Update committee / builder email IDs there.
//
// SHEET_ID resolution order:
//   1. ScriptProperties key "SHEET_ID" — lets a fork/staging deployment point at
//      a different spreadsheet without editing source (Extensions > Apps Script
//      > Project Settings > Script Properties).
//   2. Hardcoded literal below — the canonical production spreadsheet.
// The constant is resolved once at script load; changes to ScriptProperties
// take effect on the next execution.
const SHEET_ID = (function () {
    try {
        var p = PropertiesService.getScriptProperties().getProperty("SHEET_ID");
        if (p && String(p).trim()) return String(p).trim();
    } catch (e) { /* fall through to literal */ }
    return "1dvLsUyog-6Rbv22WBQWClwZkabNBVYqF4ChNL1LL_vU"; // Get from Sheets URL
})();
const SHEETS = {
    FORM_RESPONSES:  "Form Responses 1",
    PENDING_REVIEW:  "PENDING_REVIEW",
    LIVE_ISSUES:     "LIVE_ISSUES",
    CLOSED_ISSUES:   "CLOSED_ISSUES",
    CATEGORY_MASTER: "CATEGORY_MASTER",
    DASHBOARD:       "DASHBOARD",
    // Spreadsheet-side views maintained by formula; no code reader yet.
    BUILDER_VIEW:    "BUILDER_VIEW",
    ARCHIVES_ISSUES: "ARCHIVES_ISSUES"
};

const SLA_RULES = {
    "Critical": 1,
    "High": 3,
    "Medium": 7,
    "Low": 15
};

const ALLOWED_STATUSES = [
    "PENDING_APPROVAL", "APPROVED", "ASSIGNED",
    "IN_PROGRESS", "WORK_COMPLETED", "CLOSED", "REOPENED", "REJECTED"
];

// ===== CANONICAL SHEET SCHEMAS =====
// These constants are the single source of truth for which column holds
// which field. They mirror the actual layout of the bound Google Sheet
// (see the *.csv exports in repo for evidence). All read/write code MUST
// use these constants instead of magic numbers.

// Form Responses 1 (auto-created by Google Forms; 9 columns).
const FORM_COL = {
    TIMESTAMP:    0,
    RESIDENT:     1,
    FLAT:         2,
    CATEGORY:     3,
    SUBCATEGORY:  4,
    SEVERITY:     5,
    TOWER:        6,
    LOCATION:     7,  // "Exact Location/Comment"
    PHOTO:        8
};

// PENDING_REVIEW (17 columns).
const PENDING_COL = {
    TICKET_ID:        0,
    DATE_REPORTED:    1,
    RESIDENT:         2,
    FLAT:             3,
    CATEGORY:         4,
    SUBCATEGORY:      5,
    SEVERITY:         6,
    TOWER:            7,
    PHOTO:            8,
    DESCRIPTION:      9,   // free-text location/details
    SUBMITTED_BY:    10,   // approver / sync operator (optional)
    ACTION_DATE:     11,   // approve/reject timestamp
    ACTION_BY:       12,   // approve/reject by email
    REJECTION_REASON:13,
    RESERVED1:       14,
    RESERVED2:       15,
    STATE:           16    // PENDING_APPROVAL | APPROVED | REJECTED
};
const PENDING_WIDTH = 17;

// LIVE_ISSUES (20 columns; mirrors the live spreadsheet header row).
const LIVE_COL = {
    TICKET_ID:        0,   // Ticket ID
    DATE_REPORTED:    1,   // Date Reported
    TOWER:            2,   // Found at Tower
    FLAT:             3,   // Flat No
    RESIDENT:         4,   // Resident Name
    PHONE:            5,   // Phone
    CATEGORY:         6,   // Category
    SUBCATEGORY:      7,   // Subcategory
    SEVERITY:         8,   // Severity
    LOCATION:         9,   // Exact Location
    DESCRIPTION:     10,   // Description
    PHOTO:           11,   // Photo Link
    ASSIGNED_VENDOR: 12,   // Assigned To
    STATUS:          13,   // Status (single status column on this sheet)
    BUILDER_STATUS:  13,   //   alias of STATUS — sheet has only one
    DATE_ASSIGNED:   14,   // Date Assigned
    SLA_DATE:        15,   // Target Closure
    CLOSURE_DATE:    16,   // Closure Date
    RESIDENT_CONFIRM:17,   // Resident Confirmation
    REOPENED_FLAG:   18,   // Reopened
    REMARKS:         19,   // Remarks
    BUILDER_COMMENT: 19    //   alias of REMARKS
};
const LIVE_WIDTH = 20;

// Build a row array of given width filled with empty strings.
function newRow_(width) { return new Array(width).fill(""); }

// Split a photo cell into an array of URLs. The form & in-portal submit
// both store multiple Drive links as a comma+space separated string in a
// single cell; callers want an array. Each URL is normalized to a form
// that renders inside an <img> tag (Drive's /file/d/<id>/view URL does
// not — it's an HTML viewer page, not the image bytes).
function splitPhotoLinks_(cell) {
    if (!cell) return [];
    const raw = Array.isArray(cell)
        ? cell.filter(Boolean)
        : String(cell).split(/[,\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    return raw.map(driveImageUrl_);
}

// Convert a Drive URL (in any of the common formats) to a public,
// img-tag-embeddable URL. Non-Drive URLs are returned unchanged so the
// helper is safe to apply blindly.
//   Inputs we handle:
//     https://drive.google.com/file/d/<ID>/view?usp=...
//     https://drive.google.com/open?id=<ID>
//     https://drive.google.com/uc?id=<ID>&export=...
//     https://drive.google.com/thumbnail?id=<ID>&sz=...
//     https://docs.google.com/uc?id=<ID>
//   Output:
//     https://drive.google.com/thumbnail?id=<ID>&sz=w2000
//   The /thumbnail endpoint streams JPEG bytes (works in <img>), honors
//   "Anyone with link" sharing, and avoids the redirect chain that the
//   /uc?export=view endpoint sometimes triggers inside the Apps Script
//   iframe.
function driveImageUrl_(url) {
    if (!url) return "";
    const s = String(url);
    if (s.indexOf("drive.google.com") === -1 && s.indexOf("docs.google.com") === -1) return s;
    let id = "";
    let m = s.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/);
    if (m) id = m[1];
    if (!id) { m = s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);  if (m) id = m[1]; }
    if (!id) { m = s.match(/\/d\/([A-Za-z0-9_-]{10,})/);     if (m) id = m[1]; }
    if (!id) return s;
    return "https://drive.google.com/thumbnail?id=" + id + "&sz=w2000";
}

// Extract a Drive file id from any of the URL shapes we accept.
// Returns "" if no id can be found. Used by report photo embedder.
function driveFileIdFromUrl_(url) {
    if (!url) return "";
    const s = String(url);
    let m = s.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/);                 if (m) return m[1];
    m     = s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);                     if (m) return m[1];
    m     = s.match(/\/d\/([A-Za-z0-9_-]{10,})/);                       if (m) return m[1];
    m     = s.match(/^([A-Za-z0-9_-]{20,})$/);                          if (m) return m[1];
    return "";
}

// Server-side fetch a Drive image (by file id or any drive URL) and
// return it as base64 so the client can embed it in a jsPDF report
// without hitting CORS or redirect-chain issues that the Drive thumbnail
// endpoint sometimes hits inside the HtmlService iframe.
//
// Returns: { success, data: { mimeType, b64, sourceId }, error }.
//
// Gated by FEATURE_PDF_REPORT (the only consumer is the Export Report
// wizard) AND FEATURE_PHOTO_UPLOAD (global photo kill-switch).
function getReportPhotoB64(fileIdOrUrl, maxW) {
    try {
        if (!getFeatureFlag("FEATURE_PDF_REPORT")) {
            return { success: false, data: null, error: "PDF report is disabled. Enable FEATURE_PDF_REPORT in CONFIG." };
        }
        if (!getFeatureFlag("FEATURE_PHOTO_UPLOAD")) {
            return { success: false, data: null, error: "Photo upload is currently disabled." };
        }
        const id = driveFileIdFromUrl_(fileIdOrUrl);
        if (!id) return { success: false, data: null, error: "Unable to extract Drive file id" };
        // Cap the requested thumbnail width so we don't pull multi-MB
        // originals over the wire for a 60 mm PDF cell.
        const w = (typeof maxW === "number" && maxW > 0 && maxW <= 4000) ? Math.floor(maxW) : 1200;
        const url = "https://drive.google.com/thumbnail?id=" + id + "&sz=w" + w;
        const resp = UrlFetchApp.fetch(url, {
            muteHttpExceptions: true,
            followRedirects:    true,
            headers: { "Authorization": "Bearer " + ScriptApp.getOAuthToken() }
        });
        const code = resp.getResponseCode();
        if (code < 200 || code >= 300) {
            return { success: false, data: null, error: "Drive fetch returned HTTP " + code };
        }
        const blob = resp.getBlob();
        const mime = blob.getContentType() || "image/jpeg";
        const b64  = Utilities.base64Encode(blob.getBytes());
        return { success: true, data: { mimeType: mime, b64: b64, sourceId: id }, error: null };
    } catch (err) {
        return { success: false, data: null, error: err && err.message ? err.message : String(err) };
    }
}

// google.script.run silently delivers `null` to the client success
// handler when the response contains any value it cannot serialize —
// most notably an Invalid Date (a Date whose time is NaN, which sheets
// emit for empty date-formatted cells). Coerce values to JSON-safe
// primitives before returning them.
function safeStr_(v) {
    if (v === null || v === undefined) return "";
    if (v instanceof Date) {
        var t = v.getTime();
        return isNaN(t) ? "" : v.toISOString();
    }
    return String(v);
}
function safeDateIso_(v) {
    if (v === null || v === undefined || v === "") return "";
    if (v instanceof Date) {
        var t = v.getTime();
        return isNaN(t) ? "" : v.toISOString();
    }
    // Sometimes the cell is a number (serial) or string ISO — coerce.
    var d = new Date(v);
    var t2 = d.getTime();
    return isNaN(t2) ? String(v) : d.toISOString();
}

// Some sheets (notably PENDING_REVIEW and ARCHIVES_ISSUES) were created
// without a labeled header row, so getDataRange() returns a real ticket
// row at index 0 that loops would otherwise silently skip. Detect that
// case so iteration can start at the right offset without mutating the
// sheet.
function firstDataRow_(data) {
    if (!data || !data.length) return 1;
    var c0 = data[0][0];
    var s  = (c0 === null || c0 === undefined) ? "" : String(c0).trim();
    if (!s) return 1;
    // Looks like a ticket id (TKT-00001, TA-0001, etc.) -> no header row.
    if (/^[A-Z]{2,4}-\d+/i.test(s)) return 0;
    return 1;
}
// ===== END CONFIG =====

// Get Spreadsheet with error handling
function getSpreadsheet() {
    try {
        return SpreadsheetApp.openById(SHEET_ID);
    } catch (error) {
        Logger.log("Error opening spreadsheet: " + error.toString());
        // Build a caller-friendly diagnostic. The secure deployment runs
        // as USER_ACCESSING, so this call uses the SIGNED-IN user's Drive
        // credentials — if their email is not shared on the source sheet,
        // openById throws. Include the caller's email + the actionable
        // fix so the operator can self-diagnose from the toast instead
        // of seeing an opaque sheet id.
        var callerEmail = "";
        try { callerEmail = (Session.getActiveUser().getEmail() || "").trim(); }
        catch (_e) { /* identity lookup can fail on anonymous sessions */ }
        var msg = "Cannot open the issues spreadsheet (id " + SHEET_ID + ") as "
                + (callerEmail ? callerEmail : "the current user")
                + ". Your Google account may not have Drive access to the sheet. "
                + "Ask the admin to run syncRoleAccessNow() (or share the sheet "
                + "with your email as Viewer). Underlying error: " + error;
        throw new Error(msg);
    }
}

// Get Sheet with enhanced error handling
function getSheet(sheetName) {
    try {
        const ss = getSpreadsheet();
        const sheet = ss.getSheetByName(sheetName);
        if (!sheet) {
            const allSheets = ss.getSheets().map(s => s.getName());
            throw new Error(`Sheet "${sheetName}" not found. Available sheets: ${allSheets.join(", ")}`);
        }
        return sheet;
    } catch (error) {
        Logger.log("Error getting sheet: " + error.toString());
        throw error;
    }
}

// TEST FUNCTION - Run this to debug connection
function testConnection() {
  try {
    Logger.log("🔍 Testing spreadsheet connection...");
    const ss = getSpreadsheet();
    const allSheets = ss.getSheets().map(s => s.getName());
    
    Logger.log("✅ Connected to spreadsheet: " + ss.getName());
    Logger.log("📋 Available sheets: " + JSON.stringify(allSheets));
    
    const formSheet = ss.getSheetByName("Form Responses 1");
    if (formSheet) {
      const data = formSheet.getDataRange().getValues();
      Logger.log("✅ 'Form Responses 1' sheet found with " + data.length + " rows");
      Logger.log("📊 Headers: " + JSON.stringify(data[0]));
      if (data.length > 1) {
        Logger.log("📌 First data row: " + JSON.stringify(data[1]));
      }
    } else {
      Logger.log("❌ 'Form Responses 1' sheet NOT found. Check sheet name spelling!");
    }
  } catch (e) {
    Logger.log("❌ Connection Error: " + e.toString());
  }
}

// Generate Ticket ID (TKT-XXXXX). Uses a ScriptProperties counter as
// the authoritative source so two concurrent intakes can never mint the
// same id (LockService alone is not enough — see #45). On every call we
// also scan PENDING_REVIEW + LIVE_ISSUES + CLOSED_ISSUES and lift the
// counter to max(counter, scannedMax) so a manual sheet edit (paste,
// delete-row, re-import) can never produce a collision either. The
// PENDING_REVIEW sheet is the primary source per the spec — that's
// where every new intake lands first — but we cross-check the other
// two so historic numbering is honoured. Recognises the legacy `TA-`
// prefix when computing max.
const TICKET_COUNTER_PROP = "TICKET_COUNTER";

function generateTicketID() {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
        const ss = getSpreadsheet();
        const sheets = [
            ss.getSheetByName(SHEETS.PENDING_REVIEW),
            ss.getSheetByName(SHEETS.LIVE_ISSUES),
            ss.getSheetByName(SHEETS.CLOSED_ISSUES)
        ];
        let scannedMax = 0;
        for (let s = 0; s < sheets.length; s++) {
            const sheet = sheets[s];
            if (!sheet) continue;
            const data = sheet.getDataRange().getValues();
            for (let i = 1; i < data.length; i++) {
                const raw = data[i][0];
                if (!raw) continue;
                const id = String(raw).trim();
                let num = 0;
                if (id.indexOf("TKT-") === 0)      num = parseInt(id.substring(4), 10);
                else if (id.indexOf("TA-") === 0)  num = parseInt(id.substring(3), 10);
                if (!isNaN(num) && num > scannedMax) scannedMax = num;
            }
        }

        const props = PropertiesService.getScriptProperties();
        const storedRaw = props.getProperty(TICKET_COUNTER_PROP);
        const storedNum = storedRaw ? parseInt(storedRaw, 10) : 0;
        const baseNum = Math.max(scannedMax, isNaN(storedNum) ? 0 : storedNum);
        const nextNum = baseNum + 1;
        props.setProperty(TICKET_COUNTER_PROP, String(nextNum));

        return "TKT-" + String(nextNum).padStart(5, "0");
    } catch (error) {
        Logger.log("Error generating ticket ID: " + error.toString());
        throw error;
    } finally {
        try { lock.releaseLock(); } catch (e) { /* noop */ }
    }
}

// Calculate SLA Date
function calculateSLADate(severity, reportedDate) {
    const days = SLA_RULES[severity] || 7;
    const slaDate = new Date(reportedDate);
    slaDate.setDate(slaDate.getDate() + days);
    return slaDate;
}

// On Form Submit Trigger.
// e.values aligns 1:1 with the bound spreadsheet row -> FORM_COL constants
// map the indices. Severity is intentionally NOT collected by the form;
// the column is preserved in the sheet for historical rows but stays
// blank on new intake — committee assigns it at approval time.
//
// IMPORTANT: this is an INSTALLABLE trigger. Apps Script does NOT bind
// it automatically just because the name starts with "on". The operator
// must run installFormSubmitTrigger() once (or use Triggers UI) for new
// form submissions to land in PENDING_REVIEW. Without it, rows go to
// "Form Responses 1" only and no ticket is created.
function onFormSubmit(e) {
    try {
        const values = e.values || [];
        const fields = {
            residentName: values[FORM_COL.RESIDENT]    || "",
            flat:         values[FORM_COL.FLAT]        || "",
            category:     values[FORM_COL.CATEGORY]    || "",
            subCategory:  values[FORM_COL.SUBCATEGORY] || "",
            severity:     "",
            tower:        values[FORM_COL.TOWER]       || "",
            description:  values[FORM_COL.LOCATION]    || "",
            photoLinks:   values[FORM_COL.PHOTO]       || ""
        };
        createPendingIssue_(fields, ""); // form path has no verified email
    } catch (error) {
        Logger.log("Form submission error: " + error.toString());
    }
}

// Operator-run setup. Idempotent: removes any prior onFormSubmit
// triggers attached to this script project, then creates a fresh
// spreadsheet-form-submit trigger bound to the active sheet. Run once
// per deployment, and any time the bound spreadsheet changes.
//
// Returns: { success, message, data:{ removed, triggerId } }.
function installFormSubmitTrigger() {
    try {
        const ss = getSpreadsheet();
        const existing = ScriptApp.getProjectTriggers();
        Logger.log("[form-trigger] existing project triggers: " + existing.length);
        let removed = 0;
        for (let i = 0; i < existing.length; i++) {
            if (existing[i].getHandlerFunction() === "onFormSubmit") {
                ScriptApp.deleteTrigger(existing[i]);
                removed++;
            }
        }
        Logger.log("[form-trigger] removed prior onFormSubmit triggers: " + removed);
        const t = ScriptApp.newTrigger("onFormSubmit")
            .forSpreadsheet(ss)
            .onFormSubmit()
            .create();
        const tid = t.getUniqueId();
        Logger.log("[form-trigger] created id=" + tid + " handler=onFormSubmit");
        const msg = "Form-submit trigger installed (handler=onFormSubmit). " +
                    "Removed " + removed + " prior trigger(s). " +
                    "New form responses will now create PENDING_REVIEW rows.";
        Logger.log("[form-trigger] DONE: " + msg);
        return { success: true, message: msg, data: { removed: removed, triggerId: tid } };
    } catch (error) {
        Logger.log("[form-trigger] FAILED: " + error.toString());
        return { success: false, message: null, data: null, error: "Install failed: " + error.toString() };
    }
}

// Read-only diagnostic. Lists every trigger on the script project so
// operators can confirm whether onFormSubmit is wired up. Useful when
// "form was submitted but no ticket appeared".
//
// Returns: { success, data: [{handler, type, source, uniqueId}, ...], error }.
function listProjectTriggers() {
    try {
        const out = ScriptApp.getProjectTriggers().map(function (t) {
            let source = "";
            try {
                const tsId = t.getTriggerSourceId && t.getTriggerSourceId();
                source = tsId || "";
            } catch (e) { source = ""; }
            return {
                handler:  t.getHandlerFunction(),
                type:     String(t.getEventType()),
                triggerSource: String(t.getTriggerSource()),
                sourceId: source,
                uniqueId: t.getUniqueId()
            };
        });
        Logger.log("[trigger-list] " + JSON.stringify(out));
        return { success: true, data: out, error: null };
    } catch (error) {
        Logger.log("[trigger-list] FAILED: " + error.toString());
        return { success: false, data: null, error: error.toString() };
    }
}

/**
 * Shared writer for both the Google Form trigger and the in-portal
 * submitIssue API action. Generates the ticket id atomically (LockService)
 * and writes one row into PENDING_REVIEW using PENDING_COL constants.
 *
 * Severity is NOT defaulted here. It stays blank in PENDING_REVIEW until
 * the committee assigns it at approval time, at which point SLA is also
 * computed. See approveIssue().
 *
 * `fields` shape:
 *   { residentName, flat, category, subCategory, severity, tower,
 *     description, photoLinks }   // photoLinks: string (CSV) OR string[]
 *
 * `reportedDateOverride` (optional): when provided (a Date or ISO-ish
 * string), that value is written to DATE_REPORTED instead of "now".
 * Used by the rebuild/recovery paths to preserve original submission
 * timestamps from Form Responses 1.
 *
 * Returns: { ticketId, reportedDate }
 */
function createPendingIssue_(fields, submittedBy, reportedDateOverride) {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
        let reportedDate = new Date();
        if (reportedDateOverride) {
            const d = (reportedDateOverride instanceof Date)
                ? reportedDateOverride
                : new Date(reportedDateOverride);
            if (d && !isNaN(d.getTime())) reportedDate = d;
        }
        const ticketId = generateTicketID();
        const photoCell = Array.isArray(fields.photoLinks)
            ? fields.photoLinks.filter(Boolean).join(", ")
            : (fields.photoLinks || "");

        const row = newRow_(PENDING_WIDTH);
        row[PENDING_COL.TICKET_ID]     = ticketId;
        row[PENDING_COL.DATE_REPORTED] = reportedDate;
        row[PENDING_COL.RESIDENT]      = fields.residentName || "";
        row[PENDING_COL.FLAT]          = fields.flat         || "";
        row[PENDING_COL.CATEGORY]      = fields.category     || "";
        row[PENDING_COL.SUBCATEGORY]   = fields.subCategory  || "";
        row[PENDING_COL.SEVERITY]      = fields.severity     || "";
        row[PENDING_COL.TOWER]         = fields.tower        || "";
        row[PENDING_COL.PHOTO]         = photoCell;
        row[PENDING_COL.DESCRIPTION]   = fields.description  || "";
        row[PENDING_COL.SUBMITTED_BY]  = submittedBy         || "";
        row[PENDING_COL.STATE]         = "PENDING_APPROVAL";

        getSheet(SHEETS.PENDING_REVIEW).appendRow(row);
        Logger.log("Pending issue created: " + ticketId);

        return { ticketId: ticketId, reportedDate: reportedDate };
    } finally {
        try { lock.releaseLock(); } catch (e) { /* noop */ }
    }
}

/**
 * In-portal submission entry point.
 * `payload` shape:
 *   { residentName?, flat, category, subCategory?, severity, tower,
 *     description, photos?: [{ name, mime, b64 }, ...] }
 * `submittedBy` is the server-trusted email from Session.
 */
function submitIssue(payload, submittedBy) {
    try {
        // Feature gate (UI is also hidden when off; this is the API
        // safeguard so dependent helpers stay reachable while the public
        // entry point is disabled).
        if (!getFeatureFlag("FEATURE_IN_PORTAL_SUBMIT")) {
            return { success: false, data: null, error: "In-portal submission is currently disabled." };
        }
        const p = payload || {};
        // If photo upload is feature-disabled, silently drop photos.
        if (!getFeatureFlag("FEATURE_PHOTO_UPLOAD")) {
            p.photos = [];
        }
        const validation = validateSubmission_(p);
        if (!validation.ok) {
            return { success: false, data: null, error: "Validation failed: " + validation.errors.join("; ") };
        }

        // Rate limit: 1 submit / 20s per user, max 20 per UTC day.
        const limit = checkRateLimit_(submittedBy);
        if (!limit.ok) {
            return { success: false, data: null, error: limit.error };
        }

        // Upload photos (if any).
        let photoLinks = [];
        if (Array.isArray(p.photos) && p.photos.length > 0) {
            try {
                photoLinks = uploadSubmissionPhotos_(p.photos, submittedBy);
            } catch (e) {
                Logger.log("Photo upload failed: " + e);
                return { success: false, data: null, error: "Photo upload failed: " + e.message };
            }
        }

        const fields = {
            residentName: p.residentName || submittedBy || "",
            flat:         p.flat,
            category:     p.category,
            subCategory:  p.subCategory || "",
            // Severity is intentionally blank at intake; the committee
            // assigns it at approval time (see approveIssue + SLA calc).
            severity:     "",
            tower:        p.tower,
            description:  p.description,
            photoLinks:   photoLinks
        };
        const result = createPendingIssue_(fields, submittedBy || "");

        return {
            success: true,
            data: {
                ticketId: result.ticketId,
                reportedDate: result.reportedDate,
                photoCount: photoLinks.length
            },
            error: null
        };
    } catch (error) {
        Logger.log("submitIssue error: " + error);
        return { success: false, data: null, error: error.toString() };
    }
}

/**
 * Returns the CATEGORY_MASTER lists so the submit page can render dropdowns
 * sourced from the sheet (not hard-coded). The sheet stores Category /
 * Subcategory / Severity / Tower as independent columns of lists.
 */
function getCategoryMaster() {
    try {
        const sheet = getSheet(SHEETS.CATEGORY_MASTER);
        const data = sheet.getDataRange().getValues();
        const categories = [], subcategories = [], severities = [], towers = [];
        for (let i = 1; i < data.length; i++) {
            const r = data[i];
            if (r[0]) categories.push(String(r[0]).trim());
            if (r[1]) subcategories.push(String(r[1]).trim());
            if (r[2]) severities.push(String(r[2]).trim());
            if (r[3]) towers.push(String(r[3]).trim());
        }
        return {
            success: true,
            data: {
                categories: dedupe_(categories),
                subcategories: dedupe_(subcategories),
                severities: dedupe_(severities),
                towers: dedupe_(towers)
            },
            error: null
        };
    } catch (error) {
        return { success: false, data: null, error: error.toString() };
    }
}

function dedupe_(arr) {
    const seen = {}, out = [];
    for (let i = 0; i < arr.length; i++) {
        const k = arr[i];
        if (!k || seen[k]) continue;
        seen[k] = true;
        out.push(k);
    }
    return out;
}

// Server-side validation for in-portal submissions.
// All numeric limits come from CONFIG tunables — keep this aligned with
// what the browser client sees via getClientConfig(). Severity is NOT
// validated here — it is assigned by the committee at approval time.
function validateSubmission_(p) {
    const errors = [];
    const descMin   = Number(getTunable("SUBMIT_DESC_MIN"))    || 5;
    const descMax   = Number(getTunable("SUBMIT_DESC_MAX"))    || 1000;
    const maxPhotos = Number(getTunable("SUBMIT_MAX_PHOTOS"))  || 5;
    const maxMB     = Number(getTunable("SUBMIT_MAX_PHOTO_MB")) || 5;
    if (!p.category || String(p.category).trim() === "") errors.push("Category is required");
    if (!p.tower    || String(p.tower).trim()    === "") errors.push("Tower is required");
    if (!p.description || String(p.description).trim().length < descMin) errors.push("Description must be at least " + descMin + " characters");
    if (p.description && String(p.description).length > descMax)        errors.push("Description must be " + descMax + " characters or fewer");
    if (p.residentName && String(p.residentName).length > 80)            errors.push("Resident name too long");
    if (p.flat && String(p.flat).length > 20)                            errors.push("Flat number too long");
    if (Array.isArray(p.photos)) {
        if (p.photos.length > maxPhotos) errors.push("Maximum " + maxPhotos + " photos allowed");
        const allowedMime = ["image/jpeg", "image/png", "image/webp"];
        const maxBytes = maxMB * 1024 * 1024;
        for (let i = 0; i < p.photos.length; i++) {
            const ph = p.photos[i];
            if (!ph || !ph.b64) { errors.push("Photo " + (i + 1) + " is empty"); continue; }
            if (allowedMime.indexOf(ph.mime) === -1) errors.push("Photo " + (i + 1) + " must be JPEG/PNG/WEBP");
            // Approximate decoded size: b64 length * 3/4.
            const approxBytes = Math.floor(ph.b64.length * 0.75);
            if (approxBytes > maxBytes) errors.push("Photo " + (i + 1) + " exceeds " + maxMB + " MB");
        }
    }
    return { ok: errors.length === 0, errors: errors };
}

// Per-user rate limit using UserProperties (scoped to signed-in account).
function checkRateLimit_(email) {
    if (!email) return { ok: true }; // anonymous (form path)
    const gapSec = Number(getTunable("SUBMIT_RATE_LIMIT_SECONDS")) || 20;
    const dayCap = Number(getTunable("SUBMIT_DAILY_LIMIT"))        || 20;
    try {
        const props = PropertiesService.getUserProperties();
        const now = Date.now();
        const last = parseInt(props.getProperty("IRP_LAST_SUBMIT_TS") || "0", 10);
        if (last && (now - last) < gapSec * 1000) {
            return { ok: false, error: "Please wait a few seconds before submitting again." };
        }
        const todayKey = new Date().toISOString().slice(0, 10);
        const dayKey = "IRP_DAY_" + todayKey;
        const count = parseInt(props.getProperty(dayKey) || "0", 10);
        if (count >= dayCap) {
            return { ok: false, error: "Daily submission limit reached (" + dayCap + ")." };
        }
        props.setProperty("IRP_LAST_SUBMIT_TS", String(now));
        props.setProperty(dayKey, String(count + 1));
        return { ok: true };
    } catch (e) {
        Logger.log("checkRateLimit_ noop: " + e);
        return { ok: true };
    }
}

// Upload base64-encoded photos to the configured Drive folder and return
// publicly viewable URLs (Drive thumbnail endpoint) that work inside an
// <img> tag in the web app.
function uploadSubmissionPhotos_(photos, submittedBy) {
    // Auto-resolves + persists ATTACHMENT_FOLDER_ID on first use, so no
    // separate operator setup step is required. Throws a clear error if
    // the canonical Drive path can't be reached (missing folder / no
    // share access for the script's effective account).
    const resolved = resolveAttachmentFolder_({ autoSetup: true, makePublic: true });
    const folder = resolved.folder;
    const links = [];
    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "UTC", "yyyyMMdd_HHmmss");
    for (let i = 0; i < photos.length; i++) {
        const ph = photos[i];
        const bytes = Utilities.base64Decode(String(ph.b64 || "").replace(/^data:[^;]+;base64,/, ""));
        const safeName = String(ph.name || ("photo_" + (i + 1))).replace(/[^A-Za-z0-9._-]/g, "_");
        const fileName = stamp + "_" + (submittedBy ? submittedBy.replace(/[^A-Za-z0-9._-]/g, "_") + "_" : "") + safeName;
        const blob = Utilities.newBlob(bytes, ph.mime, fileName);
        const file = folder.createFile(blob);
        // Force "Anyone with link → Viewer" so the web app (which may be
        // served to anonymous visitors) can render the image. Helper logs
        // and falls back to ANYONE if domain policy blocks link sharing.
        trySharePublic_(file, fileName);
        // Store the embeddable thumbnail URL directly so future readers
        // don't have to translate. splitPhotoLinks_ also normalizes legacy
        // /file/d/<id>/view URLs from the bound Google Form.
        links.push(driveImageUrl_(file.getUrl()));
    }
    return links;
}

/**
 * Append uploaded photos to an existing issue row (PENDING_REVIEW,
 * LIVE_ISSUES, or CLOSED_ISSUES). Used by the committee dashboard to
 * attach photos to issues that were submitted without any.
 *
 * payload shape: { ticketId, sheet, photos: [{name, mime, b64}, ...] }
 *   sheet: "PENDING_REVIEW" | "LIVE_ISSUES" | "CLOSED_ISSUES"
 *
 * Returns: { success, data: { ticketId, photoLinks }, error }
 */
function addPhotosToIssue(ticketId, sheetName, photos, userEmail) {
    try {
        // Two flags gate this action:
        //   FEATURE_COMMITTEE_PHOTO_ATTACH — master switch for the
        //     "attach later" workflow (UI button + this API). Default OFF.
        //   FEATURE_PHOTO_UPLOAD — global photo-upload kill-switch shared
        //     with the resident submit page.
        if (!getFeatureFlag("FEATURE_COMMITTEE_PHOTO_ATTACH")) {
            return { success: false, data: null, error: "Committee photo attach is disabled. Enable FEATURE_COMMITTEE_PHOTO_ATTACH in the CONFIG sheet." };
        }
        if (!getFeatureFlag("FEATURE_PHOTO_UPLOAD")) {
            return { success: false, data: null, error: "Photo upload is currently disabled." };
        }
        if (!ticketId) return { success: false, data: null, error: "ticketId is required" };
        if (!Array.isArray(photos) || photos.length === 0) {
            return { success: false, data: null, error: "No photos provided" };
        }

        // Reuse the submission validator (photos-only branch).
        const v = validateSubmission_({
            category: "x", tower: "x",
            description: "placeholder description",
            photos: photos
        });
        if (!v.ok) {
            // Strip the placeholder-field errors we forced through above.
            const errs = v.errors.filter(function (e) {
                return e.indexOf("Photo") === 0 || e.indexOf("photos") !== -1;
            });
            if (errs.length) {
                return { success: false, data: null, error: "Validation failed: " + errs.join("; ") };
            }
        }

        const sn = String(sheetName || SHEETS.PENDING_REVIEW);
        let photoColIdx;
        if (sn === SHEETS.PENDING_REVIEW)      photoColIdx = PENDING_COL.PHOTO;
        else if (sn === SHEETS.LIVE_ISSUES)    photoColIdx = LIVE_COL.PHOTO;
        else if (sn === SHEETS.CLOSED_ISSUES)  photoColIdx = LIVE_COL.PHOTO;
        else return { success: false, data: null, error: "Unsupported sheet: " + sn };

        const sheet = getSheet(sn);
        const data = sheet.getDataRange().getValues();
        const ticketColIdx = (sn === SHEETS.PENDING_REVIEW) ? PENDING_COL.TICKET_ID : LIVE_COL.TICKET_ID;

        let rowIndex = -1;
        for (let i = 1; i < data.length; i++) {
            if (String(data[i][ticketColIdx]) === String(ticketId)) { rowIndex = i; break; }
        }
        if (rowIndex === -1) {
            return { success: false, data: null, error: "Ticket not found on " + sn + ": " + ticketId };
        }

        const newLinks = uploadSubmissionPhotos_(photos, userEmail || "");
        const existingCell = data[rowIndex][photoColIdx];
        const existing = splitPhotoLinks_(existingCell);
        const merged = existing.concat(newLinks);
        const cellValue = merged.join(", ");

        // Sheet rows are 1-based; data array is 0-based.
        sheet.getRange(rowIndex + 1, photoColIdx + 1).setValue(cellValue);
        Logger.log("addPhotosToIssue: " + ticketId + " on " + sn + " (+" + newLinks.length + " photos by " + (userEmail || "?") + ")");

        return {
            success: true,
            data: { ticketId: ticketId, photoLinks: merged, addedCount: newLinks.length },
            error: null
        };
    } catch (error) {
        Logger.log("addPhotosToIssue error: " + error);
        return { success: false, data: null, error: error.toString() };
    }
}

// Get Form Responses (Direct from Google Sheet). Uses FORM_COL indices
// (not header text) so the API contract is stable even if the bound form
// changes question wording.
function getFormResponses() {
    try {
        const sheet = getSheet(SHEETS.FORM_RESPONSES);
        const data = sheet.getDataRange().getValues();
        const responses = [];

        for (let i = 1; i < data.length; i++) {
            const row = data[i];
            responses.push({
                timestamp:    row[FORM_COL.TIMESTAMP]   || "",
                residentName: row[FORM_COL.RESIDENT]    || "",
                flat:         row[FORM_COL.FLAT]        || "",
                category:     row[FORM_COL.CATEGORY]    || "",
                subCategory:  row[FORM_COL.SUBCATEGORY] || "",
                severity:     row[FORM_COL.SEVERITY]    || "",
                tower:        row[FORM_COL.TOWER]       || "",
                description:  row[FORM_COL.LOCATION]    || "",
                photoLinks:   splitPhotoLinks_(row[FORM_COL.PHOTO])
            });
        }

        return {
            success: true,
            responses: responses,
            count: responses.length,
            error: null
        };
    } catch (error) {
        return {
            success: false,
            responses: null,
            error: "Error fetching form responses: " + error.toString()
        };
    }
}

// Sync Form Responses to PENDING_REVIEW (manual data sync). Idempotent
// via {Timestamp|ResidentName|Flat} signature compared across both sheets.
function syncFormResponses() {
    try {
        const formSheet = getSheet(SHEETS.FORM_RESPONSES);
        const pendingSheet = getSheet(SHEETS.PENDING_REVIEW);

        const formData = formSheet.getDataRange().getValues();
        const pendingData = pendingSheet.getDataRange().getValues();

        const sigOf = function (ts, name, flat) {
            const t = ts instanceof Date ? ts.toISOString() : String(ts);
            return t + "|" + String(name || "") + "|" + String(flat || "");
        };

        const processedKeys = new Set();
        for (let i = firstDataRow_(pendingData); i < pendingData.length; i++) {
            const p = pendingData[i];
            processedKeys.add(sigOf(
                p[PENDING_COL.DATE_REPORTED],
                p[PENDING_COL.RESIDENT],
                p[PENDING_COL.FLAT]
            ));
        }

        let synced = 0;
        let skipped = 0;

        for (let i = 1; i < formData.length; i++) {
            const row = formData[i];
            const uniqueKey = sigOf(
                row[FORM_COL.TIMESTAMP],
                row[FORM_COL.RESIDENT],
                row[FORM_COL.FLAT]
            );

            if (processedKeys.has(uniqueKey)) {
                skipped++;
                continue;
            }

            createPendingIssue_({
                residentName: row[FORM_COL.RESIDENT]    || "",
                flat:         row[FORM_COL.FLAT]        || "",
                category:     row[FORM_COL.CATEGORY]    || "",
                subCategory:  row[FORM_COL.SUBCATEGORY] || "",
                severity:     row[FORM_COL.SEVERITY]    || "",
                tower:        row[FORM_COL.TOWER]       || "",
                description:  row[FORM_COL.LOCATION]    || "",
                photoLinks:   row[FORM_COL.PHOTO]       || ""
            }, "");
            processedKeys.add(uniqueKey);
            synced++;
        }
        
        return {
            success: true,
            data: {
                synced: synced,
                skipped: skipped,
                message: `Synced ${synced} new issues, skipped ${skipped} already processed`
            },
            error: null
        };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: "Sync error: " + error.toString()
        };
    }
}

// Validate User Access
// Authoritative source is the CONFIG sheet (see config.gs). Email MUST be
// a server-trusted address obtained from Session.getActiveUser() - never
// from a client-supplied payload field.
function validateUserAccess(email) {
    try {
        const role = getUserRole(email);
        if (role === "COMMITTEE") {
            return { email: email, role: "COMMITTEE", hasAccess: true, accessLevel: "FULL" };
        }
        if (role === "BUILDER") {
            return { email: email, role: "BUILDER", hasAccess: true, accessLevel: "LIMITED" };
        }
        return { email: email, role: "UNKNOWN", hasAccess: false, accessLevel: "NONE" };
    } catch (error) {
        Logger.log("Error validating user access: " + error.toString());
        throw error;
    }
}

// Get Pending Issues
function getPendingIssues() {
    try {
        const pendingSheet = getSheet(SHEETS.PENDING_REVIEW);
        const archiveSheet = getSheet(SHEETS.ARCHIVES_ISSUES);
        const pendingData  = pendingSheet.getDataRange().getValues();
        const archiveData  = archiveSheet.getDataRange().getValues();
        const issues = [];

        const pushRow = function (row, fallbackState) {
            const state = row[PENDING_COL.STATE] || fallbackState;
            // Skip APPROVED rows from pending (they live on LIVE_ISSUES); the
            // committee dashboard surfaces approved ones via its Active tab.
            if (state === "APPROVED") return;
            const photo = row[PENDING_COL.PHOTO];
            issues.push({
                ticketId:     safeStr_(row[PENDING_COL.TICKET_ID]),
                dateReported: safeDateIso_(row[PENDING_COL.DATE_REPORTED]),
                resident: {
                    name:  safeStr_(row[PENDING_COL.RESIDENT]),
                    email: "",
                    phone: ""
                },
                location: {
                    tower: safeStr_(row[PENDING_COL.TOWER]),
                    flat:  safeStr_(row[PENDING_COL.FLAT])
                },
                issue: {
                    category:    safeStr_(row[PENDING_COL.CATEGORY]),
                    subcategory: safeStr_(row[PENDING_COL.SUBCATEGORY]),
                    severity:    safeStr_(row[PENDING_COL.SEVERITY]),
                    location:    safeStr_(row[PENDING_COL.DESCRIPTION]),
                    description: safeStr_(row[PENDING_COL.DESCRIPTION]),
                    photoLinks:  splitPhotoLinks_(photo)
                },
                state:           safeStr_(state),
                rejectionReason: safeStr_(row[PENDING_COL.REJECTION_REASON]),
                actionDate:      safeDateIso_(row[PENDING_COL.ACTION_DATE]),
                actionBy:        safeStr_(row[PENDING_COL.ACTION_BY])
            });
        };

        for (let i = firstDataRow_(pendingData); i < pendingData.length; i++) {
            pushRow(pendingData[i], "PENDING_APPROVAL");
        }
        for (let i = firstDataRow_(archiveData); i < archiveData.length; i++) {
            pushRow(archiveData[i], "REJECTED");
        }

        return { success: true, data: issues, error: null };
    } catch (error) {
        return { success: false, data: null, error: error.toString() };
    }
}

// Approve Issue: copy PENDING row into LIVE_ISSUES with status=APPROVED,
// then remove from PENDING. Severity is supplied by the committee at
// approval time (it is NOT collected on intake). SLA due-date is
// computed here from severity + reportedDate.
function approveIssue(ticketId, userEmail, severity) {
    try {
        const ALLOWED = ["Critical", "High", "Medium", "Low"];
        if (!severity || ALLOWED.indexOf(severity) === -1) {
            return { success: false, data: null, error: "Severity must be Critical/High/Medium/Low" };
        }
        const pendingSheet = getSheet(SHEETS.PENDING_REVIEW);
        const liveSheet    = getSheet(SHEETS.LIVE_ISSUES);
        const pendingData  = pendingSheet.getDataRange().getValues();

        for (let i = firstDataRow_(pendingData); i < pendingData.length; i++) {
            const row = pendingData[i];
            if (row[PENDING_COL.TICKET_ID] !== ticketId) continue;

            const reportedDate = new Date(row[PENDING_COL.DATE_REPORTED]);
            const slaDate      = calculateSLADate(severity, reportedDate);
            const now          = new Date();

            const live = newRow_(LIVE_WIDTH);
            live[LIVE_COL.TICKET_ID]       = ticketId;
            live[LIVE_COL.DATE_REPORTED]   = reportedDate;
            live[LIVE_COL.TOWER]           = row[PENDING_COL.TOWER]       || "";
            live[LIVE_COL.FLAT]            = row[PENDING_COL.FLAT]        || "";
            live[LIVE_COL.RESIDENT]        = row[PENDING_COL.RESIDENT]    || "";
            live[LIVE_COL.CATEGORY]        = row[PENDING_COL.CATEGORY]    || "";
            live[LIVE_COL.SUBCATEGORY]     = row[PENDING_COL.SUBCATEGORY] || "";
            live[LIVE_COL.SEVERITY]        = severity;
            live[LIVE_COL.DESCRIPTION]     = row[PENDING_COL.DESCRIPTION] || "";
            live[LIVE_COL.PHOTO]           = row[PENDING_COL.PHOTO]       || "";
            live[LIVE_COL.STATUS]          = "ASSIGNED";
            live[LIVE_COL.DATE_ASSIGNED]   = now;
            live[LIVE_COL.SLA_DATE]        = slaDate;
            live[LIVE_COL.REMARKS]         = "Approved by " + (userEmail || "committee");

            // Strict move semantics: append to LIVE_ISSUES, then delete
            // the row from PENDING_REVIEW. After this the ticket only
            // exists in LIVE (and read-only views read LIVE for approved).
            liveSheet.appendRow(live);
            pendingSheet.deleteRow(i + 1);

            return {
                success: true,
                data: {
                    ticketId: ticketId,
                    state: "APPROVED",
                    severity: severity,
                    approvedBy: userEmail,
                    approvedDate: safeDateIso_(now),
                    slaDate:      safeDateIso_(slaDate)
                },
                error: null
            };
        }

        return { success: false, data: null, error: "Ticket not found" };
    } catch (error) {
        return { success: false, data: null, error: error.toString() };
    }
}

// Reject Issue: move PENDING row to ARCHIVES_ISSUES with state=REJECTED,
// then delete from PENDING_REVIEW. The archive remains visible on the
// public submitted-issues view.
function rejectIssue(ticketId, reason, userEmail) {
    try {
        const pendingSheet = getSheet(SHEETS.PENDING_REVIEW);
        const archiveSheet = getSheet(SHEETS.ARCHIVES_ISSUES);
        const data = pendingSheet.getDataRange().getValues();

        for (let i = firstDataRow_(data); i < data.length; i++) {
            if (data[i][PENDING_COL.TICKET_ID] !== ticketId) continue;
            const rowNum = i + 1;
            const now = new Date();

            // Build the archive row from a copy of the pending row so any
            // sheet-specific extra columns are preserved by position.
            const archived = data[i].slice();
            while (archived.length < PENDING_WIDTH) archived.push("");
            archived[PENDING_COL.ACTION_DATE]      = now;
            archived[PENDING_COL.ACTION_BY]        = userEmail || "";
            archived[PENDING_COL.REJECTION_REASON] = reason || "";
            archived[PENDING_COL.STATE]            = "REJECTED";
            archiveSheet.appendRow(archived);
            pendingSheet.deleteRow(rowNum);

            return {
                success: true,
                data: {
                    ticketId: ticketId,
                    state: "REJECTED",
                    rejectionReason: reason,
                    rejectedBy: userEmail,
                    rejectedDate: safeDateIso_(now)
                },
                error: null
            };
        }

        return { success: false, data: null, error: "Ticket not found" };
    } catch (error) {
        return { success: false, data: null, error: error.toString() };
    }
}

// Get Live Issues
function getLiveIssues(filterOption) {
    try {
        const sheet = getSheet(SHEETS.LIVE_ISSUES);
        const data = sheet.getDataRange().getValues();
        const issues = [];
        const today = new Date();
        const slaOn = getFeatureFlag("FEATURE_SLA");

        // BREACHED filter is meaningless when SLA is off — return empty.
        if (filterOption === "BREACHED" && !slaOn) {
            return { success: true, data: [], error: null };
        }

        for (let i = 1; i < data.length; i++) {
            const row = data[i];
            const sevRaw = String(row[LIVE_COL.SEVERITY] || "");
            const slaDateRaw = (slaOn && row[LIVE_COL.SLA_DATE]) ? new Date(row[LIVE_COL.SLA_DATE]) : null;
            const isBreached = slaDateRaw ? today > slaDateRaw : false;

            if (filterOption === "CRITICAL" && sevRaw.toUpperCase() !== "CRITICAL") continue;
            if (filterOption === "AGING" && (today - new Date(row[LIVE_COL.DATE_REPORTED])) < 7 * 24 * 60 * 60 * 1000) continue;
            if (filterOption === "BREACHED" && !isBreached) continue;

            const slaDate = slaDateRaw;
            const breached = isBreached;
            const daysRemaining = slaDate ? Math.ceil((slaDate - today) / (1000 * 60 * 60 * 24)) : null;
            const photo = row[LIVE_COL.PHOTO];

            issues.push({
                ticketId:     safeStr_(row[LIVE_COL.TICKET_ID]),
                dateReported: safeDateIso_(row[LIVE_COL.DATE_REPORTED]),
                resident: {
                    name:  safeStr_(row[LIVE_COL.RESIDENT]),
                    email: "",
                    phone: ""
                },
                location: {
                    tower: safeStr_(row[LIVE_COL.TOWER]),
                    flat:  safeStr_(row[LIVE_COL.FLAT])
                },
                issue: {
                    category:    safeStr_(row[LIVE_COL.CATEGORY]),
                    subcategory: safeStr_(row[LIVE_COL.SUBCATEGORY]),
                    severity:    sevRaw,
                    description: safeStr_(row[LIVE_COL.DESCRIPTION]),
                    photoLinks:  splitPhotoLinks_(photo)
                },
                builder: {
                    status:         safeStr_(row[LIVE_COL.STATUS]) || "ASSIGNED",
                    comment:        safeStr_(row[LIVE_COL.REMARKS]),
                    assignedVendor: safeStr_(row[LIVE_COL.ASSIGNED_VENDOR]),
                    lastUpdated:    safeDateIso_(row[LIVE_COL.DATE_ASSIGNED])
                },
                sla: {
                    dueDate:       slaDate ? (isNaN(slaDate.getTime()) ? "" : slaDate.toISOString()) : "",
                    breached:      breached,
                    daysRemaining: daysRemaining
                },
                state:       safeStr_(row[LIVE_COL.STATUS]),
                approvedBy:  "",
                lastUpdated: safeDateIso_(row[LIVE_COL.DATE_ASSIGNED])
            });
        }

        return { success: true, data: issues, error: null };
    } catch (error) {
        return { success: false, data: null, error: error.toString() };
    }
}

// Update Builder Status. Column indices come from LIVE_COL; getRange() is
// 1-based so we add 1.
function updateBuilderStatus(ticketId, status, comment, vendor, closureDate) {
    try {
        const sheet = getSheet(SHEETS.LIVE_ISSUES);
        const data = sheet.getDataRange().getValues();

        for (let i = 1; i < data.length; i++) {
            if (data[i][LIVE_COL.TICKET_ID] !== ticketId) continue;
            const rowNum = i + 1;
            const now = new Date();

            sheet.getRange(rowNum, LIVE_COL.STATUS         + 1).setValue(status || "");
            sheet.getRange(rowNum, LIVE_COL.REMARKS        + 1).setValue(comment || "");
            sheet.getRange(rowNum, LIVE_COL.ASSIGNED_VENDOR + 1).setValue(vendor || "");
            if (closureDate) {
                sheet.getRange(rowNum, LIVE_COL.CLOSURE_DATE + 1).setValue(new Date(closureDate));
            }

            return {
                success: true,
                data: {
                    ticketId: ticketId,
                    builderStatus: status,
                    builderComment: comment,
                    assignedVendor: vendor,
                    lastUpdated: safeDateIso_(now)
                },
                error: null
            };
        }

        return { success: false, data: null, error: "Ticket not found" };
    } catch (error) {
        return { success: false, data: null, error: error.toString() };
    }
}

// Close Issue: move LIVE row -> CLOSED_ISSUES, append [reason, closedDate,
// closedBy, resolutionDays] at the tail (indices LIVE_WIDTH..LIVE_WIDTH+3).
function closeIssue(ticketId, reason, userEmail) {
    try {
        const liveSheet   = getSheet(SHEETS.LIVE_ISSUES);
        const closedSheet = getSheet(SHEETS.CLOSED_ISSUES);
        const liveData    = liveSheet.getDataRange().getValues();

        for (let i = 1; i < liveData.length; i++) {
            if (liveData[i][LIVE_COL.TICKET_ID] !== ticketId) continue;
            const row = liveData[i];
            const reportedDate = new Date(row[LIVE_COL.DATE_REPORTED]);
            const closedDate   = new Date();
            const resolutionTime = Math.ceil((closedDate - reportedDate) / (1000 * 60 * 60 * 24));

            // Normalise width so closure metadata always lands at fixed offsets.
            const base = row.slice(0, LIVE_WIDTH);
            while (base.length < LIVE_WIDTH) base.push("");
            base[LIVE_COL.STATUS]       = "CLOSED";
            base[LIVE_COL.CLOSURE_DATE] = closedDate;
            const closedRow = base.concat([reason || "", closedDate, userEmail || "", resolutionTime]);
            closedSheet.appendRow(closedRow);
            liveSheet.deleteRow(i + 1);

            return {
                success: true,
                data: {
                    ticketId: ticketId,
                    state: "CLOSED",
                    closedDate: safeDateIso_(closedDate),
                    closedBy: userEmail,
                    closureReason: reason,
                    resolutionTime: resolutionTime
                },
                error: null
            };
        }

        return { success: false, data: null, error: "Ticket not found" };
    } catch (error) {
        return { success: false, data: null, error: error.toString() };
    }
}

// Get Closed Issues: read CLOSED_ISSUES. Layout = LIVE_COL plus closure
// metadata appended at the end: [reason, closedDate, closedBy, resolutionDays].
function getClosedIssues() {
    try {
        const sheet = getSheet(SHEETS.CLOSED_ISSUES);
        const data = sheet.getDataRange().getValues();
        const issues = [];
        const REASON_IDX     = LIVE_WIDTH;
        const CLOSED_AT_IDX  = LIVE_WIDTH + 1;
        const CLOSED_BY_IDX  = LIVE_WIDTH + 2;
        const RES_DAYS_IDX   = LIVE_WIDTH + 3;

        for (let i = 1; i < data.length; i++) {
            const row = data[i];
            if (!row[LIVE_COL.TICKET_ID]) continue;
            issues.push({
                ticketId:     safeStr_(row[LIVE_COL.TICKET_ID]),
                dateReported: safeDateIso_(row[LIVE_COL.DATE_REPORTED]),
                resident: {
                    name:  safeStr_(row[LIVE_COL.RESIDENT]),
                    email: "",
                    phone: ""
                },
                location: {
                    tower: safeStr_(row[LIVE_COL.TOWER]),
                    flat:  safeStr_(row[LIVE_COL.FLAT])
                },
                issue: {
                    category:    safeStr_(row[LIVE_COL.CATEGORY]),
                    subcategory: safeStr_(row[LIVE_COL.SUBCATEGORY]),
                    severity:    safeStr_(row[LIVE_COL.SEVERITY]),
                    description: safeStr_(row[LIVE_COL.DESCRIPTION]),
                    photoLinks:  splitPhotoLinks_(row[LIVE_COL.PHOTO])
                },
                builder: {
                    status:         "CLOSED",
                    assignedVendor: safeStr_(row[LIVE_COL.ASSIGNED_VENDOR]),
                    comment:        safeStr_(row[LIVE_COL.REMARKS]),
                    lastUpdated:    safeDateIso_(row[CLOSED_AT_IDX])
                },
                closure: {
                    reason:         safeStr_(row[REASON_IDX]),
                    closedDate:     safeDateIso_(row[CLOSED_AT_IDX]),
                    closedBy:       safeStr_(row[CLOSED_BY_IDX]),
                    resolutionDays: Number(row[RES_DAYS_IDX]) || 0
                },
                state: "CLOSED"
            });
        }

        return { success: true, data: issues, error: null };
    } catch (error) {
        return { success: false, data: null, error: error.toString() };
    }
}

// Reopen Issue: move row back from CLOSED to LIVE, status=REOPENED.
function reopenIssue(ticketId, reason, userEmail) {
    try {
        const closedSheet = getSheet(SHEETS.CLOSED_ISSUES);
        const liveSheet   = getSheet(SHEETS.LIVE_ISSUES);
        const closedData  = closedSheet.getDataRange().getValues();

        for (let i = 1; i < closedData.length; i++) {
            if (closedData[i][LIVE_COL.TICKET_ID] !== ticketId) continue;
            const row = closedData[i];
            const reopenedRow = row.slice(0, LIVE_WIDTH);
            while (reopenedRow.length < LIVE_WIDTH) reopenedRow.push("");
            const now = new Date();
            reopenedRow[LIVE_COL.STATUS]         = "REOPENED";
            reopenedRow[LIVE_COL.REOPENED_FLAG]  = "YES";
            reopenedRow[LIVE_COL.REMARKS]        = reason || reopenedRow[LIVE_COL.REMARKS] || "";
            reopenedRow[LIVE_COL.DATE_ASSIGNED]  = now;

            liveSheet.appendRow(reopenedRow);
            closedSheet.deleteRow(i + 1);

            return {
                success: true,
                data: {
                    ticketId: ticketId,
                    state: "REOPENED",
                    reopenedDate: safeDateIso_(new Date()),
                    reopenedBy: userEmail,
                    reopenReason: reason
                },
                error: null
            };
        }

        return { success: false, data: null, error: "Ticket not found" };
    } catch (error) {
        return { success: false, data: null, error: error.toString() };
    }
}

// Get Form Responses with Hybrid Status — joins Form Responses 1 against
// PENDING / LIVE / CLOSED using {ResidentName|Tower|Flat} signature.
function getIssuesWithStatus() {
    try {
        const formSheet    = getSheet(SHEETS.FORM_RESPONSES);
        const pendingSheet = getSheet(SHEETS.PENDING_REVIEW);
        const liveSheet    = getSheet(SHEETS.LIVE_ISSUES);
        const closedSheet  = getSheet(SHEETS.CLOSED_ISSUES);

        const formData    = formSheet.getDataRange().getValues();
        const pendingData = pendingSheet.getDataRange().getValues();
        const liveData    = liveSheet.getDataRange().getValues();
        const closedData  = closedSheet.getDataRange().getValues();

        const sig = function (name, tower, flat) {
            return String(name || "").trim() + "|" + String(tower || "").trim() + "|" + String(flat || "").trim();
        };

        const pendingMap = {};
        const liveMap    = {};
        const closedMap  = {};

        for (let i = firstDataRow_(pendingData); i < pendingData.length; i++) {
            const r = pendingData[i];
            pendingMap[sig(r[PENDING_COL.RESIDENT], r[PENDING_COL.TOWER], r[PENDING_COL.FLAT])] = {
                status:   r[PENDING_COL.STATE] || "PENDING_APPROVAL",
                ticketId: r[PENDING_COL.TICKET_ID]
            };
        }
        for (let i = 1; i < liveData.length; i++) {
            const r = liveData[i];
            liveMap[sig(r[LIVE_COL.RESIDENT], r[LIVE_COL.TOWER], r[LIVE_COL.FLAT])] = {
                status:   r[LIVE_COL.BUILDER_STATUS] || r[LIVE_COL.STATUS] || "ASSIGNED",
                ticketId: r[LIVE_COL.TICKET_ID]
            };
        }
        for (let i = 1; i < closedData.length; i++) {
            const r = closedData[i];
            closedMap[sig(r[LIVE_COL.RESIDENT], r[LIVE_COL.TOWER], r[LIVE_COL.FLAT])] = {
                status:   "CLOSED",
                ticketId: r[LIVE_COL.TICKET_ID]
            };
        }

        const issues = [];
        for (let i = 1; i < formData.length; i++) {
            const row = formData[i];
            const key = sig(row[FORM_COL.RESIDENT], row[FORM_COL.TOWER], row[FORM_COL.FLAT]);

            let hybridStatus = "NEW";
            let ticketId = null;
            if (closedMap[key])      { hybridStatus = closedMap[key].status;  ticketId = closedMap[key].ticketId; }
            else if (liveMap[key])   { hybridStatus = liveMap[key].status;    ticketId = liveMap[key].ticketId; }
            else if (pendingMap[key]){ hybridStatus = pendingMap[key].status; ticketId = pendingMap[key].ticketId; }

            issues.push({
                ticketId:   safeStr_(ticketId) || ("SUB-" + new Date().getFullYear() + "-" + String(i).padStart(4, "0")),
                issueTitle: safeStr_(row[FORM_COL.LOCATION]) || "Issue Report",
                resident: {
                    name:  safeStr_(row[FORM_COL.RESIDENT]) || "Unknown",
                    email: "",
                    phone: ""
                },
                location: {
                    tower: safeStr_(row[FORM_COL.TOWER]) || "N/A",
                    flat:  safeStr_(row[FORM_COL.FLAT])  || "N/A"
                },
                issue: {
                    category:    safeStr_(row[FORM_COL.CATEGORY])    || "N/A",
                    subcategory: safeStr_(row[FORM_COL.SUBCATEGORY]),
                    severity:    safeStr_(row[FORM_COL.SEVERITY]),
                    description: safeStr_(row[FORM_COL.LOCATION])    || "No details provided"
                },
                status: hybridStatus,
                dateReported: safeDateIso_(row[FORM_COL.TIMESTAMP]) || new Date().toISOString(),
                attachments: splitPhotoLinks_(row[FORM_COL.PHOTO])
            });
        }

        return { success: true, responses: issues, count: issues.length, error: null };
    } catch (error) {
        return { success: false, responses: null, error: "Error fetching issues with status: " + error.toString() };
    }
}

// Get Submitted Issues: aggregate the lifecycle for the read-only public
// view. With strict-move semantics every ticket lives in exactly one of
// PENDING_REVIEW / LIVE_ISSUES / ARCHIVES_ISSUES, so this just unions
// the three (archives are gated by SUBMITTED_INCLUDE_REJECTED).
function getSubmittedIssues() {
    try {
        const includeRejected = String(getTunable("SUBMITTED_INCLUDE_REJECTED") || "false").toLowerCase() === "true";
        const includeClosed   = getFeatureFlag("FEATURE_PUBLIC_FULL_REPORT");

        const pendingData = getSheet(SHEETS.PENDING_REVIEW).getDataRange().getValues();
        const liveData    = getSheet(SHEETS.LIVE_ISSUES).getDataRange().getValues();
        const archiveData = includeRejected
            ? getSheet(SHEETS.ARCHIVES_ISSUES).getDataRange().getValues()
            : [];
        const closedData  = includeClosed
            ? getSheet(SHEETS.CLOSED_ISSUES).getDataRange().getValues()
            : [];

        // PENDING_REVIEW and ARCHIVES_ISSUES share the PENDING_COL layout.
        const mapPendingRow = function (row, fallbackState) {
            const state = String(row[PENDING_COL.STATE] || fallbackState);
            return {
                ticketId:     safeStr_(row[PENDING_COL.TICKET_ID]),
                dateReported: safeDateIso_(row[PENDING_COL.DATE_REPORTED]),
                resident: {
                    name:  safeStr_(row[PENDING_COL.RESIDENT]),
                    email: "",
                    phone: ""
                },
                location: {
                    tower: safeStr_(row[PENDING_COL.TOWER]),
                    flat:  safeStr_(row[PENDING_COL.FLAT])
                },
                issue: {
                    category:    safeStr_(row[PENDING_COL.CATEGORY]),
                    subcategory: safeStr_(row[PENDING_COL.SUBCATEGORY]),
                    severity:    safeStr_(row[PENDING_COL.SEVERITY]),
                    description: safeStr_(row[PENDING_COL.DESCRIPTION]),
                    // photoLinks is the canonical shape every reader/PDF
                    // exporter expects (matches getPendingIssues /
                    // getLiveIssues / getClosedIssues). `attachments` is
                    // kept at the root for the existing submitted-issues
                    // detail-modal renderer that reads issue.attachments.
                    photoLinks:  splitPhotoLinks_(row[PENDING_COL.PHOTO])
                },
                status:          state,
                state:           state,
                rejectionReason: safeStr_(row[PENDING_COL.REJECTION_REASON]),
                attachments:     splitPhotoLinks_(row[PENDING_COL.PHOTO])
            };
        };

        // LIVE_ISSUES has its own column layout (LIVE_COL).
        const mapLiveRow = function (row) {
            const status = safeStr_(row[LIVE_COL.BUILDER_STATUS] || row[LIVE_COL.STATUS]) || "ASSIGNED";
            return {
                ticketId:     safeStr_(row[LIVE_COL.TICKET_ID]),
                dateReported: safeDateIso_(row[LIVE_COL.DATE_REPORTED]),
                resident: {
                    name:  safeStr_(row[LIVE_COL.RESIDENT]),
                    email: "",
                    phone: ""
                },
                location: {
                    tower: safeStr_(row[LIVE_COL.TOWER]),
                    flat:  safeStr_(row[LIVE_COL.FLAT])
                },
                issue: {
                    category:    safeStr_(row[LIVE_COL.CATEGORY]),
                    subcategory: safeStr_(row[LIVE_COL.SUBCATEGORY]),
                    severity:    safeStr_(row[LIVE_COL.SEVERITY]),
                    description: safeStr_(row[LIVE_COL.DESCRIPTION]),
                    photoLinks:  splitPhotoLinks_(row[LIVE_COL.PHOTO])
                },
                status:          status,
                state:           "APPROVED",
                rejectionReason: "",
                attachments:     splitPhotoLinks_(row[LIVE_COL.PHOTO])
            };
        };

        // CLOSED_ISSUES shares the LIVE_COL prefix and appends 4 closure
        // columns at LIVE_WIDTH..LIVE_WIDTH+3. Marked state="CLOSED" so
        // the wizard buckets them into the Closed section.
        const mapClosedRow = function (row) {
            return {
                ticketId:     safeStr_(row[LIVE_COL.TICKET_ID]),
                dateReported: safeDateIso_(row[LIVE_COL.DATE_REPORTED]),
                resident: {
                    name:  safeStr_(row[LIVE_COL.RESIDENT]),
                    email: "",
                    phone: ""
                },
                location: {
                    tower: safeStr_(row[LIVE_COL.TOWER]),
                    flat:  safeStr_(row[LIVE_COL.FLAT])
                },
                issue: {
                    category:    safeStr_(row[LIVE_COL.CATEGORY]),
                    subcategory: safeStr_(row[LIVE_COL.SUBCATEGORY]),
                    severity:    safeStr_(row[LIVE_COL.SEVERITY]),
                    description: safeStr_(row[LIVE_COL.DESCRIPTION]),
                    photoLinks:  splitPhotoLinks_(row[LIVE_COL.PHOTO])
                },
                status:          "CLOSED",
                state:           "CLOSED",
                rejectionReason: "",
                attachments:     splitPhotoLinks_(row[LIVE_COL.PHOTO])
            };
        };

        const responses = [];
        for (let i = firstDataRow_(pendingData); i < pendingData.length; i++) {
            const m = mapPendingRow(pendingData[i], "PENDING_APPROVAL");
            if (!m.ticketId) continue;
            // Defensive: skip legacy rows whose state was flipped to
            // APPROVED in-place before strict-move semantics landed.
            // LIVE_ISSUES is the canonical source for approved tickets.
            if (m.state === "APPROVED") continue;
            responses.push(m);
        }
        for (let i = 1; i < liveData.length; i++) {
            const m = mapLiveRow(liveData[i]);
            if (m.ticketId) responses.push(m);
        }
        for (let i = firstDataRow_(archiveData); i < archiveData.length; i++) {
            const m = mapPendingRow(archiveData[i], "REJECTED");
            if (m.ticketId) responses.push(m);
        }
        for (let i = 1; i < closedData.length; i++) {
            const m = mapClosedRow(closedData[i]);
            if (m.ticketId) responses.push(m);
        }

        return { success: true, responses: responses, count: responses.length, error: null };
    } catch (error) {
        return { success: false, responses: null, error: "Error fetching submitted issues: " + error.toString() };
    }
}

// Delete Issue (from any sheet)
function deleteIssue(ticketId, sheet) {
    try {
        const targetSheet = getSheet(sheet);
        const data = targetSheet.getDataRange().getValues();
        
        for (let i = 1; i < data.length; i++) {
            if (data[i][0] === ticketId) {
                targetSheet.deleteRow(i + 1);
                return {
                    success: true,
                    data: {
                        ticketId: ticketId,
                        sheet: sheet,
                        deleted: true
                    },
                    error: null
                };
            }
        }
        
        return { success: false, data: null, error: "Ticket not found in " + sheet };
    } catch (error) {
        return { success: false, data: null, error: error.toString() };
    }
}

// Get Dashboard Metrics
function getDashboardMetrics() {
    try {
        const pendingSheet = getSheet(SHEETS.PENDING_REVIEW);
        const liveSheet    = getSheet(SHEETS.LIVE_ISSUES);
        const closedSheet  = getSheet(SHEETS.CLOSED_ISSUES);

        const pendingData = pendingSheet.getDataRange().getValues();
        const liveData    = liveSheet.getDataRange().getValues();
        const closedData  = closedSheet.getDataRange().getValues();

        let totalPending      = 0;
        let totalActive       = liveData.length - 1;
        const totalClosed     = closedData.length - 1;
        let criticalPending   = 0;
        let slaBreaches       = 0;
        let agingIssues       = 0;
        const categoryBreakdown = {};
        const towerBreakdown    = {};

        for (let i = firstDataRow_(pendingData); i < pendingData.length; i++) {
            const r = pendingData[i];
            if ((r[PENDING_COL.STATE] || "PENDING_APPROVAL") !== "PENDING_APPROVAL") continue;
            totalPending++;
            if (String(r[PENDING_COL.SEVERITY] || "").toUpperCase() === "CRITICAL") criticalPending++;
        }

        const today = new Date();
        let totalClosureTime = 0;
        const slaOn = getFeatureFlag("FEATURE_SLA");

        for (let i = 1; i < liveData.length; i++) {
            const r = liveData[i];
            const category = String(r[LIVE_COL.CATEGORY] || "Uncategorised");
            const tower    = String(r[LIVE_COL.TOWER]    || "Unknown");
            const sla      = (slaOn && r[LIVE_COL.SLA_DATE]) ? new Date(r[LIVE_COL.SLA_DATE]) : null;
            const updated  = r[LIVE_COL.DATE_ASSIGNED] ? new Date(r[LIVE_COL.DATE_ASSIGNED]) : null;

            if (sla && today > sla) slaBreaches++;
            if (updated && (today - updated) > 7 * 24 * 60 * 60 * 1000) agingIssues++;

            categoryBreakdown[category] = (categoryBreakdown[category] || 0) + 1;
            towerBreakdown[tower]       = (towerBreakdown[tower]    || 0) + 1;
        }

        // Closed sheet adds [reason, closedDate, closedBy, resolutionDays] at
        // offsets LIVE_WIDTH..LIVE_WIDTH+3. Resolution days is at LIVE_WIDTH+3.
        const resolutionIdx = LIVE_WIDTH + 3;
        for (let i = 1; i < closedData.length; i++) {
            totalClosureTime += Number(closedData[i][resolutionIdx]) || 0;
        }
        const avgClosureTime = totalClosed > 0 ? (totalClosureTime / totalClosed).toFixed(1) : 0;
        
        return {
            success: true,
            data: {
                totalPending: totalPending,
                totalActive: totalActive,
                totalClosed: totalClosed,
                criticalPending: criticalPending,
                slaBreaches: slaBreaches,
                categoryBreakdown: categoryBreakdown,
                towerBreakdown: towerBreakdown,
                agingIssues: agingIssues,
                avgClosureTime: parseFloat(avgClosureTime),
                builderWorkload: totalActive
            },
            error: null
        };
    } catch (error) {
        return { success: false, data: null, error: error.toString() };
    }
}

// Server-callable wrapper around generateTicketID(). Kept for backward
// compatibility with the api_call switch; intake mints the ticket id
// directly, so most callers no longer need this.
function generateTicketId() {
    try {
        return { success: true, data: { ticketId: generateTicketID() }, error: null };
    } catch (error) {
        return { success: false, data: null, error: error.toString() };
    }
}

// Deprecated: ticket IDs are now minted at intake (TKT-XXXXX) and never
// re-issued. Retained as a thin compatibility shim — it ignores
// newTicketId, accepts the committee-chosen severity, and delegates to
// approveIssue().
function approveIssueWithTicketId(originalTicketId, newTicketId, userEmail, severity) {
    return approveIssue(originalTicketId, userEmail || "", severity);
}

// Main Post Handler
// NOTE: Google Apps Script ContentService automatically sends 
// Access-Control-Allow-Origin: * for web apps deployed as "Anyone".
// We use text/plain Content-Type from the client to avoid CORS preflight.

// NOTE: doGet is defined in Router.gs (renders the HtmlService dashboards).
// doPost remains here for any external/legacy JSON callers. When the web
// app is deployed with executeAs=USER_ACCESSING, Session.getActiveUser()
// returns the verified email; the request body is NEVER trusted for identity.

function doPost(e) {
    try {
        // Parse request body
        let payload = {};
        if (e.postData && e.postData.contents) {
            payload = JSON.parse(e.postData.contents);
        }

        const action = payload.action;
        // Server-trusted identity. Falls back to empty -> UNKNOWN -> denied.
        const userEmail = (Session.getActiveUser().getEmail() || "").trim();

        Logger.log(`API Request: action=${action}, user=${userEmail}`);

        const userRole = validateUserAccess(userEmail);
        if (!userRole || !userRole.hasAccess) {
            return ContentService.createTextOutput(JSON.stringify({
                success: false,
                error: "Unauthorized: sign in with an authorized Google account"
            })).setMimeType(ContentService.MimeType.JSON);
        }
        
        let result;
        switch(action) {
            case "getFormResponses":
                result = getFormResponses();
                break;
            case "getIssuesWithStatus":
                result = getIssuesWithStatus();
                break;
            case "getPendingIssues":
                result = getPendingIssues();
                break;
            case "approveIssue":
                result = approveIssue(payload.ticketId, userEmail);
                break;
            case "rejectIssue":
                result = rejectIssue(payload.ticketId, payload.reason, userEmail);
                break;
            case "getLiveIssues":
                result = getLiveIssues(payload.filterOption || "ALL");
                break;
            case "updateBuilderStatus":
                result = updateBuilderStatus(payload.ticketId, payload.status, payload.comment, payload.vendor, payload.closureDate);
                break;
            case "closeIssue":
                result = closeIssue(payload.ticketId, payload.reason, userEmail);
                break;
            case "reopenIssue":
                result = reopenIssue(payload.ticketId, payload.reason, userEmail);
                break;
            case "deleteIssue":
                result = deleteIssue(payload.ticketId, payload.sheet || SHEETS.PENDING_REVIEW);
                break;
            case "generateTicketId":
                result = generateTicketId();
                break;
            case "approveIssueWithTicketId":
                result = approveIssueWithTicketId(payload.originalTicketId, payload.newTicketId);
                break;
            case "getDashboardMetrics":
                result = getDashboardMetrics();
                break;
            case "validateUserAccess":
                result = { success: true, data: userRole, error: null };
                break;
            case "syncFormResponses":
                result = syncFormResponses();
                break;
            case "submitIssue":
                result = submitIssue(payload, userEmail);
                break;
            case "getCategoryMaster":
                result = getCategoryMaster();
                break;
            case "getClientConfig":
                result = getClientConfig();
                break;
            default:
                result = { success: false, error: "Unknown action: " + action };
        }
        
        return ContentService.createTextOutput(JSON.stringify(result))
            .setMimeType(ContentService.MimeType.JSON);
        
    } catch (error) {
        Logger.log("API Error: " + error.toString());
        return ContentService.createTextOutput(JSON.stringify({
            success: false,
            error: error.toString()
        })).setMimeType(ContentService.MimeType.JSON);
    }
}

// =====================================================================
// SCHEMA DIAGNOSTIC
// Returns header rows + first 2 data rows for the sheets that drive the
// portal. Used by ?diag=sheets endpoint to verify column constants match
// the live spreadsheet layout.
// =====================================================================
function diag_sheetSchemas_() {
    const names = [
        SHEETS.FORM_RESPONSES,
        SHEETS.PENDING_REVIEW,
        SHEETS.ARCHIVES_ISSUES,
        SHEETS.LIVE_ISSUES,
        SHEETS.CLOSED_ISSUES
    ];
    const ss = getSpreadsheet();
    const out = { spreadsheet: ss.getName(), sheets: {} };

    for (var i = 0; i < names.length; i++) {
        var name = names[i];
        try {
            var sh = ss.getSheetByName(name);
            if (!sh) { out.sheets[name] = { exists: false }; continue; }
            var lastCol = sh.getLastColumn();
            var lastRow = sh.getLastRow();
            var headers = lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getValues()[0] : [];
            var sampleRows = [];
            var take = Math.min(2, Math.max(0, lastRow - 1));
            if (take > 0 && lastCol > 0) {
                sampleRows = sh.getRange(2, 1, take, lastCol).getValues();
            }
            out.sheets[name] = {
                exists: true,
                rows: lastRow,
                cols: lastCol,
                headers: headers.map(String),
                samples: sampleRows.map(function (r) {
                    return r.map(function (v) {
                        if (v instanceof Date) return v.toISOString();
                        return v === null || v === undefined ? "" : String(v);
                    });
                })
            };
        } catch (err) {
            out.sheets[name] = { exists: false, error: String(err) };
        }
    }
    return out;
}

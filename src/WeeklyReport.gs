// ============================================================================
// WeeklyReport.gs - Two PDF reports committed to GitHub.
//
// Gated by FEATURE_WEEKLY_REPORT_BACKUP (DEFAULT_FEATURES, default OFF).
// Reuses Backup.gs script properties (GITHUB_TOKEN / GITHUB_REPO /
// GITHUB_BRANCH).
//
// FILES PRODUCED (both committed to the same repo+branch as the sheet
// backup, in the same `backups/` folder by default):
//
//   1. TA_IAP_Report.pdf       (a.k.a. "anonymised default report")
//      - Scope: PENDING + ACTIVE only (no closed, no rejected)
//      - PII redacted: resident name and flat number replaced with "—"
//      - No photos
//      - Built by `generateWeeklyReportPdf()` on the weekly trigger
//      - Linked from the login page (public-safe)
//
//   2. TA_IAP_Full_Report.pdf  (a.k.a. "full report")
//      - Scope: PENDING + ACTIVE + CLOSED + REJECTED
//      - Names, flats, descriptions kept as-is
//      - Photos embedded inline: server-side fallback now fetches Drive
//        thumbnails authenticated (UrlFetchApp + script OAuth) and
//        embeds them via DocumentApp.Body.appendImage. Capped at
//        4 per issue / 60 per report to keep PDF size + execution
//        time bounded. The dashboard wizard's `commitFullReportPdf`
//        path still wins when the wizard is used, but the cron file
//        is no longer text-only.
//      - Linked from EVERY page (login, submitted, committee, builder,
//        admin) via a small "View Full Report" pill that resolves to
//        FULL_REPORT_PUBLIC_URL (auto-derived from BACKUP_REPO when
//        the operator hasn't set the tunable).
//
// FIRST-TIME SETUP (run once in the Apps Script editor):
//   1. Confirm Backup.gs script properties (GITHUB_TOKEN, etc.) are set.
//   2. (Optional) override path / names via script properties:
//        WEEKLY_REPORT_DIR       = backups                    (default)
//        WEEKLY_REPORT_FILE      = TA_IAP_Report.pdf          (default)
//        FULL_REPORT_FILE        = TA_IAP_Full_Report.pdf     (default)
//   3. Set FEATURE_WEEKLY_REPORT_BACKUP = "true" in the CONFIG sheet,
//      then `clearConfigCache`.
//   4. Set tunables in the CONFIG sheet:
//        WEEKLY_REPORT_PUBLIC_URL  = raw URL to TA_IAP_Report.pdf
//        FULL_REPORT_PUBLIC_URL    = raw URL to TA_IAP_Full_Report.pdf
//      Recommended values (raw.githubusercontent.com):
//        https://raw.githubusercontent.com/tadeskops/ta-issue-manager/main/backups/TA_IAP_Report.pdf
//        https://raw.githubusercontent.com/tadeskops/ta-issue-manager/main/backups/TA_IAP_Full_Report.pdf
//      Leaving either blank hides the corresponding UI button.
//   5. Run `installWeeklyReportTrigger` once - schedules the weekly job
//      (Mon 03:00 IST) which builds BOTH PDFs.
//
// PUBLIC FUNCTIONS:
//   generateWeeklyReportPdf()    -> manual: build + commit anonymised
//   generateFullReportPdf()      -> manual: build + commit full (server-side, embeds photos)
//   commitFullReportPdf(b64, src)-> API: accept wizard-rendered PDF bytes
//                                  from a dashboard and commit them as
//                                  TA_IAP_Full_Report.pdf (overwrites).
//   weeklyReportJob()            -> trigger handler; do not call directly
//   installWeeklyReportTrigger() -> schedule weeklyReportJob
// ============================================================================

const WEEKLY_REPORT_DEFAULTS = {
    DIR:         "backups",
    FILE:        "TA_IAP_Report.pdf",
    FULL_FILE:   "TA_IAP_Full_Report.pdf"
};

// Hard cap on accepted wizard payload size (decoded). 30 MB is well under
// Apps Script's request limit and well over a typical export with a few
// dozen photos.
const FULL_REPORT_MAX_BYTES = 30 * 1024 * 1024;

function weeklyReport_props_() {
    const p = PropertiesService.getScriptProperties();
    const base = backup_props_();
    return {
        token:    base.token,
        repo:     base.repo,
        branch:   base.branch,
        dir:      (p.getProperty("WEEKLY_REPORT_DIR")  || WEEKLY_REPORT_DEFAULTS.DIR).replace(/^\/+|\/+$/g, ""),
        filename: p.getProperty("WEEKLY_REPORT_FILE")  || WEEKLY_REPORT_DEFAULTS.FILE,
        fullName: p.getProperty("FULL_REPORT_FILE")    || WEEKLY_REPORT_DEFAULTS.FULL_FILE
    };
}

// ----------------------------------------------------------------------------
// SCOPED ROW READERS
// Each returns a flat array of plain objects ready for the renderer. Photos
// are included only on full-scope rows (server fallback never embeds them
// regardless; the field is informational only).
// ----------------------------------------------------------------------------

function weeklyReport_readPending_() {
    const sheet = getSheet(SHEETS.PENDING_REVIEW);
    const data  = sheet.getDataRange().getValues();
    const out = [];
    for (let i = firstDataRow_(data); i < data.length; i++) {
        const r = data[i];
        if (!r[PENDING_COL.TICKET_ID]) continue;
        const state = String(r[PENDING_COL.STATE] || "PENDING_APPROVAL");
        if (state === "APPROVED") continue;     // moved to LIVE
        if (state === "REJECTED") continue;     // archives
        out.push({
            ticketId:    String(r[PENDING_COL.TICKET_ID]),
            dateReported: r[PENDING_COL.DATE_REPORTED],
            resident:    String(r[PENDING_COL.RESIDENT] || ""),
            tower:       String(r[PENDING_COL.TOWER] || ""),
            flat:        String(r[PENDING_COL.FLAT] || ""),
            category:    String(r[PENDING_COL.CATEGORY] || ""),
            subcategory: String(r[PENDING_COL.SUBCATEGORY] || ""),
            severity:    String(r[PENDING_COL.SEVERITY] || ""),
            description: String(r[PENDING_COL.DESCRIPTION] || ""),
            photoLinks:  splitPhotoLinks_(r[PENDING_COL.PHOTO]),
            status:      state,
            section:     "Pending"
        });
    }
    return out;
}

function weeklyReport_readActive_() {
    const sheet = getSheet(SHEETS.LIVE_ISSUES);
    const data  = sheet.getDataRange().getValues();
    const out = [];
    for (let i = firstDataRow_(data); i < data.length; i++) {
        const r = data[i];
        if (!r[LIVE_COL.TICKET_ID]) continue;
        out.push({
            ticketId:    String(r[LIVE_COL.TICKET_ID]),
            dateReported: r[LIVE_COL.DATE_REPORTED],
            resident:    String(r[LIVE_COL.RESIDENT] || ""),
            tower:       String(r[LIVE_COL.TOWER] || ""),
            flat:        String(r[LIVE_COL.FLAT] || ""),
            category:    String(r[LIVE_COL.CATEGORY] || ""),
            subcategory: String(r[LIVE_COL.SUBCATEGORY] || ""),
            severity:    String(r[LIVE_COL.SEVERITY] || ""),
            description: String(r[LIVE_COL.DESCRIPTION] || ""),
            photoLinks:  splitPhotoLinks_(r[LIVE_COL.PHOTO]),
            status:      String(r[LIVE_COL.STATUS] || "ASSIGNED"),
            section:     "Active"
        });
    }
    return out;
}

function weeklyReport_readClosed_() {
    const sheet = getSheet(SHEETS.CLOSED_ISSUES);
    const data  = sheet.getDataRange().getValues();
    const out = [];
    const CLOSED_AT_IDX = LIVE_WIDTH + 1;
    for (let i = firstDataRow_(data); i < data.length; i++) {
        const r = data[i];
        if (!r[LIVE_COL.TICKET_ID]) continue;
        out.push({
            ticketId:    String(r[LIVE_COL.TICKET_ID]),
            dateReported: r[LIVE_COL.DATE_REPORTED],
            resident:    String(r[LIVE_COL.RESIDENT] || ""),
            tower:       String(r[LIVE_COL.TOWER] || ""),
            flat:        String(r[LIVE_COL.FLAT] || ""),
            category:    String(r[LIVE_COL.CATEGORY] || ""),
            subcategory: String(r[LIVE_COL.SUBCATEGORY] || ""),
            severity:    String(r[LIVE_COL.SEVERITY] || ""),
            description: String(r[LIVE_COL.DESCRIPTION] || ""),
            photoLinks:  splitPhotoLinks_(r[LIVE_COL.PHOTO]),
            status:      "CLOSED",
            closedAt:    r[CLOSED_AT_IDX],
            section:     "Closed"
        });
    }
    return out;
}

function weeklyReport_readRejected_() {
    const sheet = getSheet(SHEETS.ARCHIVES_ISSUES);
    const data  = sheet.getDataRange().getValues();
    const out = [];
    for (let i = firstDataRow_(data); i < data.length; i++) {
        const r = data[i];
        if (!r[PENDING_COL.TICKET_ID]) continue;
        out.push({
            ticketId:    String(r[PENDING_COL.TICKET_ID]),
            dateReported: r[PENDING_COL.DATE_REPORTED],
            resident:    String(r[PENDING_COL.RESIDENT] || ""),
            tower:       String(r[PENDING_COL.TOWER] || ""),
            flat:        String(r[PENDING_COL.FLAT] || ""),
            category:    String(r[PENDING_COL.CATEGORY] || ""),
            subcategory: String(r[PENDING_COL.SUBCATEGORY] || ""),
            severity:    String(r[PENDING_COL.SEVERITY] || ""),
            description: String(r[PENDING_COL.DESCRIPTION] || ""),
            photoLinks:  splitPhotoLinks_(r[PENDING_COL.PHOTO]),
            rejectionReason: String(r[PENDING_COL.REJECTION_REASON] || ""),
            status:      "REJECTED",
            section:     "Rejected"
        });
    }
    return out;
}

// ----------------------------------------------------------------------------
// AGGREGATE STATS (used in both reports' summary section)
// ----------------------------------------------------------------------------

function weeklyReport_buildStats_(rows, includeClosed) {
    const byState     = {};
    const bySeverity  = {};
    const byCategory  = {};
    const byAgeBucket = {};
    const inc = function (o, k) { o[k] = (o[k] || 0) + 1; };
    const ageBucket = function (days) {
        if (days <= 1) return "0-1 days";
        if (days <= 3) return "2-3 days";
        if (days <= 7) return "4-7 days";
        if (days <= 14) return "8-14 days";
        if (days <= 30) return "15-30 days";
        return "30+ days";
    };
    const now = new Date();
    let resolutionDaysSum = 0;
    let resolutionDaysCount = 0;

    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        inc(byState,    r.status || "");
        if (r.severity) inc(bySeverity, r.severity);
        if (r.category) inc(byCategory, r.category);
        if (r.section !== "Closed" && r.dateReported instanceof Date && !isNaN(r.dateReported.getTime())) {
            const days = Math.floor((now.getTime() - r.dateReported.getTime()) / (1000 * 60 * 60 * 24));
            inc(byAgeBucket, ageBucket(days));
        }
        if (includeClosed && r.section === "Closed" &&
            r.dateReported instanceof Date && r.closedAt instanceof Date &&
            !isNaN(r.dateReported.getTime()) && !isNaN(r.closedAt.getTime())) {
            const d = Math.floor((r.closedAt.getTime() - r.dateReported.getTime()) / (1000 * 60 * 60 * 24));
            if (d >= 0) { resolutionDaysSum += d; resolutionDaysCount++; }
        }
    }

    return {
        generatedAt: now,
        totals:      {
            all:      rows.length,
            pending:  rows.filter(r => r.section === "Pending").length,
            active:   rows.filter(r => r.section === "Active").length,
            closed:   rows.filter(r => r.section === "Closed").length,
            rejected: rows.filter(r => r.section === "Rejected").length
        },
        byState:     byState,
        bySeverity:  bySeverity,
        byCategory:  byCategory,
        byAgeBucket: byAgeBucket,
        avgResolutionDays: (resolutionDaysCount > 0)
            ? Math.round((resolutionDaysSum / resolutionDaysCount) * 10) / 10
            : null
    };
}

function weeklyReport_sortDesc_(obj) {
    const keys = Object.keys(obj || {});
    keys.sort(function (a, b) { return (obj[b] || 0) - (obj[a] || 0); });
    return keys.map(function (k) { return [k, String(obj[k])]; });
}

// ----------------------------------------------------------------------------
// PDF RENDERER (DocumentApp -> PDF)
//   variant: "ANONYMISED" | "FULL"
// ----------------------------------------------------------------------------

function weeklyReport_renderPdfBlob_(rows, stats, variant) {
    const tz = Session.getScriptTimeZone() || "Asia/Kolkata";
    const stamp = Utilities.formatDate(stats.generatedAt, tz, "yyyy-MM-dd HH:mm z");
    const docName = "TA-IAP " + variant + " (temp) " +
                    Utilities.formatDate(stats.generatedAt, tz, "yyyyMMdd-HHmmss");
    const doc = DocumentApp.create(docName);
    const body = doc.getBody();
    body.clear();

    // Header
    body.appendParagraph("The Address - Issue Addressal Portal")
        .setHeading(DocumentApp.ParagraphHeading.HEADING1);
    const subtitle = (variant === "ANONYMISED")
        ? "Weekly Status Report (public, anonymised)"
        : "Weekly Full Report (committee/builder)";
    body.appendParagraph(subtitle)
        .setHeading(DocumentApp.ParagraphHeading.HEADING2);
    const metaText = (variant === "ANONYMISED")
        ? ("Generated " + stamp + " - Resident names and flat numbers redacted. Closed and rejected issues not included.")
        : ("Generated " + stamp + " - Full content (pending + active + closed + rejected). Restricted distribution.");
    body.appendParagraph(metaText)
        .editAsText().setItalic(true).setForegroundColor("#666666");

    // Totals
    body.appendParagraph("").setHeading(DocumentApp.ParagraphHeading.NORMAL);
    body.appendParagraph("Totals").setHeading(DocumentApp.ParagraphHeading.HEADING2);
    const totalsRows = (variant === "ANONYMISED")
        ? [
            ["Pending approval", String(stats.totals.pending)],
            ["Active",           String(stats.totals.active)],
            ["Total in scope",   String(stats.totals.all)]
        ]
        : [
            ["Pending approval", String(stats.totals.pending)],
            ["Active",           String(stats.totals.active)],
            ["Closed",           String(stats.totals.closed)],
            ["Rejected",         String(stats.totals.rejected)],
            ["Total in scope",   String(stats.totals.all)]
        ];
    weeklyReport_appendKvTable_(body, totalsRows);

    // Status breakdown
    body.appendParagraph("Status breakdown").setHeading(DocumentApp.ParagraphHeading.HEADING2);
    weeklyReport_appendKvTable_(body, weeklyReport_sortDesc_(stats.byState));

    // Severity
    body.appendParagraph("Severity breakdown").setHeading(DocumentApp.ParagraphHeading.HEADING2);
    weeklyReport_appendKvTable_(body, weeklyReport_sortDesc_(stats.bySeverity));

    // Top categories
    body.appendParagraph("Top categories").setHeading(DocumentApp.ParagraphHeading.HEADING2);
    weeklyReport_appendKvTable_(body, weeklyReport_sortDesc_(stats.byCategory).slice(0, 12));

    // Age buckets
    body.appendParagraph("Open issues by age").setHeading(DocumentApp.ParagraphHeading.HEADING2);
    const ageOrder = ["0-1 days", "2-3 days", "4-7 days", "8-14 days", "15-30 days", "30+ days"];
    const ageRows = ageOrder
        .filter(k => stats.byAgeBucket[k])
        .map(k => [k, String(stats.byAgeBucket[k])]);
    weeklyReport_appendKvTable_(body, ageRows.length ? ageRows : [["(no open issues)", "0"]]);

    // Resolution time (full only)
    if (variant === "FULL" && stats.avgResolutionDays != null) {
        body.appendParagraph("Average resolution time").setHeading(DocumentApp.ParagraphHeading.HEADING2);
        weeklyReport_appendKvTable_(body, [["Closed issues, mean days from reported -> closed",
                                            stats.avgResolutionDays + " days"]]);
    }

    // Per-issue lists, grouped by section
    const sections = (variant === "ANONYMISED")
        ? ["Pending", "Active"]
        : ["Pending", "Active", "Closed", "Rejected"];
    // Total images budget across the whole document. Capped to keep
    // PDF size and execution time bounded — Drive thumbnail fetches at
    // w800 average ~60-100KB, so 60 images ≈ 5 MB of images.
    const photoBudget = { remaining: (variant === "FULL") ? 60 : 0 };
    sections.forEach(function (sec) {
        const slice = rows.filter(function (r) { return r.section === sec; });
        if (!slice.length) return;
        body.appendParagraph("").setHeading(DocumentApp.ParagraphHeading.NORMAL);
        body.appendParagraph(sec + " issues (" + slice.length + ")")
            .setHeading(DocumentApp.ParagraphHeading.HEADING2);
        weeklyReport_appendIssueTable_(body, slice, variant);
        if (variant === "FULL" && photoBudget.remaining > 0) {
            weeklyReport_appendPhotosBlock_(body, slice, photoBudget);
        }
    });

    // Footer
    body.appendParagraph("").setHeading(DocumentApp.ParagraphHeading.NORMAL);
    const discText = (variant === "ANONYMISED")
        ? ("This is the anonymised public report. Resident names and flat numbers are redacted. " +
           "Closed and rejected issues are not included. For per-issue detail, sign in to the portal.")
        : ("This is the full committee/builder report. Distribute only to authorised personnel. " +
           "It contains resident names, flat numbers, and complaint details.");
    body.appendParagraph(discText)
        .editAsText().setItalic(true).setForegroundColor("#888888").setFontSize(9);

    doc.saveAndClose();
    const docId = doc.getId();
    const bytes = DriveApp.getFileById(docId).getAs("application/pdf").getBytes();
    DriveApp.getFileById(docId).setTrashed(true);
    return bytes;
}

function weeklyReport_appendKvTable_(body, rows) {
    if (!rows || !rows.length) {
        body.appendParagraph("(none)").editAsText()
            .setItalic(true).setForegroundColor("#888888");
        return;
    }
    const t = body.appendTable(rows);
    for (let i = 0; i < t.getNumRows(); i++) {
        const row = t.getRow(i);
        if (row.getNumCells() >= 1) row.getCell(0).editAsText().setBold(true);
        if (row.getNumCells() >= 2) row.getCell(1).setAttributes({
            [DocumentApp.Attribute.HORIZONTAL_ALIGNMENT]: DocumentApp.HorizontalAlignment.RIGHT
        });
    }
}

// Per-issue table. Anonymised variant redacts resident + flat. Description
// is truncated to keep the PDF readable; full text remains on the sheet.
function weeklyReport_appendIssueTable_(body, slice, variant) {
    const headers = (variant === "ANONYMISED")
        ? ["Ticket", "Reported", "Tower", "Category", "Severity", "Status", "Description"]
        : ["Ticket", "Reported", "Tower / Flat", "Resident", "Category", "Severity", "Status", "Description"];
    const rows = [headers];
    const tz = Session.getScriptTimeZone() || "Asia/Kolkata";
    const fmt = function (d) {
        if (!(d instanceof Date) || isNaN(d.getTime())) return "";
        return Utilities.formatDate(d, tz, "yyyy-MM-dd");
    };
    const trim = function (s, n) {
        s = String(s || "");
        if (s.length <= n) return s;
        return s.slice(0, n - 1) + "\u2026";
    };
    for (let i = 0; i < slice.length; i++) {
        const r = slice[i];
        if (variant === "ANONYMISED") {
            rows.push([
                r.ticketId,
                fmt(r.dateReported),
                r.tower || "—",
                r.category + (r.subcategory ? " / " + r.subcategory : ""),
                r.severity || "—",
                r.status,
                trim(r.description, 200)
            ]);
        } else {
            rows.push([
                r.ticketId,
                fmt(r.dateReported),
                (r.tower || "—") + " / " + (r.flat || "—"),
                r.resident || "—",
                r.category + (r.subcategory ? " / " + r.subcategory : ""),
                r.severity || "—",
                r.status,
                trim(r.description, 200)
            ]);
        }
    }
    const t = body.appendTable(rows);
    // Bold the header row
    if (t.getNumRows() > 0) {
        const hdr = t.getRow(0);
        for (let c = 0; c < hdr.getNumCells(); c++) {
            hdr.getCell(c).editAsText().setBold(true);
            hdr.getCell(c).setBackgroundColor("#f0f0f0");
        }
    }
}

// Append an inline photos block beneath an issue section's table.
// Used only by the FULL variant. Each issue with photos gets a small
// label ("Ticket — Photos (N)") and up to 4 thumbnails laid out in a
// 2-column inline table. Drive thumbnails are fetched authenticated via
// UrlFetchApp (the report runs server-side under the script owner, so
// any photo the script owner can read is reachable). Capped per-issue
// and globally via the shared budget object so the doc stays under
// the GitHub PDF size limit (~50 MB) and the Apps Script execution
// budget (~6 min).
function weeklyReport_appendPhotosBlock_(body, slice, budget) {
    const PER_ISSUE_CAP = 4;
    const THUMB_WIDTH_PX = 240;     // ~63 mm in the rendered PDF
    const THUMB_FETCH_W  = 800;     // request bigger source for crisper print
    for (let i = 0; i < slice.length; i++) {
        if (budget.remaining <= 0) break;
        const r = slice[i];
        const links = (r.photoLinks || []).filter(Boolean);
        if (!links.length) continue;
        const take = Math.min(links.length, PER_ISSUE_CAP, budget.remaining);
        const blobs = [];
        for (let j = 0; j < take; j++) {
            const id = driveFileIdFromUrl_(links[j]);
            if (!id) continue;
            const blob = weeklyReport_fetchDriveThumb_(id, THUMB_FETCH_W);
            if (blob) blobs.push(blob);
        }
        if (!blobs.length) continue;
        body.appendParagraph(r.ticketId + " — Photos (" + blobs.length + ")")
            .setHeading(DocumentApp.ParagraphHeading.HEADING3);
        // Lay out in a 2-column grid for readability.
        const cols = 2;
        const grid = [];
        for (let k = 0; k < blobs.length; k += cols) {
            const rowCells = [];
            for (let kk = 0; kk < cols; kk++) {
                rowCells.push(blobs[k + kk] ? "" : "");
            }
            grid.push(rowCells);
        }
        const t = body.appendTable(grid);
        let idx = 0;
        for (let rr = 0; rr < t.getNumRows(); rr++) {
            const row = t.getRow(rr);
            for (let cc = 0; cc < row.getNumCells(); cc++) {
                const blob = blobs[idx++];
                const cell = row.getCell(cc);
                cell.clear();
                if (!blob) continue;
                try {
                    const img = cell.appendImage(blob);
                    img.setWidth(THUMB_WIDTH_PX);
                    // Preserve aspect: appendImage gives natural
                    // dimensions, scaling width re-flows height.
                } catch (e) {
                    cell.appendParagraph("(photo unavailable)")
                        .editAsText().setItalic(true).setForegroundColor("#888888").setFontSize(8);
                }
            }
        }
        budget.remaining -= blobs.length;
    }
}

// Authenticated Drive thumbnail fetch. Returns a Blob (image/jpeg) or
// null when the fetch fails — never throws so a single broken photo
// can't sink the whole report.
function weeklyReport_fetchDriveThumb_(fileId, widthPx) {
    try {
        const url = "https://drive.google.com/thumbnail?id=" + fileId + "&sz=w" + widthPx;
        const resp = UrlFetchApp.fetch(url, {
            muteHttpExceptions: true,
            followRedirects:    true,
            headers: { "Authorization": "Bearer " + ScriptApp.getOAuthToken() }
        });
        const code = resp.getResponseCode();
        if (code < 200 || code >= 300) return null;
        const blob = resp.getBlob();
        const mime = (blob.getContentType() || "").toLowerCase();
        if (mime.indexOf("image/") !== 0) return null;
        return blob;
    } catch (e) {
        Logger.log("[wr-full] thumb fetch failed for " + fileId + ": " + e);
        return null;
    }
}

// ----------------------------------------------------------------------------
// PUBLIC: BUILD + COMMIT
// ----------------------------------------------------------------------------

// Anonymised default report (login-page).
function generateWeeklyReportPdf(reason) {
    Logger.log("========== generateWeeklyReportPdf START (reason=" + (reason || "manual") + ") ==========");
    if (!getFeatureFlag("FEATURE_WEEKLY_REPORT_BACKUP")) {
        const msg = "FEATURE_WEEKLY_REPORT_BACKUP is OFF. Set it to 'true' in CONFIG and clear cache.";
        Logger.log("[wr] ABORT: " + msg);
        return { success: false, error: msg };
    }
    const cfg = weeklyReport_props_();
    if (!cfg.token) {
        const msg = "GITHUB_TOKEN script property is not set. Set it under Project Settings.";
        Logger.log("[wr] ABORT: " + msg);
        return { success: false, error: msg };
    }
    try {
        const rows = [].concat(weeklyReport_readPending_(), weeklyReport_readActive_());
        Logger.log("[wr] anonymised rows: pending=" + rows.filter(r => r.section === "Pending").length +
                   " active=" + rows.filter(r => r.section === "Active").length);
        const stats = weeklyReport_buildStats_(rows, false);
        const bytes = weeklyReport_renderPdfBlob_(rows, stats, "ANONYMISED");
        Logger.log("[wr] anonymised PDF size: " + bytes.length + " bytes");

        const tz = Session.getScriptTimeZone() || "Asia/Kolkata";
        const stamp = Utilities.formatDate(stats.generatedAt, tz, "yyyy-MM-dd HH:mm z");
        const path  = cfg.dir + "/" + cfg.filename;
        const message = "weekly-report (anonymised): " + stamp +
                        (reason ? " [" + reason + "]" : "");
        const result = backup_putToGit_(cfg, path, bytes, message);
        const info = {
            variant: "ANONYMISED",
            path:    path,
            commit:  (result.commit && result.commit.sha) || "",
            url:     (result.content && result.content.html_url) || "",
            message: message,
            bytes:   bytes.length,
            totals:  stats.totals
        };
        Logger.log("[wr] anonymised SUCCESS: " + JSON.stringify(info));
        return { success: true, data: info };
    } catch (err) {
        Logger.log("[wr] anonymised FAILED: " + err + "\n" + (err && err.stack || ""));
        return { success: false, error: String(err) };
    }
}

// Full report — server-side build (embeds photos via authenticated Drive thumbnail fetch).
function generateFullReportPdf(reason) {
    Logger.log("========== generateFullReportPdf START (reason=" + (reason || "manual") + ") ==========");
    if (!getFeatureFlag("FEATURE_WEEKLY_REPORT_BACKUP")) {
        const msg = "FEATURE_WEEKLY_REPORT_BACKUP is OFF. Set it to 'true' in CONFIG and clear cache.";
        Logger.log("[wr-full] ABORT: " + msg);
        return { success: false, error: msg };
    }
    const cfg = weeklyReport_props_();
    if (!cfg.token) {
        const msg = "GITHUB_TOKEN script property is not set. Set it under Project Settings.";
        Logger.log("[wr-full] ABORT: " + msg);
        return { success: false, error: msg };
    }
    try {
        const rows = [].concat(
            weeklyReport_readPending_(),
            weeklyReport_readActive_(),
            weeklyReport_readClosed_(),
            weeklyReport_readRejected_()
        );
        Logger.log("[wr-full] rows: pending=" + rows.filter(r => r.section === "Pending").length +
                   " active=" + rows.filter(r => r.section === "Active").length +
                   " closed=" + rows.filter(r => r.section === "Closed").length +
                   " rejected=" + rows.filter(r => r.section === "Rejected").length);
        const stats = weeklyReport_buildStats_(rows, true);
        const bytes = weeklyReport_renderPdfBlob_(rows, stats, "FULL");
        Logger.log("[wr-full] full PDF size: " + bytes.length + " bytes");

        const tz = Session.getScriptTimeZone() || "Asia/Kolkata";
        const stamp = Utilities.formatDate(stats.generatedAt, tz, "yyyy-MM-dd HH:mm z");
        const path  = cfg.dir + "/" + cfg.fullName;
        const message = "weekly-report (full, server fallback): " + stamp +
                        (reason ? " [" + reason + "]" : "");
        const result = backup_putToGit_(cfg, path, bytes, message);
        const info = {
            variant: "FULL_SERVER",
            path:    path,
            commit:  (result.commit && result.commit.sha) || "",
            url:     (result.content && result.content.html_url) || "",
            message: message,
            bytes:   bytes.length,
            totals:  stats.totals
        };
        Logger.log("[wr-full] SUCCESS: " + JSON.stringify(info));
        return { success: true, data: info };
    } catch (err) {
        Logger.log("[wr-full] FAILED: " + err + "\n" + (err && err.stack || ""));
        return { success: false, error: String(err) };
    }
}

// Public API: accept a wizard-rendered PDF (base64-encoded bytes) from a
// dashboard's Export Report flow and commit it as TA_IAP_Full_Report.pdf
// (overwriting the previous full-report file).
//
// Called only from the Router when role is COMMITTEE or BUILDER (gated
// in isActionAllowed_). source is a free-text label ("committee", etc.)
// stored in the commit message for traceability.
function commitFullReportPdf(b64, source) {
    Logger.log("========== commitFullReportPdf START (source=" + (source || "?") + ") ==========");
    if (!getFeatureFlag("FEATURE_WEEKLY_REPORT_BACKUP")) {
        return { success: false, error: "FEATURE_WEEKLY_REPORT_BACKUP is OFF; set it to 'true' in CONFIG to enable report commits." };
    }
    if (!b64 || typeof b64 !== "string") {
        return { success: false, error: "Missing PDF bytes (b64 string required)." };
    }
    const cfg = weeklyReport_props_();
    if (!cfg.token) {
        return { success: false, error: "GITHUB_TOKEN script property is not set." };
    }
    try {
        // Strip data-URL prefix if the client included one.
        const cleaned = b64.replace(/^data:application\/pdf;base64,/i, "");
        const bytes = Utilities.base64Decode(cleaned);
        if (bytes.length > FULL_REPORT_MAX_BYTES) {
            return { success: false, error: "PDF too large (" + bytes.length +
                     " bytes). Max " + FULL_REPORT_MAX_BYTES + ". Reduce photos or columns and retry." };
        }
        // Sanity: PDF magic bytes "%PDF"
        if (bytes.length < 4 ||
            bytes[0] !== 37 || bytes[1] !== 80 || bytes[2] !== 68 || bytes[3] !== 70) {
            return { success: false, error: "Payload is not a PDF (missing %PDF header)." };
        }
        const tz = Session.getScriptTimeZone() || "Asia/Kolkata";
        const stamp = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd HH:mm z");
        const actor = (Session.getActiveUser().getEmail() || "unknown");
        const path  = cfg.dir + "/" + cfg.fullName;
        const message = "weekly-report (full, wizard): " + stamp +
                        " by " + actor +
                        " from=" + (source || "?");
        const result = backup_putToGit_(cfg, path, bytes, message);
        const info = {
            variant: "FULL_WIZARD",
            path:    path,
            commit:  (result.commit && result.commit.sha) || "",
            url:     (result.content && result.content.html_url) || "",
            message: message,
            bytes:   bytes.length
        };
        Logger.log("[wr-commit] SUCCESS: " + JSON.stringify(info));
        return { success: true, data: info };
    } catch (err) {
        Logger.log("[wr-commit] FAILED: " + err + "\n" + (err && err.stack || ""));
        return { success: false, error: String(err) };
    }
}

// Trigger handler. Builds BOTH PDFs sequentially. Logs each independently
// so a failure on one does not block the other.
function weeklyReportJob() {
    Logger.log("[trigger] weeklyReportJob fired at " + new Date().toISOString());
    const a = generateWeeklyReportPdf("weekly");
    Logger.log("[trigger] anonymised result: " + JSON.stringify(a));
    const b = generateFullReportPdf("weekly");
    Logger.log("[trigger] full server-fallback result: " + JSON.stringify(b));
    return { anonymised: a, full: b };
}

// One-shot trigger installer. Removes any prior weeklyReportJob trigger
// then creates a new one (Mondays around 03:00 in the script time zone -
// one hour after the sheet backup so it picks up that week's snapshot).
function installWeeklyReportTrigger() {
    Logger.log("[trigger] installWeeklyReportTrigger START");
    const existing = ScriptApp.getProjectTriggers();
    let removed = 0;
    for (let i = 0; i < existing.length; i++) {
        if (existing[i].getHandlerFunction() === "weeklyReportJob") {
            ScriptApp.deleteTrigger(existing[i]);
            removed++;
        }
    }
    Logger.log("[trigger] removed prior weeklyReportJob triggers: " + removed);
    const t = ScriptApp.newTrigger("weeklyReportJob")
        .timeBased()
        .onWeekDay(ScriptApp.WeekDay.MONDAY)
        .atHour(3)
        .create();
    Logger.log("[trigger] created trigger id=" + t.getUniqueId() +
               " handler=weeklyReportJob (Mondays ~03:00 " +
               (Session.getScriptTimeZone() || "Asia/Kolkata") + ")");
    return {
        success: true,
        message: "Weekly report trigger installed (Mondays ~03:00). Removed " +
                 removed + " prior trigger(s)."
    };
}

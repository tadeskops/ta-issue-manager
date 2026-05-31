// ============================================================================
// Backup.gs - Google Sheet -> GitHub backup + reset-from-form helpers.
//
// FIRST-TIME SETUP (run once in the Apps Script editor):
//   1. Open Project Settings -> Script Properties and add:
//        GITHUB_TOKEN  = <a fine-grained PAT with "Contents: Read & Write"
//                        on the repo>
//        GITHUB_REPO   = tadeskops/ta-issue-manager     (optional override)
//        GITHUB_BRANCH = main                           (optional override)
//        BACKUP_DIR    = backups                        (optional override)
//        BACKUP_FILE   = ta-issue-manager.xlsx          (optional override)
//   2. Run `installWeeklyBackupTrigger` once - approves OAuth scopes and
//      schedules the weekly backup job.
//
// PUBLIC FUNCTIONS:
//   backupSheetToGit()           -> manual one-shot backup
//   backupAndResetFromForm()     -> backup, then wipe PENDING_REVIEW +
//                                   LIVE_ISSUES and repopulate LIVE_ISSUES
//                                   from "Form Responses 1"
//   installWeeklyBackupTrigger() -> schedule weeklyBackupJob (Mon 02:00 IST)
//   weeklyBackupJob()            -> trigger handler; do not call directly
// ============================================================================

const BACKUP_DEFAULTS = {
    REPO:     "tadeskops/ta-issue-manager",
    BRANCH:   "main",
    DIR:      "backups",
    FILENAME: "ta-issue-manager.xlsx"
};

function backup_props_() {
    const p = PropertiesService.getScriptProperties();
    return {
        token:    p.getProperty("GITHUB_TOKEN")  || "",
        repo:     p.getProperty("GITHUB_REPO")   || BACKUP_DEFAULTS.REPO,
        branch:   p.getProperty("GITHUB_BRANCH") || BACKUP_DEFAULTS.BRANCH,
        dir:      (p.getProperty("BACKUP_DIR")   || BACKUP_DEFAULTS.DIR).replace(/^\/+|\/+$/g, ""),
        filename: p.getProperty("BACKUP_FILE")   || BACKUP_DEFAULTS.FILENAME
    };
}

// Monotonic version counter persisted in ScriptProperties.
function backup_nextVersion_() {
    const p = PropertiesService.getScriptProperties();
    const cur = parseInt(p.getProperty("BACKUP_VERSION") || "0", 10) || 0;
    const next = cur + 1;
    p.setProperty("BACKUP_VERSION", String(next));
    return next;
}

// Export the bound spreadsheet as XLSX bytes using the export endpoint
// authenticated with the current user's OAuth token.
function backup_exportXlsx_() {
    const url = "https://docs.google.com/spreadsheets/d/" + SHEET_ID +
                "/export?format=xlsx";
    const res = UrlFetchApp.fetch(url, {
        headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
        throw new Error("XLSX export failed: HTTP " + res.getResponseCode() +
                        " - " + res.getContentText().slice(0, 200));
    }
    return res.getBlob().getBytes();
}

// GET current SHA of a file in the repo, or null if it does not exist.
function backup_getRemoteSha_(cfg, path) {
    const url = "https://api.github.com/repos/" + cfg.repo +
                "/contents/" + encodeURI(path) +
                "?ref=" + encodeURIComponent(cfg.branch);
    const res = UrlFetchApp.fetch(url, {
        method: "get",
        headers: {
            Authorization: "Bearer " + cfg.token,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28"
        },
        muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    if (code === 404) return null;
    if (code !== 200) {
        throw new Error("GitHub GET contents failed: HTTP " + code +
                        " - " + res.getContentText().slice(0, 200));
    }
    return JSON.parse(res.getContentText()).sha;
}

// PUT the XLSX bytes to the repo, overwriting same filename.
function backup_putToGit_(cfg, path, bytes, commitMessage) {
    const sha = backup_getRemoteSha_(cfg, path);
    const url = "https://api.github.com/repos/" + cfg.repo +
                "/contents/" + encodeURI(path);
    const body = {
        message: commitMessage,
        content: Utilities.base64Encode(bytes),
        branch:  cfg.branch
    };
    if (sha) body.sha = sha;
    const res = UrlFetchApp.fetch(url, {
        method: "put",
        contentType: "application/json",
        headers: {
            Authorization: "Bearer " + cfg.token,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28"
        },
        payload: JSON.stringify(body),
        muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    if (code !== 200 && code !== 201) {
        throw new Error("GitHub PUT contents failed: HTTP " + code +
                        " - " + res.getContentText().slice(0, 300));
    }
    return JSON.parse(res.getContentText());
}

// Public: backup current spreadsheet as XLSX to {BACKUP_DIR}/{BACKUP_FILE}
// with commit message "backup: v{N} {YYYY-MM-DD HH:mm IST} [{reason}]".
function backupSheetToGit(reason) {
    const cfg = backup_props_();
    if (!cfg.token) {
        const msg = "GITHUB_TOKEN script property is not set. " +
                    "Open Project Settings -> Script Properties and add it.";
        Logger.log(msg);
        return { success: false, error: msg };
    }
    try {
        const bytes = backup_exportXlsx_();
        const version = backup_nextVersion_();
        const stamp = Utilities.formatDate(new Date(),
            Session.getScriptTimeZone() || "Asia/Kolkata",
            "yyyy-MM-dd HH:mm z");
        const path = cfg.dir + "/" + cfg.filename;
        const message = "backup: v" + version + " " + stamp +
                        (reason ? " [" + reason + "]" : "");
        const result = backup_putToGit_(cfg, path, bytes, message);
        const info = {
            version: version,
            path: path,
            commit: (result.commit && result.commit.sha) || "",
            url:    (result.content && result.content.html_url) || "",
            message: message
        };
        Logger.log("Backup OK: " + JSON.stringify(info));
        return { success: true, data: info };
    } catch (err) {
        Logger.log("Backup failed: " + err);
        return { success: false, error: String(err) };
    }
}

// Wipe data rows (keep header) on a sheet.
function backup_clearDataRows_(sheet) {
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow > 1 && lastCol > 0) {
        sheet.getRange(2, 1, lastRow - 1, lastCol).clearContent();
    }
}

// Map one Form Responses row to a LIVE_ISSUES row.
function backup_formRowToLive_(formRow, ticketId, actorEmail) {
    const row = newRow_(LIVE_WIDTH);
    const now = new Date();
    const sev = formRow[FORM_COL.SEVERITY] || "";
    row[LIVE_COL.TICKET_ID]     = ticketId;
    row[LIVE_COL.DATE_REPORTED] = formRow[FORM_COL.TIMESTAMP] || now;
    row[LIVE_COL.RESIDENT]      = formRow[FORM_COL.RESIDENT]    || "";
    row[LIVE_COL.FLAT]          = formRow[FORM_COL.FLAT]        || "";
    row[LIVE_COL.CATEGORY]      = formRow[FORM_COL.CATEGORY]    || "";
    row[LIVE_COL.SEVERITY]      = sev;
    row[LIVE_COL.TOWER]         = formRow[FORM_COL.TOWER]       || "";
    row[LIVE_COL.SUBCATEGORY]   = formRow[FORM_COL.SUBCATEGORY] || "";
    row[LIVE_COL.PHOTO]         = formRow[FORM_COL.PHOTO]       || "";
    row[LIVE_COL.DESCRIPTION]   = formRow[FORM_COL.LOCATION]    || "";
    row[LIVE_COL.BUILDER_STATUS]= "ASSIGNED";
    row[LIVE_COL.SLA_DATE]      = calculateSLADate(sev, formRow[FORM_COL.TIMESTAMP] || now);
    row[LIVE_COL.STATUS]        = "APPROVED";
    row[LIVE_COL.ACTION_BY]     = actorEmail || "";
    row[LIVE_COL.LAST_UPDATED]  = now;
    return row;
}

// Public: backup spreadsheet, then wipe PENDING_REVIEW + LIVE_ISSUES and
// repopulate LIVE_ISSUES from every row in "Form Responses 1".
function backupAndResetFromForm() {
    const backup = backupSheetToGit("pre-reset");
    if (!backup.success) {
        return {
            success: false,
            error: "Aborted: backup failed before reset. " + backup.error
        };
    }
    try {
        const formSheet    = getSheet(SHEETS.FORM_RESPONSES);
        const pendingSheet = getSheet(SHEETS.PENDING_REVIEW);
        const liveSheet    = getSheet(SHEETS.LIVE_ISSUES);

        const formData = formSheet.getDataRange().getValues();
        if (formData.length < 2) {
            backup_clearDataRows_(pendingSheet);
            backup_clearDataRows_(liveSheet);
            return {
                success: true,
                data: {
                    backup: backup.data,
                    inserted: 0,
                    message: "Sheets reset. Form Responses 1 is empty."
                }
            };
        }

        backup_clearDataRows_(pendingSheet);
        backup_clearDataRows_(liveSheet);

        const actor = (Session.getActiveUser() && Session.getActiveUser().getEmail()) || "";
        const rows = [];
        const pad5 = function (n) { return String(n).padStart(5, "0"); };
        for (let i = 1; i < formData.length; i++) {
            const ticketId = "TKT-" + pad5(i);
            rows.push(backup_formRowToLive_(formData[i], ticketId, actor));
        }
        if (rows.length) {
            liveSheet.getRange(2, 1, rows.length, LIVE_WIDTH).setValues(rows);
        }
        return {
            success: true,
            data: {
                backup: backup.data,
                inserted: rows.length,
                message: "Backed up, reset PENDING_REVIEW + LIVE_ISSUES, " +
                         "and inserted " + rows.length + " rows into LIVE_ISSUES."
            }
        };
    } catch (err) {
        Logger.log("Reset failed: " + err);
        return {
            success: false,
            error: "Reset error after successful backup: " + String(err),
            data: { backup: backup.data }
        };
    }
}

// One-shot trigger installer. Removes any prior weeklyBackupJob trigger then
// creates a new one (Mondays around 02:00 in the script time zone).
function installWeeklyBackupTrigger() {
    const existing = ScriptApp.getProjectTriggers();
    for (let i = 0; i < existing.length; i++) {
        if (existing[i].getHandlerFunction() === "weeklyBackupJob") {
            ScriptApp.deleteTrigger(existing[i]);
        }
    }
    ScriptApp.newTrigger("weeklyBackupJob")
        .timeBased()
        .onWeekDay(ScriptApp.WeekDay.MONDAY)
        .atHour(2)
        .create();
    return { success: true, message: "Weekly backup trigger installed (Mondays ~02:00)." };
}

// Trigger handler. Do not call directly.
function weeklyBackupJob() {
    return backupSheetToGit("weekly");
}

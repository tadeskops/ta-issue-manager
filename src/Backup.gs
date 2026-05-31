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
    Logger.log("[backup] exporting spreadsheet " + SHEET_ID + " as XLSX...");
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
    const bytes = res.getBlob().getBytes();
    Logger.log("[backup] XLSX export OK (" + bytes.length + " bytes)");
    return bytes;
}

// GET current SHA of a file in the repo, or null if it does not exist.
function backup_getRemoteSha_(cfg, path) {
    Logger.log("[backup] checking remote file: " + cfg.repo + "@" + cfg.branch + ":" + path);
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
    if (code === 404) {
        Logger.log("[backup] remote file not found (will create new)");
        return null;
    }
    if (code !== 200) {
        throw new Error("GitHub GET contents failed: HTTP " + code +
                        " - " + res.getContentText().slice(0, 200));
    }
    const sha = JSON.parse(res.getContentText()).sha;
    Logger.log("[backup] remote file exists, sha=" + sha);
    return sha;
}

// PUT the XLSX bytes to the repo, overwriting same filename.
function backup_putToGit_(cfg, path, bytes, commitMessage) {
    const sha = backup_getRemoteSha_(cfg, path);
    Logger.log("[backup] PUT " + path + " (" + bytes.length + " bytes)" +
               (sha ? " updating sha=" + sha : " creating new"));
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
    Logger.log("[backup] GitHub PUT response: HTTP " + code);
    if (code !== 200 && code !== 201) {
        throw new Error("GitHub PUT contents failed: HTTP " + code +
                        " - " + res.getContentText().slice(0, 300));
    }
    return JSON.parse(res.getContentText());
}

// Public: backup current spreadsheet as XLSX to {BACKUP_DIR}/{BACKUP_FILE}
// with commit message "backup: v{N} {YYYY-MM-DD HH:mm IST} [{reason}]".
function backupSheetToGit(reason) {
    Logger.log("========== backupSheetToGit START (reason=" + (reason || "manual") + ") ==========");
    const cfg = backup_props_();
    Logger.log("[backup] config: repo=" + cfg.repo + " branch=" + cfg.branch +
               " path=" + cfg.dir + "/" + cfg.filename +
               " tokenSet=" + (!!cfg.token));
    if (!cfg.token) {
        const msg = "GITHUB_TOKEN script property is not set. " +
                    "Open Project Settings -> Script Properties and add it.";
        Logger.log("[backup] ABORT: " + msg);
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
        Logger.log("[backup] commit message: " + message);
        const result = backup_putToGit_(cfg, path, bytes, message);
        const info = {
            version: version,
            path: path,
            commit: (result.commit && result.commit.sha) || "",
            url:    (result.content && result.content.html_url) || "",
            message: message
        };
        Logger.log("[backup] SUCCESS: " + JSON.stringify(info));
        Logger.log("========== backupSheetToGit END (success) ==========");
        return { success: true, data: info };
    } catch (err) {
        Logger.log("[backup] FAILED: " + err + "\n" + (err && err.stack || ""));
        Logger.log("========== backupSheetToGit END (failure) ==========");
        return { success: false, error: String(err) };
    }
}

// Wipe data rows (keep header) on a sheet, including any data validations
// on the cleared range so a subsequent bulk-insert is not rejected by stale
// dropdown rules.
function backup_clearDataRows_(sheet) {
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow > 1 && lastCol > 0) {
        const range = sheet.getRange(2, 1, lastRow - 1, lastCol);
        range.clearContent();
        range.clearDataValidations();
    }
}

// Map one Form Responses row to a PENDING_REVIEW row.
function backup_formRowToPending_(formRow, ticketId, actorEmail) {
    const row = newRow_(PENDING_WIDTH);
    const now = new Date();
    row[PENDING_COL.TICKET_ID]        = ticketId;
    row[PENDING_COL.DATE_REPORTED]    = formRow[FORM_COL.TIMESTAMP]   || now;
    row[PENDING_COL.RESIDENT]         = formRow[FORM_COL.RESIDENT]    || "";
    row[PENDING_COL.FLAT]             = formRow[FORM_COL.FLAT]        || "";
    row[PENDING_COL.CATEGORY]         = formRow[FORM_COL.CATEGORY]    || "";
    row[PENDING_COL.SUBCATEGORY]      = formRow[FORM_COL.SUBCATEGORY] || "";
    row[PENDING_COL.SEVERITY]         = formRow[FORM_COL.SEVERITY]    || "";
    row[PENDING_COL.TOWER]            = formRow[FORM_COL.TOWER]       || "";
    row[PENDING_COL.PHOTO]            = formRow[FORM_COL.PHOTO]       || "";
    row[PENDING_COL.DESCRIPTION]      = formRow[FORM_COL.LOCATION]    || "";
    row[PENDING_COL.SUBMITTED_BY]     = actorEmail || "";
    row[PENDING_COL.ACTION_DATE]      = "";
    row[PENDING_COL.ACTION_BY]        = "";
    row[PENDING_COL.REJECTION_REASON] = "";
    row[PENDING_COL.STATE]            = "PENDING_APPROVAL";
    return row;
}

// Public: backup spreadsheet, then wipe PENDING_REVIEW + LIVE_ISSUES and
// repopulate PENDING_REVIEW from every row in "Form Responses 1" with
// state="SUBMITTED". LIVE_ISSUES stays empty - rows only land there when
// the committee accepts a pending issue.
function backupAndResetFromForm() {
    Logger.log("########## backupAndResetFromForm START ##########");
    const backup = backupSheetToGit("pre-reset");
    if (!backup.success) {
        Logger.log("[reset] ABORTING: backup failed, no destructive action taken");
        return {
            success: false,
            error: "Aborted: backup failed before reset. " + backup.error
        };
    }
    Logger.log("[reset] backup OK -> proceeding to wipe + repopulate");
    try {
        const formSheet    = getSheet(SHEETS.FORM_RESPONSES);
        const pendingSheet = getSheet(SHEETS.PENDING_REVIEW);
        const liveSheet    = getSheet(SHEETS.LIVE_ISSUES);
        Logger.log("[reset] sheets resolved (form/pending/live)");
        const pendingHeader = pendingSheet.getRange(1, 1, 1, pendingSheet.getLastColumn()).getValues()[0];
        Logger.log("[reset] PENDING_REVIEW header (" + pendingHeader.length + " cols): " + JSON.stringify(pendingHeader));

        const formData = formSheet.getDataRange().getValues();
        Logger.log("[reset] Form Responses rows (incl. header): " + formData.length);
        if (formData.length < 2) {
            backup_clearDataRows_(pendingSheet);
            backup_clearDataRows_(liveSheet);
            Logger.log("[reset] form is empty - cleared both sheets, nothing to insert");
            Logger.log("########## backupAndResetFromForm END (empty form) ##########");
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
        Logger.log("[reset] cleared PENDING_REVIEW data rows");
        backup_clearDataRows_(liveSheet);
        Logger.log("[reset] cleared LIVE_ISSUES data rows");

        const actor = (Session.getActiveUser() && Session.getActiveUser().getEmail()) || "";
        Logger.log("[reset] actor email: " + (actor || "(empty)"));
        const rows = [];
        const pad5 = function (n) { return String(n).padStart(5, "0"); };
        for (let i = 1; i < formData.length; i++) {
            const ticketId = "TKT-" + pad5(i);
            rows.push(backup_formRowToPending_(formData[i], ticketId, actor));
        }
        Logger.log("[reset] mapped " + rows.length + " rows from form -> PENDING_REVIEW");
        if (rows.length) {
            const writeRange = pendingSheet.getRange(2, 1, rows.length, PENDING_WIDTH);
            writeRange.clearDataValidations();
            Logger.log("[reset] cleared data validations on write range (" + rows.length + " x " + PENDING_WIDTH + ")");
            writeRange.setValues(rows);
            Logger.log("[reset] wrote " + rows.length + " rows into PENDING_REVIEW with state=PENDING_APPROVAL");
        }
        Logger.log("########## backupAndResetFromForm END (success, inserted=" + rows.length + ") ##########");
        return {
            success: true,
            data: {
                backup: backup.data,
                inserted: rows.length,
                message: "Backed up, reset PENDING_REVIEW + LIVE_ISSUES, " +
                         "and inserted " + rows.length + " rows into PENDING_REVIEW (state=PENDING_APPROVAL)."
            }
        };
    } catch (err) {
        Logger.log("[reset] FAILED after backup: " + err + "\n" + (err && err.stack || ""));
        Logger.log("########## backupAndResetFromForm END (failure) ##########");
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
    Logger.log("[trigger] installWeeklyBackupTrigger START");
    const existing = ScriptApp.getProjectTriggers();
    Logger.log("[trigger] existing project triggers: " + existing.length);
    let removed = 0;
    for (let i = 0; i < existing.length; i++) {
        if (existing[i].getHandlerFunction() === "weeklyBackupJob") {
            ScriptApp.deleteTrigger(existing[i]);
            removed++;
        }
    }
    Logger.log("[trigger] removed prior weeklyBackupJob triggers: " + removed);
    const t = ScriptApp.newTrigger("weeklyBackupJob")
        .timeBased()
        .onWeekDay(ScriptApp.WeekDay.MONDAY)
        .atHour(2)
        .create();
    Logger.log("[trigger] created trigger id=" + t.getUniqueId() +
               " handler=weeklyBackupJob (Mondays ~02:00 " +
               (Session.getScriptTimeZone() || "Asia/Kolkata") + ")");
    const msg = "Weekly backup trigger installed (Mondays ~02:00). " +
                "Removed " + removed + " prior trigger(s).";
    Logger.log("[trigger] DONE: " + msg);
    return { success: true, message: msg };
}

// Trigger handler. Do not call directly.
function weeklyBackupJob() {
    Logger.log("[trigger] weeklyBackupJob fired at " + new Date().toISOString());
    const r = backupSheetToGit("weekly");
    Logger.log("[trigger] weeklyBackupJob result: " + JSON.stringify(r));
    return r;
}

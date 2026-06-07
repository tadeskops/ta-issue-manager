// ============================================================================
// Recovery.gs — operator-run recovery & maintenance functions.
//
// These functions are NOT exposed through `api_call`. Run them manually
// from the Apps Script editor when the spreadsheet is in a bad state
// (duplicate ticket ids, drifted counter, lost pending rows, etc.).
//
// All recovery functions take a full XLSX backup to GitHub before they
// touch a single cell — the backup is the rollback path. If the backup
// step throws, recovery still proceeds (recovery is logged), but the
// operator should investigate the GitHub credentials first.
//
// PUBLIC FUNCTIONS:
//   renumberAllTicketIds()    -> rewrite TICKET_ID across PENDING_REVIEW,
//                                LIVE_ISSUES, CLOSED_ISSUES, ARCHIVES_ISSUES
//                                as a single monotonic TKT-NNNNN series
//                                sorted by date-reported. Resets the
//                                TICKET_COUNTER ScriptProperty to match.
//   recoverPendingFromForm()  -> wipe PENDING_REVIEW data rows and rebuild
//                                from "Form Responses 1", skipping any
//                                rows that already exist in LIVE_ISSUES
//                                or CLOSED_ISSUES. The fallback when
//                                pending data was lost / corrupted.
//
// Drive folder names (per-ticket photo folders) are NOT renamed by
// renumberAllTicketIds — the new id may not match the legacy folder
// name. The folder ids on each row's PHOTO cell still resolve, so
// existing photos remain viewable; new photos uploaded after recovery
// use the new ticket id for any new folders.
// ============================================================================

// Sheets that carry TICKET_ID in column 0 and DATE_REPORTED in column 1.
// (CLOSED_ISSUES + ARCHIVES_ISSUES extend the LIVE_COL layout — see
// requirement.md §5 for the schema.)
const RECOVERY_TICKET_SHEETS = [
    { name: "PENDING_REVIEW",  idCol: 0, dateCol: 1 /* PENDING_COL.DATE_REPORTED */ },
    { name: "LIVE_ISSUES",     idCol: 0, dateCol: 1 /* LIVE_COL.DATE_REPORTED */ },
    { name: "CLOSED_ISSUES",   idCol: 0, dateCol: 1 },
    { name: "ARCHIVES_ISSUES", idCol: 0, dateCol: 1 }
];

// Renumber every TICKET_ID across all four issue sheets as a single
// monotonic TKT-NNNNN series sorted by DATE_REPORTED ascending (with
// the existing id as a tiebreaker for stable ordering). Resets the
// TICKET_COUNTER ScriptProperty to the new max.
//
// Returns: { success, data: { renumbered, perSheet, counter }, error }.
function renumberAllTicketIds() {
    try {
        try { backupSheetToGit(); }
        catch (e) { Logger.log("[renumber] backup failed (continuing): " + e); }

        const ss = getSpreadsheet();
        const rows = [];

        RECOVERY_TICKET_SHEETS.forEach(function (cfg) {
            const sheet = ss.getSheetByName(cfg.name);
            if (!sheet) { Logger.log("[renumber] sheet not found, skip: " + cfg.name); return; }
            const last = sheet.getLastRow();
            if (last < 2) return;
            const width = Math.max(cfg.idCol, cfg.dateCol) + 1;
            const data = sheet.getRange(2, 1, last - 1, width).getValues();
            for (let i = 0; i < data.length; i++) {
                const r = data[i];
                const oldId = String(r[cfg.idCol] || "").trim();
                const dt = r[cfg.dateCol];
                const ms = dt instanceof Date
                    ? dt.getTime()
                    : (dt ? new Date(dt).getTime() : 0);
                rows.push({
                    sheetName: cfg.name,
                    rowIndex:  i + 2, // +1 for header, +1 for 1-based
                    dateMs:    isNaN(ms) ? 0 : ms,
                    oldId:     oldId
                });
            }
        });

        // Sort globally by date asc, tiebreak by existing id text.
        rows.sort(function (a, b) {
            if (a.dateMs !== b.dateMs) return a.dateMs - b.dateMs;
            return a.oldId.localeCompare(b.oldId);
        });

        const perSheet = {};
        const writes = {}; // sheetName -> [{row, value}]
        rows.forEach(function (r, i) {
            const newId = "TKT-" + String(i + 1).padStart(5, "0");
            perSheet[r.sheetName] = (perSheet[r.sheetName] || 0) + 1;
            if (!writes[r.sheetName]) writes[r.sheetName] = [];
            writes[r.sheetName].push({ row: r.rowIndex, value: newId });
        });

        Object.keys(writes).forEach(function (sheetName) {
            const sheet = ss.getSheetByName(sheetName);
            writes[sheetName].forEach(function (w) {
                sheet.getRange(w.row, 1).setValue(w.value);
            });
            Logger.log("[renumber] wrote " + writes[sheetName].length + " ids to " + sheetName);
        });

        PropertiesService.getScriptProperties()
            .setProperty("TICKET_COUNTER", String(rows.length));

        Logger.log("[renumber] DONE — total=" + rows.length + " perSheet=" + JSON.stringify(perSheet));
        return {
            success: true,
            data: { renumbered: rows.length, perSheet: perSheet, counter: rows.length },
            error: null
        };
    } catch (error) {
        Logger.log("[renumber] FAILED: " + error.toString());
        return { success: false, data: null, error: "Renumber failed: " + error.toString() };
    }
}

// Wipe PENDING_REVIEW data rows and rebuild from Form Responses 1,
// skipping any form rows whose {timestamp|resident|flat} signature
// already exists in LIVE_ISSUES or CLOSED_ISSUES. New pending rows get
// fresh ids via the hardened generateTicketID() (so they will not
// collide with live/closed ids).
//
// Use this when PENDING_REVIEW is the only sheet that's broken
// (deleted rows, missing intake, etc.) and the upstream Form Responses
// sheet is still intact.
//
// Returns: { success, data: { inserted, skipped, totalForm }, error }.
function recoverPendingFromForm() {
    try {
        try { backupSheetToGit(); }
        catch (e) { Logger.log("[recover] backup failed (continuing): " + e); }

        const ss = getSpreadsheet();
        const formSheet    = ss.getSheetByName(SHEETS.FORM_RESPONSES);
        const pendingSheet = ss.getSheetByName(SHEETS.PENDING_REVIEW);
        if (!formSheet)    throw new Error("Form Responses 1 sheet not found");
        if (!pendingSheet) throw new Error("PENDING_REVIEW sheet not found");

        // Build a signature set of rows that already exist in live/closed
        // so we never re-create them as new pending duplicates. Both
        // sheets use LIVE_COL's TICKET_ID + DATE_REPORTED + RESIDENT +
        // FLAT layout.
        const seen = new Set();
        function addSigs(sheet) {
            if (!sheet) return;
            const data = sheet.getDataRange().getValues();
            for (let i = 1; i < data.length; i++) {
                const r = data[i];
                const d = r[LIVE_COL.DATE_REPORTED];
                const ts = d instanceof Date ? d.toISOString() : String(d || "");
                seen.add(ts + "|" + String(r[LIVE_COL.RESIDENT] || "") + "|" + String(r[LIVE_COL.FLAT] || ""));
            }
        }
        addSigs(ss.getSheetByName(SHEETS.LIVE_ISSUES));
        addSigs(ss.getSheetByName(SHEETS.CLOSED_ISSUES));

        // Wipe PENDING_REVIEW data rows (keep header).
        const lastRow = pendingSheet.getLastRow();
        const lastCol = pendingSheet.getLastColumn();
        if (lastRow > 1 && lastCol > 0) {
            pendingSheet.getRange(2, 1, lastRow - 1, lastCol).clearContent();
            Logger.log("[recover] cleared " + (lastRow - 1) + " pending rows");
        }

        // Drop the cached counter so generateTicketID() re-seeds from
        // the live/closed scan on its next call — guarantees the new
        // pending ids do not collide with surviving live/closed ids.
        PropertiesService.getScriptProperties().deleteProperty("TICKET_COUNTER");

        // Walk Form Responses, skip already-promoted rows, re-create
        // the rest via createPendingIssue_ (so each gets a fresh id).
        const formData = formSheet.getDataRange().getValues();
        let inserted = 0;
        let skipped  = 0;
        for (let i = 1; i < formData.length; i++) {
            const row = formData[i];
            const ts  = row[FORM_COL.TIMESTAMP];
            const t   = ts instanceof Date ? ts.toISOString() : String(ts || "");
            const sig = t + "|" + String(row[FORM_COL.RESIDENT] || "") + "|" + String(row[FORM_COL.FLAT] || "");
            if (seen.has(sig)) { skipped++; continue; }

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
            inserted++;
        }

        Logger.log("[recover] DONE — inserted=" + inserted + " skipped=" + skipped + " totalForm=" + (formData.length - 1));
        return {
            success: true,
            data: {
                inserted:  inserted,
                skipped:   skipped,
                totalForm: formData.length - 1
            },
            error: null
        };
    } catch (error) {
        Logger.log("[recover] FAILED: " + error.toString());
        return { success: false, data: null, error: "Recovery failed: " + error.toString() };
    }
}

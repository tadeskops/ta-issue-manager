/**
 * ============================================================================
 *  ROUTER - Web App entry point with Google authentication
 * ============================================================================
 *  The web app is deployed with `executeAs: USER_ACCESSING` and
 *  `access: ANYONE` (i.e. anyone WITH a Google account). Google therefore
 *  forces sign-in BEFORE this script runs, and `Session.getActiveUser()`
 *  returns the verified email of the signed-in user. The email cannot be
 *  spoofed by the client.
 *
 *  Routing rules:
 *      /exec                    -> role-based landing
 *                                  COMMITTEE -> committee-dashboard
 *                                  BUILDER   -> builder-dashboard
 *                                  UNKNOWN   -> access-denied
 *      /exec?page=committee     -> force committee dashboard (if authorized)
 *      /exec?page=builder       -> force builder dashboard   (if authorized)
 *      /exec?page=submitted     -> read-only submitted-issues page
 *      /exec?page=admin         -> super-admin dashboard (committee only)
 *
 *  The chosen HTML file is loaded with HtmlService and a small inline
 *  `window.IRP_USER = { email, role }` is injected so client code can
 *  display the user without ever asking them to type it in.
 * ============================================================================
 */

const PAGE_MAP = {
    committee: { file: "src/pages/committee-dashboard", roles: ["COMMITTEE"] },
    builder:   { file: "src/pages/builder-dashboard",   roles: ["BUILDER", "COMMITTEE"], feature: "FEATURE_BUILDER_DASHBOARD" },
    admin:     { file: "src/pages/admin-dashboard",     roles: ["COMMITTEE"],            feature: "FEATURE_ADMIN_DASHBOARD" },
    submitted: { file: "src/pages/submitted-issues",    roles: ["COMMITTEE", "BUILDER", "RESIDENT", "UNKNOWN"], feature: "FEATURE_SUBMITTED_PAGE", public: true },
    submit:    { file: "src/pages/submit-issue",        roles: ["RESIDENT", "COMMITTEE", "BUILDER"], feature: "FEATURE_IN_PORTAL_SUBMIT" },
    denied:    { file: "src/pages/index",               roles: ["COMMITTEE", "BUILDER", "RESIDENT", "UNKNOWN"] }
};

function doGet(e) {
    // Schema introspection endpoint (?diag=sheets). Returns JSON describing
    // header rows + a couple of sample rows so we can verify the live sheet
    // layout against our column constants.
    if (e && e.parameter && e.parameter.diag === "sheets") {
        const out = diag_sheetSchemas_();
        return ContentService.createTextOutput(JSON.stringify(out, null, 2))
            .setMimeType(ContentService.MimeType.JSON);
    }

    // Role-resolution diagnostic (?diag=whoami). Returns a JSON payload
    // showing exactly what the server sees for the signed-in caller:
    // the resolved email, the role, the loaded committee list, cache
    // status, and any error. Use this when a user says "I added myself
    // to the CONFIG sheet but still see (Resident)".
    if (e && e.parameter && e.parameter.diag === "whoami") {
        const out = diag_whoami_();
        return ContentService.createTextOutput(JSON.stringify(out, null, 2))
            .setMimeType(ContentService.MimeType.JSON);
    }

    const email = (Session.getActiveUser().getEmail() || "").trim();
    const role  = getUserRole(email);
    const requested = (e && e.parameter && e.parameter.page) || "";

    // Pick target page.
    // Default landing is ALWAYS the index/login page so the user explicitly
    // chooses read-only view vs. tech (signed-in) mode. Dashboards open only
    // when requested via ?page=committee|builder|admin|submitted|submit.
    // ("denied" maps to src/pages/index — the same shared landing screen.)
    let key = (requested && PAGE_MAP[requested]) ? requested : "denied";

    const target = PAGE_MAP[key];

    // Feature-flag gate (pages can be hidden without breaking backend helpers).
    if (target.feature && !getFeatureFlag(target.feature)) {
        return renderDenied_(email, role, requested);
    }

    // Authorization check. Anonymous users (role UNKNOWN) are allowed only
    // on pages flagged public:true (e.g. the read-only submitted-issues view).
    if (!target.public && role === "UNKNOWN") {
        return renderDenied_(email, role, requested);
    }
    if (target.roles.indexOf(role) === -1) {
        return renderDenied_(email, role, requested);
    }

    return renderPage_(target.file, email, role);
}

/**
 * Renders an HTML page via the templating engine so each page can inline
 * the shared API client through `<?!= include('api') ?>`. Pages that don't
 * contain template tags pass through unchanged, so the same files remain
 * valid for local/static dev (browsers treat raw `<?…?>` as bogus comments
 * and ignore them).
 */
function renderPage_(file, email, role) {
    return HtmlService.createTemplateFromFile(file).evaluate()
        .setTitle("Issue Addressal Portal")
        .addMetaTag("viewport", "width=device-width, initial-scale=1")
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function renderDenied_(email, role, requestedPage) {
    var tpl = HtmlService.createTemplateFromFile("src/pages/index");
    // requestedPage lets the client auto-redirect anonymous visitors who
    // asked for a protected page over to the secure deployment URL.
    tpl.requestedPage = String(requestedPage || "").replace(/[^a-z]/gi, "");
    return tpl.evaluate()
        .setTitle("Issue Addressal Portal - Access Required")
        .addMetaTag("viewport", "width=device-width, initial-scale=1")
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Allows HTML files to include other HTML/CSS/JS via:
 *   <?!= include('partial-name') ?>
 * Evaluated through the templating engine so the included partial may
 * itself use scriptlets (e.g. theme.html reads DEFAULT_THEME from Config).
 *
 * Cycle guard: throws with the full include chain if a template tries
 * to include itself (directly or transitively). Without this, a stray
 * recursive include shows up only as "Maximum call stack size exceeded".
 */
var __INCLUDE_STACK__ = [];
function include(filename) {
    if (__INCLUDE_STACK__.indexOf(filename) !== -1) {
        var chain = __INCLUDE_STACK__.concat([filename]).join(' -> ');
        __INCLUDE_STACK__ = [];
        throw new Error('include() cycle: ' + chain);
    }
    __INCLUDE_STACK__.push(filename);
    try {
        return HtmlService.createTemplateFromFile(filename).evaluate().getContent();
    } finally {
        __INCLUDE_STACK__.pop();
    }
}

/**
 * Logo URL helper — exposed to client via api_getLogoUrl().
 * Delegates to Config.gs getLogoUrl() which reads CONFIG key LOGO_URL.
 */
function api_getLogoUrl() {
    return getLogoUrl();
}

/**
 * Returns the absolute web app URL of this deployment. Useful for links
 * across HTML files (e.g. "Open admin view").
 */
function getWebAppUrl() {
    return ScriptApp.getService().getUrl();
}

/* ----------------------------------------------------------------------------
 * Server-callable API surface for google.script.run
 * Each function reads the signed-in email from Session (NEVER from args)
 * and enforces role-based authorization centrally.
 * --------------------------------------------------------------------------*/

function api_whoAmI() {
    const email = (Session.getActiveUser().getEmail() || "").trim();
    return { email: email, role: getUserRole(email) };
}

// Returns deployment + identity + a sample call of getPendingIssues so we
// can verify what code the secure deployment is actually running and
// whether the signed-in user's session can read the issues sheet. Output
// is intentionally always a plain object (never throws) so the client
// always sees a real diagnostic instead of an opaque null.
function api_diag() {
    var out = {
        version: "diag-2026-05-31-r2",
        when: new Date().toISOString(),
        identity: null,
        identityError: null,
        webappUrl: null,
        pendingTest: null,
        pendingTestError: null
    };
    try {
        var email = (Session.getActiveUser().getEmail() || "").trim();
        out.identity = { email: email, role: getUserRole(email) };
    } catch (e) {
        out.identityError = String(e);
    }
    try {
        out.webappUrl = ScriptApp.getService().getUrl();
    } catch (e) { /* ignore */ }
    try {
        var r = getPendingIssues();
        // Return a small summary, not the whole payload, to keep the
        // diagnostic response small.
        out.pendingTest = {
            success: r && r.success,
            error: r && r.error,
            count: r && r.data ? r.data.length : null,
            firstTicket: r && r.data && r.data.length ? r.data[0].ticketId : null
        };
    } catch (e) {
        out.pendingTestError = String(e);
    }
    return out;
}

function api_call(action, payload) {
    payload = payload || {};
    var email = "";
    var role  = "UNKNOWN";
    // Wrap identity lookup so a Drive/CONFIG-sheet access failure surfaces as
    // a structured error to the client instead of an opaque "Unknown API
    // error" via google.script.run's failure handler.
    try {
        email = (Session.getActiveUser().getEmail() || "").trim();
        role  = getUserRole(email);
    } catch (idErr) {
        Logger.log("api_call identity error: " + idErr);
        return { success: false, error: "Identity lookup failed: " + String(idErr) + ". The signed-in account may not have access to the CONFIG spreadsheet." };
    }
    // Public read-only actions are allowed for anonymous visitors (role UNKNOWN).
    // getReportPhotoB64 is included so the Export Report wizard on the
    // public submitted-issues page can embed photo thumbnails — the
    // underlying Drive folder is already shared "Anyone with the link –
    // Viewer" via makeAttachmentFolderPublic, so this exposes nothing
    // that wasn't already publicly viewable via the issue card thumbnails.
    //
    // commitFullReportPdf is also public: every view (committee,
    // builder, public submitted) must push the rendered PDF back to
    // GitHub as the canonical TA_IAP_Full_Report.pdf. The commit handler
    // itself keeps integrity checks (GITHUB_TOKEN required, 30 MB cap,
    // %PDF magic-byte check) but no longer gates by role or feature
    // flag — access policy is intentionally lifted per operator
    // requirement so the View Full Report pill on every page always
    // reflects the freshest export.
    const PUBLIC_ACTIONS = ["getSubmittedIssues", "getClientConfig", "getCategoryMaster", "diag", "getReportPhotoB64", "commitFullReportPdf"];
    if (role === "UNKNOWN" && PUBLIC_ACTIONS.indexOf(action) === -1) {
        return { success: false, error: "Unauthorized: " + (email || "no email") };
    }
    if (role !== "UNKNOWN" && !isActionAllowed_(action, role)) {
        return { success: false, error: "Forbidden for role " + role + ": " + action };
    }
    try {
        var result;
        switch (action) {
            case "getFormResponses":         result = getFormResponses(); break;
            case "getIssuesWithStatus":      result = getIssuesWithStatus(); break;
            case "getSubmittedIssues":       result = getSubmittedIssues(); break;
            case "getPendingIssues":         result = getPendingIssues(); break;
            case "approveIssue":             result = approveIssue(payload.ticketId, email, payload.severity); break;
            case "rejectIssue":              result = rejectIssue(payload.ticketId, payload.reason, email); break;
            case "getLiveIssues":            result = getLiveIssues(payload.filterOption || "ALL"); break;
            case "getClosedIssues":          result = getClosedIssues(); break;
            case "updateBuilderStatus":      result = updateBuilderStatus(payload.ticketId, payload.status, payload.comment, payload.vendor, payload.closureDate); break;
            case "closeIssue":               result = closeIssue(payload.ticketId, payload.reason, email); break;
            case "reopenIssue":              result = reopenIssue(payload.ticketId, payload.reason, email); break;
            case "deleteIssue":              result = deleteIssue(payload.ticketId, payload.sheet || SHEETS.PENDING_REVIEW); break;
            case "generateTicketId":         result = generateTicketId(); break;
            case "approveIssueWithTicketId": result = approveIssueWithTicketId(payload.originalTicketId, payload.newTicketId, email, payload.severity); break;
            case "getDashboardMetrics":      result = getDashboardMetrics(); break;
            case "syncFormResponses":        result = syncFormResponses(); break;
            case "submitIssue":              result = submitIssue(payload, email); break;
            case "addPhotosToIssue":         result = addPhotosToIssue(payload.ticketId, payload.sheet, payload.photos, email); break;
            case "getReportPhotoB64":        result = getReportPhotoB64(payload.fileId || payload.url || "", payload.maxW); break;
            case "commitFullReportPdf":      result = commitFullReportPdf(payload.b64 || "", payload.source || ""); break;
            case "getCategoryMaster":        result = getCategoryMaster(); break;
            case "getClientConfig":          result = getClientConfig(); break;
            case "validateUserAccess":       result = { success: true, data: { email: email, role: role, hasAccess: true }, error: null }; break;
            case "diag":                     result = { success: true, data: api_diag(), error: null }; break;
            default:
                return { success: false, error: "Unknown action: " + action };
        }
        // Guard against handlers that returned undefined or stripped the error
        // string — those surface to the browser as the opaque "Unknown API
        // error" because the client falls back on a missing `error` field.
        if (!result) return { success: false, error: action + " returned no value" };
        if (result.success === false && !result.error) {
            result.error = action + " failed (no error message returned)";
        }
        return result;
    } catch (err) {
        Logger.log("api_call error (" + action + "): " + err);
        return { success: false, error: "[" + action + "] " + String(err) };
    }
}

/**
 * Role-based action allow-list. Edit here to grant/deny capabilities.
 */
function isActionAllowed_(action, role) {
    const COMMITTEE_ONLY = [
        "approveIssue", "rejectIssue", "deleteIssue",
        "generateTicketId", "approveIssueWithTicketId",
        "syncFormResponses", "addPhotosToIssue"
    ];
    const BUILDER_ALLOWED = [
        "getLiveIssues", "updateBuilderStatus", "closeIssue", "reopenIssue",
        "getFormResponses", "getIssuesWithStatus", "getSubmittedIssues",
        "validateUserAccess", "getDashboardMetrics", "getClientConfig",
        "getReportPhotoB64", "commitFullReportPdf"
    ];
    const RESIDENT_ALLOWED = [
        "submitIssue", "getCategoryMaster", "getIssuesWithStatus",
        "getSubmittedIssues", "validateUserAccess", "getClientConfig",
        "getReportPhotoB64"
    ];
    if (role === "COMMITTEE") return true; // committee can do everything
    if (role === "BUILDER")   return BUILDER_ALLOWED.indexOf(action) !== -1;
    if (role === "RESIDENT")  return RESIDENT_ALLOWED.indexOf(action) !== -1;
    return false;
}


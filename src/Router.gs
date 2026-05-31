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
        return renderDenied_(email, role);
    }

    // Authorization check. Anonymous users (role UNKNOWN) are allowed only
    // on pages flagged public:true (e.g. the read-only submitted-issues view).
    if (!target.public && role === "UNKNOWN") {
        return renderDenied_(email, role);
    }
    if (target.roles.indexOf(role) === -1) {
        return renderDenied_(email, role);
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

function renderDenied_(email, role) {
    return HtmlService.createTemplateFromFile("src/pages/index").evaluate()
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

function api_call(action, payload) {
    payload = payload || {};
    const email = (Session.getActiveUser().getEmail() || "").trim();
    const role  = getUserRole(email);
    // Public read-only actions are allowed for anonymous visitors (role UNKNOWN).
    const PUBLIC_ACTIONS = ["getSubmittedIssues", "getClientConfig", "getCategoryMaster"];
    if (role === "UNKNOWN" && PUBLIC_ACTIONS.indexOf(action) === -1) {
        return { success: false, error: "Unauthorized: " + (email || "no email") };
    }
    if (role !== "UNKNOWN" && !isActionAllowed_(action, role)) {
        return { success: false, error: "Forbidden for role " + role + ": " + action };
    }
    try {
        switch (action) {
            case "getFormResponses":       return getFormResponses();
            case "getIssuesWithStatus":    return getIssuesWithStatus();
            case "getSubmittedIssues":     return getSubmittedIssues();
            case "getPendingIssues":       return getPendingIssues();
            case "approveIssue":           return approveIssue(payload.ticketId, email, payload.severity);
            case "rejectIssue":            return rejectIssue(payload.ticketId, payload.reason, email);
            case "getLiveIssues":          return getLiveIssues(payload.filterOption || "ALL");
            case "updateBuilderStatus":    return updateBuilderStatus(payload.ticketId, payload.status, payload.comment, payload.vendor, payload.closureDate);
            case "closeIssue":             return closeIssue(payload.ticketId, payload.reason, email);
            case "reopenIssue":            return reopenIssue(payload.ticketId, payload.reason, email);
            case "deleteIssue":            return deleteIssue(payload.ticketId, payload.sheet || SHEETS.PENDING_REVIEW);
            case "generateTicketId":       return generateTicketId();
            case "approveIssueWithTicketId": return approveIssueWithTicketId(payload.originalTicketId, payload.newTicketId, email, payload.severity);
            case "getDashboardMetrics":    return getDashboardMetrics();
            case "syncFormResponses":      return syncFormResponses();
            case "submitIssue":            return submitIssue(payload, email);
            case "getCategoryMaster":      return getCategoryMaster();
            case "getClientConfig":        return getClientConfig();
            case "validateUserAccess":     return { success: true, data: { email: email, role: role, hasAccess: true }, error: null };
            default:
                return { success: false, error: "Unknown action: " + action };
        }
    } catch (err) {
        Logger.log("api_call error: " + err);
        return { success: false, error: String(err) };
    }
}

/**
 * Role-based action allow-list. Edit here to grant/deny capabilities.
 */
function isActionAllowed_(action, role) {
    const COMMITTEE_ONLY = [
        "approveIssue", "rejectIssue", "deleteIssue",
        "generateTicketId", "approveIssueWithTicketId",
        "syncFormResponses"
    ];
    const BUILDER_ALLOWED = [
        "getLiveIssues", "updateBuilderStatus", "closeIssue", "reopenIssue",
        "getFormResponses", "getIssuesWithStatus", "getSubmittedIssues",
        "validateUserAccess", "getDashboardMetrics", "getClientConfig"
    ];
    const RESIDENT_ALLOWED = [
        "submitIssue", "getCategoryMaster", "getIssuesWithStatus",
        "getSubmittedIssues", "validateUserAccess", "getClientConfig"
    ];
    if (role === "COMMITTEE") return true; // committee can do everything
    if (role === "BUILDER")   return BUILDER_ALLOWED.indexOf(action) !== -1;
    if (role === "RESIDENT")  return RESIDENT_ALLOWED.indexOf(action) !== -1;
    return false;
}

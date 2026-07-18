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
    // Top-level try/catch. Every ?diag=* route MUST return JSON — CI +
    // any post-deploy probe parses these responses strictly. Without
    // this wrapper, an uncaught exception in diag_* would surface as
    // Google's stock HTML error page ("Sorry, unable to open the file
    // at this time"), which CI mis-diagnoses as "wrong deployment
    // shape" instead of "your code threw". The wrapper narrows the
    // failure signal to a machine-parseable JSON blob with the actual
    // error message + type + stack.
    var isDiag = !!(e && e.parameter && e.parameter.diag);
    try {
        return doGet_(e);
    } catch (err) {
        if (isDiag) {
            var payload = {
                success: false,
                error: String(err && err.message || err),
                errorName: String(err && err.name || 'Error'),
                stack: String(err && err.stack || '').split('\n').slice(0, 8),
                diagRequested: e.parameter.diag,
                when: new Date().toISOString(),
                hint: 'doGet threw before the ?diag=' + e.parameter.diag + ' handler could complete. Check Apps Script → Executions for the full stack. Most common cause: the CONFIG sheet is not reachable by the caller (or by the deployer under USER_DEPLOYING).'
            };
            return ContentService.createTextOutput(JSON.stringify(payload, null, 2))
                .setMimeType(ContentService.MimeType.JSON);
        }
        // Non-diag GETs re-throw so Apps Script renders its stock error
        // page for browser users (better UX than a raw JSON blob).
        throw err;
    }
}

function doGet_(e) {
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

    // Deployment-mode fingerprint (?diag=deployment). Lets an operator
    // open the URL in a private-window (no Google account) and see the
    // shape of the deployment: USER_DEPLOYING (public) shows an empty
    // activeEmail + the deployer's effectiveEmail; USER_ACCESSING
    // (secure) forces Google sign-in first, then shows the caller's
    // email in both fields. This is how you match an AKfycbz… URL to
    // "public vs secure" without opening the Apps Script editor.
    if (e && e.parameter && e.parameter.diag === "deployment") {
        const out = diag_deployment_();
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
        version: "diag-2026-07-11-r3",
        when: new Date().toISOString(),
        identity: null,
        identityError: null,
        webappUrl: null,
        deployment: null,           // { activeEmail, effectiveEmail, mode }
        deploymentError: null,
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
    // Deployment-mode fingerprint. Under USER_DEPLOYING, Session.getActiveUser()
    // returns "" for external callers while getEffectiveUser() returns the
    // script owner. Under USER_ACCESSING, both return the signed-in caller.
    // Comparing them lets us prove from a browser tab which shape of
    // deployment served the request — no Apps Script editor access needed.
    try {
        var active    = "";
        var effective = "";
        try { active    = (Session.getActiveUser().getEmail()    || "").trim(); } catch (e1) {}
        try { effective = (Session.getEffectiveUser().getEmail() || "").trim(); } catch (e2) {}
        var mode = "UNKNOWN";
        if (active && effective && active === effective) {
            // Both non-empty and equal → could be either mode when the caller
            // IS the deployer; otherwise USER_ACCESSING (caller signed in).
            mode = "USER_ACCESSING";
        } else if (!active && effective) {
            // Classic USER_DEPLOYING signature: no caller identity, but the
            // script runs as its owner.
            mode = "USER_DEPLOYING";
        } else if (active && !effective) {
            // Unusual — treat as USER_ACCESSING but flag for the operator.
            mode = "USER_ACCESSING_NO_OWNER";
        }
        out.deployment = { activeEmail: active, effectiveEmail: effective, mode: mode };
    } catch (e) {
        out.deploymentError = String(e);
    }
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

/**
 * Deployment-mode fingerprint served by GET ?diag=deployment. Compares
 * Session.getActiveUser() (the caller) against Session.getEffectiveUser()
 * (the script owner) and reports the inferred deployment shape. Meant to
 * be opened in an incognito window with no Google session on the PUBLIC
 * URL — you should see USER_DEPLOYING and an empty activeEmail. The
 * SECURE URL will force sign-in first and then return USER_ACCESSING with
 * matching activeEmail + effectiveEmail. Any other combination is drift.
 */
function diag_deployment_() {
    var out = {
        version: "diag-deployment-r1",
        when: new Date().toISOString(),
        webappUrl: null,
        activeEmail: "",
        effectiveEmail: "",
        mode: "UNKNOWN",
        mustTestInIncognito: true,   // See comment below the emails block.
        expected: {
            public: { executeAs: "USER_DEPLOYING", access: "ANYONE_ANONYMOUS", pattern: "activeEmail=='' AND effectiveEmail==<deployer>" },
            secure: { executeAs: "USER_ACCESSING", access: "ANYONE",          pattern: "activeEmail==<caller> AND effectiveEmail==<caller>" }
        },
        hint: null
    };
    try { out.webappUrl = ScriptApp.getService().getUrl(); } catch (e) {}
    try { out.activeEmail    = (Session.getActiveUser().getEmail()    || "").trim(); } catch (e) {}
    try { out.effectiveEmail = (Session.getEffectiveUser().getEmail() || "").trim(); } catch (e) {}
    // IMPORTANT — this test is only conclusive when called from an INCOGNITO
    // window with no Google session. Reason: on the PUBLIC deployment
    // (USER_DEPLOYING), Google trusts the deployer's own account and
    // returns their email for both getActiveUser and getEffectiveUser — so
    // a deployer testing the public URL from their own browser would look
    // identical to a signed-in caller on the secure deployment. In
    // incognito with no Google cookie, the public URL falls through with an
    // empty activeEmail and any other visitor on the secure URL is bounced
    // to Google's sign-in page before this code runs.
    if (out.activeEmail && out.effectiveEmail && out.activeEmail === out.effectiveEmail) {
        out.mode = "USER_ACCESSING";
        out.hint = "Both active + effective emails equal (" + out.activeEmail + "). If you opened this in incognito with NO Google sign-in and STILL got a response, this URL is the SECURE deployment (Google would have forced sign-in). If you tested from your own browser as the deployer, this reading is inconclusive — retry from a private window signed out of Google, or from a different Google account. When SECURE is confirmed: populate CONFIG.PUBLIC_WEBAPP_URL with the sibling public URL.";
    } else if (!out.activeEmail && out.effectiveEmail) {
        out.mode = "USER_DEPLOYING";
        out.hint = "activeEmail is empty and effectiveEmail is the script owner — this URL is the PUBLIC deployment (USER_DEPLOYING + ANYONE_ANONYMOUS). Populate CONFIG.TECH_WEBAPP_URL with the sibling secure URL so the Sign-in button works.";
    } else if (out.activeEmail && !out.effectiveEmail) {
        out.mode = "USER_ACCESSING_NO_OWNER";
        out.hint = "Unusual — treated as USER_ACCESSING but effective user is empty. Check that the script owner is still valid.";
    } else {
        out.mode = "UNKNOWN";
        out.hint = "Neither active nor effective user resolved — usually means the deployment is not reachable or a Workspace policy is stripping identity headers.";
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
            case "commitBatch":              result = commitBatch(payload.items || [], email); break;
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
        "syncFormResponses", "addPhotosToIssue", "commitBatch"
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


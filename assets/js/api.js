/**
 * API Client (transport-aware)
 *
 * When the page is served by Apps Script HtmlService, identity comes from
 * `Session.getActiveUser()` server-side and we call backend functions via
 * `google.script.run` — no email is ever sent from the client.
 *
 * When the page is loaded locally (e.g. `file://` or a static host), the
 * shim falls back to `fetch(API.ENDPOINT)` so existing offline dev still
 * works against the legacy `doPost` endpoint.
 *
 * Public surface is unchanged: `API.getPendingIssues()`, `API.approveIssue()`,
 * etc. continue to return Promises that resolve to the action's `data` field.
 */
const API = {
    // Used only by the fetch fallback (local dev). Production HtmlService
    // ignores this — identity comes from the Google session, not from the URL.
    // Updated 2026-07-12: previous URL pointed to a stale project (v24 May 10);
    // this one is the canonical PUBLIC deployment cut inside TA_IRP_Launch,
    // the project CI now bumps on every push.
    ENDPOINT: "https://script.google.com/macros/s/AKfycbwyrWVDKsSiXpTvBMlEj470MeH80DHGTGD44aYf0chVegZeEqEoZWmN_QSUAEHSG2Ib/exec",

    // Detect environment once.
    get USES_APPS_SCRIPT() {
        return typeof google !== "undefined" &&
               typeof google.script !== "undefined" &&
               typeof google.script.run !== "undefined";
    },

    /**
     * Cached user identity (populated from window.IRP_USER injected by the
     * HtmlService template, or from api_whoAmI() the first time it's needed).
     * In fetch-fallback mode, populated from a one-time `whoAmI` server call.
     */
    _user: null,

    setEndpoint(url) { this.ENDPOINT = url; },

    /** Returns { email, role } - cached after first call. */
    async whoAmI() {
        if (this._user) return this._user;
        if (typeof window !== "undefined" && window.IRP_USER && window.IRP_USER.email) {
            this._user = {
                email: window.IRP_USER.email,
                role:  window.IRP_USER.role
            };
            return this._user;
        }
        if (this.USES_APPS_SCRIPT) {
            this._user = await new Promise((resolve, reject) => {
                google.script.run
                    .withSuccessHandler(resolve)
                    .withFailureHandler(reject)
                    .api_whoAmI();
            });
            return this._user;
        }
        // Fetch fallback - identity unknown; backend will derive it.
        this._user = { email: "", role: "UNKNOWN" };
        return this._user;
    },

    /**
     * Generic action dispatcher. Resolves to the action's `data` (or full
     * response object when the action doesn't use the {success,data,error}
     * envelope, e.g. getFormResponses returns {success, responses, count}).
     */
    async call(action, data = {}) {
        const payload = data || {};
        let result;

        if (this.USES_APPS_SCRIPT) {
            result = await new Promise((resolve, reject) => {
                google.script.run
                    .withSuccessHandler(resolve)
                    .withFailureHandler(err => reject(new Error(err && err.message ? err.message : String(err))))
                    .api_call(action, payload);
            });
        } else {
            // Local-dev / legacy transport.
            const body = Object.assign({ action: action }, payload);
            const response = await fetch(this.ENDPOINT, {
                method: "POST",
                mode: "cors",
                headers: { "Content-Type": "text/plain;charset=utf-8" },
                body: JSON.stringify(body)
            });
            if (!response.ok) throw new Error("HTTP " + response.status);
            result = await response.json();
        }

        if (!result || result.success === false) {
            const msg = (result && result.error) || "Unknown API error";
            console.error("API Error:", { action, payload, error: msg });
            throw new Error(msg);
        }
        return ("data" in result) ? result.data : result;
    },

    // ---- Convenience methods (unchanged public surface) ----
    getPendingIssues()        { return this.call("getPendingIssues"); },
    approveIssue(ticketId)    { return this.call("approveIssue", { ticketId }); },
    rejectIssue(t, r)         { return this.call("rejectIssue", { ticketId: t, reason: r }); },
    getLiveIssues(f = "ALL")  { return this.call("getLiveIssues", { filterOption: f }); },
    updateBuilderStatus(t, s, c = "", v = "", d = null) {
        return this.call("updateBuilderStatus", { ticketId: t, status: s, comment: c, vendor: v, closureDate: d });
    },
    closeIssue(t, r)          { return this.call("closeIssue", { ticketId: t, reason: r }); },
    reopenIssue(t, r)         { return this.call("reopenIssue", { ticketId: t, reason: r }); },
    getDashboardMetrics()     { return this.call("getDashboardMetrics"); },
    getFormResponses()        { return this.call("getFormResponses"); },
    getIssuesWithStatus()     { return this.call("getIssuesWithStatus"); },
    generateTicketId()        { return this.call("generateTicketId"); },
    approveIssueWithTicketId(o, n) { return this.call("approveIssueWithTicketId", { originalTicketId: o, newTicketId: n }); },
    syncFormResponses()       { return this.call("syncFormResponses"); },
    submitIssue(payload)      { return this.call("submitIssue", payload || {}); },
    getCategoryMaster()       { return this.call("getCategoryMaster"); },
    getClientConfig()         { return this.call("getClientConfig"); },

    /**
     * Sign out helper. There is no programmatic sign-out for an Apps Script
     * web app session — redirect to Google's account chooser instead.
     */
    signOut() {
        const back = (typeof window !== "undefined" && window.IRP_WEBAPP_URL) || "/";
        const url  = "https://accounts.google.com/Logout?continue=" +
                     encodeURIComponent("https://appengine.google.com/_ah/logout?continue=" + back);
        if (typeof window !== "undefined") window.open(url, "_top");
    }
};

// Default identity so older code reading window.IRP_USER doesn't crash
// before whoAmI() resolves.
if (typeof window !== "undefined" && !window.IRP_USER) {
    window.IRP_USER = { email: "", role: "UNKNOWN" };
}

/**
 * Local preview builder for the Apps Script HtmlService pages.
 *
 * Expands `<?!= include('src/partials/X') ?>` includes, evaluates the
 * `<?= __defTheme ?>` scriptlet (using DEFAULT_THEME from Config.gs or
 * 'light'), strips remaining `<? ... ?>` scriptlets, and writes flat
 * .html files into ./preview/ alongside a tiny shim that fakes
 * google.script.run so the pages don't crash in a regular browser.
 *
 * Usage:
 *   node scripts/build-preview.js
 *   npx http-server preview -p 5173 -o /index.html
 *
 * Apps Script safety guard:
 *   clasp 3.x renames every *.js it pushes to *.gs, and Apps Script V8
 *   evaluates every .gs file at script load. If this file ever ends up
 *   on the server (e.g. an over-permissive .claspignore), the top-level
 *   `require()` calls below would throw `ReferenceError: require is not
 *   defined` and brick the entire web app. The `typeof require` check
 *   makes the file a harmless no-op in that environment.
 */

if (typeof require === 'undefined') {
    // Loaded under Google Apps Script (no CommonJS). Do nothing.
} else {

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'preview');

const PAGES = [
    'index.html',
    'submit-issue.html',
    'submitted-issues.html',
    'committee-dashboard.html',
    'builder-dashboard.html',
    'admin-dashboard.html'
];

// ---- pull DEFAULT_THEME default out of Config.gs (best-effort, regex) -----
function readDefaultTheme() {
    try {
        const cfg = fs.readFileSync(path.join(SRC, 'Config.gs'), 'utf8');
        const m = cfg.match(/DEFAULT_THEME\s*:\s*"([^"]+)"/);
        return m ? m[1] : 'light';
    } catch { return 'light'; }
}
const DEFAULT_THEME = readDefaultTheme();

function readDefaultFontScale() {
    try {
        const cfg = fs.readFileSync(path.join(SRC, 'Config.gs'), 'utf8');
        const m = cfg.match(/DEFAULT_FONT_SCALE\s*:\s*"([^"]+)"/);
        return m ? m[1] : 'md';
    } catch { return 'md'; }
}
const DEFAULT_FONT_SCALE = readDefaultFontScale();

// ---- include / scriptlet expansion ----------------------------------------
function readPartial(rel, depth) {
    // include('src/partials/theme')  →  src/partials/theme.html
    const p = path.join(ROOT, rel + '.html');
    if (!fs.existsSync(p)) return `<!-- MISSING PARTIAL: ${rel} -->`;
    return expand(fs.readFileSync(p, 'utf8'), depth + 1);
}

function expand(html, depth) {
    depth = depth || 0;

    // 0a) strip HTML comments so example `<?!= include(...) ?>` text
    //     inside doc comments doesn't trigger recursive expansion.
    html = html.replace(/<!--[\s\S]*?-->/g, '');
    // 0b) strip JS line comments that quote include() syntax — those
    //     would otherwise expand recursively and leak partial content
    //     out of <script> blocks as visible page text.
    html = html.replace(/^[\t ]*\/\/[^\n]*<\?!=\s*include\([^\n]*\?>[^\n]*\n?/gm, '');

    // 1) recursive includes (capped depth as a final safety net).
    if (depth < 3) {
        html = html.replace(/<\?!=\s*include\(\s*['"]([^'"]+)['"]\s*\)\s*\?>/g,
            (_, rel) => readPartial(rel, depth));
    }

    // 2) `<?= __defTheme ?>` → DEFAULT_THEME
    html = html.replace(/<\?=\s*__defTheme\s*\?>/g, DEFAULT_THEME);
    html = html.replace(/<\?=\s*__defFontScale\s*\?>/g, DEFAULT_FONT_SCALE);

    // 3) any other `<?= expr ?>` → leave empty (best-effort)
    html = html.replace(/<\?=\s*[^?]+\?>/g, '');

    // 4) strip non-printing scriptlets `<? ... ?>`
    html = html.replace(/<\?[^=!][\s\S]*?\?>/g, '');
    // also handle leading `<? ` (no second char)
    html = html.replace(/<\?\s[\s\S]*?\?>/g, '');

    return html;
}

// ---- google.script.run shim ----------------------------------------------
const SHIM = `
<script>
/* LOCAL PREVIEW SHIM — fakes google.script.run so pages render without
   Apps Script. All calls resolve with empty/sane defaults. */
(function () {
    if (typeof google === 'undefined') window.google = {};
    if (google.script && google.script.run && google.script.run.__local) return;

    const fakes = {
        getClientConfig: () => ({
            success: true,
            data: {
                features: {
                    FEATURE_IN_PORTAL_SUBMIT: true,
                    FEATURE_PHOTO_UPLOAD: true,
                    FEATURE_AUTOSAVE_DRAFT: true,
                    FEATURE_REJECTED_FILTER: true,
                    FEATURE_BUILDER_DASHBOARD: true,
                    FEATURE_ADMIN_DASHBOARD: true,
                    FEATURE_SUBMITTED_PAGE: true,
                    FEATURE_SHOW_SEVERITY_ON_SUBMITTED: false,
                    FEATURE_COMMITTEE_PHOTO_ATTACH: true,
                    FEATURE_PDF_REPORT: true,
                    FEATURE_WEEKLY_REPORT_BACKUP: true,
                    FEATURE_SLA: false
                },
                tunables: {
                    SUBMIT_RATE_LIMIT_SECONDS: 20,
                    SUBMIT_DAILY_LIMIT: 20,
                    SUBMIT_MAX_PHOTOS: 5,
                    SUBMIT_MAX_PHOTO_MB: 5,
                    SUBMIT_PHOTO_MAX_DIM: 1600,
                    SUBMIT_PHOTO_JPEG_QUALITY: 0.85,
                    SUBMIT_DESC_MIN: 5,
                    SUBMIT_DESC_MAX: 1000,
                    CONFIG_CACHE_TTL_SECONDS: 300,
                    DEFAULT_THEME: '${DEFAULT_THEME}',
                    WEEKLY_REPORT_PUBLIC_URL: 'https://raw.githubusercontent.com/tadeskops/ta-issue-manager/main/backups/TA_IAP_Report.pdf',
                    FULL_REPORT_PUBLIC_URL: 'https://raw.githubusercontent.com/tadeskops/ta-issue-manager/main/backups/TA_IAP_Full_Report.pdf'
                },
                logoUrl: '',
                attachmentFolderUrl: 'https://drive.google.com/drive/folders/preview-folder-id'
            },
            error: null
        }),
        api_getLogoUrl: () => '',
        api_whoAmI: () => ({ email: 'preview@example.com', role: 'COMMITTEE' }),
        api_call: function (action, payload) {
            payload = payload || {};
            // Route getClientConfig through api_call so the unwrap in
            // API.call (returns result.data) delivers the feature-flag
            // object to the page exactly like the live deployment.
            if (action === 'getClientConfig') {
                return fakes.getClientConfig();
            }
            // Preview-only monotonic counter so each submitIssue (and
            // generateTicketId) mints a unique TKT-PREVIEW-NNNNN — mirrors
            // the live ScriptProperties counter in generateTicketID().
            if (typeof window.__previewTicketCounter !== 'number') {
                window.__previewTicketCounter = 0;
            }
            if (action === 'submitIssue') {
                window.__previewTicketCounter += 1;
                const id = 'TKT-PREVIEW-' + String(window.__previewTicketCounter).padStart(5, '0');
                return { success: true, data: { ticketId: id, reportedDate: new Date().toISOString(), photoCount: (payload.photos || []).length }, error: null };
            }
            if (action === 'generateTicketId') {
                window.__previewTicketCounter += 1;
                const id = 'TKT-PREVIEW-' + String(window.__previewTicketCounter).padStart(5, '0');
                return { success: true, data: { ticketId: id }, error: null };
            }
            // Preview mock data for the Export Report wizard.
            const mockIssues = function (state, n) {
                const out = [];
                for (let i = 1; i <= n; i++) {
                    out.push({
                        ticketId: 'TKT-' + state.slice(0, 3).toUpperCase() + '-' + String(i).padStart(3, '0'),
                        dateReported: new Date(Date.now() - i * 86400000 * 3).toISOString(),
                        resident: { name: 'Resident ' + i, email: '', phone: '' },
                        location: { tower: 'Tower ' + 'ABCDE'.charAt(i % 5), flat: String(100 + i) },
                        issue: {
                            category: ['Plumbing','Electrical','Civil','Cleaning'][i % 4],
                            subcategory: 'Sub ' + i,
                            severity: ['Critical','High','Medium','Low'][i % 4],
                            description: 'Sample issue description #' + i + ' for ' + state + ' — leak, crack, or other defect noted by resident.',
                            photoLinks: i % 2 === 0
                                ? ['https://drive.google.com/thumbnail?id=preview-photo-' + i + '&sz=w800']
                                : []
                        },
                        builder: { status: state === 'closed' ? 'WORK_COMPLETED' : (state === 'active' ? 'IN_PROGRESS' : 'ASSIGNED'),
                                   comment: state === 'closed' ? 'Work completed.' : '',
                                   assignedVendor: state !== 'pending' ? 'Vendor X' : '',
                                   lastUpdated: new Date().toISOString() },
                        sla: { dueDate: new Date(Date.now() + 7 * 86400000).toISOString(), breached: i % 5 === 0, daysRemaining: 7 - i },
                        state: state === 'pending' ? 'PENDING_APPROVAL'
                             : state === 'rejected' ? 'REJECTED'
                             : state === 'closed' ? 'CLOSED'
                             : 'APPROVED',
                        actionDate: new Date().toISOString(),
                        actionBy: 'committee@example.com',
                        rejectionReason: state === 'rejected' ? 'Out of scope.' : ''
                    });
                }
                return out;
            };
            if (action === 'getPendingIssues')   return { success: true, data: mockIssues('pending', 3).concat(mockIssues('rejected', 2)), error: null };
            if (action === 'getLiveIssues')      return { success: true, data: mockIssues('active', 5), error: null };
            if (action === 'getClosedIssues')    return { success: true, data: mockIssues('closed', 6), error: null };
            if (action === 'getSubmittedIssues') return { success: true, data: mockIssues('pending', 4).concat(mockIssues('active', 3)).concat(mockIssues('closed', 3)), error: null };
            if (action === 'getReportPhotoB64') {
                // Preview-only: cycle through small solid-colour 1x1 PNGs
                // so each inline thumb renders as a visible coloured swatch.
                // Real production data uses JPEG bytes from Drive thumbnails.
                const swatches = [
                    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', // red
                    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADBgGAWjR9awAAAABJRU5ErkJggg==', // blue
                    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP8z/D/PwAGBQIA1tH6lwAAAABJRU5ErkJggg==', // green
                    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP8//8/AwQwAQAH/wL+rrDdNAAAAABJRU5ErkJggg=='  // yellow
                ];
                const key = String(payload.fileId || payload.url || 'preview');
                let h = 0;
                for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
                const b64 = swatches[Math.abs(h) % swatches.length];
                return { success: true, data: { mimeType: 'image/png', b64: b64, sourceId: 'preview' }, error: null };
            }
            if (action === 'commitFullReportPdf') {
                // Preview-only stub — pretend the server accepted the bytes.
                const len = (payload.b64 || '').length;
                return { success: true, data: { mock: true, source: payload.source || '', b64Len: len }, error: null };
            }
            if (action && action.indexOf('Issues') >= 0) return { success: true, data: [], error: null };
            return { success: true, data: null, error: null };
        },
        getCurrentUser: () => ({ email: 'preview@example.com', role: 'COMMITTEE' }),
        getWebAppUrl: () => location.pathname.replace(/[^/]+$/, ''),
        getPendingIssues:  () => ({ success: true, data: [], error: null }),
        getLiveIssues:     () => ({ success: true, data: [], error: null }),
        getArchivedIssues: () => ({ success: true, data: [], error: null }),
        getClosedIssues:   () => ({ success: true, data: [], error: null }),
        getBuilderIssues:  () => ({ success: true, data: [], error: null }),
        getSubmittedIssues:() => ({ success: true, data: [], error: null }),
        getCategories:     () => ({ success: true, data: ['Plumbing','Electrical','Civil','Cleaning','Security','Lift','Garden','Other'], error: null }),
        getDashboardStats: () => ({ success: true, data: { pending: 0, live: 0, closed: 0, archived: 0 }, error: null })
    };

    function chain() {
        const ctx = { _success: null, _failure: null };
        ctx.withSuccessHandler = function (fn) { ctx._success = fn; return ctx; };
        ctx.withFailureHandler = function (fn) { ctx._failure = fn; return ctx; };
        ctx.withUserObject = function () { return ctx; };
        // every fake method is callable on the chain context too
        Object.keys(fakes).forEach(function (name) {
            ctx[name] = function () {
                const args = Array.from(arguments);
                setTimeout(function () {
                    try {
                        const v = fakes[name].apply(null, args);
                        if (ctx._success) ctx._success(v);
                    } catch (e) {
                        if (ctx._failure) ctx._failure(e);
                        else console.error('[preview shim] ' + name + ' threw', e);
                    }
                }, 10);
                return ctx;
            };
        });
        // unknown methods → no-op success
        return new Proxy(ctx, {
            get: function (t, k) {
                if (k in t) return t[k];
                return function () {
                    setTimeout(function () {
                        if (ctx._success) ctx._success({ success: true, data: null, error: null });
                    }, 10);
                    return ctx;
                };
            }
        });
    }

    const runner = { __local: true };
    runner.withSuccessHandler = function (fn) { return chain().withSuccessHandler(fn); };
    runner.withFailureHandler = function (fn) { return chain().withFailureHandler(fn); };
    runner.withUserObject     = function ()   { return chain(); };
    Object.keys(fakes).forEach(function (name) {
        runner[name] = function () {
            return chain()[name].apply(null, arguments);
        };
    });
    google.script = google.script || {};
    google.script.run = new Proxy(runner, {
        get: function (t, k) {
            if (k in t) return t[k];
            return function () {
                const c = chain();
                setTimeout(function () { c._success && c._success({ success: true, data: null, error: null }); }, 10);
                return c;
            };
        }
    });
    google.script.host = { close: function(){}, setHeight: function(){}, setWidth: function(){} };

    console.info('[preview] google.script.run shim active; DEFAULT_THEME=${DEFAULT_THEME}');
})();
</script>
`;

// ---- build ---------------------------------------------------------------
function build() {
    if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

    const links = [];
    PAGES.forEach(function (name) {
        const src = path.join(SRC, 'pages', name);
        if (!fs.existsSync(src)) { console.warn('skip (missing):', name); return; }

        let html = expand(fs.readFileSync(src, 'utf8'));

        // Inject shim just before </head> so it loads before page scripts.
        if (/<\/head>/i.test(html)) {
            html = html.replace(/<\/head>/i, SHIM + '</head>');
        } else {
            html = SHIM + html;
        }

        fs.writeFileSync(path.join(OUT, name), html, 'utf8');
        links.push(name);
        console.log('built  preview/' + name);
    });

    // Tiny landing page
    const landing = `<!doctype html>
<html><head><meta charset="utf-8"><title>IRP Preview</title>
<style>
    body { font: 14px/1.5 system-ui, sans-serif;
           background: linear-gradient(135deg,#f6f1e6,#ece4d0);
           color:#1f2937; padding:48px; }
    h1 { color:#a67c00; margin:0 0 8px; }
    .hint { color:#64748b; margin-bottom:24px; font-size:13px; }
    a { display:block; padding:12px 18px; margin:8px 0;
        background:#fff; border:1px solid rgba(166,124,0,0.22);
        border-radius:12px; text-decoration:none; color:#1f2937;
        box-shadow:0 4px 16px rgba(31,41,55,0.06); transition:transform .15s; }
    a:hover { transform:translateY(-1px); }
    code { background:#fff8e1; padding:2px 6px; border-radius:4px; }
</style></head>
<body>
    <h1>IRP \u2014 Local Preview</h1>
    <p class="hint">Default theme: <code>${DEFAULT_THEME}</code>. The
    <code>google.script.run</code> calls are stubbed; data lists will appear empty.
    Use the discreet tone switcher at the top-right of each page.</p>
    ${links.map(n => `<a href="./${n}">${n}</a>`).join('\n    ')}
</body></html>`;
    fs.writeFileSync(path.join(OUT, 'index-preview.html'), landing, 'utf8');
    console.log('built  preview/index-preview.html');

    console.log('\nDone. Serve with:  npx --yes http-server preview -p 5173 -o /index-preview.html');
}

build();

} // end Apps-Script safety guard

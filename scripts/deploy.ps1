# =============================================================================
#  scripts/deploy.ps1 — one-command launch to Google Apps Script
# =============================================================================
#  Run from the project root:  .\scripts\deploy.ps1
#
#  Handles, in order:
#    1) Ensures Node + clasp are installed (installs clasp if missing).
#    2) Ensures you are logged in to clasp (opens browser for Google OAuth).
#    3) Links the project to Apps Script (clone existing or create new).
#    4) Pushes src/** + appsscript.json (honours .claspignore).
#    5) Creates / updates a Web App deployment.
#    6) Opens the Apps Script editor so you can run setupConfigSheet() once.
#
#  Safe to re-run — each step skips when already done.
# =============================================================================
$ErrorActionPreference = 'Stop'

function Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Ok($t)      { Write-Host "  [ok] $t" -ForegroundColor Green }
function Warn($t)    { Write-Host "  [!]  $t" -ForegroundColor Yellow }
function Info($t)    { Write-Host "  $t" }

# Move to repo root (one level up from this script).
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# ----- 1. Tooling ------------------------------------------------------------
Section "Tooling"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is not on PATH. Install Node 18+ and re-run."
}
Ok "node $(node --version)"

if (-not (Get-Command clasp -ErrorAction SilentlyContinue)) {
    Warn "clasp not found - installing @google/clasp globally..."
    npm install -g @google/clasp --registry=https://registry.npmjs.org/ --fetch-timeout=30000 | Out-Null
}
Ok "clasp $(clasp --version)"

# ----- 2. Login --------------------------------------------------------------
Section "Google login"
$claspRc = Join-Path $HOME ".clasprc.json"
if (-not (Test-Path $claspRc)) {
    Info "No saved credentials. Launching browser-based OAuth..."
    Info "(A Google permission dialog will open. Approve the requested scopes.)"
    clasp login
    if (-not (Test-Path $claspRc)) { throw "clasp login did not produce $claspRc" }
}
Ok "Logged in (~/.clasprc.json present)"

# ----- 3. Project link -------------------------------------------------------
Section "Project link"
if (-not (Test-Path ".clasp.json")) {
    Write-Host ""
    Write-Host "No .clasp.json found. Choose an option:" -ForegroundColor Yellow
    Write-Host "  [1] Clone an EXISTING Apps Script project (you'll paste the Script ID)"
    Write-Host "  [2] CREATE a new standalone Apps Script project"
    $choice = Read-Host "Enter 1 or 2"

    if ($choice -eq '1') {
        $scriptId = Read-Host "Paste the Script ID (Apps Script editor > Project Settings > IDs)"
        if ([string]::IsNullOrWhiteSpace($scriptId)) { throw "Script ID is required." }
        # clone-script writes .clasp.json in cwd; --rootDir tells it where files live.
        clasp clone-script $scriptId --rootDir .
    }
    elseif ($choice -eq '2') {
        $title = Read-Host "Project title [TA Issue Reporting Portal]"
        if ([string]::IsNullOrWhiteSpace($title)) { $title = 'TA Issue Reporting Portal' }
        clasp create-script --type standalone --title "$title" --rootDir .
    }
    else {
        throw "Unrecognised choice: $choice"
    }

    if (-not (Test-Path ".clasp.json")) { throw "clasp did not create .clasp.json" }
}
$claspCfg = Get-Content .clasp.json | ConvertFrom-Json
Ok ("Linked to scriptId={0}" -f $claspCfg.scriptId)

# ----- 4. Push ---------------------------------------------------------------
Section "Push src/** + appsscript.json"
Info "(.claspignore restricts the upload to src/** + appsscript.json)"
clasp push -f
Ok "Push complete"

# ----- 5. Deploy -------------------------------------------------------------
Section "Web app deployment"
$desc = "Auto-deploy $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
Write-Host ""
Write-Host "Press Enter to create a NEW deployment, or paste an existing"
Write-Host "deploymentId to UPDATE that one (find it in the editor under"
Write-Host "Deploy > Manage deployments)."
$depId = Read-Host "Deployment Id (blank = new)"
if ([string]::IsNullOrWhiteSpace($depId)) {
    clasp create-deployment --description "$desc"
} else {
    clasp update-deployment $depId --description "$desc"
}
Ok "Deployment requested"

# ----- 6. Final manual step --------------------------------------------------
Section "One-time setup in the Apps Script editor"
$editorUrl = "https://script.google.com/d/$($claspCfg.scriptId)/edit"
Write-Host "Opening the editor so you can run setupConfigSheet() once."
Write-Host "  1. Top toolbar: pick function 'setupConfigSheet' > click Run."
Write-Host "  2. Approve any new OAuth scopes Apps Script asks for."
Write-Host "  3. Then: Deploy > Manage deployments > Edit > 'Web app' settings"
Write-Host "     - Execute as : User accessing the web app"
Write-Host "     - Who has access : Anyone"
Write-Host ""
Info $editorUrl
Start-Process $editorUrl

Write-Host "`nAll done." -ForegroundColor Green

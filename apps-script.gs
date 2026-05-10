// ===== CONFIG (Update these values) =====
const COMMITTEE_EMAILS = [
    "maitreya.jain007@gmail.com",
    "ta.deskops@gmail.com"
];

const BUILDER_EMAIL = "vibhumaitreya@gmail.com";
const SHEET_ID = "1dvLsUyog-6Rbv22WBQWClwZkabNBVYqF4ChNL1LL_vU"; // Get from Sheets URL
const SHEETS = {
    FORM_RESPONSES: "Form Responses 1",
    PENDING_QUEUE: "PENDING_REVIEW",  // Updated to match actual sheet name
    LIVE_ISSUES: "LIVE_ISSUES",
    CLOSED_ISSUES: "CLOSED_ISSUES",
    CATEGORY_MASTER: "CATEGORY_MASTER",
    DASHBOARD: "DASHBOARD",
    WEEKLY_REVIEW: "WEEKLY_REVIEW"
};

const SLA_RULES = {
    "Critical": 1,
    "High": 3,
    "Medium": 7,
    "Low": 15
};

const ALLOWED_STATUSES = [
    "PENDING_APPROVAL", "APPROVED", "ASSIGNED",
    "IN_PROGRESS", "WORK_COMPLETED", "CLOSED", "REOPENED", "REJECTED"
];
// ===== END CONFIG =====

// Get Spreadsheet with error handling
function getSpreadsheet() {
    try {
        return SpreadsheetApp.openById(SHEET_ID);
    } catch (error) {
        Logger.log("Error opening spreadsheet: " + error.toString());
        throw new Error("Cannot access spreadsheet with ID: " + SHEET_ID);
    }
}

// Get Sheet with enhanced error handling
function getSheet(sheetName) {
    try {
        const ss = getSpreadsheet();
        const sheet = ss.getSheetByName(sheetName);
        if (!sheet) {
            const allSheets = ss.getSheets().map(s => s.getName());
            throw new Error(`Sheet "${sheetName}" not found. Available sheets: ${allSheets.join(", ")}`);
        }
        return sheet;
    } catch (error) {
        Logger.log("Error getting sheet: " + error.toString());
        throw error;
    }
}

// Generate Ticket ID
function generateTicketID() {
    try {
        const ss = getSpreadsheet();
        const liveSheet = ss.getSheetByName(SHEETS.LIVE_ISSUES);
        const closedSheet = ss.getSheetByName(SHEETS.CLOSED_ISSUES);
        
        let maxNum = 0;
        
        // Get max from LIVE_ISSUES
        if (liveSheet) {
            const liveData = liveSheet.getDataRange().getValues();
            for (let i = 1; i < liveData.length; i++) {
                const ticketId = liveData[i][0];
                if (ticketId && ticketId.toString().startsWith("TA-")) {
                    const num = parseInt(ticketId.toString().substring(3));
                    if (num > maxNum) maxNum = num;
                }
            }
        }
        
        // Get max from CLOSED_ISSUES
        if (closedSheet) {
            const closedData = closedSheet.getDataRange().getValues();
            for (let i = 1; i < closedData.length; i++) {
                const ticketId = closedData[i][0];
                if (ticketId && ticketId.toString().startsWith("TA-")) {
                    const num = parseInt(ticketId.toString().substring(3));
                    if (num > maxNum) maxNum = num;
                }
            }
        }
        
        const nextNum = String(maxNum + 1).padStart(4, '0');
        return `TA-${nextNum}`;
    } catch (error) {
        Logger.log("Error generating ticket ID: " + error.toString());
        throw error;
    }
}

// Calculate SLA Date
function calculateSLADate(severity, reportedDate) {
    const days = SLA_RULES[severity] || 7;
    const slaDate = new Date(reportedDate);
    slaDate.setDate(slaDate.getDate() + days);
    return slaDate;
}

// On Form Submit Trigger
function onFormSubmit(e) {
    try {
        const values = e.values;
        const ticketId = generateTicketID();
        const reportedDate = new Date();
        const slaDate = calculateSLADate(values[8], reportedDate); // values[8] is Severity
        
        const newRow = [
            ticketId,
            reportedDate,
            values[1], // Resident Name
            values[2], // Email
            values[3], // Tower
            values[4], // Flat Number
            values[5], // Phone
            values[6], // Category
            values[7], // Subcategory
            values[8], // Severity
            values[9], // Location
            values[10], // Description
            values[11], // Photos
            "", // Submitted By
            "", // Approved Date
            "", // Rejection Reason
            "PENDING_APPROVAL" // Current State
        ];
        
        const pendingSheet = getSheet(SHEETS.PENDING_QUEUE);
        pendingSheet.appendRow(newRow);
        
    } catch (error) {
        Logger.log("Form submission error: " + error.toString());
    }
}

// Get Form Responses (Direct from Google Sheet)
function getFormResponses() {
    try {
        const sheet = getSheet(SHEETS.FORM_RESPONSES);
        const data = sheet.getDataRange().getValues();
        const responses = [];
        
        // Get header row to map column names
        const headers = data[0];
        
        // Process each row (skip header)
        for (let i = 1; i < data.length; i++) {
            const row = data[i];
            const response = {};
            
            // Map each column to header name
            for (let j = 0; j < headers.length; j++) {
                response[headers[j]] = row[j];
            }
            
            responses.push(response);
        }
        
        return {
            success: true,
            responses: responses,
            count: responses.length,
            error: null
        };
    } catch (error) {
        return {
            success: false,
            responses: null,
            error: "Error fetching form responses: " + error.toString()
        };
    }
}

// Sync Form Responses to PENDING_QUEUE (Manual Data Sync)
function syncFormResponses() {
    try {
        const formSheet = getSheet(SHEETS.FORM_RESPONSES);
        const pendingSheet = getSheet(SHEETS.PENDING_QUEUE);
        
        const formData = formSheet.getDataRange().getValues();
        const pendingData = pendingSheet.getDataRange().getValues();
        
        // Get list of already processed ticket IDs from PENDING_QUEUE
        const processedTickets = new Set();
        for (let i = 1; i < pendingData.length; i++) {
            processedTickets.add(JSON.stringify(pendingData[i].slice(2, 7))); // Unique identifier from resident data
        }
        
        let synced = 0;
        let skipped = 0;
        
        // Process each form response (skip header row)
        for (let i = 1; i < formData.length; i++) {
            const row = formData[i];
            const uniqueKey = JSON.stringify(row.slice(1, 6)); // timestamp, name, email, tower, flat
            
            // Check if already processed
            if (processedTickets.has(uniqueKey)) {
                skipped++;
                continue;
            }
            
            // Generate ticket and create new entry
            const ticketId = generateTicketID();
            const reportedDate = new Date(row[0]); // Timestamp
            const severity = row[7] || "Medium"; // Severity column
            const slaDate = calculateSLADate(severity, reportedDate);
            
            const newRow = [
                ticketId,
                reportedDate,
                row[1], // Resident Name
                row[2], // Email
                row[3], // Tower
                row[4], // Flat Number
                row[5], // Phone
                row[6], // Category
                row[8] || "", // Subcategory (may be column 8 or 9)
                severity, // Severity
                row[9] || "", // Location
                row[10] || "", // Description
                row[11] || "", // Photos
                "", // Submitted By
                "", // Approved Date
                "", // Rejection Reason
                "PENDING_APPROVAL" // Current State
            ];
            
            pendingSheet.appendRow(newRow);
            synced++;
        }
        
        return {
            success: true,
            data: {
                synced: synced,
                skipped: skipped,
                message: `Synced ${synced} new issues, skipped ${skipped} already processed`
            },
            error: null
        };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: "Sync error: " + error.toString()
        };
    }
}

// Validate User Access
function validateUserAccess(email) {
    try {
        // BYPASS AUTHENTICATION FOR NOW - Allow all emails
        if (COMMITTEE_EMAILS.includes(email)) {
            return { email: email, role: "COMMITTEE", hasAccess: true, accessLevel: "FULL" };
        } else if (email === BUILDER_EMAIL) {
            return { email: email, role: "BUILDER", hasAccess: true, accessLevel: "LIMITED" };
        } else {
            // Temporarily allow all other emails as COMMITTEE for testing
            return { email: email, role: "COMMITTEE", hasAccess: true, accessLevel: "FULL" };
        }
    } catch (error) {
        Logger.log("Error validating user access: " + error.toString());
        throw error;
    }
}

// Get Pending Issues
function getPendingIssues() {
    try {
        const sheet = getSheet(SHEETS.PENDING_QUEUE);
        const data = sheet.getDataRange().getValues();
        const issues = [];
        
        for (let i = 1; i < data.length; i++) {
            const row = data[i];
            issues.push({
                ticketId: row[0],
                dateReported: row[1],
                resident: {
                    name: row[2],
                    email: row[3],
                    phone: row[6]
                },
                location: {
                    tower: row[4],
                    flat: row[5]
                },
                issue: {
                    category: row[7],
                    subcategory: row[8],
                    severity: row[9],
                    location: row[10],
                    description: row[11],
                    photoLinks: row[12] ? [row[12]] : []
                },
                state: row[16]
            });
        }
        
        return { success: true, data: issues, error: null };
    } catch (error) {
        return { success: false, data: null, error: error.toString() };
    }
}

// Approve Issue
function approveIssue(ticketId, userEmail) {
    try {
        const pendingSheet = getSheet(SHEETS.PENDING_QUEUE);
        const liveSheet = getSheet(SHEETS.LIVE_ISSUES);
        const pendingData = pendingSheet.getDataRange().getValues();
        
        for (let i = 1; i < pendingData.length; i++) {
            if (pendingData[i][0] === ticketId) {
                const row = pendingData[i];
                const reportedDate = new Date(row[1]);
                const severity = row[9];
                const slaDate = calculateSLADate(severity, reportedDate);
                
                const newRow = [
                    row[0], row[1], row[2], row[3], row[4], row[5], row[6],
                    row[7], row[8], row[9], row[10], row[11], row[12],
                    "", "", "", "", "", "", slaDate, new Date(), "APPROVED", userEmail, new Date()
                ];
                
                liveSheet.appendRow(newRow);
                pendingSheet.deleteRow(i + 1);
                
                return {
                    success: true,
                    data: {
                        ticketId: ticketId,
                        state: "APPROVED",
                        approvedBy: userEmail,
                        approvedDate: new Date(),
                        slaDate: slaDate
                    },
                    error: null
                };
            }
        }
        
        return { success: false, data: null, error: "Ticket not found" };
    } catch (error) {
        return { success: false, data: null, error: error.toString() };
    }
}

// Reject Issue
function rejectIssue(ticketId, reason, userEmail) {
    try {
        const pendingSheet = getSheet(SHEETS.PENDING_QUEUE);
        const pendingData = pendingSheet.getDataRange().getValues();
        
        for (let i = 1; i < pendingData.length; i++) {
            if (pendingData[i][0] === ticketId) {
                pendingSheet.deleteRow(i + 1);
                
                return {
                    success: true,
                    data: {
                        ticketId: ticketId,
                        state: "REJECTED",
                        rejectionReason: reason,
                        rejectedBy: userEmail,
                        rejectedDate: new Date()
                    },
                    error: null
                };
            }
        }
        
        return { success: false, data: null, error: "Ticket not found" };
    } catch (error) {
        return { success: false, data: null, error: error.toString() };
    }
}

// Get Live Issues
function getLiveIssues(filterOption) {
    try {
        const sheet = getSheet(SHEETS.LIVE_ISSUES);
        const data = sheet.getDataRange().getValues();
        const issues = [];
        
        for (let i = 1; i < data.length; i++) {
            const row = data[i];
            
            if (filterOption === "CRITICAL" && row[9] !== "Critical") continue;
            if (filterOption === "AGING" && (new Date() - new Date(row[20])) < 7 * 24 * 60 * 60 * 1000) continue;
            
            const slaDate = new Date(row[18]);
            const today = new Date();
            const breached = today > slaDate;
            const daysRemaining = Math.ceil((slaDate - today) / (1000 * 60 * 60 * 24));
            
            issues.push({
                ticketId: row[0],
                dateReported: row[1],
                resident: {
                    name: row[4],
                    email: row[3],
                    phone: row[6]
                },
                location: {
                    tower: row[2],
                    flat: row[3]
                },
                issue: {
                    category: row[7],
                    severity: row[9],
                    description: row[11],
                    photoLinks: row[12] ? [row[12]] : []
                },
                builder: {
                    status: row[13],
                    comment: row[14],
                    assignedVendor: row[15],
                    lastUpdated: row[20]
                },
                sla: {
                    dueDate: slaDate,
                    breached: breached,
                    daysRemaining: daysRemaining
                },
                state: row[17],
                approvedBy: row[21],
                lastUpdated: row[20]
            });
        }
        
        return { success: true, data: issues, error: null };
    } catch (error) {
        return { success: false, data: null, error: error.toString() };
    }
}

// Update Builder Status
function updateBuilderStatus(ticketId, status, comment, vendor, closureDate) {
    try {
        const sheet = getSheet(SHEETS.LIVE_ISSUES);
        const data = sheet.getDataRange().getValues();
        
        for (let i = 1; i < data.length; i++) {
            if (data[i][0] === ticketId) {
                sheet.getRange(i + 1, 14).setValue(status); // Builder Status
                sheet.getRange(i + 1, 15).setValue(comment || ""); // Builder Comment
                sheet.getRange(i + 1, 16).setValue(vendor || ""); // Assigned Vendor
                sheet.getRange(i + 1, 18).setValue(status); // Current State
                sheet.getRange(i + 1, 20).setValue(new Date()); // Last Updated
                
                if (closureDate) {
                    sheet.getRange(i + 1, 19).setValue(new Date(closureDate));
                }
                
                return {
                    success: true,
                    data: {
                        ticketId: ticketId,
                        builderStatus: status,
                        builderComment: comment,
                        assignedVendor: vendor,
                        lastUpdated: new Date()
                    },
                    error: null
                };
            }
        }
        
        return { success: false, data: null, error: "Ticket not found" };
    } catch (error) {
        return { success: false, data: null, error: error.toString() };
    }
}

// Close Issue
function closeIssue(ticketId, reason, userEmail) {
    try {
        const liveSheet = getSheet(SHEETS.LIVE_ISSUES);
        const closedSheet = getSheet(SHEETS.CLOSED_ISSUES);
        const liveData = liveSheet.getDataRange().getValues();
        
        for (let i = 1; i < liveData.length; i++) {
            if (liveData[i][0] === ticketId) {
                const row = liveData[i];
                const reportedDate = new Date(row[1]);
                const closedDate = new Date();
                const resolutionTime = Math.ceil((closedDate - reportedDate) / (1000 * 60 * 60 * 24));
                
                const closedRow = [...row, reason, closedDate, userEmail, resolutionTime];
                closedSheet.appendRow(closedRow);
                liveSheet.deleteRow(i + 1);
                
                return {
                    success: true,
                    data: {
                        ticketId: ticketId,
                        state: "CLOSED",
                        closedDate: closedDate,
                        closedBy: userEmail,
                        closureReason: reason,
                        resolutionTime: resolutionTime
                    },
                    error: null
                };
            }
        }
        
        return { success: false, data: null, error: "Ticket not found" };
    } catch (error) {
        return { success: false, data: null, error: error.toString() };
    }
}

// Reopen Issue
function reopenIssue(ticketId, reason, userEmail) {
    try {
        const closedSheet = getSheet(SHEETS.CLOSED_ISSUES);
        const liveSheet = getSheet(SHEETS.LIVE_ISSUES);
        const closedData = closedSheet.getDataRange().getValues();
        
        for (let i = 1; i < closedData.length; i++) {
            if (closedData[i][0] === ticketId) {
                const row = closedData.slice(i, i + 1)[0];
                const reopenedRow = row.slice(0, 22);
                reopenedRow[17] = "REOPENED";
                reopenedRow[13] = "ASSIGNED";
                
                liveSheet.appendRow(reopenedRow);
                closedSheet.deleteRow(i + 1);
                
                return {
                    success: true,
                    data: {
                        ticketId: ticketId,
                        state: "REOPENED",
                        reopenedDate: new Date(),
                        reopenedBy: userEmail,
                        reopenReason: reason
                    },
                    error: null
                };
            }
        }
        
        return { success: false, data: null, error: "Ticket not found" };
    } catch (error) {
        return { success: false, data: null, error: error.toString() };
    }
}

// Get Dashboard Metrics
function getDashboardMetrics() {
    try {
        const pendingSheet = getSheet(SHEETS.PENDING_QUEUE);
        const liveSheet = getSheet(SHEETS.LIVE_ISSUES);
        const closedSheet = getSheet(SHEETS.CLOSED_ISSUES);
        
        const pendingData = pendingSheet.getDataRange().getValues();
        const liveData = liveSheet.getDataRange().getValues();
        const closedData = closedSheet.getDataRange().getValues();
        
        let totalPending = pendingData.length - 1;
        let totalActive = liveData.length - 1;
        let totalClosed = closedData.length - 1;
        let criticalPending = 0;
        let slaBreaches = 0;
        let categoryBreakdown = {};
        let towerBreakdown = {};
        let agingIssues = 0;
        let avgClosureTime = 0;
        
        // Count critical pending
        for (let i = 1; i < pendingData.length; i++) {
            if (pendingData[i][9] === "Critical") criticalPending++;
        }
        
        // Count SLA breaches, categories, towers, aging
        const today = new Date();
        let totalClosureTime = 0;
        
        for (let i = 1; i < liveData.length; i++) {
            const severity = liveData[i][9];
            const tower = liveData[i][2];
            const lastUpdated = new Date(liveData[i][20]);
            const slaDate = new Date(liveData[i][18]);
            
            if (today > slaDate) slaBreaches++;
            if ((today - lastUpdated) > 7 * 24 * 60 * 60 * 1000) agingIssues++;
            
            categoryBreakdown[severity] = (categoryBreakdown[severity] || 0) + 1;
            towerBreakdown[tower] = (towerBreakdown[tower] || 0) + 1;
        }
        
        // Average closure time
        for (let i = 1; i < closedData.length; i++) {
            totalClosureTime += closedData[i][24] || 0;
        }
        avgClosureTime = totalClosed > 0 ? (totalClosureTime / totalClosed).toFixed(1) : 0;
        
        return {
            success: true,
            data: {
                totalPending: totalPending,
                totalActive: totalActive,
                totalClosed: totalClosed,
                criticalPending: criticalPending,
                slaBreaches: slaBreaches,
                categoryBreakdown: categoryBreakdown,
                towerBreakdown: towerBreakdown,
                agingIssues: agingIssues,
                avgClosureTime: parseFloat(avgClosureTime),
                builderWorkload: totalActive,
                recentClosed: []
            },
            error: null
        };
    } catch (error) {
        return { success: false, data: null, error: error.toString() };
    }
}

// Main Post Handler
// Handle CORS preflight requests
function doOptions(e) {
    return HtmlService.createHtmlOutput('')
        .addHeader('Access-Control-Allow-Origin', '*')
        .addHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE')
        .addHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        .addHeader('Access-Control-Max-Age', '86400');
}

// Handle GET requests (for direct URL testing)
function doGet(e) {
    return HtmlService.createHtmlOutput(JSON.stringify({
        success: true,
        message: "TA Issue Management API is running",
        status: "Ready",
        version: "1.0"
    }))
        .addHeader('Access-Control-Allow-Origin', '*')
        .addHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE')
        .addHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function doPost(e) {
    try {
        // Parse request body
        let payload = {};
        if (e.postData && e.postData.contents) {
            payload = JSON.parse(e.postData.contents);
        }
        
        const action = payload.action;
        const userEmail = payload.userEmail || "anonymous@test.com";
        
        // Log request for debugging
        Logger.log(`API Request: action=${action}, user=${userEmail}`);
        
        const userRole = validateUserAccess(userEmail);
        if (!userRole || !userRole.hasAccess) {
            return HtmlService.createHtmlOutput(JSON.stringify({
                success: false,
                error: "Unauthorized"
            }))
                .addHeader('Access-Control-Allow-Origin', '*')
                .addHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE')
                .addHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        }
        
        let result;
        switch(action) {
            case "getFormResponses":
                result = getFormResponses();
                break;
            case "getPendingIssues":
                result = getPendingIssues();
                break;
            case "approveIssue":
                result = approveIssue(payload.ticketId, userEmail);
                break;
            case "rejectIssue":
                result = rejectIssue(payload.ticketId, payload.reason, userEmail);
                break;
            case "getLiveIssues":
                result = getLiveIssues(payload.filterOption || "ALL");
                break;
            case "updateBuilderStatus":
                result = updateBuilderStatus(payload.ticketId, payload.status, payload.comment, payload.vendor, payload.closureDate);
                break;
            case "closeIssue":
                result = closeIssue(payload.ticketId, payload.reason, userEmail);
                break;
            case "reopenIssue":
                result = reopenIssue(payload.ticketId, payload.reason, userEmail);
                break;
            case "getDashboardMetrics":
                result = getDashboardMetrics();
                break;
            case "validateUserAccess":
                result = { success: true, data: userRole, error: null };
                break;
            case "syncFormResponses":
                result = syncFormResponses();
                break;
            default:
                result = { success: false, error: "Unknown action: " + action };
        }
        
        return HtmlService.createHtmlOutput(JSON.stringify(result))
            .addHeader('Access-Control-Allow-Origin', '*')
            .addHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE')
            .addHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        
    } catch (error) {
        Logger.log("API Error: " + error.toString());
        return HtmlService.createHtmlOutput(JSON.stringify({
            success: false,
            error: error.toString()
        }))
            .addHeader('Access-Control-Allow-Origin', '*')
            .addHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE')
            .addHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
}

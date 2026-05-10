// API Client for TA Issue Management System
// Configure this endpoint to match your deployed Apps Script Web App

const API = {
    // IMPORTANT: Replace with your Apps Script Web App deployment URL
    ENDPOINT: "https://script.google.com/macros/s/AKfycbyNgktSMgxtw-DReo3FoX14IsfId5EZiry6t4wrqtVco1ereWnhwO0FMvNbpXaBhr8lSQ/exec",
    
    // Configuration
    LOGIN_ENABLED: false, // Set to true to enable login page, false to bypass and use default user
    DEFAULT_TEST_USER: 'ta.deskops@gmail.com', // Default user when LOGIN_ENABLED is false
    
    // Set this after deployment
    setEndpoint(url) {
        this.ENDPOINT = url;
    },
    
    // Toggle login requirement
    setLoginEnabled(enabled) {
        this.LOGIN_ENABLED = enabled;
    },

    async call(action, data = {}) {
        const userEmail = this.DEFAULT_TEST_USER;

        const payload = {
            action: action,
            userEmail: userEmail,
            ...data
        };

        try {
            const response = await fetch(this.ENDPOINT, {
                method: 'POST',
                mode: 'cors',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const result = await response.json();

            if (!result.success) {
                throw new Error(result.error || 'Unknown API error');
            }

            return result.data;

        } catch (error) {
            console.error('API Error:', {
                action,
                payload,
                error
            });

            throw error;
        }
    },

    // Public API Methods

    async getPendingIssues() {
        return await this.call('getPendingIssues');
    },

    async approveIssue(ticketId) {
        return await this.call('approveIssue', { ticketId });
    },

    async rejectIssue(ticketId, reason) {
        return await this.call('rejectIssue', { ticketId, reason });
    },

    async getLiveIssues(filterOption = 'ALL') {
        return await this.call('getLiveIssues', { filterOption });
    },

    async updateBuilderStatus(ticketId, status, comment = '', vendor = '', closureDate = null) {
        return await this.call('updateBuilderStatus', {
            ticketId,
            status,
            comment,
            vendor,
            closureDate
        });
    },

    async closeIssue(ticketId, reason) {
        return await this.call('closeIssue', { ticketId, reason });
    },

    async reopenIssue(ticketId, reason) {
        return await this.call('reopenIssue', { ticketId, reason });
    },

    async getDashboardMetrics() {
        return await this.call('getDashboardMetrics');
    },

    async validateUserAccess(email) {
        return await this.call('validateUserAccess', { userEmail: email });
    },

    async syncFormResponses() {
        return await this.call('syncFormResponses');
    }
};

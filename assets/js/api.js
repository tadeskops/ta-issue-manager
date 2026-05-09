// API Client for TA Issue Management System
// Configure this endpoint to match your deployed Apps Script Web App

const API = {
    // IMPORTANT: Replace with your Apps Script Web App deployment URL
    ENDPOINT: "https://script.google.com/macros/s/AKfycbwZc3oSeaP8ZxtnDDbyvN_EqQrm968vc0kYOJw46XVwcyJFkK7nzJv11gRMw1CAL5zGSA/exec",

    
    // Set this after deployment
    setEndpoint(url) {
        this.ENDPOINT = url;
    },

    async call(action, data = {}) {
        // validateUserAccess is allowed without prior authentication (for login page)
        let userEmail = sessionStorage.getItem('userEmail');
        
        if (!userEmail && action !== 'validateUserAccess') {
            throw new Error('Not authenticated. Please log in.');
        }

        const payload = {
            action: action,
            userEmail: userEmail || data.userEmail || '',
            ...data
        };

        try {
            const response = await fetch(this.ENDPOINT, {
                method: 'POST',
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
            console.error('API Error:', error);
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
    }
};

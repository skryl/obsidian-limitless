import { Notice, TFile, TFolder, normalizePath, requestUrl } from 'obsidian';
import { LimitlessPluginSettings } from '../models/settings';
import { ILimitlessPlugin } from '../models/plugin-interface';
import { SyncState } from '../models/types';
import type { Lifelog } from 'limitless-types';

// Type definitions for API responses
export interface LifelogsResponse {
    data: {
        lifelogs: Lifelog[];
    };
    meta?: {
        lifelogs?: {
            nextCursor?: string;
            count?: number;
        };
    };
}

export class LimitlessAPIService {
    private plugin: ILimitlessPlugin;
    private activeFetchRequests: number = 0; // Track number of active requests
    
    // Constants for retry logic
    private readonly MAX_RETRIES = 5;
    private readonly BASE_DELAY = 2000; // milliseconds
    
    constructor(plugin: ILimitlessPlugin) {
        this.plugin = plugin;
    }
    


    /**
     * Fetch lifelogs from the API for a specific day
     */
    async fetchLifelogsForDay(date: string): Promise<Lifelog[]> {
        try {
            // Check if operation was cancelled before starting
            const syncState = this.plugin as unknown as SyncState;
            if (syncState.cancelSync) {
                this.plugin.log(`Fetch operation for ${date} cancelled before starting`);
                this.plugin.updateSyncStatus('Sync cancelled');
                throw new Error('Operation cancelled');
            }
            
            this.plugin.log(`Fetching lifelogs for ${date}...`);
            this.plugin.updateSyncStatus(`Fetching lifelogs for ${date}...`);
            
            // Build the API endpoint URL with the date parameter
            let endpoint = `${this.plugin.settings.apiUrl}/lifelogs?includeMarkdown=true&sort=desc&limit=10&date=${encodeURIComponent(date)}`;
            
            // Add timezone parameter if enabled
            if (this.plugin.settings.useSystemTimezone) {
                const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
                endpoint += `&timezone=${encodeURIComponent(timezone)}`;
                this.plugin.log('Using timezone for API request:', timezone);
            }
            
            // Make the API request
            const response = await this.makeApiRequest(endpoint);
            
            this.plugin.log(`Retrieved ${response.lifelogs?.length || 0} lifelogs for ${date}`);
            this.plugin.updateSyncStatus(`Retrieved ${response.lifelogs?.length || 0} lifelogs for ${date}`);
            return response.lifelogs || [];
        } catch (error) {
            this.plugin.log('Error fetching lifelogs for day:', error);
            this.plugin.updateSyncStatus('Sync failed - See logs for details');
            new Notice(`Error fetching lifelogs: ${error.message || 'Unknown error'}`);
            throw error;
        }
    }

    /**
     * Fetch all lifelogs since a specific timestamp
     */
    async fetchLifelogsSince(timestamp: string): Promise<Lifelog[]> {
        try {
            // Check if operation was cancelled before starting
            const syncState = this.plugin as unknown as SyncState;
            if (syncState.cancelSync) {
                this.plugin.log('Fetch operation cancelled before starting');
                this.plugin.updateSyncStatus('Sync cancelled');
                throw new Error('Operation cancelled');
            }
            
            this.plugin.log(`Fetching lifelogs since ${timestamp}...`);
            this.plugin.updateSyncStatus(`Fetching lifelogs since ${timestamp}...`);
            
            // Build the API endpoint URL with the start timestamp parameter
            let endpoint = `${this.plugin.settings.apiUrl}/lifelogs?includeMarkdown=true&sort=desc&limit=10&start=${encodeURIComponent(timestamp)}`;
            
            // Include timezone parameter if enabled
            if (this.plugin.settings.useSystemTimezone) {
                const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
                endpoint += `&timezone=${encodeURIComponent(timezone)}`;
                this.plugin.log('Using timezone for API request:', timezone);
            }
            
            // Make the API request with retries
            const response = await this.makeApiRequest(endpoint);
            
            this.plugin.log(`Retrieved ${response.lifelogs?.length || 0} lifelogs since ${timestamp}`);
            this.plugin.updateSyncStatus(`Retrieved ${response.lifelogs?.length || 0} lifelogs since ${timestamp}`);
            return response.lifelogs || [];
        } catch (error) {
            this.plugin.log('Error fetching lifelogs since timestamp:', error);
            this.plugin.updateSyncStatus('Sync failed - See logs for details');
            new Notice(`Error fetching lifelogs: ${error.message || 'Unknown error'}`);
            throw error;
        }
    }
    
    /**
     * Fetch all lifelogs with pagination, handling cursors
     */
    async fetchLifelogs(since: string | null = null, date: string | null = null, cursor: string | null = null, retryCount: number = 0): Promise<LifelogsResponse> {
        // Create a request ID for tracking
        const requestId = Math.random().toString(36).substring(2, 15);
        
        // Track that we're starting a request
        this.activeFetchRequests += 1;
        
        this.plugin.log(`Starting API request ${requestId}, active requests: ${this.activeFetchRequests}`);
        
        try {
            // Check if operation was cancelled before starting
            const syncState = this.plugin as unknown as SyncState;
            if (syncState.cancelSync) {
                this.plugin.log(`Request ${requestId} cancelled before starting`);
                throw new Error('Operation cancelled');
            }
            
            // Start building the URL with required parameters
            let url = `${this.plugin.settings.apiUrl}/lifelogs?includeMarkdown=true&sort=desc`;

            // Add limit parameter (API has a max of 10 per request)
            url += '&limit=10';
            
            const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            url += `&timezone=${encodeURIComponent(timezone)}`;
            this.plugin.log('Using timezone for API request:', timezone);
            
            // Add date parameter if provided (for day-by-day sync)
            if (date) {
                url += `&date=${encodeURIComponent(date)}`;
                this.plugin.log('Fetching lifelogs for specific date:', date);
            }
            // Otherwise, if we have a last sync timestamp, only fetch newer entries
            else if (since) {
                url += `&start=${encodeURIComponent(since)}`;
                this.plugin.log('Fetching lifelogs since:', since);
            }
            
            // Add cursor for pagination if provided
            if (cursor) {
                url += `&cursor=${encodeURIComponent(cursor)}`;
                this.plugin.log('Using pagination cursor:', cursor);
            }
            
            this.plugin.log('Fetching lifelogs from URL:', url, retryCount > 0 ? `(Retry ${retryCount}/${this.MAX_RETRIES})` : '');
            
            // Use Obsidian's requestUrl which handles CORS properly
            const response = await requestUrl({
                url: url,
                method: 'GET',
                headers: {
                    'X-API-Key': `${this.plugin.settings.apiKey}`,
                    'Content-Type': 'application/json'
                }
            });
            
            // Decrement active request count
            this.activeFetchRequests -= 1;
            this.plugin.log(`Completed API request ${requestId}, remaining active requests: ${this.activeFetchRequests}`);
            
            this.plugin.log('Response status:', response.status);
            const responseData = response.json as LifelogsResponse;
            
            // Log pagination information
            if (responseData.meta?.lifelogs?.nextCursor) {
                this.plugin.log('Next cursor available:', responseData.meta.lifelogs.nextCursor);
                this.plugin.log('Fetched', responseData.meta.lifelogs.count, 'lifelogs');
            } else {
                this.plugin.log('No more pages available');
            }

            return responseData;
        } catch (error) {
            // Decrement active request count
            this.activeFetchRequests -= 1;
            this.plugin.log(`Completed API request ${requestId}, remaining active requests: ${this.activeFetchRequests}`);
            
            console.error('Error fetching lifelogs:', error);
            
            // Check if operation was cancelled
            const syncState = this.plugin as unknown as SyncState;
            if (syncState.cancelSync) {
                this.plugin.log(`Request ${requestId} was cancelled due to sync cancellation`);
                throw new Error('Operation cancelled');
            }
            
            // Check for 401 Unauthorized error
            if (error.status === 401) {
                const authError = 'Authentication failed. Please check your API key in the Limitless settings.';
                this.plugin.log(authError);
                new Notice(authError);
                return { data: { lifelogs: [] } };
            }
            
            // Handle 5xx server errors with retries - specifically handle 504 Gateway Timeout
            if (error.status >= 500 && error.status < 600) {
                if (retryCount < this.MAX_RETRIES) {
                    // For 504 Gateway Timeout, use a longer delay
                    const isTimeout = error.status === 504;
                    const baseDelayForError = isTimeout ? this.BASE_DELAY * 2 : this.BASE_DELAY;
                    const delay = baseDelayForError * Math.pow(2, retryCount) + Math.random() * 1000;
                    
                    this.plugin.log(`Server error (${error.status}${isTimeout ? ' Gateway Timeout' : ''}). Retrying in ${Math.round(delay/1000)}s...`);
                    
                    await this.sleep(delay);
                    return this.fetchLifelogs(since, date, cursor, retryCount + 1);
                } else {
                    const maxRetryError = `Maximum retries (${this.MAX_RETRIES}) reached for server error: ${error.status} ${error.message}`;
                    this.plugin.log(maxRetryError);
                    new Notice(maxRetryError);
                    return { data: { lifelogs: [] } };
                }
            }
            
            // Handle 429 Too Many Requests with exponential backoff
            if (error.status === 429) {
                // Get retry-after header if available, otherwise use exponential backoff
                let retryAfter = error.headers?.['retry-after'] ? parseInt(error.headers['retry-after']) * 1000 : this.BASE_DELAY * Math.pow(2, retryCount);
                
                // Cap the maximum delay at 60 seconds
                retryAfter = Math.min(retryAfter, 60000);
                
                this.plugin.log(`Rate limited (429). Waiting for ${retryAfter}ms before retrying...`);
                
                await this.sleep(retryAfter);
                return this.fetchLifelogs(since, date, cursor, retryCount + 1);
            }
            
            // For other errors, log and return empty response
            this.plugin.log(`API request error: ${error.message || 'Unknown error'}`);
            new Notice(`API request error: ${error.message || 'Unknown error'}`);
            return { data: { lifelogs: [] } };
        }
    }

    /**
     * Makes an authenticated API request to the Limitless API with retries
     */
    private async makeApiRequest(endpoint: string, retryCount: number = 0): Promise<any> {
        if (!this.plugin.settings.apiKey) {
            const error = 'API key not set. Please configure your API key in the settings.';
            this.plugin.log(error);
            new Notice(error);
            throw new Error(error);
        }
        
        // Generate a unique request ID for logging
        const requestId = Math.random().toString(36).substring(2, 10);

        try {
            // Log the request details in debug mode
            this.plugin.log(`[${requestId}] API Request:`, {
                method: 'GET',
                url: endpoint,
                headers: {
                    'X-API-Key': 'REDACTED',
                    'Content-Type': 'application/json'
                }
            });
            
            const startTime = Date.now();
            const response = await requestUrl({
                url: endpoint,
                method: 'GET',
                headers: {
                    'X-API-Key': `${this.plugin.settings.apiKey}`,
                    'Content-Type': 'application/json'
                }
            });
            const endTime = Date.now();
            
            // Log the response details in debug mode (Obsidian's requestUrl doesn't throw on HTTP error status)
            this.plugin.log(`[${requestId}] API Response received (${endTime - startTime}ms) with status: ${response.status}`);
            
            // Log full response details for debugging
            try {
                this.plugin.log(`[${requestId}] API Response details:`, {
                    status: response.status,
                    statusText: response.status.toString(),
                    headers: response.headers,
                    contentType: response.headers?.['content-type'],
                    text: response.text ? response.text.substring(0, 300) : null,
                    json: response.json
                });
            } catch (logError) {
                this.plugin.log(`[${requestId}] Error logging response details: ${logError.message}`);
            }

            // Handle non-200 responses (requestUrl doesn't throw on HTTP error status)
            if (response.status !== 200) {
                // Log detailed error information
                this.plugin.log(`[${requestId}] API Error detected:`, {
                    status: response.status,
                    url: endpoint,
                    errorText: response.text ? response.text.substring(0, 300) : 'No error text available'
                });
                
                if (response.status === 401) {
                    const authError = 'Authentication failed. Please check your API key.';
                    this.plugin.log(authError);
                    new Notice(authError);
                    throw new Error(authError);
                }
                
                // Handle rate limiting (429)
                if (response.status === 429) {
                    if (retryCount < this.MAX_RETRIES) {
                        // Get retry-after header if available
                        const retryAfter = response.headers && response.headers['retry-after'];
                        let waitTime = this.BASE_DELAY * Math.pow(2, retryCount); // Exponential backoff
                        
                        if (retryAfter) {
                            // Use server-provided retry time if available
                            waitTime = parseInt(retryAfter, 10) * 1000;
                        }
                        
                        // Cap maximum wait time at 60 seconds
                        waitTime = Math.min(waitTime, 60000);
                        
                        this.plugin.log(`Rate limited (429). Waiting for ${waitTime}ms before retry #${retryCount + 1}`);
                        await this.sleep(waitTime);
                        
                        // Retry the request
                        return this.makeApiRequest(endpoint, retryCount + 1);
                    } else {
                        const error = `Rate limit exceeded after ${this.MAX_RETRIES} retries. Please try again later.`;
                        this.plugin.log(error);
                        new Notice(error);
                        throw new Error(error);
                    }
                }
                
                // Handle server errors (5xx)
                if (response.status >= 500 && response.status < 600) {
                    if (retryCount < this.MAX_RETRIES) {
                        // For 504 Gateway Timeout, use a longer delay
                        const isTimeout = response.status === 504;
                        const baseDelayForError = isTimeout ? this.BASE_DELAY * 2 : this.BASE_DELAY;
                        const delay = baseDelayForError * Math.pow(2, retryCount) + Math.random() * 1000;
                        
                        this.plugin.log(`Server error (${response.status}). Retrying in ${Math.round(delay/1000)}s...`);
                        await this.sleep(delay);
                        
                        // Retry the request
                        return this.makeApiRequest(endpoint, retryCount + 1);
                    }
                }
                
                const error = `API request failed with status ${response.status}`;
                this.plugin.log(error);
                new Notice(error);
                throw new Error(`${error}: ${response.text.substring(0, 100)}${response.text.length > 100 ? '...' : ''}`);
            }

            return response.json;
        } catch (error) {
            // Only retry for network errors, not for auth or client errors
            if ((error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) && retryCount < this.MAX_RETRIES) {
                const delay = this.BASE_DELAY * Math.pow(2, retryCount);
                this.plugin.log(`Network error. Retrying in ${Math.round(delay/1000)}s...`);
                await this.sleep(delay);
                return this.makeApiRequest(endpoint, retryCount + 1);
            }
            
            if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
                const networkError = 'Network error. Please check your internet connection and API URL.';
                this.plugin.log(networkError);
                new Notice(networkError);
                throw new Error(networkError);
            }
            
            this.plugin.log(`Unexpected API error: ${error.message || 'Unknown error'}`);
            new Notice(`API error: ${error.message || 'Unknown error'}`);
            throw error;
        }
    }
    
    /**
     * Cancel all active fetch requests
     */
    /**
     * Reset active request counter
     * Note: With Obsidian's requestUrl we cannot actually cancel in-flight requests
     * But we can track how many are active for logging purposes
     */
    cancelAllRequests(): void {
        this.plugin.log(`Marking ${this.activeFetchRequests} active API requests as cancelled`);
        // We can't actually cancel in-flight requests with requestUrl
        // But we can reset the counter for tracking purposes
        this.activeFetchRequests = 0;
        this.plugin.log('API request tracking reset');
    }
    
    /**
     * Sleep utility function for delays
     */
    private async sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

import { Notice, TFile, TFolder, normalizePath, requestUrl } from 'obsidian';
import { LimitlessPluginSettings } from '../models/settings';
import { ILimitlessPlugin } from '../models/plugin-interface';
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
    private activeFetchRequests: AbortController[] = [];
    
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
            this.plugin.log(`Fetching lifelogs for ${date}...`);
            
            // Build the API endpoint URL with the date
            const endpoint = `${this.plugin.settings.apiUrl}/lifelogs/day/${date}`;
            
            // Make the API request
            const response = await this.makeApiRequest(endpoint);
            
            this.plugin.log(`Retrieved ${response.lifelogs?.length || 0} lifelogs for ${date}`);
            return response.lifelogs || [];
        } catch (error) {
            this.plugin.log('Error fetching lifelogs for day:', error);
            throw error;
        }
    }

    /**
     * Fetch all lifelogs since a specific timestamp
     */
    async fetchLifelogsSince(timestamp: string): Promise<Lifelog[]> {
        try {
            this.plugin.log(`Fetching lifelogs since ${timestamp}...`);
            
            // Build the API endpoint URL with the timestamp
            const endpoint = `${this.plugin.settings.apiUrl}/lifelogs/since/${timestamp}`;
            
            // Include timezone parameter if enabled
            const params = this.plugin.settings.useSystemTimezone 
                ? `?timezone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`
                : '';
            
            // Make the API request with retries
            const response = await this.makeApiRequest(endpoint + params);
            
            this.plugin.log(`Retrieved ${response.lifelogs?.length || 0} lifelogs since ${timestamp}`);
            return response.lifelogs || [];
        } catch (error) {
            this.plugin.log('Error fetching lifelogs since timestamp:', error);
            throw error;
        }
    }
    
    /**
     * Fetch all lifelogs with pagination, handling cursors
     */
    async fetchLifelogs(since: string | null = null, date: string | null = null, cursor: string | null = null, retryCount: number = 0): Promise<LifelogsResponse> {
        // Create a request ID for tracking
        const requestId = Math.random().toString(36).substring(2, 15);
        
        // Create an AbortController for this request
        const controller = new AbortController();
        controller['requestId'] = requestId;
        
        // Add to active requests list for tracking and potential cancellation
        this.activeFetchRequests.push(controller);
        
        try {
            // Start building the URL with required parameters
            let url = `${this.plugin.settings.apiUrl}/lifelogs?includeMarkdown=true&sort=desc`;

            // Add limit parameter (API has a max of 10 per request)
            url += '&limit=10';
            
            // Add timezone parameter if enabled
            if (this.plugin.settings.useSystemTimezone) {
                const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
                url += `&timezone=${encodeURIComponent(timezone)}`;
                this.plugin.log('Using timezone for API request:', timezone);
            }
            
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
            
            // Remove from active requests list
            const index = this.activeFetchRequests.indexOf(controller);
            if (index > -1) {
                this.activeFetchRequests.splice(index, 1);
            }
            
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
            // Remove from active requests list
            const index = this.activeFetchRequests.indexOf(controller);
            if (index > -1) {
                this.activeFetchRequests.splice(index, 1);
            }
            
            console.error('Error fetching lifelogs:', error);
            
            // Check for 401 Unauthorized error
            if (error.status === 401) {
                throw new Error('Authentication failed. Please check your API key in the Limitless settings.');
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
                    this.plugin.log(`Maximum retries (${this.MAX_RETRIES}) reached for server error.`);
                    throw new Error(`Server error after ${this.MAX_RETRIES} retries: ${error.status} ${error.message}`);
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
            
            // For other errors, just throw
            throw error;
        }
    }

    /**
     * Makes an authenticated API request to the Limitless API with retries
     */
    private async makeApiRequest(endpoint: string, retryCount: number = 0): Promise<any> {
        if (!this.plugin.settings.apiKey) {
            throw new Error('API key not set. Please configure your API key in the settings.');
        }

        try {
            const response = await requestUrl({
                url: endpoint,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.plugin.settings.apiKey}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.status !== 200) {
                if (response.status === 401) {
                    throw new Error('Authentication failed. Please check your API key.');
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
                        throw new Error(`Rate limit exceeded after ${this.MAX_RETRIES} retries. Please try again later.`);
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
                
                throw new Error(`API request failed with status ${response.status}`);
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
                throw new Error('Network error. Please check your internet connection and API URL.');
            }
            
            throw error;
        }
    }
    
    /**
     * Cancel all active fetch requests
     */
    cancelAllRequests(): void {
        this.plugin.log(`Cancelling ${this.activeFetchRequests.length} active requests`);
        for (const controller of this.activeFetchRequests) {
            controller.abort();
        }
        this.activeFetchRequests = [];
    }
    
    /**
     * Sleep utility function for delays
     */
    private async sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

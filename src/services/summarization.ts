import { Notice, TFile, TFolder, normalizePath, requestUrl } from 'obsidian';
import { ILimitlessPlugin } from '../models/plugin-interface';
import * as crypto from 'crypto';

/**
 * Utility function to sleep for a specified number of milliseconds
 */
async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class SummarizationService {
    private plugin: ILimitlessPlugin;
    private activeRequests: number = 0; // Track number of active requests
    
    // Constants for retry logic
    private readonly MAX_RETRIES = 5;
    private readonly BASE_DELAY = 2000; // milliseconds
    
    constructor(plugin: ILimitlessPlugin) {
        this.plugin = plugin;
    }
    


    /**
     * Main method to summarize all notes
     */
    async summarizeAllNotes(forceAll: boolean = false): Promise<void> {
        try {
            // Reset state
            this.plugin.isSummarizing = true;
            this.plugin.cancelSummarization = false;
            
            // Update status in UI with appropriate message
            if (forceAll) {
                this.plugin.updateSummarizationStatus('Starting force summarization from start date...');
            } else {
                this.plugin.updateSummarizationStatus('Starting incremental summarization...');
            }
            
            // Get all notes that need summarization
            const notesToSummarize = await this.getNotesNeedingSummarization(forceAll);
            
            if (notesToSummarize.length === 0) {
                new Notice('No notes need summarization');
                this.plugin.updateSummarizationStatus('No notes need summarization');
                return;
            }
            
            this.plugin.log(`Starting summarization of ${notesToSummarize.length} notes`);
            this.plugin.updateSummarizationStatus(`Summarizing ${notesToSummarize.length} notes...`);
            
            // Process each note
            await this.processNotesForSummarization(notesToSummarize);
            
            // Update lastSummaryTimestamp and save settings
            this.plugin.settings.lastSummaryTimestamp = new Date().toISOString();
            await this.plugin.saveSettings();
            
            // Update status after successful completion
            this.plugin.updateSummarizationStatus('Idle');
            new Notice(`Summarization complete! ${notesToSummarize.length} notes processed.`);
        } catch (error) {
            console.error('Error during summarization:', error);
            new Notice(`Error during summarization: ${error.message}`);
            
            // Update status after error
            this.plugin.updateSummarizationStatus(`Error: ${error.message}`);
        } finally {
            // Always reset the summarizing flag
            this.plugin.isSummarizing = false;
            
            // Force UI refresh if settings tab is open
            const settingsTabs = (this.plugin.app as any).setting?.settingTabs;
            const settingsTab = settingsTabs ? 
                settingsTabs.find((tab: any) => tab.id === 'limitless') : undefined;
            if (settingsTab && typeof settingsTab.updateStatusDisplay === 'function') {
                // Force a UI refresh with current status after a small delay
                setTimeout(() => {
                    const status = this.plugin.lastSummarizationStatus || 'Idle';
                    settingsTab.updateStatusDisplay('summarization', status);
                }, 50);
            }
        }
    }

    /**
     * Cancel ongoing summarization
     */
    async cancelOngoingSummarization(): Promise<void> {
        this.plugin.log('Cancelling summarization');
        this.plugin.updateSummarizationStatus('Cancelling summarization...');
        this.plugin.cancelSummarization = true;
        
        // Set status to cancelled after a brief delay
        setTimeout(() => {
            if (this.plugin.cancelSummarization) {
                this.plugin.updateSummarizationStatus('Cancelled');
                this.plugin.isSummarizing = false;
            }
        }, 1000);
        
        // Cancel any active API requests
        this.cancelAllRequests();
    }
    
    /**
     * Reset active request counter
     * Note: With Obsidian's requestUrl we cannot actually cancel in-flight requests
     * But we can track how many are active for logging purposes
     */
    cancelAllRequests(): void {
        this.plugin.log(`Marking ${this.activeRequests} active OpenAI requests as cancelled`);
        // We can't actually cancel in-flight requests with requestUrl
        // But we can reset the counter to prevent counting obsolete requests
        this.activeRequests = 0;
        this.plugin.log('OpenAI request tracking reset');
        this.plugin.updateSummarizationStatus('Summarization cancelled');
    }

    /**
     * Process a list of notes that need summarization
     */
    async processNotesForSummarization(notePaths: string[]): Promise<void> {
        // Read existing hashes
        const hashes = await this.readHashFile();
        
        // Process each note
        for (let i = 0; i < notePaths.length; i++) {
            // Check if summarization was cancelled
            if (this.plugin.cancelSummarization) {
                this.plugin.log('Summarization cancelled');
                this.plugin.updateSummarizationStatus('Summarization cancelled');
                new Notice('Summarization cancelled');
                break;
            }
            
            const notePath = notePaths[i];
            this.plugin.log(`Summarizing note ${i + 1}/${notePaths.length}: ${notePath}`);
            this.plugin.updateSummarizationStatus(`Summarizing note ${i + 1}/${notePaths.length}...`);
            
            try {
                // Get the note file
                const file = this.plugin.app.vault.getAbstractFileByPath(notePath);
                if (file instanceof TFile) {
                    // Read the note content
                    const content = await this.plugin.app.vault.read(file);
                    
                    // Generate a summary
                    const summary = await this.generateNoteSummary(content, file.path);
                    
                    // Save the summary to a file
                    const summaryFolder = await this.ensureSummaryFolder();
                    const fileName = file.path.split('/').pop() || '';
                    const summaryPath = normalizePath(`${this.plugin.settings.summaryOutputFolder}/${fileName}`);
                    
                    await this.saveSummaryToFile(file.path, summary);
                    
                    // Update the hash for this note
                    const hash = await this.generateSHA256(content);
                    hashes[file.path] = hash;
                    await this.writeHashFile(hashes);
                    
                    this.plugin.log(`Summarized note: ${file.path}`);
                    
                    // Show progress notification every 5 notes
                    if (i % 5 === 0 || i === notePaths.length - 1) {
                        new Notice(`Summarization progress: ${i + 1}/${notePaths.length} notes`);
                    }
                } else {
                    this.plugin.log(`File not found: ${notePath}`);
                }
            } catch (error) {
                console.error(`Error summarizing ${notePath}:`, error);
                new Notice(`Error summarizing ${notePath}: ${error.message}`);
            }
        }
        
        // Summarization complete
        if (!this.plugin.cancelSummarization) {
            new Notice(`Summarization complete. Processed ${notePaths.length} notes.`);
        }
    }

    /**
     * Generate a summary for a note using the OpenAI API with retry logic
     */
    async generateNoteSummary(content: string, notePath: string, retryCount: number = 0): Promise<string> {
        if (!this.plugin.settings.openaiApiKey) {
            const errorMsg = 'OpenAI API key is not set';
            this.plugin.log(errorMsg);
            new Notice(errorMsg);
            throw new Error(errorMsg);
        }
        
        // Track that we're starting a request
        this.activeRequests += 1;
        
        try {
            this.plugin.log(`Generating summary for ${notePath}${retryCount > 0 ? ` (retry ${retryCount}/${this.MAX_RETRIES})` : ''}`);
            
            // Check if the operation has been cancelled
            if (this.plugin.cancelSummarization) {
                this.plugin.log('Summary generation cancelled by user');
                throw new Error('Summary generation was cancelled');
            }
            
            // Create the messages for the API request
            const messages = [
                {
                    "role": "system",
                    "content": this.plugin.settings.summarizationPrompt
                },
                {
                    "role": "user",
                    "content": content
                }
            ];
            
            // Generate a unique request ID for logging
            const requestId = Math.random().toString(36).substring(2, 10);
            
            // Create the request body
            const requestBody = {
                model: this.plugin.settings.openaiModelName,
                messages: messages,
                temperature: 0.7,
                max_tokens: 1000
            };
            
            // Log the request details in debug mode
            this.plugin.log(`[${requestId}] OpenAI API Request:`, {
                method: 'POST',
                url: 'https://api.openai.com/chat/completions',
                headers: {
                    'Authorization': 'Bearer REDACTED',
                    'Content-Type': 'application/json'
                },
                body: requestBody
            });
            
            // Make the API request using Obsidian's requestUrl
            const startTime = Date.now();
            const response = await requestUrl({
                url: 'https://api.openai.com/chat/completions',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.plugin.settings.openaiApiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });
            const endTime = Date.now();
            
            // Log the response details in debug mode
            this.plugin.log(`[${requestId}] OpenAI API Response (${endTime - startTime}ms):`, {
                status: response.status,
                statusText: response.status.toString(),
                headers: response.headers,
                data: response.json
            });
            
            // Decrement active request count
            this.activeRequests -= 1;
            
            // Handle errors for all non-200 responses
            if (response.status !== 200) {
                // Log detailed error information for debugging
                this.plugin.log(`[${requestId}] OpenAI API Error Response Details:`, {
                    status: response.status,
                    statusText: response.status.toString(),
                    body: response.text,
                    json: response.json,
                    url: 'https://api.openai.com/chat/completions'
                });
                
                // Handle rate limiting (429)
                if (response.status === 429) {
                    if (retryCount >= this.MAX_RETRIES) {
                        const errorMsg = `OpenAI API rate limit exceeded. Maximum retries (${this.MAX_RETRIES}) reached.`;
                        this.plugin.log(errorMsg);
                        new Notice(errorMsg);
                        throw new Error(errorMsg);
                    }
                
                // Get retry-after header if available, otherwise use exponential backoff
                const retryAfter = response.headers && response.headers['retry-after'];
                let waitTime = this.BASE_DELAY * Math.pow(2, retryCount); // Exponential backoff
                
                if (retryAfter) {
                    // Use server-provided retry time if available
                    waitTime = parseInt(retryAfter, 10) * 1000;
                }
                
                // Cap maximum wait time at 60 seconds
                waitTime = Math.min(waitTime, 60000);
                
                this.plugin.log(`Rate limited by OpenAI API (429). Retrying in ${waitTime/1000}s (attempt ${retryCount+1}/${this.MAX_RETRIES})`);
                await sleep(waitTime);
                
                // Retry the request
                return this.generateNoteSummary(content, notePath, retryCount + 1);
            }
            
            // Handle server errors (5xx)
            if (response.status >= 500 && response.status < 600) {
                if (retryCount >= this.MAX_RETRIES) {
                    const errorMsg = `OpenAI API server error (${response.status}). Maximum retries (${this.MAX_RETRIES}) reached.`;
                    this.plugin.log(errorMsg);
                    new Notice(errorMsg);
                    throw new Error(errorMsg);
                }
                
                const waitTime = this.BASE_DELAY * Math.pow(1.5, retryCount);
                this.plugin.log(`Server error (${response.status}). Retrying in ${waitTime/1000}s (attempt ${retryCount+1}/${this.MAX_RETRIES})`);
                await sleep(waitTime);
                
                // Retry the request
                return this.generateNoteSummary(content, notePath, retryCount + 1);
            }
            
                // Handle other errors if not rate limiting
                const errorData = response.json;
                const errorMsg = `OpenAI API error (${response.status}): ${errorData.error?.message || JSON.stringify(errorData)}`;
                this.plugin.log(errorMsg);
                new Notice(errorMsg);
                throw new Error(errorMsg);
            }
            
            // Parse the OpenAI API response
            const result = response.json;
            const summary = result?.choices?.[0]?.message?.content || 'Error: Unable to parse summary from API response';
            
            // Add metadata to the summary
            const metadata = this.generateSummaryMetadata(notePath);
            const fullSummary = `${metadata}\n\n${summary}`;
            
            return fullSummary;
        } catch (error) {
            // Decrement active request count
            this.activeRequests -= 1;
            
            // Check for cancellation
            if (this.plugin.cancelSummarization) {
                this.plugin.log(`Summary generation for ${notePath} was cancelled`);
                this.plugin.log('Summary generation was cancelled');
                throw new Error('Summary generation was cancelled');
            }
            
            // Handle network errors with retry
            if ((error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) && retryCount < this.MAX_RETRIES) {
                const waitTime = this.BASE_DELAY * Math.pow(2, retryCount);
                this.plugin.log(`Network error. Retrying in ${waitTime/1000}s (attempt ${retryCount+1}/${this.MAX_RETRIES})`);
                await sleep(waitTime);
                
                // Retry the request
                return this.generateNoteSummary(content, notePath, retryCount + 1);
            }
            
            this.plugin.log('Error generating summary:', error);
            this.plugin.log(`Error writing summary for ${notePath}:`, error);
            new Notice(`Error writing summary: ${error.message || 'Unknown error'}`);
            throw error;
        }
    }

    /**
     * Test if the OpenAI connection is valid
     */
    async testOpenAIConnection(): Promise<boolean> {
        if (!this.plugin.settings.openaiApiKey) {
            new Notice('Please enter an OpenAI API key first');
            return false;
        }
        
        this.plugin.log('Testing OpenAI connection...');
        
        try {
            const models = await this.fetchAvailableModels();
            
            if (models.length === 0) {
                return false;
            }
            
            // Check if the selected model is available
            const modelExists = models.some((modelId: string) => modelId === this.plugin.settings.openaiModelName);
            
            if (!modelExists) {
                new Notice(`API key is valid, but model "${this.plugin.settings.openaiModelName}" was not found. Please check the model name.`);
                return false;
            }
            
            new Notice('OpenAI connection successful! API key and model are valid.');
            return true;
        } catch (error) {
            console.error('Error testing OpenAI connection:', error);
            new Notice(`Error connecting to OpenAI: ${error.message}`);
            return false;
        }
    }
    
    /**
     * Fetch available OpenAI models
     */
    

    
    /**
     * Fetch available models from OpenAI with retry and exponential backoff
     */
    async fetchAvailableModels(): Promise<string[]> {
        if (!this.plugin.settings.openaiApiKey) {
            this.plugin.log('No OpenAI API key provided');
            return [];
        }
        
        this.plugin.log('Fetching available OpenAI models...');
        
        // Track that we're starting a request
        this.activeRequests += 1;
        
        let retryCount = 0;
        let lastError: Error | null = null;
        
        while (retryCount <= this.MAX_RETRIES) {
            try {
                // Make a request to the OpenAI API to get available models
                const response = await requestUrl({
                    url: 'https://api.openai.com/v1/models',
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${this.plugin.settings.openaiApiKey}`,
                        'Content-Type': 'application/json'
                    }
                });
                
                // Decrement active request count
                this.activeRequests -= 1;
                
                if (response.status !== 200) {
                    // For authentication errors (401/403), don't retry
                    if (response.status === 401 || response.status === 403) {
                        this.plugin.log(`Authentication error: ${response.status} - Invalid API key`);
                        const errorMsg = `Authentication failed. Please check your API key. (Status: ${response.status})`;
                        this.plugin.log(errorMsg);
                        new Notice(errorMsg);
                        return [];
                    }
                    
                    // For rate limit errors (429), retry with backoff
                    if (response.status === 429) {
                        lastError = new Error(`Rate limited by OpenAI API. (Status: ${response.status})`);
                        
                        // Get retry-after header if available
                        const retryAfter = response.headers && response.headers['retry-after'];
                        let waitTime = Math.pow(2, retryCount) * 1000; // Exponential backoff: 1s, 2s, 4s...
                        
                        if (retryAfter) {
                            // Use server-provided retry time if available
                            waitTime = parseInt(retryAfter, 10) * 1000;
                        }
                        
                        // Cap maximum wait time
                        waitTime = Math.min(waitTime, 60000);
                        
                        this.plugin.log(`Rate limited by OpenAI API. Retrying in ${waitTime/1000}s (attempt ${retryCount+1}/${this.MAX_RETRIES+1})`);
                        await sleep(waitTime);
                        retryCount++;
                        continue;
                    }
                    
                    // For server errors (5xx), retry with backoff
                    if (response.status >= 500 && response.status < 600) {
                        lastError = new Error(`Server error: ${response.status}`);
                        const waitTime = Math.min(this.BASE_DELAY * Math.pow(1.5, retryCount), 15000);
                        
                        this.plugin.log(`Server error (${response.status}). Retrying in ${waitTime/1000}s (attempt ${retryCount+1}/${this.MAX_RETRIES+1})`);
                        await sleep(waitTime);
                        retryCount++;
                        continue;
                    }
                    
                    const errorMsg = `API request failed with status ${response.status}`;
                    this.plugin.log(errorMsg);
                    new Notice(errorMsg);
                    return [];
                }
            
                const data = response.json;
                const allModels = data.data;
                
                this.plugin.log(`Received ${allModels.length} models from OpenAI API`);
                
                // Filter only GPT models that can be used for chat completions
                const chatModels = allModels
                    .filter((model: any) => 
                        (model.id.includes('gpt-3.5') || model.id.includes('gpt-4')) && 
                        !model.id.includes('instruct') &&
                        !model.id.includes('vision')
                    )
                    .map((model: any) => model.id);
                
                this.plugin.log(`Filtered to ${chatModels.length} usable chat models: ${chatModels.join(', ')}`);
                
                // If no chat models found, return empty array to signal failure
                if (chatModels.length === 0) {
                    this.plugin.log('No usable chat models found');
                    return [];
                }
                
                return chatModels;
            } catch (error) {
                // Decrement active request count
                this.activeRequests -= 1;
                
                // Check if operation was cancelled
                if (this.plugin.cancelSummarization) {
                    this.plugin.log('Model fetching was cancelled');
                    this.plugin.log(`Request was cancelled by user`);
                    return []; // Return empty array instead of string to match return type
                }
                
                // Save the error for potential final retry failure
                lastError = error;
                
                // Handle network errors with retry
                if ((error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) && retryCount < this.MAX_RETRIES) {
                    const waitTime = this.BASE_DELAY * Math.pow(2, retryCount);
                    this.plugin.log(`Network error. Retrying in ${waitTime/1000}s (attempt ${retryCount+1}/${this.MAX_RETRIES})`);
                    await sleep(waitTime);
                    retryCount++;
                    continue;
                }
                
                // If this isn't a rate limit error or network error, or we've used all retries, break out
                if (!(error.message && error.message.includes('Rate limited')) || retryCount >= this.MAX_RETRIES) {
                    break;
                }
                
                // Otherwise, we continue the loop
                retryCount++;
            }
        }
        
        // If we get here, we've exhausted all retries or encountered a non-retry error
        console.error('Error fetching available models:', lastError);
        this.plugin.log(`Error fetching models: ${lastError?.message || 'Unknown error'}`);
        
        // Check if this is an authentication error
        if (lastError?.message && (lastError.message.includes('401') || lastError.message.includes('403') || 
                           lastError.message.includes('Authentication failed'))) {
            this.plugin.log('Authentication error detected - returning empty array');
            return [];
        }
        
        // Return empty array for all errors
        this.plugin.log('Error occurred after retries - returning empty array');
        return [];
    }

    /**
     * Generate metadata for a summary
     */
    private generateSummaryMetadata(notePath: string): string {
        return [
            '---',
            `source: ${notePath}`,
            `generated: ${new Date().toISOString()}`,
            `model: ${this.plugin.settings.openaiModelName}`,
            '---',
            ''
        ].join('\n');
    }

    /**
     * Save a summary to a file
     */
    async saveSummaryToFile(notePath: string, summary: string): Promise<void> {
        // Ensure the summary folder exists
        await this.ensureSummaryFolder();
        
        // Get the filename from the note path
        const fileName = notePath.split('/').pop();
        
        // Create the summary path
        const summaryPath = normalizePath(`${this.plugin.settings.summaryOutputFolder}/${fileName}`);
        
        // Save the summary
        const file = this.plugin.app.vault.getAbstractFileByPath(summaryPath);
        
        if (file instanceof TFile) {
            // Update existing file
            await this.plugin.app.vault.modify(file, summary);
        } else {
            // Create new file
            await this.plugin.app.vault.create(summaryPath, summary);
        }
        
        this.plugin.log(`Summary saved to ${summaryPath}`);
    }

    /**
     * Ensure summary output folder exists
     */
    async ensureSummaryFolder(): Promise<TFolder | null> {
        const folderPath = normalizePath(this.plugin.settings.summaryOutputFolder);
        let folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);
        
        if (!folder) {
            // Create the folder if it doesn't exist
            this.plugin.log(`Creating summary folder: ${folderPath}`);
            folder = await this.plugin.app.vault.createFolder(folderPath);
        } else if (!(folder instanceof TFolder)) {
            const errorMsg = `${folderPath} exists but is not a folder`;
            this.plugin.log(errorMsg);
            new Notice(errorMsg);
            return null;
        }
        
        return folder as TFolder;
    }

    /**
     * Get all daily notes that need to be summarized
     */
    async getNotesNeedingSummarization(forceAll = false): Promise<string[]> {
        // Get the hash file
        const hashes = await this.readHashFile();
        
        // Get all daily notes in the configured folder
        const folderPath = normalizePath(this.plugin.settings.outputFolder);
        const folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);
        
        if (!folder || !(folder instanceof TFolder)) {
            this.plugin.log('Daily notes folder not found:', folderPath);
            return [];
        }
        
        const notesNeedingSummarization: string[] = [];
        
        // Check each file in the folder
        for (const file of folder.children) {
            if (file instanceof TFile && file.extension === 'md') {
                // If forcing all summaries, check the date if we have a start date
                if (forceAll) {
                    const summaryStartDate = this.plugin.settings.summaryStartDate;
                    
                    if (summaryStartDate) {
                        // Extract date from filename (assuming format like 2023-01-01.md)
                        const fileDate = file.name.replace('.md', '').match(/^(\d{4}-\d{2}-\d{2})/);
                        if (fileDate) {
                            // Compare with the start date
                            if (fileDate[1] >= summaryStartDate) {
                                notesNeedingSummarization.push(file.path);
                            }
                        } else {
                            // If no date in filename, include it anyway
                            notesNeedingSummarization.push(file.path);
                        }
                    } else {
                        // If no start date, include all files
                        notesNeedingSummarization.push(file.path);
                    }
                } else {
                    // Otherwise, check if the hash has changed
                    const content = await this.plugin.app.vault.read(file);
                    const hash = await this.generateSHA256(content);
                    
                    // If the hash doesn't exist or has changed, add to the list
                    if (!hashes[file.path] || hashes[file.path] !== hash) {
                        notesNeedingSummarization.push(file.path);
                    }
                }
            }
        }
        
        this.plugin.log(`Found ${notesNeedingSummarization.length} notes needing summarization`);
        return notesNeedingSummarization;
    }

    /**
     * Generate a SHA256 hash for content
     */
    async generateSHA256(content: string): Promise<string> {
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    /**
     * Path to the hash file
     */
    private get hashFilePath(): string {
        // Use the configDir as fallback location for our hash file
        return normalizePath(`${this.plugin.app.vault.configDir}/.limitless-note-hashes.json`);
    }

    /**
     * Read the hash file or create it if it doesn't exist
     */
    async readHashFile(): Promise<Record<string, string>> {
        try {
            const hashPath = this.hashFilePath;
            
            // Check if file exists
            const fileExists = await this.plugin.app.vault.adapter.exists(hashPath);
            if (fileExists) {
                // Read the file content
                const fileContent = await this.plugin.app.vault.adapter.read(hashPath);
                return JSON.parse(fileContent);
            }
            return {};
        } catch (error) {
            this.plugin.log('Error reading hash file:', error);
            return {};
        }
    }

    /**
     * Write to the hash file
     */
    async writeHashFile(hashes: Record<string, string>): Promise<void> {
        try {
            // Write content to file
            await this.plugin.app.vault.adapter.write(
                this.hashFilePath, 
                JSON.stringify(hashes, null, 2)
            );
        } catch (error) {
            this.plugin.log('Error writing hash file:', error);
            new Notice(`Error writing file: ${error.message || 'Unknown error'}`);
            // Continue without throwing
        }
    }
}

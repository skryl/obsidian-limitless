import { Notice, TFile, TFolder, normalizePath } from 'obsidian';
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
    private activeRequests: AbortController[] = [];
    
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
            this.plugin.summarizationCurrent = 0;
            this.plugin.summarizationTotal = 0;
            this.plugin.summarizationProgressText = 'Checking for notes to summarize...';
            
            // Get all notes that need summarization
            const notesToSummarize = await this.getNotesNeedingSummarization(forceAll);
            this.plugin.summarizationTotal = notesToSummarize.length;
            
            if (notesToSummarize.length === 0) {
                this.plugin.summarizationProgressText = 'No notes need summarization';
                new Notice('No notes need summarization');
                return;
            }
            
            this.plugin.summarizationProgressText = `Summarizing ${notesToSummarize.length} notes...`;
            this.plugin.log(`Starting summarization of ${notesToSummarize.length} notes`);
            
            // Process each note
            await this.processNotesForSummarization(notesToSummarize);
        } catch (error) {
            console.error('Error during summarization:', error);
            this.plugin.summarizationProgressText = `Error: ${error.message}`;
            new Notice(`Error during summarization: ${error.message}`);
        } finally {
            this.plugin.isSummarizing = false;
        }
    }

    /**
     * Cancel ongoing summarization
     */
    async cancelOngoingSummarization(): Promise<void> {
        this.plugin.log('Cancelling summarization');
        this.plugin.cancelSummarization = true;
        
        // Cancel any active API requests
        this.cancelAllRequests();
    }
    
    /**
     * Cancel all active API requests
     */
    cancelAllRequests(): void {
        this.plugin.log(`Cancelling ${this.activeRequests.length} active OpenAI requests`);
        
        // Abort all active controllers
        for (const controller of this.activeRequests) {
            controller.abort();
        }
        
        // Clear the list
        this.activeRequests = [];
        this.plugin.log('All OpenAI requests cancelled');
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
                this.plugin.summarizationProgressText = 'Summarization cancelled';
                new Notice('Summarization cancelled');
                break;
            }
            
            const notePath = notePaths[i];
            this.plugin.summarizationCurrent = i + 1;
            this.plugin.summarizationProgressText = `Summarizing note ${i + 1}/${notePaths.length}: ${notePath}`;
            
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
                        new Notice(`Summarization progress: ${this.plugin.summarizationCurrent}/${this.plugin.summarizationTotal} notes`);
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
            this.plugin.summarizationProgressText = 'Summarization complete';
            new Notice(`Summarization complete. Processed ${this.plugin.summarizationCurrent} notes.`);
        }
    }

    /**
     * Generate a summary for a note using the OpenAI API with retry logic
     */
    async generateNoteSummary(content: string, notePath: string, retryCount: number = 0): Promise<string> {
        if (!this.plugin.settings.openaiApiKey) {
            throw new Error('OpenAI API key is not set');
        }
        
        // Create an abort controller for this request
        const controller = new AbortController();
        this.activeRequests.push(controller);
        
        try {
            this.plugin.log(`Generating summary for ${notePath}${retryCount > 0 ? ` (retry ${retryCount}/${this.MAX_RETRIES})` : ''}`);
            
            // Check if the operation has been cancelled
            if (this.plugin.cancelSummarization) {
                throw new Error('Summary generation cancelled');
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
            
            // Make the API request with the abort signal
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.plugin.settings.openaiApiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: this.plugin.settings.openaiModelName,
                    messages: messages,
                    temperature: 0.7,
                    max_tokens: 1000
                }),
                signal: controller.signal
            });
            
            // Remove this controller from active list
            this.activeRequests = this.activeRequests.filter(c => c !== controller);
            
            // Handle rate limiting (429)
            if (response.status === 429) {
                if (retryCount >= this.MAX_RETRIES) {
                    throw new Error(`OpenAI API rate limit exceeded. Maximum retries (${this.MAX_RETRIES}) reached.`);
                }
                
                // Get retry-after header if available, otherwise use exponential backoff
                const retryAfter = response.headers.get('retry-after');
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
                    throw new Error(`OpenAI API server error (${response.status}). Maximum retries (${this.MAX_RETRIES}) reached.`);
                }
                
                const waitTime = this.BASE_DELAY * Math.pow(1.5, retryCount);
                this.plugin.log(`Server error (${response.status}). Retrying in ${waitTime/1000}s (attempt ${retryCount+1}/${this.MAX_RETRIES})`);
                await sleep(waitTime);
                
                // Retry the request
                return this.generateNoteSummary(content, notePath, retryCount + 1);
            }
            
            // Handle other errors
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(`OpenAI API error (${response.status}): ${errorData.error?.message || JSON.stringify(errorData)}`);
            }
            
            const result = await response.json();
            const summary = result.choices[0].message.content;
            
            // Add metadata to the summary
            const metadata = this.generateSummaryMetadata(notePath);
            const fullSummary = `${metadata}\n\n${summary}`;
            
            return fullSummary;
        } catch (error) {
            // Remove this controller from active list
            this.activeRequests = this.activeRequests.filter(c => c !== controller);
            
            // Handle abort errors
            if (error.name === 'AbortError') {
                this.plugin.log(`Summary generation for ${notePath} was cancelled`);
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
        
        // Create an abort controller for this request
        const controller = new AbortController();
        this.activeRequests.push(controller);
        
        let retryCount = 0;
        let lastError: Error | null = null;
        
        while (retryCount <= this.MAX_RETRIES) {
            try {
                // Make a request to the OpenAI API to get available models with the abort signal
                const response = await fetch('https://api.openai.com/v1/models', {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${this.plugin.settings.openaiApiKey}`,
                        'Content-Type': 'application/json'
                    },
                    signal: controller.signal
                });
                
                // Remove this controller from active list after request completes
                this.activeRequests = this.activeRequests.filter(c => c !== controller);
                
                if (!response.ok) {
                    // For authentication errors (401/403), don't retry
                    if (response.status === 401 || response.status === 403) {
                        this.plugin.log(`Authentication error: ${response.status} - Invalid API key`);
                        throw new Error(`Authentication failed. Please check your API key. (Status: ${response.status})`);
                    }
                    
                    // For rate limit errors (429), retry with backoff
                    if (response.status === 429) {
                        lastError = new Error(`Rate limited by OpenAI API. (Status: ${response.status})`);
                        
                        // Get retry-after header if available
                        const retryAfter = response.headers.get('retry-after');
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
                    
                    throw new Error(`API request failed with status ${response.status}`);
                }
            
                const data = await response.json();
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
                // Remove this controller from active list if error
                this.activeRequests = this.activeRequests.filter(c => c !== controller);
                
                // Handle abort errors
                if (error.name === 'AbortError') {
                    this.plugin.log('Model fetching was cancelled');
                    throw error;
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
    async ensureSummaryFolder(): Promise<TFolder> {
        const folderPath = normalizePath(this.plugin.settings.summaryOutputFolder);
        let folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);
        
        if (!folder) {
            // Create the folder if it doesn't exist
            this.plugin.log(`Creating summary folder: ${folderPath}`);
            folder = await this.plugin.app.vault.createFolder(folderPath);
        } else if (!(folder instanceof TFolder)) {
            throw new Error(`${folderPath} exists but is not a folder`);
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
                if (forceAll) {
                    // If force all is true, add all md files
                    notesNeedingSummarization.push(file.path);
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
            throw error;
        }
    }
}

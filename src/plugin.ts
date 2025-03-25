import { Plugin, TFile, TFolder, Notice } from 'obsidian';
import { LimitlessSettingTab } from './ui/settings-tab';
import { LimitlessPluginSettings, DEFAULT_SETTINGS } from './models/settings';
import { LimitlessAPIService } from './services/api';
import { SummarizationService } from './services/summarization';
import { FileUtils } from './utils/file-utils';
import { SyncState, SummarizationState, Lifelog } from './models/types';

export class LimitlessPlugin extends Plugin implements SyncState, SummarizationState {
    settings: LimitlessPluginSettings;
    apiService: LimitlessAPIService;
    summarizationService: SummarizationService;
    fileUtils: FileUtils;
    
    // Sync state
    isSyncing: boolean = false;
    cancelSync: boolean = false;
    lastSyncStatus: string = 'Idle';
    
    // Summarization state
    isSummarizing: boolean = false;
    cancelSummarization: boolean = false;
    lastSummarizationStatus: string = 'Idle';
    
    private syncIntervalId: number | null = null;

    async onload() {
        await this.loadSettings();
        
        // Initialize services
        this.apiService = new LimitlessAPIService(this);
        this.summarizationService = new SummarizationService(this);
        this.fileUtils = new FileUtils(this);

        // Add settings tab
        this.addSettingTab(new LimitlessSettingTab(this.app, this));

        // Register commands
        this.addCommands();
        
        // Register interval
        this.registerSyncInterval();
        
        // Initial sync if enabled
        if (this.settings.apiKey) {
            this.syncLifelogs().catch(error => this.log('Error during initial sync:', error));
        }
        
        this.log('Plugin loaded');
    }

    onunload() {
        // Clear interval
        if (this.syncIntervalId) {
            window.clearInterval(this.syncIntervalId);
            this.syncIntervalId = null;
        }
        
        this.log('Plugin unloaded');
    }

    /**
     * Log a message to the console if debug mode is enabled
     */
    log(...args: any[]): void {
        if (this.settings.debugMode) {
            console.log('Limitless:', ...args);
        }
    }
    
    /**
     * Update the sync status in the settings tab
     * @param message The status message to display
     */
    updateSyncStatus(message: string): void {
        // Store the status for reference
        this.lastSyncStatus = message;
        
        // Get settings tab instance if it exists
        const settingsTabs = (this.app as any).setting?.settingTabs;
        const settingsTab = settingsTabs ? 
            settingsTabs.find((tab: any) => tab.id === 'limitless') : undefined;
        
        if (settingsTab && typeof settingsTab.updateStatusDisplay === 'function') {
            settingsTab.updateStatusDisplay('sync', message);
        }
        
        // Also log the status update if debug is enabled
        this.log('Sync Status:', message);
    }
    
    /**
     * Update the summarization status in the settings tab
     * @param message The status message to display
     */
    updateSummarizationStatus(message: string): void {
        // Store the status for reference
        this.lastSummarizationStatus = message;
        
        // Get settings tab instance if it exists
        const settingsTabs = (this.app as any).setting?.settingTabs;
        const settingsTab = settingsTabs ? 
            settingsTabs.find((tab: any) => tab.id === 'limitless') : undefined;
        
        if (settingsTab && typeof settingsTab.updateStatusDisplay === 'function') {
            settingsTab.updateStatusDisplay('summarization', message);
        }
        
        // Also log the status update if debug is enabled
        this.log('Summarization Status:', message);
    }
    


    /**
     * Add plugin commands
     */
    private addCommands(): void {
        // Command to sync lifelogs
        this.addCommand({
            id: 'sync-lifelogs',
            name: 'Sync Lifelogs',
            callback: async () => {
                await this.syncLifelogs();
            }
        });
        
        // Command to force sync lifelogs
        this.addCommand({
            id: 'force-sync-lifelogs',
            name: 'Force Sync All Lifelogs',
            callback: async () => {
                await this.syncLifelogs(true);
            }
        });
        
        // Command to cancel sync
        this.addCommand({
            id: 'cancel-sync',
            name: 'Cancel Ongoing Sync',
            callback: () => {
                this.cancelSyncOperation();
            }
        });
        
        // Command to summarize all notes
        this.addCommand({
            id: 'summarize-notes',
            name: 'Summarize Changed Notes',
            callback: async () => {
                if (this.settings.summarizationEnabled) {
                    await this.summarizationService.summarizeAllNotes(false);
                } else {
                    new Notice('Summarization is not enabled. Enable it in the settings.');
                }
            }
        });
        
        // Command to force summarize all notes
        this.addCommand({
            id: 'force-summarize-notes',
            name: 'Force Summarize All Notes',
            callback: async () => {
                if (this.settings.summarizationEnabled) {
                    await this.summarizationService.summarizeAllNotes(true);
                } else {
                    new Notice('Summarization is not enabled. Enable it in the settings.');
                }
            }
        });
    }



    /**
     * Register sync interval
     */
    registerSyncInterval(): void {
        // Clear existing interval
        if (this.syncIntervalId) {
            window.clearInterval(this.syncIntervalId);
            this.syncIntervalId = null;
        }
        
        // Set new interval if API key is set
        if (this.settings.apiKey) {
            const intervalMs = this.settings.syncIntervalMinutes * 60 * 1000;
            this.syncIntervalId = window.setInterval(() => {
                // Only start a sync if not already syncing
                if (!this.isSyncing) {
                    this.syncLifelogs().catch(error => this.log('Error during scheduled sync:', error));
                }
                
                // Summarize notes if enabled and not already summarizing
                if (this.settings.summarizationEnabled && this.settings.openaiApiKey && !this.isSummarizing) {
                    this.summarizationService.summarizeAllNotes(false)
                        .catch(error => this.log('Error during scheduled summarization:', error));
                }
            }, intervalMs);
            
            this.log(`Sync interval set to ${this.settings.syncIntervalMinutes} minutes`);
        }
    }

    /**
     * Load plugin settings
     */
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    /**
     * Save plugin settings
     */
    async saveSettings() {
        await this.saveData(this.settings);
    }

    /**
     * Cancel ongoing sync operation
     */
    cancelSyncOperation(): void {
        if (!this.isSyncing) {
            new Notice('No sync in progress');
            return;
        }
        
        this.log('Cancelling sync operation...');
        this.cancelSync = true;
        
        // Cancel any active API requests
        this.apiService.cancelAllRequests();
        
        new Notice('Sync operation is being cancelled. Please wait...');
    }
    
    /**
     * Test API connection
     */
    async testAPIConnection(): Promise<boolean> {
        if (!this.settings.apiKey) {
            new Notice('Please enter an API key first');
            return false;
        }
        
        this.log('Testing API connection...');
        new Notice('Testing connection to Limitless API...');
        
        try {
            // Simple request to check if the API key is valid
            await this.apiService.fetchLifelogsForDay(new Date().toISOString().split('T')[0]);
            
            new Notice('Connection successful! API key is valid.');
            return true;
        } catch (error) {
            console.error('Error testing connection:', error);
            if (error.message.includes('Authentication failed')) {
                new Notice('API key is invalid. Please check your API key.');
            } else {
                new Notice(`Error connecting to Limitless API: ${error.message}`);
            }
            return false;
        }
    }

    /**
     * Sync lifelogs from the API
     */
    async syncLifelogs(forceFull: boolean = false): Promise<void> {
        // If already syncing, return
        if (this.isSyncing) {
            new Notice('Sync already in progress');
            return;
        }
        
        // Check if API key is set
        if (!this.settings.apiKey) {
            new Notice('Please set your API key in the settings');
            return;
        }
        
        try {
            // Reset cancellation flag and set syncing state
            this.cancelSync = false;
            this.isSyncing = true;
            
            // Update status immediately with appropriate message
            if (forceFull) {
                this.updateSyncStatus('Force syncing from start date...');
            } else {
                this.updateSyncStatus('Syncing new data...');
            }
            
            if (forceFull) {
                // Perform full sync from start date
                await this.fetchAllLifelogsFromStartDate();
            } else {
                // Perform incremental sync
                await this.fetchAllLifelogsSinceLastSync();
            }
            
            // Check if sync was cancelled
            if (this.cancelSync) {
                this.log('Sync operation was cancelled by user');
                new Notice(`Sync cancelled.`);
                this.updateSyncStatus('Cancelled');
                return;
            }
            
            // Update last sync timestamp (unless this was a force sync with a start date or cancelled)
            if (!forceFull && !this.cancelSync) {
                this.settings.lastSyncTimestamp = new Date().toISOString();
                await this.saveSettings();
            }
            

            if (!this.cancelSync) {
                new Notice('Lifelogs sync complete');
                
                // Reset sync state and update UI
                this.isSyncing = false;
                this.updateSyncStatus('Idle');
                
                // Force UI refresh if needed
                const settingsTabs = (this.app as any).setting?.settingTabs;
                const settingsTab = settingsTabs ? 
                    settingsTabs.find((tab: any) => tab.id === 'limitless') : undefined;
                if (settingsTab && typeof settingsTab.updateStatusDisplay === 'function') {
                    // Force a UI refresh after a small delay
                    setTimeout(() => {
                        settingsTab.updateStatusDisplay('sync', 'Idle');
                    }, 50);
                }
            }
        } catch (error) {
            console.error('Error syncing lifelogs:', error);
            new Notice(`Error syncing lifelogs: ${error.message}`);
            this.updateSyncStatus(`Error: ${error.message}`);
            
        } finally {
                // Reset syncing state and cancel flag immediately
            this.isSyncing = false;
            this.cancelSync = false;
        }
    }

    /**
     * Fetch all lifelogs since the last successful sync
     */
    private async fetchAllLifelogsSinceLastSync(): Promise<void> {
        // Get timestamp to fetch from
        let timestamp: string;
        
        if (!this.settings.lastSyncTimestamp) {
            // If never synced, use start date
            timestamp = this.settings.startDate;
            this.log(`No previous sync found, fetching from start date: ${timestamp}`);
        } else {
            // Use last sync timestamp
            timestamp = this.settings.lastSyncTimestamp;
            this.log(`Fetching lifelogs since last sync: ${timestamp}`);
        }
        

        
        try {
            // Check for early cancellation
            if (this.cancelSync) {
                this.log('Sync operation was cancelled before fetching lifelogs');
                return;
            }
            
            // Get lifelogs from API
            const lifelogs = await this.apiService.fetchLifelogsSince(timestamp);
            
            // Check for cancellation after API call
            if (this.cancelSync) {
                this.log('Sync operation was cancelled after fetching lifelogs');
                return;
            }
            
            if (lifelogs.length === 0) {
                this.log('No new lifelogs found');

                return;
            }
            
            // Organize lifelogs by date
            const lifelogsByDate: Record<string, Lifelog[]> = {};
            
            lifelogs.forEach(lifelog => {
                // Extract date from timestamp (YYYY-MM-DD)
                const date = lifelog.timestamp.split('T')[0];
                
                // Add to the map
                if (!lifelogsByDate[date]) {
                    lifelogsByDate[date] = [];
                }
                lifelogsByDate[date].push(lifelog);
            });
            
            // Write lifelogs to notes
            const dates = Object.keys(lifelogsByDate);
            
            for (let i = 0; i < dates.length; i++) {
                // Check for cancellation before each file operation
                if (this.cancelSync) {
                    this.log(`Sync cancelled during processing after ${i} of ${dates.length} dates`);
                    return;
                }
                
                const date = dates[i];
                const logs = lifelogsByDate[date];
                


                
                await this.fileUtils.writeLifelogsToNote(date, logs);
            }
            
            this.log(`Processed ${lifelogs.length} lifelogs for ${dates.length} dates`);
        } catch (error) {
            this.log('Error fetching lifelogs since last sync:', error);
            new Notice(`Error fetching lifelogs: ${error.message || 'Unknown error'}`);
        }
    }

    /**
     * Fetch all lifelogs from the start date
     */
    private async fetchAllLifelogsFromStartDate(): Promise<void> {

        
        try {
            // Check for early cancellation
            if (this.cancelSync) {
                this.log('Sync operation was cancelled before starting full sync');
                return;
            }
            
            const now = new Date();
            let startDate = new Date(this.settings.startDate);
            
            // Calculate number of days to fetch
            const msPerDay = 24 * 60 * 60 * 1000;
            let numDays = Math.ceil((now.getTime() - startDate.getTime()) / msPerDay) + 1;
            
            if (numDays <= 0) {
                this.log(`Start date must be in the past! Using today.`);
                new Notice(`Start date must be in the past! Using today.`);
                startDate = new Date();
                numDays = 1;
            }
            
            this.log(`Fetching lifelogs for ${numDays} days from ${startDate.toISOString().split('T')[0]} to today`);

            
            // Process each day
            const allLifelogsByDate: Record<string, Lifelog[]> = {};
            
            for (let i = 0; i < numDays; i++) {
                // Check for cancellation before each API call
                if (this.cancelSync) {
                    this.log(`Sync cancelled during full sync after ${i} of ${numDays} days`);
                    return;
                }
                
                // Calculate date
                const date = new Date(startDate.getTime() + i * msPerDay);
                const dateStr = date.toISOString().split('T')[0];
                

                
                // Skip future dates
                if (date > now) {
                    continue;
                }
                
                try {
                    // Get lifelogs for this day
                    const lifelogs = await this.apiService.fetchLifelogsForDay(dateStr);
                    
                    if (lifelogs.length > 0) {
                        allLifelogsByDate[dateStr] = lifelogs;
                    }
                } catch (error) {
                    this.log(`Error fetching lifelogs for ${dateStr}:`, error);
                    // Continue with next day instead of stopping completely
                }
            }
            
            // Check for cancellation before file operations
            if (this.cancelSync) {
                this.log('Sync operation was cancelled after fetching all lifelogs');
                return;
            }
            
            // Write all lifelogs to notes
            const dates = Object.keys(allLifelogsByDate);
            
            for (let i = 0; i < dates.length; i++) {
                // Check for cancellation before each file operation
                if (this.cancelSync) {
                    this.log(`Sync cancelled during file writing after ${i} of ${dates.length} dates`);
                    return;
                }
                
                const date = dates[i];
                const logs = allLifelogsByDate[date];
                

                
                await this.fileUtils.writeLifelogsToNote(date, logs);
            }
            
            // Count total lifelogs
            const totalLifelogs = Object.values(allLifelogsByDate).reduce((total, logs) => total + logs.length, 0);
            this.log(`Full sync completed. Processed ${totalLifelogs} lifelogs for ${dates.length} dates`);
        } catch (error) {
            this.log('Error during full sync:', error);
            new Notice(`Error during full sync: ${error.message || 'Unknown error'}`);
        }
    }
}

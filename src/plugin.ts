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
    syncProgress: number = 0;
    syncCurrent: number = 0;
    syncTotal: number = 0;
    syncProgressText: string = '';
    
    // Summarization state
    isSummarizing: boolean = false;
    cancelSummarization: boolean = false;
    summarizationCurrent: number = 0;
    summarizationTotal: number = 0;
    summarizationProgressText: string = '';
    
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
        
        // Add status bar
        this.addStatusBar();
        
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
     * Add status bar item
     */
    private addStatusBar(): void {
        // Remove if it already exists
        const statusBarEl = this.addStatusBarItem();
        statusBarEl.setText('Limitless: Ready');
        
        // Update status bar text when syncing
        const updateStatusBar = () => {
            if (this.isSyncing) {
                statusBarEl.setText(`Limitless: ${this.syncProgressText}`);
            } else if (this.isSummarizing) {
                statusBarEl.setText(`Limitless: ${this.summarizationProgressText}`);
            } else {
                statusBarEl.setText('Limitless: Ready');
            }
            
            window.requestAnimationFrame(updateStatusBar);
        };
        
        window.requestAnimationFrame(updateStatusBar);
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
        this.syncProgressText = 'Cancelling sync...';
        
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
            this.syncProgress = 0;
            this.syncCurrent = 0;
            this.syncTotal = 0;
            this.syncProgressText = 'Preparing to sync...';
            
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
                this.syncProgressText = `Sync cancelled`;
                return;
            }
            
            // Update last sync timestamp (unless this was a force sync with a start date or cancelled)
            if (!forceFull && !this.cancelSync) {
                this.settings.lastSyncTimestamp = new Date().toISOString();
                await this.saveSettings();
            }
            
            // Update status
            this.syncProgress = 100;
            this.syncProgressText = 'Sync complete';
            if (!this.cancelSync) {
                new Notice('Lifelogs sync complete');
            }
        } catch (error) {
            console.error('Error syncing lifelogs:', error);
            this.syncProgressText = `Error: ${error.message}`;
            new Notice(`Error syncing lifelogs: ${error.message}`);
        } finally {
            // Reset syncing state and cancel flag after a delay
            setTimeout(() => {
                this.isSyncing = false;
                this.cancelSync = false;
                this.syncProgress = 0;
                this.syncCurrent = 0;
                this.syncTotal = 0;
                this.syncProgressText = '';
            }, 2000);
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
        
        this.syncProgressText = `Fetching lifelogs since ${timestamp}...`;
        
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
                this.syncProgressText = 'No new lifelogs found';
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
            this.syncTotal = dates.length;
            
            for (let i = 0; i < dates.length; i++) {
                // Check for cancellation before each file operation
                if (this.cancelSync) {
                    this.log(`Sync cancelled during processing after ${i} of ${dates.length} dates`);
                    return;
                }
                
                const date = dates[i];
                const logs = lifelogsByDate[date];
                
                this.syncCurrent = i + 1;
                this.syncProgressText = `Writing lifelogs for ${date}... (${i + 1}/${dates.length})`;
                this.syncProgress = Math.floor(((i + 1) / dates.length) * 100);
                
                await this.fileUtils.writeLifelogsToNote(date, logs);
            }
            
            this.log(`Processed ${lifelogs.length} lifelogs for ${dates.length} dates`);
        } catch (error) {
            this.log('Error fetching lifelogs since last sync:', error);
            throw error;
        }
    }

    /**
     * Fetch all lifelogs from the start date
     */
    private async fetchAllLifelogsFromStartDate(): Promise<void> {
        this.syncProgressText = `Starting full sync from ${this.settings.startDate}...`;
        
        try {
            // Check for early cancellation
            if (this.cancelSync) {
                this.log('Sync operation was cancelled before starting full sync');
                return;
            }
            
            const now = new Date();
            const startDate = new Date(this.settings.startDate);
            
            // Calculate number of days to fetch
            const msPerDay = 24 * 60 * 60 * 1000;
            const numDays = Math.ceil((now.getTime() - startDate.getTime()) / msPerDay) + 1;
            
            if (numDays <= 0) {
                throw new Error('Start date must be in the past');
            }
            
            this.log(`Fetching lifelogs for ${numDays} days from ${this.settings.startDate} to today`);
            this.syncTotal = numDays;
            
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
                
                this.syncCurrent = i + 1;
                this.syncProgressText = `Fetching lifelogs for ${dateStr}... (${i + 1}/${numDays})`;
                this.syncProgress = Math.floor((i / numDays) * 50); // First half of progress bar
                
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
                
                this.syncProgressText = `Writing lifelogs for ${date}... (${i + 1}/${dates.length})`;
                this.syncProgress = 50 + Math.floor(((i + 1) / dates.length) * 50); // Second half of progress bar
                
                await this.fileUtils.writeLifelogsToNote(date, logs);
            }
            
            // Count total lifelogs
            const totalLifelogs = Object.values(allLifelogsByDate).reduce((total, logs) => total + logs.length, 0);
            this.log(`Full sync completed. Processed ${totalLifelogs} lifelogs for ${dates.length} dates`);
        } catch (error) {
            this.log('Error during full sync:', error);
            throw error;
        }
    }
}

import { App, Notice, Plugin, PluginSettingTab, Setting, normalizePath, TFile, TFolder, requestUrl } from 'obsidian';
import { format } from 'date-fns';

// Interfaces for the Limitless API
interface ContentNode {
	startTime: string;
	endTime?: string;
	type: string;
	value: string;
}

interface Lifelog {
	id: string;
	title: string;
	markdown: string;
	contents: ContentNode[];
}

interface MetaLifelogs {
	nextCursor?: string;
	count: number;
}

interface Meta {
	lifelogs: MetaLifelogs;
}

interface LifelogsData {
	lifelogs: Lifelog[];
}

interface LifelogsResponse {
	data: LifelogsData;
	meta: Meta;
}

interface LimitlessPluginSettings {
	apiUrl: string;
	apiKey: string;
	outputFolder: string;
	syncIntervalMinutes: number;
	lastSyncTimestamp: string;
	debugMode: boolean;
	forceOverwrite: boolean;
	ascendingOrder: boolean; // If true, new entries go at the bottom; if false, new entries go at the top
	startDate: string; // When the user started using Limitless (YYYY-MM-DD)
	useSystemTimezone: boolean; // Whether to use the system timezone for API requests
}

const DEFAULT_SETTINGS: LimitlessPluginSettings = {
	apiUrl: 'https://api.limitless.ai/v1',
	apiKey: '',
	outputFolder: 'Limitless',
	syncIntervalMinutes: 60,
	lastSyncTimestamp: '',
	debugMode: false,
	forceOverwrite: false,
	ascendingOrder: false, // Default to descending order (new entries at the top)
	startDate: new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0], // Default to January 1st of current year
	useSystemTimezone: true // Default to using the system timezone
}

// We're extending the HTMLElement interface to add Obsidian-specific methods
declare global {
	interface HTMLElement {
		empty(): void;
		createEl(tag: string, attrs?: any): HTMLElement;
		setText(text: string): HTMLElement;
	}
}

export default class LimitlessPlugin extends Plugin {
	settings: LimitlessPluginSettings;
	syncIntervalId: number | null = null;
	isSyncing: boolean = false;
	cancelSync: boolean = false;
	
	// Progress tracking
	syncProgress: number = 0; // 0-100
	syncTotal: number = 0;
	syncCurrent: number = 0;
	syncProgressText: string = '';
	
	// Debug logger function that only logs when debug mode is enabled
	log(...args: any[]): void {
		if (this.settings?.debugMode) {
			console.log('[Limitless]', ...args);
		}
	}

	// This method isn't actually needed in Obsidian plugins
	// Obsidian automatically loads the styles.css file from the plugin directory
	loadStyles(): void {
		// In Obsidian plugins, the styles.css file is automatically loaded when the plugin is enabled
		// This method is just a placeholder to support our call in onload()
		this.log('Loading styles from styles.css');
	}

	async onload() {
		await this.loadSettings();

		// Load CSS styles
		this.loadStyles();

		// Create the ribbon icon for manual sync
		const ribbonIconEl = this.addRibbonIcon('sync', 'Limitless - Sync Lifelogs', async () => {
			await this.syncLifelogs();
			new Notice('Limitless Lifelogs synced!');
		});

		// Add status bar item
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Limitless: Ready');

		// Register commands
		this.addCommand({
			id: 'sync-limitless-lifelogs',
			name: 'Sync Lifelogs',
			callback: async () => {
				await this.syncLifelogs();
				new Notice('Limitless Lifelogs synced!');
			}
		});

		// Add settings tab
		this.addSettingTab(new LimitlessSettingTab(this.app, this));

		// Initialize the sync interval
		this.initializeSyncInterval();

		// Perform initial sync on load
		this.syncLifelogs();
	}

	onunload() {
		if (this.syncIntervalId) {
			window.clearInterval(this.syncIntervalId);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.log('Loaded settings:', this.settings);
	}

	async saveSettings() {
		this.log('Saving settings:', JSON.stringify(this.settings));
		await this.saveData(this.settings);
	}

	initializeSyncInterval() {
		// Clear existing interval if it exists
		if (this.syncIntervalId) {
			window.clearInterval(this.syncIntervalId);
		}

		// Set up new interval
		const intervalMs = this.settings.syncIntervalMinutes * 60 * 1000;
		this.syncIntervalId = window.setInterval(async () => {
			await this.syncLifelogs();
		}, intervalMs);
	}

	async ensureOutputFolder(): Promise<TFolder> {
		const folderPath = normalizePath(this.settings.outputFolder);
		this.log('Ensuring output folder exists:', folderPath);
		
		let folder = this.app.vault.getAbstractFileByPath(folderPath);
		this.log('Folder exists?', !!folder);
		
		if (!folder) {
			// Only create the folder if it doesn't exist
			this.log('Creating folder:', folderPath);
			try {
				folder = await this.app.vault.createFolder(folderPath);
				this.log('Folder created successfully');
			} catch (folderError) {
				// Check if the error is because the folder already exists
				this.log('Error creating folder:', folderError);
				
				// Try to get the folder again in case it was created by another process
				folder = this.app.vault.getAbstractFileByPath(folderPath);
				if (!folder) {
					// If it still doesn't exist, rethrow the error
					throw folderError;
				}
			}
		} else if (!(folder instanceof TFolder)) {
			console.error(`${folderPath} exists but is not a folder`);
			throw new Error(`${folderPath} exists but is not a folder`);
		}
		
		// Return the folder - we know it's a TFolder because of the instanceof check above
		return folder;
	}

	async getDailyNotePath(date: Date): Promise<string> {
		const folder = await this.ensureOutputFolder();
		const fileName = `${format(date, 'yyyy-MM-dd')}.md`;
		const filePath = normalizePath(`${folder.path}/${fileName}`);
		this.log('Daily note path:', filePath);
		return filePath;
	}

	async getDailyNote(date: Date): Promise<TFile | null> {
		const filePath = await this.getDailyNotePath(date);
		const file = this.app.vault.getAbstractFileByPath(filePath);
		this.log('Daily note exists?', !!file);
		return file instanceof TFile ? file : null;
	}

	async createOrAppendToDailyNote(date: Date, content: string, forceOverwrite: boolean = false): Promise<void> {
		// First ensure the output folder exists
		await this.ensureOutputFolder();
		
		// Now get the file path and check if the file exists
		const filePath = await this.getDailyNotePath(date);
		const file = await this.getDailyNote(date);
		
		// Always overwrite the file as requested
		if (file) {
			this.log('Overwriting existing file:', filePath);
			await this.app.vault.modify(file, content);
			this.log('File overwritten successfully');
		} else {
			this.log('Creating new file:', filePath);
			// Create new file
			const initialContent = content;
			this.log('Initial content length:', initialContent.length);
			try {
				// Create the file
				const newFile = await this.app.vault.create(filePath, initialContent);
				this.log('File created successfully:', newFile.path);
			} catch (createError) {
				console.error('Error creating file:', createError);
				throw createError;
			}
		}
	}

	async fetchLifelogs(since: string | null = null, date: string | null = null, cursor: string | null = null, retryCount: number = 0): Promise<LifelogsResponse> {
		// Maximum number of retries for server errors
		const MAX_RETRIES = 5; // Increased from 3 to 5 for better handling of timeouts
		// Base delay for exponential backoff (in milliseconds)
		const BASE_DELAY = 2000; // Increased from 1000 to 2000 for more spacing between retries
		
		// Create a request ID for tracking
		const requestId = Math.random().toString(36).substring(2, 15);
		
		// Create an AbortController for this request (not used directly with requestUrl but for tracking)
		const controller = new AbortController();
		controller['requestId'] = requestId;
		
		// Add to active requests list
		this.activeFetchRequests.push(controller);
		
		try {
			// Check if sync has been cancelled
			if (this.cancelSync) {
				throw new Error('Sync cancelled by user');
			}
			
			// Start building the URL with required parameters
			let url = `${this.settings.apiUrl}/lifelogs?includeMarkdown=true&sort=desc`;

			// Add limit parameter (API has a max of 10 per request)
			url += '&limit=10';
			
			// Add timezone parameter if enabled
			if (this.settings.useSystemTimezone) {
				const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
				url += `&timezone=${encodeURIComponent(timezone)}`;
				this.log('Using timezone for API request:', timezone);
			}
			
			// Add date parameter if provided (for day-by-day sync)
			if (date) {
				url += `&date=${encodeURIComponent(date)}`;
				this.log('Fetching lifelogs for specific date:', date);
			}
			// Otherwise, if we have a last sync timestamp, only fetch newer entries
			else if (since) {
				url += `&start=${encodeURIComponent(since)}`;
				this.log('Fetching lifelogs since:', since);
			}
			
			// Add cursor for pagination if provided
			if (cursor) {
				url += `&cursor=${encodeURIComponent(cursor)}`;
				this.log('Using pagination cursor:', cursor);
			}
			
			this.log('Fetching lifelogs from URL:', url, retryCount > 0 ? `(Retry ${retryCount}/${MAX_RETRIES})` : '');

			// Check again if sync has been cancelled before making the request
			if (this.cancelSync) {
				throw new Error('Sync cancelled by user');
			}
			
			// Use Obsidian's requestUrl which handles CORS properly
			const response = await requestUrl({
				url: url,
				method: 'GET',
				headers: {
					'X-API-Key': `${this.settings.apiKey}`,
					'Content-Type': 'application/json'
				}
			});
			
			// Check if sync was cancelled during the request
			if (this.cancelSync) {
				throw new Error('Sync cancelled during request');
			}
			
			// Remove from active requests list
			const index = this.activeFetchRequests.indexOf(controller);
			if (index > -1) {
				this.activeFetchRequests.splice(index, 1);
			}
			
			this.log('Response status:', response.status);
			const responseData = response.json as LifelogsResponse;
			
			// Log pagination information
			if (responseData.meta?.lifelogs?.nextCursor) {
				this.log('Next cursor available:', responseData.meta.lifelogs.nextCursor);
				this.log('Fetched', responseData.meta.lifelogs.count, 'lifelogs');
			} else {
				this.log('No more pages available');
			}

			return responseData;
		} catch (error) {
			// Remove from active requests list
			const index = this.activeFetchRequests.indexOf(controller);
			if (index > -1) {
				this.activeFetchRequests.splice(index, 1);
			}
			
			// Check if this is a cancellation
			if (error.message === 'Sync cancelled by user' || error.message === 'Sync cancelled during request') {
				this.log('Request was cancelled');
				throw new Error('Sync cancelled');
			}
			
			console.error('Error fetching lifelogs:', error);
			
			// Check for 401 Unauthorized error
			if (error.status === 401) {
				throw new Error('Authentication failed. Please check your API key in the Limitless settings.');
			}
			
			// If sync has been cancelled, don't retry
			if (this.cancelSync) {
				throw new Error('Sync cancelled');
			}
			
			// Handle 5xx server errors with retries - specifically handle 504 Gateway Timeout
			if (error.status >= 500 && error.status < 600) {
				if (retryCount < MAX_RETRIES) {
					// For 504 Gateway Timeout, use a longer delay
					const isTimeout = error.status === 504;
					const baseDelayForError = isTimeout ? BASE_DELAY * 2 : BASE_DELAY;
					const delay = baseDelayForError * Math.pow(2, retryCount) + Math.random() * 1000;
					
					this.log(`Server error (${error.status}${isTimeout ? ' Gateway Timeout' : ''}). Retrying in ${Math.round(delay/1000)}s...`);
					this.syncProgressText = `Server error (${error.status}). Retrying in ${Math.round(delay/1000)}s...`;
					
					await new Promise(resolve => setTimeout(resolve, delay));
					return this.fetchLifelogs(since, date, cursor, retryCount + 1);
				} else {
					this.log(`Maximum retries (${MAX_RETRIES}) reached for server error.`);
					throw new Error(`Server error after ${MAX_RETRIES} retries: ${error.status} ${error.message}`);
				}
			}
			
			// Handle 429 Too Many Requests with exponential backoff
			if (error.status === 429) {
				// Get retry-after header if available, otherwise use exponential backoff
				let retryAfter = error.headers?.['retry-after'] ? parseInt(error.headers['retry-after']) * 1000 : BASE_DELAY * Math.pow(2, retryCount);
				
				// Cap the maximum delay at 60 seconds
				retryAfter = Math.min(retryAfter, 60000);
				
				this.log(`Rate limited (429). Waiting for ${retryAfter}ms before retrying...`);
				this.syncProgressText = `Rate limited. Waiting ${Math.round(retryAfter/1000)}s before retrying...`;
				
				await new Promise(resolve => setTimeout(resolve, retryAfter));
				return this.fetchLifelogs(since, date, cursor, retryCount + 1);
			}
			
			// For other errors, just throw
			throw error;
		}
	}

	// Helper method to extract timestamp from a lifelog
	getLifelogTimestamp(lifelog: Lifelog): string {
		// Filter content blocks that have startTime and sort them
		let startTime: string;
		
		if (lifelog.contents && lifelog.contents.length > 0) {
			// Filter out content blocks without startTime
			const contentWithTime = lifelog.contents.filter(content => !!content.startTime);
			this.log('Content blocks with time:', contentWithTime.length);
			
			if (contentWithTime.length > 0) {
				// Sort content blocks by startTime (oldest first)
				contentWithTime.sort((a, b) => {
					return new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
				});
				
				// Use the earliest startTime for the daily note
				startTime = contentWithTime[0].startTime;
				this.log('Using earliest content startTime:', startTime);
			} else {
				// If no content blocks have startTime, use current time
				startTime = new Date().toISOString();
				this.log('No content blocks with startTime, using current time:', startTime);
			}
		} else {
			// If no content blocks at all, use current time
			startTime = new Date().toISOString();
			this.log('No content blocks found, using current time:', startTime);
		}
		
		return startTime;
	}

	// Fetch all lifelogs for a specific day with pagination
	async fetchAllLifelogsForDay(date: string, forceOverwrite: boolean): Promise<Lifelog[]> {
		// Check if already cancelled before starting
		if (this.cancelSync) {
			this.log(`Skipping day ${date} due to cancellation`);
			return [];
		}
		
		const allLifelogs: Lifelog[] = [];
		let cursor: string | null = null;
		let hasMore = true;
		let pageCount = 0;
		
		this.log(`Fetching all lifelogs for day: ${date}`);
		// Don't update progress text here as we only want to track days
		
		// First, collect all lifelogs for the day
		while (hasMore && !this.cancelSync) {
			pageCount++;
			this.log(`Fetching page ${pageCount} for date ${date}`);
			
			// Fetch a page of lifelogs
			const response = await this.fetchLifelogs(null, date, cursor);
			
			// Check if sync was cancelled during API call
			if (this.cancelSync) {
				this.log(`Sync cancelled during API call for date ${date}`);
				break;
			}
			
			// Process the lifelogs in this page
			const lifelogs = response.data.lifelogs;
			this.log(`Received ${lifelogs.length} lifelogs for date ${date}`);
			
			if (lifelogs.length > 0) {
				// Add all lifelogs to our collection
				for (const lifelog of lifelogs) {
					if (lifelog.markdown) {
						allLifelogs.push(lifelog);
					} else {
						this.log('Skipping lifelog with no markdown content');
					}
				}
				
				// Update progress for fetched lifelogs
				this.syncProgressText = `Fetched ${allLifelogs.length} lifelogs for date ${date} (page ${pageCount})`;
			}
			
			// Check if sync was cancelled during processing
			if (this.cancelSync) {
				break;
			}
			
			// Check if there are more pages
			cursor = response.meta?.lifelogs?.nextCursor || null;
			hasMore = !!cursor;
			
			if (hasMore && !this.cancelSync) {
				this.log(`More pages available for date ${date}, next cursor: ${cursor}`);
			} else {
				this.log(`No more pages for date ${date}`);
			}
		}
		
		// Only process and write to file after all lifelogs have been fetched
		if (allLifelogs.length > 0 && !this.cancelSync) {
			this.log(`Processing ${allLifelogs.length} lifelogs for date ${date}`);
			
			// Get the date for the daily note from any lifelog
			const firstLifelog = allLifelogs[0];
			const timestamp = this.getLifelogTimestamp(firstLifelog);
			const lifelogDate = new Date(timestamp);
			
			// Sort all lifelogs by timestamp
			let sortedLifelogs: Lifelog[];
			
			if (this.settings.ascendingOrder) {
				// Ascending order: oldest first (chronological)
				this.log('Using ascending order: sorting lifelogs oldest first');
				sortedLifelogs = [...allLifelogs].sort((a, b) => {
					const aTime = this.getLifelogTimestamp(a);
					const bTime = this.getLifelogTimestamp(b);
					if (!aTime || !bTime) return 0;
					return new Date(aTime).getTime() - new Date(bTime).getTime();
				});
			} else {
				// Descending order: newest first (reverse chronological)
				this.log('Using descending order: sorting lifelogs newest first');
				sortedLifelogs = [...allLifelogs].sort((a, b) => {
					const aTime = this.getLifelogTimestamp(a);
					const bTime = this.getLifelogTimestamp(b);
					if (!aTime || !bTime) return 0;
					return new Date(bTime).getTime() - new Date(aTime).getTime();
				});
			}
			
			// Prepare the content for the daily note
			let dailyNoteContent = '';
			let processedCount = 0;
			
			// Process each lifelog to build the content
			for (const lifelog of sortedLifelogs) {
				// Check if sync was cancelled
				if (this.cancelSync) {
					this.log(`Sync cancelled during lifelog processing for date ${date}`);
					break;
				}
				
				// Add the markdown content
				dailyNoteContent += lifelog.markdown + '\n\n';
				
				// Update progress for individual lifelogs
				processedCount++;
				if (processedCount % 5 === 0 || processedCount === sortedLifelogs.length) {
					this.syncProgressText = `Processed ${processedCount}/${sortedLifelogs.length} lifelogs for date ${date}`;
				}
			}
			
			// Check if sync was cancelled before writing
			if (!this.cancelSync) {
				// Write all content to the daily note at once
				try {
					await this.createOrAppendToDailyNote(lifelogDate, dailyNoteContent, forceOverwrite);
					this.log(`Successfully wrote ${sortedLifelogs.length} lifelogs to daily note for date: ${date}`);
				} catch (noteError) {
					console.error('Error creating/updating daily note:', noteError);
				}
			}
		}
		
		this.log(`Total lifelogs fetched for date ${date}: ${allLifelogs.length}`);
		return allLifelogs;
	}
	


	// Array to track active fetch requests
	private activeFetchRequests: AbortController[] = [];

	async cancelOngoingSync(): Promise<void> {
		if (this.isSyncing) {
			this.log('Cancelling ongoing sync operation');
			
			// Set the cancel flag to true - this is the main signal for all processes to stop
			this.cancelSync = true;
			
			// We can't directly abort Obsidian's requestUrl calls, but we can set the cancelSync flag
			// which will prevent further processing
			this.log(`Setting cancel flag for ${this.activeFetchRequests.length} active requests`);
			
			// Clear the array since we can't actually abort the requests
			// but we can prevent further processing by setting cancelSync = true
			this.activeFetchRequests = [];
			
			// Reset sync state immediately
			this.isSyncing = false;
			this.syncProgressText = 'Sync cancelled';
			
			// Force a UI refresh to show cancellation
			this.syncProgress = 0;
			
			new Notice('Limitless sync cancelled.');
			
			// Add a small delay to ensure the cancellation flag propagates
			await new Promise(resolve => setTimeout(resolve, 100));
		} else {
			new Notice('No sync operation is currently running.');
		}
	}

	async syncLifelogs(forceSync: boolean = false, customStartDate?: string): Promise<void> {
		// Check if API key is configured
		if (!this.settings.apiKey) {
			new Notice('Limitless API key not configured. Please update plugin settings.');
			return;
		}
		
		// Check if sync is already in progress
		if (this.isSyncing) {
			new Notice('A sync operation is already in progress. Please wait for it to complete or cancel it.');
			return;
		}
		
		// Set sync flags
		this.isSyncing = true;
		this.cancelSync = false;
		
		// Reset progress tracking
		this.syncProgress = 0;
		this.syncTotal = 0;
		this.syncCurrent = 0;
		this.syncProgressText = 'Preparing sync...';
		
		// Store the force overwrite setting for this sync operation
		const forceOverwrite = forceSync || this.settings.forceOverwrite;

		try {
			this.log('Starting sync operation. Force sync:', forceSync);
			
			// Initialize counters for tracking processed lifelogs
			let totalProcessedLifelogs = 0;
			let latestTimestamp = this.settings.lastSyncTimestamp || '';
			
			// If force sync, do a day-by-day sync from the start date to today
			if (forceSync) {
				this.log('Force sync enabled, syncing day-by-day from start date');
				
				// Parse the start date - use custom start date if provided, otherwise use the configured start date
				const startDateStr = customStartDate || this.settings.startDate;
				this.log(`Using start date: ${startDateStr}`);
				const startDate = new Date(startDateStr);
				const today = new Date();
				today.setHours(23, 59, 59, 999); // End of today
				
				this.log('Syncing from', startDate.toISOString(), 'to', today.toISOString());
				
				// Calculate total days for progress tracking
				const totalDays = Math.floor((today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
				this.syncTotal = totalDays;
				this.syncCurrent = 0;
				this.syncProgressText = `Preparing to sync ${totalDays} days`;
				
				// Generate array of all dates to sync
				const allDates: string[] = [];
				const currentDate = new Date(startDate);
				while (currentDate <= today) {
					const dateString = currentDate.toISOString().split('T')[0]; // YYYY-MM-DD format
					allDates.push(dateString);
					currentDate.setDate(currentDate.getDate() + 1);
				}
				
				this.log(`Prepared ${allDates.length} days to sync using parallel processing`);
				this.syncProgressText = `Preparing to sync ${allDates.length} days`;
				
				// Reduce concurrent operations to avoid overwhelming the API
				const MAX_CONCURRENT = 5; // Reduced from 10 to 5
				let activeTasks = 0;
				let completedDays = 0;
				let dateIndex = 0;
				
				// Map to store results by date
				const resultsByDate = new Map<string, Lifelog[]>();
				
				// Create a promise that resolves when all days are processed
				await new Promise<void>((resolve, reject) => {
					// Function to process the next date in the queue
					const processNextDate = async () => {
						// Check if we should stop processing - immediate return if cancelled
						if (this.cancelSync) {
							this.log('Cancellation detected in processNextDate - stopping queue');
							return resolve();
						}
						
						// Check if we've processed all dates
						if (dateIndex >= allDates.length) {
							// If no active tasks, we're done
							if (activeTasks === 0) {
								resolve();
							}
							return;
						}
						
						// Check for cancellation again before getting next date
						if (this.cancelSync) {
							this.log('Cancellation detected before processing next date');
							return resolve();
						}
						
						// Get the next date to process
						const dateString = allDates[dateIndex++];
						activeTasks++;
						
						try {
							// Check for cancellation before starting day processing
							if (this.cancelSync) {
								this.log(`Skipping day ${dateString} due to cancellation`);
								activeTasks--;
								// Don't process next date, just return
								return resolve();
							}
							
							this.log(`Starting sync for day: ${dateString} (${activeTasks} active tasks)`);
							
							// Process all lifelogs for this day (with pagination)
							const dayLifelogs = await this.fetchAllLifelogsForDay(dateString, forceOverwrite);
							
							// Check for cancellation after day processing
							if (this.cancelSync) {
								this.log(`Day ${dateString} completed but sync was cancelled - stopping further processing`);
								activeTasks--;
								return resolve();
							}
							
							// Store the results
							resultsByDate.set(dateString, dayLifelogs);
							
							// Update progress - only tracking days synced/total days
							completedDays++;
							this.syncCurrent = completedDays;
							this.syncProgress = Math.floor((completedDays / totalDays) * 100);
							this.syncProgressText = `Synced ${completedDays}/${totalDays} days`;
							this.log(`Completed day ${dateString} with ${dayLifelogs.length} lifelogs`);
							
							// Show progress notification every 10 days
							if (completedDays % 10 === 0 || completedDays === totalDays) {
								new Notice(`Force sync progress: ${completedDays}/${totalDays} days`);
							}
						} catch (error) {
							this.log(`Error syncing day ${dateString}:`, error);
							// Store empty result for this date
							resultsByDate.set(dateString, []);
						} finally {
							activeTasks--;
							
							// Check for cancellation before scheduling next date
							if (this.cancelSync) {
								this.log('Cancellation detected in finally block - not scheduling more tasks');
								// If all tasks are done, resolve the promise
								if (activeTasks === 0) {
									resolve();
								}
								return;
							}
							
							// Process next date with a small delay to avoid overwhelming the API
							setTimeout(processNextDate, 200); // Add 200ms delay between requests
						}
					};
					
					// Check if cancelled before starting any tasks
					if (this.cancelSync) {
						this.log('Sync already cancelled before starting tasks');
						return resolve();
					}
					
					// Start initial batch of tasks with a small delay between each
					for (let i = 0; i < MAX_CONCURRENT && i < allDates.length; i++) {
						// Use setTimeout with a staggered delay to prevent overwhelming the API
						setTimeout(processNextDate, i * 500); // Add 500ms delay between each initial task
					}
				});
				
				// Process all results to count total lifelogs and find latest timestamp
				for (const [dateString, lifelogs] of resultsByDate.entries()) {
					totalProcessedLifelogs += lifelogs.length;
					
					// Update latest timestamp if needed
					for (const lifelog of lifelogs) {
						const timestamp = this.getLifelogTimestamp(lifelog);
						if (timestamp && (!latestTimestamp || new Date(timestamp) > new Date(latestTimestamp))) {
							latestTimestamp = timestamp;
						}
					}
				}
				
				// Check if sync was cancelled
				if (this.cancelSync) {
					this.log('Sync operation was cancelled by user');
					new Notice(`Sync cancelled. Processed ${totalProcessedLifelogs} lifelogs before cancellation.`);
					this.syncProgressText = `Sync cancelled after processing ${totalProcessedLifelogs} lifelogs`;
					this.isSyncing = false;
					this.cancelSync = false;
					// Clear any remaining active requests
					this.activeFetchRequests = [];
					return;
				}
			} else {
				// Regular incremental sync using the last sync timestamp
				this.log('Regular sync, using last sync timestamp:', this.settings.lastSyncTimestamp || 'None');
				this.syncProgressText = 'Starting incremental sync...';
				
				// Check if sync was cancelled before starting
				if (this.cancelSync) {
					this.log('Sync operation was cancelled by user before starting incremental sync');
					new Notice('Sync cancelled.');
					this.syncProgressText = 'Sync cancelled before starting';
					this.isSyncing = false;
					this.cancelSync = false;
					// Clear any remaining active requests
					this.activeFetchRequests = [];
					return;
				}
				
				// For incremental sync, we need to determine the date range to sync
				this.syncProgressText = 'Determining date range for incremental sync...';
				
				// If we have a last sync timestamp, use it to determine the start date
				let startDate: Date;
				if (this.settings.lastSyncTimestamp) {
					// Use the last sync timestamp as the start date
					startDate = new Date(this.settings.lastSyncTimestamp);
					// Subtract one day to ensure we don't miss any lifelogs
					startDate.setDate(startDate.getDate());
				} else {
					// If no last sync timestamp, use the Limitless Start Date from settings
					startDate = new Date(this.settings.startDate);
					this.log(`No last sync timestamp, using Limitless Start Date: ${this.settings.startDate}`);
				}
				
				// End date is today
				const endDate = new Date();
				
				// Generate all dates in the range
				const allDates: string[] = [];
				const currentDate = new Date(startDate);
				while (currentDate <= endDate) {
					allDates.push(currentDate.toISOString().split('T')[0]); // YYYY-MM-DD format
					currentDate.setDate(currentDate.getDate() + 1);
				}
				
				this.log(`Incremental sync will process ${allDates.length} days from ${allDates[0]} to ${allDates[allDates.length - 1]}`);
				
				// Now process each date using the same approach as force sync
				const resultsByDate = new Map<string, Lifelog[]>();
				let completedDays = 0;
				const totalDays = allDates.length;
				
				// Set up progress tracking
				this.syncTotal = totalDays;
				this.syncCurrent = 0;
				this.syncProgress = 0;
				this.syncProgressText = `Starting incremental sync for ${totalDays} days`;
				
				// Process each date sequentially
				for (const dateString of allDates) {
					// Check for cancellation
					if (this.cancelSync) {
						this.log(`Skipping day ${dateString} due to cancellation`);
						break;
					}
					
					this.log(`Starting sync for day: ${dateString}`);
					
					// Process all lifelogs for this day
					try {
						const dayLifelogs = await this.fetchAllLifelogsForDay(dateString, forceOverwrite);
						
						// Check for cancellation after day processing
						if (this.cancelSync) {
							this.log(`Day ${dateString} completed but sync was cancelled - stopping further processing`);
							break;
						}
						
						// Store the results
						resultsByDate.set(dateString, dayLifelogs);
						
						// Update progress
						completedDays++;
						this.syncCurrent = completedDays;
						this.syncProgress = Math.floor((completedDays / totalDays) * 100);
						this.syncProgressText = `Synced ${completedDays}/${totalDays} days`;
						this.log(`Completed day ${dateString} with ${dayLifelogs.length} lifelogs`);
					} catch (error) {
						this.log(`Error syncing day ${dateString}:`, error);
						// Store empty result for this date
						resultsByDate.set(dateString, []);
					}
				}
				
				// Process all results to count total lifelogs and find latest timestamp
				for (const [dateString, lifelogs] of resultsByDate.entries()) {
					totalProcessedLifelogs += lifelogs.length;
					
					// Update latest timestamp if needed
					for (const lifelog of lifelogs) {
						const timestamp = this.getLifelogTimestamp(lifelog);
						if (timestamp && (!latestTimestamp || new Date(timestamp) > new Date(latestTimestamp))) {
							latestTimestamp = timestamp;
						}
					}
				}
				
				// Set progress to 100% for incremental sync completion
				this.syncProgress = 100;
				this.syncProgressText = `Incremental sync complete`;
				
				// Check if sync was cancelled during processing
				if (this.cancelSync) {
					this.log('Sync operation was cancelled by user during incremental sync');
					new Notice(`Sync cancelled. Processed ${totalProcessedLifelogs} lifelogs before cancellation.`);
					this.syncProgressText = `Sync cancelled`;
					this.isSyncing = false;
					this.cancelSync = false;
					return;
				}
			}
			
			// If no lifelogs were processed, we're done
			if (totalProcessedLifelogs === 0) {
				this.log('No new lifelogs found');
				new Notice('No new lifelogs found');
				this.syncProgressText = 'Sync complete';
				this.syncProgress = 100;
				this.isSyncing = false;
				return;
			}
			
			// Update the last sync timestamp only for regular syncs, not force syncs
			if (!forceSync) {
				this.settings.lastSyncTimestamp = latestTimestamp;
				await this.saveSettings();
				this.log('Updated last sync timestamp:', latestTimestamp);
			} else {
				this.log('Force sync completed without updating last sync timestamp');
			}
			
			// Show success message
			if (forceSync) {
				new Notice(`Force sync completed! ${totalProcessedLifelogs} entries processed with overwrite.`);
				this.syncProgressText = `Force sync completed`;
			} else {
				new Notice(`Limitless Lifelogs synced! ${totalProcessedLifelogs} entries processed.`);
				this.syncProgressText = `Sync completed`;
			}
			
			// Set final progress
			this.syncProgress = 100;
			
			// Reset sync flag
			this.isSyncing = false;
			
		} catch (error) {
			console.error('Error syncing lifelogs:', error);
			
			// Update progress on error
			this.syncProgressText = `Error: ${error.message}`;
			
			// Reset sync flag on error
			this.isSyncing = false;
			
			// Display a user-friendly error message
			if (error.message.includes('Authentication failed')) {
				new Notice('Authentication failed. Please check your API key in the Limitless settings.', 10000);
			} else if (error.message.includes('NetworkError') || error.message.includes('Failed to fetch')) {
				new Notice('Network error. Please check your internet connection and API URL in the Limitless settings.', 10000);
			} else {
				new Notice(`Error syncing Limitless Lifelogs: ${error.message}`, 5000);
			}
		}
	}
}

class LimitlessSettingTab extends PluginSettingTab {
	plugin: LimitlessPlugin;
	// containerEl is already defined in the PluginSettingTab class
	private cleanupFns: Array<() => void> = [];
	private statusTextEl: HTMLElement | null = null;
	private progressBarEl: HTMLElement | null = null;
	private progressTextEl: HTMLElement | null = null;

	constructor(app: App, plugin: LimitlessPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	
	// Register a function to be called when the settings tab is hidden
	register(fn: () => void): void {
		this.cleanupFns.push(fn);
	}
	
	// Clean up when the settings tab is hidden
	onhide(): void {
		this.cleanupFns.forEach(fn => fn());
		this.cleanupFns = [];
	}
	
	// Update progress bar with current sync status
	updateProgressBar(): void {
		if (!this.statusTextEl || !this.progressBarEl || !this.progressTextEl) return;
		
		// Update status text
		this.statusTextEl.textContent = this.plugin.isSyncing ? 
			`Status: Syncing - ${this.plugin.syncProgressText}` : 
			`Status: ${this.plugin.syncProgressText || 'Ready'}`;

		// Update progress bar
		if (this.plugin.isSyncing) {
			// Only update the width dynamically
			this.progressBarEl.style.width = `${this.plugin.syncProgress}%`;
			this.progressTextEl.textContent = `${this.plugin.syncProgress}%`;
			
			// Use class to update text color based on progress
			if (this.plugin.syncProgress > 50) {
				this.progressTextEl.classList.add('progress-text-on-accent');
				this.progressTextEl.classList.remove('progress-text-normal');
			} else {
				this.progressTextEl.classList.add('progress-text-normal');
				this.progressTextEl.classList.remove('progress-text-on-accent');
			}
		} else {
			// Always show the progress bar, but at 100% when not syncing
			this.progressBarEl.style.width = '100%';
			if (this.plugin.syncProgressText) {
				this.progressTextEl.textContent = this.plugin.syncProgressText;
			} else {
				this.progressTextEl.textContent = 'Ready';
			}
			this.progressTextEl.classList.add('progress-text-normal');
			this.progressTextEl.classList.remove('progress-text-on-accent');
		}
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();
		containerEl.createEl('h1', {text: 'Limitless Settings'});
		containerEl.createEl('p', {text: 'Configure your Limitless plugin settings below.'});

		// ==========================================
		// Section 1: API Configuration
		// ==========================================
		containerEl.createEl('h3', {text: 'API Configuration'});

		new Setting(containerEl)
			.setName('API URL')
			.setDesc('URL of the Limitless API')
			.addText((text: any) => text
				.setPlaceholder('Enter API URL')
				.setValue(this.plugin.settings.apiUrl)
				.onChange(async (value: string) => {
					this.plugin.settings.apiUrl = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('API Key')
			.setDesc('Your Limitless API Key')
			.addText((text: any) => text
				.setPlaceholder('Enter API Key')
				.setValue(this.plugin.settings.apiKey)
				.onChange(async (value: string) => {
					this.plugin.settings.apiKey = value;
					await this.plugin.saveSettings();
				}));
		
		// Add timezone setting
		const timezoneSetting = new Setting(containerEl)
			.setName('Use System Timezone')
			.setDesc('Send your system timezone to the Limitless API to ensure data is returned in your local time');
		
		// @ts-ignore - The Obsidian API has this method but TypeScript doesn't know about it
		timezoneSetting.addToggle((toggle: any) => toggle
			.setValue(this.plugin.settings.useSystemTimezone)
			.onChange(async (value: boolean) => {
				this.plugin.settings.useSystemTimezone = value;
				await this.plugin.saveSettings();
				const timezone = value ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
				new Notice(`Timezone setting ${value ? 'enabled' : 'disabled'}. Using ${timezone}.`);
			}));

		// ==========================================
		// Section 2: Output Settings
		// ==========================================
		containerEl.createEl('h3', {text: 'Output Settings'});
		
		new Setting(containerEl)
			.setName('Output Folder')
			.setDesc('Folder where daily notes will be created')
			.addText((text: any) => text
				.setPlaceholder('Enter folder path')
				.setValue(this.plugin.settings.outputFolder)
				.onChange(async (value: string) => {
					this.plugin.settings.outputFolder = value;
					await this.plugin.saveSettings();
				}));
		
		// Add entry order toggle
		const orderSetting = new Setting(containerEl)
			.setName('Entry Order')
			.setDesc('Choose how new entries are added to daily notes');
		
		// @ts-ignore - The Obsidian API has this method but TypeScript doesn't know about it
		orderSetting.addDropdown((dropdown: any) => dropdown
			.addOption('descending', 'Descending (new entries at top)')
			.addOption('ascending', 'Ascending (new entries at bottom)')
			.setValue(this.plugin.settings.ascendingOrder ? 'ascending' : 'descending')
			.onChange(async (value: string) => {
				this.plugin.settings.ascendingOrder = (value === 'ascending');
				await this.plugin.saveSettings();
				new Notice(`Entry order set to ${value}`);
			}));
		
		// ==========================================
		// Section 3: Sync Settings
		// ==========================================
		containerEl.createEl('h3', {text: 'Sync Settings'});
		
		new Setting(containerEl)
			.setName('Sync Interval (minutes)')
			.setDesc('How often to sync with Limitless API')
			.addSlider((slider: any) => slider
				.setLimits(10, 120, 5)
				.setValue(this.plugin.settings.syncIntervalMinutes)
				.setDynamicTooltip()
				.onChange(async (value: number) => {
					this.plugin.settings.syncIntervalMinutes = value;
					await this.plugin.saveSettings();
					this.plugin.initializeSyncInterval();
				}));
		
		// Add start date setting
		new Setting(containerEl)
			.setName('Limitless Start Date')
			.setDesc('When you started using Limitless (used for full syncs)')
			.addText((text: any) => {
				text.inputEl.type = 'date';
				text.setValue(this.plugin.settings.startDate)
					.onChange(async (value: string) => {
						// Validate date format
						if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
							this.plugin.settings.startDate = value;
							await this.plugin.saveSettings();
						}
					});
			});

		// Add last sync timestamp display with formatted time
		const lastSyncSetting = new Setting(containerEl).setName('Last Sync');
		
		// Format the timestamp if it exists
		if (this.plugin.settings.lastSyncTimestamp) {
			try {
				const lastSyncDate = new Date(this.plugin.settings.lastSyncTimestamp);
				const formattedDate = lastSyncDate.toLocaleString(undefined, {
					year: 'numeric',
					month: 'long',
					day: 'numeric',
					hour: '2-digit',
					minute: '2-digit',
					second: '2-digit',
					hour12: true
				});
				
				// Calculate time ago
				const now = new Date();
				const diffMs = now.getTime() - lastSyncDate.getTime();
				const diffMins = Math.floor(diffMs / (1000 * 60));
				const diffHours = Math.floor(diffMins / 60);
				const diffDays = Math.floor(diffHours / 24);
				
				let timeAgo = '';
				if (diffDays > 0) {
					timeAgo = `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
				} else if (diffHours > 0) {
					timeAgo = `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
				} else {
					timeAgo = `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
				}
				
				lastSyncSetting.setDesc(`${formattedDate} (${timeAgo})`);
			} catch (e) {
				// Fallback if date parsing fails
				lastSyncSetting.setDesc(this.plugin.settings.lastSyncTimestamp);
			}
		} else {
			lastSyncSetting.setDesc('Never synced');
		}

		// Manual sync with cancel button
		let manualSyncCancelButtonRef: any = null;
		
		const manualSyncSetting = new Setting(containerEl)
			.setName('Manual Sync')
			.setDesc('Manually sync with Limitless API')
			.addButton((button: any) => button
				.setButtonText('Sync Now')
				.onClick(async () => {
					button.setButtonText('Syncing...');
					button.setDisabled(true);
					
					// Enable both cancel buttons
					if (manualSyncCancelButtonRef) {
						manualSyncCancelButtonRef.setDisabled(false);
					}
					if (cancelButtonRef) {
						cancelButtonRef.setDisabled(false);
					}
					
					// Show progress bar
					this.updateProgressBar();
					
					try {
						await this.plugin.syncLifelogs();
						// Success message is now shown in the syncLifelogs method
					} catch (error: any) {
						// Error handling is now in the syncLifelogs method
					} finally {
						button.setButtonText('Sync Now');
						button.setDisabled(false);
						
						// Disable both cancel buttons
						if (manualSyncCancelButtonRef) {
							manualSyncCancelButtonRef.setDisabled(true);
						}
						if (cancelButtonRef) {
							cancelButtonRef.setDisabled(true);
						}
						
						// Update progress bar one final time
						this.updateProgressBar();
					}
				}));
		
		// Add Cancel button for manual sync
		manualSyncSetting.addButton((button: any) => {
			// Store reference to the button
			manualSyncCancelButtonRef = button;
			
			return button
				.setButtonText('Cancel')
				.setWarning()
				.setDisabled(!this.plugin.isSyncing) // Disabled if no sync is running
				.onClick(async () => {
					await this.plugin.cancelOngoingSync();
					// Disable both cancel buttons
					if (manualSyncCancelButtonRef) manualSyncCancelButtonRef.setDisabled(true);
					if (cancelButtonRef) cancelButtonRef.setDisabled(true);
					this.updateProgressBar(); // Update progress bar to show cancellation
				});
		});

		// Add reset button to the last sync setting
		lastSyncSetting.addButton((button: any) => button
			.setButtonText('Reset')
			.onClick(async () => {
				const confirmed = confirm('Are you sure you want to reset the last sync timestamp? This will cause the next sync to fetch all lifelogs.');
				if (confirmed) {
					this.plugin.settings.lastSyncTimestamp = '';
					await this.plugin.saveSettings();
					new Notice('Last sync timestamp reset. Next sync will fetch all lifelogs.');
					this.display(); // Refresh the settings display
				}
			}));
				
		// ==========================================
		// Section 4: Advanced Settings
		// ==========================================
		containerEl.createEl('h3', {text: 'Advanced Settings'});
		
		// Add debug mode toggle
		const debugSetting = new Setting(containerEl)
			.setName('Debug Mode')
			.setDesc('Enable detailed logging for troubleshooting');
		
		// @ts-ignore - The Obsidian API has this method but TypeScript doesn't know about it
		debugSetting.addToggle((toggle: any) => toggle
			.setValue(this.plugin.settings.debugMode)
			.onChange(async (value: boolean) => {
				this.plugin.settings.debugMode = value;
				await this.plugin.saveSettings();
				new Notice(`Debug mode ${value ? 'enabled' : 'disabled'}`);
			}));

		// Add Force Sync button with Cancel button and date field
		let cancelButtonRef: any = null; // Reference to the cancel button
		let forceSyncStartDateField: HTMLInputElement | null = null; // Reference to the date input field
		
		const forceSyncSetting = new Setting(containerEl)
			.setName('Force Full Sync')
			.setDesc('Force sync all lifelogs and overwrite existing daily note files. Optional: select a custom start date.')
			.addText((text: any) => {
				text.inputEl.type = 'date';
				text.setPlaceholder(this.plugin.settings.startDate);
				forceSyncStartDateField = text.inputEl;
				text.inputEl.style.marginRight = '10px';
				text.inputEl.style.width = '150px';
			})
			.addButton((button: any) => button
				.setButtonText('Force Sync')
				.setCta()
				.onClick(async () => {
					// Get the custom start date if provided
					const customStartDate = forceSyncStartDateField?.value || null;
					const startDateMessage = customStartDate 
						? `from ${customStartDate}` 
						: `from your configured start date (${this.plugin.settings.startDate})`;
					
					const confirmed = confirm(`WARNING: This will fetch ALL lifelogs ${startDateMessage} and OVERWRITE existing daily note files. This cannot be undone. Are you sure you want to continue?`);
					if (confirmed) {
						button.setButtonText('Syncing...');
						button.setDisabled(true);
						
						// Enable cancel button
						if (cancelButtonRef) {
							cancelButtonRef.setDisabled(false);
						}
						
						// Also enable the manual sync cancel button
						if (manualSyncCancelButtonRef) {
							manualSyncCancelButtonRef.setDisabled(false);
						}
						
						// Show progress bar
						this.updateProgressBar();
						
						try {
							await this.plugin.syncLifelogs(true, customStartDate || undefined);
							// Success message is shown in the syncLifelogs method
						} catch (error: any) {
							// Error handling is in the syncLifelogs method
						} finally {
							button.setButtonText('Force Sync');
							button.setDisabled(false);
							
							// Disable cancel buttons
							if (cancelButtonRef) {
								cancelButtonRef.setDisabled(true);
							}
							if (manualSyncCancelButtonRef) {
								manualSyncCancelButtonRef.setDisabled(true);
							}
							
							// Update progress bar one final time
							this.updateProgressBar();
						}
					}
				}));
		
		// Add Cancel Sync button
		forceSyncSetting.addButton((button: any) => {
			// Store reference to the button
			cancelButtonRef = button;
			
			return button
				.setButtonText('Cancel Sync')
				.setWarning()
				.setDisabled(!this.plugin.isSyncing) // Disabled if no sync is running
				.onClick(async () => {
					await this.plugin.cancelOngoingSync();
					// Disable both cancel buttons
					if (cancelButtonRef) cancelButtonRef.setDisabled(true);
					if (manualSyncCancelButtonRef) manualSyncCancelButtonRef.setDisabled(true);
					this.updateProgressBar(); // Update progress bar to show cancellation
				});
		});
			
		// ==========================================
		// Section 5: Sync Status
		// ==========================================
		containerEl.createEl('h3', {text: 'Sync Status'});
		
		// Initial update
		this.updateProgressBar();
		
		// Set up interval for updates
		const progressInterval = setInterval(() => this.updateProgressBar(), 500);
		
		// Clean up interval when settings tab is closed
		this.register(() => clearInterval(progressInterval));
		
		


		// Create a status container with CSS classes instead of inline styles
		const statusContainer = containerEl.createEl('div', { cls: 'limitless-status-container' });

		// Add status text element
		this.statusTextEl = statusContainer.createEl('div', { cls: 'limitless-status-text' });
		this.statusTextEl.textContent = this.plugin.isSyncing ? this.plugin.syncProgressText : 'Ready';

		// Add progress bar for sync operations
		const progressBarContainer = statusContainer.createEl('div', { cls: 'limitless-progress-container' });
		this.progressBarEl = progressBarContainer.createEl('div', { cls: 'limitless-progress-bar' });
		this.progressTextEl = progressBarContainer.createEl('div', { cls: 'limitless-progress-text' });
		
		// Set the initial width of the progress bar (only property we need to set dynamically)
		this.progressBarEl.style.width = `${this.plugin.syncProgress}%`;
		
		// Set the text content
		this.progressTextEl.textContent = this.plugin.syncProgressText || 'Ready';
		

	}
}

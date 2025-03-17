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
	contents: ContentNode[];
	markdown?: string;
}

interface LifelogsData {
	lifelogs: Lifelog[];
}

interface LifelogsResponse {
	data: LifelogsData;
}

interface LimitlessPluginSettings {
	apiUrl: string;
	apiKey: string;
	outputFolder: string;
	syncIntervalMinutes: number;
	lastSyncTimestamp: string;
}

const DEFAULT_SETTINGS: LimitlessPluginSettings = {
	apiUrl: 'https://api.limitless.ai/v1',
	apiKey: '',
	outputFolder: 'Limitless',
	syncIntervalMinutes: 60,
	lastSyncTimestamp: ''
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

	async onload() {
		await this.loadSettings();

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
			name: 'Sync Limitless Lifelogs',
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
		console.log('Loaded settings:', this.settings);
	}

	async saveSettings() {
		console.log('Saving settings:', JSON.stringify(this.settings));
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
		console.log('Ensuring output folder exists:', folderPath);
		
		let folder = this.app.vault.getAbstractFileByPath(folderPath);
		console.log('Folder exists?', !!folder);
		
		if (!folder) {
			// Only create the folder if it doesn't exist
			console.log('Creating folder:', folderPath);
			try {
				folder = await this.app.vault.createFolder(folderPath);
				console.log('Folder created successfully');
			} catch (folderError) {
				// Check if the error is because the folder already exists
				console.log('Error creating folder:', folderError);
				
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
		
		return folder as TFolder;
	}

	async getDailyNotePath(date: Date): Promise<string> {
		const folder = await this.ensureOutputFolder();
		const fileName = `${format(date, 'yyyy-MM-dd')}.md`;
		const filePath = normalizePath(`${folder.path}/${fileName}`);
		console.log('Daily note path:', filePath);
		return filePath;
	}

	async getDailyNote(date: Date): Promise<TFile | null> {
		const filePath = await this.getDailyNotePath(date);
		const file = this.app.vault.getAbstractFileByPath(filePath);
		console.log('Daily note exists?', !!file);
		return file instanceof TFile ? file : null;
	}

	async createOrAppendToDailyNote(date: Date, content: string): Promise<void> {
		// First ensure the output folder exists
		await this.ensureOutputFolder();
		
		// Now get the file path and check if the file exists
		const filePath = await this.getDailyNotePath(date);
		const file = await this.getDailyNote(date);
		
		if (file) {
			console.log('Appending to existing file:', filePath);
			// Append to existing file
			const existingContent = await this.app.vault.read(file);
			console.log('Existing content length:', existingContent.length);
			console.log('New content length:', content.length);
			await this.app.vault.modify(file, existingContent + '\n\n' + content);
			console.log('File modified successfully');
		} else {
			console.log('Creating new file:', filePath);
			// Create new file
			const title = format(date, 'yyyy-MM-dd');
			const initialContent = `# ${title}\n\n${content}`;
			console.log('Initial content length:', initialContent.length);
			try {
				// Create the file
				const newFile = await this.app.vault.create(filePath, initialContent);
				console.log('File created successfully:', newFile.path);
			} catch (createError) {
				console.error('Error creating file:', createError);
				throw createError;
			}
		}
	}

	async fetchLifelogs(since: string | null = null): Promise<LifelogsResponse> {
		try {
			let url = `${this.settings.apiUrl}/lifelogs?includeMarkdown=true`;

			// If we have a last sync timestamp, only fetch newer entries
			if (since) {
				url += `&start=${encodeURIComponent(since)}`;
			}

			const response = await requestUrl({
				url: url,
				method: 'GET',
				headers: {
					'X-API-Key': `${this.settings.apiKey}`,
					'Content-Type': 'application/json'
				}
			});

			return response.json as LifelogsResponse;
		} catch (error) {
			console.error('Error fetching lifelogs:', error);
			
			// Check for 401 Unauthorized error
			if (error.status === 401) {
				throw new Error('Authentication failed. Please check your API key in the Limitless settings.');
			}
			
			throw error;
		}
	}

	async syncLifelogs(): Promise<void> {
		// Check if API key is configured
		if (!this.settings.apiKey) {
			new Notice('Limitless API key not configured. Please update plugin settings.');
			return;
		}

		try {
			
			const lastSync = this.settings.lastSyncTimestamp || null;
			console.log('Starting sync. Last sync timestamp:', lastSync);
			const response = await this.fetchLifelogs(lastSync);
			
			console.log('Received response:', response);
			console.log('Number of lifelogs:', response.data.lifelogs.length);
			
			if (response.data.lifelogs.length === 0) {
				// No new entries
				new Notice('No new Limitless lifelogs to sync.');
				return;
			}

			// Track the latest timestamp
			let latestTimestamp = this.settings.lastSyncTimestamp || '';
			
			// Process each lifelog
			for (const lifelog of response.data.lifelogs) {
				console.log('Processing lifelog:', lifelog.id);
				if (!lifelog.markdown) {
					console.log('Skipping lifelog with no markdown content');
					continue;
				}
				
				// Extract the date from the lifelog's startTime
				const startTime = lifelog.contents[0]?.startTime;
				if (!startTime) {
					console.log('Skipping lifelog with no startTime');
					continue;
				}
				
				const entryDate = new Date(startTime);
				console.log('Entry date:', entryDate);
				
				// Create or append to the daily note
				try {
					await this.createOrAppendToDailyNote(entryDate, lifelog.markdown);
					console.log('Successfully created/updated daily note for date:', entryDate);
				} catch (noteError) {
					console.error('Error creating/updating daily note:', noteError);
				}
				
				// Update latest timestamp if this entry is newer
				const entryTimestamp = new Date(startTime).toISOString();
				console.log('Entry timestamp:', entryTimestamp);
				console.log('Current latest timestamp:', latestTimestamp);
				
				if (!latestTimestamp || new Date(entryTimestamp) > new Date(latestTimestamp)) {
					console.log('Updating latest timestamp to:', entryTimestamp);
					latestTimestamp = entryTimestamp;
				}
			}
			
			// Update the settings with the latest timestamp
			this.settings.lastSyncTimestamp = latestTimestamp;
			console.log('Final last sync timestamp:', this.settings.lastSyncTimestamp);
			
			// Save updated settings with new timestamp
			console.log('Saving settings with last sync timestamp:', this.settings.lastSyncTimestamp);
			await this.saveSettings();
			console.log('Settings saved successfully');
			
			// Show success notification
			new Notice(`Limitless Lifelogs synced! ${response.data.lifelogs.length} entries processed.`);
			
		} catch (error) {
			console.error('Error syncing lifelogs:', error);
			
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

	constructor(app: App, plugin: LimitlessPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();
		containerEl.createEl('h2', {text: 'Limitless Settings'});

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

		new Setting(containerEl)
			.setName('Last Sync')
			.setDesc('Timestamp of the last successful sync')
			.addText((text: any) => text
				.setValue(this.plugin.settings.lastSyncTimestamp || 'Never')
				.setDisabled(true));

		new Setting(containerEl)
			.setName('Manual Sync')
			.setDesc('Manually sync with Limitless API')
			.addButton((button: any) => button
				.setButtonText('Sync Now')
				.onClick(async () => {
					button.setButtonText('Syncing...');
					button.setDisabled(true);
					
					try {
						await this.plugin.syncLifelogs();
						// Success message is now shown in the syncLifelogs method
					} catch (error: any) {
						// Error handling is now in the syncLifelogs method
					} finally {
						button.setButtonText('Sync Now');
						button.setDisabled(false);
					}
				}));

		new Setting(containerEl)
			.setName('Reset Last Sync')
			.setDesc('Reset the last sync timestamp to fetch all lifelogs')
			.addButton((button: any) => button
				.setButtonText('Reset')
				.onClick(async () => {
					this.plugin.settings.lastSyncTimestamp = '';
					await this.plugin.saveSettings();
					new Notice('Last sync timestamp reset. Next sync will fetch all lifelogs.');
				}));
	}
}

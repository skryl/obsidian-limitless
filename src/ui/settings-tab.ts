import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import { ILimitlessPlugin } from '../models/plugin-interface';
import { SyncState } from '../models/types';
import { format } from 'date-fns';

export class LimitlessSettingTab extends PluginSettingTab {
    plugin: ILimitlessPlugin;
    private cleanupFns: Array<() => void> = [];
    private modelSetting: Setting | null = null;
    private modelDropdown: any = null;

    constructor(app: App, plugin: ILimitlessPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    // UI elements for progress bar
    private statusTextEl: HTMLElement | null = null;
    private progressBarEl: HTMLElement | null = null;
    private progressTextEl: HTMLElement | null = null;
    private progressInterval?: number;
    
    /**
     * Clean up any event listeners when the settings tab is closed
     */
    hide() {
        // Clean up all registered event listeners
        this.cleanupFns.forEach(fn => fn());
        this.cleanupFns = [];
        
        // Clear any running intervals
        if (this.progressInterval) {
            window.clearInterval(this.progressInterval);
            this.progressInterval = undefined;
        }
    }
    
    /**
     * Refresh the list of models from OpenAI and update the dropdown
     * @returns {Promise<boolean>} True if successful, false if failed
     */
    async refreshModelsList(containerEl: HTMLElement): Promise<boolean> {
        if (!this.plugin.settings.openaiApiKey) {
            return false;
        }
        
        // Add loading indicator first
        this.addOrUpdateModelSetting(containerEl);
        
        try {
            const models = await this.plugin.summarizationService.fetchAvailableModels();
            
            if (models.length === 0) {
                new Notice('Could not fetch available models. Please check your API key.', 4000);
                
                // API key is invalid - disable summarization
                if (this.plugin.settings.summarizationEnabled) {
                    this.plugin.settings.summarizationEnabled = false;
                    await this.plugin.saveSettings();
                    this.display();
                }
                
                return false;
            }
            
            // Make sure current model is in the list, or select first model
            if (!models.includes(this.plugin.settings.openaiModelName)) {
                this.plugin.settings.openaiModelName = models[0];
                await this.plugin.saveSettings();
            }
            
            // Update model dropdown with retrieved models
            this.addOrUpdateModelSetting(containerEl, models);
            
            // Make sure the dropdown value is set correctly
            if (this.modelDropdown && this.plugin.settings.openaiModelName) {
                this.modelDropdown.setValue(this.plugin.settings.openaiModelName);
            }
            
            new Notice(`Successfully connected to OpenAI. Found ${models.length} available models.`);
            return true;
        } catch (error) {
            console.error('Error refreshing models list:', error);
            new Notice(`Error fetching models: ${error.message}`, 4000);
            
            // API key is likely invalid - disable summarization
            if (this.plugin.settings.summarizationEnabled) {
                this.plugin.settings.summarizationEnabled = false;
                await this.plugin.saveSettings();
                this.display();
            }
            
            return false;
        }
    }
    
    /**
     * Add or update the model dropdown setting
     */
    addOrUpdateModelSetting(containerEl: HTMLElement, models?: string[]): void {
        // Get the model setting container if it exists
        const modelSettingContainer = containerEl.querySelector('#model-setting-container');
        
        // Remove existing model setting if it exists
        if (modelSettingContainer) {
            modelSettingContainer.remove();
            this.modelSetting = null;
            this.modelDropdown = null;
        }
        
        // Create a container for the model setting
        const settingContainer = containerEl.createDiv({ attr: { id: 'model-setting-container' } });
        
        // Create a loading indicator if we're fetching models
        if (!models) {
            this.modelSetting = new Setting(settingContainer)
                .setName('OpenAI Model')
                .setDesc('Loading available models...');
            
            // Add a simple loading text
            this.modelSetting.setDesc('Loading available models... Please wait');
            return;
        }
        
        // Display the models dropdown
        this.modelSetting = new Setting(settingContainer)
            .setName('OpenAI Model')
            .setDesc(`Select from ${models.length} available models for summarization`)
            .addDropdown(dropdown => {
                this.modelDropdown = dropdown;
                
                // Helper function to get display name for model ID
                const getModelDisplayName = (modelId: string) => {
                    if (modelId.includes('gpt-3.5-turbo-16k')) return 'GPT-3.5 Turbo 16K';
                    if (modelId.includes('gpt-3.5-turbo')) return 'GPT-3.5 Turbo';
                    if (modelId.includes('gpt-4-turbo')) return 'GPT-4 Turbo';
                    if (modelId.includes('gpt-4-32k')) return 'GPT-4 32K';
                    if (modelId.includes('gpt-4')) return 'GPT-4';
                    return modelId; // Default to showing the model ID
                };
                
                // Add model options
                models.sort().forEach(modelId => {
                    dropdown.addOption(modelId, getModelDisplayName(modelId));
                });
                
                dropdown.setValue(this.plugin.settings.openaiModelName)
                    .onChange(async (value) => {
                        this.plugin.settings.openaiModelName = value;
                        await this.plugin.saveSettings();
                    });
            });
        
        // Move this setting to be right after the API key and toggle
        const summaryFolderSetting = containerEl.querySelector('.setting-item:nth-child(4)');
        if (summaryFolderSetting) {
            containerEl.insertBefore(settingContainer, summaryFolderSetting);
        } else {
            // If we can't find the exact position, just append it
            containerEl.appendChild(settingContainer);
        }
    }

    /**
     * Display the settings UI
     */
    display(): void {
        const { containerEl } = this;

        containerEl.empty();
        containerEl.addClass('limitless-setting-tab');

        containerEl.createEl('h2', { text: 'Limitless Plugin Settings' });

        this.addApiSettings(containerEl);
        this.addGeneralSettings(containerEl);
        this.addSummarizationSettings(containerEl);
        this.addDebugSettings(containerEl);
    }

    /**
     * Add API settings to the settings tab
     */
    private addApiSettings(containerEl: HTMLElement) {
        containerEl.createEl('h3', { text: 'API Settings' });

        new Setting(containerEl)
            .setName('API URL')
            .setDesc('URL of the Limitless API')
            .addText(text => text
                .setPlaceholder('https://api.limitless.ai/v1')
                .setValue(this.plugin.settings.apiUrl)
                .onChange(async (value) => {
                    this.plugin.settings.apiUrl = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('API Key')
            .setDesc('Your Limitless API key')
            .addText(text => {
                text.setPlaceholder('Enter your API key')
                    .setValue(this.plugin.settings.apiKey ? '••••••••••••••••••••••••••' : '')
                    .onChange(async (value) => {
                        // Only update if not masked
                        if (value && !value.match(/^•+$/)) {
                            this.plugin.settings.apiKey = value;
                            await this.plugin.saveSettings();
                        }
                    });
                
                // Use password input style
                text.inputEl.type = 'password';
                
                // Add show/hide button
                const showHideButton = text.inputEl.parentElement!.createEl('button', {
                    text: 'Show',
                    cls: 'show-hide-button'
                });
                
                // Add event listener
                const toggleVisible = (e: MouseEvent) => {
                    e.preventDefault();
                    if (text.inputEl.type === 'password') {
                        text.inputEl.type = 'text';
                        showHideButton.textContent = 'Hide';
                        if (this.plugin.settings.apiKey) {
                            text.setValue(this.plugin.settings.apiKey);
                        }
                    } else {
                        text.inputEl.type = 'password';
                        showHideButton.textContent = 'Show';
                        if (this.plugin.settings.apiKey) {
                            text.setValue('••••••••••••••••••••••••••');
                        }
                    }
                };
                
                showHideButton.addEventListener('click', toggleVisible);
                this.cleanupFns.push(() => showHideButton.removeEventListener('click', toggleVisible));
            });

        // Test connection button
        new Setting(containerEl)
            .setName('Test API Connection')
            .setDesc('Test the connection to the Limitless API')
            .addButton(button => button
                .setButtonText('Test Connection')
                .onClick(async () => {
                    button.setDisabled(true);
                    button.setButtonText('Testing...');
                    
                    try {
                        await this.plugin.testAPIConnection();
                    } finally {
                        button.setDisabled(false);
                        button.setButtonText('Test Connection');
                    }
                }));
    }

    /**
     * Add general settings to the settings tab
     */
    private addGeneralSettings(containerEl: HTMLElement) {
        containerEl.createEl('h3', { text: 'General Settings' });

        new Setting(containerEl)
            .setName('Output Folder')
            .setDesc('Folder to store daily notes')
            .addText(text => text
                .setPlaceholder('Limitless')
                .setValue(this.plugin.settings.outputFolder)
                .onChange(async (value) => {
                    this.plugin.settings.outputFolder = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Sync Interval')
            .setDesc('How often to sync lifelogs (in minutes)')
            .addSlider(slider => slider
                .setLimits(5, 120, 5)
                .setValue(this.plugin.settings.syncIntervalMinutes)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.syncIntervalMinutes = value;
                    await this.plugin.saveSettings();
                    // Update the interval timer
                    this.plugin.registerSyncInterval();
                }))
            .addButton(button => button
                .setIcon('reset')
                .setTooltip('Reset to default (60 minutes)')
                .onClick(async () => {
                    this.plugin.settings.syncIntervalMinutes = 60;
                    await this.plugin.saveSettings();
                    this.display();
                    // Update the interval timer
                    this.plugin.registerSyncInterval();
                }));

        new Setting(containerEl)
            .setName('Chronological Order')
            .setDesc('Display lifelogs in chronological order (oldest first)')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.ascendingOrder)
                .onChange(async (value) => {
                    this.plugin.settings.ascendingOrder = value;
                    await this.plugin.saveSettings();
                }));
                
        new Setting(containerEl)
            .setName('Use System Timezone')
            .setDesc('Use your system timezone when fetching lifelogs')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useSystemTimezone)
                .onChange(async (value) => {
                    this.plugin.settings.useSystemTimezone = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Force Overwrite')
            .setDesc('Always overwrite existing notes instead of updating them')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.forceOverwrite)
                .onChange(async (value) => {
                    this.plugin.settings.forceOverwrite = value;
                    await this.plugin.saveSettings();
                }));

        // Add sync status
        containerEl.createEl('h3', { text: 'Sync Status' });

        // Last sync time
        const lastSyncTime = this.plugin.settings.lastSyncTimestamp 
            ? format(new Date(this.plugin.settings.lastSyncTimestamp), 'MMM d, yyyy h:mm a')
            : 'Never';

        new Setting(containerEl)
            .setName('Last Sync')
            .setDesc(`Last successful sync: ${lastSyncTime}`)
            .addButton(button => button
                .setButtonText('Sync Now')
                .setDisabled(this.plugin.isSyncing)
                .onClick(async () => {
                    if (!this.plugin.isSyncing) {
                        await this.plugin.syncLifelogs();
                        this.display();
                    }
                }));

        // Force full sync (with date picker)
        const startDateSetting = new Setting(containerEl)
            .setName('Force Full Sync')
            .setDesc('Sync all lifelogs from the start date')
            .addText(text => {
                text.setValue(this.plugin.settings.startDate)
                    .setPlaceholder('YYYY-MM-DD')
                    .onChange(async (value) => {
                        // Validate date format
                        if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
                            this.plugin.settings.startDate = value;
                            await this.plugin.saveSettings();
                        }
                    });

                // Set input type to date
                text.inputEl.type = 'date';
            })
            .addButton(button => button
                .setButtonText('Force Sync')
                .setDisabled(this.plugin.isSyncing)
                .onClick(async () => {
                    if (!this.plugin.isSyncing) {
                        await this.plugin.syncLifelogs(true);
                        this.display();
                    }
                }));
                
        // Add progress bar if syncing
        if (this.plugin.isSyncing) {
            const progressBarContainer = containerEl.createDiv({ cls: 'progress-bar-container' });
            
            // Create a header with progress text and cancel button
            const progressHeader = progressBarContainer.createDiv({ cls: 'progress-header' });
            
            // Add progress text
            progressHeader.createDiv({ text: this.plugin.syncProgressText, cls: 'progress-text' });
            
            // Add cancel button
            const cancelButton = progressHeader.createEl('button', { 
                text: 'Cancel', 
                cls: 'cancel-sync-button' 
            });
            
            cancelButton.addEventListener('click', () => {
                // Access cancelSync property through explicit cast to SyncState
                const syncState = this.plugin as unknown as SyncState;
                if (this.plugin.isSyncing && !syncState.cancelSync) {
                    this.plugin.cancelSyncOperation();
                    cancelButton.disabled = true;
                    cancelButton.setText('Cancelling...');
                }
            });
            
            // Access SyncState properties through explicit cast
            const syncState = this.plugin as unknown as SyncState;
            
            // Show total progress count if available
            if (syncState.syncTotal > 0) {
                progressHeader.createDiv({
                    text: `${syncState.syncCurrent} of ${syncState.syncTotal}`,
                    cls: 'progress-count'
                });
            }
            
            // Add progress bar
            const progressBarOuter = progressBarContainer.createDiv({ cls: 'progress-bar-outer' });
            const progressBarInner = progressBarOuter.createDiv({ cls: 'progress-bar-inner' });
            progressBarInner.style.width = `${this.plugin.syncProgress}%`;
            
            // Progress bar styles are now in styles.css
            
            // We'll use an interval to update the progress bar instead of requestAnimationFrame
            // This is more stable and less likely to cause rendering issues
            
            // Initial update
            this.updateSyncProgressBar(progressBarInner, progressHeader, cancelButton);
            
            // Set up interval for updates if not already running
            if (!this.progressInterval) {
                this.progressInterval = window.setInterval(() => {
                    this.updateSyncProgressBar(progressBarInner, progressHeader, cancelButton);
                    
                    // If sync is no longer running, refresh the display
                    if (!this.plugin.isSyncing) {
                        window.clearInterval(this.progressInterval);
                        this.progressInterval = undefined;
                        this.display();
                    }
                }, 500);
                
                // Make sure this gets cleaned up
                this.cleanupFns.push(() => {
                    if (this.progressInterval) {
                        window.clearInterval(this.progressInterval);
                        this.progressInterval = undefined;
                    }
                });
            }
        }
    }

    /**
     * Add summarization settings to the settings tab
     */
    private addSummarizationSettings(containerEl: HTMLElement) {
        containerEl.createEl('h3', { text: 'Summarization Settings' });

        // OpenAI API Key - moved to top level
        new Setting(containerEl)
            .setName('OpenAI API Key')
            .setDesc('Your OpenAI API key for generating summaries')
            .addText(text => {
                text.setPlaceholder('Enter your OpenAI API key')
                    .setValue(this.plugin.settings.openaiApiKey ? '••••••••••••••••••••••••••' : '')
                    .onChange(async (value) => {
                        // Don't update if the value is just masked bullets
                        if (value.match(/^•+$/)) {
                            return;
                        }
                        
                        // Update the API key with the new value (including empty string)
                        const oldKey = this.plugin.settings.openaiApiKey;
                        this.plugin.settings.openaiApiKey = value;
                        await this.plugin.saveSettings();
                        
                        // If the key was cleared and summarization was enabled
                        if (value === '' && this.plugin.settings.summarizationEnabled) {
                            this.plugin.settings.summarizationEnabled = false;
                            await this.plugin.saveSettings();
                            new Notice('Summarization has been disabled because the API key was removed');
                            this.display(); // Refresh the UI
                            return;
                        }
                        
                        // If the key was changed and summarization is enabled, test the new key
                        if (value !== oldKey && this.plugin.settings.summarizationEnabled) {
                            // Validate the new key
                            new Notice('Testing the updated API key...');
                            const success = await this.refreshModelsList(containerEl);
                            
                            // If key is invalid, it will automatically turn off summarization
                            if (!success) {
                                // refreshModelsList will have already turned off summarization
                                new Notice('API key validation failed. Summarization has been disabled.', 4000);
                            }
                        }
                    });
                
                // Use password input style
                text.inputEl.type = 'password';
                
                // Add show/hide button
                const showHideButton = text.inputEl.parentElement!.createEl('button', {
                    text: 'Show',
                    cls: 'show-hide-button'
                });
                
                // Add event listener
                const toggleVisible = (e: MouseEvent) => {
                    e.preventDefault();
                    if (text.inputEl.type === 'password') {
                        text.inputEl.type = 'text';
                        showHideButton.textContent = 'Hide';
                        if (this.plugin.settings.openaiApiKey) {
                            text.setValue(this.plugin.settings.openaiApiKey);
                        }
                    } else {
                        text.inputEl.type = 'password';
                        showHideButton.textContent = 'Show';
                        if (this.plugin.settings.openaiApiKey) {
                            text.setValue('••••••••••••••••••••••••••');
                        }
                    }
                };
                
                showHideButton.addEventListener('click', toggleVisible);
                this.cleanupFns.push(() => showHideButton.removeEventListener('click', toggleVisible));
            });

        // Enable summarization - moved after API key
        new Setting(containerEl)
            .setName('Enable Summarization')
            .setDesc('Automatically generate summaries for your daily notes using OpenAI')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.summarizationEnabled)
                .onChange(async (value) => {
                    if (value) {
                        // Check if API key is provided
                        if (!this.plugin.settings.openaiApiKey) {
                            new Notice('Error: OpenAI API key is required to enable summarization', 4000);
                            toggle.setValue(false);
                            return;
                        }
                        
                        // Test connection with OpenAI
                        new Notice('Testing OpenAI connection...');
                        
                        // Use our refreshModelsList method which handles all the error cases
                        const success = await this.refreshModelsList(containerEl);
                        
                        if (success) {
                            // Only save enabled state if we successfully validated the API key
                            this.plugin.settings.summarizationEnabled = true;
                            await this.plugin.saveSettings();
                            
                            // Update the UI with models
                            this.display();
                        } else {
                            // Reset the toggle to disabled
                            toggle.setValue(false);
                            this.plugin.settings.summarizationEnabled = false;
                            await this.plugin.saveSettings();
                        }
                    } else {
                        // If disabling, just update the setting
                        this.plugin.settings.summarizationEnabled = false;
                        await this.plugin.saveSettings();
                        this.display();
                    }
                }));

        // Only show these settings if summarization is enabled
        if (this.plugin.settings.summarizationEnabled) {
            // Add OpenAI model dropdown directly here
            let modelsList = ['gpt-3.5-turbo', 'gpt-3.5-turbo-16k', 'gpt-4', 'gpt-4-turbo'];
            
            new Setting(containerEl)
                .setName('OpenAI Model')
                .setDesc('Select a model for generating summaries')
                .addDropdown(dropdown => {
                    // Add default options first
                    const getModelDisplayName = (modelId: string) => {
                        return modelId;
                    };
                    
                    modelsList.forEach(modelId => {
                        dropdown.addOption(modelId, getModelDisplayName(modelId));
                    });
                    
                    dropdown.setValue(this.plugin.settings.openaiModelName || modelsList[0])
                        .onChange(async (value) => {
                            this.plugin.settings.openaiModelName = value;
                            await this.plugin.saveSettings();
                        });
                    
                    // Fetch available models in the background
                    this.plugin.summarizationService.fetchAvailableModels().then(models => {
                        if (models && models.length > 0) {
                            // Clear dropdown and add new options
                            const currentValue = dropdown.getValue();
                            dropdown.selectEl.empty();
                            
                            models.sort().forEach(modelId => {
                                dropdown.addOption(modelId, getModelDisplayName(modelId));
                            });
                            
                            // Restore selection if possible, otherwise select first
                            if (models.includes(currentValue)) {
                                dropdown.setValue(currentValue);
                            } else {
                                dropdown.setValue(models[0]);
                                this.plugin.settings.openaiModelName = models[0];
                                this.plugin.saveSettings();
                            }
                        }
                    }).catch(error => {
                        console.error('Error fetching models:', error);
                    });
                });

            // Summary output folder
            new Setting(containerEl)
                .setName('Summary Output Folder')
                .setDesc('Folder to store summaries')
                .addText(text => text
                    .setPlaceholder('Summaries')
                    .setValue(this.plugin.settings.summaryOutputFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.summaryOutputFolder = value;
                        await this.plugin.saveSettings();
                    }));

            // Prompt
            new Setting(containerEl)
                .setName('Summarization Prompt')
                .setDesc('Prompt to use for generating summaries')
                .addTextArea(textarea => {
                    textarea
                        .setPlaceholder('Create a detailed summary of this daily note...')
                        .setValue(this.plugin.settings.summarizationPrompt)
                        .onChange(async (value) => {
                            this.plugin.settings.summarizationPrompt = value;
                            await this.plugin.saveSettings();
                        });
                    
                    // Adjust textarea height
                    textarea.inputEl.rows = 4;
                    textarea.inputEl.addClass('limitless-textarea');
                });

            // We've removed the test button since testing happens automatically

            // Summarize all notes
            new Setting(containerEl)
                .setName('Summarize All Notes')
                .setDesc('Generate summaries for all daily notes')
                .addButton(button => button
                    .setButtonText('Summarize Changed Notes')
                    .setDisabled(this.plugin.isSummarizing)
                    .onClick(async () => {
                        if (!this.plugin.isSummarizing) {
                            await this.plugin.summarizationService.summarizeAllNotes(false);
                            this.display();
                        }
                    }))
                .addButton(button => button
                    .setButtonText('Force Summarize All')
                    .setDisabled(this.plugin.isSummarizing)
                    .onClick(async () => {
                        if (!this.plugin.isSummarizing) {
                            await this.plugin.summarizationService.summarizeAllNotes(true);
                            this.display();
                        }
                    }));

            // Add progress bar if summarizing
            if (this.plugin.isSummarizing) {
                const progressBarContainer = containerEl.createDiv({ cls: 'progress-bar-container' });
                
                // Add progress text
                progressBarContainer.createDiv({ 
                    text: this.plugin.summarizationProgressText, 
                    cls: 'progress-text' 
                });
                
                // Add progress count
                if (this.plugin.summarizationTotal > 0) {
                    const progress = `${this.plugin.summarizationCurrent} of ${this.plugin.summarizationTotal} notes`;
                    progressBarContainer.createDiv({ text: progress, cls: 'progress-count' });
                    
                    // Add progress bar
                    const progressBarOuter = progressBarContainer.createDiv({ cls: 'progress-bar-outer' });
                    const progressPercent = Math.floor((this.plugin.summarizationCurrent / this.plugin.summarizationTotal) * 100);
                    const progressBarInner = progressBarOuter.createDiv({ cls: 'progress-bar-inner' });
                    progressBarInner.style.width = `${progressPercent}%`;
                    
                    // Cancel button
                    new Setting(progressBarContainer)
                        .addButton(button => button
                            .setButtonText('Cancel')
                            .onClick(async () => {
                                await this.plugin.summarizationService.cancelOngoingSummarization();
                                button.setDisabled(true);
                                button.setButtonText('Cancelling...');
                            }));
                }
                
                // Progress bar styles are now in styles.css
                
                // Use the same interval-based approach for summarization updates
                // Initial update
                this.updateSummarizationProgressBar(progressBarContainer);
                
                // Set up a separate interval for summarization updates if not already running
                if (!this.progressInterval) {
                    this.progressInterval = window.setInterval(() => {
                        this.updateSummarizationProgressBar(progressBarContainer);
                        
                        // If summarization is no longer running, refresh the display
                        if (!this.plugin.isSummarizing) {
                            window.clearInterval(this.progressInterval);
                            this.progressInterval = undefined;
                            this.display();
                        }
                    }, 500);
                    
                    // Make sure this gets cleaned up
                    this.cleanupFns.push(() => {
                        if (this.progressInterval) {
                            window.clearInterval(this.progressInterval);
                            this.progressInterval = undefined;
                        }
                    });
                }
            }
        }
    }

    /**
     * Add debug settings to the settings tab
     */
    /**
     * Updates the sync progress bar
     */
    private updateSyncProgressBar(progressBarInner: HTMLElement, progressHeader: HTMLElement, cancelButton: HTMLElement): void {
        // Update progress bar width
        progressBarInner.style.width = `${this.plugin.syncProgress}%`;
        
        // Update progress text
        const progressTextEl = progressHeader.querySelector('.progress-text');
        if (progressTextEl) {
            progressTextEl.textContent = this.plugin.syncProgressText;
        }
        
        // Access SyncState properties through explicit cast
        const syncState = this.plugin as unknown as SyncState;
        
        // Update count if available
        const progressCountEl = progressHeader.querySelector('.progress-count');
        if (progressCountEl && syncState.syncTotal > 0) {
            progressCountEl.textContent = `${syncState.syncCurrent} of ${syncState.syncTotal}`;
        }
        
        // Update cancel button state
        if (syncState.cancelSync && cancelButton) {
            // Use setAttribute for button properties since disabled isn't a standard HTMLElement property
            cancelButton.setAttribute('disabled', 'true');
            cancelButton.textContent = 'Cancelling...';
        }
    }
    
    /**
     * Updates the summarization progress bar
     */
    private updateSummarizationProgressBar(progressBarContainer: HTMLElement): void {
        if (this.plugin.summarizationTotal > 0) {
            const progressPercent = Math.floor((this.plugin.summarizationCurrent / this.plugin.summarizationTotal) * 100);
            const progressBarInner = progressBarContainer.querySelector('.progress-bar-inner');
            if (progressBarInner) {
                (progressBarInner as HTMLElement).style.width = `${progressPercent}%`;
            }
            
            const progressCount = progressBarContainer.querySelector('.progress-count');
            if (progressCount) {
                progressCount.textContent = `${this.plugin.summarizationCurrent} of ${this.plugin.summarizationTotal} notes`;
            }
        }
        
        const progressText = progressBarContainer.querySelector('.progress-text');
        if (progressText) {
            progressText.textContent = this.plugin.summarizationProgressText;
        }
    }
    
    private addDebugSettings(containerEl: HTMLElement) {
        containerEl.createEl('h3', { text: 'Debug Settings' });

        new Setting(containerEl)
            .setName('Debug Mode')
            .setDesc('Enable debug logging and extra metadata in notes')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.debugMode)
                .onChange(async (value) => {
                    this.plugin.settings.debugMode = value;
                    await this.plugin.saveSettings();
                }));

        // Always show sync progress section
        const syncProgressSection = containerEl.createDiv();
        syncProgressSection.createEl('h4', { text: 'Sync Progress' });
        
        // Create progress bar container
        const progressBarContainer = syncProgressSection.createDiv({ cls: 'progress-bar-container' });
        
        // Add progress bar
        const progressBarOuter = progressBarContainer.createDiv({ cls: 'progress-bar-outer' });
        const progressBarInner = progressBarOuter.createDiv({ cls: 'progress-bar-inner' });
        progressBarInner.style.width = `${this.plugin.syncProgress}%`;
        
        // Add progress text
        const progressHeader = progressBarContainer.createDiv({ cls: 'progress-header' });
        progressHeader.createDiv({ text: this.plugin.syncProgressText || 'No sync in progress', cls: 'progress-text' });
        
        if (this.plugin.settings.debugMode) {
            // Add debug info section without version
            const debugInfo = containerEl.createDiv({ cls: 'debug-info' });
            
            // Add additional debug info if needed
            if (this.plugin.syncProgressText) {
                debugInfo.createEl('div', { text: `Last sync status: ${this.plugin.syncProgressText}` });
            }
        }
    }
}

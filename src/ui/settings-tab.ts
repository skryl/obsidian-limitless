import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import { ILimitlessPlugin } from '../models/plugin-interface';
import { SyncState } from '../models/types';
import { format } from 'date-fns';

export class LimitlessSettingTab extends PluginSettingTab {
    plugin: ILimitlessPlugin;
    private cleanupFns: Array<() => void> = [];
    private modelSetting: Setting | null = null;
    private modelDropdown: any = null;
    private syncStatusEl: HTMLElement | null = null;
    private summarizationStatusEl: HTMLElement | null = null;
    private syncCancelButton: HTMLButtonElement | null = null;
    private summarizeCancelButton: HTMLButtonElement | null = null;

    constructor(app: App, plugin: ILimitlessPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }


    
    /**
     * Clean up any event listeners when the settings tab is closed
     */
    hide() {
        // Clean up all registered event listeners
        this.cleanupFns.forEach(fn => fn());
        this.cleanupFns = [];
    }
    
    /**
     * Refresh the list of models from OpenAI and update the dropdown
     * @returns {Promise<boolean>} True if successful, false if failed
     */
    async refreshModelsList(containerEl: HTMLElement): Promise<boolean> {
        if (!this.plugin.settings.openaiApiKey) {
            return false;
        }
        
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
            this.updateModelDropdown(containerEl, models);
            
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
     * Handles model dropdown updates when the models list is refreshed
     */
    updateModelDropdown(containerEl: HTMLElement, models: string[]): void {
        // Find the model container
        const modelContainer = containerEl.querySelector('#model-setting-container') as HTMLElement;
        if (!modelContainer) {
            console.error('Model setting container not found');
            return;
        }

        // Clear existing settings
        modelContainer.empty();

        // Create the dropdown
        this.modelSetting = new Setting(modelContainer)
            .setName('OpenAI Model')
            .setDesc(`Select from ${models.length} available models for summarization`)
            .addDropdown(dropdown => {
                this.modelDropdown = dropdown;
                
                // Helper function to get display name for model ID
                const getModelDisplayName = (modelId: string) => {
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
    }
    /**
     * Display the settings UI
     */
    display(): void {
        try {
            const { containerEl } = this;

            containerEl.empty();
            containerEl.addClass('limitless-setting-tab');

            containerEl.createEl('h2', { text: 'Limitless Plugin Settings' });

            // Add a basic error-handling wrapper around each section
            try {
                this.addApiSettings(containerEl);
            } catch (error) {
                console.error('Error rendering API settings:', error);
                containerEl.createEl('div', { 
                    text: 'Error rendering API settings. Check console for details.',
                    cls: 'settings-error'
                });
            }
            
            try {
                this.addSyncSettings(containerEl);
            } catch (error) {
                console.error('Error rendering sync settings:', error);
                containerEl.createEl('div', { 
                    text: 'Error rendering sync settings. Check console for details.',
                    cls: 'settings-error'
                });
            }
            
            try {
                this.addSummarizationSettings(containerEl);
            } catch (error) {
                console.error('Error rendering summarization settings:', error);
                containerEl.createEl('div', { 
                    text: 'Error rendering summarization settings. Check console for details.',
                    cls: 'settings-error'
                });
            }
            
            try {
                this.addDebugSettings(containerEl);
            } catch (error) {
                console.error('Error rendering debug settings:', error);
                containerEl.createEl('div', { 
                    text: 'Error rendering debug settings. Check console for details.',
                    cls: 'settings-error'
                });
            }
        } catch (error) {
            console.error('Fatal error in settings tab:', error);
            const { containerEl } = this;
            containerEl.empty();
            containerEl.createEl('h2', { text: 'Limitless Plugin Settings Error' });
            containerEl.createEl('div', { 
                text: 'An error occurred while rendering the settings tab. Check console for details.',
                cls: 'settings-error'
            });
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
    }

    /**
     * Add API settings to the settings tab
     */
    private addApiSettings(containerEl: HTMLElement) {
        containerEl.createEl('h3', { text: 'API Settings' });
        

        new Setting(containerEl)
            .setName('Limitless API URL')
            .setDesc('URL of the Limitless API')
            .addText(text => text
                .setPlaceholder('https://api.limitless.ai/v1')
                .setValue(this.plugin.settings.apiUrl)
                .onChange(async (value) => {
                    this.plugin.settings.apiUrl = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Limitless API Key')
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
                
                // Add test connection button next to show/hide button
                const testButton = text.inputEl.parentElement!.createEl('button', {
                    text: 'Test',
                    cls: 'test-button'
                });

                // Add event listener for show/hide
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

                // Add event listener for test button
                const testConnection = async (e: MouseEvent) => {
                    e.preventDefault();
                    testButton.disabled = true;
                    testButton.textContent = 'Testing...';
                    
                    try {
                        await this.plugin.testAPIConnection();
                    } finally {
                        testButton.disabled = false;
                        testButton.textContent = 'Test';
                    }
                };
                
                showHideButton.addEventListener('click', toggleVisible);
                testButton.addEventListener('click', testConnection);
                this.cleanupFns.push(() => {
                    showHideButton.removeEventListener('click', toggleVisible);
                    testButton.removeEventListener('click', testConnection);
                });
            });

        // OpenAI API Key moved from summarization settings
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
                
                // Add test button next to show/hide button
                const testButton = text.inputEl.parentElement!.createEl('button', {
                    text: 'Test',
                    cls: 'test-button'
                });
                
                // Add event listener for show/hide
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
                
                // Add event listener for test
                const testOpenAIConnection = async (e: MouseEvent) => {
                    e.preventDefault();
                    testButton.disabled = true;
                    testButton.textContent = 'Testing...';
                    
                    try {
                        await this.refreshModelsList(containerEl);
                    } finally {
                        testButton.disabled = false;
                        testButton.textContent = 'Test';
                    }
                };
                
                showHideButton.addEventListener('click', toggleVisible);
                testButton.addEventListener('click', testOpenAIConnection);
                this.cleanupFns.push(() => {
                    showHideButton.removeEventListener('click', toggleVisible);
                    testButton.removeEventListener('click', testOpenAIConnection);
                });
            });
    }

    /**
     * Add sync settings to the settings tab
     */
    private addSyncSettings(containerEl: HTMLElement) {
        containerEl.createEl('h3', { text: 'Sync Settings' });

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
            .setName('Force Overwrite')
            .setDesc('Always overwrite existing notes instead of updating them')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.forceOverwrite)
                .onChange(async (value) => {
                    this.plugin.settings.forceOverwrite = value;
                    await this.plugin.saveSettings();
                }));

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
                        // Start sync without refreshing the UI
                        this.plugin.syncLifelogs().then(() => {
                            // Only update the UI after the operation is complete
                            setTimeout(() => {
                                if (this.syncStatusEl) {
                                    this.updateStatusDisplay('sync', this.determineSyncStatus());
                                }
                            }, 100);
                        });
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
                        // Start force sync without refreshing the UI
                        this.plugin.syncLifelogs(true).then(() => {
                            // Only update the UI after the operation is complete
                            setTimeout(() => {
                                if (this.syncStatusEl) {
                                    this.updateStatusDisplay('sync', this.determineSyncStatus());
                                }
                            }, 100);
                        });
                    }
                }));
                
        // Add Sync Status with Cancel button
        const syncStatusContainer = containerEl.createDiv('setting-item');
        const syncInfoDiv = syncStatusContainer.createDiv('setting-item-info');
        const syncNameDiv = syncInfoDiv.createDiv('setting-item-name');
        syncNameDiv.setText('Sync Status');
        
        // Create status text container under the title
        const syncStatusTextContainer = syncInfoDiv.createDiv('setting-item-description');
        this.syncStatusEl = syncStatusTextContainer.createSpan('status-text');
        
        // Set initial status
        const syncInitialStatus = this.determineSyncStatus();
        this.syncStatusEl.textContent = syncInitialStatus;
        this.syncStatusEl.style.color = this.plugin.isSyncing ? 'var(--text-accent)' : 'var(--text-normal)';
        this.syncStatusEl.style.fontSize = 'var(--font-smaller)';
        
        // Add cancel button on the right
        const syncControlDiv = syncStatusContainer.createDiv('setting-item-control');
        this.syncCancelButton = syncControlDiv.createEl('button', { text: 'Cancel', cls: 'mod-warning' });
        this.syncCancelButton.disabled = !this.plugin.isSyncing;
        this.syncCancelButton.addEventListener('click', async () => {
            new Notice('Cancelling sync operation...');
            await this.plugin.cancelSyncOperation();
        });
        
        // Force a proper status update immediately after rendering
        setTimeout(() => {
            this.updateStatusDisplay('sync', syncInitialStatus);
        }, 50);
        
        // Register a mutation observer to keep the status indicator up to date
        const syncObserver = new MutationObserver(() => {
            if (this.syncStatusEl) {
                const currentStatus = this.determineSyncStatus();
                this.updateStatusDisplay('sync', currentStatus);
            }
        });
        
        // Observe changes to the status element
        if (this.syncStatusEl) {
            syncObserver.observe(this.syncStatusEl, { childList: true });
            this.cleanupFns.push(() => syncObserver.disconnect());
        }
    }

    /**
     * Add summarization settings to the settings tab
     */
    private addSummarizationSettings(containerEl: HTMLElement) {
        containerEl.createEl('h3', { text: 'Summarization Settings' });

        // Enable summarization - moved after API key
        new Setting(containerEl)
            .setName('Enable Summarization')
            .setDesc('Automatically generate summaries for your daily notes using OpenAI')
            .addToggle(toggle => {
                // Make sure toggle visually reflects the current setting
                toggle.setValue(this.plugin.settings.summarizationEnabled);
                toggle.onChange(async (value) => {
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
                            new Notice('Summarization enabled successfully!');
                            // Instead of full display() which loses state, just update the model list
                            // this.display();
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
                        new Notice('Summarization disabled');
                        // No need to call this.display() here which causes state issues
                    }
                });
            });

        // Create a container for the model settings
        const modelSettingContainer = containerEl.createDiv({ attr: { id: 'model-setting-container' } });
        
        // Add OpenAI model dropdown directly here
        let modelsList = [];
        
        new Setting(modelSettingContainer)
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
                
                // Fetch available models in the background if summarization is enabled
                if (this.plugin.settings.summarizationEnabled && this.plugin.settings.openaiApiKey) {
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
                }
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

        // Last summary time
        const lastSummaryTime = this.plugin.settings.lastSummaryTimestamp 
            ? format(new Date(this.plugin.settings.lastSummaryTimestamp), 'MMM d, yyyy h:mm a')
            : 'Never';

        new Setting(containerEl)
            .setName('Last Summary Run')
            .setDesc(`Last successful summarization: ${lastSummaryTime}`)
            .addButton(button => button
                .setButtonText('Summarize Now')
                .setDisabled(this.plugin.isSummarizing || !this.plugin.settings.summarizationEnabled)
                .onClick(async () => {
                    if (!this.plugin.isSummarizing && this.plugin.settings.summarizationEnabled) {
                        // Start summarization without refreshing the UI
                        this.plugin.summarizationService.summarizeAllNotes(false).then(() => {
                            // Only update the UI after the operation is complete
                            setTimeout(() => {
                                if (this.summarizationStatusEl) {
                                    this.updateStatusDisplay('summarization', this.determineSummarizationStatus());
                                }
                            }, 100);
                        });
                    }
                }));

        // Force summary run (with date picker)
        const summaryStartDateSetting = new Setting(containerEl)
            .setName('Force Summary Run')
            .setDesc('Generate summaries for all notes from the start date')
            .addText(text => {
                text.setValue(this.plugin.settings.summaryStartDate)
                    .setPlaceholder('YYYY-MM-DD')
                    .onChange(async (value) => {
                        // Validate date format
                        if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
                            this.plugin.settings.summaryStartDate = value;
                            await this.plugin.saveSettings();
                        }
                    });

                // Set input type to date
                text.inputEl.type = 'date';
            })
            .addButton(button => button
                .setButtonText('Force Summarize')
                .setDisabled(this.plugin.isSummarizing || !this.plugin.settings.summarizationEnabled)
                .onClick(async () => {
                    if (!this.plugin.isSummarizing && this.plugin.settings.summarizationEnabled) {
                        // Start force summarization without refreshing the UI
                        this.plugin.summarizationService.summarizeAllNotes(true).then(() => {
                            // Only update the UI after the operation is complete
                            setTimeout(() => {
                                if (this.summarizationStatusEl) {
                                    this.updateStatusDisplay('summarization', this.determineSummarizationStatus());
                                }
                            }, 100);
                        });
                    }
                }));
        
        // Add Summarization Status with Cancel button
        const summaryStatusContainer = containerEl.createDiv('setting-item');
        const summaryInfoDiv = summaryStatusContainer.createDiv('setting-item-info');
        const summaryNameDiv = summaryInfoDiv.createDiv('setting-item-name');
        summaryNameDiv.setText('Summarization Status');
        
        // Create status text container under the title
        const summaryStatusTextContainer = summaryInfoDiv.createDiv('setting-item-description');
        this.summarizationStatusEl = summaryStatusTextContainer.createSpan('status-text');
        
        // Set initial status
        const summaryInitialStatus = this.determineSummarizationStatus();
        this.summarizationStatusEl.textContent = summaryInitialStatus;
        this.summarizationStatusEl.style.color = this.plugin.isSummarizing ? 'var(--text-accent)' : 'var(--text-normal)';
        this.summarizationStatusEl.style.fontSize = 'var(--font-smaller)';
        
        // Add cancel button on the right
        const summaryControlDiv = summaryStatusContainer.createDiv('setting-item-control');
        this.summarizeCancelButton = summaryControlDiv.createEl('button', { text: 'Cancel', cls: 'mod-warning' });
        this.summarizeCancelButton.disabled = !this.plugin.isSummarizing;
        this.summarizeCancelButton.addEventListener('click', async () => {
            new Notice('Cancelling summarization operation...');
            await this.plugin.summarizationService.cancelOngoingSummarization();
        });
        
        // Force a proper status update immediately after rendering
        setTimeout(() => {
            this.updateStatusDisplay('summarization', summaryInitialStatus);
        }, 50);
        
        // Register a mutation observer to keep the status indicator up to date
        const summaryObserver = new MutationObserver(() => {
            if (this.summarizationStatusEl) {
                const currentStatus = this.determineSummarizationStatus();
                this.updateStatusDisplay('summarization', currentStatus);
            }
        });
        
        // Observe changes to the status element
        if (this.summarizationStatusEl) {
            summaryObserver.observe(this.summarizationStatusEl, { childList: true });
            this.cleanupFns.push(() => summaryObserver.disconnect());
        }
    }

    /**
     * Add debug settings to the settings tab
     */
    /**
     * Update the status indicators in their respective sections
     * @param statusType The type of status to update ('sync' or 'summarization')
     * @param message The status message to display
     */
    public updateStatusDisplay(statusType: 'sync' | 'summarization', message: string): void {
        console.log(`Status update for ${statusType}: ${message} (isSyncing=${this.plugin.isSyncing}, isSummarizing=${this.plugin.isSummarizing})`);
        
        if (statusType === 'sync') {
            if (!this.syncStatusEl) {
                console.error('Sync status element is missing');
                return;
            }
            
            // Always update the text content
            this.syncStatusEl.textContent = message;
            
            // Determine sync state from both the message and the actual plugin state
            const isSyncing = this.plugin.isSyncing || 
                message.toLowerCase().includes('sync') || 
                message.toLowerCase().includes('fetching');
                
            // Update visual state
            if (isSyncing) {
                this.syncStatusEl.style.color = 'var(--text-accent)';
            } else if (message.toLowerCase().includes('error') || message.toLowerCase().includes('failed')) {
                this.syncStatusEl.style.color = 'var(--text-error)';
            } else {
                this.syncStatusEl.style.color = 'var(--text-normal)';
            }
            
            // Update cancel button if it exists
            if (this.syncCancelButton) {
                this.syncCancelButton.disabled = !isSyncing;
            }
        } else if (statusType === 'summarization') {
            if (!this.summarizationStatusEl) {
                console.error('Summarization status element is missing');
                return;
            }
            
            // Always update the text content
            this.summarizationStatusEl.textContent = message;
            
            // Determine summarization state from both the message and the actual plugin state
            const isSummarizing = this.plugin.isSummarizing || 
                message.toLowerCase().includes('summariz') || 
                message.toLowerCase().includes('starting');
                
            // Update visual state
            if (isSummarizing) {
                this.summarizationStatusEl.style.color = 'var(--text-accent)';
            } else if (message.toLowerCase().includes('error') || message.toLowerCase().includes('failed')) {
                this.summarizationStatusEl.style.color = 'var(--text-error)';
            } else {
                this.summarizationStatusEl.style.color = 'var(--text-normal)';
            }
            
            // Update cancel button if it exists
            if (this.summarizeCancelButton) {
                this.summarizeCancelButton.disabled = !isSummarizing;
            }
        }
    }

    /**
     * Determine the current sync status based on the plugin state
     * @returns The current sync status message
     */
    private determineSyncStatus(): string {
        // First check the actual sync state
        if (this.plugin.isSyncing) {
            // Use existing status if it's set, otherwise default to 'Syncing...'
            if (this.plugin.lastSyncStatus && this.plugin.lastSyncStatus !== 'Idle') {
                return this.plugin.lastSyncStatus;
            }
            return 'Syncing...';
        }
        
        // If the plugin has a stored status, use it
        if (this.plugin.lastSyncStatus && this.plugin.lastSyncStatus !== 'Idle') {
            // Only preserve status messages that indicate action or errors
            if (this.plugin.lastSyncStatus.includes('Sync') || 
                this.plugin.lastSyncStatus.includes('Fetching') || 
                this.plugin.lastSyncStatus.includes('Error') || 
                this.plugin.lastSyncStatus.includes('failed')) {
                return this.plugin.lastSyncStatus;
            }
        }
        
        // If button is active, we're probably syncing
        if (this.syncCancelButton && !this.syncCancelButton.disabled) {
            return 'Syncing...'; 
        }
        
        return 'Idle';
    }
    
    /**
     * Determine the current summarization status based on the plugin state
     * @returns The current summarization status message
     */
    private determineSummarizationStatus(): string {
        // First check the actual summarization state
        if (this.plugin.isSummarizing) {
            // Use existing status if it's set, otherwise default to 'Summarizing...'
            if (this.plugin.lastSummarizationStatus && this.plugin.lastSummarizationStatus !== 'Idle') {
                return this.plugin.lastSummarizationStatus;
            }
            return 'Summarizing...';
        }
        
        // If the plugin has a stored status, use it
        if (this.plugin.lastSummarizationStatus && this.plugin.lastSummarizationStatus !== 'Idle') {
            // Only preserve status messages that indicate action or errors
            if (this.plugin.lastSummarizationStatus.includes('Summariz') || 
                this.plugin.lastSummarizationStatus.includes('Starting') || 
                this.plugin.lastSummarizationStatus.includes('Error') || 
                this.plugin.lastSummarizationStatus.includes('failed')) {
                return this.plugin.lastSummarizationStatus;
            }
        }
        
        // If button is active, we're probably summarizing
        if (this.summarizeCancelButton && !this.summarizeCancelButton.disabled) {
            return 'Summarizing...';
        }
        
        return 'Idle';
    }
}

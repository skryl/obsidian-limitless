export interface LimitlessPluginSettings {
	apiUrl: string;
	apiKey: string;
	outputFolder: string;
	syncIntervalMinutes: number;
	lastSyncTimestamp: string;
	debugMode: boolean;
	forceOverwrite: boolean;
	ascendingOrder: boolean;
	startDate: string;
	useSystemTimezone: boolean;
	summarizationEnabled: boolean;
	openaiApiKey: string;
	openaiModelName: string;
	summaryOutputFolder: string;
	summarizationPrompt: string;
}

export const DEFAULT_SETTINGS: LimitlessPluginSettings = {
	apiUrl: 'https://api.limitless.ai/v1',
	apiKey: '',
	outputFolder: 'Limitless',
	syncIntervalMinutes: 60,
	lastSyncTimestamp: '',
	debugMode: false,
	forceOverwrite: false,
	ascendingOrder: false,
	startDate: new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0],
	useSystemTimezone: true,
	summarizationEnabled: false,
	openaiApiKey: '',
	openaiModelName: 'gpt-4',
	summaryOutputFolder: 'Summaries',
	summarizationPrompt: 'Create a detailed summary of this daily note, highlighting key events, insights, and activities. Format the summary in markdown with clear sections.'
};

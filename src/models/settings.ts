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
	lastSummaryTimestamp: string;
	summaryStartDate: string;
}

export const DEFAULT_SETTINGS: LimitlessPluginSettings = {
	apiUrl: 'https://api.limitless.ai/v1',
	apiKey: '',
	outputFolder: 'Limitless/Logs',
	syncIntervalMinutes: 60,
	lastSyncTimestamp: '',
	debugMode: false,
	forceOverwrite: true,
	ascendingOrder: false,
	startDate: new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0],
	useSystemTimezone: true,
	summarizationEnabled: false,
	openaiApiKey: '',
	openaiModelName: 'gpt-4o-latest',
	summaryOutputFolder: 'Limitless/Summaries',
	summarizationPrompt: 'Create a detailed summary of this daily note, highlighting key events, insights, and activities. Format the summary in markdown with clear sections.',
	lastSummaryTimestamp: '',
	summaryStartDate: new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0]
};

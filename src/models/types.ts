export interface Lifelog {
    id: string;
    timestamp: string;
    text: string;
    type: string;
    metadata?: Record<string, any>;
}

export interface SummarizationState {
    isSummarizing: boolean;
    cancelSummarization: boolean;
    summarizationCurrent: number;
    summarizationTotal: number;
    summarizationProgressText: string;
}

export interface SyncState {
    isSyncing: boolean;
    cancelSync: boolean;
    syncProgress: number;
    syncCurrent: number;
    syncTotal: number;
    syncProgressText: string;
}

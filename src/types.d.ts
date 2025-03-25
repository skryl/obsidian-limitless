// Type definitions for Limitless plugin
declare module 'limitless-types' {
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
    }
    
    export interface SyncState {
        isSyncing: boolean;
        cancelSync: boolean;
    }
}

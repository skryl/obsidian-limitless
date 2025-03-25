import { Plugin } from 'obsidian';
import { LimitlessPluginSettings } from './settings';
import type { SummarizationState, SyncState } from './types';
import { SummarizationService } from '../services/summarization';

/**
 * Interface for the LimitlessPlugin to avoid circular dependencies
 */
export interface ILimitlessPlugin extends Plugin, SyncState, SummarizationState {
    settings: LimitlessPluginSettings;
    summarizationService: SummarizationService;
    
    // Status tracking
    lastSyncStatus: string;
    lastSummarizationStatus: string;
    
    log(...args: any[]): void;
    updateSyncStatus(message: string): void;
    updateSummarizationStatus(message: string): void;
    saveSettings(): Promise<void>;
    testAPIConnection(): Promise<boolean>;
    syncLifelogs(forceFull?: boolean, customStartDate?: string): Promise<void>;
    cancelSyncOperation(): void;
    registerSyncInterval(): void;
}

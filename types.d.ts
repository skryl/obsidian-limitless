// Basic type definitions for Obsidian API
declare module 'obsidian' {
    export class Plugin {
        app: App;
        manifest: PluginManifest;
        
        // Plugin methods
        addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => any): HTMLElement;
        addStatusBarItem(): HTMLElement;
        addCommand(command: Command): void;
        addSettingTab(settingTab: PluginSettingTab): void;
        registerInterval(id: number): void;
        loadData(): Promise<any>;
        saveData(data: any): Promise<void>;
    }
    
    export interface App {
        workspace: Workspace;
        vault: Vault;
    }
    
    export interface Workspace {
        getActiveFile(): TFile | null;
    }
    
    export interface Vault {
        getAbstractFileByPath(path: string): TFile | TFolder | null;
        read(file: TFile): Promise<string>;
        modify(file: TFile, data: string): Promise<void>;
        create(path: string, data: string): Promise<TFile>;
        createFolder(path: string): Promise<TFolder>;
        adapter: {
            exists(path: string): Promise<boolean>;
        };
    }
    
    export class TFile {
        path: string;
    }
    
    export class TFolder {
        path: string;
    }
    
    export interface PluginManifest {
        id: string;
        name: string;
        version: string;
        minAppVersion: string;
        description: string;
        author: string;
        authorUrl: string;
        isDesktopOnly: boolean;
    }
    
    export interface Command {
        id: string;
        name: string;
        callback: () => any;
    }
    
    export class PluginSettingTab {
        app: App;
        plugin: Plugin;
        containerEl: HTMLElement;
        
        constructor(app: App, plugin: Plugin);
        display(): void;
    }
    
    export class Setting {
        constructor(containerEl: HTMLElement);
        setName(name: string): this;
        setDesc(desc: string): this;
        addText(cb: (text: any) => any): this;
        addButton(cb: (button: any) => any): this;
        addSlider(cb: (slider: any) => any): this;
    }
    
    export class Notice {
        constructor(message: string, timeout?: number);
    }
    
    export function normalizePath(path: string): string;
    
    export interface RequestUrlParam {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        contentType?: string;
        body?: string | ArrayBuffer;
    }
    
    export interface RequestUrlResponse {
        status: number;
        headers: Record<string, string>;
        arrayBuffer: ArrayBuffer;
        json: any;
        text: string;
    }
    
    export function requestUrl(params: RequestUrlParam): Promise<RequestUrlResponse>;
}

// Type definitions for date-fns
declare module 'date-fns' {
    export function format(date: Date, formatStr: string): string;
}

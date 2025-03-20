import { App, TFile, TFolder, normalizePath } from 'obsidian';
import { format } from 'date-fns';
import type { Lifelog } from 'limitless-types';
import { ILimitlessPlugin } from '../models/plugin-interface';

export class FileUtils {
    private plugin: ILimitlessPlugin;
    
    constructor(plugin: ILimitlessPlugin) {
        this.plugin = plugin;
    }

    /**
     * Ensure output folder exists
     */
    async ensureOutputFolder(): Promise<TFolder> {
        const folderPath = normalizePath(this.plugin.settings.outputFolder);
        
        // Try to get the folder
        let folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);
        
        if (!folder) {
            // Create the folder if it doesn't exist
            this.plugin.log(`Creating output folder: ${folderPath}`);
            folder = await this.plugin.app.vault.createFolder(folderPath);
        } else if (!(folder instanceof TFolder)) {
            throw new Error(`${folderPath} exists but is not a folder`);
        }
        
        return folder as TFolder;
    }

    /**
     * Write lifelogs to a daily note
     */
    async writeLifelogsToNote(date: string, lifelogs: Lifelog[]): Promise<void> {
        if (lifelogs.length === 0) {
            this.plugin.log(`No lifelogs to write for ${date}`);
            return;
        }
        
        try {
            // Ensure the output folder exists
            await this.ensureOutputFolder();
            
            // Format the date for the filename - YYYY-MM-DD.md
            const fileName = `${date}.md`;
            const filePath = normalizePath(`${this.plugin.settings.outputFolder}/${fileName}`);
            
            // Format the lifelogs
            let content = '';
            
            // Sort lifelogs by timestamp (ascending or descending based on settings)
            const sortedLogs = [...lifelogs].sort((a, b) => {
                const aTime = new Date(a.timestamp).getTime();
                const bTime = new Date(b.timestamp).getTime();
                return this.plugin.settings.ascendingOrder ? aTime - bTime : bTime - aTime;
            });
            
            // Format each lifelog as markdown
            for (const log of sortedLogs) {
                // Format the timestamp as a time string (e.g., "9:30 AM")
                const timestamp = new Date(log.timestamp);
                const timeString = format(timestamp, 'h:mm a');
                
                // Add the formatted lifelog to the content
                content += `- **${timeString}** ${log.text}\\n`;
                
                // Add metadata if available and in debug mode
                if (this.plugin.settings.debugMode && log.metadata) {
                    content += `  - Type: ${log.type}\\n`;
                    content += `  - ID: ${log.id}\\n`;
                    
                    // Add other metadata
                    for (const [key, value] of Object.entries(log.metadata)) {
                        if (key !== 'id' && key !== 'type') {
                            content += `  - ${key}: ${value}\\n`;
                        }
                    }
                }
            }
            
            // Get the full file content or create new content
            let fileContent = '';
            const existingFile = this.plugin.app.vault.getAbstractFileByPath(filePath);
            
            if (existingFile instanceof TFile) {
                // If file exists, read its content
                fileContent = await this.plugin.app.vault.read(existingFile);
                
                // Check if content already contains the lifelogs
                if (fileContent.includes(content)) {
                    this.plugin.log(`Lifelogs already exist in ${filePath}, skipping`);
                    return;
                }
                
                // If force overwrite, replace the file content
                if (this.plugin.settings.forceOverwrite) {
                    fileContent = this.formatDailyNote(date, content);
                    await this.plugin.app.vault.modify(existingFile, fileContent);
                    this.plugin.log(`Overwrote lifelogs in ${filePath}`);
                } else {
                    // Otherwise, append if the content doesn't already contain it
                    if (!fileContent.includes('## Lifelogs')) {
                        fileContent += `\\n\\n## Lifelogs\\n${content}`;
                    } else {
                        // Replace the Lifelogs section
                        const beforeLifelogs = fileContent.split('## Lifelogs')[0];
                        fileContent = `${beforeLifelogs}## Lifelogs\\n${content}`;
                    }
                    await this.plugin.app.vault.modify(existingFile, fileContent);
                    this.plugin.log(`Updated lifelogs in ${filePath}`);
                }
            } else {
                // Create new file with the lifelogs
                fileContent = this.formatDailyNote(date, content);
                await this.plugin.app.vault.create(filePath, fileContent);
                this.plugin.log(`Created new daily note with lifelogs: ${filePath}`);
            }
        } catch (error) {
            this.plugin.log(`Error writing lifelogs for ${date}:`, error);
            throw error;
        }
    }

    /**
     * Format a daily note with the given content
     */
    private formatDailyNote(date: string, lifelogsContent: string): string {
        // Format the date for the title
        const dateObj = new Date(date);
        const formattedDate = format(dateObj, 'EEEE, MMMM d, yyyy');
        
        // Create the note content
        return `# ${formattedDate}\\n\\n## Notes\\n\\n## Lifelogs\\n${lifelogsContent}`;
    }
}

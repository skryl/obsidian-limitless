# Limitless for Obsidian

This plugin integrates Obsidian with the Limitless API to create daily notes from your lifelogs. It automatically syncs with the Limitless API at regular intervals and creates or appends to daily notes based on the timestamp of each lifelog entry.

## Features

- **Automatic Syncing**: Syncs with the Limitless API at configurable intervals
- **Daily Notes Integration**: Creates or updates daily notes with your lifelog content
- **Smart Syncing**: Remembers the last sync timestamp to only fetch new entries
- **Non-destructive Updates**: Appends new items to existing notes without overwriting your changes
- **Manual Control**: Provides sync options via ribbon icon and command palette
- **Flexible Configuration**: Customizable API URL, API key, output folder, and sync interval

## Installation

### From Obsidian Community Plugins
1. In Obsidian, go to Settings > Community plugins
2. Turn off Safe mode
3. Click "Browse" and search for "Limitless"
4. Install the plugin and enable it

### Manual Installation
1. Download the latest release from the GitHub releases page
2. Extract the zip file into your Obsidian vault's `.obsidian/plugins/` folder
3. Restart Obsidian
4. Go to Settings > Community plugins and enable "Limitless"

## Setup

1. After installation, go to Settings > Community plugins
2. Make sure Limitless is enabled
3. Click the gear icon next to Limitless to open its settings
4. Enter your Limitless API URL and API key
5. Set the output folder where daily notes will be created
6. Configure the sync interval (in minutes)
7. Your settings will be automatically saved

## Usage

### Automatic Syncing
Once configured, the plugin will automatically sync with the Limitless API at the interval you specified. New lifelog entries will be fetched and added to the appropriate daily notes.

### Manual Syncing
You can manually trigger a sync in two ways:
- Click the sync icon in the ribbon (sidebar)
- Use the command palette (Ctrl/Cmd+P) and search for "Limitless: Sync Lifelogs"

### Daily Notes Format
Each lifelog entry will be added to a daily note with the format `YYYY-MM-DD.md` in your specified output folder. Entries are organized chronologically and formatted as markdown content.

## Troubleshooting

- **No data appearing**: Verify your API key and URL are correct in the settings
- **Sync errors**: Check your internet connection and Limitless API status
- **Missing notes**: Ensure the output folder exists and Obsidian has permission to write to it

## Privacy

This plugin only communicates with the Limitless API using the credentials you provide. Your data is not sent anywhere else, and all processing happens locally within Obsidian.

## Support

If you encounter any issues or have feature requests, please submit them on the [GitHub repository](https://github.com/yourusername/obsidian-limitless).


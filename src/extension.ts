import * as vscode from 'vscode';
import sqlite3 from 'sqlite3';
import * as path from 'path';
import { createDirectory, createDatabase, getTodayActivityBreakdown, getRecentHeartbeats } from './storage';
import { setupFileWatcher } from './watchers/fileWatcher';
import { setupCursorWatcher } from './watchers/cursorWatcher';
import { HeartbeatAggregator } from './aggregators/heartbeatAggregator';
import { SessionsPanelProvider } from './panels/sessionsPanel';

function formatDuration(ms: number): string {
    const totalMinutes = Math.floor(ms / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}

let dbInstance: sqlite3.Database | null = null;
let aggregator: HeartbeatAggregator | null = null;
let sessionsPanel: SessionsPanelProvider | null = null;

export async function activate(context: vscode.ExtensionContext) {
    console.log('EXTENSION: "ntna-time" is now active!');
    const dbPath = context.globalStorageUri.fsPath;
    createDirectory(dbPath);

    dbInstance = await createDatabase(dbPath);
    
    const outputChannel = vscode.window.createOutputChannel('ntna-time');
    context.subscriptions.push(outputChannel);

    aggregator = new HeartbeatAggregator(dbInstance, outputChannel);
    
    const fileWatcher = setupFileWatcher(context);
    const cursorWatcher = setupCursorWatcher(context, outputChannel);

    fileWatcher.on('activity', (event) => aggregator!.push(event));
    cursorWatcher.on('activity', (event) => aggregator!.push(event));

    aggregator.start();
    
    context.subscriptions.push({
        dispose: () => {
            if (aggregator) {
                aggregator.dispose();
            }
        }
    });

    sessionsPanel = new SessionsPanelProvider(dbInstance);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            SessionsPanelProvider.viewType,
            sessionsPanel,
            {
                webviewOptions: {
                    retainContextWhenHidden: true
                }
            }
        )
    );
    
    sessionsPanel.preload();
    
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = "$(clock) 0m";
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    async function updateStatusBar() {
        try {
            const breakdown = await getTodayActivityBreakdown(dbInstance!);
            const parts: string[] = [];
            
            if (breakdown.coding > 0) {
                parts.push(`${formatDuration(breakdown.coding)} coding`);
            }
            if (breakdown.planning > 0) {
                parts.push(`${formatDuration(breakdown.planning)} planning`);
            }
            
            if (parts.length > 0) {
                statusBarItem.text = `$(clock) ${parts.join(' | ')}`;
                statusBarItem.tooltip = `Today: ${formatDuration(breakdown.total)} total\nCoding: ${formatDuration(breakdown.coding)}\nPlanning: ${formatDuration(breakdown.planning)}`;
            } else {
                statusBarItem.text = "$(clock) 0m";
                statusBarItem.tooltip = "No activity tracked today";
            }
        } catch (err) {
            console.error('Failed to update status bar:', err);
        }
    }

    updateStatusBar();

    aggregator.onHeartbeat(() => {
        sessionsPanel!.invalidateToday();
        updateStatusBar();
    });

    const showHeartbeatsCommand = vscode.commands.registerCommand('ntna-time.showHeartbeats', async () => {
        if (!dbInstance) {
            vscode.window.showErrorMessage('Database not initialized');
            return;
        }

        try {
            const heartbeats = await getRecentHeartbeats(dbInstance, 50);
            
            outputChannel.show(true);
            outputChannel.appendLine('\n=== Recent Heartbeats (Last 50) ===');
            outputChannel.appendLine('');

            if (heartbeats.length === 0) {
                outputChannel.appendLine('No heartbeats found.');
                return;
            }

            const now = Date.now();
            for (const hb of heartbeats) {
                const timeAgo = now - hb.timestamp;
                const minutesAgo = Math.floor(timeAgo / 60000);
                const hoursAgo = Math.floor(minutesAgo / 60);
                
                let timeLabel = '';
                if (hoursAgo > 0) {
                    timeLabel = `${hoursAgo}h ${minutesAgo % 60}m ago`;
                } else if (minutesAgo > 0) {
                    timeLabel = `${minutesAgo}m ago`;
                } else {
                    timeLabel = 'just now';
                }

                const date = new Date(hb.timestamp);
                const timeStr = date.toLocaleTimeString();
                const dateStr = date.toLocaleDateString();
                
                const entityName = hb.type === 'agent' ? 'agent chat' : path.basename(hb.entity);
                const activityLabel = hb.has_file_activity && hb.has_agent_activity 
                    ? 'coding+agent' 
                    : hb.activity_type;
                
                const languageStr = (hb.language || 'unknown').padEnd(10);
                const projectStr = (hb.project || 'no project').padEnd(20);
                
                outputChannel.appendLine(`[${dateStr} ${timeStr}] ${timeLabel.padEnd(12)} | ${entityName.padEnd(30)} | ${languageStr} | ${projectStr} | ${activityLabel}`);
                outputChannel.appendLine(`  └─ Entity: ${hb.entity}`);
                if (hb.type === 'agent' && hb.source_file) {
                    outputChannel.appendLine(`  └─ Source file: ${hb.source_file}`);
                }
                if (hb.type === 'file') {
                    outputChannel.appendLine(`  └─ Write: ${hb.is_write ? 'yes' : 'no'}`);
                }
                outputChannel.appendLine('');
            }
            
            outputChannel.appendLine('=== End of Heartbeats ===\n');
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to fetch heartbeats: ${err}`);
            outputChannel.appendLine(`Error: ${err}`);
        }
    });

    context.subscriptions.push(showHeartbeatsCommand);
}

export async function deactivate() {
    if (sessionsPanel) {
        await sessionsPanel.dispose();
    }
    if (aggregator) {
        aggregator.dispose();
    }
    if (dbInstance) {
        dbInstance.close();
    }
}

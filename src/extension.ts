import * as vscode from 'vscode';
import sqlite3 from 'sqlite3';
import { createDirectory, createDatabase, getTodayActivityBreakdown } from './storage';
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

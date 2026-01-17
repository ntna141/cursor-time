import * as vscode from 'vscode';
import sqlite3 from 'sqlite3';
import { createDirectory, createDatabase } from './storage';
import { setupFileWatcher } from './watchers/fileWatcher';
import { setupCursorWatcher } from './watchers/cursorWatcher';
import { HeartbeatAggregator } from './aggregators/heartbeatAggregator';
import { SessionsPanelProvider } from './panels/sessionsPanel';

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
    
    aggregator.onHeartbeat(() => {
        sessionsPanel!.invalidateToday();
    });
    
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = "$(clock) ntna-time";
    statusBarItem.tooltip = "EXTENSION: ntna-time is active";
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
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

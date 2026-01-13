import * as vscode from 'vscode';
import sqlite3 from 'sqlite3';
import { createDirectory, createDatabase, getRecentHeartbeats } from './storage';
import { setupFileWatcher } from './fileWatcher';

let dbInstance: sqlite3.Database | null = null;

export async function activate(context: vscode.ExtensionContext) {
    console.log('Extension "ntna-time" is now active!');
    const dbPath = context.globalStorageUri.fsPath;
    createDirectory(dbPath);

    dbInstance = await createDatabase(dbPath);
    
    setupFileWatcher(context, dbInstance);
    
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = "$(clock) ntna-time";
    statusBarItem.tooltip = "ntna-time extension is active";
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    
    const showHeartbeatsCommand = vscode.commands.registerCommand('ntna-time.showHeartbeats', async () => {
        if (!dbInstance) {
            vscode.window.showErrorMessage('Database not initialized');
            return;
        }
        
        const heartbeats = await getRecentHeartbeats(dbInstance, 20);
        
        if (heartbeats.length === 0) {
            vscode.window.showInformationMessage('No heartbeats recorded yet. Try creating or modifying a file!');
            return;
        }
        
        const output = heartbeats.map((h, i) => {
            const time = new Date(h.timestamp).toLocaleTimeString();
            const action = h.is_write ? 'modified' : 'created/deleted';
            const file = h.entity.split('/').pop() || h.entity;
            return `${i + 1}. [${time}] ${action} ${file} (${h.language || 'unknown'})`;
        }).join('\n');
        
        const outputChannel = vscode.window.createOutputChannel('ntna-time');
        outputChannel.clear();
        outputChannel.appendLine(`Recent Heartbeats (${heartbeats.length}):\n`);
        outputChannel.appendLine(output);
        outputChannel.show();
    });
    
    context.subscriptions.push(showHeartbeatsCommand);
    
    vscode.window.showInformationMessage('ntna-time extension is now active!');
}

export function deactivate() {
    if (dbInstance) {
        dbInstance.close();
    }
}

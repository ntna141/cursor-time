import * as vscode from 'vscode';
import sqlite3 from 'sqlite3';
import { createDirectory, createDatabase } from './storage';
import { setupFileWatcher } from './fileWatcher';

let dbInstance: sqlite3.Database | null = null;

export async function activate(context: vscode.ExtensionContext) {
    console.log('EXTENSION: "ntna-time" is now active!');
    const dbPath = context.globalStorageUri.fsPath;
    createDirectory(dbPath);

    dbInstance = await createDatabase(dbPath);
    
    const outputChannel = vscode.window.createOutputChannel('ntna-time');
    context.subscriptions.push(outputChannel);
    
    setupFileWatcher(context, dbInstance, outputChannel);
    
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = "$(clock) ntna-time";
    statusBarItem.tooltip = "EXTENSION: ntna-time is active";
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    
    vscode.window.showInformationMessage('EXTENSION: ntna-time is now active!');
}

export function deactivate() {
    if (dbInstance) {
        dbInstance.close();
    }
}

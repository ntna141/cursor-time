import * as vscode from 'vscode';
import * as path from 'path';
import sqlite3 from 'sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { insertHeartbeat, Heartbeat } from './storage';

export function setupFileWatcher(
    context: vscode.ExtensionContext,
    db: sqlite3.Database
): vscode.Disposable {
    const watcher = vscode.workspace.createFileSystemWatcher(
        '**/*',
        false,
        false,
        false
    );

    watcher.onDidCreate((uri) => {
        recordHeartbeat(db, uri, 'file', false);
    });

    watcher.onDidChange((uri) => {
        recordHeartbeat(db, uri, 'file', true);
    });

    watcher.onDidDelete((uri) => {
        recordHeartbeat(db, uri, 'file', false);
    });

    context.subscriptions.push(watcher);
    
    return watcher;
}

function recordHeartbeat(
    db: sqlite3.Database,
    uri: vscode.Uri,
    type: string,
    isWrite: boolean
) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    const filePath = uri.fsPath;
    const ext = path.extname(filePath).slice(1);
    
    const heartbeat: Heartbeat = {
        id: uuidv4(),
        timestamp: Date.now(),
        created_at: new Date().toISOString(),
        entity: filePath,
        type: type,
        category: getCategoryFromExtension(ext),
        is_write: isWrite,
        project: workspaceFolder?.name,
        language: ext || undefined,
    };

    insertHeartbeat(db, heartbeat);
    console.log(`[ntna-time] Heartbeat recorded: ${isWrite ? 'modified' : 'created/deleted'} ${path.basename(filePath)}`);
}

function getCategoryFromExtension(ext: string): string {
    const categories: { [key: string]: string } = {
        'ts': 'coding',
        'tsx': 'coding',
        'js': 'coding',
        'jsx': 'coding',
        'py': 'coding',
        'java': 'coding',
        'cpp': 'coding',
        'c': 'coding',
        'h': 'coding',
        'cs': 'coding',
        'go': 'coding',
        'rs': 'coding',
        'swift': 'coding',
        'kt': 'coding',
        'rb': 'coding',
        'php': 'coding',
        'html': 'coding',
        'css': 'coding',
        'scss': 'coding',
        'json': 'coding',
        'xml': 'coding',
        'yaml': 'coding',
        'yml': 'coding',
        'md': 'writing',
        'txt': 'writing',
        'doc': 'writing',
        'docx': 'writing',
        'pdf': 'writing',
    };

    return categories[ext.toLowerCase()] || 'other';
}

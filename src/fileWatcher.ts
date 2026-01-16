import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import sqlite3 from 'sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { insertHeartbeat, Heartbeat } from './storage';
import { extensionCategories } from './extensionCategories';

let lastHeartbeatTime = 0;
const MIN_HEARTBEAT_GAP = 3 * 1000;
let outputChannel: vscode.OutputChannel;
let dbInstance: sqlite3.Database;

interface HeartbeatParams {
    entity: string;
    type: string;
    category: string;
    isWrite: boolean;
    project?: string;
    language?: string;
}

function createHeartbeat(params: HeartbeatParams): boolean {
    const now = Date.now();
    const timeSinceLast = now - lastHeartbeatTime;
    
    if (timeSinceLast < MIN_HEARTBEAT_GAP) {
        return false;
    }
    
    lastHeartbeatTime = now;
    
    const heartbeat: Heartbeat = {
        id: uuidv4(),
        timestamp: now,
        created_at: new Date().toISOString(),
        entity: params.entity,
        type: params.type,
        category: params.category,
        is_write: params.isWrite,
        project: params.project,
        language: params.language,
    };

    insertHeartbeat(dbInstance, heartbeat);
    
    const time = new Date(heartbeat.timestamp).toLocaleTimeString();
    const displayName = params.type === 'agent' ? 'agent chat' : path.basename(params.entity);
    const language = params.language || 'unknown';
    const project = params.project || 'no project';
    
    outputChannel.appendLine(`[${time}] ${displayName} | ${language} | ${project}`);
    
    return true;
}

let cursorWatchers: fs.FSWatcher[] = [];

export function setupFileWatcher(
    context: vscode.ExtensionContext,
    db: sqlite3.Database,
    output: vscode.OutputChannel
): vscode.Disposable {
    outputChannel = output;
    dbInstance = db;
    
    const watcher = vscode.workspace.createFileSystemWatcher(
        '**/*',
        false,
        false,
        false
    );

    watcher.onDidCreate((uri) => {
        if (vscode.window.state.focused && !shouldIgnoreFile(uri)) {
            recordFileHeartbeat(uri, false);
        }
    });

    watcher.onDidChange((uri) => {
        if (vscode.window.state.focused && !shouldIgnoreFile(uri)) {
            recordFileHeartbeat(uri, true);
        }
    });

    watcher.onDidDelete((uri) => {
        if (vscode.window.state.focused && !shouldIgnoreFile(uri)) {
            recordFileHeartbeat(uri, false);
        }
    });

    const textChangeListener = vscode.workspace.onDidChangeTextDocument(() => {
        if (vscode.window.activeTextEditor && vscode.window.state.focused) {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                recordFileHeartbeat(editor.document.uri, true);
            }
        }
    });

    setupCursorWatcher();

    context.subscriptions.push(watcher, textChangeListener, {
        dispose: () => {
            cursorWatchers.forEach(w => w.close());
            cursorWatchers = [];
        }
    });
    
    return watcher;
}

function setupCursorWatcher() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        outputChannel.appendLine('[cursor-watcher] No workspace folders found');
        return;
    }

    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    
    for (const folder of workspaceFolders) {
        const workspacePath = folder.uri.fsPath;
        const projectName = workspacePath.replace(/\//g, '-').replace(/^-/, '');
        const cursorProjectPath = path.join(homeDir, '.cursor', 'projects', projectName);
        
        outputChannel.appendLine(`[cursor-watcher] Checking: ${cursorProjectPath}`);
        if (fs.existsSync(cursorProjectPath)) {
            outputChannel.appendLine(`[cursor-watcher] Watching: ${cursorProjectPath}`);
            watchDirectoryRecursive(cursorProjectPath);
        } else {
            outputChannel.appendLine(`[cursor-watcher] Not found: ${cursorProjectPath}`);
        }
        
        const workspaceCursorPath = path.join(workspacePath, '.cursor');
        if (fs.existsSync(workspaceCursorPath)) {
            outputChannel.appendLine(`[cursor-watcher] Also watching workspace: ${workspaceCursorPath}`);
            watchDirectoryRecursive(workspaceCursorPath);
        }
    }
}

function watchDirectoryRecursive(dirPath: string) {
    if (!fs.existsSync(dirPath)) return;

    try {
        const watcher = fs.watch(dirPath, { recursive: true }, (eventType, filename) => {
            outputChannel.appendLine(`[cursor-watcher] Event: ${eventType} - ${filename}`);
            recordAgentHeartbeat();
        });
        cursorWatchers.push(watcher);
    } catch {
        try {
            const watcher = fs.watch(dirPath, (eventType, filename) => {
                outputChannel.appendLine(`[cursor-watcher] Event: ${eventType} - ${filename}`);
                recordAgentHeartbeat();
            });
            cursorWatchers.push(watcher);
            
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    watchDirectoryRecursive(path.join(dirPath, entry.name));
                }
            }
        } catch {
        }
    }
}

function recordFileHeartbeat(uri: vscode.Uri, isWrite: boolean) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    const filePath = uri.fsPath;
    const ext = path.extname(filePath).slice(1);
    
    createHeartbeat({
        entity: filePath,
        type: 'file',
        category: getCategoryFromExtension(ext),
        isWrite: isWrite,
        project: workspaceFolder?.name,
        language: ext || undefined,
    });
}

function recordAgentHeartbeat() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    
    createHeartbeat({
        entity: 'cursor-agent-chat',
        type: 'agent',
        category: 'coding',
        isWrite: true,
        project: workspaceFolder?.name,
        language: 'agent',
    });
}

function shouldIgnoreFile(uri: vscode.Uri): boolean {
    const filePath = uri.fsPath;
    const fileName = path.basename(filePath);
    
    if (filePath.includes('.cursor')) {
        return true;
    }
    
    if (filePath.includes('.git')) {
        return true;
    }
    
    if (filePath.includes('node_modules')) {
        return true;
    }
    
    const ignoreExtensions = ['.lock', '.tmp', '.temp', '.swp', '.swo'];
    const ext = path.extname(fileName);
    if (ignoreExtensions.includes(ext)) {
        return true;
    }
    
    const ignoreNames = ['FETCH_HEAD', 'HEAD.lock', 'index.lock', '.DS_Store'];
    if (ignoreNames.includes(fileName)) {
        return true;
    }
    
    return false;
}

function getCategoryFromExtension(ext: string): string {
    return extensionCategories[ext.toLowerCase()] || 'other';
}

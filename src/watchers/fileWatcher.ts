import * as vscode from 'vscode';
import * as path from 'path';
import { EventEmitter } from 'events';
import { ActivityEvent, ActivityEmitter } from '../types';
import { extensionCategories } from '../utils/extensionCategories';

export function setupFileWatcher(
    context: vscode.ExtensionContext
): ActivityEmitter {
    const emitter = new EventEmitter() as ActivityEmitter;

    const watcher = vscode.workspace.createFileSystemWatcher(
        '**/*',
        false,
        false,
        false
    );

    watcher.onDidCreate((uri) => {
        if (vscode.window.state.focused && !shouldIgnoreFile(uri)) {
            emitFileEvent(emitter, uri, false);
        }
    });

    watcher.onDidChange((uri) => {
        if (vscode.window.state.focused && !shouldIgnoreFile(uri)) {
            emitFileEvent(emitter, uri, true);
        }
    });

    watcher.onDidDelete((uri) => {
        if (vscode.window.state.focused && !shouldIgnoreFile(uri)) {
            emitFileEvent(emitter, uri, false);
        }
    });

    context.subscriptions.push(watcher);

    return emitter;
}

function emitFileEvent(emitter: ActivityEmitter, uri: vscode.Uri, isWrite: boolean) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    const filePath = uri.fsPath;
    const ext = path.extname(filePath).slice(1);

    const event: ActivityEvent = {
        source: 'file',
        timestamp: Date.now(),
        entity: filePath,
        isWrite: isWrite,
        project: workspaceFolder?.name,
        language: ext || undefined,
        category: getCategoryFromExtension(ext)
    };

    emitter.emit('activity', event);
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

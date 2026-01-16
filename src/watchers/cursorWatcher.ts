import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { ActivityEvent, ActivityEmitter } from '../types';

export function setupCursorWatcher(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel
): ActivityEmitter {
    const emitter = new EventEmitter() as ActivityEmitter;
    const watchers: fs.FSWatcher[] = [];

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        outputChannel.appendLine('[cursor-watcher] No workspace folders found');
        return emitter;
    }

    const homeDir = process.env.HOME || process.env.USERPROFILE || '';

    for (const folder of workspaceFolders) {
        const workspacePath = folder.uri.fsPath;
        const projectName = workspacePath.replace(/\//g, '-').replace(/^-/, '');
        const cursorProjectPath = path.join(homeDir, '.cursor', 'projects', projectName);

        outputChannel.appendLine(`[cursor-watcher] Checking: ${cursorProjectPath}`);
        if (fs.existsSync(cursorProjectPath)) {
            outputChannel.appendLine(`[cursor-watcher] Watching: ${cursorProjectPath}`);
            watchDirectoryRecursive(cursorProjectPath, watchers, emitter, folder.name, outputChannel);
        } else {
            outputChannel.appendLine(`[cursor-watcher] Not found: ${cursorProjectPath}`);
        }

        const workspaceCursorPath = path.join(workspacePath, '.cursor');
        if (fs.existsSync(workspaceCursorPath)) {
            outputChannel.appendLine(`[cursor-watcher] Also watching workspace: ${workspaceCursorPath}`);
            watchDirectoryRecursive(workspaceCursorPath, watchers, emitter, folder.name, outputChannel);
        }
    }

    context.subscriptions.push({
        dispose: () => {
            watchers.forEach(w => w.close());
        }
    });

    return emitter;
}

function watchDirectoryRecursive(
    dirPath: string,
    watchers: fs.FSWatcher[],
    emitter: ActivityEmitter,
    projectName: string,
    outputChannel: vscode.OutputChannel
) {
    if (!fs.existsSync(dirPath)) return;

    try {
        const watcher = fs.watch(dirPath, { recursive: true }, (eventType, filename) => {
            outputChannel.appendLine(`[cursor-watcher] Event: ${eventType} - ${filename}`);
            
            const event: ActivityEvent = {
                source: 'agent',
                timestamp: Date.now(),
                entity: 'cursor-agent-chat',
                isWrite: true,
                project: projectName,
                language: 'agent',
                category: 'coding'
            };
            
            emitter.emit('activity', event);
        });
        watchers.push(watcher);
    } catch {
        try {
            const watcher = fs.watch(dirPath, (eventType, filename) => {
                outputChannel.appendLine(`[cursor-watcher] Event: ${eventType} - ${filename}`);
                
                const event: ActivityEvent = {
                    source: 'agent',
                    timestamp: Date.now(),
                    entity: 'cursor-agent-chat',
                    isWrite: true,
                    project: projectName,
                    language: 'agent',
                    category: 'coding'
                };
                
                emitter.emit('activity', event);
            });
            watchers.push(watcher);

            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    watchDirectoryRecursive(path.join(dirPath, entry.name), watchers, emitter, projectName, outputChannel);
                }
            }
        } catch {
        }
    }
}

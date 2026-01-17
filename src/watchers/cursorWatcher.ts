import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { ActivityEvent, ActivityEmitter } from '../types';

const AGENT_ACTIVITY_FOLDERS = ['agent-transcripts', 'agent-tools'];

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
            for (const folderName of AGENT_ACTIVITY_FOLDERS) {
                const activityPath = path.join(cursorProjectPath, folderName);
                if (fs.existsSync(activityPath)) {
                    outputChannel.appendLine(`[cursor-watcher] Watching: ${activityPath}`);
                    watchAgentFolder(activityPath, watchers, emitter, folder.name, outputChannel);
                }
            }
        } else {
            outputChannel.appendLine(`[cursor-watcher] Not found: ${cursorProjectPath}`);
        }
    }

    context.subscriptions.push({
        dispose: () => {
            watchers.forEach(w => w.close());
        }
    });

    return emitter;
}

function watchAgentFolder(
    dirPath: string,
    watchers: fs.FSWatcher[],
    emitter: ActivityEmitter,
    projectName: string,
    outputChannel: vscode.OutputChannel
) {
    try {
        const watcher = fs.watch(dirPath, (eventType, filename) => {
            if (!vscode.window.state.focused) {
                return;
            }
            
            if (!filename || !filename.endsWith('.txt')) {
                return;
            }
            
            outputChannel.appendLine(`[cursor-watcher] Agent activity: ${eventType} - ${filename}`);
            
            const sourceFilePath = path.join(dirPath, filename);
            
            const event: ActivityEvent = {
                source: 'agent',
                timestamp: Date.now(),
                entity: 'cursor-agent-chat',
                isWrite: true,
                project: projectName,
                language: 'agent',
                category: 'coding',
                sourceFile: sourceFilePath
            };
            
            emitter.emit('activity', event);
        });
        watchers.push(watcher);
    } catch (err) {
        outputChannel.appendLine(`[cursor-watcher] Failed to watch: ${dirPath}`);
    }
}

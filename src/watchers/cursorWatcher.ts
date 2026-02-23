import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { ActivityEvent, ActivityEmitter } from '../types';

const AGENT_ACTIVITY_FOLDERS = ['agent-transcripts', 'agent-tools'];
const AGENT_ACTIVITY_EXCLUDED_PATH_SEGMENTS = ['terminals'];

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

    const plansPath = path.join(homeDir, '.cursor', 'plans');
    if (fs.existsSync(plansPath)) {
        outputChannel.appendLine(`[cursor-watcher] Watching plans folder: ${plansPath}`);
        watchPlansFolder(plansPath, watchers, emitter, outputChannel);
    } else {
        outputChannel.appendLine(`[cursor-watcher] Plans folder not found: ${plansPath}`);
    }

    for (const folder of workspaceFolders) {
        const workspacePath = folder.uri.fsPath;
        const projectName = workspacePath.replace(/\//g, '-').replace(/^-/, '');
        const cursorProjectPath = path.join(homeDir, '.cursor', 'projects', projectName);

        outputChannel.appendLine(`[cursor-watcher] Checking: ${cursorProjectPath}`);
        
        if (fs.existsSync(cursorProjectPath)) {
            for (const folderName of getActivityFolders(cursorProjectPath)) {
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

function watchPlansFolder(
    dirPath: string,
    watchers: fs.FSWatcher[],
    emitter: ActivityEmitter,
    outputChannel: vscode.OutputChannel
) {
    try {
        const watcher = fs.watch(dirPath, (eventType, filename) => {
            if (!vscode.window.state.focused) {
                return;
            }
            
            if (!filename || !filename.endsWith('.plan.md')) {
                return;
            }
            
            outputChannel.appendLine(`[cursor-watcher] Plan activity: ${eventType} - ${filename}`);
            
            const sourceFilePath = path.join(dirPath, filename);
            
            const event: ActivityEvent = {
                source: 'agent',
                timestamp: Date.now(),
                entity: 'cursor-plan',
                isWrite: true,
                language: 'markdown',
                category: 'planning',
                sourceFile: sourceFilePath
            };
            
            emitter.emit('activity', event);
        });
        watchers.push(watcher);
    } catch (err) {
        outputChannel.appendLine(`[cursor-watcher] Failed to watch plans folder: ${dirPath}`);
    }
}

function watchAgentFolder(
    dirPath: string,
    watchers: fs.FSWatcher[],
    emitter: ActivityEmitter,
    projectName: string,
    outputChannel: vscode.OutputChannel
) {
    try {
        const watcher = fs.watch(dirPath, { recursive: true }, (eventType, filename) => {
            handleAgentActivity(dirPath, eventType, filename, emitter, projectName, outputChannel);
        });
        watchers.push(watcher);
    } catch (err) {
        try {
            const fallbackWatcher = fs.watch(dirPath, (eventType, filename) => {
                handleAgentActivity(dirPath, eventType, filename, emitter, projectName, outputChannel);
            });
            watchers.push(fallbackWatcher);
        } catch (fallbackErr) {
            outputChannel.appendLine(`[cursor-watcher] Failed to watch: ${dirPath}`);
        }
    }
}

function getActivityFolders(cursorProjectPath: string): string[] {
    const result = new Set<string>();
    for (const folderName of AGENT_ACTIVITY_FOLDERS) {
        result.add(folderName);
    }

    try {
        const entries = fs.readdirSync(cursorProjectPath, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }

            if (entry.name.includes('agent')) {
                result.add(entry.name);
            }
        }
    } catch (err) {
        return Array.from(result);
    }

    return Array.from(result);
}

function shouldEmitAgentFile(dirPath: string, filename: string): boolean {
    const sourceFilePath = path.join(dirPath, filename);

    try {
        const stat = fs.statSync(sourceFilePath);
        return stat.isFile();
    } catch (err) {
        return path.extname(filename).length > 0;
    }
}

function handleAgentActivity(
    dirPath: string,
    eventType: string,
    filename: string | Buffer | null,
    emitter: ActivityEmitter,
    projectName: string,
    outputChannel: vscode.OutputChannel
) {
    if (!vscode.window.state.focused) {
        return;
    }

    const normalizedFilename = typeof filename === 'string' ? filename : filename?.toString();
    if (!normalizedFilename || !shouldEmitAgentFile(dirPath, normalizedFilename)) {
        return;
    }

    outputChannel.appendLine(`[cursor-watcher] Agent activity: ${eventType} - ${normalizedFilename}`);

    const sourceFilePath = path.join(dirPath, normalizedFilename);
    if (isExcludedAgentActivityPath(sourceFilePath)) {
        return;
    }

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
}

function isExcludedAgentActivityPath(sourceFilePath: string): boolean {
    const segments = path.normalize(sourceFilePath).split(path.sep);
    return AGENT_ACTIVITY_EXCLUDED_PATH_SEGMENTS.some(segment => segments.includes(segment));
}

import * as vscode from 'vscode';
import * as path from 'path';
import sqlite3 from 'sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { ActivityEvent, ActivityType } from '../types';
import { insertHeartbeat, Heartbeat } from '../storage';

const HEARTBEAT_INTERVAL_MS = 3000;

export class HeartbeatAggregator {
    private eventBuffer: ActivityEvent[] = [];
    private timer: NodeJS.Timeout | null = null;
    private db: sqlite3.Database;
    private outputChannel: vscode.OutputChannel;
    private heartbeatCallbacks: (() => void)[] = [];

    constructor(db: sqlite3.Database, outputChannel: vscode.OutputChannel) {
        this.db = db;
        this.outputChannel = outputChannel;
    }

    onHeartbeat(callback: () => void) {
        this.heartbeatCallbacks.push(callback);
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => this.flush(), HEARTBEAT_INTERVAL_MS);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    push(event: ActivityEvent) {
        this.eventBuffer.push(event);
    }

    private flush() {
        if (this.eventBuffer.length === 0) return;

        const hasFileActivity = this.eventBuffer.some(e => e.source === 'file');
        const hasAgentActivity = this.eventBuffer.some(e => e.source === 'agent');

        const activityType: ActivityType = hasFileActivity ? 'coding' : 'planning';

        const mostRecentEvent = this.eventBuffer.reduce((latest, current) => 
            current.timestamp > latest.timestamp ? current : latest
        );

        const isWrite = this.eventBuffer.some(e => e.isWrite);

        const heartbeat: Heartbeat = {
            id: uuidv4(),
            timestamp: Date.now(),
            created_at: new Date().toISOString(),
            entity: mostRecentEvent.entity,
            type: mostRecentEvent.source === 'agent' ? 'agent' : 'file',
            category: mostRecentEvent.category || 'coding',
            is_write: isWrite,
            project: mostRecentEvent.project,
            language: mostRecentEvent.language,
            activity_type: activityType,
            has_file_activity: hasFileActivity,
            has_agent_activity: hasAgentActivity,
            source_file: mostRecentEvent.sourceFile
        };

        insertHeartbeat(this.db, heartbeat);
        
        this.heartbeatCallbacks.forEach(cb => cb());

        const time = new Date(heartbeat.timestamp).toLocaleTimeString();
        const displayName = heartbeat.type === 'agent' ? 'agent chat' : path.basename(heartbeat.entity);
        const language = heartbeat.language || 'unknown';
        const project = heartbeat.project || 'no project';
        const activityLabel = hasFileActivity && hasAgentActivity ? 'coding+agent' : activityType;
        
        this.outputChannel.appendLine(`[${time}] ${displayName} | ${language} | ${project} | ${activityLabel}`);

        this.eventBuffer = [];
    }

    dispose() {
        this.stop();
        this.flush();
    }
}

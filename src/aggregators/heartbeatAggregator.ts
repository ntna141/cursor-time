import * as vscode from 'vscode';
import * as path from 'path';
import sqlite3 from 'sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { ActivityEvent, ActivityType } from '../types';
import { insertHeartbeat, Heartbeat } from '../storage';
import { TodaySessionStore } from '../storage/todayStore';

const HEARTBEAT_INTERVAL_MS = 60000; // agents often sends final summary, so if the threshold is low, every heartbeat will basically be an agent activity

export class HeartbeatAggregator {
    private eventBuffer: ActivityEvent[] = [];
    private timer: NodeJS.Timeout | null = null;
    private db: sqlite3.Database;
    private outputChannel: vscode.OutputChannel;
    private heartbeatCallbacks: (() => void)[] = [];
    private todayStore: TodaySessionStore;

    constructor(db: sqlite3.Database, outputChannel: vscode.OutputChannel, todayStore: TodaySessionStore) {
        this.db = db;
        this.outputChannel = outputChannel;
        this.todayStore = todayStore;
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

        const fileEvents = this.eventBuffer.filter(e => e.source === 'file');
        const agentEvents = this.eventBuffer.filter(e => e.source === 'agent');
        
        const hasFileActivity = fileEvents.length > 0;
        const hasAgentActivity = agentEvents.length > 0;

        const activityType: ActivityType = hasFileActivity ? 'coding' : 'planning';

        const mostRecentFileEvent = hasFileActivity 
            ? fileEvents.reduce((latest, current) => 
                current.timestamp > latest.timestamp ? current : latest)
            : null;
        
        const mostRecentAgentEvent = hasAgentActivity
            ? agentEvents.reduce((latest, current) =>
                current.timestamp > latest.timestamp ? current : latest)
            : null;

        const primaryEvent = mostRecentFileEvent || mostRecentAgentEvent!;

        const isWrite = this.eventBuffer.some(e => e.isWrite);

        const heartbeat: Heartbeat = {
            id: uuidv4(),
            timestamp: Date.now(),
            created_at: new Date().toISOString(),
            entity: primaryEvent.entity,
            type: primaryEvent.source === 'agent' ? 'agent' : 'file',
            category: primaryEvent.category || 'coding',
            is_write: isWrite,
            project: primaryEvent.project,
            language: primaryEvent.language,
            activity_type: activityType,
            has_file_activity: hasFileActivity,
            has_agent_activity: hasAgentActivity,
            source_file: primaryEvent.sourceFile
        };

        insertHeartbeat(this.db, heartbeat);
        this.todayStore.pushHeartbeat(heartbeat);
        
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

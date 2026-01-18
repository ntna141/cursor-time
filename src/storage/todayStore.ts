import sqlite3 from 'sqlite3';
import { Heartbeat, Session, DaySessionSummary, getTodayDateKey, getDateRange, ActivitySegment } from './index';
import { SESSION_GAP_THRESHOLD_MS, PLANNING_STREAK_THRESHOLD } from '../utils/time';

interface ActiveSession {
    start: number;
    end: number;
    projects: Set<string>;
    codingMs: number;
    planningMs: number;
    heartbeats: number;
    currentActivityStart: number;
    planningStreak: number;
    activitySegments: ActivitySegment[];
}

interface TodayState {
    dateKey: string;
    sessions: Session[];
    activeSession: ActiveSession | null;
    lastHeartbeatTimestamp: number;
}

export class TodaySessionStore {
    private db: sqlite3.Database;
    private state: TodayState;

    constructor(db: sqlite3.Database) {
        this.db = db;
        this.state = {
            dateKey: getTodayDateKey(),
            sessions: [],
            activeSession: null,
            lastHeartbeatTimestamp: 0
        };
    }

    private ensureCurrentDate(): boolean {
        const currentDateKey = getTodayDateKey();
        if (this.state.dateKey !== currentDateKey) {
            this.state = {
                dateKey: currentDateKey,
                sessions: [],
                activeSession: null,
                lastHeartbeatTimestamp: 0
            };
            return true;
        }
        return false;
    }

    async load(): Promise<void> {
        this.ensureCurrentDate();
        const { start, end } = getDateRange(this.state.dateKey);
        
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT id, timestamp, project, activity_type FROM heartbeats WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp ASC`,
                [start, end],
                (err, rows: any[]) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    if (rows.length === 0) {
                        resolve();
                        return;
                    }

                    this.rebuildFromHeartbeats(rows);
                    resolve();
                }
            );
        });
    }

    private rebuildFromHeartbeats(rows: any[]): void {
        this.state.sessions = [];
        this.state.activeSession = null;
        this.state.lastHeartbeatTimestamp = 0;

        if (rows.length === 0) return;

        const isPlanning = (type: string | null | undefined) => type === 'planning';

        for (const row of rows) {
            this.processHeartbeat(row.timestamp, row.project, isPlanning(row.activity_type));
        }
    }

    private processHeartbeat(timestamp: number, project: string | null, isPlanning: boolean): void {
        const gap = this.state.lastHeartbeatTimestamp > 0 
            ? timestamp - this.state.lastHeartbeatTimestamp 
            : 0;

        if (this.state.activeSession === null || gap > SESSION_GAP_THRESHOLD_MS) {
            if (this.state.activeSession) {
                this.finalizeActiveSession();
            }
            
            this.state.activeSession = {
                start: timestamp,
                end: timestamp,
                projects: new Set(project ? [project] : []),
                codingMs: 0,
                planningMs: 0,
                heartbeats: 1,
                currentActivityStart: timestamp,
                planningStreak: isPlanning ? 1 : 0,
                activitySegments: []
            };
        } else {
            const session = this.state.activeSession;
            const lastWasPlanning = session.planningStreak > 0;

            if (isPlanning !== lastWasPlanning) {
                this.flushActivityTime(session, timestamp, lastWasPlanning);
                session.currentActivityStart = timestamp;
                session.planningStreak = isPlanning ? 1 : 0;
            } else if (isPlanning) {
                session.planningStreak++;
            }

            session.end = timestamp;
            session.heartbeats++;
            if (project) {
                session.projects.add(project);
            }
        }

        this.state.lastHeartbeatTimestamp = timestamp;
    }

    private flushActivityTime(session: ActiveSession, toTimestamp: number, isPlanningActivity: boolean): void {
        if (toTimestamp > session.currentActivityStart) {
            const duration = toTimestamp - session.currentActivityStart;
            const isTruePlanning = isPlanningActivity && session.planningStreak >= PLANNING_STREAK_THRESHOLD;
            if (isTruePlanning) {
                session.planningMs += duration;
            } else {
                session.codingMs += duration;
            }
            session.activitySegments.push({
                start: session.currentActivityStart,
                end: toTimestamp,
                type: isTruePlanning ? 'planning' : 'coding'
            });
        }
    }

    private finalizeActiveSession(): void {
        const session = this.state.activeSession;
        if (!session) return;

        const lastWasPlanning = session.planningStreak > 0;
        this.flushActivityTime(session, session.end, lastWasPlanning);

        this.state.sessions.push({
            start: session.start,
            end: session.end,
            durationMs: session.end - session.start,
            heartbeats: session.heartbeats,
            projects: Array.from(session.projects),
            codingMs: session.codingMs,
            planningMs: session.planningMs,
            activitySegments: session.activitySegments
        });

        this.state.activeSession = null;
    }

    pushHeartbeat(heartbeat: Heartbeat): void {
        this.ensureCurrentDate();
        const isPlanning = heartbeat.activity_type === 'planning';
        this.processHeartbeat(heartbeat.timestamp, heartbeat.project || null, isPlanning);
    }

    getSummary(): DaySessionSummary {
        if (this.ensureCurrentDate()) {
            return {
                dateKey: this.state.dateKey,
                sessionCount: 0,
                totalTimeMs: 0,
                sessions: [],
                totalCodingMs: 0,
                totalPlanningMs: 0
            };
        }

        const allSessions = [...this.state.sessions];
        
        if (this.state.activeSession) {
            const session = this.state.activeSession;
            const lastWasPlanning = session.planningStreak > 0;
            
            let codingMs = session.codingMs;
            let planningMs = session.planningMs;
            const activitySegments = [...session.activitySegments];
            
            if (session.end > session.currentActivityStart) {
                const duration = session.end - session.currentActivityStart;
                const isTruePlanning = lastWasPlanning && session.planningStreak >= PLANNING_STREAK_THRESHOLD;
                if (isTruePlanning) {
                    planningMs += duration;
                } else {
                    codingMs += duration;
                }
                activitySegments.push({
                    start: session.currentActivityStart,
                    end: session.end,
                    type: isTruePlanning ? 'planning' : 'coding'
                });
            }

            allSessions.push({
                start: session.start,
                end: session.end,
                durationMs: session.end - session.start,
                heartbeats: session.heartbeats,
                projects: Array.from(session.projects),
                codingMs,
                planningMs,
                activitySegments
            });
        }

        const totalTimeMs = allSessions.reduce((sum, s) => sum + s.durationMs, 0);
        const totalCodingMs = allSessions.reduce((sum, s) => sum + s.codingMs, 0);
        const totalPlanningMs = allSessions.reduce((sum, s) => sum + s.planningMs, 0);

        return {
            dateKey: this.state.dateKey,
            sessionCount: allSessions.length,
            totalTimeMs,
            sessions: allSessions,
            totalCodingMs,
            totalPlanningMs
        };
    }
}

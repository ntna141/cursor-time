import * as fs from 'fs';
import * as path from 'path';
import sqlite3 from 'sqlite3';
import { ActivityType } from '../types';
import { SESSION_GAP_THRESHOLD_MS, PLANNING_STREAK_THRESHOLD } from '../utils/time';

export interface Heartbeat {
    id: string;
    timestamp: number;
    created_at: string;
    entity: string;
    type: string;
    category: string;
    time?: number;
    is_write: boolean;
    project?: string;
    project_root_count?: number;
    branch?: string;
    language?: string;
    dependencies?: string[];
    machine_name_id?: string;
    activity_type: ActivityType;
    has_file_activity: boolean;
    has_agent_activity: boolean;
    source_file?: string;
}

export interface ActivitySegment {
    start: number;
    end: number;
    type: 'coding' | 'planning';
}

export interface Session {
    start: number;
    end: number;
    durationMs: number;
    heartbeats: number;
    projects: string[];
    codingMs: number;
    planningMs: number;
    activitySegments: ActivitySegment[];
}

export interface DaySessionSummary {
    dateKey: string;
    sessionCount: number;
    totalTimeMs: number;
    sessions: Session[];
    totalCodingMs: number;
    totalPlanningMs: number;
}

export interface StatsSummary {
    totalThisWeekMs: number;
    totalLastWeekMs: number;
    dailyAverageThisYearMs: number;
    dailyAverageLastYearMs: number;
    hasLastYearData: boolean;
}

export interface TodoItem {
    id: string;
    dateKey: string;
    text: string;
    completed: boolean;
    createdAt: number;
    sortOrder: number;
    completedAt?: number;
}

export function createDirectory(dir: string) {
    if (!fs.existsSync(dir)){
        fs.mkdirSync(dir, { recursive: true });
    }
}

export function createDatabase(dir: string): Promise<sqlite3.Database> {
    return new Promise((resolve, reject) => {
        const dbPath = path.join(dir, 'cursor-time.db');
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                reject(err);
                return;
            }

            db.run(`
                CREATE TABLE IF NOT EXISTS heartbeats (
                    id TEXT PRIMARY KEY,
                    timestamp INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    entity TEXT NOT NULL,
                    type TEXT NOT NULL,
                    category TEXT NOT NULL,
                    time REAL,
                    is_write INTEGER NOT NULL,
                    project TEXT,
                    project_root_count INTEGER,
                    branch TEXT,
                    language TEXT,
                    dependencies TEXT,
                    machine_name_id TEXT,
                    activity_type TEXT DEFAULT 'coding',
                    has_file_activity INTEGER DEFAULT 1,
                    has_agent_activity INTEGER DEFAULT 0
                )
            `, (err) => {
                if (err) {
                    reject(err);
                    return;
                }

                db.run(`
                    CREATE TABLE IF NOT EXISTS daily_sessions_cache (
                        date_key TEXT PRIMARY KEY,
                        session_count INTEGER NOT NULL,
                        total_time_ms INTEGER NOT NULL,
                        sessions_json TEXT NOT NULL,
                        last_heartbeat_id TEXT,
                        computed_at INTEGER NOT NULL
                    )
                `, (err) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    db.run(`
                        CREATE TABLE IF NOT EXISTS todos (
                            id TEXT PRIMARY KEY,
                            date_key TEXT NOT NULL,
                            text TEXT NOT NULL,
                            completed INTEGER DEFAULT 0,
                            created_at INTEGER NOT NULL,
                            sort_order INTEGER DEFAULT 0
                        )
                    `, (err) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        
                        db.run(`
                            CREATE TABLE IF NOT EXISTS aggregate_sessions_cache (
                                range_key TEXT PRIMARY KEY,
                                total_time_ms INTEGER NOT NULL,
                                computed_at INTEGER NOT NULL
                            )
                        `, (err) => {
                            if (err) {
                                reject(err);
                                return;
                            }
                        });

                        resolve(db);

                        db.run(`CREATE INDEX IF NOT EXISTS idx_todos_date ON todos(date_key)`);
                        db.run(`ALTER TABLE todos ADD COLUMN sort_order INTEGER DEFAULT 0`, () => {});
                        db.run(`ALTER TABLE todos ADD COLUMN completed_at INTEGER`, () => {});
                        db.run(`ALTER TABLE heartbeats ADD COLUMN activity_type TEXT DEFAULT 'coding'`, () => {});
                        db.run(`ALTER TABLE heartbeats ADD COLUMN has_file_activity INTEGER DEFAULT 1`, () => {});
                        db.run(`ALTER TABLE heartbeats ADD COLUMN has_agent_activity INTEGER DEFAULT 0`, () => {});
                        db.run(`ALTER TABLE heartbeats ADD COLUMN source_file TEXT`, () => {});
                        db.run(`CREATE INDEX IF NOT EXISTS idx_timestamp ON heartbeats(timestamp DESC)`);
                        db.run(`CREATE INDEX IF NOT EXISTS idx_entity ON heartbeats(entity)`);
                        db.run(`CREATE INDEX IF NOT EXISTS idx_project ON heartbeats(project)`);
                        db.run(`CREATE INDEX IF NOT EXISTS idx_project_timestamp ON heartbeats(project, timestamp DESC)`);
                        db.run(`CREATE INDEX IF NOT EXISTS idx_category_timestamp ON heartbeats(category, timestamp DESC)`);
                        db.run(`CREATE INDEX IF NOT EXISTS idx_activity_type_timestamp ON heartbeats(activity_type, timestamp DESC)`);
                        db.run(`CREATE INDEX IF NOT EXISTS idx_branch_timestamp ON heartbeats(branch, timestamp DESC)`);
                    });
                });
            });
        });
    });
}

export function insertHeartbeat(db: sqlite3.Database, heartbeat: Heartbeat) {
    db.run(`
        INSERT INTO heartbeats (
            id, timestamp, created_at, entity, type, category, time,
            is_write, project, project_root_count, branch, language,
            dependencies, machine_name_id, activity_type, has_file_activity, has_agent_activity, source_file
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?
        )
    `, [
        heartbeat.id,
        heartbeat.timestamp || Date.now(),
        heartbeat.created_at,
        heartbeat.entity,
        heartbeat.type,
        heartbeat.category,
        heartbeat.time ?? null,
        heartbeat.is_write ? 1 : 0,
        heartbeat.project ?? null,
        heartbeat.project_root_count ?? null,
        heartbeat.branch ?? null,
        heartbeat.language ?? null,
        heartbeat.dependencies ? JSON.stringify(heartbeat.dependencies) : null,
        heartbeat.machine_name_id ?? null,
        heartbeat.activity_type,
        heartbeat.has_file_activity ? 1 : 0,
        heartbeat.has_agent_activity ? 1 : 0,
        heartbeat.source_file ?? null
    ]);
}

export function getHeartbeatsByTimeRange(
    db: sqlite3.Database,
    startTime: number,
    endTime: number
): Promise<Heartbeat[]> {
    return new Promise((resolve, reject) => {
        db.all(`
            SELECT * FROM heartbeats
            WHERE timestamp BETWEEN ? AND ?
            ORDER BY timestamp DESC
        `, [startTime, endTime], (err, rows: any[]) => {
            if (err) {
                reject(err);
            } else {
                resolve(rows.map(deserializeHeartbeat));
            }
        });
    });
}

export function getRecentHeartbeats(
    db: sqlite3.Database,
    limit: number = 20
): Promise<Heartbeat[]> {
    return new Promise((resolve, reject) => {
        db.all(`
            SELECT * FROM heartbeats
            ORDER BY timestamp DESC
            LIMIT ?
        `, [limit], (err, rows: any[]) => {
            if (err) {
                reject(err);
            } else {
                resolve(rows.map(deserializeHeartbeat));
            }
        });
    });
}

export function getHeartbeatsByProject(
    db: sqlite3.Database,
    project: string,
    limit: number = 100
): Promise<Heartbeat[]> {
    return new Promise((resolve, reject) => {
        db.all(`
            SELECT * FROM heartbeats
            WHERE project = ?
            ORDER BY timestamp DESC
            LIMIT ?
        `, [project, limit], (err, rows: any[]) => {
            if (err) {
                reject(err);
            } else {
                resolve(rows.map(deserializeHeartbeat));
            }
        });
    });
}

export function getTimeSpentByProject(
    db: sqlite3.Database,
    startTime?: number,
    endTime?: number
): Promise<any[]> {
    return new Promise((resolve, reject) => {
        let query = `
            SELECT 
                project,
                COUNT(*) as heartbeat_count,
                MIN(timestamp) as first_heartbeat,
                MAX(timestamp) as last_heartbeat,
                MAX(timestamp) - MIN(timestamp) as total_time_ms
            FROM heartbeats
            WHERE project IS NOT NULL
        `;
        
        const params: any[] = [];
        if (startTime !== undefined && endTime !== undefined) {
            query += ` AND timestamp BETWEEN ? AND ?`;
            params.push(startTime, endTime);
        }
        
        query += `
            GROUP BY project
            ORDER BY total_time_ms DESC
        `;
        
        db.all(query, params, (err, rows: any[]) => {
            if (err) {
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
}

export function getTimeSpentByFile(
    db: sqlite3.Database,
    project?: string,
    startTime?: number,
    endTime?: number
): Promise<any[]> {
    return new Promise((resolve, reject) => {
        let query = `
            SELECT 
                entity,
                project,
                language,
                COUNT(*) as heartbeat_count,
                MIN(timestamp) as first_heartbeat,
                MAX(timestamp) as last_heartbeat,
                MAX(timestamp) - MIN(timestamp) as total_time_ms
            FROM heartbeats
            WHERE 1=1
        `;
        
        const params: any[] = [];
        if (project) {
            query += ` AND project = ?`;
            params.push(project);
        }
        if (startTime !== undefined && endTime !== undefined) {
            query += ` AND timestamp BETWEEN ? AND ?`;
            params.push(startTime, endTime);
        }
        
        query += `
            GROUP BY entity
            ORDER BY total_time_ms DESC
        `;
        
        db.all(query, params, (err, rows: any[]) => {
            if (err) {
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
}

function deserializeHeartbeat(row: any): Heartbeat {
    return {
        ...row,
        is_write: row.is_write === 1,
        dependencies: row.dependencies ? JSON.parse(row.dependencies) : undefined,
        activity_type: row.activity_type || 'coding',
        has_file_activity: row.has_file_activity === 1,
        has_agent_activity: row.has_agent_activity === 1,
        source_file: row.source_file || undefined
    };
}

export function getTodayDateKey(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function getDateRange(dateKey: string): { start: number; end: number } {
    const [year, month, day] = dateKey.split('-').map(Number);
    const startOfDay = new Date(year, month - 1, day, 0, 0, 0, 0);
    const endOfDay = new Date(year, month - 1, day, 23, 59, 59, 999);
    return { start: startOfDay.getTime(), end: endOfDay.getTime() };
}

function getDateKeyFromDate(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function getStartOfWeek(date: Date): Date {
    const day = date.getDay();
    const offset = day === 0 ? -6 : 1 - day;
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    start.setDate(start.getDate() + offset);
    start.setHours(0, 0, 0, 0);
    return start;
}

function addDays(date: Date, days: number): Date {
    const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    result.setDate(result.getDate() + days);
    return result;
}

function getYearDays(year: number): number {
    const start = new Date(year, 0, 1);
    const end = new Date(year + 1, 0, 1);
    return Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
}

function getDailyCacheSumAndCount(
    db: sqlite3.Database,
    startKey: string,
    endKey: string
): Promise<{ totalMs: number; dayCount: number }> {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT COALESCE(SUM(total_time_ms), 0) as total_time_ms, COUNT(*) as day_count FROM daily_sessions_cache WHERE date_key BETWEEN ? AND ?`,
            [startKey, endKey],
            (err, row: any) => {
                if (err) {
                    reject(err);
                } else {
                    resolve({ totalMs: row.total_time_ms || 0, dayCount: row.day_count || 0 });
                }
            }
        );
    });
}

async function getDailyCacheTotal(db: sqlite3.Database, dateKey: string): Promise<number | null> {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT total_time_ms FROM daily_sessions_cache WHERE date_key = ?`,
            [dateKey],
            (err, row: any) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row ? row.total_time_ms : null);
                }
            }
        );
    });
}

async function upsertAggregateCache(
    db: sqlite3.Database,
    rangeKey: string,
    startKey: string,
    endKey: string
): Promise<number> {
    const { totalMs } = await getDailyCacheSumAndCount(db, startKey, endKey);
    await new Promise<void>((resolve, reject) => {
        db.run(
            `INSERT OR REPLACE INTO aggregate_sessions_cache (range_key, total_time_ms, computed_at) VALUES (?, ?, ?)`,
            [rangeKey, totalMs, Date.now()],
            (err) => err ? reject(err) : resolve()
        );
    });
    return totalMs;
}

async function updateAggregateWithDelta(
    db: sqlite3.Database,
    rangeKey: string,
    startKey: string,
    endKey: string,
    deltaMs: number
): Promise<void> {
    const cached = await new Promise<number | null>((resolve, reject) => {
        db.get(
            `SELECT total_time_ms FROM aggregate_sessions_cache WHERE range_key = ?`,
            [rangeKey],
            (err, row: any) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row ? row.total_time_ms : null);
                }
            }
        );
    });

    if (cached !== null) {
        await new Promise<void>((resolve, reject) => {
            db.run(
                `UPDATE aggregate_sessions_cache SET total_time_ms = ?, computed_at = ? WHERE range_key = ?`,
                [cached + deltaMs, Date.now(), rangeKey],
                (err) => err ? reject(err) : resolve()
            );
        });
        return;
    }

    await upsertAggregateCache(db, rangeKey, startKey, endKey);
}

async function getAggregateTotalMs(
    db: sqlite3.Database,
    rangeKey: string,
    startKey: string,
    endKey: string
): Promise<number> {
    const cached = await new Promise<number | null>((resolve, reject) => {
        db.get(
            `SELECT total_time_ms FROM aggregate_sessions_cache WHERE range_key = ?`,
            [rangeKey],
            (err, row: any) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row ? row.total_time_ms : null);
                }
            }
        );
    });
    if (cached !== null) {
        return cached;
    }
    return upsertAggregateCache(db, rangeKey, startKey, endKey);
}

export async function updateAggregateCachesForDate(
    db: sqlite3.Database,
    dateKey: string,
    previousTotalMs: number,
    newTotalMs: number
): Promise<void> {
    const deltaMs = newTotalMs - previousTotalMs;
    if (deltaMs === 0) {
        return;
    }
    const [year, month, day] = dateKey.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    const weekStart = getStartOfWeek(date);
    const weekEnd = addDays(weekStart, 6);
    const weekStartKey = getDateKeyFromDate(weekStart);
    const weekEndKey = getDateKeyFromDate(weekEnd);
    const weekKey = `week:${weekStartKey}`;
    const yearKey = `year:${year}`;
    const yearStartKey = `${year}-01-01`;
    const yearEndKey = `${year}-12-31`;
    await updateAggregateWithDelta(db, weekKey, weekStartKey, weekEndKey, deltaMs);
    await updateAggregateWithDelta(db, yearKey, yearStartKey, yearEndKey, deltaMs);
}

export async function getStatsSummary(db: sqlite3.Database, date: Date = new Date()): Promise<StatsSummary> {
    const weekStart = getStartOfWeek(date);
    const weekEnd = addDays(weekStart, 6);
    const weekStartKey = getDateKeyFromDate(weekStart);
    const weekEndKey = getDateKeyFromDate(weekEnd);
    const weekKey = `week:${weekStartKey}`;

    const lastWeekStart = addDays(weekStart, -7);
    const lastWeekEnd = addDays(lastWeekStart, 6);
    const lastWeekStartKey = getDateKeyFromDate(lastWeekStart);
    const lastWeekEndKey = getDateKeyFromDate(lastWeekEnd);
    const lastWeekKey = `week:${lastWeekStartKey}`;

    const thisYear = date.getFullYear();
    const lastYear = thisYear - 1;
    const thisYearKey = `year:${thisYear}`;
    const lastYearKey = `year:${lastYear}`;
    const thisYearStartKey = `${thisYear}-01-01`;
    const thisYearEndKey = `${thisYear}-12-31`;
    const lastYearStartKey = `${lastYear}-01-01`;
    const lastYearEndKey = `${lastYear}-12-31`;

    const totalThisWeekMs = await getAggregateTotalMs(db, weekKey, weekStartKey, weekEndKey);
    const totalLastWeekMs = await getAggregateTotalMs(db, lastWeekKey, lastWeekStartKey, lastWeekEndKey);
    const totalThisYearMs = await getAggregateTotalMs(db, thisYearKey, thisYearStartKey, thisYearEndKey);
    const totalLastYearMs = await getAggregateTotalMs(db, lastYearKey, lastYearStartKey, lastYearEndKey);
    const { dayCount: lastYearDayCount } = await getDailyCacheSumAndCount(db, lastYearStartKey, lastYearEndKey);

    const daysElapsed = Math.max(1, Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() - new Date(thisYear, 0, 1).getTime()) / (24 * 60 * 60 * 1000)) + 1);
    const dailyAverageThisYearMs = Math.floor(totalThisYearMs / daysElapsed);
    const dailyAverageLastYearMs = Math.floor(totalLastYearMs / getYearDays(lastYear));

    return {
        totalThisWeekMs,
        totalLastWeekMs,
        dailyAverageThisYearMs,
        dailyAverageLastYearMs,
        hasLastYearData: lastYearDayCount > 0
    };
}

function computeSessionsFromHeartbeats(rows: any[]): Session[] {
    if (rows.length === 0) return [];

    const sessions: Session[] = [];
    const isPlanning = (type: string | null | undefined) => type === 'planning';
    
    let currentSession: { 
        start: number; 
        end: number; 
        heartbeats: number; 
        projects: Set<string>;
        codingMs: number;
        planningMs: number;
        lastTimestamp: number;
        currentActivityStart: number;
        planningStreak: number;
        activitySegments: ActivitySegment[];
    } = {
        start: rows[0].timestamp,
        end: rows[0].timestamp,
        heartbeats: 1,
        projects: new Set(rows[0].project ? [rows[0].project] : []),
        codingMs: 0,
        planningMs: 0,
        lastTimestamp: rows[0].timestamp,
        currentActivityStart: rows[0].timestamp,
        planningStreak: isPlanning(rows[0].activity_type) ? 1 : 0,
        activitySegments: []
    };

    const flushCurrentActivity = (session: typeof currentSession, toTimestamp: number, isPlanningActivity: boolean) => {
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
    };

    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const gap = row.timestamp - currentSession.end;
        const currentIsPlanning = isPlanning(row.activity_type);
        const lastWasPlanning = currentSession.planningStreak > 0;

        if (gap > SESSION_GAP_THRESHOLD_MS) {
            flushCurrentActivity(currentSession, currentSession.end, lastWasPlanning);
            sessions.push({
                start: currentSession.start,
                end: currentSession.end,
                durationMs: currentSession.end - currentSession.start,
                heartbeats: currentSession.heartbeats,
                projects: Array.from(currentSession.projects),
                codingMs: currentSession.codingMs,
                planningMs: currentSession.planningMs,
                activitySegments: currentSession.activitySegments
            });
            currentSession = {
                start: row.timestamp,
                end: row.timestamp,
                heartbeats: 1,
                projects: new Set(row.project ? [row.project] : []),
                codingMs: 0,
                planningMs: 0,
                lastTimestamp: row.timestamp,
                currentActivityStart: row.timestamp,
                planningStreak: currentIsPlanning ? 1 : 0,
                activitySegments: []
            };
        } else {
            if (currentIsPlanning !== lastWasPlanning) {
                flushCurrentActivity(currentSession, row.timestamp, lastWasPlanning);
                currentSession.currentActivityStart = row.timestamp;
                currentSession.planningStreak = currentIsPlanning ? 1 : 0;
            } else {
                if (currentIsPlanning) {
                    currentSession.planningStreak++;
                }
            }

            currentSession.end = row.timestamp;
            currentSession.lastTimestamp = row.timestamp;
            currentSession.heartbeats++;
            if (row.project) {
                currentSession.projects.add(row.project);
            }
        }
    }

    flushCurrentActivity(currentSession, currentSession.end, currentSession.planningStreak > 0);
    sessions.push({
        start: currentSession.start,
        end: currentSession.end,
        durationMs: currentSession.end - currentSession.start,
        heartbeats: currentSession.heartbeats,
        projects: Array.from(currentSession.projects),
        codingMs: currentSession.codingMs,
        planningMs: currentSession.planningMs,
        activitySegments: currentSession.activitySegments
    });

    return sessions;
}

export function getDaySessions(
    db: sqlite3.Database,
    dateKey: string
): Promise<DaySessionSummary> {
    return new Promise((resolve, reject) => {
        const isToday = dateKey === getTodayDateKey();
        
        db.get(
            `SELECT * FROM daily_sessions_cache WHERE date_key = ?`,
            [dateKey],
            (err, cacheRow: any) => {
                if (err) {
                    reject(err);
                    return;
                }

                if (cacheRow) {
                    const sessions = JSON.parse(cacheRow.sessions_json);
                    const totalCodingMs = sessions.reduce((sum: number, s: Session) => sum + (s.codingMs || 0), 0);
                    const totalPlanningMs = sessions.reduce((sum: number, s: Session) => sum + (s.planningMs || 0), 0);
                    resolve({
                        dateKey: cacheRow.date_key,
                        sessionCount: cacheRow.session_count,
                        totalTimeMs: cacheRow.total_time_ms,
                        sessions,
                        totalCodingMs,
                        totalPlanningMs
                    });
                    return;
                }

                const { start, end } = getDateRange(dateKey);
                db.all(
                    `SELECT id, timestamp, project, activity_type FROM heartbeats WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp ASC`,
                    [start, end],
                    async (err, rows: any[]) => {
                        try {
                            if (err) {
                                reject(err);
                                return;
                            }

                            if (rows.length === 0) {
                                resolve({
                                    dateKey,
                                    sessionCount: 0,
                                    totalTimeMs: 0,
                                    sessions: [],
                                    totalCodingMs: 0,
                                    totalPlanningMs: 0
                                });
                                return;
                            }

                            const sessions = computeSessionsFromHeartbeats(rows);
                            const totalCodingMs = sessions.reduce((sum, s) => sum + s.codingMs, 0);
                            const totalPlanningMs = sessions.reduce((sum, s) => sum + s.planningMs, 0);
                            const totalTimeMs = totalCodingMs + totalPlanningMs;
                            const lastHeartbeatId = rows[rows.length - 1].id;
                            const previousTotalMs = (await getDailyCacheTotal(db, dateKey)) ?? 0;

                            await new Promise<void>((resolve, reject) => {
                                db.run(
                                    `INSERT OR REPLACE INTO daily_sessions_cache (date_key, session_count, total_time_ms, sessions_json, last_heartbeat_id, computed_at) VALUES (?, ?, ?, ?, ?, ?)`,
                                    [dateKey, sessions.length, totalTimeMs, JSON.stringify(sessions), lastHeartbeatId, Date.now()],
                                    (err) => err ? reject(err) : resolve()
                                );
                            });
                            await updateAggregateCachesForDate(db, dateKey, previousTotalMs, totalTimeMs);

                            resolve({
                                dateKey,
                                sessionCount: sessions.length,
                                totalTimeMs,
                                sessions,
                                totalCodingMs,
                                totalPlanningMs
                            });
                        } catch (error) {
                            reject(error);
                        }
                    }
                );
            }
        );
    });
}

export function getTodosByDate(
    db: sqlite3.Database,
    dateKey: string
): Promise<TodoItem[]> {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT * FROM todos WHERE date_key = ? ORDER BY sort_order ASC, created_at ASC`,
            [dateKey],
            (err, rows: any[]) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows.map(row => ({
                        id: row.id,
                        dateKey: row.date_key,
                        text: row.text,
                        completed: row.completed === 1,
                        createdAt: row.created_at,
                        sortOrder: row.sort_order || 0,
                        completedAt: row.completed_at
                    })));
                }
            }
        );
    });
}

export function getUnfinishedTodosBeforeDate(
    db: sqlite3.Database,
    dateKey: string
): Promise<TodoItem[]> {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT * FROM todos WHERE date_key < ? AND completed = 0 ORDER BY date_key ASC, sort_order ASC, created_at ASC`,
            [dateKey],
            (err, rows: any[]) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows.map(row => ({
                        id: row.id,
                        dateKey: row.date_key,
                        text: row.text,
                        completed: row.completed === 1,
                        createdAt: row.created_at,
                        sortOrder: row.sort_order || 0,
                        completedAt: row.completed_at
                    })));
                }
            }
        );
    });
}

export function getCompletedTodosByDate(
    db: sqlite3.Database,
    dateKey: string
): Promise<TodoItem[]> {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT * FROM todos WHERE date_key = ? AND completed = 1 ORDER BY sort_order ASC, created_at ASC`,
            [dateKey],
            (err, rows: any[]) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows.map(row => ({
                        id: row.id,
                        dateKey: row.date_key,
                        text: row.text,
                        completed: row.completed === 1,
                        createdAt: row.created_at,
                        sortOrder: row.sort_order || 0,
                        completedAt: row.completed_at
                    })));
                }
            }
        );
    });
}

export function insertTodo(db: sqlite3.Database, todo: TodoItem): Promise<void> {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO todos (id, date_key, text, completed, created_at, sort_order) VALUES (?, ?, ?, ?, ?, ?)`,
            [todo.id, todo.dateKey, todo.text, todo.completed ? 1 : 0, todo.createdAt, todo.sortOrder],
            (err) => err ? reject(err) : resolve()
        );
    });
}

export function updateTodoCompleted(db: sqlite3.Database, id: string, completed: boolean, completedAt?: number, dateKey?: string): Promise<void> {
    return new Promise((resolve, reject) => {
        if (dateKey) {
            db.run(
                `UPDATE todos SET completed = ?, completed_at = ?, date_key = ? WHERE id = ?`,
                [completed ? 1 : 0, completed ? (completedAt ?? Date.now()) : null, dateKey, id],
                (err) => err ? reject(err) : resolve()
            );
        } else {
            db.run(
                `UPDATE todos SET completed = ?, completed_at = ? WHERE id = ?`,
                [completed ? 1 : 0, completed ? (completedAt ?? Date.now()) : null, id],
                (err) => err ? reject(err) : resolve()
            );
        }
    });
}

export function updateTodoText(db: sqlite3.Database, id: string, text: string): Promise<void> {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE todos SET text = ? WHERE id = ?`,
            [text, id],
            (err) => err ? reject(err) : resolve()
        );
    });
}

export function deleteTodo(db: sqlite3.Database, id: string): Promise<void> {
    return new Promise((resolve, reject) => {
        db.run(`DELETE FROM todos WHERE id = ?`, [id], (err) => err ? reject(err) : resolve());
    });
}

export function updateTodoSortOrder(db: sqlite3.Database, id: string, sortOrder: number): Promise<void> {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE todos SET sort_order = ? WHERE id = ?`,
            [sortOrder, id],
            (err) => err ? reject(err) : resolve()
        );
    });
}

export function clearSessionCache(db: sqlite3.Database): Promise<void> {
    return new Promise((resolve, reject) => {
        db.run(`DELETE FROM daily_sessions_cache`, (err) => err ? reject(err) : resolve());
    });
}

export function recalculateAllCachedDays(db: sqlite3.Database): Promise<number> {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT DISTINCT strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch', 'localtime') as date_key FROM heartbeats ORDER BY date_key`,
            [],
            async (err, rows: any[]) => {
                if (err) {
                    reject(err);
                    return;
                }

                const today = getTodayDateKey();
                let recalculated = 0;

                for (const row of rows) {
                    const dateKey = row.date_key;
                    if (dateKey === today) continue;

                    const { start, end } = getDateRange(dateKey);
                    const heartbeats = await new Promise<any[]>((resolve, reject) => {
                        db.all(
                            `SELECT id, timestamp, project, activity_type FROM heartbeats WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp ASC`,
                            [start, end],
                            (err, rows: any[]) => err ? reject(err) : resolve(rows)
                        );
                    });

                    if (heartbeats.length > 0) {
                        const sessions = computeSessionsFromHeartbeats(heartbeats);
                        const totalCodingMs = sessions.reduce((sum, s) => sum + s.codingMs, 0);
                        const totalPlanningMs = sessions.reduce((sum, s) => sum + s.planningMs, 0);
                        const totalTimeMs = totalCodingMs + totalPlanningMs;
                        const lastHeartbeatId = heartbeats[heartbeats.length - 1].id;

                        const previousTotalMs = (await getDailyCacheTotal(db, dateKey)) ?? 0;
                        await new Promise<void>((resolve, reject) => {
                            db.run(
                                `INSERT OR REPLACE INTO daily_sessions_cache (date_key, session_count, total_time_ms, sessions_json, last_heartbeat_id, computed_at) VALUES (?, ?, ?, ?, ?, ?)`,
                                [dateKey, sessions.length, totalTimeMs, JSON.stringify(sessions), lastHeartbeatId, Date.now()],
                                (err) => err ? reject(err) : resolve()
                            );
                        });
                        await updateAggregateCachesForDate(db, dateKey, previousTotalMs, totalTimeMs);
                        recalculated++;
                    }
                }

                resolve(recalculated);
            }
        );
    });
}


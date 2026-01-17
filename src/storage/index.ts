import * as fs from 'fs';
import * as path from 'path';
import sqlite3 from 'sqlite3';
import { ActivityType } from '../types';

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
}

export interface Session {
    start: number;
    end: number;
    durationMs: number;
    heartbeats: number;
    projects: string[];
}

export interface DaySessionSummary {
    dateKey: string;
    sessionCount: number;
    totalTimeMs: number;
    sessions: Session[];
}

export interface TodoItem {
    id: string;
    dateKey: string;
    text: string;
    completed: boolean;
    createdAt: number;
}

export function createDirectory(dir: string) {
    if (!fs.existsSync(dir)){
        fs.mkdirSync(dir, { recursive: true });
    }
}

export function createDatabase(dir: string): Promise<sqlite3.Database> {
    return new Promise((resolve, reject) => {
        const dbPath = path.join(dir, 'ntna-time.db');
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
                            created_at INTEGER NOT NULL
                        )
                    `, (err) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        
                        resolve(db);

                        db.run(`CREATE INDEX IF NOT EXISTS idx_todos_date ON todos(date_key)`);
                        db.run(`ALTER TABLE heartbeats ADD COLUMN activity_type TEXT DEFAULT 'coding'`, () => {});
                        db.run(`ALTER TABLE heartbeats ADD COLUMN has_file_activity INTEGER DEFAULT 1`, () => {});
                        db.run(`ALTER TABLE heartbeats ADD COLUMN has_agent_activity INTEGER DEFAULT 0`, () => {});
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
            dependencies, machine_name_id, activity_type, has_file_activity, has_agent_activity
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?
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
        heartbeat.has_agent_activity ? 1 : 0
    ], () => {
        invalidateTodayCache(db);
    });
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

export function detectSessions(
    db: sqlite3.Database,
    gapThresholdMs: number = 15 * 60 * 1000
): Promise<Array<{
    start: number;
    end: number;
    heartbeats: number;
    projects: Set<string>;
}>> {
    return new Promise((resolve, reject) => {
        db.all(`
            SELECT 
                id,
                timestamp,
                entity,
                project,
                LAG(timestamp) OVER (ORDER BY timestamp) as prev_timestamp
            FROM heartbeats
            ORDER BY timestamp
        `, (err, rows: any[]) => {
            if (err) {
                reject(err);
                return;
            }

            const sessions: Array<{
                start: number;
                end: number;
                heartbeats: number;
                projects: Set<string>;
            }> = [];
            
            let currentSession = {
                start: 0,
                end: 0,
                heartbeats: 0,
                projects: new Set<string>()
            };
            
            for (const row of rows) {
                const gap = row.prev_timestamp ? row.timestamp - row.prev_timestamp : 0;
                
                if (gap > gapThresholdMs || currentSession.start === 0) {
                    if (currentSession.start !== 0) {
                        sessions.push({...currentSession, projects: new Set(currentSession.projects)});
                    }
                    currentSession = {
                        start: row.timestamp,
                        end: row.timestamp,
                        heartbeats: 1,
                        projects: new Set([row.project])
                    };
                } else {
                    currentSession.end = row.timestamp;
                    currentSession.heartbeats++;
                    if (row.project) {
                        currentSession.projects.add(row.project);
                    }
                }
            }
            
            if (currentSession.start !== 0) {
                sessions.push(currentSession);
            }
            
            resolve(sessions);
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
        has_agent_activity: row.has_agent_activity === 1
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

const SESSION_GAP_THRESHOLD_MS = 20 * 60 * 1000;

function computeSessionsFromHeartbeats(rows: any[]): Session[] {
    if (rows.length === 0) return [];

    const sessions: Session[] = [];
    let currentSession: { start: number; end: number; heartbeats: number; projects: Set<string> } = {
        start: rows[0].timestamp,
        end: rows[0].timestamp,
        heartbeats: 1,
        projects: new Set(rows[0].project ? [rows[0].project] : [])
    };

    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const gap = row.timestamp - currentSession.end;

        if (gap > SESSION_GAP_THRESHOLD_MS) {
            sessions.push({
                start: currentSession.start,
                end: currentSession.end,
                durationMs: currentSession.end - currentSession.start,
                heartbeats: currentSession.heartbeats,
                projects: Array.from(currentSession.projects)
            });
            currentSession = {
                start: row.timestamp,
                end: row.timestamp,
                heartbeats: 1,
                projects: new Set(row.project ? [row.project] : [])
            };
        } else {
            currentSession.end = row.timestamp;
            currentSession.heartbeats++;
            if (row.project) {
                currentSession.projects.add(row.project);
            }
        }
    }

    sessions.push({
        start: currentSession.start,
        end: currentSession.end,
        durationMs: currentSession.end - currentSession.start,
        heartbeats: currentSession.heartbeats,
        projects: Array.from(currentSession.projects)
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

                if (cacheRow && !isToday) {
                    resolve({
                        dateKey: cacheRow.date_key,
                        sessionCount: cacheRow.session_count,
                        totalTimeMs: cacheRow.total_time_ms,
                        sessions: JSON.parse(cacheRow.sessions_json)
                    });
                    return;
                }

                const { start, end } = getDateRange(dateKey);
                db.all(
                    `SELECT id, timestamp, project FROM heartbeats WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp ASC`,
                    [start, end],
                    (err, rows: any[]) => {
                        if (err) {
                            reject(err);
                            return;
                        }

                        if (rows.length === 0) {
                            resolve({
                                dateKey,
                                sessionCount: 0,
                                totalTimeMs: 0,
                                sessions: []
                            });
                            return;
                        }

                        const sessions = computeSessionsFromHeartbeats(rows);
                        const totalTimeMs = sessions.reduce((sum, s) => sum + s.durationMs, 0);
                        const lastHeartbeatId = rows[rows.length - 1].id;

                        db.run(
                            `INSERT OR REPLACE INTO daily_sessions_cache (date_key, session_count, total_time_ms, sessions_json, last_heartbeat_id, computed_at) VALUES (?, ?, ?, ?, ?, ?)`,
                            [dateKey, sessions.length, totalTimeMs, JSON.stringify(sessions), lastHeartbeatId, Date.now()]
                        );

                        resolve({
                            dateKey,
                            sessionCount: sessions.length,
                            totalTimeMs,
                            sessions
                        });
                    }
                );
            }
        );
    });
}

export function invalidateTodayCache(db: sqlite3.Database): void {
    const todayKey = getTodayDateKey();
    db.run(`DELETE FROM daily_sessions_cache WHERE date_key = ?`, [todayKey]);
}

export function getTodosByDate(
    db: sqlite3.Database,
    dateKey: string
): Promise<TodoItem[]> {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT * FROM todos WHERE date_key = ? ORDER BY created_at ASC`,
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
                        createdAt: row.created_at
                    })));
                }
            }
        );
    });
}

export function insertTodo(db: sqlite3.Database, todo: TodoItem): Promise<void> {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO todos (id, date_key, text, completed, created_at) VALUES (?, ?, ?, ?, ?)`,
            [todo.id, todo.dateKey, todo.text, todo.completed ? 1 : 0, todo.createdAt],
            (err) => err ? reject(err) : resolve()
        );
    });
}

export function updateTodoCompleted(db: sqlite3.Database, id: string, completed: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE todos SET completed = ? WHERE id = ?`,
            [completed ? 1 : 0, id],
            (err) => err ? reject(err) : resolve()
        );
    });
}

export function deleteTodo(db: sqlite3.Database, id: string): Promise<void> {
    return new Promise((resolve, reject) => {
        db.run(`DELETE FROM todos WHERE id = ?`, [id], (err) => err ? reject(err) : resolve());
    });
}

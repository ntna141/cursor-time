import * as vscode from 'vscode';
import * as fs from 'fs';
import sqlite3 from 'sqlite3';
import { getDaySessions, getTodayDateKey, DaySessionSummary, TodoItem, getStatsSummary, StatsSummary, Heartbeat, insertHeartbeat, deleteHeartbeatsByDateKey, summarizeHeartbeatsForCache, upsertDailySessionsCache, updateAggregateCachesForDate } from '../storage';
import { TodaySessionStore } from '../storage/todayStore';
import { TodoHandler } from '../handlers/todoHandler';
import { formatDuration } from '../utils/time';

class LRUCache<K, V> {
    private cache = new Map<K, V>();
    private maxSize: number;

    constructor(maxSize: number) {
        this.maxSize = maxSize;
    }

    get(key: K): V | undefined {
        const value = this.cache.get(key);
        if (value !== undefined) {
            this.cache.delete(key);
            this.cache.set(key, value);
        }
        return value;
    }

    set(key: K, value: V): void {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) {
                this.cache.delete(oldest);
            }
        }
        this.cache.set(key, value);
    }

    delete(key: K): void {
        this.cache.delete(key);
    }
}

export class SessionsPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'cursor-time.sessionsView';
    private _view?: vscode.WebviewView;
    private context: vscode.ExtensionContext;
    private db: sqlite3.Database;
    private todayStore: TodaySessionStore;
    private currentDateKey: string;
    private viewingToday: boolean = true;
    private cache = new LRUCache<string, { summary: DaySessionSummary; todos: TodoItem[] }>(14);
    private isReady: boolean = false;
    private todoHandler: TodoHandler;
    private activePanel: 'sessions' | 'settings' | 'stats' = 'sessions';
    private webviewReady: boolean = false;
    private lastRenderedSections?: { dateKey: string; summaryHeader: string; panelSwitcher: string; todosSection: string };
    private lastRenderState?: { summary: DaySessionSummary; todos: TodoItem[]; stats: StatsSummary; isToday: boolean };
    private theme: 'dark' | 'blue' = 'dark';

    constructor(context: vscode.ExtensionContext, db: sqlite3.Database, todayStore: TodaySessionStore) {
        this.context = context;
        this.db = db;
        this.todayStore = todayStore;
        this.currentDateKey = getTodayDateKey();
        this.todoHandler = new TodoHandler(db);
        this.theme = (context.globalState.get('theme') as 'dark' | 'blue') || 'dark';
        
        vscode.window.onDidChangeWindowState(async (state) => {
            if (state.focused && this._view?.visible) {
                await this.ensureTodayUpdated();
                this.updateView();
            }
        });
    }

    public async preload(): Promise<void> {
        const todayKey = getTodayDateKey();
        const summary = this.todayStore.getSummary();
        const todos = await this.todoHandler.getTodos(todayKey);
        const stats = await getStatsSummary(this.db);
        this.isReady = true;
        
        if (this._view) {
            if (this.webviewReady) {
                const sections = this.getAppSections(summary, todos, stats, true, this.activePanel);
                this._view.webview.postMessage({
                    command: 'updateSections',
                    summaryHeader: sections.summaryHeader,
                    panelSwitcher: sections.panelSwitcher,
                    todosSection: sections.todosSection,
                    shouldFocusTodoInput: false,
                    activePanel: this.activePanel
                });
                this.lastRenderedSections = { ...sections, dateKey: todayKey };
                this.lastRenderState = { summary, todos, stats, isToday: true };
            } else {
                this._view.webview.html = this.getHtml(this._view.webview, summary, todos, stats, true, false, this.activePanel);
            }
        }
    }

    public refreshToday(summary?: DaySessionSummary): void {
        const todayKey = getTodayDateKey();
        if (this._view && this._view.visible && this.currentDateKey === todayKey) {
            this.updateView(false, summary);
        } else if (this._view && this._view.visible && this.viewingToday) {
            this.ensureTodayUpdated().then((didChange) => {
                if (didChange) {
                    this.updateView();
                }
            });
        }
    }

    public getLastActiveSuffix(summary?: DaySessionSummary): string {
        const summaryData = summary ?? this.todayStore.getSummary();
        return this.getLastActiveTextFromSummary(summaryData, true);
    }

    public async resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;
        this.webviewReady = false;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
        };
        
        webviewView.onDidChangeVisibility(async () => {
            if (webviewView.visible) {
                await this.ensureTodayUpdated();
                this.updateView();
            }
        });

        const cached = this.cache.get(this.currentDateKey);
        if (cached) {
            const isToday = this.currentDateKey === getTodayDateKey();
            const stats = await getStatsSummary(this.db);
            webviewView.webview.html = this.getHtml(webviewView.webview, cached.summary, cached.todos, stats, isToday, false, this.activePanel);
        } else if (this.isReady) {
            this.updateView();
        } else {
            webviewView.webview.html = this.getLoadingHtml(webviewView.webview);
        }

        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'webviewReady') {
                this.webviewReady = true;
                this._view?.webview.postMessage({ command: 'updateTheme', theme: this.theme });
                return;
            }
            if (message.command === 'prevDay' || message.command === 'nextDay') {
                if (this.viewingToday) {
                    const actualToday = getTodayDateKey();
                    if (this.currentDateKey !== actualToday) {
                        await this.todayStore.load();
                    }
                }
            }
            
            if (message.command === 'toggleSettings') {
                this.activePanel = this.activePanel === 'settings' ? 'sessions' : 'settings';
                this.updatePanelVisibility();
            } else if (message.command === 'showSettings') {
                this.activePanel = 'settings';
                this.updatePanelVisibility();
            } else if (message.command === 'showSessions') {
                this.activePanel = 'sessions';
                this.updatePanelVisibility();
            } else if (message.command === 'showStats') {
                this.activePanel = 'stats';
                this.updatePanelVisibility();
            } else if (message.command === 'openKeybindings') {
                await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings');
            } else if (message.command === 'setTheme') {
                this.theme = message.theme === 'blue' ? 'blue' : 'dark';
                await this.context.globalState.update('theme', this.theme);
                if (this._view) {
                    this._view.webview.postMessage({ command: 'updateTheme', theme: this.theme });
                }
            } else if (message.command === 'importWakaTime') {
                await this.handleImportWakaTime();
            } else if (message.command === 'prevDay') {
                this.currentDateKey = this.getOffsetDateKey(this.currentDateKey, -1);
                this.viewingToday = false;
                await this.updateView();
            } else if (message.command === 'nextDay') {
                this.currentDateKey = this.getOffsetDateKey(this.currentDateKey, 1);
                this.viewingToday = this.currentDateKey === getTodayDateKey();
                await this.updateView();
            } else if (await this.todoHandler.handleMessage(message, this.currentDateKey)) {
                this.cache.delete(this.currentDateKey);
                const shouldFocus = message.command === 'addTodo';
                await this.updateView(shouldFocus);
            }
        });
    }

    private getLoadingHtml(webview: vscode.Webview): string {
        const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'sessionsPanel.css'));
        const themeAttr = this.theme === 'blue' ? 'blue' : '';
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${stylesUri}">
</head>
<body${themeAttr ? ` data-theme="${themeAttr}"` : ''}>
    <div class="loading">loading...</div>
</body>
</html>`;
    }

    private getOffsetDateKey(dateKey: string, offset: number): string {
        const [year, month, day] = dateKey.split('-').map(Number);
        const date = new Date(year, month - 1, day);
        date.setDate(date.getDate() + offset);
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    private getDateKeyFromTimestamp(timestamp: number): string {
        const date = new Date(timestamp);
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    private mapWakaTimeHeartbeat(raw: any): Heartbeat | null {
        if (!raw || typeof raw !== 'object') return null;
        const entity = typeof raw.entity === 'string' ? raw.entity : null;
        const type = typeof raw.type === 'string' ? raw.type : null;
        if (!entity || !type) return null;

        const timeValue = typeof raw.time === 'number' ? raw.time : null;
        const createdAtRaw = typeof raw.created_at === 'string' ? raw.created_at : null;
        const timestamp = timeValue !== null
            ? Math.floor(timeValue * 1000)
            : (createdAtRaw ? Date.parse(createdAtRaw) : NaN);
        if (!Number.isFinite(timestamp)) return null;

        const created_at = createdAtRaw || new Date(timestamp).toISOString();
        const categoryRaw = typeof raw.category === 'string' ? raw.category.toLowerCase() : 'coding';
        const category = categoryRaw || 'coding';
        const activity_type = category === 'coding' ? 'coding' : 'planning';
        const dependencies = Array.isArray(raw.dependencies) ? raw.dependencies.map((dep: any) => String(dep)) : undefined;

        return {
            id: typeof raw.id === 'string' ? raw.id : `${timestamp}-${Math.random().toString(36).slice(2)}`,
            timestamp,
            created_at,
            entity,
            type,
            category,
            time: timeValue ?? undefined,
            is_write: !!raw.is_write,
            project: typeof raw.project === 'string' ? raw.project : undefined,
            project_root_count: typeof raw.project_root_count === 'number' ? raw.project_root_count : undefined,
            branch: typeof raw.branch === 'string' ? raw.branch : undefined,
            language: typeof raw.language === 'string' ? raw.language : undefined,
            dependencies,
            machine_name_id: typeof raw.machine_name_id === 'string' ? raw.machine_name_id : undefined,
            activity_type,
            has_file_activity: type === 'file',
            has_agent_activity: false,
            source_file: undefined
        };
    }

    private setImportLoading(loading: boolean) {
        if (this._view) {
            this._view.webview.postMessage({ command: 'setImportLoading', loading });
        }
    }

    private async handleImportWakaTime(): Promise<void> {
        try {
            const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;
            const picked = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: { JSON: ['json'] },
                defaultUri
            });
            if (!picked || picked.length === 0) {
                return;
            }

            this.setImportLoading(true);
            vscode.window.showWarningMessage('Importing WakaTime data. Please do not interrupt until it finishes.');

            const rawText = await fs.promises.readFile(picked[0].fsPath, 'utf8');
            const data = JSON.parse(rawText);
            const days = Array.isArray(data?.days) ? data.days : [];

            const grouped = new Map<string, Heartbeat[]>();
            for (const day of days) {
                const heartbeats = Array.isArray(day?.heartbeats) ? day.heartbeats : [];
                for (const hb of heartbeats) {
                    const mapped = this.mapWakaTimeHeartbeat(hb);
                    if (!mapped) continue;
                    const dateKey = this.getDateKeyFromTimestamp(mapped.timestamp);
                    const list = grouped.get(dateKey);
                    if (list) {
                        list.push(mapped);
                    } else {
                        grouped.set(dateKey, [mapped]);
                    }
                }
            }

            if (grouped.size === 0) {
                vscode.window.showErrorMessage('No heartbeats found in this file.');
                return;
            }

            let replacedDays = 0;
            let skippedDays = 0;
            let inserted = 0;

            for (const [dateKey, heartbeats] of grouped) {
                const importedSummary = summarizeHeartbeatsForCache(heartbeats);
                const existingSummary = await getDaySessions(this.db, dateKey);
                if (importedSummary.totalCodingMs <= existingSummary.totalCodingMs) {
                    skippedDays++;
                    continue;
                }

                await deleteHeartbeatsByDateKey(this.db, dateKey);
                for (const hb of heartbeats) {
                    insertHeartbeat(this.db, hb);
                    inserted++;
                }
                await upsertDailySessionsCache(this.db, dateKey, importedSummary.sessions, importedSummary.totalTimeMs, importedSummary.lastHeartbeatId);
                await updateAggregateCachesForDate(this.db, dateKey, existingSummary.totalTimeMs, importedSummary.totalTimeMs);
                this.cache.delete(dateKey);
                replacedDays++;
            }

            if (replacedDays > 0) {
                await this.updateView();
            }

            vscode.window.showInformationMessage(`Imported ${inserted} heartbeats across ${replacedDays} day(s), skipped ${skippedDays}.`);
        } catch (error) {
            vscode.window.showErrorMessage('Import failed.');
        } finally {
            this.setImportLoading(false);
        }
    }

    private async ensureTodayUpdated(): Promise<boolean> {
        if (this.viewingToday) {
            const actualToday = getTodayDateKey();
            if (this.currentDateKey !== actualToday) {
                const previousDateKey = this.currentDateKey;
                this.currentDateKey = actualToday;
                this.viewingToday = true;
                await this.todayStore.load();
                this.todoHandler.invalidateCache(previousDateKey);
                this.todoHandler.invalidateCache(actualToday);
                this.cache.delete(previousDateKey);
                this.cache.delete(actualToday);
                return true;
            }
        }
        return false;
    }

    public async updateView(shouldFocusTodoInput: boolean = false, precomputedSummary?: DaySessionSummary) {
        if (!this._view) return;

        const isToday = this.currentDateKey === getTodayDateKey();

        if (!isToday) {
            const cached = this.cache.get(this.currentDateKey);
            if (cached && !shouldFocusTodoInput) {
                const stats = await getStatsSummary(this.db);
                if (this.webviewReady) {
                    const sections = this.getAppSections(cached.summary, cached.todos, stats, isToday, this.activePanel);
                    this._view.webview.postMessage({
                        command: 'updateSections',
                        summaryHeader: sections.summaryHeader,
                        panelSwitcher: sections.panelSwitcher,
                        todosSection: sections.todosSection,
                        shouldFocusTodoInput: false,
                        activePanel: this.activePanel
                    });
                    this.lastRenderedSections = { ...sections, dateKey: this.currentDateKey };
                    this.lastRenderState = { summary: cached.summary, todos: cached.todos, stats, isToday };
                } else {
                    this._view.webview.html = this.getHtml(this._view.webview, cached.summary, cached.todos, stats, isToday, false, this.activePanel);
                }
                return;
            }
        }

        const summary = precomputedSummary ?? (isToday 
            ? this.todayStore.getSummary()
            : await getDaySessions(this.db, this.currentDateKey));
        const todos = await this.todoHandler.getTodos(this.currentDateKey);
        const stats = await getStatsSummary(this.db);
        
        if (!isToday && !shouldFocusTodoInput) {
            this.cache.set(this.currentDateKey, { summary, todos });
        }

        const sections = this.getAppSections(summary, todos, stats, isToday, this.activePanel);
        this.lastRenderState = { summary, todos, stats, isToday };

        if (this.webviewReady) {
            const lastRendered = this.lastRenderedSections;
            const shouldReplaceAll = !lastRendered || lastRendered.dateKey !== this.currentDateKey;
            const summaryChanged = shouldReplaceAll || (lastRendered && lastRendered.summaryHeader !== sections.summaryHeader);
            const panelChanged = shouldReplaceAll || (lastRendered && lastRendered.panelSwitcher !== sections.panelSwitcher);
            const todosChanged = shouldReplaceAll || (lastRendered && lastRendered.todosSection !== sections.todosSection);

            if (summaryChanged || panelChanged || todosChanged) {
                this._view.webview.postMessage({
                    command: 'updateSections',
                    summaryHeader: summaryChanged ? sections.summaryHeader : undefined,
                    panelSwitcher: panelChanged ? sections.panelSwitcher : undefined,
                    todosSection: todosChanged ? sections.todosSection : undefined,
                    shouldFocusTodoInput,
                    activePanel: this.activePanel
                });
                this.lastRenderedSections = { ...sections, dateKey: this.currentDateKey };
            }
            if (shouldFocusTodoInput) {
                this._view.webview.postMessage({ command: 'focusTodoInput' });
            }
        } else {
            this._view.webview.html = this.getHtml(this._view.webview, summary, todos, stats, isToday, shouldFocusTodoInput, this.activePanel);
            this.lastRenderedSections = { ...sections, dateKey: this.currentDateKey };
        }
    }

    public async focusTodoInput(): Promise<void> {
        if (!this._view) return;
        await this.updateView(true);
    }

    private updatePanelVisibility(): void {
        if (!this._view) return;
        this._view.webview.postMessage({ command: 'setActivePanel', activePanel: this.activePanel });
        this.syncLastRenderedForActivePanel();
    }


    private getTimelineHtml(sessions: Array<{ start: number; end: number; durationMs: number; projects: string[]; codingMs: number; planningMs: number; activitySegments?: Array<{ start: number; end: number; type: 'coding' | 'planning' }> }>): string {
        const filteredSessions = sessions.filter(s => s.durationMs >= 60000);
        
        if (filteredSessions.length === 0) {
            return '<div class="no-sessions">No sessions recorded</div>';
        }

        const firstSession = filteredSessions[0];
        const dayStart = new Date(firstSession.start);
        dayStart.setHours(0, 0, 0, 0);
        const dayStartMs = dayStart.getTime();
        const msPerDay = 24 * 60 * 60 * 1000;
        const msPerHour = 60 * 60 * 1000;

        const sessionHours = new Set<number>();
        filteredSessions.forEach(session => {
            const startOffset = session.start - dayStartMs;
            const endOffset = session.end - dayStartMs;
            
            const startHour = Math.floor(startOffset / msPerHour);
            const endHour = Math.ceil(endOffset / msPerHour);
            
            if (startHour >= 0 && startHour < 24) {
                sessionHours.add(startHour);
            }
            if (endHour >= 0 && endHour < 24) {
                sessionHours.add(endHour);
            }
        });

        const sortedHours = Array.from(sessionHours).sort((a, b) => a - b);
        const hoursToShow = new Set<number>();
        
        if (sortedHours.length > 0) {
            let groupStart = sortedHours[0];
            let groupEnd = sortedHours[0];
            
            for (let i = 1; i < sortedHours.length; i++) {
                if (sortedHours[i] === groupEnd + 1) {
                    groupEnd = sortedHours[i];
                } else {
                    if (groupStart === groupEnd) {
                        hoursToShow.add(groupStart);
                    } else {
                        hoursToShow.add(groupStart);
                        hoursToShow.add(groupEnd);
                    }
                    groupStart = sortedHours[i];
                    groupEnd = sortedHours[i];
                }
            }
            
            if (groupStart === groupEnd) {
                hoursToShow.add(groupStart);
            } else {
                hoursToShow.add(groupStart);
                hoursToShow.add(groupEnd);
            }
        }

        const bars = filteredSessions.map((session, index) => {
            const sessionStartPercent = ((session.start - dayStartMs) / msPerDay) * 100;
            const sessionEndPercent = ((session.end - dayStartMs) / msPerDay) * 100;
            const sessionWidthPercent = sessionEndPercent - sessionStartPercent;
            const centerPercent = sessionStartPercent + sessionWidthPercent / 2;
            
            const duration = formatDuration(session.durationMs);
            const position = index % 2 === 0 ? 'top' : 'bottom';
            
            let segmentBars = '';
            if (session.activitySegments && session.activitySegments.length > 0) {
                segmentBars = session.activitySegments.map(segment => {
                    const segStartPercent = ((segment.start - dayStartMs) / msPerDay) * 100;
                    const segEndPercent = ((segment.end - dayStartMs) / msPerDay) * 100;
                    const segWidthPercent = segEndPercent - segStartPercent;
                    return `<div class="timeline-bar ${segment.type}" style="position: absolute; left: ${segStartPercent}%; width: ${segWidthPercent}%; height: 100%;"></div>`;
                }).join('');
            } else {
                const totalActivity = (session.codingMs || 0) + (session.planningMs || 0);
                const codingPercent = totalActivity > 0 ? ((session.codingMs || 0) / totalActivity) * 100 : 100;
                segmentBars = `
                    <div class="timeline-bar coding" style="position: absolute; left: ${sessionStartPercent}%; width: ${sessionWidthPercent * codingPercent / 100}%; height: 100%;"></div>
                    <div class="timeline-bar planning" style="position: absolute; left: ${sessionStartPercent + sessionWidthPercent * codingPercent / 100}%; width: ${sessionWidthPercent * (100 - codingPercent) / 100}%; height: 100%;"></div>
                `;
            }
            
            return `
                ${segmentBars}
                <span class="time-label ${position}" style="left: ${centerPercent}%">${duration}</span>
            `;
        }).join('');

        const hourMarkers = Array.from({ length: 24 }, (_, hour) => {
            const hourPercent = (hour / 24) * 100;
            const showLabel = hoursToShow.has(hour);
            return `<div class="hour-marker" style="left: ${hourPercent}%">${showLabel ? `<span class="hour-label">${hour}</span>` : ''}</div>`;
        }).join('');

        return `
            <div class="timeline-container">
                <div class="timeline-track">
                    ${bars}
                </div>
                <div class="timeline-hours">
                    ${hourMarkers}
                </div>
            </div>
        `;
    }

    private getAppSections(summary: DaySessionSummary, todos: TodoItem[], stats: StatsSummary, isToday: boolean, activePanel: 'sessions' | 'settings' | 'stats' = 'sessions'): { summaryHeader: string; panelSwitcher: string; todosSection: string } {
        const filteredSessions = summary.sessions.filter(s => s.durationMs >= 60000);
        const lastActiveText = this.getLastActiveTextFromSummary(summary, isToday);
        const timelineHtml = this.getTimelineHtml(summary.sessions);
        const todosHtml = todos.map((todo, index) => `
            <div class="todo-item ${todo.completed ? 'completed' : ''}" ${isToday ? `data-index="${index}"` : ''}>
                ${isToday ? `<input type="checkbox" class="todo-checkbox" data-id="${todo.id}" ${todo.completed ? 'checked' : ''}>` : `<span class="todo-bullet">${todo.completed ? '×' : '•'}</span>`}
                ${isToday ? `<span class="todo-text" data-id="${todo.id}" contenteditable="true">${this.escapeHtml(todo.text)}</span>` : `<span class="todo-text">${this.escapeHtml(todo.text)}</span>`}
                ${isToday ? `<span class="drag-handle" data-index="${index}">⋮⋮</span>` : ''}
            </div>
        `).join('');

        const summaryHeader = `
    <div class="summary-header">
        <div class="date-nav">
            <button class="nav-btn" id="prevBtn">&larr;</button>
            <span class="date-label">${summary.dateKey}${isToday ? ' (today)' : ''}</span>
            <button class="nav-btn" id="nextBtn" ${isToday ? 'disabled' : ''}>&rarr;</button>
        </div>
        <div class="stats-row">
            <span class="total-time">${formatDuration(summary.totalTimeMs)}</span>
            <span class="session-count">${isToday ? lastActiveText : `(${filteredSessions.length} session${filteredSessions.length !== 1 ? 's' : ''})`}</span>
        </div>
        <div class="settings-row">
            <button class="settings-btn ${activePanel === 'sessions' ? 'disabled' : ''}" id="sessionsBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg></button>
            <button class="settings-btn ${activePanel === 'stats' ? 'disabled' : ''}" id="statsBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg></button>
            <button class="settings-btn ${activePanel === 'settings' ? 'disabled' : ''}" id="settingsBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg></button>
        </div>
    </div>
        `;

        const panelSwitcher = `
    <div class="panel-switcher">
        <div class="panel sessions-panel ${activePanel === 'sessions' ? 'visible' : 'hidden'}">
            <h2 class="section-header">sessions</h2>
            <div class="sessions-content">
                ${timelineHtml}
                <div class="activity-breakdown">
                    <div class="activity-item">
                        <span class="activity-dot coding"></span>
                        <span class="activity-label">coding</span>
                    </div>
                    <div class="activity-item">
                        <span class="activity-dot planning"></span>
                        <span class="activity-label">planning</span>
                    </div>
                </div>
            </div>
        </div>
        <div class="panel stats-panel ${activePanel === 'stats' ? 'visible' : 'hidden'}">
            <h2 class="section-header">stats</h2>
            <div class="stats-grid">
                <div class="stats-card">
                    <div class="stats-label">this week</div>
                    <div class="stats-value">${formatDuration(stats.totalThisWeekMs)}</div>
                </div>
                <div class="stats-card">
                    <div class="stats-label">last week</div>
                    <div class="stats-value">${formatDuration(stats.totalLastWeekMs)}</div>
                </div>
                ${stats.hasLastYearData ? `
                <div class="stats-card">
                    <div class="stats-label">daily avg last year</div>
                    <div class="stats-value">${formatDuration(stats.dailyAverageLastYearMs)}</div>
                </div>
                <div class="stats-card">
                    <div class="stats-label">daily avg this year</div>
                    <div class="stats-value">${formatDuration(stats.dailyAverageThisYearMs)}</div>
                </div>
                ` : `
                <div class="stats-card wide">
                    <div class="stats-label">daily avg this year</div>
                    <div class="stats-value">${formatDuration(stats.dailyAverageThisYearMs)}</div>
                </div>
                `}
            </div>
        </div>
        <div class="panel settings-panel ${activePanel === 'settings' ? 'visible' : 'hidden'}">
            <h2 class="section-header">settings</h2>
            <div class="settings-page">
                <div class="settings-section">
                    <button class="settings-action" id="openKeybindingsBtn">change keybinds</button>
                </div>
                <div class="settings-section">
                    <button class="settings-action" id="toggleThemeBtn">theme: ${this.theme === 'dark' ? 'dark' : 'blue'}</button>
                </div>
                <div class="settings-section">
                    <button class="settings-action" id="importWakaTimeBtn">import wakatime</button>
                    <span class="import-spinner" id="importSpinner" style="display: none;">⟳</span>
                </div>
            </div>
        </div>
    </div>
        `;

        const todosSection = `
    <h2 class="section-header" style="margin-top: 20px;">${isToday ? 'todos' : 'completed'}</h2>
    <div class="todos-list">
        ${isToday ? `
        <div class="todo-input-row">
            <div class="todo-input-box"></div>
            <input type="text" class="todo-input" id="todoInput" placeholder="">
        </div>
        ` : ''}
        ${todosHtml}
    </div>
        `;

        return { summaryHeader, panelSwitcher, todosSection };
    }

    private getAppHtml(summary: DaySessionSummary, todos: TodoItem[], stats: StatsSummary, isToday: boolean, activePanel: 'sessions' | 'settings' | 'stats' = 'sessions'): string {
        const sections = this.getAppSections(summary, todos, stats, isToday, activePanel);
        return `
    ${sections.summaryHeader}
    ${sections.panelSwitcher}
    ${sections.todosSection}
        `;
    }

    private getHtml(webview: vscode.Webview, summary: DaySessionSummary, todos: TodoItem[], stats: StatsSummary, isToday: boolean, shouldFocusTodoInput: boolean = false, activePanel: 'sessions' | 'settings' | 'stats' = 'sessions'): string {
        const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'sessionsPanel.css'));
        const sections = this.getAppSections(summary, todos, stats, isToday, activePanel);
        const themeAttr = this.theme === 'blue' ? 'blue' : '';
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${stylesUri}">
</head>
<body${themeAttr ? ` data-theme="${themeAttr}"` : ''}>
    <div id="app">
        <div id="summaryHeaderContainer">${sections.summaryHeader}</div>
        <div id="panelSwitcherContainer">${sections.panelSwitcher}</div>
        <div id="todosSectionContainer">${sections.todosSection}</div>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        const app = document.getElementById('app');
        let panelSwitcher = null;
        let sessionsPanel = null;
        let settingsPanel = null;
        let statsPanel = null;
        let settingsBtn = null;
        let sessionsBtn = null;
        let statsBtn = null;
        let updatePanelHeight = () => {};
        let setActivePanel = () => {};

        let documentHandlersBound = false;
        const bindOnce = (el, key, eventName, handler) => {
            if (!el) return;
            const flag = 'bound' + key;
            if (el.dataset && el.dataset[flag]) return;
            if (el.dataset) {
                el.dataset[flag] = 'true';
            }
            el.addEventListener(eventName, handler);
        };

        const bindHandlers = (shouldFocusTodoInput) => {
            const prevBtn = document.getElementById('prevBtn');
            const nextBtn = document.getElementById('nextBtn');
            if (prevBtn) {
                bindOnce(prevBtn, 'PrevClick', 'click', () => {
                    vscode.postMessage({ command: 'prevDay' });
                });
            }
            if (nextBtn) {
                bindOnce(nextBtn, 'NextClick', 'click', () => {
                    vscode.postMessage({ command: 'nextDay' });
                });
            }
            settingsBtn = document.getElementById('settingsBtn');
            sessionsBtn = document.getElementById('sessionsBtn');
            statsBtn = document.getElementById('statsBtn');
            if (settingsBtn) {
                bindOnce(settingsBtn, 'SettingsClick', 'click', () => {
                    vscode.postMessage({ command: 'showSettings' });
                });
            }
            if (sessionsBtn) {
                bindOnce(sessionsBtn, 'SessionsClick', 'click', () => {
                    vscode.postMessage({ command: 'showSessions' });
                });
            }
            if (statsBtn) {
                bindOnce(statsBtn, 'StatsClick', 'click', () => {
                    vscode.postMessage({ command: 'showStats' });
                });
            }
            
            const openKeybindingsBtn = document.getElementById('openKeybindingsBtn');
            if (openKeybindingsBtn) {
                bindOnce(openKeybindingsBtn, 'OpenKeybindingsClick', 'click', () => {
                    vscode.postMessage({ command: 'openKeybindings' });
                });
            }
            
            const toggleThemeBtn = document.getElementById('toggleThemeBtn');
            if (toggleThemeBtn) {
                bindOnce(toggleThemeBtn, 'ToggleThemeClick', 'click', () => {
                    const currentTheme = document.body.getAttribute('data-theme') || 'dark';
                    const newTheme = currentTheme === 'dark' ? 'blue' : 'dark';
                    vscode.postMessage({ command: 'setTheme', theme: newTheme });
                });
            }

            const importWakaTimeBtn = document.getElementById('importWakaTimeBtn');
            if (importWakaTimeBtn) {
                bindOnce(importWakaTimeBtn, 'ImportWakaTimeClick', 'click', () => {
                    vscode.postMessage({ command: 'importWakaTime' });
                });
            }

            panelSwitcher = document.querySelector('.panel-switcher');
            sessionsPanel = document.querySelector('.sessions-panel');
            settingsPanel = document.querySelector('.settings-panel');
            statsPanel = document.querySelector('.stats-panel');
            updatePanelHeight = () => {};
            setActivePanel = (panel) => {
                if (sessionsPanel) {
                    sessionsPanel.classList.toggle('visible', panel === 'sessions');
                    sessionsPanel.classList.toggle('hidden', panel !== 'sessions');
                }
                if (statsPanel) {
                    statsPanel.classList.toggle('visible', panel === 'stats');
                    statsPanel.classList.toggle('hidden', panel !== 'stats');
                }
                if (settingsPanel) {
                    settingsPanel.classList.toggle('visible', panel === 'settings');
                    settingsPanel.classList.toggle('hidden', panel !== 'settings');
                }
                if (sessionsBtn) {
                    sessionsBtn.classList.toggle('disabled', panel === 'sessions');
                }
                if (statsBtn) {
                    statsBtn.classList.toggle('disabled', panel === 'stats');
                }
                if (settingsBtn) {
                    settingsBtn.classList.toggle('disabled', panel === 'settings');
                }
            };
            const initialPanel = (sessionsPanel && sessionsPanel.classList.contains('visible')) ? 'sessions' 
                : (statsPanel && statsPanel.classList.contains('visible')) ? 'stats' 
                : 'settings';
            setActivePanel(initialPanel);
            updatePanelHeight();
            
            const todoInput = document.getElementById('todoInput');
            if (todoInput) {
                if (shouldFocusTodoInput) {
                    todoInput.focus();
                }
                const submitTodo = () => {
                    const text = todoInput.value.trim();
                    if (text) {
                        vscode.postMessage({ command: 'addTodo', text });
                        todoInput.value = '';
                    }
                };
                bindOnce(todoInput, 'TodoInputKeypress', 'keypress', (e) => {
                    if (e.key === 'Enter') {
                        submitTodo();
                    }
                });
                bindOnce(todoInput, 'TodoInputBlur', 'blur', submitTodo);
            }

            document.querySelectorAll('.todo-checkbox').forEach(checkbox => {
                bindOnce(checkbox, 'TodoCheckboxChange', 'change', (e) => {
                    const id = e.target.dataset.id;
                    vscode.postMessage({ command: 'toggleTodo', id, completed: e.target.checked });
                });
            });
            
            document.querySelectorAll('.todo-text[contenteditable="true"]').forEach(span => {
                if (span.dataset && span.dataset.boundTodoText === 'true') {
                    return;
                }
                if (span.dataset) {
                    span.dataset.boundTodoText = 'true';
                }
                let originalText = span.textContent;
                let skipNextBlur = false;
                
                span.addEventListener('focus', () => {
                    originalText = span.textContent;
                });
                
                span.addEventListener('blur', () => {
                    if (skipNextBlur) {
                        skipNextBlur = false;
                        return;
                    }
                    const newText = span.textContent.trim();
                    if (newText === '') {
                        span.textContent = originalText;
                        return;
                    }
                    if (newText !== originalText) {
                        const id = span.dataset.id;
                        vscode.postMessage({ command: 'editTodo', id, text: newText });
                    }
                });
                
                span.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        const newText = span.textContent.trim();
                        const id = span.dataset.id;
                        skipNextBlur = true;
                        if (newText === '') {
                            vscode.postMessage({ command: 'deleteTodo', id });
                        } else if (newText !== originalText) {
                            vscode.postMessage({ command: 'editTodo', id, text: newText });
                            originalText = newText;
                        }
                        span.blur();
                    } else if (e.key === 'Escape') {
                        span.textContent = originalText;
                        span.blur();
                    }
                });
            });
            
            let draggedItem = null;
            let draggedIndex = -1;
            
            document.querySelectorAll('.drag-handle').forEach(handle => {
                bindOnce(handle, 'DragHandleMousedown', 'mousedown', (e) => {
                    const item = handle.closest('.todo-item');
                    if (item) {
                        item.setAttribute('draggable', 'true');
                    }
                });
            });
            
            if (!documentHandlersBound) {
                documentHandlersBound = true;
                document.addEventListener('mouseup', () => {
                    document.querySelectorAll('.todo-item[draggable="true"]').forEach(item => {
                        item.removeAttribute('draggable');
                    });
                });
            }
            
            document.querySelectorAll('.todo-item[data-index]').forEach(item => {
                bindOnce(item, 'TodoItemDragstart', 'dragstart', (e) => {
                    draggedItem = item;
                    draggedIndex = parseInt(item.dataset.index);
                    item.classList.add('dragging');
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', draggedIndex);
                });
                
                bindOnce(item, 'TodoItemDragend', 'dragend', () => {
                    item.classList.remove('dragging');
                    item.removeAttribute('draggable');
                    document.querySelectorAll('.todo-item').forEach(i => {
                        i.classList.remove('drag-over-top', 'drag-over-bottom');
                    });
                    draggedItem = null;
                    draggedIndex = -1;
                });
                
                bindOnce(item, 'TodoItemDragover', 'dragover', (e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (draggedItem && item !== draggedItem) {
                        document.querySelectorAll('.todo-item').forEach(i => {
                            i.classList.remove('drag-over-top', 'drag-over-bottom');
                        });
                        const targetIndex = parseInt(item.dataset.index);
                        if (targetIndex > draggedIndex) {
                            item.classList.add('drag-over-bottom');
                        } else {
                            item.classList.add('drag-over-top');
                        }
                    }
                });
                
                bindOnce(item, 'TodoItemDragleave', 'dragleave', () => {
                    item.classList.remove('drag-over-top', 'drag-over-bottom');
                });
                
                bindOnce(item, 'TodoItemDrop', 'drop', (e) => {
                    e.preventDefault();
                    item.classList.remove('drag-over-top', 'drag-over-bottom');
                    if (draggedItem && item !== draggedItem) {
                        const toIndex = parseInt(item.dataset.index);
                        if (draggedIndex !== toIndex) {
                            vscode.postMessage({ command: 'reorderTodo', fromIndex: draggedIndex, toIndex: toIndex });
                        }
                    }
                });
            });
        };

        window.addEventListener('message', (event) => {
            const message = event.data;
            if (message.command === 'focusTodoInput') {
                const input = document.getElementById('todoInput');
                if (input) {
                    input.focus();
                }
            } else if (message.command === 'updateTheme') {
                document.body.setAttribute('data-theme', message.theme || 'dark');
                const toggleThemeBtn = document.getElementById('toggleThemeBtn');
                if (toggleThemeBtn) {
                    toggleThemeBtn.textContent = 'theme: ' + (message.theme === 'dark' ? 'dark' : 'blue');
                }
            } else if (message.command === 'setImportLoading') {
                const importBtn = document.getElementById('importWakaTimeBtn');
                const importSpinner = document.getElementById('importSpinner');
                if (importBtn) {
                    importBtn.disabled = message.loading || false;
                }
                if (importSpinner) {
                    importSpinner.style.display = message.loading ? 'inline-block' : 'none';
                }
            } else if (message.command === 'setActivePanel') {
                setActivePanel(message.activePanel || 'sessions');
                updatePanelHeight();
            } else if (message.command === 'updateSections') {
                const summaryHeaderContainer = document.getElementById('summaryHeaderContainer');
                const panelSwitcherContainer = document.getElementById('panelSwitcherContainer');
                const todosSectionContainer = document.getElementById('todosSectionContainer');
                if (summaryHeaderContainer && message.summaryHeader !== undefined) {
                    summaryHeaderContainer.innerHTML = message.summaryHeader;
                }
                if (panelSwitcherContainer && message.panelSwitcher !== undefined) {
                    panelSwitcherContainer.innerHTML = message.panelSwitcher;
                }
                if (todosSectionContainer && message.todosSection !== undefined) {
                    todosSectionContainer.innerHTML = message.todosSection;
                }
                bindHandlers(!!message.shouldFocusTodoInput);
                if (message.activePanel) {
                    setActivePanel(message.activePanel);
                    updatePanelHeight();
                }
            } else if (message.command === 'updateContent') {
                if (app) {
                    app.innerHTML = message.html || '';
                    bindHandlers(!!message.shouldFocusTodoInput);
                    if (message.activePanel) {
                        setActivePanel(message.activePanel);
                        updatePanelHeight();
                    }
                }
            }
        });

        bindHandlers(${shouldFocusTodoInput ? 'true' : 'false'});
        vscode.postMessage({ command: 'webviewReady' });
    </script>
</body>
</html>`;
    }

    private syncLastRenderedForActivePanel(): void {
        if (!this.lastRenderState) return;
        const sections = this.getAppSections(
            this.lastRenderState.summary,
            this.lastRenderState.todos,
            this.lastRenderState.stats,
            this.lastRenderState.isToday,
            this.activePanel
        );
        this.lastRenderedSections = { ...sections, dateKey: this.currentDateKey };
    }

    private getLastActiveText(sessions: Array<{ end: number }>): string {
        if (sessions.length === 0) {
            return '';
        }
        const lastSession = sessions[sessions.length - 1];
        const now = Date.now();
        const diffMs = now - lastSession.end;
        const diffMin = Math.floor(diffMs / 60000);
        
        if (diffMin < 1) {
            return ' (active just now)';
        }
        return ` (active ${diffMin} min ago)`;
    }

    private getLastActiveTextFromSummary(summary: DaySessionSummary, isToday: boolean): string {
        if (!isToday) {
            return '';
        }
        const filteredSessions = summary.sessions.filter(s => s.durationMs >= 60000);
        return this.getLastActiveText(filteredSessions);
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    public async dispose(): Promise<void> {
        await this.todoHandler.flush();
    }
}

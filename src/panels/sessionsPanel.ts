import * as vscode from 'vscode';
import sqlite3 from 'sqlite3';
import { getDaySessions, getTodayDateKey, DaySessionSummary, TodoItem, getTodosByDate } from '../storage';
import { TodoHandler } from '../handlers/todoHandler';

export class SessionsPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'ntna-time.sessionsView';
    private static readonly CACHE_DAYS = 14;
    private _view?: vscode.WebviewView;
    private db: sqlite3.Database;
    private currentDateKey: string;
    private cache: Map<string, { summary: DaySessionSummary; todos: TodoItem[]; html: string }> = new Map();
    private isReady: boolean = false;
    private todoHandler: TodoHandler;

    constructor(db: sqlite3.Database) {
        this.db = db;
        this.currentDateKey = getTodayDateKey();
        this.todoHandler = new TodoHandler(db);
    }

    private isWithinCacheWindow(dateKey: string): boolean {
        const [year, month, day] = dateKey.split('-').map(Number);
        const date = new Date(year, month - 1, day);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const diffMs = today.getTime() - date.getTime();
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        return diffDays >= 0 && diffDays < SessionsPanelProvider.CACHE_DAYS;
    }

    public async preload(): Promise<void> {
        const todayKey = getTodayDateKey();
        const [summary, todos] = await Promise.all([
            getDaySessions(this.db, todayKey),
            getTodosByDate(this.db, todayKey)
        ]);
        const html = this.getHtml(summary, todos, true);
        this.cache.set(todayKey, { summary, todos, html });
        this.isReady = true;
        
        if (this._view) {
            this._view.webview.html = html;
        }
    }

    public invalidateToday(): void {
        const todayKey = getTodayDateKey();
        this.cache.delete(todayKey);
        if (this._view && this.currentDateKey === todayKey) {
            this.updateView();
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true
        };
        
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible && this.currentDateKey === getTodayDateKey()) {
                this.invalidateToday();
            }
        });

        const cached = this.cache.get(this.currentDateKey);
        if (cached) {
            webviewView.webview.html = cached.html;
        } else if (this.isReady) {
            this.updateView();
        } else {
            webviewView.webview.html = this.getLoadingHtml();
        }

        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'prevDay') {
                this.currentDateKey = this.getOffsetDateKey(this.currentDateKey, -1);
                await this.updateView();
            } else if (message.command === 'nextDay') {
                this.currentDateKey = this.getOffsetDateKey(this.currentDateKey, 1);
                await this.updateView();
            } else if (await this.todoHandler.handleMessage(message, this.currentDateKey)) {
                this.cache.delete(this.currentDateKey);
                await this.updateView();
            }
        });
    }

    private getLoadingHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            font-family: monospace;
            padding: 15px;
            margin: 0;
            color: #a9b1d6;
            background-color: #1a1b26;
        }
        .loading {
            text-align: center;
            color: #565f89;
            padding: 40px 20px;
        }
    </style>
</head>
<body>
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

    public async updateView() {
        if (!this._view) return;

        const cached = this.cache.get(this.currentDateKey);
        if (cached) {
            this._view.webview.html = cached.html;
            return;
        }

        const isToday = this.currentDateKey === getTodayDateKey();
        const [summary, todos] = await Promise.all([
            getDaySessions(this.db, this.currentDateKey),
            getTodosByDate(this.db, this.currentDateKey)
        ]);
        const html = this.getHtml(summary, todos, isToday);
        
        if (!isToday && this.isWithinCacheWindow(this.currentDateKey)) {
            this.cache.set(this.currentDateKey, { summary, todos, html });
        }
        
        this._view.webview.html = html;
    }

    private formatDuration(ms: number): string {
        const totalMinutes = Math.floor(ms / 60000);
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;

        if (hours > 0) {
            return `${hours}h ${minutes}m`;
        } else {
            return `${minutes}m`;
        }
    }

    private getTimelineHtml(sessions: Array<{ start: number; end: number; durationMs: number; projects: string[] }>): string {
        const filteredSessions = sessions.filter(s => s.durationMs >= 60000);
        
        if (filteredSessions.length === 0) {
            return '<div class="no-sessions">No sessions recorded</div>';
        }

        const firstSession = filteredSessions[0];
        const dayStart = new Date(firstSession.start);
        dayStart.setHours(0, 0, 0, 0);
        const dayStartMs = dayStart.getTime();
        const msPerDay = 24 * 60 * 60 * 1000;

        const bars = filteredSessions.map((session, index) => {
            const startPercent = ((session.start - dayStartMs) / msPerDay) * 100;
            const endPercent = ((session.end - dayStartMs) / msPerDay) * 100;
            const widthPercent = endPercent - startPercent;
            const centerPercent = startPercent + widthPercent / 2;
            
            const duration = this.formatDuration(session.durationMs);
            const position = index % 2 === 0 ? 'top' : 'bottom';
            
            return `
                <div class="timeline-bar" style="left: ${startPercent}%; width: ${widthPercent}%;"></div>
                <span class="time-label ${position}" style="left: ${centerPercent}%">${duration}</span>
            `;
        }).join('');

        return `
            <div class="timeline-container">
                <div class="timeline-track">
                    ${bars}
                </div>
            </div>
        `;
    }

    private getHtml(summary: DaySessionSummary, todos: TodoItem[], isToday: boolean): string {
        const filteredSessions = summary.sessions.filter(s => s.durationMs >= 60000);
        const timelineHtml = this.getTimelineHtml(summary.sessions);

        const todosHtml = todos.map(todo => `
            <div class="todo-item ${todo.completed ? 'completed' : ''}">
                ${isToday ? `<input type="checkbox" class="todo-checkbox" data-id="${todo.id}" ${todo.completed ? 'checked' : ''}>` : `<span class="todo-bullet">${todo.completed ? '×' : '•'}</span>`}
                <span class="todo-text">${this.escapeHtml(todo.text)}</span>
                ${isToday ? `<button class="todo-delete" data-id="${todo.id}">&times;</button>` : ''}
            </div>
        `).join('');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            font-family: monospace;
            padding: 15px;
            margin: 0;
            color: #a9b1d6;
            background-color: #1a1b26;
        }
        .summary-header {
            background-color: #24283b;
            padding: 15px;
            margin: -15px -15px 0 -15px;
            border-bottom: 1px solid #414868;
        }
        .date-nav {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 12px;
        }
        .nav-btn {
            background: #414868;
            border: none;
            color: #c0caf5;
            cursor: pointer;
            font-size: 14px;
            padding: 5px 12px;
            border-radius: 4px;
            font-family: monospace;
            transition: background-color 0.2s ease;
        }
        .nav-btn:hover {
            background: #565f89;
        }
        .nav-btn:disabled {
            color: #565f89;
            cursor: not-allowed;
            background: #1a1b26;
        }
        .date-label {
            font-size: 14px;
            color: #9aa5ce;
        }
        .stats-row {
            display: flex;
            align-items: baseline;
            gap: 12px;
        }
        .total-time {
            font-size: 28px;
            font-weight: bold;
            color: #7aa2f7;
        }
        .session-count {
            font-size: 12px;
            color: #565f89;
        }
        .section-header {
            color: #9aa5ce;
            font-size: 0.9em;
            margin: 12px 0 4px 0;
            padding-bottom: 4px;
            border-bottom: 1px solid #414868;
        }
        .no-sessions {
            text-align: center;
            color: #565f89;
            padding: 15px 10px;
            font-size: 0.8em;
        }
        .timeline-container {
            margin: 8px 0;
        }
        .timeline-track {
            position: relative;
            height: 24px;
            background: #24283b;
            margin-top: 25px;
            margin-bottom: 25px;
        }
        .timeline-bar {
            position: absolute;
            top: 0;
            bottom: 0;
            background: #9ece6a;
            min-width: 2px;
        }
        .time-label {
            position: absolute;
            transform: translateX(-50%);
            font-size: 9px;
            color: #9aa5ce;
            white-space: nowrap;
        }
        .time-label.top {
            top: -14px;
        }
        .time-label.bottom {
            bottom: -14px;
        }
        .todos-list {
            margin-top: 0;
        }
        .todo-item {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 0;
        }
        .todo-item.completed .todo-text {
            text-decoration: line-through;
            color: #565f89;
        }
        .todo-item.completed .todo-bullet {
            color: #565f89;
        }
        .todo-bullet {
            color: #7aa2f7;
            font-size: 1.1em;
            width: 16px;
            text-align: center;
        }
        .todo-checkbox {
            appearance: none;
            -webkit-appearance: none;
            width: 13px;
            height: 13px;
            border: 1px solid #7aa2f7;
            border-radius: 2px;
            background: transparent;
            cursor: pointer;
            margin: 0;
            position: relative;
        }
        .todo-checkbox:checked::after {
            content: '×';
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            font-size: 13px;
            line-height: 1;
            color: #7aa2f7;
        }
        .todo-text {
            flex: 1;
            font-size: 1.1em;
            color: #c0caf5;
        }
        .todo-delete {
            background: transparent;
            border: none;
            color: #f7768e;
            cursor: pointer;
            font-size: 1.17em;
            padding: 0 3px;
            opacity: 0;
        }
        .todo-item:hover .todo-delete {
            opacity: 0.6;
        }
        .todo-delete:hover {
            opacity: 1;
        }
        .todo-input-row {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 0;
        }
        .todo-input-box {
            width: 13px;
            height: 13px;
            border: 1px solid #565f89;
            border-radius: 2px;
            flex-shrink: 0;
        }
        .todo-input {
            flex: 1;
            background: transparent;
            border: none;
            color: #c0caf5;
            font-family: monospace;
            font-size: 1.1em;
            padding: 0;
        }
        .todo-input:focus {
            outline: none;
        }
        .todo-input::placeholder {
            color: #565f89;
        }
    </style>
</head>
<body>
    <div class="summary-header">
        <div class="date-nav">
            <button class="nav-btn" id="prevBtn">&larr;</button>
            <span class="date-label">${summary.dateKey}${isToday ? ' (today)' : ''}</span>
            <button class="nav-btn" id="nextBtn" ${isToday ? 'disabled' : ''}>&rarr;</button>
        </div>
        <div class="stats-row">
            <span class="total-time">${this.formatDuration(summary.totalTimeMs)}</span>
            <span class="session-count">(${filteredSessions.length} session${filteredSessions.length !== 1 ? 's' : ''})</span>
        </div>
    </div>
    <h2 class="section-header">sessions</h2>
    ${timelineHtml}
    <h2 class="section-header" style="margin-top: 20px;">todos</h2>
    <div class="todos-list">
        ${todosHtml}
        ${isToday ? `
        <div class="todo-input-row">
            <div class="todo-input-box"></div>
            <input type="text" class="todo-input" id="todoInput" placeholder="">
        </div>
        ` : ''}
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        document.getElementById('prevBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'prevDay' });
        });
        document.getElementById('nextBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'nextDay' });
        });
        
        const todoInput = document.getElementById('todoInput');
        if (todoInput) {
            todoInput.focus();
            todoInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    const text = todoInput.value.trim();
                    if (text) {
                        vscode.postMessage({ command: 'addTodo', text });
                        todoInput.value = '';
                    }
                }
            });
        }
        
        document.querySelectorAll('.todo-checkbox').forEach(checkbox => {
            checkbox.addEventListener('change', (e) => {
                const id = e.target.dataset.id;
                vscode.postMessage({ command: 'toggleTodo', id, completed: e.target.checked });
            });
        });
        
        document.querySelectorAll('.todo-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.target.dataset.id;
                vscode.postMessage({ command: 'deleteTodo', id });
            });
        });
    </script>
</body>
</html>`;
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}

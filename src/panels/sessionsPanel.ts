import * as vscode from 'vscode';
import sqlite3 from 'sqlite3';
import { getDaySessions, getTodayDateKey, DaySessionSummary, TodoItem } from '../storage';
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
    public static readonly viewType = 'ntna-time.sessionsView';
    private _view?: vscode.WebviewView;
    private db: sqlite3.Database;
    private todayStore: TodaySessionStore;
    private currentDateKey: string;
    private cache = new LRUCache<string, { summary: DaySessionSummary; todos: TodoItem[] }>(14);
    private isReady: boolean = false;
    private todoHandler: TodoHandler;

    constructor(db: sqlite3.Database, todayStore: TodaySessionStore) {
        this.db = db;
        this.todayStore = todayStore;
        this.currentDateKey = getTodayDateKey();
        this.todoHandler = new TodoHandler(db);
    }

    public async preload(): Promise<void> {
        const todayKey = getTodayDateKey();
        const summary = this.todayStore.getSummary();
        const todos = await this.todoHandler.getTodos(todayKey);
        this.isReady = true;
        
        if (this._view) {
            this._view.webview.html = this.getHtml(summary, todos, true);
        }
    }

    public refreshToday(): void {
        const todayKey = getTodayDateKey();
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
                this.updateView();
            }
        });

        const cached = this.cache.get(this.currentDateKey);
        if (cached) {
            const isToday = this.currentDateKey === getTodayDateKey();
            webviewView.webview.html = this.getHtml(cached.summary, cached.todos, isToday);
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
                const shouldFocus = message.command === 'addTodo';
                await this.updateView(shouldFocus);
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

    public async updateView(shouldFocusTodoInput: boolean = false) {
        if (!this._view) return;

        const isToday = this.currentDateKey === getTodayDateKey();

        if (!isToday) {
            const cached = this.cache.get(this.currentDateKey);
            if (cached && !shouldFocusTodoInput) {
                this._view.webview.html = this.getHtml(cached.summary, cached.todos, isToday);
                return;
            }
        }

        const summary = isToday 
            ? this.todayStore.getSummary()
            : await getDaySessions(this.db, this.currentDateKey);
        const todos = await this.todoHandler.getTodos(this.currentDateKey);
        
        if (!isToday && !shouldFocusTodoInput) {
            this.cache.set(this.currentDateKey, { summary, todos });
        }
        
        this._view.webview.html = this.getHtml(summary, todos, isToday, shouldFocusTodoInput);
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
            const showLabel = sessionHours.has(hour);
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

    private getHtml(summary: DaySessionSummary, todos: TodoItem[], isToday: boolean, shouldFocusTodoInput: boolean = false): string {
        const filteredSessions = summary.sessions.filter(s => s.durationMs >= 60000);
        const timelineHtml = this.getTimelineHtml(summary.sessions);

        const todosHtml = todos.map((todo, index) => `
            <div class="todo-item ${todo.completed ? 'completed' : ''}" ${isToday ? `data-index="${index}"` : ''}>
                ${isToday ? `<input type="checkbox" class="todo-checkbox" data-id="${todo.id}" ${todo.completed ? 'checked' : ''}>` : `<span class="todo-bullet">${todo.completed ? '×' : '•'}</span>`}
                ${isToday ? `<span class="todo-text" data-id="${todo.id}" contenteditable="true">${this.escapeHtml(todo.text)}</span>` : `<span class="todo-text">${this.escapeHtml(todo.text)}</span>`}
                ${isToday ? `<span class="drag-handle" data-index="${index}">⋮⋮</span>` : ''}
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
        .activity-breakdown {
            display: flex;
            gap: 12px;
            margin-top: 18px;
            font-size: 12px;
        }
        .activity-item {
            display: flex;
            align-items: center;
            gap: 5px;
        }
        .activity-dot {
            width: 8px;
            height: 8px;
            border-radius: 2px;
        }
        .activity-dot.coding {
            background: #9ece6a;
        }
        .activity-dot.planning {
            background: #bb9af7;
        }
        .activity-label {
            color: #9aa5ce;
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
            margin-bottom: 8px;
        }
        .timeline-hours {
            position: relative;
            height: 16px;
            margin-bottom: 8px;
        }
        .hour-marker {
            position: absolute;
            top: 0;
            width: 1px;
            height: 6px;
            background: #414868;
            transform: translateX(-50%);
        }
        .hour-label {
            position: absolute;
            top: 8px;
            left: 50%;
            transform: translateX(-50%);
            font-size: 8px;
            color: #565f89;
            white-space: nowrap;
        }
        .timeline-bar {
            position: absolute;
            top: 0;
            height: 100%;
            min-width: 2px;
        }
        .timeline-bar.coding {
            background: #9ece6a;
        }
        .timeline-bar.planning {
            background: #bb9af7;
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
            align-items: flex-start;
            gap: 8px;
            padding: 4px 0;
            transition: background-color 0.15s ease, opacity 0.15s ease;
        }
        .todo-item.dragging {
            opacity: 0.5;
            background: #24283b;
        }
        .todo-item.drag-over-top {
            background: #24283b;
            border-top: 2px solid #7aa2f7;
            margin-top: -2px;
        }
        .todo-item.drag-over-bottom {
            background: #24283b;
            border-bottom: 2px solid #7aa2f7;
            margin-bottom: -2px;
        }
        .drag-handle {
            cursor: grab;
            color: #565f89;
            font-size: 10px;
            letter-spacing: -2px;
            padding: 0 2px;
            user-select: none;
            flex-shrink: 0;
            margin-top: 2px;
            opacity: 0;
            transition: opacity 0.15s ease;
        }
        .todo-item:hover .drag-handle {
            opacity: 1;
        }
        .drag-handle:hover {
            color: #7aa2f7;
        }
        .drag-handle:active {
            cursor: grabbing;
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
            flex-shrink: 0;
            margin-top: 2px;
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
            margin-top: 2px;
            position: relative;
            flex-shrink: 0;
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
            word-wrap: break-word;
            overflow-wrap: break-word;
            line-height: 1.4;
        }
        .todo-text[contenteditable="true"]:focus {
            outline: none;
            background: #24283b;
            border-radius: 2px;
            padding: 0 4px;
            margin: 0 -4px;
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
            <span class="total-time">${formatDuration(summary.totalTimeMs)}</span>
            <span class="session-count">(${filteredSessions.length} session${filteredSessions.length !== 1 ? 's' : ''})</span>
        </div>
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
    <h2 class="section-header">sessions</h2>
    ${timelineHtml}
    <h2 class="section-header" style="margin-top: 20px;">${isToday ? 'todos' : 'completed'}</h2>
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
            ${shouldFocusTodoInput ? 'todoInput.focus();' : ''}
            const submitTodo = () => {
                const text = todoInput.value.trim();
                if (text) {
                    vscode.postMessage({ command: 'addTodo', text });
                    todoInput.value = '';
                }
            };
            todoInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    submitTodo();
                }
            });
            todoInput.addEventListener('blur', submitTodo);
        }
        
        window.addEventListener('message', (event) => {
            const message = event.data;
            if (message.command === 'focusTodoInput') {
                const input = document.getElementById('todoInput');
                if (input) {
                    input.focus();
                }
            }
        });
        
        document.querySelectorAll('.todo-checkbox').forEach(checkbox => {
            checkbox.addEventListener('change', (e) => {
                const id = e.target.dataset.id;
                vscode.postMessage({ command: 'toggleTodo', id, completed: e.target.checked });
            });
        });
        
        document.querySelectorAll('.todo-text[contenteditable="true"]').forEach(span => {
            let originalText = span.textContent;
            
            span.addEventListener('focus', () => {
                originalText = span.textContent;
            });
            
            span.addEventListener('blur', () => {
                const newText = span.textContent.trim();
                if (newText !== originalText) {
                    const id = span.dataset.id;
                    vscode.postMessage({ command: 'editTodo', id, text: newText });
                }
            });
            
            span.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
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
            handle.addEventListener('mousedown', (e) => {
                const item = handle.closest('.todo-item');
                if (item) {
                    item.setAttribute('draggable', 'true');
                }
            });
        });
        
        document.addEventListener('mouseup', () => {
            document.querySelectorAll('.todo-item[draggable="true"]').forEach(item => {
                item.removeAttribute('draggable');
            });
        });
        
        document.querySelectorAll('.todo-item[data-index]').forEach(item => {
            item.addEventListener('dragstart', (e) => {
                draggedItem = item;
                draggedIndex = parseInt(item.dataset.index);
                item.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', draggedIndex);
            });
            
            item.addEventListener('dragend', () => {
                item.classList.remove('dragging');
                item.removeAttribute('draggable');
                document.querySelectorAll('.todo-item').forEach(i => {
                    i.classList.remove('drag-over-top', 'drag-over-bottom');
                });
                draggedItem = null;
                draggedIndex = -1;
            });
            
            item.addEventListener('dragover', (e) => {
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
            
            item.addEventListener('dragleave', () => {
                item.classList.remove('drag-over-top', 'drag-over-bottom');
            });
            
            item.addEventListener('drop', (e) => {
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

    public async dispose(): Promise<void> {
        await this.todoHandler.flush();
    }
}

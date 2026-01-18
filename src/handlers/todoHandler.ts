import sqlite3 from 'sqlite3';
import { TodoItem, insertTodo, updateTodoCompleted, deleteTodo, getTodosByDate, getUnfinishedTodosBeforeDate, getCompletedTodosByDate, getTodayDateKey } from '../storage';

export interface TodoMessage {
    command: string;
    text?: string;
    id?: string;
    completed?: boolean;
}

interface PendingChange {
    type: 'insert' | 'update' | 'delete';
    todo?: TodoItem;
    id?: string;
    completed?: boolean;
}

export class TodoHandler {
    private static readonly DEBOUNCE_MS = 300;
    private db: sqlite3.Database;
    private cache: Map<string, TodoItem[]> = new Map();
    private pendingChanges: Map<string, PendingChange> = new Map();
    private debounceTimer: NodeJS.Timeout | null = null;

    constructor(db: sqlite3.Database) {
        this.db = db;
    }

    public async getTodos(dateKey: string): Promise<TodoItem[]> {
        if (!this.cache.has(dateKey)) {
            const todayKey = getTodayDateKey();
            const isToday = dateKey === todayKey;
            
            if (isToday) {
                const [todayTodos, carriedOverTodos] = await Promise.all([
                    getTodosByDate(this.db, dateKey),
                    getUnfinishedTodosBeforeDate(this.db, dateKey)
                ]);
                const todos = [...carriedOverTodos, ...todayTodos];
                this.cache.set(dateKey, todos);
            } else {
                const todos = await getCompletedTodosByDate(this.db, dateKey);
                this.cache.set(dateKey, todos);
            }
        }
        return this.cache.get(dateKey)!;
    }

    public async handleMessage(message: TodoMessage, dateKey: string): Promise<boolean> {
        const todos = await this.getTodos(dateKey);

        if (message.command === 'addTodo') {
            const todo: TodoItem = {
                id: this.generateId(),
                dateKey: dateKey,
                text: message.text!,
                completed: false,
                createdAt: Date.now()
            };
            todos.push(todo);
            this.pendingChanges.set(todo.id, { type: 'insert', todo });
            this.schedulePersist();
            return true;
        } else if (message.command === 'toggleTodo') {
            const todo = todos.find(t => t.id === message.id);
            if (todo) {
                todo.completed = message.completed!;
                this.pendingChanges.set(todo.id, { type: 'update', id: todo.id, completed: todo.completed });
                this.schedulePersist();
            }
            return true;
        } else if (message.command === 'deleteTodo') {
            const index = todos.findIndex(t => t.id === message.id);
            if (index !== -1) {
                todos.splice(index, 1);
                this.pendingChanges.set(message.id!, { type: 'delete', id: message.id });
                this.schedulePersist();
            }
            return true;
        }
        return false;
    }

    public invalidateCache(dateKey: string): void {
        this.cache.delete(dateKey);
        const todayKey = getTodayDateKey();
        if (dateKey !== todayKey) {
            this.cache.delete(todayKey);
        }
    }

    private schedulePersist(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => this.persist(), TodoHandler.DEBOUNCE_MS);
    }

    private async persist(): Promise<void> {
        const changes = new Map(this.pendingChanges);
        this.pendingChanges.clear();

        for (const change of changes.values()) {
            if (change.type === 'insert' && change.todo) {
                await insertTodo(this.db, change.todo);
            } else if (change.type === 'update' && change.id) {
                await updateTodoCompleted(this.db, change.id, change.completed!);
            } else if (change.type === 'delete' && change.id) {
                await deleteTodo(this.db, change.id);
            }
        }
    }

    public async flush(): Promise<void> {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        await this.persist();
    }

    private generateId(): string {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
}

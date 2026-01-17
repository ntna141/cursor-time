import sqlite3 from 'sqlite3';
import { TodoItem, insertTodo, updateTodoCompleted, deleteTodo } from '../storage';

export interface TodoMessage {
    command: string;
    text?: string;
    id?: string;
    completed?: boolean;
}

export class TodoHandler {
    private db: sqlite3.Database;

    constructor(db: sqlite3.Database) {
        this.db = db;
    }

    public async handleMessage(message: TodoMessage, dateKey: string): Promise<boolean> {
        if (message.command === 'addTodo') {
            const todo: TodoItem = {
                id: this.generateId(),
                dateKey: dateKey,
                text: message.text!,
                completed: false,
                createdAt: Date.now()
            };
            await insertTodo(this.db, todo);
            return true;
        } else if (message.command === 'toggleTodo') {
            await updateTodoCompleted(this.db, message.id!, message.completed!);
            return true;
        } else if (message.command === 'deleteTodo') {
            await deleteTodo(this.db, message.id!);
            return true;
        }
        return false;
    }

    private generateId(): string {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
}

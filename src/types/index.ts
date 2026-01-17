import { EventEmitter } from 'events';

export type ActivitySource = 'file' | 'agent';
export type ActivityType = 'coding' | 'planning';

export interface ActivityEvent {
    source: ActivitySource;
    timestamp: number;
    entity: string;
    isWrite: boolean;
    project?: string;
    language?: string;
    category?: string;
    sourceFile?: string;
}

export interface ActivityEmitter extends EventEmitter {
    on(event: 'activity', listener: (activityEvent: ActivityEvent) => void): this;
    emit(event: 'activity', activityEvent: ActivityEvent): boolean;
}

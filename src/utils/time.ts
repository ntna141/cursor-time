export const SESSION_GAP_THRESHOLD_MS = 20 * 60 * 1000;
export const PLANNING_STREAK_THRESHOLD = 5;

export function formatDuration(ms: number): string {
    const totalMinutes = Math.floor(ms / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}

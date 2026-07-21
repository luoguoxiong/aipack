export interface ProgressEvent {
  type: 'start' | 'progress' | 'complete' | 'error';
  task: string;
  step?: string;
  progress?: number;
  message?: string;
  error?: string;
  timestamp: number;
}

export type ProgressCallback = (event: ProgressEvent) => void;

export class ProgressTracker {
  private callbacks: Set<ProgressCallback> = new Set();
  private activeTasks: Map<string, ProgressEvent> = new Map();

  onProgress(callback: ProgressCallback): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  emit(event: ProgressEvent): void {
    if (event.type === 'start' || event.type === 'progress') {
      this.activeTasks.set(event.task, event);
    } else {
      this.activeTasks.delete(event.task);
    }
    for (const cb of this.callbacks) {
      cb(event);
    }
  }

  start(task: string, step?: string): void {
    this.emit({
      type: 'start',
      task,
      step,
      timestamp: Date.now(),
    });
  }

  progress(task: string, progress: number, step?: string, message?: string): void {
    this.emit({
      type: 'progress',
      task,
      step,
      progress,
      message,
      timestamp: Date.now(),
    });
  }

  complete(task: string, message?: string): void {
    this.emit({
      type: 'complete',
      task,
      progress: 100,
      message,
      timestamp: Date.now(),
    });
  }

  error(task: string, error: string): void {
    this.emit({
      type: 'error',
      task,
      error,
      timestamp: Date.now(),
    });
  }

  getActiveTasks(): ProgressEvent[] {
    return Array.from(this.activeTasks.values());
  }
}

export const globalProgressTracker = new ProgressTracker();
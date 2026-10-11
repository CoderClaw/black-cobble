import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { NoteFormat } from '../shared/notes';
import type { ReplaceEdit, SearchMatch, SearchOptions } from '../shared/search';

/** Longest a single note may take, plus SEARCH_MS_PER_MIB for large notes: past it the pattern is treated as runaway. */
export const SEARCH_TASK_TIMEOUT_MS = 5_000;
/** Parsing a 30 MiB HTML note alone takes seconds. */
export const SEARCH_MS_PER_MIB = 500;
/** Longest a whole search may take; it then returns what it found, marked truncated. */
export const SEARCH_TOTAL_MS = 30_000;
export const SEARCH_TIMED_OUT = 'La búsqueda tardó demasiado y se canceló. Simplifica la expresión regular.';
const WORKER_HEAP_MB = 1536;
const literalTimedOut = 'La búsqueda tardó demasiado en una nota y se canceló.';
export type SearchTask =
  | { kind: 'find'; content: string; format: NoteFormat; options: SearchOptions; limit: number }
  | { kind: 'replace'; content: string; format: NoteFormat; options: SearchOptions; replacement: string; only?: Array<{ start: number; end: number }> };
/** The worker hit its memory limit on one note; the note can be skipped. */
export class SearchWorkerError extends Error {}
/** One note took too long; with a regex, every other note would likely stall too. */
export class SearchTimeoutError extends Error {}
/** Search skips a note that is too large for the worker; a slow regex fails the whole search instead. */
export function skippable(error: unknown, options: SearchOptions): SearchMatch[] {
  if (error instanceof SearchWorkerError || (error instanceof SearchTimeoutError && !options.regex)) return [];
  throw error;
}
type Current = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** Next to the main bundle; packaged apps unpack it because workers cannot start from inside app.asar. */
const defaultFile = () => path.join(__dirname, 'search-worker.cjs').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');

/**
 * Runs user patterns off the main thread, one note at a time. A note that takes too long terminates the
 * worker, so runaway backtracking never freezes the app; the next note starts a fresh worker.
 */
export class SearchRunner {
  private worker?: Worker;
  private current?: Current;
  private tail: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private reason = 'La búsqueda se ha cancelado.';
  constructor(private readonly file?: string, private readonly timeout = SEARCH_TASK_TIMEOUT_MS) {}
  find(content: string, format: NoteFormat, options: SearchOptions, limit: number): Promise<SearchMatch[]> {
    return this.run({ kind: 'find', content, format, options, limit });
  }
  replace(content: string, format: NoteFormat, options: SearchOptions, replacement: string, only?: Array<{ start: number; end: number }>): Promise<{ content: string; count: number; edits: ReplaceEdit[] }> {
    return this.run({ kind: 'replace', content, format, options, replacement, ...(only ? { only } : {}) });
  }
  /** Terminate the worker (and the plaintext it holds), failing the running and queued notes. */
  cancel(reason = 'La búsqueda se ha cancelado.'): void {
    this.generation++;
    this.reason = reason;
    this.stop(new Error(reason));
  }
  /** End of a search or replace call: no idle worker keeps heap or private plaintext. A worker busy for another call stays. */
  release(): void { if (!this.current) this.stop(new Error(this.reason)); }
  dispose(): void { this.cancel(); }

  private run<T>(task: SearchTask): Promise<T> {
    const generation = this.generation;
    const result = this.tail.then(() => {
      if (generation !== this.generation) throw new Error(this.reason);
      return this.send<T>(task);
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
  private send<T>(task: SearchTask): Promise<T> {
    const worker = this.worker ?? this.spawn();
    return new Promise<T>((resolve, reject) => {
      // Only this note fails on timeout; queued notes continue on a fresh worker.
      const timeout = this.timeout + Math.floor(task.content.length / 2 ** 20) * SEARCH_MS_PER_MIB;
      const timer = setTimeout(() => this.stop(new SearchTimeoutError(task.options.regex ? SEARCH_TIMED_OUT : literalTimedOut)), timeout);
      this.current = { resolve: value => resolve(value as T), reject, timer };
      worker.postMessage(task);
    });
  }
  private spawn(): Worker {
    // All isolates share one 4 GiB pointer-compression cage: a larger cap could abort the whole app. Notes whose
    // parse tree does not fit (HTML above roughly 20 MiB) are skipped; replacements stop at MAX_NOTE_BYTES first.
    const worker = new Worker(this.file ?? defaultFile(), { resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB } });
    worker.unref();
    worker.on('message', ({ result, error }: { result?: unknown; error?: string }) => {
      const current = this.current;
      if (this.worker !== worker || !current) return;
      this.current = undefined;
      clearTimeout(current.timer);
      if (error !== undefined) current.reject(new Error(error)); else current.resolve(result);
    });
    // Only running out of memory is specific to one note; anything else (a missing bundle) fails the search.
    worker.on('error', error => { if (this.worker === worker) this.stop((error as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY' ? new SearchWorkerError('La nota es demasiado grande para buscar en ella.') : new Error('No se pudo iniciar la búsqueda.')); });
    worker.on('exit', () => { if (this.worker === worker) this.stop(new Error('No se pudo iniciar la búsqueda.')); });
    this.worker = worker;
    return worker;
  }
  /** A worker that failed or hung is never reused. */
  private stop(error: Error): void {
    const worker = this.worker;
    const current = this.current;
    this.worker = undefined;
    this.current = undefined;
    void worker?.terminate();
    if (current) { clearTimeout(current.timer); current.reject(error); }
  }
}

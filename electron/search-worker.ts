import { parentPort } from 'node:worker_threads';
import { applyReplacements, findMatches } from '../shared/search';
import type { SearchTask } from './search-runner';

// Content arrives in memory only; it is never logged or written.
parentPort!.on('message', (task: SearchTask) => {
  try {
    const result = task.kind === 'find' ? findMatches(task.content, task.format, task.options, task.limit) : applyReplacements(task.content, task.format, task.options, task.replacement, task.only);
    parentPort!.postMessage({ result });
  } catch (error) { parentPort!.postMessage({ error: error instanceof Error ? error.message : 'La búsqueda ha fallado.' }); }
});

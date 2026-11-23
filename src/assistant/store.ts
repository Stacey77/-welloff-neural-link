import { join } from 'path';
import { DATA_DIR, readJson, writeJson } from '../ide/workspace.js';

export const ASSISTANT_DIR = join(DATA_DIR, 'assistant');

export interface Persisted<T> {
  get(): T;
  set(value: T): void;
  save(): void;
  flush(): void;
}

const WRITE_EVERY_MS = 250;
const pending = new Set<() => void>();
let exitHooked = false;

function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => {
    for (const flush of [...pending]) flush();
  });
}

// A JSON file under data/assistant, written at most every 250 ms and flushed on exit.
export function persisted<T>(name: string, fallback: () => T, validate: (v: unknown) => v is T): Persisted<T> {
  const file = join(ASSISTANT_DIR, name);
  const loaded = readJson<unknown>(file, null);
  let value: T = validate(loaded) ? loaded : fallback();
  let timer: NodeJS.Timeout | null = null;
  let lastWrite = 0;
  let dirty = false;

  const flush = (): void => {
    if (timer) { clearTimeout(timer); timer = null; }
    pending.delete(flush);
    if (!dirty) return;
    dirty = false;
    lastWrite = Date.now();
    writeJson(file, value);
  };

  const save = (): void => {
    dirty = true;
    pending.add(flush);
    if (timer) return;
    timer = setTimeout(flush, Math.max(0, WRITE_EVERY_MS - (Date.now() - lastWrite)));
    timer.unref();
  };

  hookExit();
  return {
    get: () => value,
    set: (v) => { value = v; save(); },
    save,
    flush,
  };
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

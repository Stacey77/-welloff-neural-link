import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(__dirname, '../../data');
const MEMORY_FILE = join(DATA_DIR, 'brain-memory.json');
const MAX_ENTRIES = 200;

export interface MemoryEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  tags?: string[];
}

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function loadMemory(): MemoryEntry[] {
  try {
    if (!existsSync(MEMORY_FILE)) return [];
    const raw = readFileSync(MEMORY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export function saveMemory(entries: MemoryEntry[]): void {
  try {
    ensureDir();
    const trimmed = entries.slice(-MAX_ENTRIES);
    writeFileSync(MEMORY_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
  } catch (err) {
    console.error('[memory] save failed:', err instanceof Error ? err.message : err);
  }
}

export function appendMemory(entry: MemoryEntry): void {
  const entries = loadMemory();
  entries.push(entry);
  saveMemory(entries);
}

export function searchMemory(query: string): MemoryEntry[] {
  const entries = loadMemory();
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (!words.length) return entries.slice(-10);
  return entries.filter(e =>
    words.some(w => e.content.toLowerCase().includes(w))
  ).slice(-20);
}

export function clearMemory(): void {
  try {
    ensureDir();
    writeFileSync(MEMORY_FILE, '[]', 'utf8');
  } catch { /* ignore */ }
}

export function getMemoryStats() {
  const entries = loadMemory();
  return {
    totalEntries: entries.length,
    userMessages: entries.filter(e => e.role === 'user').length,
    assistantMessages: entries.filter(e => e.role === 'assistant').length,
    oldestEntry: entries[0]?.timestamp,
    newestEntry: entries[entries.length - 1]?.timestamp,
    filePath: MEMORY_FILE,
  };
}

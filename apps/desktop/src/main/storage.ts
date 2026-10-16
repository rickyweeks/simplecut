import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { app } from 'electron';
import type { ProjectStorage } from '@simplecut/core';
import type { RecoveryEntry } from '../shared/api';

/** Project files: atomic writes so a crash mid-save never corrupts the .scut file. */
export const projectStorage: ProjectStorage = {
  readText: (path) => fs.readFile(path, 'utf8'),
  async writeText(path, text) {
    const tmp = `${path}.${process.pid}.tmp`;
    await fs.writeFile(tmp, text, 'utf8');
    await fs.rename(tmp, path);
  },
  exists: (paths) =>
    Promise.all(
      paths.map((p) =>
        fs.stat(p).then(
          (s) => s.isFile(),
          () => false,
        ),
      ),
    ),
};

/** Finds files by name in a folder and up to two levels of subfolders (for relinking). */
export async function findInFolder(folder: string, fileNames: string[]): Promise<Record<string, string>> {
  const wanted = new Map(fileNames.map((n) => [n.toLowerCase(), n]));
  const found: Record<string, string> = {};
  const walk = async (dir: string, depth: number) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const original = wanted.get(e.name.toLowerCase());
      if (e.isFile() && original && !found[original]) found[original] = join(dir, e.name);
    }
    if (depth < 2) for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) await walk(join(dir, e.name), depth + 1);
  };
  await walk(folder, 0);
  return found;
}

// ---------------------------------------------------------------------------
// Crash recovery: the UI autosaves a copy here every 60 s while there are unsaved
// changes; a clean close or a save removes it. Anything left at launch is offered back.
// ---------------------------------------------------------------------------

const recoveryDir = () => join(app.getPath('userData'), 'recovery');
const safeId = (id: string) => basename(id).replace(/[^a-zA-Z0-9_-]/g, '_');

export const recovery = {
  async write(id: string, text: string, meta: { name: string; projectPath: string | null }): Promise<void> {
    await fs.mkdir(recoveryDir(), { recursive: true });
    const entry: RecoveryEntry = { id: safeId(id), name: meta.name, projectPath: meta.projectPath, savedAt: new Date().toISOString() };
    await projectStorage.writeText(join(recoveryDir(), `${safeId(id)}.scut`), text);
    await projectStorage.writeText(join(recoveryDir(), `${safeId(id)}.json`), JSON.stringify(entry));
  },
  async list(): Promise<RecoveryEntry[]> {
    let files: string[];
    try {
      files = await fs.readdir(recoveryDir());
    } catch {
      return [];
    }
    const entries: RecoveryEntry[] = [];
    for (const f of files.filter((f) => f.endsWith('.json'))) {
      try {
        const e = JSON.parse(await fs.readFile(join(recoveryDir(), f), 'utf8')) as RecoveryEntry;
        if (await fs.stat(join(recoveryDir(), `${e.id}.scut`)).then(() => true, () => false)) entries.push(e);
      } catch {
        // ignore unreadable entries
      }
    }
    return entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  },
  read: (id: string) => fs.readFile(join(recoveryDir(), `${safeId(id)}.scut`), 'utf8'),
  async clear(id: string): Promise<void> {
    await fs.rm(join(recoveryDir(), `${safeId(id)}.scut`), { force: true });
    await fs.rm(join(recoveryDir(), `${safeId(id)}.json`), { force: true });
  },
};

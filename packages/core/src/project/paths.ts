/**
 * Platform-neutral path helpers (no Node `path`), so project files can be read on any OS.
 * Internally everything uses forward slashes. Windows-style paths (drive letters, UNC) are
 * compared case-insensitively.
 */

/** Converts to forward slashes, strips Windows long-path prefixes, removes duplicate slashes. */
export function toPortablePath(p: string): string {
  let s = p.replace(/\\/g, '/');
  if (s.startsWith('//?/UNC/')) s = '//' + s.slice(8);
  else if (s.startsWith('//?/') || s.startsWith('//./')) s = s.slice(4);
  const unc = s.startsWith('//');
  s = s.replace(/\/{2,}/g, '/');
  return unc ? '/' + s : s;
}

export function isWindowsPath(p: string): boolean {
  const s = toPortablePath(p);
  return /^[a-zA-Z]:(\/|$)/.test(s) || s.startsWith('//');
}

export function isAbsolutePath(p: string): boolean {
  const s = toPortablePath(p);
  return /^[a-zA-Z]:\//.test(s) || s.startsWith('/');
}

/** Splits into [root, ...segments]; root is "C:/", "//server/share/", "/" or "". */
function splitRoot(p: string): { root: string; parts: string[] } {
  const s = toPortablePath(p);
  let root = '';
  let rest = s;
  const drive = /^([a-zA-Z]:)(\/|$)/.exec(s);
  if (drive) {
    root = drive[1]!.toUpperCase() + '/';
    rest = s.slice(drive[0].length);
  } else if (s.startsWith('//')) {
    const m = /^\/\/([^/]+)\/([^/]+)\/?/.exec(s);
    if (m) {
      root = `//${m[1]}/${m[2]}/`;
      rest = s.slice(m[0].length);
    }
  } else if (s.startsWith('/')) {
    root = '/';
    rest = s.slice(1);
  }
  return { root, parts: rest.split('/').filter((x) => x.length > 0) };
}

/** Resolves "." and ".." segments. */
export function normalizePath(p: string): string {
  const { root, parts } = splitRoot(p);
  const out: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!root) out.push('..');
    } else out.push(part);
  }
  const joined = root + out.join('/');
  return joined || '.';
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter((x) => x.length > 0).join('/'));
}

export function dirname(p: string): string {
  const { root, parts } = splitRoot(normalizePath(p));
  if (parts.length <= 1) return root || '.';
  return root + parts.slice(0, -1).join('/');
}

export function basename(p: string): string {
  const { parts } = splitRoot(p);
  return parts[parts.length - 1] ?? '';
}

/** ".mp4" (lowercase), or "" */
export function extname(p: string): string {
  const base = basename(p);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
}

/** File name without extension. */
export function stem(p: string): string {
  const base = basename(p);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(0, i) : base;
}

/** Joins a relative path onto a base directory; absolute paths are just normalized. */
export function resolvePath(baseDir: string, p: string): string {
  return isAbsolutePath(p) ? normalizePath(p) : joinPath(baseDir, p);
}

/**
 * Relative path from a directory to a file, or null when they live on different roots
 * (e.g. different drive letters), where a relative path is impossible.
 */
export function relativePath(fromDir: string, to: string): string | null {
  const a = splitRoot(normalizePath(fromDir));
  const b = splitRoot(normalizePath(to));
  const win = isWindowsPath(fromDir) || isWindowsPath(to);
  const eq = (x: string, y: string) => (win ? x.toLowerCase() === y.toLowerCase() : x === y);
  if (!eq(a.root, b.root) || !a.root) return null;
  let i = 0;
  while (i < a.parts.length && i < b.parts.length && eq(a.parts[i]!, b.parts[i]!)) i++;
  const up = a.parts.slice(i).map(() => '..');
  const rel = [...up, ...b.parts.slice(i)].join('/');
  return rel || '.';
}

/** Converts a portable path to Windows backslashes. */
export function toWindowsPath(p: string): string {
  return toPortablePath(p).replace(/\//g, '\\');
}

/** Converts a portable path to the native style of the platform it came from. */
export function toNativePath(p: string, style: 'win32' | 'posix'): string {
  return style === 'win32' ? toWindowsPath(p) : toPortablePath(p);
}

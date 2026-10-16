import { describe, expect, it } from 'vitest';
import {
  PROJECT_VERSION,
  ProjectFileError,
  addMedia,
  basename,
  createProjectDoc,
  dirname,
  extname,
  insertEdit,
  mediaUsageCount,
  parseProject,
  relativePath,
  removeMedia,
  resolvePath,
  sequentialIds,
  serializeProject,
  stem,
  toPortablePath,
  toWindowsPath,
} from '../src';
import { audioMedia, videoMedia } from './helpers';

describe('portable paths', () => {
  it('normalizes Windows separators, long-path prefixes and UNC shares', () => {
    expect(toPortablePath('C:\\Users\\me\\clip.mp4')).toBe('C:/Users/me/clip.mp4');
    expect(toPortablePath('\\\\?\\C:\\very\\long\\path.mp4')).toBe('C:/very/long/path.mp4');
    expect(toPortablePath('\\\\?\\UNC\\nas\\videos\\a.mp4')).toBe('//nas/videos/a.mp4');
    expect(toPortablePath('\\\\nas\\videos\\\\a.mp4')).toBe('//nas/videos/a.mp4');
    expect(toWindowsPath('C:/a/b.mp4')).toBe('C:\\a\\b.mp4');
  });

  it('keeps spaces and non-ASCII characters intact', () => {
    const p = 'C:\\Users\\Zoë\\My Videos\\día 1 — final.mp4';
    expect(basename(p)).toBe('día 1 — final.mp4');
    expect(stem(p)).toBe('día 1 — final');
    expect(extname(p)).toBe('.mp4');
    expect(dirname(p)).toBe('C:/Users/Zoë/My Videos');
  });

  it('computes relative paths case-insensitively on Windows and refuses across drives', () => {
    expect(relativePath('C:/Projects/vlog', 'C:/Projects/vlog/footage/a.mp4')).toBe('footage/a.mp4');
    expect(relativePath('C:\\Projects\\vlog', 'c:\\projects\\Music\\song.mp3')).toBe('../Music/song.mp3');
    expect(relativePath('C:/Projects', 'D:/x.mp4')).toBeNull();
    expect(relativePath('/home/u/p', '/home/u/m/a.mp4')).toBe('../m/a.mp4');
    expect(resolvePath('C:/Projects/vlog', '../Music/song.mp3')).toBe('C:/Projects/Music/song.mp3');
    expect(resolvePath('C:/Projects/vlog', 'D:/abs.mp4')).toBe('D:/abs.mp4');
  });
});

describe('.scut project files', () => {
  const projectPath = 'C:\\Projects\\vlog\\My Vlog.scut';
  const meta = { id: 'p1', name: 'My Vlog' };

  function sampleDoc() {
    const ids = sequentialIds('n');
    let doc = createProjectDoc(ids);
    const a = { ...videoMedia('m1', 30), path: 'C:\\Projects\\vlog\\footage\\día 1.mp4' };
    const b = { ...audioMedia('m2', 90), path: 'D:\\Music\\song.mp3' };
    doc = addMedia(doc, [a, b]);
    const tl = insertEdit(doc.timeline, a, { mediaId: 'm1', inSec: 0, outSec: 2, video: true, audio: true }, 0, ids).timeline;
    return { ...doc, timeline: tl };
  }

  it('stores media relative to the project (plus an absolute fallback) with forward slashes', () => {
    const json = JSON.parse(serializeProject(sampleDoc(), meta, projectPath, { now: new Date('2026-10-15T00:00:00Z') }));
    expect(json.format).toBe('simplecut-project');
    expect(json.version).toBe(PROJECT_VERSION);
    const [a, b] = json.media;
    expect(a).toMatchObject({ path: 'footage/día 1.mp4', absolutePath: 'C:/Projects/vlog/footage/día 1.mp4' });
    expect(b).toMatchObject({ path: null, absolutePath: 'D:/Music/song.mp3' });
    expect(json.savedAt).toBe('2026-10-15T00:00:00.000Z');
  });

  it('round-trips the document exactly', () => {
    const doc = sampleDoc();
    const parsed = parseProject(serializeProject(doc, meta, projectPath), projectPath, 'win32');
    expect(parsed.doc).toEqual(doc);
    expect(parsed.meta).toEqual(meta);
  });

  it('finds media next to a moved project first, then at the original location', () => {
    const text = serializeProject(sampleDoc(), meta, projectPath);
    const moved = parseProject(text, 'E:\\Backup\\vlog\\My Vlog.scut', 'win32');
    expect(moved.mediaCandidates.m1).toEqual(['E:\\Backup\\vlog\\footage\\día 1.mp4', 'C:\\Projects\\vlog\\footage\\día 1.mp4']);
    expect(moved.doc.media.m1!.path).toBe('E:\\Backup\\vlog\\footage\\día 1.mp4');
    expect(moved.mediaCandidates.m2).toEqual(['D:\\Music\\song.mp3']);
    // Platform-neutral: a POSIX reader gets forward slashes.
    expect(parseProject(text, '/mnt/backup/vlog/My Vlog.scut', 'posix').mediaCandidates.m1![0]).toBe('/mnt/backup/vlog/footage/día 1.mp4');
  });

  it('rejects files that are not projects, are broken, or come from a newer version', () => {
    expect(() => parseProject('not json', null, 'win32')).toThrow(ProjectFileError);
    expect(() => parseProject('{"format":"other"}', null, 'win32')).toThrow(ProjectFileError);
    const newer = JSON.stringify({ format: 'simplecut-project', version: PROJECT_VERSION + 1, timeline: {} });
    expect(() => parseProject(newer, null, 'win32')).toThrow(/newer version/);
  });

  it('fills in missing fields and drops clips whose track or media is gone', () => {
    const text = JSON.stringify({
      format: 'simplecut-project',
      version: 1,
      project: { id: 'x', name: 'Hand edited' },
      media: [{ id: 'm1', name: 'a.mp4', absolutePath: 'C:/a.mp4', kind: 'video', durationSec: 5, hasVideo: true, hasAudio: true }],
      timeline: {
        settings: { fps: 25 },
        tracks: [{ id: 'a1', kind: 'audio' }, { id: 'v1', kind: 'video' }],
        clips: {
          ok: { id: 'ok', trackId: 'v1', mediaId: 'm1', kind: 'video', start: 0, duration: 10, sourceIn: 0 },
          noTrack: { id: 'noTrack', trackId: 'zz', mediaId: 'm1', kind: 'video', start: 0, duration: 10 },
          noMedia: { id: 'noMedia', trackId: 'v1', mediaId: 'gone', kind: 'video', start: 20, duration: 10 },
        },
      },
    });
    const { doc } = parseProject(text, null, 'win32');
    expect(doc.timeline.settings).toEqual({ format: '1080p', fps: 30, sampleRate: 48000, locked: false });
    expect(doc.timeline.tracks.map((t) => t.kind)).toEqual(['video', 'audio']);
    expect(Object.keys(doc.timeline.clips)).toEqual(['ok']);
    expect(doc.media.m1!.path).toBe('C:\\a.mp4');
  });

  it('removing media removes its clips', () => {
    const doc = sampleDoc();
    expect(mediaUsageCount(doc, 'm1')).toBe(2);
    const r = removeMedia(doc, ['m1']);
    expect(Object.keys(r.media)).toEqual(['m2']);
    expect(Object.keys(r.timeline.clips)).toHaveLength(0);
  });
});

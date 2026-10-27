import { createReadStream, promises as fs } from 'node:fs';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import { protocol } from 'electron';
import { MEDIA_SCHEME } from '../shared/api';

/**
 * scut://media/<encoded absolute path> serves local media to the UI with HTTP range
 * support, which <video> needs for seeking. Only media and cache asset types are served.
 */
const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.bin': 'application/octet-stream',
  '.json': 'application/json',
};

export function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true },
    },
  ]);
}

export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    let filePath: string;
    try {
      filePath = decodeURIComponent(new URL(request.url).pathname.slice(1));
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    const type = MIME[extname(filePath).toLowerCase()];
    if (!type) return new Response('Forbidden', { status: 403 });

    let size: number;
    try {
      const st = await fs.stat(filePath);
      if (!st.isFile()) throw new Error('not a file');
      size = st.size;
    } catch {
      return new Response('Not found', { status: 404 });
    }

    const headers: Record<string, string> = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    };
    const range = request.headers.get('range');
    const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
    if (m && (m[1] || m[2])) {
      let start: number;
      let end: number;
      if (m[1]) {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      } else {
        // "bytes=-N": the last N bytes.
        start = Math.max(0, size - Number(m[2]));
        end = size - 1;
      }
      if (start >= size || start > end) {
        return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
      }
      const body = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream;
      return new Response(body, {
        status: 206,
        headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
      });
    }
    const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
    return new Response(body, { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
  });
}

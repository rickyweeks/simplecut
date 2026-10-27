import { describe, expect, it } from 'vitest';
import { PeakAccumulator, detectVFR, parseProbe, parseRate, proxyArgs, proxyFrameRate, proxyReasons, proxySize } from '../src';

const iphone = {
  streams: [
    {
      codec_type: 'video',
      codec_name: 'hevc',
      width: 1920,
      height: 1080,
      pix_fmt: 'yuv420p10le',
      r_frame_rate: '30/1',
      avg_frame_rate: '18000/601',
      side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }],
    },
    { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '44100' },
  ],
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '12.345000', bit_rate: '15000000', size: '23000000' },
};

const obs = {
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, pix_fmt: 'yuv420p', r_frame_rate: '60/1', avg_frame_rate: '60/1' },
    { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' },
  ],
  format: { format_name: 'matroska,webm', duration: '600.0', bit_rate: '6000000' },
};

const gopro4k = {
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 3840, height: 2160, pix_fmt: 'yuvj420p', r_frame_rate: '30000/1001', avg_frame_rate: '30000/1001' },
    { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' },
  ],
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '60', bit_rate: '100000000' },
};

const mp3WithCover = {
  streams: [
    { codec_type: 'audio', codec_name: 'mp3', channels: 2, sample_rate: '44100' },
    { codec_type: 'video', codec_name: 'mjpeg', width: 600, height: 600, disposition: { attached_pic: 1 } },
  ],
  format: { format_name: 'mp3', duration: '201.5' },
};

const aviH264 = {
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, pix_fmt: 'yuv420p', r_frame_rate: '30/1', avg_frame_rate: '30/1' },
    { codec_type: 'audio', codec_name: 'mp3', channels: 2, sample_rate: '44100' },
  ],
  format: { format_name: 'avi', duration: '10.0', bit_rate: '4000000' },
};

const png = {
  streams: [{ codec_type: 'video', codec_name: 'png', width: 1280, height: 720, pix_fmt: 'rgba', r_frame_rate: '25/1', avg_frame_rate: '0/0' }],
  format: { format_name: 'png_pipe' },
};

describe('ffprobe parsing', () => {
  it('reads rotated, variable-frame-rate phone footage', () => {
    const info = parseProbe(iphone, 'C:/phone/IMG_0001.MOV');
    expect(info).toMatchObject({
      kind: 'video',
      width: 1080,
      height: 1920,
      rotation: 90,
      isVFR: true,
      videoCodec: 'hevc',
      durationSec: 12.345,
      hasAudio: true,
      audioSampleRate: 44100,
      fileSize: 23000000,
    });
    expect(info.avgFps).toBeCloseTo(29.95, 2);
  });

  it('treats constant-frame-rate screen recordings as CFR', () => {
    expect(parseProbe(obs, 'C:/obs/rec.mkv')).toMatchObject({ kind: 'video', fps: 60, isVFR: false });
  });

  it('ignores embedded cover art in audio files', () => {
    expect(parseProbe(mp3WithCover, 'C:/music/song.mp3')).toMatchObject({ kind: 'audio', hasVideo: false, hasAudio: true, durationSec: 201.5 });
  });

  it('recognizes still images', () => {
    expect(parseProbe(png, 'C:/img/logo.png')).toMatchObject({ kind: 'image', durationSec: 0, hasAudio: false, width: 1280 });
  });

  it('rejects files without usable streams', () => {
    expect(() => parseProbe({ streams: [], format: {} }, 'C:/x.mp4')).toThrow();
  });

  it('parses rates and detects VFR', () => {
    expect(parseRate('30000/1001')).toBeCloseTo(29.97, 2);
    expect(parseRate('0/0')).toBe(0);
    expect(detectVFR(30, 30)).toBe(false);
    expect(detectVFR(30000 / 1001, 30000 / 1001)).toBe(false);
    expect(detectVFR(30, 29.87)).toBe(true);
    expect(detectVFR(90000, 29.9)).toBe(true);
    expect(detectVFR(0, 30)).toBe(false);
  });
});

describe('proxy rules', () => {
  it('conforms VFR, and transcodes codecs the preview cannot play', () => {
    const phone = parseProbe(iphone, 'a.mov');
    expect(proxyReasons(phone).sort()).toEqual(['codec', 'vfr']);
    expect(proxySize(phone)).toEqual({ width: 1080, height: 1920 });
    expect(proxyFrameRate(phone)).toBe(29.97);
    const args = proxyArgs(phone, 'C:\\in.mov', 'C:\\out.mp4', 'h264_amf');
    expect(args).toEqual(expect.arrayContaining(['-fps_mode', 'cfr', '-r', '30000/1001', '-c:v', 'h264_amf', '-hwaccel', 'auto']));
    expect(args[args.length - 1]).toBe('C:\\out.mp4');
  });

  it('downsizes heavy 4K footage and leaves friendly files alone', () => {
    const uhd = parseProbe(gopro4k, 'g.mp4');
    expect(proxyReasons(uhd).sort()).toEqual(['bitrate', 'resolution']);
    expect(proxySize(uhd)).toEqual({ width: 1280, height: 720 });
    expect(proxyReasons(parseProbe(obs, 'o.mkv'))).toEqual([]);
    expect(proxyReasons(parseProbe(mp3WithCover, 's.mp3'))).toEqual([]);
    expect(proxyReasons(parseProbe(png, 'p.png'))).toEqual([]);
  });

  it('proxies AVI files even when their codecs are playable', () => {
    const avi = parseProbe(aviH264, 'C:/cam/CLIP0001.AVI');
    expect(avi).toMatchObject({ kind: 'video', container: 'avi', videoCodec: 'h264' });
    expect(proxyReasons(avi)).toEqual(['codec']);
    // Projects saved before the container was recorded keep their old behaviour.
    expect(proxyReasons({ ...avi, container: undefined })).toEqual([]);
  });
});

describe('waveform peaks', () => {
  it('turns 8 kHz samples into 100 peaks per second', () => {
    const acc = new PeakAccumulator();
    const second = new Float32Array(8000);
    for (let i = 0; i < second.length; i++) second[i] = i < 4000 ? 0.5 * Math.sin(i) : 0;
    acc.push(second.subarray(0, 3000));
    acc.push(second.subarray(3000));
    const peaks = acc.result();
    expect(peaks).toHaveLength(100);
    expect(peaks[0]).toBeGreaterThan(120);
    expect(peaks[99]).toBe(0);
  });
});

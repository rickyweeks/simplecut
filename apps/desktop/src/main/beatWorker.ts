/**
 * Runs beat detection off the main thread (it takes a second or two for a long song, and
 * the main process also serves media to the preview, which must never stall).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { analyzeBeats } from '@simplecut/core';

const { samples } = workerData as { samples: Float32Array };
const { features: _features, ...analysis } = analyzeBeats(samples);
parentPort!.postMessage(analysis);

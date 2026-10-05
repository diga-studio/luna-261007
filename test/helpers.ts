import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodePng, encodePng } from '../src/png.js';

export const WIDTH = 10;
export const HEIGHT = 10;

/** Build an opaque PNG where every pixel is the given RGB color. */
export function solidPng(r: number, g: number, b: number): Buffer {
  const data = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return encodePng(WIDTH, HEIGHT, data);
}

/** Re-encode a PNG with the first `count` pixels recolored. */
export function pngWithChangedPixels(source: Buffer, count: number, r: number, g: number, b: number): Buffer {
  const decoded = decodePng(source);
  const data = Buffer.from(decoded.data);
  for (let i = 0; i < count; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
  }
  return encodePng(WIDTH, HEIGHT, data);
}

export function imageIdOf(png: Buffer): string {
  return createHash('sha256').update(png).digest('hex');
}

export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vrb-test-'));
}

export function listImageFiles(dir: string): string[] {
  const imageDir = path.join(dir, 'images');
  return fs.existsSync(imageDir) ? fs.readdirSync(imageDir).sort() : [];
}

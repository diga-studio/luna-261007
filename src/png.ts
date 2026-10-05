import { deflateSync, inflateSync } from 'node:zlib';

/** Decoded 8-bit RGB(A) PNG. */
export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA pixel data, 4 bytes per pixel. */
  data: Buffer;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Decode a PNG buffer (8-bit RGB/RGBA, non-interlaced) into RGBA pixels. */
export function decodePng(png: Buffer): DecodedPng {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG file');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9];
      const interlace = data[12];
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
        throw new Error(`unsupported PNG format: bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`);
      }
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (colorType === -1 || idat.length === 0) {
    throw new Error('invalid PNG: missing IHDR or IDAT');
  }
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const stride = width * bytesPerPixel;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * 4);
  let prevRow = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const row = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const out = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= bytesPerPixel ? out[x - bytesPerPixel] : 0;
      const up = prevRow[x];
      const upLeft = x >= bytesPerPixel ? prevRow[x - bytesPerPixel] : 0;
      let value: number;
      switch (filter) {
        case 0: value = row[x]; break;
        case 1: value = row[x] + left; break;
        case 2: value = row[x] + up; break;
        case 3: value = row[x] + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          value = row[x] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default:
          throw new Error(`unsupported PNG filter: ${filter}`);
      }
      out[x] = value & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const src = x * bytesPerPixel;
      const dst = (y * width + x) * 4;
      pixels[dst] = out[src];
      pixels[dst + 1] = out[src + 1];
      pixels[dst + 2] = out[src + 2];
      pixels[dst + 3] = bytesPerPixel === 4 ? out[src + 3] : 255;
    }
    prevRow = out;
  }
  return { width, height, data: pixels };
}

/** Percentage (0-100) of pixels whose R, G and B channels are exactly equal. */
export function computeMatchRate(a: DecodedPng, b: DecodedPng): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`dimension mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  const total = a.width * a.height;
  if (total === 0) return 100;
  let equal = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] === b.data[i] && a.data[i + 1] === b.data[i + 1] && a.data[i + 2] === b.data[i + 2]) {
      equal++;
    }
  }
  return (equal / total) * 100;
}

/** Encode raw RGBA pixels into a PNG (filter type 0 per scanline). */
export function encodePng(width: number, height: number, data: Buffer): Buffer {
  if (data.length !== width * height * 4) {
    throw new Error(`expected ${width * height * 4} bytes of RGBA data, got ${data.length}`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

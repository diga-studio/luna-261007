# jpeg-exif-gps-strip

Strip GPS information from JPEG EXIF data, entirely in memory.
The input bytes are never modified; `stripGps` returns an independent
copy with every GPS directory removed.

## Usage

```ts
import { stripGps } from "jpeg-exif-gps-strip";

const clean: Uint8Array = stripGps(jpegBytes);
```

- Removes the GPSInfo directory (tag `0x8825`) together with its whole
  subtree from every EXIF APP1 segment, including EXIF segments that
  appear between scans of multi-scan (progressive) JPEGs.
- Preserves all non-GPS tags (types 1-12, inline and external values,
  unknown tags), directory relations (IFD0, ExifIFD `0x8769`,
  InteropIFD `0xa005`, next-IFD chains) and both byte orders.
- Value bytes shared between GPS and non-GPS tags keep the non-GPS
  portion; GPS-exclusive bytes leave no recoverable residue.
- All other JPEG segments, markers and entropy-coded scan data are
  preserved byte for byte (`FF00` escapes, restart markers and `0xff`
  padding inside scans are not mistaken for segment boundaries).
- Without GPS data the output is byte-identical to the input, and
  stripping an already-clean file never changes it again.

## Develop

```sh
npm install
npm test
```

`npm test` compiles the TypeScript sources and runs the test suite
with the Node.js built-in test runner. The only dependency is
`typescript` (dev).

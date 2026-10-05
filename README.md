# jpeg-exif-gps-strip

Strip GPS location data from the EXIF segments of JPEG files, entirely in
memory. The input bytes are never modified.

## Usage

```ts
import { stripGps } from 'jpeg-exif-gps-strip';

const cleaned: Uint8Array = stripGps(jpegBytes);
```

- Removes the GPSInfo (0x8825) pointer entries and zeroes the entire GPS IFD
  subtree: directory tables and GPS-exclusive external values.
- Non-GPS directories, tags, types, counts and values are preserved, including
  unknown tags and bytes shared between GPS and non-GPS values.
- Handles little- and big-endian TIFF (version 42), types 1-12, inline and
  external values, IFD0/ExifIFD/InteropIFD/GPSIFD and next-IFD chains.
- Handles multi-scan JPEGs and EXIF segments between scans; scan data escape
  sequences (FF00), restart markers and 0xFF fill bytes are not mistaken for
  segment boundaries. Non-EXIF APP1 segments are preserved.
- With no GPS data the output is byte-identical to the input; stripping is
  idempotent.

## Develop

```sh
npm install
npm test
```

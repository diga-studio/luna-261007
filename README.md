# stl-stream-analyzer

Streaming STL metadata analyzer in TypeScript. Feed bytes in, get format,
triangle count, SHA-256 of the raw bytes, and the bounding box / axis sizes
in inches (vertices are interpreted as millimetres; 25.4 mm = 1 in).

## API

```ts
import { StlAnalyzer } from "stl-stream-analyzer";

const analyzer = new StlAnalyzer();
analyzer.push(chunk); // Uint8Array; caller may reuse the buffer afterwards
// ... more pushes, chunks may be as small as 1 byte ...
const result = analyzer.finish(); // EOF
```

`finish()` returns a discriminated union:

```ts
type AnalyzeResult =
  | { ok: true; metadata: StlMetadata }
  | { ok: false; error: { code: "FORMAT_ERROR" | "SIZE_LIMIT_EXCEEDED" | ...; message: string } };

interface StlMetadata {
  format: "binary" | "ascii";
  triangleCount: number;
  sha256: string;                 // hex, over the raw input bytes
  boundingBox: BoundingBox | null; // inches; null when triangleCount === 0
  size: Vec3 | null;               // inches; null when triangleCount === 0
}
```

Success requires full validation through EOF; errors never carry partial
metadata. Results are identical for any chunking of the same input.

## Guarantees

- **Bounded memory**: two candidate parsers (binary + ASCII) run concurrently
  over the stream with a few fixed-size staging buffers (84 B prefix, 50 B
  record, 64 B token). No full-file buffering, no line/name accumulation,
  no temporary files, no string conversion of the input. Working memory is
  O(1) regardless of input size (test asserts < 32 MiB heap growth while
  streaming ~100 MiB including a 64 MiB solid name).
- **No prefix guessing**: a binary file whose 80-byte header starts with
  `solid` is still parsed as binary. When both grammars validate, binary
  wins; otherwise the unique valid one; otherwise `FORMAT_ERROR`.
- **Binary STL**: 80-byte header + uint32 LE count + count × 50-byte records
  (3 normal + 9 vertex LE Float32, all finite; 2 attribute bytes). Missing
  records or trailing bytes are invalid.
- **ASCII STL**: one or more `solid` blocks; strict facet grammar
  (`facet normal` ×3 nums, `outer loop`, 3 × `vertex` ×3 nums, `endloop`,
  `endfacet`); lowercase keywords; tokens separated by space/tab/CR/LF;
  `solid`/`endsolid` own their line with an optional unbounded UTF-8 name
  (validated incrementally, never stored); LF/CRLF; final `endsolid` may end
  at EOF; decimal numbers with optional sign/fraction/exponent, token ≤ 64
  bytes, finite value. Keywords, numbers and UTF-8 sequences may all straddle
  chunk boundaries.
- **Limits**: inputs over 500 MiB are rejected with `SIZE_LIMIT_EXCEEDED`.

## Develop

```sh
npm install
npm test   # tsc + node --test
```

Layout: `src/sha256.ts` (streaming SHA-256), `src/utf8.ts` (incremental
UTF-8 DFA validator), `src/binary-parser.ts`, `src/ascii-parser.ts`,
`src/analyzer.ts` (orchestration), `src/types.ts`.

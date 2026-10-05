import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Content-addressed PNG file store. Files live at <imageDir>/<sha256>.png,
 * known ids are tracked in the SQLite `images` table. Referenced ids are
 * derived from the baseline, retained runs and their pinned baselines;
 * anything else is reclaimed by collectGarbage().
 */
export class ImageStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly imageDir: string,
  ) {
    fs.mkdirSync(imageDir, { recursive: true });
  }

  /** Store a PNG, returning its image id. Reuses an existing identical image. */
  put(png: Buffer): string {
    const id = createHash('sha256').update(png).digest('hex');
    const existing = this.db.prepare(`SELECT id FROM images WHERE id = ?`).get(id);
    if (!existing) {
      const file = path.join(this.imageDir, `${id}.png`);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, png);
      fs.renameSync(tmp, file);
      this.db.prepare(`INSERT INTO images (id) VALUES (?)`).run(id);
    }
    return id;
  }

  /** Read a stored image back by id. */
  get(imageId: string): Buffer {
    return fs.readFileSync(path.join(this.imageDir, `${imageId}.png`));
  }

  /** Delete image files no longer referenced by baseline, runs or pinned baselines. */
  collectGarbage(): void {
    const referenced = new Set<string>();
    const rows = this.db
      .prepare(
        `SELECT image_id AS id FROM baseline
         UNION SELECT image_id AS id FROM run_images
         UNION SELECT baseline_image_id AS id FROM run_images WHERE baseline_image_id IS NOT NULL`,
      )
      .all() as Array<{ id: string }>;
    for (const row of rows) referenced.add(row.id);
    const stored = this.db.prepare(`SELECT id FROM images`).all() as Array<{ id: string }>;
    const known = new Set(stored.map((row) => row.id));
    const remove = this.db.prepare(`DELETE FROM images WHERE id = ?`);
    for (const { id } of stored) {
      if (!referenced.has(id)) {
        remove.run(id);
        fs.rmSync(path.join(this.imageDir, `${id}.png`), { force: true });
      }
    }
    // Reclaim orphan files left behind by rolled-back transactions.
    for (const file of fs.readdirSync(this.imageDir)) {
      if (file.endsWith('.png') && !known.has(file.slice(0, -4))) {
        fs.rmSync(path.join(this.imageDir, file), { force: true });
      }
    }
  }
}

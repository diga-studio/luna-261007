import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MetadataStore } from './db';
import { ImageStore } from './image-store';
import { computeMatchRate, decodePng } from './png';
import {
  ApproveResult,
  BaselineInfo,
  ImageComparison,
  LibraryOptions,
  RunImageData,
  RunInfo,
  ScreenshotInput,
} from './types';

const MATCH_THRESHOLD = 98;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Visual regression baseline library for a single test group.
 *
 * Metadata lives in SQLite, PNG files in a local directory. Comparison runs
 * in the background against the baseline pinned at submission time.
 */
export class VisualRegressionLibrary {
  private meta: MetadataStore;
  private images: ImageStore;
  private maxRetainedRuns: number;
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;
  private idleResolvers: Array<() => void> = [];
  private backgroundError: unknown = null;

  constructor(options: LibraryOptions) {
    mkdirSync(options.dir, { recursive: true });
    this.meta = new MetadataStore(join(options.dir, 'meta.db'));
    this.images = new ImageStore(join(options.dir, 'images'));
    this.maxRetainedRuns = options.maxRetainedRuns ?? 10;
  }

  private enqueue(job: () => Promise<void> | void): void {
    this.pending++;
    this.chain = this.chain.then(async () => {
      try {
        await job();
      } catch (err) {
        // A failed background job must not break the queue or crash the
        // process; it is recorded for inspection instead.
        if (this.backgroundError === null) {
          this.backgroundError = err;
        }
      } finally {
        this.pending--;
        if (this.pending === 0) {
          const resolvers = this.idleResolvers;
          this.idleResolvers = [];
          for (const resolve of resolvers) resolve();
        }
      }
    });
  }

  /**
   * Submit a run of named screenshots. The full current baseline is pinned
   * synchronously; comparison happens in the background.
   */
  submitRun(screenshots: ScreenshotInput[]): string {
    if (screenshots.length === 0) {
      throw new Error('a run must contain at least one screenshot');
    }
    const seen = new Set<string>();
    for (const shot of screenshots) {
      if (seen.has(shot.name)) {
        throw new Error(`duplicate screenshot name: ${shot.name}`);
      }
      seen.add(shot.name);
      decodePng(shot.png); // validate real, decodable PNG
    }

    const refs = screenshots.map((shot) => {
      const imageId = this.images.save(shot.png);
      this.meta.registerImage(imageId, this.images.pathFor(imageId));
      return { name: shot.name, imageId };
    });

    const baselineVersion = this.meta.getBaselineVersion();
    const pinnedBaseline = [...this.meta.getBaselineEntries()].map(([name, imageId]) => ({
      name,
      imageId,
    }));

    const runId = randomUUID();
    this.meta.insertRun(runId, refs, pinnedBaseline, baselineVersion);
    this.enqueue(() => this.compareRun(runId));
    return runId;
  }

  private async compareRun(runId: string): Promise<void> {
    const screenshots = this.meta.getRunImages(runId);
    const pinned = new Map(this.meta.getRunBaselineImages(runId).map((r) => [r.name, r.imageId]));
    const results: ImageComparison[] = [];
    for (const shot of screenshots) {
      await yieldToEventLoop();
      const baselineImageId = pinned.get(shot.name);
      if (baselineImageId === undefined) {
        results.push({ name: shot.name, matchRate: null, baselineExists: false, passed: false });
        continue;
      }
      const screenshotImage = decodePng(this.images.read(shot.imageId));
      const baselineImage = decodePng(this.images.read(baselineImageId));
      const matchRate = computeMatchRate(screenshotImage, baselineImage);
      results.push({
        name: shot.name,
        matchRate,
        baselineExists: true,
        passed: matchRate >= MATCH_THRESHOLD,
      });
    }
    const passed = results.every((r) => r.passed);
    this.meta.completeRun(runId, passed, results);
    this.enqueue(() => this.pruneRuns());
  }

  private pruneRuns(): void {
    this.meta.pruneCompletedRuns(this.maxRetainedRuns);
    this.enqueue(() => this.collectGarbage());
  }

  private collectGarbage(): void {
    const referenced = this.meta.listReferencedImageIds();
    const stale = this.meta.listAllImages().filter((img) => !referenced.has(img.id));
    for (const img of stale) {
      this.images.remove(img.id);
    }
    this.meta.deleteImages(stale.map((img) => img.id));
  }

  /** Query a run. Returns null once the run has been pruned. */
  getRun(runId: string): RunInfo | null {
    const row = this.meta.getRun(runId);
    if (!row) return null;
    const info: RunInfo = {
      id: row.id,
      status: row.status,
      baselineVersion: row.baselineVersion,
    };
    if (row.status === 'completed' && row.result) {
      info.passed = row.result.passed;
      info.images = row.result.images;
    }
    return info;
  }

  /** Fetch one screenshot of a run plus the baseline image actually used. */
  getRunImage(runId: string, name: string): RunImageData | null {
    if (!this.meta.getRun(runId)) return null;
    const shot = this.meta.getRunImages(runId).find((r) => r.name === name);
    if (!shot) return null;
    const baselineRef = this.meta.getRunBaselineImages(runId).find((r) => r.name === name);
    return {
      name,
      screenshot: this.images.read(shot.imageId),
      baseline: baselineRef ? this.images.read(baselineRef.imageId) : null,
    };
  }

  getBaseline(): BaselineInfo {
    return {
      version: this.meta.getBaselineVersion(),
      names: [...this.meta.getBaselineEntries().keys()].sort(),
    };
  }

  /**
   * Publish selected screenshots of a completed, retained run as the new
   * baseline. Succeeds only when `expectedVersion` matches the current
   * baseline version; failures never take partial effect.
   */
  approveBaseline(runId: string, names: string[], expectedVersion: number): ApproveResult {
    const run = this.meta.getRun(runId);
    if (!run) {
      return { ok: false, error: 'run_not_found' };
    }
    if (run.status !== 'completed') {
      return { ok: false, error: 'run_not_completed' };
    }
    if (names.length === 0) {
      return { ok: false, error: 'unknown_names' };
    }
    const runImages = this.meta.getRunImages(runId);
    const byName = new Map(runImages.map((r) => [r.name, r.imageId]));
    const entries = [];
    for (const name of names) {
      const imageId = byName.get(name);
      if (imageId === undefined) {
        return { ok: false, error: 'unknown_names' };
      }
      entries.push({ name, imageId });
    }
    const newVersion = this.meta.publishBaseline(entries, expectedVersion);
    if (newVersion === null) {
      return { ok: false, error: 'version_conflict' };
    }
    this.enqueue(() => this.collectGarbage());
    return { ok: true, baselineVersion: newVersion };
  }

  /** Resolve once comparison, pruning and image garbage collection are done. */
  waitForIdle(): Promise<void> {
    if (this.pending === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  /** First error thrown by a background job, if any. */
  getBackgroundError(): unknown {
    return this.backgroundError;
  }

  /** Wait for background work to settle, then close the database. */
  async close(): Promise<void> {
    await this.waitForIdle();
    this.meta.close();
  }
}

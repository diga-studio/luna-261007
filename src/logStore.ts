import * as fs from "node:fs";
import * as path from "node:path";
import { StepLogRef } from "./types";

const MANIFEST_NAME = "manifest.json";

interface Manifest {
  steps: StepLogRef[];
}

function sanitize(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_");
  return cleaned.length > 0 ? cleaned : "step";
}

/**
 * Writes step stdout/stderr to files under the caller-specified log directory.
 * The two streams are kept in separate files and bytes are appended in
 * arrival order, exactly as received.
 */
export class LogStore {
  readonly logDir: string;
  private readonly steps: StepLogRef[] = [];

  constructor(logDir: string) {
    this.logDir = logDir;
    fs.mkdirSync(logDir, { recursive: true });
  }

  openStep(stageIndex: number, stepIndex: number, stageName: string, stepName: string): StepLogWriter {
    const base = `${String(stageIndex).padStart(2, "0")}-${String(stepIndex).padStart(2, "0")}-${sanitize(stepName)}`;
    const ref: StepLogRef = {
      stageIndex,
      stepIndex,
      stageName,
      stepName,
      stdoutPath: path.join(this.logDir, `${base}.stdout.log`),
      stderrPath: path.join(this.logDir, `${base}.stderr.log`),
    };
    this.steps.push(ref);
    return new StepLogWriter(ref);
  }

  listSteps(): StepLogRef[] {
    return [...this.steps];
  }

  /**
   * Persist the manifest of step logs. Called once all step logs are
   * finalized, before the run reaches a terminal state.
   */
  writeManifest(): void {
    const manifest: Manifest = { steps: this.steps };
    fs.writeFileSync(path.join(this.logDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  }

  /** Read the manifest of a finished (or running) run from its log dir. */
  static readManifest(logDir: string): StepLogRef[] {
    try {
      const raw = fs.readFileSync(path.join(logDir, MANIFEST_NAME), "utf8");
      const manifest = JSON.parse(raw) as Manifest;
      return manifest.steps ?? [];
    } catch {
      return [];
    }
  }
}

export class StepLogWriter {
  readonly ref: StepLogRef;
  private readonly stdoutStream: fs.WriteStream;
  private readonly stderrStream: fs.WriteStream;

  constructor(ref: StepLogRef) {
    this.ref = ref;
    this.stdoutStream = fs.createWriteStream(ref.stdoutPath, { flags: "w" });
    this.stderrStream = fs.createWriteStream(ref.stderrPath, { flags: "w" });
  }

  writeStdout(chunk: Buffer): void {
    this.stdoutStream.write(chunk);
  }

  writeStderr(chunk: Buffer): void {
    this.stderrStream.write(chunk);
  }

  /** Flush and close both streams; resolves when all bytes are on disk. */
  finalize(): Promise<void> {
    const close = (stream: fs.WriteStream) =>
      new Promise<void>((resolve, reject) => {
        stream.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
      });
    return Promise.all([close(this.stdoutStream), close(this.stderrStream)]).then(() => undefined);
  }
}

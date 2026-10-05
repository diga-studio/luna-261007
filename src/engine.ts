import { AlertChange, Transaction } from "./types";

/** Window length: 24 hours in milliseconds. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Per-terminal live counters, evaluated at the current watermark. */
interface TerminalState {
  total: number;
  failed: number;
  alerting: boolean;
}

/** Net count delta applied to one terminal at one event time. */
interface Delta {
  total: number;
  failed: number;
}

/**
 * In-process failure-rate alert engine.
 *
 * At time t a terminal's window contains its transactions with
 * timestamp <= t and timestamp strictly greater than t - 24h.
 * The terminal alerts while failed/total strictly exceeds 5%.
 *
 * Transactions are accepted only while their timestamp is strictly
 * greater than the current watermark; the watermark certifies that all
 * data up to it is final, so later arrivals at or before it are ignored.
 */
export class AlertEngine {
  private watermark: number;
  private readonly byId = new Map<string, Transaction>();
  private readonly accepted: Transaction[] = [];
  private readonly terminals = new Map<string, TerminalState>();

  constructor(initialWatermark: number) {
    this.watermark = initialWatermark;
  }

  /**
   * Accept a batch of transactions. Records at or before the current
   * watermark are ignored; re-deliveries of an already-seen
   * transaction_id are ignored. Accepted records with a timestamp beyond
   * the watermark are stored but do not affect the current window yet.
   */
  ingest(records: Transaction[]): void {
    for (const record of records) {
      if (record.timestamp <= this.watermark) continue;
      if (this.byId.has(record.transaction_id)) continue;
      this.byId.set(record.transaction_id, record);
      this.accepted.push(record);
    }
  }

  /**
   * Monotonically advance the watermark to `t` and return every alert
   * start/end change with boundary in (previousWatermark, t].
   * All enters and exits sharing a millisecond are applied atomically
   * before the alert state is evaluated.
   */
  advanceWatermark(t: number): AlertChange[] {
    if (t < this.watermark) {
      throw new Error(
        `watermark cannot move backwards: ${t} < ${this.watermark}`
      );
    }
    if (t === this.watermark) return [];

    // Gather per-time, per-terminal deltas for every enter (at ts) and
    // exit (at ts + WINDOW_MS) falling inside (watermark, t].
    const events = new Map<number, Map<string, Delta>>();
    const addDelta = (
      time: number,
      terminalId: string,
      total: number,
      failed: number
    ): void => {
      let atTime = events.get(time);
      if (atTime === undefined) {
        atTime = new Map<string, Delta>();
        events.set(time, atTime);
      }
      const delta = atTime.get(terminalId);
      if (delta === undefined) {
        atTime.set(terminalId, { total, failed });
      } else {
        delta.total += total;
        delta.failed += failed;
      }
    };

    for (const tx of this.accepted) {
      if (tx.timestamp > this.watermark && tx.timestamp <= t) {
        addDelta(
          tx.timestamp,
          tx.terminal_id,
          1,
          tx.status === "failed" ? 1 : 0
        );
      }
      const exitAt = tx.timestamp + WINDOW_MS;
      if (exitAt > this.watermark && exitAt <= t) {
        addDelta(
          exitAt,
          tx.terminal_id,
          -1,
          tx.status === "failed" ? -1 : 0
        );
      }
    }

    const times = Array.from(events.keys()).sort((a, b) => a - b);
    const changes: AlertChange[] = [];
    for (const time of times) {
      const atTime = events.get(time)!;
      // Apply every delta of this millisecond first, then evaluate.
      const touched: string[] = [];
      for (const [terminalId, delta] of atTime) {
        const state = this.terminals.get(terminalId) ?? {
          total: 0,
          failed: 0,
          alerting: false,
        };
        state.total += delta.total;
        state.failed += delta.failed;
        this.terminals.set(terminalId, state);
        touched.push(terminalId);
      }
      touched.sort();
      for (const terminalId of touched) {
        const state = this.terminals.get(terminalId)!;
        // Strictly above 5%, computed in integers: failed/total > 1/20.
        const alerting = state.failed * 20 > state.total;
        if (alerting !== state.alerting) {
          state.alerting = alerting;
          changes.push({
            terminal_id: terminalId,
            type: alerting ? "start" : "end",
            timestamp: time,
          });
        }
      }
    }

    this.watermark = t;
    return changes;
  }
}

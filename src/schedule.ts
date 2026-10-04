/** Minimum gap between the first start of an attempt and the start of the next attempt. */
export const RETRY_DELAY_MS = 10 * 60 * 1000;

/** Total attempts per notification: 1 initial delivery + up to 3 retries. */
export const MAX_ATTEMPTS = 4;

/**
 * Non-critical notifications may only START a delivery within
 * [08:00, 18:00) UTC of each day. Critical notifications are unrestricted.
 */
export function isDeliveryWindowOpen(now: number, critical: boolean): boolean {
  if (critical) return true;
  const hour = new Date(now).getUTCHours();
  return hour >= 8 && hour < 18;
}

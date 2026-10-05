import { openDatabase } from './database.js';
import { AccessReviewService } from './service.js';

export * from './types.js';
export { AccessReviewService } from './service.js';
export { REVIEW_PERIOD_MS } from './service.js';
export { openDatabase } from './database.js';

export function createService(path: string): AccessReviewService {
  return new AccessReviewService(openDatabase(path));
}

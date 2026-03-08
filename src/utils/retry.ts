import { logger } from '../logger.js';

export const MAX_RETRIES = 5;
export const BASE_RETRY_MS = 5000;
const BACKOFF_BASE = 2;

/**
 * Increment retryCount and schedule a retry callback with exponential backoff.
 * Returns the updated retryCount (0 if max retries exceeded and counter was reset).
 */
export function scheduleRetry(groupJid: string, retryCount: number, onRetry: () => void, isShuttingDown: () => boolean): number {
  const newCount = retryCount + 1;

  if (newCount > MAX_RETRIES) {
    logger.error({ groupJid, retryCount: newCount }, 'Max retries exceeded, dropping messages (will retry on next incoming message)');

    return 0;
  }

  const delayMs = BASE_RETRY_MS * Math.pow(BACKOFF_BASE, newCount - 1);

  logger.info({ groupJid, retryCount: newCount, delayMs }, 'Scheduling retry with backoff');
  setTimeout(() => {
    if (!isShuttingDown()) onRetry();
  }, delayMs);

  return newCount;
}

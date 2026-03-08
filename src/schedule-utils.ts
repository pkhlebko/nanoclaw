import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from './config.js';

/** Thrown by {@link computeNextRun} when the schedule value is malformed. */
export class InvalidScheduleError extends Error {
  constructor(
    message: string,
    /** The schedule value that failed validation. */
    public readonly scheduleValue: string,
  ) {
    super(message);
    this.name = 'InvalidScheduleError';
  }
}

/**
 * Computes the next ISO timestamp for a scheduled task.
 *
 * @param scheduleType - One of `'cron'`, `'interval'`, or `'once'`.
 * @param scheduleValue - Cron expression, milliseconds string, or ISO timestamp.
 * @param postRun - When `true`, `'once'` tasks return `null` (no recurrence after first run).
 * @returns The next run ISO string, or `null` for non-recurring `'once'` tasks after running.
 * @throws {@link InvalidScheduleError} if `scheduleValue` is invalid.
 */
export function computeNextRun(scheduleType: 'cron' | 'interval' | 'once', scheduleValue: string, postRun = false): string | null {
  if (scheduleType === 'cron') {
    // CronExpressionParser.parse throws its own error on bad expressions
    const interval = CronExpressionParser.parse(scheduleValue, { tz: TIMEZONE });

    return interval.next().toISOString();
  }

  if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);

    if (isNaN(ms) || ms <= 0) {
      throw new InvalidScheduleError('Invalid interval value', scheduleValue);
    }

    return new Date(Date.now() + ms).toISOString();
  }

  // 'once'
  if (postRun) {
    return null;
  }

  const scheduled = new Date(scheduleValue);

  if (isNaN(scheduled.getTime())) {
    throw new InvalidScheduleError('Invalid timestamp for once schedule', scheduleValue);
  }

  return scheduled.toISOString();
}

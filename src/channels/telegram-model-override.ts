import { MODEL_OVERRIDE_TIMEOUT } from '../config.js';

export class ModelOverrideManager {
  private readonly overrides = new Map<string, string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly onExpired: (jid: string) => void) {}

  get(jid: string): string | undefined {
    return this.overrides.get(jid);
  }

  set(jid: string, model: string): void {
    this.overrides.set(jid, model);
    this.resetTimer(jid);
  }

  clear(jid: string): void {
    const timer = this.timers.get(jid);

    if (timer) clearTimeout(timer);

    this.timers.delete(jid);
    this.overrides.delete(jid);
  }

  clearAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);

    this.timers.clear();
    this.overrides.clear();
  }

  /** Resets the inactivity timer if an override is currently active. */
  refresh(jid: string): void {
    if (this.overrides.has(jid)) {
      this.resetTimer(jid);
    }
  }

  private resetTimer(jid: string): void {
    const existing = this.timers.get(jid);

    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.overrides.delete(jid);
      this.timers.delete(jid);
      this.onExpired(jid);
    }, MODEL_OVERRIDE_TIMEOUT);

    this.timers.set(jid, timer);
  }
}

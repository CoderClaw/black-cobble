/** Only a new session or foreground input changes the inactivity deadline. */
export class PrivateSessionTimer {
  private sessionId: string | null = null;
  private deadline = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly timeoutMs: number,
    private readonly expire: () => void,
    private readonly now: () => number = Date.now,
    private readonly schedule: typeof setTimeout = setTimeout,
    private readonly cancel: typeof clearTimeout = clearTimeout,
  ) {}

  setSession(sessionId: string | null): void {
    if (this.sessionId === sessionId) return;
    this.stop();
    this.sessionId = sessionId;
    if (sessionId) { this.deadline = this.now() + this.timeoutMs; this.arm(); }
  }

  check(): boolean {
    if (!this.sessionId || this.now() < this.deadline) return false;
    this.stop();
    this.expire();
    return true;
  }

  activity(): void {
    // An input received after suspension must not resurrect an expired session.
    if (this.check() || !this.sessionId) return;
    this.deadline = this.now() + this.timeoutMs;
    this.arm();
  }

  stop(): void {
    if (this.timer) this.cancel(this.timer);
    this.timer = undefined;
    this.sessionId = null;
    this.deadline = 0;
  }

  private arm(): void {
    if (this.timer) this.cancel(this.timer);
    this.timer = this.schedule(() => {
      this.timer = undefined;
      if (!this.check() && this.sessionId) this.arm();
    }, Math.max(1, this.deadline - this.now()));
    this.timer.unref?.();
  }
}

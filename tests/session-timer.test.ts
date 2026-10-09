import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrivateSessionTimer } from '../electron/session-timer';

afterEach(() => vi.useRealTimers());

describe('private inactivity deadline', () => {
  it('expires after ten minutes and repeated session notifications do not extend it', () => {
    vi.useFakeTimers();
    const expire = vi.fn();
    const timer = new PrivateSessionTimer(600_000, expire);
    timer.setSession('first');
    vi.advanceTimersByTime(500_000);
    timer.setSession('first');
    vi.advanceTimersByTime(100_000);
    expect(expire).toHaveBeenCalledTimes(1);
  });

  it('extends only on activity before the deadline', () => {
    vi.useFakeTimers();
    const expire = vi.fn();
    const timer = new PrivateSessionTimer(600_000, expire);
    timer.setSession('first');
    vi.advanceTimersByTime(500_000);
    timer.activity();
    vi.advanceTimersByTime(599_999);
    expect(expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expire).toHaveBeenCalledTimes(1);
  });

  it('checks suspension before accepting late input', () => {
    vi.useFakeTimers();
    let now = 0;
    const expire = vi.fn();
    const timer = new PrivateSessionTimer(600_000, expire, () => now);
    timer.setSession('first');
    now = 700_000;
    timer.activity();
    expect(expire).toHaveBeenCalledTimes(1);
    expect(timer.check()).toBe(false);
  });

  it('cancels old session timers when locking or replacing the vault session', () => {
    vi.useFakeTimers();
    const expire = vi.fn();
    const timer = new PrivateSessionTimer(600_000, expire);
    timer.setSession('first');
    vi.advanceTimersByTime(500_000);
    timer.setSession(null);
    vi.advanceTimersByTime(200_000);
    expect(expire).not.toHaveBeenCalled();
    timer.setSession('second');
    vi.advanceTimersByTime(600_000);
    expect(expire).toHaveBeenCalledTimes(1);
  });
});

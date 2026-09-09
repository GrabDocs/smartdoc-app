import { useCallback, useEffect, useRef } from 'react';
import { useSyncExternalStore } from 'react';
import { formatRemainingCountdown, parseUtcMs } from '../utils/timeFormatting';

/** Soft anti-spam lock for outbound invite / remind / resend actions. */
export const RESEND_COOLDOWN_MS = 60_000;

export { formatRemainingCountdown };

const lastSentAt = new Map<string, number>();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function resendCooldownKey(...parts: Array<string | number>): string {
  return parts.join(':');
}

export function getResendRemainingSec(key: string, cooldownMs = RESEND_COOLDOWN_MS): number {
  const last = lastSentAt.get(key);
  if (last == null) return 0;
  const rem = Math.ceil((last + cooldownMs - Date.now()) / 1000);
  if (rem <= 0) return 0;
  return Math.min(rem, Math.ceil(cooldownMs / 1000));
}

export function markResendSent(key: string, atMs = Date.now()): void {
  const prev = lastSentAt.get(key) ?? 0;
  if (atMs >= prev) {
    lastSentAt.set(key, atMs);
    emit();
  }
}

/** Prefer server timestamp when it is newer than any in-session mark. Naive ISO is UTC. */
export function seedResendFromServer(key: string, iso: string | null | undefined): void {
  if (!iso) return;
  const t = parseUtcMs(iso);
  if (Number.isNaN(t)) return;
  markResendSent(key, t);
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

/**
 * Session-scoped soft cooldown for resend/remind buttons.
 * Survives remounts via module Map; optionally seeded from server `*_at` fields.
 */
export function useResendCooldown(
  key: string | null | undefined,
  options?: { cooldownMs?: number; serverSentAt?: string | null },
) {
  const cooldownMs = options?.cooldownMs ?? RESEND_COOLDOWN_MS;
  const serverSentAt = options?.serverSentAt;
  const seededKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!key || !serverSentAt) return;
    // Re-seed when key or server timestamp identity changes.
    const seedToken = `${key}|${serverSentAt}`;
    if (seededKeyRef.current === seedToken) return;
    seededKeyRef.current = seedToken;
    seedResendFromServer(key, serverSentAt);
  }, [key, serverSentAt]);

  const getSnapshot = useCallback(() => {
    if (!key) return 0;
    return getResendRemainingSec(key, cooldownMs);
  }, [key, cooldownMs]);

  const remainingSec = useSyncExternalStore(subscribe, getSnapshot, () => 0);
  const isCoolingDown = remainingSec > 0;

  useEffect(() => {
    if (!key || !isCoolingDown) return;
    const id = setInterval(() => emit(), 1000);
    return () => clearInterval(id);
  }, [key, isCoolingDown]);

  const markSent = useCallback(() => {
    if (!key) return;
    markResendSent(key);
  }, [key]);

  return { remainingSec, isCoolingDown, markSent };
}

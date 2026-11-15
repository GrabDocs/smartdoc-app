/** Letter on screen after Regenerate, plus the letter that click cleared. */
export type RegenViewLock = {
  gen: number;
  body: string;
  replaced: string | null;
};

/**
 * What the composer should show.
 * The regenerate result replaces the previous letter.
 * A later event or save that still carries that cleared letter does not.
 */
export function resolveComposerBody(args: {
  current: string;
  incoming: string | null | undefined;
  incomingGenSeq?: number | null;
  lock: RegenViewLock | null;
  inFlight: boolean;
  source: 'user' | 'save' | 'generate' | 'reload';
}): { body: string; accept: boolean; reason: string } {
  const incoming = args.incoming ?? '';
  if (args.source === 'generate') {
    return { body: incoming, accept: true, reason: 'generate-result' };
  }
  if (args.inFlight) {
    return {
      body: args.lock ? args.lock.body : args.current,
      accept: false,
      reason: 'generate-in-flight',
    };
  }
  const lock = args.lock;
  if (lock && lock.replaced != null && incoming === lock.replaced && incoming !== lock.body) {
    return { body: lock.body, accept: false, reason: 'stale-replaced-body' };
  }
  if (
    lock
    && args.incomingGenSeq != null
    && Number.isFinite(Number(args.incomingGenSeq))
    && Number(args.incomingGenSeq) < lock.gen
    && incoming !== lock.body
  ) {
    return { body: lock.body, accept: false, reason: 'older-gen-seq' };
  }
  return { body: incoming, accept: true, reason: 'accept' };
}

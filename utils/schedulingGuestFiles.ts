export type QueuedGuestFile = { fileId: number; name: string };

const queued: QueuedGuestFile[] = [];

/** Scanner saves a guest file here, then scheduling picks it up on focus. */
export function queueGuestFile(file: QueuedGuestFile) {
  queued.push(file);
}

export function takeQueuedGuestFiles(): QueuedGuestFile[] {
  if (!queued.length) return [];
  return queued.splice(0, queued.length);
}

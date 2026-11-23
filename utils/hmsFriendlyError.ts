/**
 * Map HMS / iOS AVAudioSession failures to user-facing copy.
 * Keep in sync with room-kit `friendlyHmsError.ts` (patched).
 */
export function getFriendlyHmsErrorMessage(rawMessage: string, code?: string | number | null): string {
  const codeStr = code == null ? '' : String(code);
  const raw = rawMessage || '';

  const isAudioSessionFailure =
    codeStr === '3015' ||
    /audio session activation failure/i.test(raw) ||
    /session activation failed/i.test(raw) ||
    /561017449/.test(raw) ||
    /cannotinterruptothers/i.test(raw) ||
    (/\[code:\s*3015/i.test(raw) && /publish/i.test(raw));

  if (isAudioSessionFailure) {
    return "GrabDocs can't use the microphone because another call or app is using audio on this device. End the phone call (or other audio), then try joining again.";
  }

  // Usually a corrupted navigation stack after minimize→Home; a clean retry fixes it.
  if (/cannot read propert(y|ies) ['"]?state['"]? of null/i.test(raw)) {
    return 'Something went wrong opening the meeting. Go back and try joining again. If it keeps happening, fully close GrabDocs and reopen it.';
  }

  return raw;
}

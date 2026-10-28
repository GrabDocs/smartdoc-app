const NAME_LINK_RE =
  /https?:\/\/|ftp:\/\/|www\.|:\/\/|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b|\b(?:[a-z0-9-]+\.)+(?:com|net|org|edu|gov|io|co|app|dev|info|biz|xyz|me|tv|cc|site|online)\b/i;

export const NAME_NOT_A_WEB_ADDRESS_MESSAGE = 'Enter a name, not a web address or email';

export function nameLooksLikeWebAddress(value?: string | null): boolean {
  return NAME_LINK_RE.test((value || '').trim());
}

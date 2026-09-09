/** Mobile chat header/list title display cap (ellipsis when longer). */
export const CHAT_HEADER_TITLE_MAX_LENGTH = 20;

/** Client name in Ask banner / placeholder — keep short so the row doesn't overflow. */
export const ASK_CLIENT_NAME_MAX_LENGTH = 24;

/**
 * Truncate text with ASCII "..." when over maxLength.
 */
export function truncateWithEllipsis(
  value: string | null | undefined,
  maxLength: number,
  emptyFallback = '',
): string {
  const text = String(value ?? '').trim();
  if (!text) return emptyFallback;
  if (text.length <= maxLength) return text;
  const cut = Math.max(1, maxLength - 3);
  return `${text.slice(0, cut).trimEnd()}...`;
}

/**
 * Truncate a chat title for mobile header/list display.
 * Uses ASCII "..." so it stays consistent across platforms.
 */
export function truncateChatHeaderTitle(
  title: string | null | undefined,
  maxLength: number = CHAT_HEADER_TITLE_MAX_LENGTH,
): string {
  return truncateWithEllipsis(title, maxLength, 'Chat');
}

/** Truncate any mobile nav header title to the standard cap (20 chars). */
export function truncateAppHeaderTitle(
  title: string | null | undefined,
  emptyFallback = '',
): string {
  return truncateWithEllipsis(title, CHAT_HEADER_TITLE_MAX_LENGTH, emptyFallback);
}

/**
 * Truncate a client display name for Ask UI (banner + composer placeholder).
 */
export function truncateAskClientName(
  name: string | null | undefined,
  maxLength: number = ASK_CLIENT_NAME_MAX_LENGTH,
): string {
  return truncateWithEllipsis(name, maxLength, 'Client');
}

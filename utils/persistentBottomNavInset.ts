/** Matches app/components/PersistentBottomNavigation styles. */
const TAB_BAR_MIN_HEIGHT = 56;
const TAB_BAR_PADDING_TOP = 5;

const TAB_ROOTS = new Set(['index', 'documents', 'chats', 'help', 'settings']);

/** Bottom bar on main shell routes. Nested calendar screens keep header/back only. */
export function shouldShowPersistentBottomNav(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const p = pathname;

  // Main calendar list/shell — not create/detail/edit/etc.
  if (p === '/calendar' || p === '/calendar/') return true;
  if (p.startsWith('/calendar/')) return false;

  // Notes list — not edit / deleted / nested screens.
  if (p === '/drafts' || p === '/drafts/') return true;
  if (p.startsWith('/drafts/')) return false;

  // Expo Router may include or omit the "(tabs)" group in usePathname().
  if (p === '/' || p === '/index' || p === '/(tabs)' || p === '/(tabs)/' || p === '/(tabs)/index') {
    return true;
  }

  if (p.startsWith('/(tabs)/')) {
    const root = p.replace(/^\/\(tabs\)\//, '').split('/')[0] || 'index';
    return TAB_ROOTS.has(root);
  }

  // Ungrouped tab paths: "/documents", "/chats", …
  const root = p.replace(/^\//, '').split('/')[0] || '';
  return TAB_ROOTS.has(root);
}

/** Total height of PersistentBottomNavigation (for sheet bottom anchoring). */
export function persistentBottomNavInset(safeAreaBottom: number): number {
  return TAB_BAR_MIN_HEIGHT + TAB_BAR_PADDING_TOP + Math.max(safeAreaBottom, 5);
}

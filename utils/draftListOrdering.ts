import type { DraftListItem } from './createUntitledDraft';
import { parseAsUTC } from './timeFormatting';

export function getSectionKey(date: Date): string {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const startOf7DaysAgo = new Date(startOfToday);
  startOf7DaysAgo.setDate(startOf7DaysAgo.getDate() - 7);
  const startOf30DaysAgo = new Date(startOfToday);
  startOf30DaysAgo.setDate(startOf30DaysAgo.getDate() - 30);

  const d = new Date(date);
  d.setHours(0, 0, 0, 0);

  if (d.getTime() === startOfToday.getTime()) return 'today';
  if (d.getTime() === startOfYesterday.getTime()) return 'yesterday';
  if (d.getTime() > startOf7DaysAgo.getTime()) return 'last7';
  if (d.getTime() > startOf30DaysAgo.getTime()) return 'last30';
  return `month-${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function groupDraftsForList(filteredDrafts: DraftListItem[]) {
  const map = new Map<string, DraftListItem[]>();
  const sectionOrder: string[] = [];

  filteredDrafts.forEach((d) => {
    const raw = d.updated_at || d.created_at;
    const date = raw ? parseAsUTC(raw) : new Date();
    const key = getSectionKey(date);
    if (!map.has(key)) {
      map.set(key, []);
      sectionOrder.push(key);
    }
    map.get(key)!.push(d);
  });

  const fixed = ['today', 'yesterday', 'last7', 'last30'];
  sectionOrder.sort((a, b) => {
    const pa = fixed.indexOf(a);
    const pb = fixed.indexOf(b);
    if (pa !== -1 && pb !== -1) return pa - pb;
    if (pa !== -1) return -1;
    if (pb !== -1) return 1;
    return b.localeCompare(a);
  });

  return sectionOrder
    .map((key) => ({ key, items: map.get(key)! }))
    .filter((g) => g.items.length > 0);
}

/** Flatten grouped drafts in the same order as the list UI renders them. */
export function flattenVisibleDrafts(filteredDrafts: DraftListItem[]): DraftListItem[] {
  return groupDraftsForList(filteredDrafts).flatMap((g) => g.items);
}

export function selectNextDraftIdAfterDelete(
  deletedId: number,
  snapshot: DraftListItem[],
): number | null {
  const index = snapshot.findIndex((d) => d.id === deletedId);
  if (index === -1) return null;
  if (index + 1 < snapshot.length) return snapshot[index + 1].id;
  if (index - 1 >= 0) return snapshot[index - 1].id;
  return null;
}

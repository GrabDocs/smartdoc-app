/** Fold primary email + authorized_senders into one editable list. */

export type IntakeSenderForm = { name: string; email: string };

export function buildIntakeSenderList(
  authorized: { name?: string | null; email?: string | null }[] | null | undefined,
  primaryEmail?: string | null,
): IntakeSenderForm[] {
  const senders: IntakeSenderForm[] = [];
  const seen = new Set<string>();

  for (const entry of authorized || []) {
    const email = (entry?.email || '').trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    senders.push({ name: (entry?.name || '').trim(), email });
  }

  const primary = (primaryEmail || '').trim();
  if (primary) {
    const key = primary.toLowerCase();
    if (!seen.has(key)) {
      senders.unshift({ name: '', email: primary });
    }
  }

  return senders.length ? senders : [{ name: '', email: '' }];
}

export function primaryEmailFromSenders(senders: { email: string }[]): string | null {
  const first = senders.find((s) => s.email.trim());
  return first ? first.email.trim() : null;
}

export function hasSenderEmail(senders: { email: string }[]): boolean {
  return senders.some((s) => s.email.trim());
}

/** Prefill first empty email slot (or replace empty list) with client primary. */
export function prefillSendersWithEmail(
  senders: IntakeSenderForm[],
  email: string,
): IntakeSenderForm[] {
  const pe = email.trim();
  if (!pe) return senders;
  if (hasSenderEmail(senders)) return senders;
  if (!senders.length) return [{ name: '', email: pe }];
  const next = [...senders];
  next[0] = { ...next[0], email: pe };
  return next;
}

export type IntakeChecklistEditItem = {
  id?: number;
  label: string;
  description: string;
  required: boolean;
};

export function checklistItemsFromIntake(
  items: { id: number; label: string; description?: string | null; required?: boolean }[] | null | undefined,
): IntakeChecklistEditItem[] {
  const list = (items || []).map((i) => ({
    id: i.id,
    label: i.label || '',
    description: i.description || '',
    required: i.required !== false,
  }));
  return list.length ? list : [{ label: '', description: '', required: true }];
}

/** Create / update / delete checklist rows to match the edit form. */
export async function syncIntakeChecklistItems(
  intakeId: number,
  originalItems: { id: number; label: string; description?: string | null; required?: boolean }[],
  editedItems: IntakeChecklistEditItem[],
  api: {
    add: (intakeId: number, data: { label: string; description?: string | null; required?: boolean }) => Promise<unknown>;
    update: (
      intakeId: number,
      itemId: number,
      data: { label?: string; description?: string | null; required?: boolean },
    ) => Promise<unknown>;
    remove: (intakeId: number, itemId: number) => Promise<unknown>;
  },
): Promise<void> {
  const valid = editedItems.filter((i) => i.label.trim());
  const keptIds = new Set(valid.map((i) => i.id).filter((id): id is number => typeof id === 'number'));

  for (const orig of originalItems) {
    if (!keptIds.has(orig.id)) {
      await api.remove(intakeId, orig.id);
    }
  }

  for (const item of valid) {
    const label = item.label.trim();
    const description = item.description.trim() || null;
    if (item.id != null) {
      const orig = originalItems.find((o) => o.id === item.id);
      if (
        !orig ||
        orig.label !== label ||
        (orig.description || '') !== (description || '') ||
        (orig.required !== false) !== item.required
      ) {
        await api.update(intakeId, item.id, {
          label,
          description,
          required: item.required,
        });
      }
    } else {
      await api.add(intakeId, { label, description, required: item.required });
    }
  }
}

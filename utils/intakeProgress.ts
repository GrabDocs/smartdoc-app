/** Format intake checklist progress for list/detail UI. */

export type IntakeProgressLike = {
  received: number;
  total: number;
  percent: number;
  not_applicable?: number;
  done?: number;
};

/** e.g. "1 of 2 documents received · 1 N/A · 100%" */
export function formatIntakeProgressLabel(
  progress: IntakeProgressLike,
  opts?: { completeSuffix?: boolean },
): string {
  const received = progress.received ?? 0;
  const total = progress.total ?? 0;
  const percent = progress.percent ?? 0;
  const na = progress.not_applicable ?? 0;
  const parts = [`${received} of ${total} documents received`];
  if (na > 0) {
    parts.push(`${na} N/A`);
  }
  parts.push(opts?.completeSuffix ? `${percent}% Complete` : `${percent}%`);
  return parts.join(' · ');
}

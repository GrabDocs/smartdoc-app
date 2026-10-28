/**
 * User-facing plan summary for AI File Manager chat (no raw ops JSON / IDs / timestamps).
 * Ported from web frontend/src/components/ai-file-manager/formatPlanPreview.ts
 */

type PlanOp = {
  op?: string;
  file_id?: number;
  bookmark_id?: number;
  folder_id?: number;
  folder_name?: string;
  from_parent_folder_id?: number | null;
  to_folder_id?: number | null;
  name?: string;
  parent_folder_id?: number | null;
  new_filename?: string;
  new_name?: string;
  old_name?: string;
  to_folder_name?: string;
  match_reason?: string;
  resolution_trace?: string[];
  file_count?: number;
  subfolder_count?: number;
};

function previewNameMap(plan: Record<string, unknown>): Map<number, string> {
  const m = new Map<number, string>();
  const prev = plan.resolved_files_preview;
  if (!Array.isArray(prev)) return m;
  for (const row of prev) {
    if (!row || typeof row !== 'object') continue;
    const r = row as { file_id?: number; original_filename?: string };
    const id = Number(r.file_id);
    const name = String(r.original_filename || '');
    if (!Number.isNaN(id) && name) m.set(id, name);
  }
  return m;
}

function collectResolverClauses(plan: Record<string, unknown>): Set<string> {
  const clauses = new Set<string>();
  const ops = (plan.operations as PlanOp[]) || [];

  for (const op of ops.slice(0, 40)) {
    const traces = op.resolution_trace || [];
    for (const raw of traces) {
      const s = String(raw).trim();
      if (s.startsWith('Matched filter:')) {
        clauses.add(s.replace(/^Matched filter:\s*/i, '').trim());
      }
    }
  }

  const agg = plan.aggregate_breakdown as { breakdown?: Array<{ label?: string }> } | undefined;
  if (clauses.size === 0 && Array.isArray(agg?.breakdown)) {
    for (const b of agg.breakdown) {
      const lab = typeof b.label === 'string' ? b.label.trim() : '';
      if (lab) clauses.add(lab);
    }
  }

  return clauses;
}

function humanizeClauseLine(clause: string): string {
  const c = clause.trim();
  const eqName = c.match(/^original_filename\s+eq\s+(.+)$/i);
  if (eqName) return `exact filename = "${eqName[1].trim()}"`;
  const ctName = c.match(/^original_filename\s+contains\s+(.+)$/i);
  if (ctName) return `name contains "${ctName[1].trim()}"`;
  const eqFn = c.match(/^folder_name\s+eq\s+(.+)$/i);
  if (eqFn) return `folder name = "${eqFn[1].trim()}"`;
  const eqFid = c.match(/^folder_id\s+eq\s+(\d+)/i);
  if (eqFid) return `folder id ${eqFid[1]}`;
  const nullFolder = c.match(/^folder_id\s+is_null$/i);
  if (nullFolder) return 'workspace top level (no folder)';
  return c.length > 140 ? `${c.slice(0, 137)}…` : c;
}

function rowMatchesOpenFolder(rowFolder: number | null | undefined, uiFolderId: number | null | undefined): boolean {
  if (uiFolderId == null || uiFolderId === undefined) {
    return rowFolder == null || rowFolder === undefined;
  }
  return Number(rowFolder) === Number(uiFolderId);
}

function formatMatchingExplanation(plan: Record<string, unknown>): string | null {
  const total = typeof plan.total_count === 'number' ? plan.total_count : 0;
  if (total <= 0) return null;

  const ops = (plan.operations as PlanOp[]) || [];
  const fileOps = ops.filter((o) => {
    const k = String(o?.op || '').toLowerCase();
    return k && k !== 'rename_folder' && k !== 'create_folder' && k !== 'move_folder';
  });
  if (fileOps.length === 0) return null;

  const previewRows =
    (plan.resolved_files_preview as Array<{ original_filename?: string; folder_id?: number | null }>) || [];
  const clauses = collectResolverClauses(plan);

  if (clauses.size === 0) return null;

  const mc = plan.match_context as { current_folder_id?: number | null } | undefined;
  const uiFolderId = mc?.current_folder_id;
  const previewCoversTotal = previewRows.length >= total;
  const allResolvedInUiFolder =
    previewCoversTotal && previewRows.slice(0, total).every((r) => rowMatchesOpenFolder(r.folder_id, uiFolderId));

  const lines: string[] = [];

  const clauseArr = Array.from(clauses);
  const eqFilename = clauseArr.find((x) => /^original_filename\s+eq\s+/i.test(x));
  const ctFilename = clauseArr.find((x) => /^original_filename\s+contains\s+/i.test(x));

  if (eqFilename && total === 1 && previewRows[0]?.original_filename) {
    lines.push(`Matched exact filename: "${previewRows[0].original_filename}"`);
    if (allResolvedInUiFolder) {
      lines.push('That file is in the folder you currently have open in Files.');
    }
  } else if (eqFilename) {
    const m = eqFilename.match(/^original_filename\s+eq\s+(.+)$/i);
    const literal = m ? m[1].trim() : eqFilename;
    lines.push(`Matched ${total} file(s) using exact filename "${literal}".`);
    if (allResolvedInUiFolder) {
      lines.push('All of them are in the folder you currently have open in Files.');
    }
  } else if (ctFilename) {
    const m = ctFilename.match(/^original_filename\s+contains\s+(.+)$/i);
    const needle = m ? m[1].trim() : '';
    lines.push(`Matched ${total} file(s) whose names contain "${needle}".`);
    if (allResolvedInUiFolder) {
      lines.push('All matched files are in the folder you currently have open in Files.');
    }
  } else {
    lines.push(`Matched ${total} owned file(s) using:`);
    for (const c of clauseArr.slice(0, 8)) {
      lines.push(`  • ${humanizeClauseLine(c)}`);
    }
    if (clauses.size > 8) lines.push(`  • …and ${clauses.size - 8} more filter(s)`);
    if (allResolvedInUiFolder) {
      lines.push('All matched files are in the folder you currently have open in Files.');
    }
  }

  return `\n\nMatching\n${lines.join('\n')}`;
}

function planHasFileMutations(plan: Record<string, unknown>): boolean {
  const ops = (plan.operations as PlanOp[]) || [];
  return ops.some((o) => {
    const k = String(o?.op || '').toLowerCase();
    return (
      k === 'rename' ||
      k === 'move' ||
      k === 'soft_delete' ||
      k === 'delete_folder' ||
      k === 'restore_folder' ||
      k === 'purge_empty_folders' ||
      k === 'rename_folder' ||
      k === 'create_folder' ||
      k === 'move_folder' ||
      k === 'organize' ||
      k === 'restore_from_trash' ||
      k === 'copy_file'
    );
  });
}

function filenameListFromPlan(plan: Record<string, unknown>): string[] {
  const prev = plan.resolved_files_preview;
  if (Array.isArray(prev) && prev.length > 0) {
    const names: string[] = [];
    for (const row of prev) {
      if (row && typeof row === 'object' && 'original_filename' in row) {
        const n = String((row as { original_filename?: string }).original_filename || '').trim();
        if (n) names.push(n);
      }
    }
    if (names.length > 0) return names;
  }
  const strat = plan.resolved_files_preview_stratified as unknown[] | undefined;
  if (!Array.isArray(strat) || strat.length === 0) return [];
  const out: string[] = [];
  for (const row of strat) {
    if (row && typeof row === 'object' && 'original_filename' in row) {
      const n = String((row as { original_filename?: string }).original_filename || '').trim();
      if (n) out.push(n);
    }
  }
  return out;
}

function formatOperationLines(ops: unknown[], nameById: Map<number, string>): string[] {
  const lines: string[] = [];
  let i = 0;
  for (const raw of ops.slice(0, 40)) {
    if (!raw || typeof raw !== 'object') continue;
    const op = raw as PlanOp;
    const kind = String(op.op || '').toLowerCase();
    const fid = op.file_id != null ? Number(op.file_id) : NaN;
    const oldName =
      !Number.isNaN(fid) && nameById.has(fid) ? nameById.get(fid)! : 'Selected file';

    if (kind === 'rename') {
      const to = String(op.new_filename || '?');
      lines.push(`${i + 1}. ${oldName} → ${to}`);
    } else if (kind === 'move') {
      const dest = String(op.to_folder_name || '').trim();
      lines.push(dest ? `${i + 1}. Move ${oldName} → ${dest}` : `${i + 1}. Move ${oldName}`);
    } else if (kind === 'soft_delete') {
      lines.push(`${i + 1}. Move ${oldName} to trash`);
    } else if (kind === 'restore_from_trash') {
      lines.push(`${i + 1}. Restore ${oldName} from trash`);
    } else if (kind === 'copy_file') {
      const dest = String((op as { to_folder_name?: string }).to_folder_name || '').trim();
      const toName = String((op as { new_filename?: string }).new_filename || '').trim();
      const tail = dest ? ` → ${dest}` : '';
      const nameHint = toName && toName !== oldName ? ` as "${toName}"` : '';
      lines.push(`${i + 1}. Copy ${oldName}${nameHint}${tail}`);
    } else if (kind === 'rename_folder') {
      const to = String(op.new_name || '?');
      const from = String(op.old_name || '').trim();
      lines.push(from ? `${i + 1}. Rename folder "${from}" → "${to}"` : `${i + 1}. Rename folder → ${to}`);
    } else if (kind === 'create_folder') {
      const nm = String(op.name || '?').trim();
      const pid = op.parent_folder_id;
      lines.push(
        pid != null && !Number.isNaN(Number(pid))
          ? `${i + 1}. Create folder "${nm}" (inside folder #${Number(pid)})`
          : `${i + 1}. Create folder "${nm}" at workspace top level`,
      );
    } else if (kind === 'delete_folder') {
      const nm = String(op.folder_name || '').trim() || `folder #${op.folder_id ?? '?'}`;
      const fileCount = typeof op.file_count === 'number' ? op.file_count : null;
      const subCount = typeof op.subfolder_count === 'number' ? op.subfolder_count : null;
      const parts: string[] = [];
      if (fileCount !== null) parts.push(`${fileCount} file(s)`);
      if (subCount !== null && subCount > 0) parts.push(`${subCount} subfolder(s)`);
      const contentsNote = parts.length ? ` (${parts.join(', ')} inside)` : ' (empty)';
      lines.push(`${i + 1}. Move folder "${nm}" to trash${contentsNote}`);
    } else if (kind === 'restore_folder') {
      const nm = String(op.folder_name || '').trim() || `folder #${op.folder_id ?? '?'}`;
      const fileCount = typeof op.file_count === 'number' ? op.file_count : null;
      const subCount = typeof op.subfolder_count === 'number' ? op.subfolder_count : null;
      const parts: string[] = [];
      if (fileCount !== null && fileCount > 0) parts.push(`${fileCount} file(s)`);
      if (subCount !== null && subCount > 0) parts.push(`${subCount} subfolder(s)`);
      const contentsNote = parts.length ? ` (${parts.join(', ')} inside)` : '';
      lines.push(`${i + 1}. Restore folder "${nm}" from trash${contentsNote}`);
    } else if (kind === 'move_folder') {
      const dest =
        op.to_folder_id != null && !Number.isNaN(Number(op.to_folder_id))
          ? String(op.to_folder_name || '').trim() || `folder #${Number(op.to_folder_id)}`
          : 'workspace root';
      const nm = String(op.folder_name || '').trim();
      const folderNum = op.folder_id != null ? Number(op.folder_id) : NaN;
      const label = nm ? `"${nm}"` : !Number.isNaN(folderNum) ? `folder #${folderNum}` : 'folder';
      lines.push(`${i + 1}. Move folder ${label} (and its contents) → ${dest}`);
    } else if (kind === 'bookmark_add') {
      const bid = op.bookmark_id != null ? Number(op.bookmark_id) : NaN;
      const who = !Number.isNaN(fid) ? oldName : 'file';
      const tail = !Number.isNaN(bid) ? `bookmark #${bid}` : 'bookmark';
      lines.push(`${i + 1}. Add ${who} to ${tail}`);
    } else if (kind === 'bookmark_remove') {
      const bid = op.bookmark_id != null ? Number(op.bookmark_id) : NaN;
      const who = !Number.isNaN(fid) ? oldName : 'file';
      const tail = !Number.isNaN(bid) ? `bookmark #${bid}` : 'bookmark';
      lines.push(`${i + 1}. Remove ${who} from ${tail}`);
    } else if (kind === 'bookmark_create') {
      const nm = String((op as { name?: string }).name || '?').trim();
      lines.push(`${i + 1}. Create bookmark "${nm}"`);
    } else if (kind === 'bookmark_rename') {
      const nm = String((op as { new_name?: string }).new_name || '?').trim();
      lines.push(`${i + 1}. Rename bookmark → "${nm}"`);
    } else if (kind === 'bookmark_delete') {
      lines.push(`${i + 1}. Delete bookmark #${(op as { bookmark_id?: number }).bookmark_id ?? '?'}`);
    } else if (kind === 'bookmark_set_color') {
      lines.push(`${i + 1}. Set bookmark #${(op as { bookmark_id?: number }).bookmark_id ?? '?'} color`);
    } else if (kind === 'bookmark_lock' || kind === 'bookmark_unlock') {
      const bid = (op as { bookmark_id?: number }).bookmark_id;
      lines.push(`${i + 1}. ${kind === 'bookmark_lock' ? 'Lock' : 'Unlock'} bookmark #${bid ?? '?'}`);
    } else if (kind === 'organize') {
      lines.push(`${i + 1}. Organize (see match_reason / trace if needed)`);
    } else {
      lines.push(`${i + 1}. ${kind || 'Operation'}`);
    }
    i += 1;
  }
  return lines;
}

/** Plain-text plan summary for the assistant bubble after /plan succeeds. */
export function formatUserFacingPlanMessage(plan: Record<string, unknown>): string {
  const summary = typeof plan.rephrased_plan === 'string' ? plan.rephrased_plan : 'Proposed plan';
  const risk = plan.risk_tier ? String(plan.risk_tier) : '';
  const notice = typeof plan.ownership_notice === 'string' ? plan.ownership_notice : '';
  const exclusions = Array.isArray(plan.exclusions)
    ? (plan.exclusions as Array<{ reason?: string; count?: number }>)
    : [];
  const exclusionLines = exclusions
    .filter((e) => Number(e.count) > 0)
    .map((e) => {
      const r = String(e.reason || '');
      const label =
        r === 'locked_bookmark' ? 'locked bookmark (unlock the bookmark to include them)' : r.replace(/_/g, ' ');
      return `⚠️ ${Number(e.count)} file(s) excluded (${label})`;
    });

  const ops = (plan.operations as unknown[]) || [];
  const nameById = previewNameMap(plan);
  const changeLines = formatOperationLines(ops, nameById);
  const more = ops.length > changeLines.length ? `\n\n… and ${ops.length - changeLines.length} more operations.` : '';

  const totalCount = typeof plan.total_count === 'number' ? plan.total_count : 0;
  const namesFromPlan = filenameListFromPlan(plan);
  const isReadOnlyFileMatch =
    ops.length === 0 && totalCount > 0 && namesFromPlan.length > 0 && !planHasFileMutations(plan);

  const intentRaw = typeof plan.intent_type === 'string' ? plan.intent_type.toLowerCase() : '';
  const links = plan.file_links as Array<{ original_filename?: string; name?: string }> | undefined;
  const hasStructuredLinks =
    Array.isArray(links) &&
    links.length > 0 &&
    (intentRaw === 'open' || intentRaw === 'download');

  const stratified = plan.resolved_files_preview_stratified as unknown[] | undefined;
  let sampleBlock = '';
  // Open/download plans already render tappable file chips — skip the duplicate bullet list.
  if (!hasStructuredLinks && isReadOnlyFileMatch) {
    const shown = namesFromPlan.length;
    const listedAll = shown >= totalCount;
    const heading = listedAll
      ? `\n\nAll ${totalCount} matched file(s):`
      : `\n\nShowing ${shown} of ${totalCount} matched file(s):`;
    const lines = namesFromPlan.map((n) => `- ${n}`);
    let tail = '';
    if (!listedAll) {
      tail = `\n\n… ${totalCount - shown} more not listed here (preview is limited to ${shown} file(s) in chat). Use the Files panel to browse or narrow your filters.`;
    }
    sampleBlock = `${heading}\n${lines.join('\n')}${tail}`;
  } else if (!hasStructuredLinks && Array.isArray(stratified) && stratified.length > 0) {
    const maxSample = 12;
    const sampleLines = stratified.slice(0, maxSample).map((row: unknown) => {
      if (row && typeof row === 'object' && 'original_filename' in row) {
        return `- ${String((row as { original_filename?: string }).original_filename || '?')}`;
      }
      return '- (file)';
    });
    const nShown = sampleLines.length;
    const nStrat = stratified.length;
    const label =
      nShown < nStrat
        ? `Sample of matched files (${nShown} of ${nStrat} preview rows):`
        : `Sample of matched files (${nShown} shown):`;
    sampleBlock = `\n\n${label}\n${sampleLines.join('\n')}`;
  }

  const matchingBlock = formatMatchingExplanation(plan);

  const footer =
    ops.length > 0
      ? '\n\nUse Run to apply, or adjust your request.'
      : hasStructuredLinks
        ? '\n\nTap a file below to view or download.'
        : intentRaw === 'open' || intentRaw === 'download'
          ? '\n\nRead-only preview — nothing to apply. Adjust your request if you want a different scope.'
          : '\n\nThis was a read-only preview — nothing to apply. Adjust your request if you want a different scope.';

  const parts = [
    summary,
    risk ? `\n\nRisk: ${risk}` : '',
    exclusionLines.length ? `\n\n${exclusionLines.join('\n')}` : '',
    notice ? `\n\n${notice}` : '',
    changeLines.length ? `\n\nChanges (${ops.length}):\n${changeLines.join('\n')}${more}` : '',
    sampleBlock,
    matchingBlock ?? '',
    footer,
  ];
  return parts.join('').trim();
}

/** Rebuild a plan payload from a persisted history row for chat restore / preview. */
export function buildPlanFromHistoryRow(input: {
  rephrased_plan?: string | null;
  operations?: unknown;
  intent_confidence?: number | null;
  resolver_confidence?: number | null;
  telemetry?: Record<string, unknown>;
}): Record<string, unknown> {
  const ops = Array.isArray(input.operations) ? input.operations : [];
  const tel = input.telemetry || {};
  const totalRaw = tel.total_count;
  let total_count = typeof totalRaw === 'number' ? totalRaw : undefined;
  if (total_count === undefined) {
    const fileOps = ops.filter(
      (o) => o && typeof o === 'object' && (o as { file_id?: number }).file_id != null,
    );
    total_count = fileOps.length > 0 ? fileOps.length : ops.length;
  }
  return {
    rephrased_plan: input.rephrased_plan,
    operations: ops,
    risk_tier: tel.risk_tier,
    total_count,
    intent_confidence: input.intent_confidence,
    resolver_confidence: input.resolver_confidence,
    scope_source: tel.scope_source,
    ownership_notice: tel.ownership_notice,
    exclusions: tel.exclusions,
    intent_type: tel.intent_type,
    file_links: tel.file_links,
    resolved_files_preview: tel.resolved_files_preview,
    resolved_files_preview_stratified: tel.resolved_files_preview_stratified,
    match_context: tel.match_context,
    aggregate_breakdown: tel.aggregate_breakdown,
  };
}

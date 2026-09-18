/**
 * usePrepareEditor — all state and actions for the prepare editor.
 *
 * Design principles:
 * - Operation-based undo (max 50), not full snapshots
 * - Manual save only — no auto-save on drag/resize
 * - gestureLock ref blocks page nav, pinch, placement during active gesture
 * - WizardField objects are immutable — all mutations return new arrays/objects
 * - All geometry paths go through utils/fillable/ exclusively
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import Toast from 'react-native-toast-message';
import type { WizardField, FieldType } from '../types/signature';
import type { UndoOperation } from '../utils/fillable/types';
import {
  enforceFieldBounds,
  normalizeField,
  applyDragDelta,
  applyResize,
  snapshotRects,
  buildFieldAtDefault,
  computeFitScale,
  computeRenderedSize,
  clampZoom,
  preserveScrollCenter,
  stepZoom,
  sortFieldsForRender,
  sortFieldsForSave,
  fieldsOnPage,
  toggleSelection,
  setSingleSelection,
  promoteAfterDelete,
  fieldToPixelRect,
  applyUndoOp,
  applyRedoOp,
  pushUndoOp,
  generateUUID,
  FIELD_DEFAULTS,
  PASTE_OFFSET,
  DEFAULT_ZOOM,
  NUDGE_COMPRESS_MS,
} from '../utils/fillable';
import {
  saveFillableTemplateFields,
  waitForFillablePageImages,
} from '../services/fillableApi';

export type PrepareTool = 'cursor' | FieldType;

export interface PageDimensions {
  w: number;
  h: number;
}

export interface ViewportSize {
  w: number;
  h: number;
}

export interface PrepareEditorState {
  fields: WizardField[];
  deletedFields: WizardField[];
  isDirty: boolean;
  isSaving: boolean;
  isLoading: boolean;
  /** True while backend returns PDF_CONVERTING (worker LibreOffice). */
  isConverting: boolean;
  loadError: string | null;
  templateName: string;
  currentPage: number;
  totalPages: number;
  pageImages: string[];
  pageDimensions: Record<number, PageDimensions>;
  viewportSize: ViewportSize;
  zoomLevel: number;
  scrollPos: { x: number; y: number };
  /** Bumps when zoom/jump-to-field requests a programmatic scroll. */
  scrollCommandNonce: number;
  renderedSize: { renderedW: number; renderedH: number };
  fitScale: number;
  currentPageFields: WizardField[];
  sortedPageFields: WizardField[];
  prepareTool: PrepareTool;
  selectedFieldIds: string[];
  primarySelectedFieldId: string | null;
  canUndo: boolean;
  canRedo: boolean;
  overlayRenderVersion: string;
  isGestureLocked: boolean;
  gestureLock: React.MutableRefObject<boolean>;
  fieldClipboard: React.MutableRefObject<WizardField[]>;
  /** Reactive clipboard size — ref alone does not re-render the properties sheet. */
  clipboardCount: number;
  sortedAllFields: WizardField[];
}

export interface PrepareEditorActions {
  load: (templateId: string | number) => Promise<void>;
  save: (templateId: string | number) => Promise<boolean>;
  goToPage: (page: number) => void;
  setPageDimensions: (page: number, dim: PageDimensions) => void;
  setViewportSize: (size: ViewportSize) => void;
  /** Track live scroll offset from user pans — ref only, no re-render. */
  reportScrollOffset: (x: number, y: number) => void;
  setScrollPos: (pos: { x: number; y: number }) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  setZoomLevel: (level: number) => void;
  /** Live pinch updates — resizes page without programmatic scroll state churn. */
  setZoomLevelDuringPinch: (level: number) => void;
  /** Commit pinch end — sync scroll position after gesture completes. */
  commitPinchZoom: (level: number, scroll: { x: number; y: number }) => void;
  setPrepareTool: (tool: PrepareTool) => void;
  softDeleteSelected: () => void;
  /** Delete primary field only; promotes previous selection when multi-select. */
  softDeletePrimary: () => void;
  updateField: (fieldId: string, patch: Partial<WizardField>) => void;
  selectField: (fieldId: string, multi: boolean) => void;
  jumpToField: (fieldId: string) => void;
  clearSelection: () => void;
  setGestureLocked: (locked: boolean) => void;
  commitDrag: (
    fieldIds: string[],
    dxPx: number,
    dyPx: number,
    beforeRects: Record<string, { x: number; y: number; w: number; h: number }>,
  ) => void;
  commitResize: (
    fieldId: string,
    dwPx: number,
    dhPx: number,
    beforeRects: Record<string, { x: number; y: number; w: number; h: number }>,
  ) => void;
  undo: () => void;
  redo: () => void;
  /** Snapshot selection into clipboard (does not place fields). */
  copySelected: () => void;
  /** Copy selection into clipboard and immediately place offset clones. */
  duplicateSelected: () => void;
  paste: () => void;
}

type TimestampedOp = UndoOperation & { _ts?: number };

export function usePrepareEditor(): PrepareEditorState & PrepareEditorActions {
  const [fields, setFields] = useState<WizardField[]>([]);
  const [deletedFields, setDeletedFields] = useState<WizardField[]>([]);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState('');
  const [currentPage, setCurrentPage] = useState(0);
  const [pageImages, setPageImages] = useState<string[]>([]);
  const [pageDimensions, setPageDimensionsMap] = useState<Record<number, PageDimensions>>({});
  const [viewportSize, setViewportSizeState] = useState<ViewportSize>({ w: 0, h: 0 });
  const [zoomLevel, setZoomLevelState] = useState(DEFAULT_ZOOM);
  const [scrollPos, setScrollPosState] = useState({ x: 0, y: 0 });
  const [scrollCommandNonce, setScrollCommandNonce] = useState(0);
  const [prepareTool, setPrepareTool_] = useState<PrepareTool>('cursor');
  const [selectedFieldIds, setSelectedFieldIds] = useState<string[]>([]);
  const [primarySelectedFieldId, setPrimarySelectedFieldId] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<TimestampedOp[]>([]);
  const [redoStack, setRedoStack] = useState<TimestampedOp[]>([]);
  const [isGestureLocked, setIsGestureLocked] = useState(false);

  const gestureLock = useRef(false);
  const gestureLockTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fieldClipboard = useRef<WizardField[]>([]);
  const [clipboardCount, setClipboardCount] = useState(0);
  // Debounce ref for label/property update undo compression
  const lastUpdateOpRef = useRef<{ fieldId: string; key: string; ts: number } | null>(null);

  // Keep stable refs for undo/redo so callbacks don't go stale
  const fieldsRef = useRef(fields);
  const deletedFieldsRef = useRef(deletedFields);
  const zoomRef = useRef(zoomLevel);
  const scrollRef = useRef(scrollPos);
  const viewportRef = useRef(viewportSize);
  const pageDimRef = useRef<PageDimensions>({ w: 0, h: 0 });
  const fitScaleRef = useRef(1);
  const selectedRef = useRef(selectedFieldIds);
  fieldsRef.current = fields;
  deletedFieldsRef.current = deletedFields;
  zoomRef.current = zoomLevel;
  scrollRef.current = scrollPos;
  viewportRef.current = viewportSize;
  selectedRef.current = selectedFieldIds;

  const totalPages = pageImages.length;

  const pageDim = pageDimensions[currentPage] ?? { w: 0, h: 0 };
  pageDimRef.current = pageDim;

  const fitScale = useMemo(
    () => computeFitScale({ width: pageDim.w, height: pageDim.h }, viewportSize.w, viewportSize.h),
    [pageDim.w, pageDim.h, viewportSize.w, viewportSize.h],
  );
  fitScaleRef.current = fitScale;

  const renderedSize = useMemo(
    () => computeRenderedSize({ width: pageDim.w, height: pageDim.h }, fitScale, zoomLevel),
    [pageDim.w, pageDim.h, fitScale, zoomLevel],
  );

  const currentPageFields = useMemo(
    () => fieldsOnPage(fields, currentPage),
    [fields, currentPage],
  );

  const sortedPageFields = useMemo(
    () => sortFieldsForRender(currentPageFields, selectedFieldIds, primarySelectedFieldId),
    [currentPageFields, selectedFieldIds, primarySelectedFieldId],
  );

  const sortedAllFields = useMemo(
    () => sortFieldsForSave(fields),
    [fields],
  );

  const overlayRenderVersion = `${currentPage}:${renderedSize.renderedW.toFixed(1)}:${renderedSize.renderedH.toFixed(1)}:${zoomLevel}`;

  const setGestureLocked = useCallback((locked: boolean) => {
    gestureLock.current = locked;
    setIsGestureLocked(locked);
    // Safety: never leave chrome (page nav / tools) disabled if a gesture
    // finalize was missed after selecting/dragging a field.
    if (gestureLockTimeoutRef.current) {
      clearTimeout(gestureLockTimeoutRef.current);
      gestureLockTimeoutRef.current = null;
    }
    if (locked) {
      gestureLockTimeoutRef.current = setTimeout(() => {
        if (!gestureLock.current) return;
        gestureLock.current = false;
        setIsGestureLocked(false);
        gestureLockTimeoutRef.current = null;
      }, 2000);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (gestureLockTimeoutRef.current) {
        clearTimeout(gestureLockTimeoutRef.current);
      }
    };
  }, []);

  // ─── push op helpers ─────────────────────────────────────────────────────
  const pushOp = useCallback((op: UndoOperation) => {
    setUndoStack((prev) => pushUndoOp(prev as UndoOperation[], op) as TimestampedOp[]);
    setRedoStack([]);
    setIsDirty(true);
  }, []);

  // ─── load ────────────────────────────────────────────────────────────────
  const load = useCallback(async (templateId: string | number) => {
    setIsLoading(true);
    setIsConverting(false);
    setLoadError(null);
    try {
      // Poll through PDF_CONVERTING (worker) and empty page_images the same way web does.
      const tpl = await waitForFillablePageImages(templateId, {
        onConverting: () => setIsConverting(true),
      });
      setIsConverting(false);
      const allFields = tpl.json_fields?.fields ?? [];
      setFields(allFields.filter((f) => !f.deleted));
      setDeletedFields(allFields.filter((f) => f.deleted));
      setPageImages(tpl.page_images ?? []);
      setTemplateName(tpl.name?.trim() || 'Document');
      setCurrentPage(0);
      setSelectedFieldIds([]);
      setPrimarySelectedFieldId(null);
      setUndoStack([]);
      setRedoStack([]);
      setIsDirty(false);
    } catch (e: unknown) {
      setIsConverting(false);
      setLoadError(e instanceof Error ? e.message : 'Failed to load template');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // ─── save ────────────────────────────────────────────────────────────────
  const save = useCallback(async (templateId: string | number): Promise<boolean> => {
    setIsSaving(true);
    try {
      const tpl = await saveFillableTemplateFields(
        templateId,
        fieldsRef.current,
        deletedFieldsRef.current,
      );
      const allFields = tpl.json_fields?.fields ?? [];
      setFields(allFields.filter((f) => !f.deleted));
      setDeletedFields(allFields.filter((f) => f.deleted));
      setTemplateName(tpl.name?.trim() || templateName || 'Document');
      setIsDirty(false);
      setUndoStack([]);
      setRedoStack([]);
      Toast.show({ type: 'success', text1: 'Saved' });
      return true;
    } catch (e: unknown) {
      Alert.alert('Save failed', e instanceof Error ? e.message : 'Please try again');
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [templateName]);

  // ─── navigation ─────────────────────────────────────────────────────────
  const goToPage = useCallback((page: number) => {
    // Header pagination must remain usable even if a field drag left lock stuck.
    if (gestureLock.current) setGestureLocked(false);
    setCurrentPage(page);
    setSelectedFieldIds([]);
    setPrimarySelectedFieldId(null);
  }, [setGestureLocked]);

  // ─── dimensions ─────────────────────────────────────────────────────────
  const setPageDimensions = useCallback((page: number, dim: PageDimensions) => {
    setPageDimensionsMap((prev) => {
      if (prev[page]?.w === dim.w && prev[page]?.h === dim.h) return prev;
      return { ...prev, [page]: dim };
    });
  }, []);

  const setViewportSize = useCallback((size: ViewportSize) => {
    setViewportSizeState((prev) => {
      if (prev.w === size.w && prev.h === size.h) return prev;
      return size;
    });
  }, []);

  const reportScrollOffset = useCallback((x: number, y: number) => {
    scrollRef.current = { x, y };
  }, []);

  const applyProgrammaticScroll = useCallback((pos: { x: number; y: number }) => {
    scrollRef.current = pos;
    setScrollPosState(pos);
    setScrollCommandNonce((n) => n + 1);
  }, []);

  const setScrollPos = useCallback((pos: { x: number; y: number }) => {
    applyProgrammaticScroll(pos);
  }, [applyProgrammaticScroll]);

  // ─── zoom ────────────────────────────────────────────────────────────────
  const setZoomLevel = useCallback((level: number) => {
    const next = clampZoom(level);
    const oldSize = computeRenderedSize(
      { width: pageDimRef.current.w, height: pageDimRef.current.h },
      fitScaleRef.current,
      zoomRef.current,
    );
    const newSize = computeRenderedSize(
      { width: pageDimRef.current.w, height: pageDimRef.current.h },
      fitScaleRef.current,
      next,
    );
    const { newScrollX, newScrollY } = preserveScrollCenter(
      scrollRef.current.x, scrollRef.current.y,
      viewportRef.current.w, viewportRef.current.h,
      oldSize.renderedW, oldSize.renderedH,
      newSize.renderedW, newSize.renderedH,
    );
    applyProgrammaticScroll({ x: newScrollX, y: newScrollY });
    setZoomLevelState(next);
  }, [applyProgrammaticScroll]);

  const setZoomLevelDuringPinch = useCallback((level: number) => {
    const next = clampZoom(level);
    if (Math.abs(next - zoomRef.current) < 0.004) return;
    zoomRef.current = next;
    setZoomLevelState(next);
  }, []);

  const commitPinchZoom = useCallback(
    (level: number, scroll: { x: number; y: number }) => {
      const next = clampZoom(level);
      zoomRef.current = next;
      setZoomLevelState(next);
      applyProgrammaticScroll(scroll);
    },
    [applyProgrammaticScroll],
  );

  const zoomIn = useCallback(
    () => setZoomLevel(stepZoom(zoomRef.current, 'in')),
    [setZoomLevel],
  );
  const zoomOut = useCallback(
    () => setZoomLevel(stepZoom(zoomRef.current, 'out')),
    [setZoomLevel],
  );

  // ─── placement ───────────────────────────────────────────────────────────
  const addFieldOfType = useCallback((type: FieldType) => {
    if (gestureLock.current) return;
    const dim = pageDimRef.current;
    if (!dim.w || !dim.h) return;

    const defaults = FIELD_DEFAULTS[type] ?? { w: 0.2, h: 0.06, label: '' };
    const stackIndex = fieldsOnPage(fieldsRef.current, currentPage).length;
    const newField = buildFieldAtDefault(
      generateUUID(),
      type,
      defaults.label,
      currentPage,
      defaults.w,
      defaults.h,
      stackIndex,
    );
    const withTs = { ...newField, lastTouchedAt: Date.now() };
    setFields((prev) => [...prev, withTs]);
    setSelectedFieldIds([newField.id]);
    setPrimarySelectedFieldId(newField.id);
    pushOp({ type: 'add', fieldIds: [newField.id] });
  }, [currentPage, pushOp]);

  const setPrepareTool = useCallback((tool: PrepareTool) => {
    // Tool palette taps should recover from a stuck field gesture lock.
    if (gestureLock.current) setGestureLocked(false);
    if (tool === 'cursor') {
      setPrepareTool_('cursor');
      return;
    }
    addFieldOfType(tool);
    setPrepareTool_('cursor');
  }, [addFieldOfType, setGestureLocked]);

  // ─── soft delete ─────────────────────────────────────────────────────────
  const softDeleteFields = useCallback((
    ids: string[],
    promoteRemaining: boolean,
  ) => {
    if (!ids.length) return;
    const toDelete = fieldsRef.current.filter((f) => ids.includes(f.id));
    pushOp({ type: 'delete', fields: toDelete });
    setDeletedFields((prev) => [
      ...prev,
      ...toDelete.map((f) => ({ ...f, deleted: true as const })),
    ]);
    setFields((prev) => prev.filter((f) => !ids.includes(f.id)));
    if (promoteRemaining && ids.length === 1) {
      const { selectedIds, primaryId } = promoteAfterDelete(selectedRef.current, ids[0]);
      setSelectedFieldIds(selectedIds);
      setPrimarySelectedFieldId(primaryId);
    } else {
      setSelectedFieldIds([]);
      setPrimarySelectedFieldId(null);
    }
  }, [pushOp]);

  const softDeleteSelected = useCallback(() => {
    softDeleteFields(selectedRef.current, false);
  }, [softDeleteFields]);

  const softDeletePrimary = useCallback(() => {
    const primary = selectedRef.current.length
      ? selectedRef.current[selectedRef.current.length - 1]
      : null;
    if (!primary) return;
    softDeleteFields([primary], true);
  }, [softDeleteFields]);

  // ─── update field ─────────────────────────────────────────────────────────
  // Rapid same-field same-key changes (e.g. label typing) collapse into one undo op.
  const updateField = useCallback((fieldId: string, patch: Partial<WizardField>) => {
    const currentField = fieldsRef.current.find((f) => f.id === fieldId);
    if (!currentField) return;

    setFields((prev) =>
      prev.map((f) => f.id === fieldId ? normalizeField({ ...f, ...patch }) : f),
    );

    // Debounce: if same field + same single key within NUDGE_COMPRESS_MS, amend last op
    const patchKeys = Object.keys(patch);
    const singleKey = patchKeys.length === 1 ? patchKeys[0] : null;
    const now = Date.now();
    const last = lastUpdateOpRef.current;
    const canMerge =
      singleKey &&
      last &&
      last.fieldId === fieldId &&
      last.key === singleKey &&
      now - last.ts <= NUDGE_COMPRESS_MS;

    if (canMerge) {
      // Update timestamp but don't push a new op — the before value is already recorded
      lastUpdateOpRef.current = { fieldId, key: singleKey!, ts: now };
      setIsDirty(true);
    } else {
      // Record before value from current state (before mutation)
      const before: Record<string, Partial<WizardField>> = {
        [fieldId]: Object.fromEntries(
          patchKeys.map((k) => [k, currentField[k as keyof WizardField]]),
        ),
      };
      lastUpdateOpRef.current = singleKey ? { fieldId, key: singleKey, ts: now } : null;
      pushOp({ type: 'update', before, after: { [fieldId]: patch } });
    }
  }, [pushOp]);

  // ─── selection ───────────────────────────────────────────────────────────
  const selectField = useCallback((fieldId: string, multi: boolean) => {
    // A tap-to-select must not be blocked by a leftover drag lock.
    if (gestureLock.current) setGestureLocked(false);
    if (multi) {
      const { selectedIds, primaryId } = toggleSelection(selectedRef.current, fieldId);
      setSelectedFieldIds(selectedIds);
      setPrimarySelectedFieldId(primaryId);
    } else {
      const { selectedIds, primaryId } = setSingleSelection(fieldId);
      setSelectedFieldIds(selectedIds);
      setPrimarySelectedFieldId(primaryId);
    }
    setFields((prev) =>
      prev.map((f) => f.id === fieldId ? { ...f, lastTouchedAt: Date.now() } : f),
    );
  }, [setGestureLocked]);

  const jumpToField = useCallback((fieldId: string) => {
    if (gestureLock.current) setGestureLocked(false);
    const field = fieldsRef.current.find((f) => f.id === fieldId);
    if (!field || field.x == null || field.y == null || field.w == null || field.h == null) return;

    const targetPage = field.page ?? 0;
    const dim = pageDimensions[targetPage] ?? { w: 0, h: 0 };
    const vs = viewportRef.current;

    if (dim.w > 0 && vs.w > 0 && vs.h > 0) {
      const fs = computeFitScale({ width: dim.w, height: dim.h }, vs.w, vs.h);
      const { renderedW, renderedH } = computeRenderedSize(
        { width: dim.w, height: dim.h }, fs, zoomRef.current,
      );
      const px = fieldToPixelRect(
        { x: field.x, y: field.y, w: field.w, h: field.h },
        renderedW,
        renderedH,
      );
      const CANVAS_PAD_V = 16;
      const CANVAS_PAD_H = 8;
      const pageLeft = Math.max(0, (Math.max(vs.w, renderedW + CANVAS_PAD_H * 2) - renderedW) / 2);
      const fieldCenterX = pageLeft + px.left + px.width / 2;
      const fieldCenterY = CANVAS_PAD_V + px.top + px.height / 2;
      applyProgrammaticScroll({
        x: Math.max(0, fieldCenterX - vs.w / 2),
        y: Math.max(0, fieldCenterY - vs.h / 2),
      });
    }

    setCurrentPage(targetPage);
    const { selectedIds, primaryId } = setSingleSelection(fieldId);
    setSelectedFieldIds(selectedIds);
    setPrimarySelectedFieldId(primaryId);
    setFields((prev) =>
      prev.map((f) => f.id === fieldId ? { ...f, lastTouchedAt: Date.now() } : f),
    );
  }, [pageDimensions, applyProgrammaticScroll, setGestureLocked]);

  const clearSelection = useCallback(() => {
    if (gestureLock.current) return;
    setSelectedFieldIds([]);
    setPrimarySelectedFieldId(null);
  }, []);

  // ─── drag commit ─────────────────────────────────────────────────────────
  const commitDrag = useCallback((
    fieldIds: string[],
    dxPx: number,
    dyPx: number,
    beforeRects: Record<string, { x: number; y: number; w: number; h: number }>,
  ) => {
    const dim = pageDimRef.current;
    const fs = fitScaleRef.current;
    const { renderedW, renderedH } = computeRenderedSize(
      { width: dim.w, height: dim.h }, fs, zoomRef.current,
    );
    const dx = dxPx / renderedW;
    const dy = dyPx / renderedH;
    const moved = applyDragDelta(fieldsRef.current, fieldIds, dx, dy);
    const afterRects = snapshotRects(moved, fieldIds);
    const withTs = moved.map((f) =>
      fieldIds.includes(f.id) ? { ...f, lastTouchedAt: Date.now() } : f,
    );
    setFields(withTs);
    pushOp({ type: 'move', before: beforeRects, after: afterRects });
  }, [pushOp]);

  // ─── resize commit ───────────────────────────────────────────────────────
  const commitResize = useCallback((
    fieldId: string,
    dwPx: number,
    dhPx: number,
    beforeRects: Record<string, { x: number; y: number; w: number; h: number }>,
  ) => {
    const dim = pageDimRef.current;
    const fs = fitScaleRef.current;
    const { renderedW, renderedH } = computeRenderedSize(
      { width: dim.w, height: dim.h }, fs, zoomRef.current,
    );
    const resized = applyResize(fieldsRef.current, fieldId, dwPx / renderedW, dhPx / renderedH);
    const afterRects = snapshotRects(resized, [fieldId]);
    setFields(resized);
    pushOp({ type: 'resize', before: beforeRects, after: afterRects });
  }, [pushOp]);

  // ─── undo ────────────────────────────────────────────────────────────────
  const undo = useCallback(() => {
    if (gestureLock.current) setGestureLocked(false);
    setUndoStack((prev) => {
      if (!prev.length) return prev;
      const op = prev[prev.length - 1];
      const result = applyUndoOp(fieldsRef.current, deletedFieldsRef.current, op);
      setFields(result.fields);
      setDeletedFields(result.deleted);
      setRedoStack((r) => [...r, op]);
      setIsDirty(true);
      return prev.slice(0, -1);
    });
  }, [setGestureLocked]);

  // ─── redo ────────────────────────────────────────────────────────────────
  const redo = useCallback(() => {
    if (gestureLock.current) setGestureLocked(false);
    setRedoStack((prev) => {
      if (!prev.length) return prev;
      const op = prev[prev.length - 1];
      const result = applyRedoOp(fieldsRef.current, deletedFieldsRef.current, op);
      setFields(result.fields);
      setDeletedFields(result.deleted);
      setUndoStack((u) => [...u, op]);
      setIsDirty(true);
      return prev.slice(0, -1);
    });
  }, [setGestureLocked]);

  // ─── clipboard ───────────────────────────────────────────────────────────
  const snapshotSelectionToClipboard = useCallback((): WizardField[] => {
    const selected = fieldsRef.current.filter((f) =>
      selectedRef.current.includes(f.id),
    );
    fieldClipboard.current = selected;
    setClipboardCount(selected.length);
    return selected;
  }, []);

  const copySelected = useCallback(() => {
    snapshotSelectionToClipboard();
  }, [snapshotSelectionToClipboard]);

  const pasteClipboardFields = useCallback((clipboard: WizardField[]) => {
    if (!clipboard.length) return;
    const newFields = clipboard.map((f) => {
      // New fields must not reuse server revision from the source.
      const { rev: _rev, deleted: _deleted, ...rest } = f;
      return normalizeField({
        ...rest,
        id: generateUUID(),
        x: (f.x ?? 0) + PASTE_OFFSET,
        y: (f.y ?? 0) + PASTE_OFFSET,
        lastTouchedAt: Date.now(),
      });
    });
    setFields((prev) => [...prev, ...newFields]);
    const newIds = newFields.map((f) => f.id);
    setSelectedFieldIds(newIds);
    setPrimarySelectedFieldId(newIds[newIds.length - 1] ?? null);
    pushOp({ type: 'add', fieldIds: newIds });
  }, [pushOp]);

  const paste = useCallback(() => {
    pasteClipboardFields(fieldClipboard.current);
  }, [pasteClipboardFields]);

  const duplicateSelected = useCallback(() => {
    const selected = snapshotSelectionToClipboard();
    pasteClipboardFields(selected);
  }, [snapshotSelectionToClipboard, pasteClipboardFields]);

  return {
    fields, deletedFields, isDirty, isSaving, isLoading, isConverting, loadError, templateName,
    currentPage, totalPages, pageImages,
    pageDimensions, viewportSize, zoomLevel, scrollPos, scrollCommandNonce,
    renderedSize, fitScale,
    currentPageFields, sortedPageFields,
    prepareTool, selectedFieldIds, primarySelectedFieldId,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    overlayRenderVersion,
    isGestureLocked,
    gestureLock, fieldClipboard, clipboardCount,
    sortedAllFields,
    load, save,
    goToPage,
    setPageDimensions, setViewportSize, reportScrollOffset, setScrollPos,
    zoomIn, zoomOut, setZoomLevel, setZoomLevelDuringPinch, commitPinchZoom,
    setPrepareTool,
    softDeleteSelected, softDeletePrimary, updateField,
    selectField, jumpToField, clearSelection,
    setGestureLocked,
    commitDrag, commitResize,
    undo, redo,
    copySelected, duplicateSelected, paste,
  };
}

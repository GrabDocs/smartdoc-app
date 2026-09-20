/**
 * PrepareFieldOverlay — single draggable/resizable field in the prepare editor.
 *
 * Architecture:
 * - Uses RNGH Pan for drag and resize (memoized; stable across React re-renders)
 * - Drag moves animated left/top (not transform) so hit-testing stays on the visual field
 * - React state committed only on gesture end; peers follow via shared group deltas
 * - gestureLock set true on pan grant, false on end
 * - Render token compared at gesture start; stale events discarded
 * - Affordances (handles, delete ×) scale with zoom, clamped 14–28px
 * - hitSlop 8px on delete/resize only — field body itself has no expanded hit area
 *
 * NOTE: All hooks must be called unconditionally (Rules of Hooks).
 * Null-guard is done in the return, not before hooks.
 */

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Image, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  runOnJS,
  type SharedValue,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import type { WizardField } from '../../../types/signature';
import {
  fieldToPixelRect,
  FIELD_COLORS,
  FIELD_ICONS,
  FIELD_DEFAULTS,
  RESIZE_HANDLE_MIN,
  RESIZE_HANDLE_MAX,
  DELETE_BUTTON_MIN,
  DELETE_BUTTON_MAX,
  FIELD_LABEL_FONT_MIN,
  FIELD_LABEL_FONT_MAX,
  HIT_SLOP,
  clamp,
  snapshotRects,
} from '../../../utils/fillable';
import type { FieldType } from '../../../types/signature';
import { fieldImageUri } from '../../../utils/signatureRuntime';
import { formatFillDate } from '../../../utils/fillDate';

interface Props {
  field: WizardField;
  pageFields: WizardField[];
  selectedFieldIds: string[];
  renderedW: number;
  renderedH: number;
  isSelected: boolean;
  isPrimary: boolean;
  zIndex: number;
  zoomLevel: number;
  overlayRenderVersion: string;
  gestureLock: React.MutableRefObject<boolean>;
  setGestureLocked: (locked: boolean) => void;
  onSelect: (fieldId: string, multi: boolean) => void;
  onDragEnd: (
    fieldIds: string[],
    dxPx: number,
    dyPx: number,
    before: Record<string, { x: number; y: number; w: number; h: number }>,
  ) => void;
  onResizeEnd: (
    fieldId: string,
    dwPx: number,
    dhPx: number,
    before: Record<string, { x: number; y: number; w: number; h: number }>,
  ) => void;
  onDelete: () => void;
  /** Shared across overlays so multi-select drag moves all selected fields together. */
  groupDragX: SharedValue<number>;
  groupDragY: SharedValue<number>;
  isGroupDragging: SharedValue<boolean>;
  /** When true, fields accept fill values (text, signature, checkbox) instead of prepare labels only. */
  fillMode?: boolean;
  fieldValue?: unknown;
  onValueChange?: (fieldId: string, value: unknown) => void;
  onSignatureRequest?: (fieldId: string, label: string) => void;
  onTextFieldFocus?: (fieldId: string) => void;
  onDateFieldPress?: (fieldId: string, currentValue?: string) => void;
}

function affordanceSize(base: number, zoom: number, min: number, max: number): number {
  return clamp(base / zoom, min, max);
}

export default function PrepareFieldOverlay({
  field,
  pageFields,
  selectedFieldIds,
  renderedW,
  renderedH,
  isSelected,
  isPrimary,
  zIndex,
  zoomLevel,
  overlayRenderVersion,
  gestureLock,
  setGestureLocked,
  onSelect,
  onDragEnd,
  onResizeEnd,
  onDelete,
  groupDragX,
  groupDragY,
  isGroupDragging,
  fillMode = false,
  fieldValue,
  onValueChange,
  onSignatureRequest,
  onTextFieldFocus,
  onDateFieldPress,
}: Props) {
  // ── All hooks must be called unconditionally ──────────────────────────────
  // Position via left/top (not transform) so RNGH hit-tests the visible field only.
  const initialRect =
    field.x != null &&
    field.y != null &&
    field.w != null &&
    field.h != null &&
    renderedW > 0 &&
    renderedH > 0
      ? fieldToPixelRect(
          { x: field.x, y: field.y, w: field.w, h: field.h },
          renderedW,
          renderedH,
        )
      : { left: 0, top: 0, width: 0, height: 0 };
  const layoutLeft = useSharedValue(initialRect.left);
  const layoutTop = useSharedValue(initialRect.top);
  const baseW = useSharedValue(initialRect.width);
  const baseH = useSharedValue(initialRect.height);
  const dragStartLeft = useSharedValue(0);
  const dragStartTop = useSharedValue(0);
  const scaleW = useSharedValue(0);
  const scaleH = useSharedValue(0);
  const isLocked = useSharedValue(false);
  const isDraggingThis = useSharedValue(false);
  const capturedVersion = useRef('');
  const beforeRects = useRef<Record<string, { x: number; y: number; w: number; h: number }>>({});
  const dragIdsRef = useRef<string[]>([field.id]);
  const ownsLockRef = useRef(false);
  const gestureSessionRef = useRef(0);
  const [isEditingText, setIsEditingText] = useState(false);
  const [offsetCommitNonce, setOffsetCommitNonce] = useState(0);

  const resolveDragIds = useCallback((): string[] => {
    if (isSelected && selectedFieldIds.length > 1) {
      return selectedFieldIds.filter((id) => pageFields.some((f) => f.id === id));
    }
    return [field.id];
  }, [isSelected, selectedFieldIds, pageFields, field.id]);

  const syncLayoutFromField = useCallback(() => {
    if (
      field.x == null ||
      field.y == null ||
      field.w == null ||
      field.h == null ||
      renderedW <= 0 ||
      renderedH <= 0
    ) {
      return;
    }
    const rect = fieldToPixelRect(
      { x: field.x, y: field.y, w: field.w, h: field.h },
      renderedW,
      renderedH,
    );
    if (!isDraggingThis.value) {
      layoutLeft.value = rect.left;
      layoutTop.value = rect.top;
    }
    baseW.value = rect.width;
    baseH.value = rect.height;
  }, [
    baseH,
    baseW,
    field.h,
    field.w,
    field.x,
    field.y,
    isDraggingThis,
    layoutLeft,
    layoutTop,
    renderedH,
    renderedW,
  ]);

  const clearVisualOffsets = useCallback(() => {
    scaleW.value = 0;
    scaleH.value = 0;
    groupDragX.value = 0;
    groupDragY.value = 0;
    isGroupDragging.value = false;
    isDraggingThis.value = false;
    syncLayoutFromField();
  }, [
    groupDragX,
    groupDragY,
    isDraggingThis,
    isGroupDragging,
    scaleH,
    scaleW,
    syncLayoutFromField,
  ]);

  const unlockGesture = useCallback(() => {
    ownsLockRef.current = false;
    setGestureLocked(false);
    isLocked.value = false;
  }, [setGestureLocked, isLocked]);

  const acquireLock = useCallback(() => {
    if (gestureLock.current) {
      isLocked.value = false;
      isGroupDragging.value = false;
      isDraggingThis.value = false;
      return false;
    }
    setGestureLocked(true);
    ownsLockRef.current = true;
    isLocked.value = true;
    isGroupDragging.value = true;
    const dragIds = resolveDragIds();
    dragIdsRef.current = dragIds;
    capturedVersion.current = overlayRenderVersion;
    beforeRects.current = snapshotRects(pageFields, dragIds);
    return true;
  }, [
    gestureLock,
    isDraggingThis,
    isLocked,
    isGroupDragging,
    overlayRenderVersion,
    pageFields,
    resolveDragIds,
    setGestureLocked,
  ]);

  const handleDragEnd = useCallback(
    (dxPx: number, dyPx: number) => {
      if (capturedVersion.current !== overlayRenderVersion) {
        clearVisualOffsets();
        unlockGesture();
        return;
      }
      // Keep layout at the dragged position until React commits new x/y, then sync.
      onDragEnd(dragIdsRef.current, dxPx, dyPx, beforeRects.current);
      setOffsetCommitNonce((n) => n + 1);
      unlockGesture();
    },
    [overlayRenderVersion, onDragEnd, clearVisualOffsets, unlockGesture],
  );

  const handleResizeEnd = useCallback(
    (dwPx: number, dhPx: number) => {
      if (capturedVersion.current !== overlayRenderVersion) {
        clearVisualOffsets();
        unlockGesture();
        return;
      }
      onResizeEnd(field.id, dwPx, dhPx, beforeRects.current);
      setOffsetCommitNonce((n) => n + 1);
      unlockGesture();
    },
    [field.id, overlayRenderVersion, onResizeEnd, clearVisualOffsets, unlockGesture],
  );

  const cancelGesture = useCallback(() => {
    clearVisualOffsets();
    unlockGesture();
  }, [clearVisualOffsets, unlockGesture]);

  // Keep shared layout in sync with committed geometry whenever idle.
  useLayoutEffect(() => {
    syncLayoutFromField();
  }, [syncLayoutFromField]);

  // After commit, drop group/resize deltas in the same frame new geometry lands.
  useLayoutEffect(() => {
    if (offsetCommitNonce === 0) return;
    isDraggingThis.value = false;
    scaleW.value = 0;
    scaleH.value = 0;
    groupDragX.value = 0;
    groupDragY.value = 0;
    isGroupDragging.value = false;
    syncLayoutFromField();
  }, [
    offsetCommitNonce,
    field.x,
    field.y,
    field.w,
    field.h,
    groupDragX,
    groupDragY,
    isDraggingThis,
    isGroupDragging,
    scaleH,
    scaleW,
    syncLayoutFromField,
  ]);

  const handleTap = useCallback(() => {
    if (fillMode) {
      if (field.type === 'signature' || field.type === 'initials') {
        const hasSignature = fieldImageUri(fieldValue) != null;
        if (!hasSignature || isPrimary) {
          onSignatureRequest?.(
            field.id,
            field.label || (FIELD_DEFAULTS[field.type as FieldType]?.label ?? field.type),
          );
          return;
        }
        onSelect(field.id, false);
        return;
      }
      if (field.type === 'checkbox') {
        onValueChange?.(field.id, !Boolean(fieldValue));
        return;
      }
      if (field.type === 'date') {
        onDateFieldPress?.(
          field.id,
          typeof fieldValue === 'string' && fieldValue ? fieldValue : undefined,
        );
        return;
      }
    }
    onSelect(field.id, false);
  }, [field.id, field.label, field.type, fieldValue, fillMode, isPrimary, onSelect, onSignatureRequest, onDateFieldPress, onValueChange]);

  const handleLongPress = useCallback(() => {
    onSelect(field.id, true);
  }, [field.id, onSelect]);

  const dragDisabled = fillMode && field.type === 'text' && isEditingText;

  // Stable JS bridges so memoized gestures are not recreated on every React render
  // (recreating mid-drag restarts the gesture and flickers).
  const gestureHandlersRef = useRef({
    acquireLock,
    handleDragEnd,
    handleResizeEnd,
    cancelGesture,
    unlockGesture,
  });
  gestureHandlersRef.current = {
    acquireLock,
    handleDragEnd,
    handleResizeEnd,
    cancelGesture,
    unlockGesture,
  };

  const runAcquireLock = useCallback(() => {
    const session = ++gestureSessionRef.current;
    const acquired = gestureHandlersRef.current.acquireLock();
    if (!acquired) return;
    // If end/finalize already ran in this JS turn, drop a late lock immediately.
    queueMicrotask(() => {
      if (gestureSessionRef.current !== session && ownsLockRef.current) {
        gestureHandlersRef.current.unlockGesture();
      }
    });
  }, []);
  const runDragEnd = useCallback((dx: number, dy: number) => {
    gestureSessionRef.current += 1;
    gestureHandlersRef.current.handleDragEnd(dx, dy);
  }, []);
  const runResizeEnd = useCallback((dw: number, dh: number) => {
    gestureSessionRef.current += 1;
    gestureHandlersRef.current.handleResizeEnd(dw, dh);
  }, []);
  const runCancelGesture = useCallback(() => {
    gestureSessionRef.current += 1;
    gestureHandlersRef.current.cancelGesture();
  }, []);
  const runEnsureUnlocked = useCallback(() => {
    gestureSessionRef.current += 1;
    // Only clear if this overlay still owns the global lock.
    if (ownsLockRef.current) {
      gestureHandlersRef.current.unlockGesture();
    }
  }, []);

  const dragGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!dragDisabled)
        .maxPointers(1)
        .minDistance(6)
        .onStart(() => {
          'worklet';
          isLocked.value = true;
          isDraggingThis.value = true;
          dragStartLeft.value = layoutLeft.value;
          dragStartTop.value = layoutTop.value;
          groupDragX.value = 0;
          groupDragY.value = 0;
          // Set on UI thread immediately so multi-select peers track without waiting on JS.
          isGroupDragging.value = true;
          runOnJS(runAcquireLock)();
        })
        .onUpdate((e) => {
          'worklet';
          if (!isLocked.value) return;
          layoutLeft.value = dragStartLeft.value + e.translationX;
          layoutTop.value = dragStartTop.value + e.translationY;
          groupDragX.value = e.translationX;
          groupDragY.value = e.translationY;
        })
        .onEnd((e) => {
          'worklet';
          if (!isLocked.value) return;
          const dx = e.translationX;
          const dy = e.translationY;
          // Hold layout at final position; React commits new x/y, then useLayoutEffect syncs.
          layoutLeft.value = dragStartLeft.value + dx;
          layoutTop.value = dragStartTop.value + dy;
          groupDragX.value = dx;
          groupDragY.value = dy;
          runOnJS(runDragEnd)(dx, dy);
        })
        .onFinalize((_e, success) => {
          'worklet';
          // Always clear chrome lock — catches cancelled pans and acquire/unlock races
          // that previously left page nav / tools disabled after selecting a field.
          if (!success) {
            runOnJS(runCancelGesture)();
          } else {
            runOnJS(runEnsureUnlocked)();
          }
        }),
    [
      dragDisabled,
      dragStartLeft,
      dragStartTop,
      groupDragX,
      groupDragY,
      isDraggingThis,
      isGroupDragging,
      isLocked,
      layoutLeft,
      layoutTop,
      runAcquireLock,
      runCancelGesture,
      runDragEnd,
      runEnsureUnlocked,
    ],
  );

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .maxPointers(1)
        .onStart(() => {
          'worklet';
          isLocked.value = true;
          scaleW.value = 0;
          scaleH.value = 0;
          runOnJS(runAcquireLock)();
        })
        .onUpdate((e) => {
          'worklet';
          if (!isLocked.value) return;
          scaleW.value = e.translationX;
          scaleH.value = e.translationY;
        })
        .onEnd((e) => {
          'worklet';
          if (!isLocked.value) return;
          const dw = e.translationX;
          const dh = e.translationY;
          // Hold size delta until committed w/h lands in layout.
          scaleW.value = dw;
          scaleH.value = dh;
          runOnJS(runResizeEnd)(dw, dh);
        })
        .onFinalize((_e, success) => {
          'worklet';
          if (!success) {
            runOnJS(runCancelGesture)();
          } else {
            runOnJS(runEnsureUnlocked)();
          }
        }),
    [
      isLocked,
      runAcquireLock,
      runCancelGesture,
      runEnsureUnlocked,
      runResizeEnd,
      scaleH,
      scaleW,
    ],
  );

  const animatedFieldStyle = useAnimatedStyle(() => {
    // Peer fields in a multi-select follow the active drag via shared group deltas.
    const peerDrag = isGroupDragging.value && isSelected && !isDraggingThis.value;
    return {
      left: layoutLeft.value + (peerDrag ? groupDragX.value : 0),
      top: layoutTop.value + (peerDrag ? groupDragY.value : 0),
      width: baseW.value + scaleW.value,
      height: baseH.value + scaleH.value,
    };
  });

  // ── Guard: skip render if rect is incomplete ──────────────────────────────
  if (field.x == null || field.y == null || field.w == null || field.h == null) {
    return null;
  }

  const color = FIELD_COLORS[(field.type as FieldType)] ?? '#2563EB';
  const iconName = FIELD_ICONS[(field.type as FieldType)] ?? 'document-outline';
  const handleSize = affordanceSize(20, zoomLevel, RESIZE_HANDLE_MIN, RESIZE_HANDLE_MAX);
  const deleteBtnSize = affordanceSize(24, zoomLevel, DELETE_BUTTON_MIN, DELETE_BUTTON_MAX);
  const fontSize = affordanceSize(11, zoomLevel, FIELD_LABEL_FONT_MIN, FIELD_LABEL_FONT_MAX);
  const fieldLabel = field.label || (FIELD_DEFAULTS[field.type as FieldType]?.label ?? field.type);
  const signatureImageUri = fillMode ? fieldImageUri(fieldValue) : null;

  const renderFillContent = () => {
    if (!fillMode) return null;

    if (field.type === 'text') {
      return (
        <TextInput
          style={[styles.fillTextInput, { color, fontSize }]}
          value={typeof fieldValue === 'string' ? fieldValue : ''}
          onChangeText={(t) => onValueChange?.(field.id, t)}
          placeholder={fieldLabel}
          placeholderTextColor={`${color}99`}
          multiline
          underlineColorAndroid="transparent"
          onFocus={() => {
            setIsEditingText(true);
            onSelect(field.id, false);
            onTextFieldFocus?.(field.id);
          }}
          onBlur={() => setIsEditingText(false)}
        />
      );
    }

    if (field.type === 'date') {
      const display =
        typeof fieldValue === 'string' && fieldValue.trim()
          ? fieldValue
          : formatFillDate(new Date());
      return (
        <Text style={[styles.fillDateText, { color, fontSize }]} numberOfLines={1}>
          {display}
        </Text>
      );
    }

    if (field.type === 'checkbox') {
      const checked = Boolean(fieldValue);
      const boxSize = Math.max(fontSize + 2, 16);
      return (
        <View
          style={{
            width: boxSize,
            height: boxSize,
            borderRadius: 3,
            borderWidth: 2,
            borderColor: checked ? '#2563eb' : '#b8bec4',
            backgroundColor: checked ? '#dbeafe' : '#ffffff',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {checked ? (
            <Text style={{ fontSize: Math.max(boxSize * 0.65, 11), color: '#2563eb', fontWeight: '700' }}>✓</Text>
          ) : null}
        </View>
      );
    }

    if (field.type === 'signature' || field.type === 'initials') {
      if (signatureImageUri) {
        return (
          <Image
            source={{ uri: signatureImageUri }}
            style={styles.fillSignatureImage}
            resizeMode="contain"
          />
        );
      }
      return (
        <Text style={[styles.fillSignHint, { color, fontSize }]}>
          Tap to {field.type === 'initials' ? 'initial' : 'sign'}
        </Text>
      );
    }

    return null;
  };

  const fillContent = renderFillContent();

  return (
    <Animated.View
      style={[
        styles.fieldRoot,
        { zIndex },
        animatedFieldStyle,
      ]}
    >
      <GestureDetector gesture={dragGesture}>
        <View
          collapsable={false}
          style={[
            styles.fieldBody,
            {
              backgroundColor: 'transparent',
              borderColor: isSelected ? color : `${color}88`,
              borderWidth: isSelected ? 2 : 1.5,
              borderStyle: isSelected ? 'solid' : 'dashed',
              borderRadius: 4,
              width: '100%',
              height: '100%',
            },
          ]}
        >
          {fillContent ? (
            field.type === 'text' ? (
              <View style={styles.fieldContent}>{fillContent}</View>
            ) : (
              <TouchableOpacity
                style={styles.fieldContent}
                onPress={handleTap}
                onLongPress={handleLongPress}
                delayLongPress={400}
                activeOpacity={0.8}
              >
                {fillContent}
              </TouchableOpacity>
            )
          ) : (
            <TouchableOpacity
              style={styles.fieldContent}
              onPress={handleTap}
              onLongPress={handleLongPress}
              delayLongPress={400}
              activeOpacity={0.8}
            >
              <Ionicons
                name={iconName as keyof typeof Ionicons.glyphMap}
                size={Math.max(fontSize + 2, 10)}
                color={color}
              />
              <Text
                style={[styles.fieldLabel, { color, fontSize }]}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {fieldLabel}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </GestureDetector>

      {/* Delete × — primary only */}
      {isPrimary && (
        <TouchableOpacity
          style={[
            styles.deleteBtn,
            {
              width: deleteBtnSize,
              height: deleteBtnSize,
              borderRadius: deleteBtnSize / 2,
              top: -deleteBtnSize / 2,
              right: -deleteBtnSize / 2,
              backgroundColor: '#EF4444',
            },
          ]}
          onPress={onDelete}
          hitSlop={{ top: HIT_SLOP, bottom: HIT_SLOP, left: HIT_SLOP, right: HIT_SLOP }}
        >
          <Ionicons name="close" size={deleteBtnSize * 0.55} color="#fff" />
        </TouchableOpacity>
      )}

      {/* Resize handle — primary only */}
      {isPrimary && (
        <GestureDetector gesture={resizeGesture}>
          <View
            style={[
              styles.resizeHandle,
              {
                width: handleSize,
                height: handleSize,
                borderRadius: 3,
                bottom: -handleSize / 2,
                right: -handleSize / 2,
                backgroundColor: color,
              },
            ]}
            hitSlop={{ top: HIT_SLOP, bottom: HIT_SLOP, left: HIT_SLOP, right: HIT_SLOP }}
          >
            <Ionicons name="resize-outline" size={handleSize * 0.6} color="#fff" />
          </View>
        </GestureDetector>
      )}

      {/* Selection dot — non-primary selected */}
      {isSelected && !isPrimary && (
        <View style={[styles.selectedDot, { backgroundColor: color }]} />
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fieldRoot: {
    position: 'absolute',
  },
  fieldBody: {
    flex: 1,
    overflow: 'hidden',
  },
  fieldContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  fieldLabel: {
    fontWeight: '600',
    flexShrink: 1,
  },
  fillTextInput: {
    flex: 1,
    width: '100%',
    paddingHorizontal: 4,
    paddingVertical: 2,
    textAlignVertical: 'center',
    backgroundColor: 'transparent',
    ...(Platform.OS === 'web' ? {} : { includeFontPadding: false }),
  },
  fillSignatureImage: {
    width: '100%',
    height: '100%',
    backgroundColor: 'transparent',
  },
  fillSignHint: {
    fontWeight: '600',
    textAlign: 'center',
  },
  fillDateText: {
    fontWeight: '500',
    textAlign: 'center',
    width: '100%',
  },
  deleteBtn: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  resizeHandle: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  selectedDot: {
    position: 'absolute',
    top: -4,
    right: -4,
    width: 8,
    height: 8,
    borderRadius: 4,
    zIndex: 9,
  },
});

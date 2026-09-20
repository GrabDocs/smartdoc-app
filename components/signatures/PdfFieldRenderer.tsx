/**
 * PdfFieldRenderer — fill-side renderer for interactive signing.
 *
 * Uses the same utils/fillable/ geometry engine as PreparePageCanvas so that
 * prepare(rect) == fill(rect) == composited output rect for every page, zoom,
 * and device size.
 *
 * Core invariant: always use a fixed-size container (renderedW × renderedH),
 * never rely on Image resizeMode="contain" intrinsic layout for field positioning.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { captureRef } from 'react-native-view-shot';
import AlignmentDebugOverlay from './prepare/AlignmentDebugOverlay';
import { useThemeColors } from '../../hooks/useThemeColors';
import type { RuntimeDocument } from '../../types/signature';
import { fieldImageUri, isFieldEditable, dateFieldDisplayText } from '../../utils/signatureRuntime';
import {
  buildAlignmentOverlays,
  computeFitScale,
  computeRenderedSize,
  FIELD_OVERLAY_BACKGROUND,
  fieldToPixelRect,
  isDebugAlignmentEnabled,
} from '../../utils/fillable';

interface Props {
  document: RuntimeDocument;
  fieldValues: Record<string, unknown>;
  editableKeys: ReadonlySet<string>;
  activePage: number;
  onPageChange: (page: number) => void;
  onFieldPress: (fieldKey: string, fieldType: string) => void;
  onTextChange: (fieldKey: string, text: string) => void;
  onCheckboxToggle: (fieldKey: string, checked: boolean) => void;
  pageCaptureRef?: React.RefObject<View | null>;
}

export default function PdfFieldRenderer({
  document,
  fieldValues,
  editableKeys,
  activePage,
  onPageChange,
  onFieldPress,
  onTextChange,
  onCheckboxToggle,
  pageCaptureRef,
}: Props) {
  const colors = useThemeColors();
  const localRef = useRef<View>(null);
  const ref = pageCaptureRef ?? localRef;

  const [viewportSize, setViewportSize] = useState({ w: 0, h: 0 });

  const [pageDimensions, setPageDimensions] = useState<
    Record<number, { width: number; height: number }>
  >({});

  const page = document.pages[activePage];
  const pageDim = pageDimensions[activePage];
  const hasViewport = viewportSize.w > 0 && viewportSize.h > 0;
  const hasPageDimensions = (pageDim?.width ?? 0) > 0;
  const hasValidDimensions = hasViewport && hasPageDimensions;

  const fitScale = useMemo(
    () =>
      pageDim && viewportSize.w && viewportSize.h
        ? computeFitScale(
            { width: pageDim.width, height: pageDim.height },
            viewportSize.w,
            viewportSize.h,
          )
        : 0,
    [pageDim, viewportSize.w, viewportSize.h],
  );

  const zoomLevel = 1;
  const { renderedW, renderedH } = hasValidDimensions && fitScale
    ? computeRenderedSize({ width: pageDim!.width, height: pageDim!.height }, fitScale, zoomLevel)
    : { renderedW: 0, renderedH: 0 };

  const showDebug = isDebugAlignmentEnabled();

  const handleImageLoad = useCallback(
    (e: { nativeEvent: { source: { width: number; height: number } } }) => {
      const { width, height } = e.nativeEvent.source;
      if (width > 0 && height > 0) {
        setPageDimensions((prev) => ({ ...prev, [activePage]: { width, height } }));
      }
    },
    [activePage],
  );

  const handleViewportLayout = useCallback(
    (e: { nativeEvent: { layout: { width: number; height: number } } }) => {
      const { width, height } = e.nativeEvent.layout;
      setViewportSize({ w: width, h: height });
    },
    [],
  );

  if (!page) {
    return (
      <View style={styles.empty}>
        <Text style={{ color: colors.textSecondary }}>No pages</Text>
      </View>
    );
  }

  const pageFields = document.fields.filter((f) => f.rect?.page === activePage);

  const debugOverlays = showDebug && hasValidDimensions
    ? buildAlignmentOverlays(
        pageFields
          .filter((f) => f.rect)
          .map((f) => ({
            id: f.key,
            rect: { x: f.rect!.x, y: f.rect!.y, w: f.rect!.w, h: f.rect!.h },
          })),
        renderedW,
        renderedH,
        'fill',
      )
    : [];

  return (
    <View style={styles.wrap}>
      {/* Page tabs */}
      <FlatList
        horizontal
        data={document.pages}
        keyExtractor={(p) => String(p.index)}
        showsHorizontalScrollIndicator={false}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[
              styles.tab,
              item.index === activePage && {
                borderBottomColor: colors.primary,
                borderBottomWidth: 2,
              },
            ]}
            onPress={() => onPageChange(item.index)}
          >
            <Text
              style={{
                color:
                  item.index === activePage ? colors.primary : colors.textSecondary,
                fontSize: 13,
                fontWeight: item.index === activePage ? '600' : '400',
              }}
            >
              Page {item.index + 1}
            </Text>
          </TouchableOpacity>
        )}
        style={styles.tabs}
      />

      {/* Viewport — same fitScale inputs as prepare (viewportW × viewportH) */}
      <View style={styles.pageArea} onLayout={handleViewportLayout}>
        {!hasViewport ? (
          <View style={[styles.skeleton, { backgroundColor: colors.background }]}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : (
          <View
            ref={ref}
            collapsable={false}
            style={[
              styles.page,
              {
                width: hasValidDimensions ? renderedW : viewportSize.w,
                height: hasValidDimensions ? renderedH : viewportSize.h * 0.85,
                alignSelf: 'center',
              },
            ]}
          >
            <Image
              source={{ uri: page.imageUrl }}
              style={{
                width: hasValidDimensions ? renderedW : viewportSize.w,
                height: hasValidDimensions ? renderedH : viewportSize.h * 0.85,
              }}
              resizeMode="stretch"
              onLoad={handleImageLoad}
            />

            {!hasValidDimensions && (
              <View style={[styles.skeletonOverlay, { backgroundColor: colors.background }]}>
                <ActivityIndicator color={colors.primary} />
                <Text style={[styles.skeletonText, { color: colors.textSecondary }]}>
                  Loading page…
                </Text>
              </View>
            )}

            {hasValidDimensions &&
              pageFields.map((f) => {
              if (!f.rect) return null;
              const editable = isFieldEditable(editableKeys, f.key);
              const val = fieldValues[f.key];

              const pixelRect = fieldToPixelRect(
                { x: f.rect.x, y: f.rect.y, w: f.rect.w, h: f.rect.h },
                renderedW,
                renderedH,
              );

              if (f.type === 'checkbox') {
                const checked = Boolean(val);
                const boxSize = Math.min(pixelRect.width, pixelRect.height) * 0.72;
                return (
                  <TouchableOpacity
                    key={f.key}
                    style={[
                      styles.fieldBox,
                      {
                        left: pixelRect.left,
                        top: pixelRect.top,
                        width: pixelRect.width,
                        height: pixelRect.height,
                        borderColor: checked ? colors.tint : (colors.isDark ? colors.border : '#b8bec4'),
                        backgroundColor: checked
                          ? (colors.isDark ? 'rgba(59,130,246,0.24)' : colors.primaryLight)
                          : '#ffffff',
                        borderWidth: 2,
                      },
                    ]}
                    disabled={!editable}
                    onPress={() => onCheckboxToggle(f.key, !checked)}
                  >
                    <View
                      style={{
                        width: boxSize,
                        height: boxSize,
                        borderRadius: 3,
                        borderWidth: 2,
                        borderColor: checked ? colors.tint : (colors.isDark ? colors.border : '#b8bec4'),
                        backgroundColor: '#ffffff',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {checked ? (
                        <Text style={{ fontSize: Math.min(boxSize * 0.7, 16), color: colors.tint, fontWeight: '700' }}>
                          ✓
                        </Text>
                      ) : null}
                    </View>
                  </TouchableOpacity>
                );
              }

              if (f.type === 'text') {
                return (
                  <TextInput
                    key={f.key}
                    style={[
                      styles.textField,
                      {
                        left: pixelRect.left,
                        top: pixelRect.top,
                        width: pixelRect.width,
                        height: pixelRect.height,
                        color: colors.text,
                        borderColor: colors.primary,
                      },
                    ]}
                    editable={editable}
                    value={typeof val === 'string' ? val : ''}
                    onChangeText={(t) => onTextChange(f.key, t)}
                    placeholder={f.label}
                    placeholderTextColor={colors.textSecondary}
                    multiline={pixelRect.height > 40}
                    underlineColorAndroid="transparent"
                    autoComplete="name"
                    textContentType="name"
                    importantForAutofill="yes"
                  />
                );
              }

              if (f.type === 'date' || f.type === 'datetime') {
                const dateText = dateFieldDisplayText(val);
                return (
                  <View
                    key={f.key}
                    style={[
                      styles.fieldBox,
                      {
                        left: pixelRect.left,
                        top: pixelRect.top,
                        width: pixelRect.width,
                        height: pixelRect.height,
                        borderColor: `${colors.primary}88`,
                        backgroundColor: FIELD_OVERLAY_BACKGROUND,
                      },
                    ]}
                    accessibilityLabel={dateText ? `Date ${dateText}` : f.label}
                  >
                    <Text
                      style={{
                        fontSize: Math.max(Math.min(pixelRect.height * 0.4, 13), 9),
                        color: colors.text,
                        textAlign: 'center',
                        paddingHorizontal: 2,
                      }}
                      numberOfLines={2}
                    >
                      {dateText || f.label}
                    </Text>
                  </View>
                );
              }

              const imgUri = fieldImageUri(val);
              return (
                <TouchableOpacity
                  key={f.key}
                  style={[
                    styles.fieldBox,
                    {
                      left: pixelRect.left,
                      top: pixelRect.top,
                      width: pixelRect.width,
                      height: pixelRect.height,
                      borderColor: editable ? colors.primary : `${colors.primary}55`,
                      backgroundColor: FIELD_OVERLAY_BACKGROUND,
                    },
                  ]}
                  disabled={!editable}
                  onPress={() => onFieldPress(f.key, f.type)}
                >
                  {imgUri ? (
                    <Image
                      source={{ uri: imgUri }}
                      style={{ width: '100%', height: '100%', backgroundColor: 'transparent' }}
                      resizeMode="contain"
                    />
                  ) : (
                    <Text
                      style={{
                        fontSize: Math.max(Math.min(pixelRect.height * 0.4, 13), 9),
                        color: editable ? colors.primary : colors.textSecondary,
                        textAlign: 'center',
                      }}
                      numberOfLines={1}
                    >
                      {f.label}
                    </Text>
                  )}
                </TouchableOpacity>
              );
            })}

            {showDebug && hasValidDimensions && (
              <AlignmentDebugOverlay overlays={debugOverlays} />
            )}
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, paddingHorizontal: 14 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tabs: { maxHeight: 40, marginBottom: 8 },
  tab: { paddingHorizontal: 12, paddingVertical: 8, marginRight: 4 },
  pageArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingVertical: 8,
  },
  skeleton: {
    flex: 1,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    minHeight: 320,
  },
  skeletonText: { fontSize: 13 },
  skeletonOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    zIndex: 50,
  },
  page: {
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  fieldBox: {
    position: 'absolute',
    borderWidth: 1.5,
    borderRadius: 3,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: FIELD_OVERLAY_BACKGROUND,
  },
  textField: {
    position: 'absolute',
    borderWidth: 1.5,
    borderRadius: 3,
    paddingHorizontal: 4,
    fontSize: 12,
    backgroundColor: FIELD_OVERLAY_BACKGROUND,
    ...(Platform.OS === 'web' ? {} : { includeFontPadding: false }),
  },
});

export async function capturePageRef(ref: React.RefObject<View | null>): Promise<string | null> {
  if (!ref.current) return null;
  try {
    const uri = await captureRef(ref, { format: 'jpg', quality: 0.85, result: 'tmpfile' });
    const { readAsStringAsync, EncodingType } = await import('expo-file-system/legacy');
    return readAsStringAsync(uri, { encoding: EncodingType.Base64 });
  } catch {
    return null;
  }
}

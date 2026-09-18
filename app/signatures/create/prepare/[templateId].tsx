/**
 * PreparePdfScreen — thin shell wired to usePrepareEditor.
 *
 * Responsibilities:
 * - Load template on mount
 * - Back navigation dirty guard (custom header back + beforeRemove for hardware/swipe back)
 * - Delegate all state/actions to the hook
 * - Compose header, tool palette, canvas, and properties sheet
 */

import { useNavigation } from '@react-navigation/native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FeedbackTouchable } from '../../../../components/FeedbackTouchable';
import PrepareHeader from '../../../../components/signatures/prepare/PrepareHeader';
import PreparePageCanvas from '../../../../components/signatures/prepare/PreparePageCanvas';
import PreparePropertiesSheet from '../../../../components/signatures/prepare/PreparePropertiesSheet';
import PrepareToolPalette from '../../../../components/signatures/prepare/PrepareToolPalette';
import { usePrepareEditor } from '../../../../hooks/usePrepareEditor';
import { useThemeColors } from '../../../../hooks/useThemeColors';

export default function PreparePdfScreen() {
  const { templateId } = useLocalSearchParams<{ templateId: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const colors = useThemeColors();
  const editor = usePrepareEditor();
  const scrollRef = useRef<ScrollView>(null);
  // Keep a stable ref to isDirty so the beforeRemove listener doesn't go stale
  const isDirtyRef = useRef(editor.isDirty);
  isDirtyRef.current = editor.isDirty;

  // Load template on mount
  useEffect(() => {
    if (templateId) {
      void editor.load(templateId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId]);

  // Intercept Android hardware back / swipe-back while dirty
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (e) => {
      if (!isDirtyRef.current) return;
      e.preventDefault();
      Alert.alert(
        'Unsaved changes',
        'You have unsaved changes. Discard and go back?',
        [
          { text: 'Keep editing', style: 'cancel' },
          {
            text: 'Discard',
            style: 'destructive',
            onPress: () => navigation.dispatch(e.data.action),
          },
        ],
      );
    });
    return unsubscribe;
  }, [navigation]);

  const handleBack = useCallback(() => {
    if (editor.isDirty) {
      Alert.alert(
        'Unsaved changes',
        'You have unsaved changes. Discard and go back?',
        [
          { text: 'Keep editing', style: 'cancel' },
          { text: 'Discard', style: 'destructive', onPress: () => router.back() },
        ],
      );
    } else {
      router.back();
    }
  }, [editor.isDirty, router]);

  const handleSave = useCallback(() => {
    if (!templateId) return;
    void editor.save(templateId);
  }, [editor, templateId]);

  // ── Loading state ──────────────────────────────────────────────────────────
  if (editor.isLoading) {
    return (
      <SafeAreaView style={[styles.centered, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={[styles.statusText, { color: colors.textSecondary }]}>
          {editor.isConverting
            ? 'Preparing document for editing… this can take a bit longer the first time.'
            : 'Loading template…'}
        </Text>
      </SafeAreaView>
    );
  }

  // ── Error state ────────────────────────────────────────────────────────────
  if (editor.loadError) {
    return (
      <SafeAreaView style={[styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.errorText, { color: colors.error ?? '#EF4444' }]}>
          {editor.loadError}
        </Text>
        <FeedbackTouchable
          style={[styles.retryBtn, { backgroundColor: colors.primary }]}
          onPress={() => (templateId ? editor.load(templateId) : undefined)}
          spinnerColor="#fff"
        >
          <Text style={styles.retryText}>Retry</Text>
        </FeedbackTouchable>
        <TouchableOpacity onPress={() => router.back()} style={styles.backLink}>
          <Text style={{ color: colors.textSecondary }}>Go back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaView
        style={[styles.safe, { backgroundColor: colors.background }]}
        edges={['top', 'left', 'right']}
      >
        {/* Header: back, undo/redo, page nav, zoom, save */}
        <PrepareHeader
          editor={editor}
          onBack={handleBack}
          onSave={handleSave}
        />

        {/* Tool palette: cursor + field types + field list */}
        <PrepareToolPalette editor={editor} />

        {/* Main canvas + overlays */}
        <View style={styles.canvasWrapper}>
          <PreparePageCanvas
            editor={editor}
            scrollRef={scrollRef}
          />

          {/* Properties sheet slides up when a field is selected */}
          <PreparePropertiesSheet editor={editor} />
        </View>
      </SafeAreaView>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  safe: { flex: 1 },
  canvasWrapper: { flex: 1, position: 'relative' },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    paddingHorizontal: 24,
  },
  statusText: {
    fontSize: 14,
    marginTop: 12,
  },
  errorText: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
  retryBtn: {
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 8,
    marginTop: 4,
  },
  retryText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
  backLink: {
    marginTop: 8,
    padding: 8,
  },
});

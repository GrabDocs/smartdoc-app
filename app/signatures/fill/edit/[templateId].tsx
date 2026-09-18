/**
 * FillDocumentEditor — place controls on a document to complete it yourself.
 * Reuses the prepare editor (field tools + canvas). No properties sheet — fill is direct entry only.
 */

import { useNavigation } from '@react-navigation/native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { GestureHandlerRootView, ScrollView } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { FeedbackTouchable } from '../../../../components/FeedbackTouchable';
import SignatureCaptureModal from '../../../../components/signatures/SignatureCaptureModal';
import FillCaptureHost, {
  type FillCaptureHostHandle,
} from '../../../../components/signatures/fill/FillCaptureHost';
import FillDatePickerModal from '../../../../components/signatures/FillDatePickerModal';
import PrepareHeader from '../../../../components/signatures/prepare/PrepareHeader';
import PreparePageCanvas from '../../../../components/signatures/prepare/PreparePageCanvas';
import PrepareToolPalette from '../../../../components/signatures/prepare/PrepareToolPalette';
import { useFillSubmit } from '../../../../hooks/useFillSubmit';
import { invalidateSignatureActivityCache } from '../../../../hooks/useSignatureAllList';
import { usePrepareEditor } from '../../../../hooks/usePrepareEditor';
import { useThemeColors } from '../../../../hooks/useThemeColors';
import { formatFillDate, parseFillDate } from '../../../../utils/fillDate';
import { hubFillCompleteRoute } from '../../../../utils/signatureRouteResolver';

export default function FillDocumentEditorScreen() {
  const { templateId } = useLocalSearchParams<{ templateId: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const colors = useThemeColors();
  const editor = usePrepareEditor();
  const scrollRef = useRef<ScrollView>(null);
  const captureHostRef = useRef<FillCaptureHostHandle>(null);
  const isDirtyRef = useRef(editor.isDirty);
  isDirtyRef.current = editor.isDirty;
  const [fieldValues, setFieldValues] = useState<Record<string, unknown>>({});
  const [signatureModal, setSignatureModal] = useState<{
    fieldId: string;
    label: string;
    variant: 'signature' | 'initials';
    expandNonce: number;
  } | null>(null);
  const [datePickerModal, setDatePickerModal] = useState<{
    fieldId: string;
    label: string;
    value: Date;
    expandNonce: number;
  } | null>(null);
  const prevFieldCountRef = useRef(0);
  const editorInitializedRef = useRef(false);

  const { finish, isFinishing } = useFillSubmit({
    templateId: templateId ?? '',
    templateName: editor.templateName,
    editor,
    fieldValues,
    captureHostRef,
  });

  const handleFieldValueChange = useCallback((fieldId: string, value: unknown) => {
    setFieldValues((prev) => ({ ...prev, [fieldId]: value }));
  }, []);

  const handleSignatureRequest = useCallback(
    (fieldId: string, label: string) => {
      const field = editor.fields.find((f) => f.id === fieldId);
      setSignatureModal((prev) => ({
        fieldId,
        label,
        variant: field?.type === 'initials' ? 'initials' : 'signature',
        expandNonce: (prev?.expandNonce ?? 0) + 1,
      }));
    },
    [editor.fields],
  );

  const handleDateFieldPress = useCallback(
    (fieldId: string, currentValue?: string) => {
      const initial = parseFillDate(currentValue);
      if (Platform.OS === 'android') {
        DateTimePickerAndroid.open({
          value: initial,
          mode: 'date',
          onChange: (event, date) => {
            if (event.type === 'set' && date) {
              handleFieldValueChange(fieldId, formatFillDate(date));
            }
          },
        });
        return;
      }
      const field = editor.fields.find((f) => f.id === fieldId);
      setDatePickerModal((prev) => ({
        fieldId,
        label: field?.label || 'Date',
        value: initial,
        expandNonce: (prev?.expandNonce ?? 0) + 1,
      }));
    },
    [editor.fields, handleFieldValueChange],
  );

  const canvasProps = {
    editor,
    scrollRef,
    fillMode: true as const,
    fieldValues,
    onFieldValueChange: handleFieldValueChange,
    onSignatureRequest: handleSignatureRequest,
    onDateFieldPress: handleDateFieldPress,
  };

  const fieldCount = editor.fields.length;
  const primaryFieldId = editor.primarySelectedFieldId;

  useEffect(() => {
    if (editor.isLoading) return;
    if (!editorInitializedRef.current) {
      editorInitializedRef.current = true;
      prevFieldCountRef.current = fieldCount;
      return;
    }
    if (fieldCount > prevFieldCountRef.current && primaryFieldId) {
      const field = editor.fields.find((f) => f.id === primaryFieldId);
      if (field && (field.type === 'signature' || field.type === 'initials')) {
        setSignatureModal((prev) => ({
          fieldId: field.id,
          label: field.label || field.type,
          variant: field.type === 'initials' ? 'initials' : 'signature',
          expandNonce: (prev?.expandNonce ?? 0) + 1,
        }));
      }
      if (field?.type === 'date') {
        handleFieldValueChange(field.id, formatFillDate(new Date()));
      }
    }
    prevFieldCountRef.current = fieldCount;
  }, [fieldCount, primaryFieldId, editor.fields, editor.isLoading, handleFieldValueChange]);

  useEffect(() => {
    if (templateId) {
      editorInitializedRef.current = false;
      prevFieldCountRef.current = 0;
      void editor.load(templateId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId]);

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

  const handleFinish = useCallback(() => {
    if (!templateId) return;
    Alert.alert(
      'Finish document?',
      'A completed PDF will be saved to your Documents. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          onPress: () => {
            void (async () => {
              const result = await finish();
              if (!result) return;
              invalidateSignatureActivityCache();
              router.replace(
                hubFillCompleteRoute({
                  templateId,
                  filledFileId: result.filledFileId,
                  submissionId: result.submissionId,
                  templateName: result.templateName,
                }),
              );
            })();
          },
        },
      ],
    );
  }, [finish, router, templateId]);

  if (editor.isLoading) {
    return (
      <SafeAreaView style={[styles.centered, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={[styles.statusText, { color: colors.textSecondary }]}>
          {editor.isConverting
            ? 'Preparing document… this can take a bit longer the first time.'
            : 'Loading document…'}
        </Text>
      </SafeAreaView>
    );
  }

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
        <PrepareHeader
          editor={editor}
          onBack={handleBack}
          onSave={handleSave}
          showFinish
          onFinish={handleFinish}
          isFinishing={isFinishing}
        />
        <PrepareToolPalette editor={editor} />
        {Platform.OS === 'ios' ? (
          <KeyboardAvoidingView
            style={styles.canvasWrapper}
            behavior="padding"
            keyboardVerticalOffset={4}
          >
            <PreparePageCanvas {...canvasProps} />
          </KeyboardAvoidingView>
        ) : (
          <View style={styles.canvasWrapper}>
            <PreparePageCanvas {...canvasProps} />
          </View>
        )}
        {datePickerModal ? (
          <FillDatePickerModal
            key={datePickerModal.fieldId}
            visible
            expandNonce={datePickerModal.expandNonce}
            fieldLabel={datePickerModal.label}
            value={datePickerModal.value}
            onClose={() => setDatePickerModal(null)}
            onSave={(dateStr) => {
              handleFieldValueChange(datePickerModal.fieldId, dateStr);
              setDatePickerModal(null);
            }}
          />
        ) : null}
        {signatureModal ? (
          <SignatureCaptureModal
            key={signatureModal.fieldId}
            visible
            expandNonce={signatureModal.expandNonce}
            variant={signatureModal.variant}
            fieldLabel={signatureModal.label}
            onClose={() => setSignatureModal(null)}
            onSave={(uri) => {
              handleFieldValueChange(signatureModal.fieldId, { image: uri });
              setSignatureModal(null);
            }}
          />
        ) : null}
        <FillCaptureHost
          ref={captureHostRef}
          pageImages={editor.pageImages}
          pageDimensions={editor.pageDimensions}
          fields={editor.fields}
          fieldValues={fieldValues}
        />
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
  statusText: { fontSize: 14, marginTop: 12 },
  errorText: { fontSize: 15, textAlign: 'center', lineHeight: 22 },
  retryBtn: {
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 8,
    marginTop: 4,
  },
  retryText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  backLink: { marginTop: 8, padding: 8 },
});

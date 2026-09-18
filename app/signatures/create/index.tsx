import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ClientsButton from '../../../components/clients/ClientsButton';
import { FeedbackTouchable } from '../../../components/FeedbackTouchable';
import { UploadOptionsModal } from '../../components/UploadOptionsModal';
import DocumentSourcePicker, {
  pickDocumentsForFillable,
  pickGalleryImagesLikeFilesScreen } from '../../../components/signatures/DocumentSourcePicker';
import { useEnvelopeDraft } from '../../../hooks/useEnvelopeDraft';
import { useMinimizableSheet } from '../../../hooks/useMinimizableSheet';
import { useThemeColors } from '../../../hooks/useThemeColors';
import { useAuth } from '../../context/auth';
import { createEnvelope, getEnvelope, replaceDocuments, updateEnvelopeDraft } from '../../../services/envelopeApi';
import { setItemClients } from '../../../services/clientsApi';
import { uploadDocumentForFillable } from '../../../services/uploadWithGlobalProgress';
import type { SourceInput, WizardSourceDraft } from '../../../types/signature';
import { saveDraftStep } from '../../../services/signatureSessionCache';
import { useFileStore } from '../../../stores/fileStore';
import { envelopeDocsToWizardSources, wizardSourcesToReplaceDocuments } from '../../../utils/signatureRuntime';

import AppBackButton from '../../../components/AppBackButton';
import AppHeaderTitle from '../../../components/AppHeaderTitle';

function newLocalId() {
  return `src_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export default function CreateEnvelopeScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const params = useLocalSearchParams<{ envelopeId?: string; client_id?: string }>();
  const { saveWizardSources, loadWizardSources } = useEnvelopeDraft();
  const { user } = useAuth();
  const [sources, setSources] = useState<WizardSourceDraft[]>([]);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const uploadSheet = useMinimizableSheet();
  const [uploading, setUploading] = useState(false);
  const [selectedClientIds, setSelectedClientIds] = useState<number[]>([]);
  const [envelopeNumericId, setEnvelopeNumericId] = useState<number | undefined>();
  const linkedClientRef = useRef<number | null>(null);

  useEffect(() => {
    const raw = Array.isArray(params.client_id) ? params.client_id[0] : params.client_id;
    const clientId = typeof raw === 'string' && /^\d+$/.test(raw) ? parseInt(raw, 10) : null;
    if (!clientId) return;
    setSelectedClientIds((prev) => (prev.includes(clientId) ? prev : [...prev, clientId]));
  }, [params.client_id]);

  useEffect(() => {
    void (async () => {
      if (params.envelopeId) {
        const res = await getEnvelope(params.envelopeId);
        setTitle(res.envelope.title ?? '');
        setMessage(res.envelope.message ?? '');
        setEnvelopeNumericId(res.envelope.id);
        const docs = res.envelope.documents ?? [];
        if (docs.length) {
          const hydrated = envelopeDocsToWizardSources(docs);
          setSources(hydrated);
          void saveWizardSources(hydrated);
        }
      } else {
        const cached = await loadWizardSources();
        if (cached.length) setSources(cached);
      }
    })();
  }, [params.envelopeId, loadWizardSources, saveWizardSources]);

  useEffect(() => {
    if (!envelopeNumericId || selectedClientIds.length === 0) return;
    if (linkedClientRef.current === envelopeNumericId) return;
    linkedClientRef.current = envelopeNumericId;
    void setItemClients({
      client_ids: selectedClientIds,
      item_type: 'signature_envelope',
      item_id: envelopeNumericId,
    }).catch(() => {
      linkedClientRef.current = null;
    });
  }, [envelopeNumericId, selectedClientIds]);

  const persistSources = (next: WizardSourceDraft[]) => {
    setSources(next);
    void saveWizardSources(next);
  };

  const addSignatureUploads = useCallback(
    async (assets: Array<{ uri: string; name?: string | null; mimeType?: string | null }>) => {
      const added: WizardSourceDraft[] = [];

      for (const asset of assets) {
        // Return as soon as the file + template exist so the Documents list updates
        // immediately — do not block on page-image rasterization.
        const { templateId, displayName } = await uploadDocumentForFillable(
          {
            uri: asset.uri,
            name: asset.name ?? 'Document',
            mimeType: asset.mimeType ?? null },
          { waitForPages: false },
        );
        const draft: WizardSourceDraft = {
          localId: newLocalId(),
          source_type: 'fillable',
          fillable_template_id: templateId,
          display_name: displayName,
          needsPrepare: true };
        added.push(draft);
        setSources((prev) => {
          const nextSources = [...prev, draft];
          void saveWizardSources(nextSources);
          return nextSources;
        });
      }

      if (!added.length) return;

      const firstTemplateId = added[0].fillable_template_id;
      if (firstTemplateId) {
        // Prepare editor waits for page images if they are still rasterizing.
        router.push(`/signatures/create/prepare/${firstTemplateId}` as any);
      }
    },
    [router, saveWizardSources],
  );

  const dismissUploadModal = useCallback(() => {
    uploadSheet.close();
  }, [uploadSheet]);

  const handleUploadFromFilesViaModal = useCallback(async () => {
    if (uploading) return;

    uploadSheet.close();
    await new Promise((resolve) => setTimeout(resolve, 500));

    try {
      setUploading(true);
      await useFileStore.getState().forceResetDocumentPicker();
      const assets = await pickDocumentsForFillable();
      if (!assets?.length) return;
      await addSignatureUploads(assets);
    } catch (e: unknown) {
      Alert.alert('Upload failed', e instanceof Error ? e.message : 'Try again');
    } finally {
      setUploading(false);
    }
  }, [addSignatureUploads, uploading, uploadSheet]);

  const handleUploadFromCameraViaModal = useCallback(() => {
    uploadSheet.close();
    router.push('/scanner');
  }, [router, uploadSheet]);

  const handleUploadFromGalleryViaModal = useCallback(async () => {
    if (uploading) return;

    uploadSheet.close();
    await new Promise((resolve) => setTimeout(resolve, 500));

    try {
      setUploading(true);
      const assets = await pickGalleryImagesLikeFilesScreen();
      if (!assets?.length) return;
      await addSignatureUploads(assets);
    } catch (e: unknown) {
      Alert.alert('Upload failed', e instanceof Error ? e.message : 'Try again');
    } finally {
      setUploading(false);
    }
  }, [addSignatureUploads, uploading, uploadSheet]);

  const handleUploadByLinkViaModal = useCallback(() => {
    uploadSheet.close();
    router.push('/upload-by-link-code');
  }, [router, uploadSheet]);

  const handleNext = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      Alert.alert('Title required', 'Enter a title for this envelope.');
      return;
    }
    if (!sources.length) {
      Alert.alert('Add documents', 'Add at least one document.');
      return;
    }
    setSaving(true);
    try {
      const apiSources: SourceInput[] = sources.map((s) => {
        if (s.source_type === 'fillable') {
          return { source_type: 'fillable', fillable_template_id: s.fillable_template_id! };
        }
        if (s.source_type === 'form') {
          return { source_type: 'form', user_form_id: s.user_form_id! };
        }
        return { source_type: 'attachment', file_id: s.file_id! };
      });
      let envelopeId = params.envelopeId;
      if (!envelopeId) {
        const res = await createEnvelope({
          sources: apiSources,
          title: trimmedTitle,
          message: message || undefined });
        envelopeId = res.envelope.public_id || String(res.envelope.id);
        setEnvelopeNumericId(res.envelope.id);
        if (selectedClientIds.length > 0) {
          try {
            await setItemClients({
              client_ids: selectedClientIds,
              item_type: 'signature_envelope',
              item_id: res.envelope.id,
            });
            linkedClientRef.current = res.envelope.id;
          } catch {
            /* non-fatal */
          }
        }
      } else {
        const existing = await getEnvelope(envelopeId);
        setEnvelopeNumericId(existing.envelope.id);
        await updateEnvelopeDraft(envelopeId, {
          title: trimmedTitle,
          message: message || undefined });
        await replaceDocuments(
          envelopeId,
          wizardSourcesToReplaceDocuments(sources, existing.envelope.documents),
        );
      }
      await saveDraftStep(user?.id, envelopeId, 'recipients');
      router.push(`/signatures/create/recipients?envelopeId=${envelopeId}` as any);
    } catch (e: unknown) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Failed to create');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { backgroundColor: colors.headerBackground }]}>
        <AppBackButton />
        <AppHeaderTitle>Prepare for Signature</AppHeaderTitle>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, marginBottom: 6 }}>
          <Text style={[styles.label, { color: colors.text, marginTop: 0, marginBottom: 0 }]}>Title</Text>
          <ClientsButton
            selectedClientIds={selectedClientIds}
            onChange={setSelectedClientIds}
            itemType={envelopeNumericId ? 'signature_envelope' : undefined}
            itemId={envelopeNumericId}
            compact
            label="Clients"
          />
        </View>
        <TextInput
          style={[styles.input, { color: colors.text, borderColor: colors.border }]}
          value={title}
          onChangeText={setTitle}
          placeholder="Envelope title"
          placeholderTextColor={colors.textSecondary}
        />
        <Text style={[styles.label, { color: colors.text }]}>Message (optional)</Text>
        <TextInput
          style={[styles.input, styles.multiline, { color: colors.text, borderColor: colors.border }]}
          value={message}
          onChangeText={setMessage}
          placeholder="Message to signers"
          placeholderTextColor={colors.textSecondary}
          multiline
        />
        <DocumentSourcePicker
          sources={sources}
          onSourcesChange={persistSources}
          onOpenUpload={() => uploadSheet.open()}
          onPrepare={(templateId) => router.push(`/signatures/create/prepare/${templateId}` as any)}
        />
        <FeedbackTouchable
          style={[styles.nextBtn, { backgroundColor: colors.primary, opacity: saving ? 0.6 : 1 }]}
          disabled={saving}
          loading={saving}
          onPress={handleNext}
          spinnerColor="#fff"
          replaceWithSpinner={false}
        >
          <Text style={styles.nextText}>{saving ? 'Saving…' : 'Next: Recipients'}</Text>
        </FeedbackTouchable>
      </ScrollView>
      <UploadOptionsModal
        visible={uploadSheet.visible}
        expandNonce={uploadSheet.expandNonce}
        isUploading={uploading}
        onDismiss={dismissUploadModal}
        onFiles={handleUploadFromFilesViaModal}
        onCamera={handleUploadFromCameraViaModal}
        onGallery={handleUploadFromGalleryViaModal}
        onLink={handleUploadByLinkViaModal}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12 },
  headerTitle: { fontSize: 18, fontWeight: '600' },
  content: { padding: 14, paddingBottom: 40 },
  label: { fontWeight: '600', marginBottom: 6, marginTop: 12 },
  input: { borderWidth: 1, borderRadius: 8, padding: 12, fontSize: 16 },
  multiline: { minHeight: 80, textAlignVertical: 'top' },
  nextBtn: { marginTop: 24, padding: 14, borderRadius: 8, alignItems: 'center' },
  nextText: { color: '#fff', fontWeight: '700' } });

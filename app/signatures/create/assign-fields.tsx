import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ActionMenuModal, { type ActionMenuItem } from '../../../components/ActionMenuModal';
import { FeedbackTouchable } from '../../../components/FeedbackTouchable';
import FileNameText from '../../../components/FileNameText';
import { useThemeColors } from '../../../hooks/useThemeColors';
import { useAuth } from '../../context/auth';
import { getEnvelope, putFieldAssignments } from '../../../services/envelopeApi';
import { getFillableTemplate } from '../../../services/fillableApi';
import { apiService } from '../../../services/api';
import type {
  Envelope,
  EnvelopeDocument,
  FieldAssignmentInput,
  FieldType,
  WizardField,
} from '../../../types/signature';
import { makeFieldKey } from '../../../utils/fieldKeys';
import { FIELD_DEFAULTS } from '../../../utils/fillable';
import { validateSignerFieldCoverage } from '../../../utils/signatureAssignmentCoverage';
import { saveDraftStep } from '../../../services/signatureSessionCache';

import AppBackButton from '../../../components/AppBackButton';
import AppHeaderTitle from '../../../components/AppHeaderTitle';

const FIELD_TYPE_LABELS: Record<string, string> = {
  signature: 'Signature',
  initials: 'Initials',
  date: 'Date',
  text: 'Text',
  checkbox: 'Checkbox',
};

function displayNameForField(
  fieldKey: string,
  fieldType: string | undefined,
  labelsByKey: Record<string, string>,
): string {
  const fromMeta = labelsByKey[fieldKey]?.trim();
  if (fromMeta) return fromMeta;
  const typeKey = (fieldType || '').toLowerCase();
  return (
    FIELD_TYPE_LABELS[typeKey] ||
    FIELD_DEFAULTS[typeKey as FieldType]?.label ||
    (fieldType ? String(fieldType) : 'Field')
  );
}

export default function AssignFieldsScreen() {
  const { envelopeId } = useLocalSearchParams<{ envelopeId: string }>();
  const router = useRouter();
  const colors = useThemeColors();
  const { user } = useAuth();
  const [envelope, setEnvelope] = useState<Envelope | null>(null);
  const [assignments, setAssignments] = useState<FieldAssignmentInput[]>([]);
  const [fieldLabelsByKey, setFieldLabelsByKey] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [assignMenuIndex, setAssignMenuIndex] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!envelopeId) {
        setLoading(false);
        setLoadError('Missing envelope');
        return;
      }
      setLoading(true);
      setLoadError(null);
      try {
        const res = await getEnvelope(envelopeId);
        if (cancelled) return;
        setEnvelope(res.envelope);
        const { labels, defaults } = await loadFieldMetaAndDefaults(res.envelope);
        if (cancelled) return;
        setFieldLabelsByKey(labels);
        const existing = res.envelope.field_assignments ?? [];
        if (existing.length) {
          setAssignments(
            existing.map((a) => ({
              recipient_id: a.recipient_id,
              document_id: a.document_id ?? undefined,
              field_key: a.field_key,
              field_type: a.field_type,
              required: a.required })),
          );
        } else {
          setAssignments(defaults);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : 'Failed to load fields');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [envelopeId]);

  const signers = (envelope?.recipients ?? []).filter((r) => r.role === 'signer');
  const firstSignerId = signers[0]?.id;
  const coverage = useMemo(
    () => validateSignerFieldCoverage(signers, assignments),
    [signers, assignments]
  );
  const fieldsNeedAssignment = assignments.length > 0;
  const coverageOk = !fieldsNeedAssignment || coverage.ok;
  const canProceed = !loading && !loadError && !!firstSignerId && coverageOk;

  const pickRecipient = (index: number) => {
    if (!signers.length || loading) return;
    setAssignMenuIndex(index);
  };

  const assignMenuItems = useMemo((): ActionMenuItem[] => {
    if (assignMenuIndex == null) return [];
    return signers.map((s) => ({
      id: String(s.id),
      label: s.name || s.email,
      icon: 'person-outline' as const,
      iconColor: colors.primary,
      onPress: () => {
        setAssignments((prev) =>
          prev.map((a, i) => (i === assignMenuIndex ? { ...a, recipient_id: s.id } : a)),
        );
      } }));
  }, [assignMenuIndex, colors.primary, signers]);

  const handleNext = async () => {
    if (!envelopeId || loading || loadError || !firstSignerId || saving) return;
    if (!assignments.length) {
      Alert.alert(
        'No fields',
        'Send without signature fields?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Continue',
            onPress: () => router.push(`/signatures/create/review?envelopeId=${envelopeId}&acknowledgeOnly=1` as any) },
        ],
      );
      return;
    }
    const check = validateSignerFieldCoverage(signers, assignments);
    if (!check.ok) {
      Alert.alert('Assign fields', check.message);
      return;
    }
    setSaving(true);
    try {
      await putFieldAssignments(envelopeId, assignments);
      await saveDraftStep(user?.id, envelopeId, 'review');
      router.push(`/signatures/create/review?envelopeId=${envelopeId}` as any);
    } catch (e: unknown) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { backgroundColor: colors.headerBackground }]}>
        <AppBackButton />
        <AppHeaderTitle>Assign fields</AppHeaderTitle>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {loading ? (
          <View style={styles.loadingBlock}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={{ color: colors.textSecondary, marginTop: 12 }}>
              Loading fields…
            </Text>
          </View>
        ) : loadError ? (
          <Text style={{ color: colors.error ?? '#EF4444', marginBottom: 16 }}>{loadError}</Text>
        ) : (
          <>
            <Text style={{ color: colors.textSecondary, marginBottom: 16 }}>
              Tap a field to change its signer. {assignments.length} field(s) configured.
              {signers.length > 1
                ? ' Each signer must have at least one field before you can continue.'
                : ''}
            </Text>
            {fieldsNeedAssignment && !coverage.ok ? (
              <View
                style={[
                  styles.coverageWarn,
                  {
                    backgroundColor: colors.surface,
                    borderColor: colors.error ?? '#EF4444' },
                ]}
              >
                <Text style={{ color: colors.error ?? '#EF4444', fontSize: 13, lineHeight: 18 }}>
                  {coverage.message}
                </Text>
              </View>
            ) : null}
            {(envelope?.documents ?? []).map((doc) => {
              const docAssignments = assignments.filter((a) => a.document_id === doc.id);
              if (!docAssignments.length) return null;
              return (
                <View key={doc.id} style={[styles.docBlock, { borderColor: colors.border }]}>
                  <FileNameText name={doc.display_name} style={[styles.docName, { color: colors.text }]} />
                  {docAssignments.map((a) => {
                    const signer = signers.find((s) => s.id === a.recipient_id);
                    const globalIdx = assignments.indexOf(a);
                    return (
                      <TouchableOpacity
                        key={a.field_key}
                        style={styles.fieldRow}
                        onPress={() => pickRecipient(globalIdx)}
                      >
                        <Text style={{ color: colors.text, flex: 1 }} numberOfLines={1}>
                          {displayNameForField(a.field_key, a.field_type, fieldLabelsByKey)}
                        </Text>
                        <Text style={{ color: colors.primary, fontSize: 13 }}>
                          {signer?.name || signer?.email || 'Unassigned'}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              );
            })}
          </>
        )}
        <FeedbackTouchable
          style={[
            styles.nextBtn,
            {
              backgroundColor: colors.primary,
              opacity: canProceed && !saving ? 1 : 0.5 },
          ]}
          disabled={!canProceed || saving}
          loading={saving || loading}
          onPress={handleNext}
          spinnerColor="#fff"
          replaceWithSpinner={false}
        >
          <Text style={styles.nextText}>
            {loading ? 'Loading…' : saving ? 'Saving…' : 'Next: Review'}
          </Text>
        </FeedbackTouchable>
      </ScrollView>
      <ActionMenuModal
        visible={assignMenuIndex != null}
        title="Assign to"
        items={assignMenuItems}
        onClose={() => setAssignMenuIndex(null)}
      />
    </SafeAreaView>
  );
}

async function loadFieldMetaAndDefaults(envelope: Envelope): Promise<{
  labels: Record<string, string>;
  defaults: FieldAssignmentInput[];
}> {
  const signers = (envelope.recipients ?? []).filter((r) => r.role === 'signer');
  const recipientId = signers[0]?.id;
  const labels: Record<string, string> = {};
  const defaults: FieldAssignmentInput[] = [];
  for (const doc of envelope.documents ?? []) {
    const fields = await loadFieldsForDoc(doc);
    for (const f of fields) {
      const fieldKey = makeFieldKey(f.id, f.rev ?? 1);
      const typeKey = String(f.type || '').toLowerCase();
      const label =
        (f.label || '').trim() ||
        FIELD_TYPE_LABELS[typeKey] ||
        FIELD_DEFAULTS[typeKey as FieldType]?.label ||
        String(f.type || 'Field');
      const pagePart =
        typeof f.page === 'number' && Number.isFinite(f.page) ? ` · p${f.page + 1}` : '';
      labels[fieldKey] = `${label}${pagePart}`;
      if (recipientId) {
        defaults.push({
          recipient_id: recipientId,
          document_id: doc.id,
          field_key: fieldKey,
          field_type: f.type,
          required: f.required ?? false,
        });
      }
    }
  }
  return { labels, defaults };
}

async function loadFieldsForDoc(doc: EnvelopeDocument): Promise<WizardField[]> {
  if (doc.source_type === 'attachment') return [];
  if (doc.source_type === 'fillable' && doc.fillable_template_id) {
    const t = await getFillableTemplate(doc.fillable_template_id);
    return t.json_fields?.fields ?? [];
  }
  if (doc.source_type === 'form' && doc.user_form_id) {
    const res = await apiService.getFormById(doc.user_form_id);
    const form = (res as { form?: { json_fields?: unknown } }).form;
    const jf = form?.json_fields;
    if (jf && typeof jf === 'object' && Array.isArray((jf as { fields?: WizardField[] }).fields)) {
      return (jf as { fields: WizardField[] }).fields;
    }
  }
  return [];
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12 },
  title: { fontSize: 18, fontWeight: '600' },
  content: { padding: 14, paddingBottom: 40 },
  loadingBlock: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48 },
  docBlock: { padding: 12, borderWidth: 1, borderRadius: 8, marginBottom: 8 },
  docName: { fontWeight: '600', marginBottom: 8, flexShrink: 1 },
  coverageWarn: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 16 },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    gap: 8 },
  nextBtn: { marginTop: 24, padding: 14, borderRadius: 8, alignItems: 'center' },
  nextText: { color: '#fff', fontWeight: '700' } });

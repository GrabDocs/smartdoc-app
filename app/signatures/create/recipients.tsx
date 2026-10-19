import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FeedbackTouchable } from '../../../components/FeedbackTouchable';
import RecipientEditor from '../../../components/signatures/RecipientEditor';
import { useThemeColors } from '../../../hooks/useThemeColors';
import { useAuth } from '../../context/auth';
import { getEnvelope, putRecipients, updateEnvelopeDraft } from '../../../services/envelopeApi';
import type { RecipientInput } from '../../../types/signature';
import { saveDraftStep } from '../../../services/signatureSessionCache';
import { findInvalidEmails, invalidEmailsMessage, isValidEmail } from '../../../utils/emailValidation';

import AppBackButton from '../../../components/AppBackButton';
import AppHeaderTitle from '../../../components/AppHeaderTitle';

export default function RecipientsScreen() {
  const { envelopeId } = useLocalSearchParams<{ envelopeId: string }>();
  const router = useRouter();
  const colors = useThemeColors();
  const { user } = useAuth();
  const [recipients, setRecipients] = useState<RecipientInput[]>([
    { email: '', name: '', role: 'signer', order_index: 0 },
  ]);
  const [reminderEnabled, setReminderEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!envelopeId) return;
    void getEnvelope(envelopeId).then((res) => {
      const existing = res.envelope.recipients ?? [];
      if (existing.length) {
        setRecipients(
          existing.map((r) => ({
            email: r.email,
            name: r.name ?? undefined,
            role: r.role,
            order_index: r.order_index,
            auth_required: r.auth_required,
            phone_verification_required: r.phone_verification_required,
            phone_number: r.phone_number ?? undefined })),
        );
      }
      setReminderEnabled(res.envelope.reminder_enabled ?? true);
    });
  }, [envelopeId]);

  const handleNext = async () => {
    const invalid = findInvalidEmails(
      recipients.map((r) => (r.email || '').trim()).filter((email) => email.length > 0),
    );
    if (invalid.length > 0) {
      Alert.alert('Invalid email', invalidEmailsMessage(invalid));
      return;
    }
    const signers = recipients.filter((r) => r.role === 'signer' && isValidEmail(r.email));
    if (!signers.length) {
      Alert.alert('Add signers', 'At least one signer email is required.');
      return;
    }
    const missingPhone = signers.find(
      (r) => r.phone_verification_required && !(r.phone_number ?? '').trim(),
    );
    if (missingPhone) {
      Alert.alert(
        'Phone required',
        `Signer ${missingPhone.email || missingPhone.name || ''} requires a phone number when phone verification is enabled.`,
      );
      return;
    }
    setSaving(true);
    try {
      await updateEnvelopeDraft(envelopeId!, { reminder_enabled: reminderEnabled });
      await putRecipients(
        envelopeId!,
        recipients.filter((r) => isValidEmail(r.email)).map((r) => ({
          ...r,
          phone_number: r.phone_verification_required ? r.phone_number?.trim() : undefined })),
      );
      await saveDraftStep(user?.id, envelopeId!, 'assign_fields');
      router.push(`/signatures/create/assign-fields?envelopeId=${envelopeId}` as any);
    } catch (e: unknown) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { backgroundColor: colors.headerBackground }]}>
        <AppBackButton />
        <AppHeaderTitle>Recipients</AppHeaderTitle>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <RecipientEditor recipients={recipients} onChange={setRecipients} />
        <View style={[styles.reminderRow, { borderColor: colors.border }]}>
          <Text style={{ color: colors.text, flex: 1 }}>Send reminders</Text>
          <Switch value={reminderEnabled} onValueChange={setReminderEnabled} />
        </View>
        <FeedbackTouchable
          style={[styles.nextBtn, { backgroundColor: colors.primary, opacity: saving ? 0.6 : 1 }]}
          disabled={saving}
          loading={saving}
          onPress={handleNext}
          spinnerColor="#fff"
          replaceWithSpinner={false}
        >
          <Text style={styles.nextText}>{saving ? 'Saving…' : 'Next: Assign fields'}</Text>
        </FeedbackTouchable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12 },
  title: { fontSize: 18, fontWeight: '600' },
  content: { padding: 14, paddingBottom: 40 },
  reminderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    marginTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth },
  nextBtn: { marginTop: 24, padding: 14, borderRadius: 8, alignItems: 'center' },
  nextText: { color: '#fff', fontWeight: '700' } });

import React from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemeColors } from '../../hooks/useThemeColors';
import type { PendingSubmission, SessionState } from '../../types/signature';
import type { NormalizedSignerSession } from '../../types/signature';
import { isSignFieldType } from '../../utils/signatureRuntime';
import SigningOrderStrip from './SigningOrderStrip';
import PdfFieldRenderer from './PdfFieldRenderer';
import FormFieldRenderer from './FormFieldRenderer';
import AttachmentDocTab from './AttachmentDocTab';
import SignatureCaptureModal from './SignatureCaptureModal';
import type { SignerUIActions } from '../../hooks/useSignerUIState';
import AppBackButton from '../AppBackButton';
import AppHeaderTitle from '../AppHeaderTitle';
import { truncateAppHeaderTitle } from '../../utils/chatTitleDisplay';

interface Props {
  session: NormalizedSignerSession;
  fieldValues: Record<string, unknown>;
  state: SessionState;
  error: string | null;
  pendingSubmission?: PendingSubmission | null;
  ui: SignerUIActions;
  envelopeId: string;
  token?: string;
  pageCaptureRef: React.RefObject<View | null>;
  onFieldValue: (key: string, value: unknown) => void;
  onSubmit: () => void;
  onDecline: () => void;
  onBack?: () => void;
  onReloadConflict: () => void;
}

export default function UnifiedSignerShell({
  session,
  fieldValues,
  state,
  error,
  pendingSubmission,
  ui,
  envelopeId,
  token,
  pageCaptureRef,
  onFieldValue,
  onSubmit,
  onDecline,
  onBack,
  onReloadConflict }: Props) {
  const colors = useThemeColors();
  const doc = session.documents[ui.activeDocIndex];
  const busy = ['compositing', 'uploading', 'awaiting_server', 'autosaving', 'checking_submission'].includes(state);

  const handleFieldPress = (key: string, type: string) => {
    if (isSignFieldType(type)) {
      ui.setSignatureModalFieldKey(key);
    }
  };

  if (state === 'checking_submission') {
    return (
      <View style={[styles.wrap, styles.centered, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} />
        <Text style={{ color: colors.textSecondary, marginTop: 12 }}>Checking submission status…</Text>
      </View>
    );
  }

  return (
    <View style={[styles.wrap, { backgroundColor: colors.background }]}>
      {onBack ? (
        <View style={[styles.header, { borderBottomColor: colors.border, backgroundColor: colors.headerBackground }]}>
          <AppBackButton onPress={onBack} style={styles.backBtn} />
          <AppHeaderTitle shrink={false}>
            {truncateAppHeaderTitle(session.envelopeTitle || 'Signature')}
          </AppHeaderTitle>
        </View>
      ) : null}
      <SigningOrderStrip
        position={session.chain?.position}
        total={session.chain?.total}
        isMyTurn={session.isMyTurn}
      />
      {!session.isMyTurn ? (
        <View style={styles.banner}>
          <Text style={{ color: colors.textSecondary, textAlign: 'center' }}>
            It is not your turn to sign yet.
          </Text>
        </View>
      ) : null}
      {pendingSubmission && state === 'active' ? (
        <View style={[styles.resumeBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={{ color: colors.text, fontWeight: '600' }}>Previous submit interrupted</Text>
          <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 4 }}>
            Tap Submit to resume from where you left off.
          </Text>
        </View>
      ) : null}
      {error ? (
        <View style={[styles.errorBox, { backgroundColor: '#fef2f2' }]}>
          <Text style={{ color: '#b91c1c' }}>{error}</Text>
          {state === 'conflict_409' ? (
            <TouchableOpacity onPress={onReloadConflict}>
              <Text style={{ color: colors.primary, marginTop: 8, fontWeight: '600' }}>Reload</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.docTabs}>
        {session.documents.map((d, i) => (
          <TouchableOpacity
            key={d.documentKey}
            style={[styles.docTab, i === ui.activeDocIndex && { borderBottomColor: colors.primary, borderBottomWidth: 2 }]}
            onPress={() => {
              ui.setActiveDocIndex(i);
              ui.setActivePage(0);
            }}
          >
            <Text
              style={{ color: i === ui.activeDocIndex ? colors.primary : colors.textSecondary }}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {d.title}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      {doc ? (
        doc.sourceType === 'attachment' || !doc.interactive ? (
          <AttachmentDocTab
            document={doc}
            envelopeId={envelopeId}
            token={token}
            isTokenMode={Boolean(token)}
          />
        ) : doc.sourceType === 'form' ? (
          <FormFieldRenderer
            document={doc}
            fieldValues={fieldValues}
            editableKeys={session.editableFieldKeys}
            onFieldPress={handleFieldPress}
            onTextChange={(k, t) => onFieldValue(k, t)}
            onCheckboxToggle={(k, v) => onFieldValue(k, v)}
          />
        ) : (
          <PdfFieldRenderer
            document={doc}
            fieldValues={fieldValues}
            editableKeys={session.editableFieldKeys}
            activePage={ui.activePage}
            onPageChange={ui.setActivePage}
            onFieldPress={handleFieldPress}
            onTextChange={(k, t) => onFieldValue(k, t)}
            onCheckboxToggle={(k, v) => onFieldValue(k, v)}
            pageCaptureRef={pageCaptureRef}
          />
        )
      ) : null}
      <View style={[styles.footer, { borderColor: colors.border, backgroundColor: colors.card }]}>
        {busy ? (
          <ActivityIndicator color={colors.primary} style={{ marginBottom: 8 }} />
        ) : null}
        <Text style={[styles.stateHint, { color: colors.textSecondary }]}>
          {state === 'compositing'
            ? 'Preparing document…'
            : state === 'uploading' || state === 'awaiting_server'
              ? 'Submitting…'
              : state === 'offline_dirty'
                ? 'Saved locally — will sync when online'
                : ''}
        </Text>
        <View style={styles.footerRow}>
          <TouchableOpacity
            style={styles.declineBtn}
            disabled={busy || !session.isMyTurn}
            onPress={() =>
              Alert.alert(
                'Decline to sign?',
                'This notifies the sender that you are refusing to sign. Your progress will be saved as a draft if you leave using Back instead.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Decline to sign', style: 'destructive', onPress: onDecline },
                ],
              )
            }
          >
            <Text style={{ color: '#dc2626' }}>Decline to sign</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.submitBtn, { backgroundColor: colors.primary, opacity: busy || !session.isMyTurn ? 0.5 : 1 }]}
            disabled={busy || !session.isMyTurn}
            onPress={onSubmit}
          >
            <Text style={styles.submitText}>{pendingSubmission ? 'Resume submit' : 'Submit'}</Text>
          </TouchableOpacity>
        </View>
      </View>
      <SignatureCaptureModal
        visible={!!ui.signatureModalFieldKey}
        expandNonce={ui.signatureModalExpandNonce}
        fieldLabel={ui.signatureModalFieldKey ?? undefined}
        onClose={() => ui.setSignatureModalFieldKey(null)}
        onSave={(image) => {
          if (ui.signatureModalFieldKey) {
            onFieldValue(ui.signatureModalFieldKey, { image });
          }
          ui.setSignatureModalFieldKey(null);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 4},
  backBtn: { padding: 4 },
  headerTitle: { flex: 1, fontSize: 16, fontWeight: '600' },
  centered: { alignItems: 'center', justifyContent: 'center' },
  banner: { padding: 12 },
  resumeBox: { margin: 14, padding: 12, borderRadius: 8, borderWidth: 1 },
  errorBox: { margin: 14, padding: 12, borderRadius: 8 },
  docTabs: { maxHeight: 44, paddingHorizontal: 8 },
  docTab: { paddingHorizontal: 12, paddingVertical: 10, maxWidth: 140 },
  footer: { padding: 14, borderTopWidth: 1 },
  footerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  declineBtn: { padding: 12 },
  submitBtn: { paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8 },
  submitText: { color: '#fff', fontWeight: '700' },
  stateHint: { fontSize: 12, textAlign: 'center', marginBottom: 4 } });

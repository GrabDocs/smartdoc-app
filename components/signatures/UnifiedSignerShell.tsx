import React, { useCallback, useMemo, useState } from 'react';
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
import {
  buildSignerGuideStops,
  nextSignerGuideStop,
  signerGuideActionLabel,
  type SignerGuideStop,
} from '../../utils/signerGuide';
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
  const [guideFocus, setGuideFocus] = useState<SignerGuideStop | null>(null);

  const guideStops = useMemo(
    () => buildSignerGuideStops(session, fieldValues),
    [session, fieldValues],
  );
  const guideAhead = nextSignerGuideStop(guideStops, guideFocus);
  const guideFocusedStillOpen = guideFocus
    ? guideStops.find((s) => s.id === guideFocus.id) ?? null
    : null;
  const guideDestination = guideAhead ?? (
    guideFocusedStillOpen &&
    (guideFocusedStillOpen.docIndex !== ui.activeDocIndex || guideFocusedStillOpen.page !== ui.activePage)
      ? guideFocusedStillOpen
      : null
  );

  const goToGuideStop = useCallback((stop: SignerGuideStop) => {
    setGuideFocus(stop);
    ui.setActiveDocIndex(stop.docIndex);
    ui.setActivePage(stop.page);
    if (isSignFieldType(stop.kind)) {
      // Open capture after the page/doc switch commits.
      requestAnimationFrame(() => ui.setSignatureModalFieldKey(stop.fieldKey));
    }
  }, [ui]);

  const handleFieldPress = (key: string, type: string) => {
    if (isSignFieldType(type)) {
      ui.setSignatureModalFieldKey(key);
    }
  };

  const handlePrimarySubmit = () => {
    const requiredStops = guideStops.filter((s) => s.required);
    if (requiredStops.length > 0) {
      const focusInRequired =
        guideFocus && requiredStops.some((s) => s.id === guideFocus.id) ? guideFocus : null;
      const stop = nextSignerGuideStop(requiredStops, focusInRequired) ?? requiredStops[0];
      if (stop) {
        goToGuideStop(stop);
        return;
      }
    }
    onSubmit();
  };

  if (state === 'checking_submission') {
    return (
      <View style={[styles.wrap, styles.centered, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} />
        <Text style={{ color: colors.textSecondary, marginTop: 12 }}>Checking submission status…</Text>
      </View>
    );
  }

  const showDocTabs = session.documents.length > 1;
  const guideLabel = guideDestination
    ? `${guideFocus ? 'Next' : 'Start'}: ${guideDestination.label || signerGuideActionLabel(guideDestination.kind)}${
        guideDestination.page !== ui.activePage || guideDestination.docIndex !== ui.activeDocIndex
          ? ` · page ${guideDestination.page + 1}`
          : ''
      } · ${guideStops.length} left`
    : null;

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
          <Text style={{ color: colors.textSecondary, textAlign: 'center', fontSize: 13 }}>
            It is not your turn to sign yet.
          </Text>
        </View>
      ) : null}
      {pendingSubmission && state === 'active' ? (
        <View style={[styles.resumeBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={{ color: colors.text, fontWeight: '600', fontSize: 13 }}>Previous submit interrupted</Text>
          <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }}>
            Tap Submit to resume from where you left off.
          </Text>
        </View>
      ) : null}
      {error ? (
        <View style={[styles.errorBox, { backgroundColor: '#fef2f2' }]}>
          <Text style={{ color: '#b91c1c', fontSize: 13 }}>{error}</Text>
          {state === 'conflict_409' ? (
            <TouchableOpacity onPress={onReloadConflict}>
              <Text style={{ color: colors.primary, marginTop: 6, fontWeight: '600' }}>Reload</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
      {showDocTabs ? (
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
                style={{
                  color: i === ui.activeDocIndex ? colors.primary : colors.textSecondary,
                  fontSize: 13,
                }}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {d.title}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      ) : null}
      {session.isMyTurn && guideDestination ? (
        <TouchableOpacity
          style={[styles.guideBtn, { borderColor: colors.border, backgroundColor: colors.card }]}
          onPress={() => goToGuideStop(guideDestination)}
          accessibilityRole="button"
          accessibilityLabel={guideLabel ?? 'Go to next required field'}
        >
          <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }} numberOfLines={1}>
            {guideLabel}
          </Text>
          <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
        </TouchableOpacity>
      ) : null}
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
            focusFieldKey={guideFocus?.docIndex === ui.activeDocIndex ? guideFocus?.fieldKey : null}
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
            focusFieldKey={guideFocus?.docIndex === ui.activeDocIndex ? guideFocus?.fieldKey : null}
            onFieldPress={handleFieldPress}
            onTextChange={(k, t) => onFieldValue(k, t)}
            onCheckboxToggle={(k, v) => onFieldValue(k, v)}
            pageCaptureRef={pageCaptureRef}
          />
        )
      ) : null}
      <View style={[styles.footer, { borderColor: colors.border, backgroundColor: colors.card }]}>
        {busy ? (
          <ActivityIndicator color={colors.primary} style={{ marginBottom: 4 }} />
        ) : null}
        {state === 'compositing' || state === 'uploading' || state === 'awaiting_server' || state === 'offline_dirty' ? (
          <Text style={[styles.stateHint, { color: colors.textSecondary }]}>
            {state === 'compositing'
              ? 'Preparing document…'
              : state === 'uploading' || state === 'awaiting_server'
                ? 'Submitting…'
                : 'Saved locally — will sync when online'}
          </Text>
        ) : null}
        <View style={styles.footerRow}>
          <TouchableOpacity
            style={styles.declineBtn}
            disabled={busy || !session.isMyTurn}
            onPress={() =>
              Alert.alert(
                'Decline to sign?',
                'Are you sure you want to decline? This notifies the sender that you are refusing to sign. Use Back instead if you only want to leave and keep a draft.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Yes, decline', style: 'destructive', onPress: onDecline },
                ],
              )
            }
          >
            <Text style={{ color: '#dc2626', fontWeight: '600', fontSize: 14 }}>Decline</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.submitBtn, { backgroundColor: colors.primary, opacity: busy || !session.isMyTurn ? 0.5 : 1 }]}
            disabled={busy || !session.isMyTurn}
            onPress={handlePrimarySubmit}
          >
            <Text style={styles.submitText}>
              {pendingSubmission
                ? 'Resume'
                : guideStops.some((s) => s.required)
                  ? 'Sign'
                  : 'Submit'}
            </Text>
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
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  backBtn: { padding: 2 },
  centered: { alignItems: 'center', justifyContent: 'center' },
  banner: { paddingHorizontal: 12, paddingVertical: 6 },
  resumeBox: { marginHorizontal: 10, marginVertical: 6, padding: 10, borderRadius: 8, borderWidth: 1 },
  errorBox: { marginHorizontal: 10, marginVertical: 6, padding: 10, borderRadius: 8 },
  docTabs: { maxHeight: 36, paddingHorizontal: 8 },
  docTab: { paddingHorizontal: 10, paddingVertical: 6, maxWidth: 140 },
  guideBtn: {
    marginHorizontal: 8,
    marginBottom: 4,
    marginTop: 2,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  footer: { paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth },
  footerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  declineBtn: { paddingVertical: 8, paddingHorizontal: 4 },
  submitBtn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
  submitText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  stateHint: { fontSize: 12, textAlign: 'center', marginBottom: 4 },
});

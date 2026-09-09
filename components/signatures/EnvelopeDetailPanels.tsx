import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { FeedbackTouchable } from '../FeedbackTouchable';
import { resendCooldownKey, useResendCooldown, formatRemainingCountdown } from '../../hooks/useResendCooldown';
import { useThemeColors } from '../../hooks/useThemeColors';
import type { Envelope, EnvelopeRecipient } from '../../types/signature';
import {
  formatEnvelopeDateTime,
  groupSignersByOrder,
  recipientStatusBadge,
  envelopeRemindersLabel,
  envelopeSourceLabel,
  sortedAuditEvents,
} from '../../utils/envelopeDisplay';

interface Props {
  envelope: Envelope;
  canResend: boolean;
  onResend: (recipientId: number) => void | Promise<void>;
  onDelete?: () => void;
  deleting?: boolean;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  const colors = useThemeColors();
  return (
    <View style={[styles.panel, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.panelTitle, { color: colors.text }]}>{title}</Text>
      {children}
    </View>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  const colors = useThemeColors();
  return (
    <View style={styles.detailRow}>
      <Text style={[styles.detailLabel, { color: colors.textSecondary }]}>{label}</Text>
      <Text style={[styles.detailValue, { color: colors.text }]} selectable>
        {value}
      </Text>
    </View>
  );
}

function RecipientRow({
  recipient,
  envelopeKey,
  canResend,
  onResend,
}: {
  recipient: EnvelopeRecipient;
  envelopeKey: string;
  canResend: boolean;
  onResend: () => void | Promise<void>;
}) {
  const colors = useThemeColors();
  const badge = recipientStatusBadge(recipient.status);
  const signedAt = recipient.signed_at ? formatEnvelopeDateTime(recipient.signed_at) : null;
  const cooldownKey = resendCooldownKey('envelope', envelopeKey, recipient.id);
  const { remainingSec, isCoolingDown } = useResendCooldown(cooldownKey, {
    serverSentAt: recipient.notified_at,
  });

  return (
    <View style={styles.recipientRow}>
      <View style={styles.recipientBody}>
        <Text style={[styles.recipientName, { color: colors.text }]} numberOfLines={2}>
          {recipient.name || recipient.email}
          {' '}
          <Text style={{ color: colors.textSecondary }}>&lt;{recipient.email}&gt;</Text>
        </Text>
        <View style={styles.recipientMeta}>
          <View style={[styles.badge, { backgroundColor: badge.backgroundColor }]}>
            <Text style={[styles.badgeText, { color: badge.color }]}>{badge.label}</Text>
          </View>
          {signedAt ? (
            <Text style={[styles.recipientTime, { color: colors.textSecondary }]}>
              signed {signedAt}
            </Text>
          ) : null}
        </View>
        {recipient.phone_verification_required && recipient.role === 'signer' ? (
          <Text style={[styles.phoneNote, { color: colors.textSecondary }]}>
            Phone verification required
            {recipient.phone_number ? ` (${recipient.phone_number})` : ''}
          </Text>
        ) : null}
        {recipient.decline_reason ? (
          <Text style={[styles.declineReason, { color: '#B91C1C' }]} numberOfLines={2}>
            Reason: {recipient.decline_reason}
          </Text>
        ) : null}
        {recipient.last_delivery_error &&
        (recipient.status === 'delivery_failed' || recipient.status === 'bounced') ? (
          <Text style={[styles.deliveryError, { color: '#B45309' }]} numberOfLines={3}>
            Email not delivered: {recipient.last_delivery_error}
          </Text>
        ) : null}
      </View>
      {canResend ? (
        <FeedbackTouchable
          style={[
            styles.resendBtn,
            { borderColor: colors.border },
            isCoolingDown && { opacity: 0.55 },
          ]}
          onPress={onResend}
          disabled={isCoolingDown}
          spinnerColor={colors.text}
        >
          <Text style={[styles.resendText, { color: colors.text }]}>
            {isCoolingDown ? formatRemainingCountdown(remainingSec) : 'Resend'}
          </Text>
        </FeedbackTouchable>
      ) : null}
    </View>
  );
}

export default function EnvelopeDetailPanels({ envelope, canResend, onResend, onDelete, deleting }: Props) {
  const colors = useThemeColors();
  const { groups, ccs } = groupSignersByOrder(envelope.recipients ?? []);
  const events = sortedAuditEvents(envelope);
  const isDraft = envelope.status === 'draft';
  const envelopeKey = envelope.public_id?.trim() || String(envelope.id);

  return (
    <>
      <Panel title="Signing order">
        {groups.length === 0 ? (
          <Text style={[styles.empty, { color: colors.textSecondary }]}>No signers yet.</Text>
        ) : (
          groups.map((g, idx) => (
            <View
              key={g.order}
              style={[styles.stepCard, { borderColor: colors.border }]}
            >
              <Text style={[styles.stepLabel, { color: colors.textSecondary }]}>
                Step {idx + 1}
                {g.signers.length > 1 ? (
                  <Text style={{ color: colors.primary }}> · parallel group</Text>
                ) : null}
              </Text>
              {g.signers.map((r) => (
                <RecipientRow
                  key={r.id}
                  recipient={r}
                  envelopeKey={envelopeKey}
                  canResend={
                    canResend && r.status !== 'signed' && r.status !== 'declined'
                  }
                  onResend={() => onResend(r.id)}
                />
              ))}
            </View>
          ))
        )}
        {ccs.length > 0 ? (
          <View style={styles.ccSection}>
            <Text style={[styles.ccTitle, { color: colors.textSecondary }]}>CC observers</Text>
            {ccs.map((r) => (
              <RecipientRow
                key={r.id}
                recipient={r}
                envelopeKey={envelopeKey}
                canResend={false}
                onResend={() => {}}
              />
            ))}
          </View>
        ) : null}
        {isDraft ? (
          <Text style={[styles.draftNote, { color: colors.textSecondary, backgroundColor: colors.background }]}>
            This envelope is still a draft. Continue editing to send.
          </Text>
        ) : null}
      </Panel>

      <Panel title="Details">
        <View style={styles.detailsTable}>
          {envelope.public_id ? (
            <DetailRow label="Reference" value={envelope.public_id} />
          ) : null}
          <DetailRow label="Source" value={envelopeSourceLabel(envelope)} />
          <DetailRow label="Sent" value={formatEnvelopeDateTime(envelope.sent_at)} />
          <DetailRow label="Completed" value={formatEnvelopeDateTime(envelope.completed_at)} />
          <DetailRow
            label="Expires"
            value={formatEnvelopeDateTime(envelope.expires_at, 'No expiration')}
          />
          <DetailRow label="Reminders" value={envelopeRemindersLabel(envelope)} />
        </View>
        {isDraft && onDelete ? (
          <FeedbackTouchable
            style={styles.deleteBtn}
            onPress={onDelete}
            loading={deleting}
            disabled={deleting}
            spinnerColor="#dc2626"
            replaceWithSpinner={false}
          >
            <Ionicons name="trash-outline" size={16} color="#dc2626" />
            <Text style={styles.deleteBtnText}>{deleting ? 'Deleting…' : 'Delete draft'}</Text>
          </FeedbackTouchable>
        ) : null}
      </Panel>

      <Panel title="Audit trail">
        {events.length === 0 ? (
          <Text style={[styles.empty, { color: colors.textSecondary }]}>No events yet.</Text>
        ) : (
          events.map((e) => {
            const meta =
              e.meta_json && Object.keys(e.meta_json).length > 0
                ? JSON.stringify(e.meta_json)
                : null;
            return (
              <View
                key={e.id}
                style={[styles.auditRow, { borderBottomColor: colors.border }]}
              >
                <Text style={[styles.auditTime, { color: colors.textSecondary }]}>
                  {formatEnvelopeDateTime(e.created_at)}
                </Text>
                <Text style={[styles.auditType, { color: colors.text }]}>{e.event_type}</Text>
                <View style={styles.auditMeta}>
                  {e.actor_email ? (
                    <Text style={[styles.auditDetail, { color: colors.textSecondary }]} numberOfLines={1}>
                      {e.actor_email}
                    </Text>
                  ) : null}
                  {e.ip ? (
                    <Text style={[styles.auditIp, { color: colors.textSecondary }]}>{e.ip}</Text>
                  ) : null}
                  {meta ? (
                    <Text style={[styles.auditJson, { color: colors.textSecondary }]} selectable>
                      {meta}
                    </Text>
                  ) : null}
                </View>
              </View>
            );
          })
        )}
      </Panel>
    </>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    marginBottom: 12,
  },
  panelTitle: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 12,
  },
  empty: { fontSize: 13 },
  stepCard: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
  },
  stepLabel: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  recipientRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 10,
  },
  recipientBody: { flex: 1, minWidth: 0 },
  recipientName: { fontSize: 14, lineHeight: 20 },
  recipientMeta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  recipientTime: { fontSize: 11 },
  phoneNote: { fontSize: 11, marginTop: 4 },
  declineReason: { fontSize: 11, marginTop: 4 },
  deliveryError: {
    fontSize: 11,
    marginTop: 4,
    backgroundColor: '#FFFBEB',
    padding: 6,
    borderRadius: 6,
  },
  resendBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  resendText: { fontSize: 11, fontWeight: '600' },
  ccSection: { marginTop: 4 },
  ccTitle: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  draftNote: {
    fontSize: 13,
    padding: 10,
    borderRadius: 8,
    marginTop: 4,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 10,
  },
  detailLabel: {
    width: '36%',
    fontSize: 12,
    lineHeight: 18,
  },
  detailValue: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  detailsTable: {
    gap: 0,
  },
  deleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: '#dc2626',
  },
  deleteBtnText: { color: '#dc2626', fontWeight: '600', fontSize: 14 },
  auditRow: {
    paddingBottom: 10,
    marginBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  auditTime: { fontSize: 11, marginBottom: 2 },
  auditType: { fontSize: 13, fontWeight: '600', marginBottom: 4 },
  auditMeta: { gap: 2 },
  auditDetail: { fontSize: 12 },
  auditIp: { fontSize: 11 },
  auditJson: {
    fontSize: 10,
    fontFamily: 'monospace',
    lineHeight: 14,
    marginTop: 2,
  },
});

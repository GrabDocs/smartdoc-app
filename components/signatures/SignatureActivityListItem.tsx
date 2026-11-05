import { Ionicons } from '@expo/vector-icons';
import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import ActionMenuModal, { type ActionMenuItem } from '../ActionMenuModal';
import FileNameText from '../FileNameText';
import { useThemeColors } from '../../hooks/useThemeColors';
import type { FillSubmission } from '../../services/fillApi';
import type { Envelope } from '../../types/signature';
import {
  envelopeSignerSummary,
  envelopeSourceTypeBadge,
  envelopeStatusBadge,
  formatEnvelopeListDate,
} from '../../utils/envelopeDisplay';
import { SIGNATURE_LIST_TITLE_MAX } from '../../utils/displayFilename';
import {
  envelopeLastActivityIso,
  formatSignatureActivityLabel,
  submissionDisplayTitle,
  submissionLastActivityIso,
  templateLastActivityIso,
  type SignatureActivityItem,
} from '../../utils/signatureActivity';

interface Props {
  item: SignatureActivityItem;
  onPress: () => void;
  onSign?: () => void;
  onViewOriginal?: () => void | Promise<void>;
  onViewDocument?: () => void;
  onFillDocument?: () => void;
  onDeleteDocument?: () => void;
  onViewSubmission?: () => void;
  onViewSubmissions?: () => void;
  onShare?: () => void | Promise<void>;
  onViewCompletedPdf?: () => void | Promise<void>;
  onViewAuditTrail?: () => void | Promise<void>;
}

function Badge({ badge }: { badge: { label: string; backgroundColor: string; color: string } }) {
  return (
    <View style={[styles.badge, { backgroundColor: badge.backgroundColor }]}>
      <Text style={[styles.badgeText, { color: badge.color }]}>{badge.label}</Text>
    </View>
  );
}

const IN_PROGRESS_BADGE = {
  label: 'In progress',
  backgroundColor: '#FEF3C7',
  color: '#92400E',
};

const COMPLETED_BADGE = {
  label: 'Completed',
  backgroundColor: '#DCFCE7',
  color: '#166534',
};

function EnvelopeRow({
  envelope,
  onPress,
  onViewOriginal,
  onSign,
  onViewCompletedPdf,
  onShare,
  onViewSubmissions,
  onViewAuditTrail,
}: {
  envelope: Envelope;
  onPress: () => void;
  onViewOriginal?: () => void | Promise<void>;
  onSign?: () => void;
  onViewCompletedPdf?: () => void | Promise<void>;
  onShare?: () => void | Promise<void>;
  onViewSubmissions?: () => void;
  onViewAuditTrail?: () => void | Promise<void>;
}) {
  const colors = useThemeColors();
  const [menuVisible, setMenuVisible] = useState(false);
  const canSign = envelope.inbox_context?.can_sign && envelope.inbox_context?.is_my_turn;
  const statusBadge = envelopeStatusBadge(envelope.status);
  const sourceBadge = envelopeSourceTypeBadge(envelope);
  const signerSummary = envelopeSignerSummary(envelope, 'all');
  const activityLabel = formatSignatureActivityLabel(envelopeLastActivityIso(envelope), {
    uploadedAt: envelope.created_at,
  });
  const metaParts = [activityLabel, signerSummary].filter(Boolean);

  const menuItems = useMemo((): ActionMenuItem[] => {
    const items: ActionMenuItem[] = [
      {
        id: 'open',
        label: 'Open',
        icon: 'open-outline',
        iconColor: colors.primary,
        onPress,
      },
    ];
    if (onViewOriginal) {
      items.push({
        id: 'view-original',
        label: 'View Original',
        icon: 'eye-outline',
        iconColor: '#007AFF',
        onPress: onViewOriginal,
      });
    }
    if (onViewCompletedPdf) {
      items.push({
        id: 'view-pdf',
        label: 'View completed PDF',
        icon: 'document-text-outline',
        iconColor: '#007AFF',
        onPress: onViewCompletedPdf,
      });
    }
    if (onShare) {
      items.push({
        id: 'share',
        label: 'Share',
        icon: 'share-outline',
        iconColor: '#007AFF',
        onPress: onShare,
      });
    }
    if (onViewSubmissions) {
      items.push({
        id: 'all-submissions',
        label: 'All submissions',
        icon: 'layers-outline',
        iconColor: colors.text,
        onPress: onViewSubmissions,
      });
    }
    if (onViewAuditTrail) {
      items.push({
        id: 'audit-trail',
        label: 'View audit trail',
        icon: 'list-outline',
        iconColor: colors.text,
        onPress: onViewAuditTrail,
      });
    }
    return items;
  }, [
    colors.primary,
    colors.text,
    onPress,
    onShare,
    onViewAuditTrail,
    onViewCompletedPdf,
    onViewOriginal,
    onViewSubmissions,
  ]);

  return (
    <>
      <TouchableOpacity
        style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}
        onPress={() => setMenuVisible(true)}
        activeOpacity={0.7}
        accessibilityLabel="Envelope actions"
        accessibilityRole="button"
      >
        <View style={styles.body}>
          <FileNameText
            name={envelope.title || 'Untitled envelope'}
            style={[styles.title, { color: colors.text }]}
            sanitize={false}
            maxLength={SIGNATURE_LIST_TITLE_MAX}
          />
          <View style={styles.badgeRow}>
            <Badge badge={statusBadge} />
            {sourceBadge ? <Badge badge={sourceBadge} /> : null}
          </View>
          {metaParts.length > 0 ? (
            <Text style={[styles.meta, { color: colors.textSecondary }]} numberOfLines={2}>
              {metaParts.join(' · ')}
            </Text>
          ) : null}
        </View>
        <View style={styles.trailing}>
          {canSign && onSign ? (
            <TouchableOpacity
              style={[styles.signBtn, { backgroundColor: colors.primary }]}
              onPress={(e) => {
                e.stopPropagation?.();
                onSign();
              }}
            >
              <Text style={styles.signText}>Sign</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            style={styles.kebabBtn}
            onPress={(e) => {
              e.stopPropagation?.();
              setMenuVisible(true);
            }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel="Envelope actions"
            accessibilityRole="button"
          >
            <Ionicons name="ellipsis-vertical" size={20} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
      <ActionMenuModal
        visible={menuVisible}
        title={envelope.title || 'Envelope'}
        items={menuItems}
        onClose={() => setMenuVisible(false)}
      />
    </>
  );
}

function TemplateRow({
  template,
  onPress,
  onViewDocument,
  onFillDocument,
  onDeleteDocument,
  onShare,
}: {
  template: NonNullable<SignatureActivityItem['template']>;
  onPress?: () => void;
  onViewDocument?: () => void;
  onFillDocument?: () => void;
  onDeleteDocument?: () => void;
  onShare?: () => void | Promise<void>;
}) {
  const colors = useThemeColors();
  const [menuVisible, setMenuVisible] = useState(false);
  const activityIso = templateLastActivityIso(template);
  const activityLabel =
    formatSignatureActivityLabel(activityIso, { uploadedAt: template.created_at }) ??
    (activityIso ? `Updated ${formatEnvelopeListDate(activityIso)}` : null);

  const menuItems = useMemo((): ActionMenuItem[] => {
    const items: ActionMenuItem[] = [];
    if (onFillDocument) {
      items.push({
        id: 'continue',
        label: 'Continue filling',
        icon: 'create-outline',
        iconColor: colors.primary,
        onPress: onFillDocument,
      });
    }
    if (onViewDocument) {
      items.push({
        id: 'view-original',
        label: 'View original',
        icon: 'eye-outline',
        iconColor: '#007AFF',
        onPress: onViewDocument,
      });
    }
    if (onShare) {
      items.push({
        id: 'share',
        label: 'Share',
        icon: 'share-outline',
        iconColor: '#007AFF',
        onPress: onShare,
      });
    }
    if (onDeleteDocument) {
      items.push({
        id: 'delete',
        label: 'Delete',
        icon: 'trash-outline',
        destructive: true,
        onPress: onDeleteDocument,
      });
    }
    return items;
  }, [colors.primary, onDeleteDocument, onFillDocument, onShare, onViewDocument]);

  return (
    <>
      <TouchableOpacity
        style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}
        onPress={onPress ?? onFillDocument}
        activeOpacity={0.7}
        disabled={!onPress && !onFillDocument}
      >
        <View style={styles.body}>
          <FileNameText
            name={template.name || 'Untitled document'}
            style={[styles.title, { color: colors.text }]}
            sanitize={false}
            maxLength={SIGNATURE_LIST_TITLE_MAX}
          />
          <View style={styles.badgeRow}>
            <Badge badge={IN_PROGRESS_BADGE} />
          </View>
          {activityLabel ? (
            <Text style={[styles.meta, { color: colors.textSecondary }]} numberOfLines={2}>
              {activityLabel}
            </Text>
          ) : null}
        </View>
        <TouchableOpacity
          style={styles.kebabBtn}
          onPress={(e) => {
            e.stopPropagation?.();
            setMenuVisible(true);
          }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityLabel="Document actions"
          accessibilityRole="button"
        >
          <Ionicons name="ellipsis-vertical" size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </TouchableOpacity>
      <ActionMenuModal
        visible={menuVisible}
        title={template.name || 'Document'}
        items={menuItems}
        onClose={() => setMenuVisible(false)}
      />
    </>
  );
}

function SubmissionRow({
  submission,
  onPress,
  onViewSubmission,
  onViewSubmissions,
  onShare,
}: {
  submission: FillSubmission;
  onPress?: () => void;
  onViewSubmission?: () => void;
  onViewSubmissions?: () => void;
  onShare?: () => void | Promise<void>;
}) {
  const colors = useThemeColors();
  const [menuVisible, setMenuVisible] = useState(false);
  const filledIso = submissionLastActivityIso(submission);
  const filledDate = formatEnvelopeListDate(filledIso);
  const metaParts = [
    filledDate ? `Completed ${filledDate}` : null,
    submission.filled_by_name?.trim() || null,
  ].filter(Boolean);

  const menuItems = useMemo((): ActionMenuItem[] => {
    const items: ActionMenuItem[] = [];
    if (onViewSubmission) {
      items.push({
        id: 'view-pdf',
        label: 'View completed PDF',
        icon: 'document-text-outline',
        iconColor: '#007AFF',
        onPress: onViewSubmission,
      });
    }
    if (onShare) {
      items.push({
        id: 'share',
        label: 'Share',
        icon: 'share-outline',
        iconColor: '#007AFF',
        onPress: onShare,
      });
    }
    if (onViewSubmissions) {
      items.push({
        id: 'all-submissions',
        label: 'All submissions',
        icon: 'layers-outline',
        iconColor: colors.text,
        onPress: onViewSubmissions,
      });
    }
    return items;
  }, [colors.text, onShare, onViewSubmission, onViewSubmissions]);

  return (
    <>
      <TouchableOpacity
        style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}
        onPress={onPress ?? onViewSubmission}
        activeOpacity={0.7}
        disabled={!onPress && !onViewSubmission}
      >
        <View style={styles.body}>
          <FileNameText
            name={submissionDisplayTitle(submission)}
            style={[styles.title, { color: colors.text }]}
            sanitize={false}
            maxLength={SIGNATURE_LIST_TITLE_MAX}
          />
          <View style={styles.badgeRow}>
            <Badge badge={COMPLETED_BADGE} />
          </View>
          {metaParts.length > 0 ? (
            <Text style={[styles.meta, { color: colors.textSecondary }]} numberOfLines={2}>
              {metaParts.join(' · ')}
            </Text>
          ) : null}
        </View>
        <TouchableOpacity
          style={styles.kebabBtn}
          onPress={(e) => {
            e.stopPropagation?.();
            setMenuVisible(true);
          }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityLabel="Submission actions"
          accessibilityRole="button"
        >
          <Ionicons name="ellipsis-vertical" size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </TouchableOpacity>
      <ActionMenuModal
        visible={menuVisible}
        title={submissionDisplayTitle(submission)}
        items={menuItems}
        onClose={() => setMenuVisible(false)}
      />
    </>
  );
}

export default function SignatureActivityListItem({
  item,
  onPress,
  onSign,
  onViewOriginal,
  onViewDocument,
  onFillDocument,
  onDeleteDocument,
  onViewSubmission,
  onViewSubmissions,
  onShare,
  onViewCompletedPdf,
  onViewAuditTrail,
}: Props) {
  if (item.kind === 'envelope' && item.envelope) {
    return (
      <EnvelopeRow
        envelope={item.envelope}
        onPress={onPress}
        onViewOriginal={onViewOriginal}
        onSign={onSign}
        onViewCompletedPdf={onViewCompletedPdf}
        onShare={onShare}
        onViewSubmissions={onViewSubmissions}
        onViewAuditTrail={onViewAuditTrail}
      />
    );
  }
  if (item.kind === 'fillable' && item.template) {
    return (
      <TemplateRow
        template={item.template}
        onPress={onFillDocument}
        onViewDocument={onViewDocument}
        onFillDocument={onFillDocument}
        onDeleteDocument={onDeleteDocument}
        onShare={onShare}
      />
    );
  }
  if (item.kind === 'submission' && item.submission) {
    return (
      <SubmissionRow
        submission={item.submission}
        onPress={onViewSubmission}
        onViewSubmission={onViewSubmission}
        onViewSubmissions={onViewSubmissions}
        onShare={onShare}
      />
    );
  }
  return null;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    marginHorizontal: 14,
    marginBottom: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  body: { flex: 1, marginRight: 8, minWidth: 0 },
  title: { fontSize: 16, fontWeight: '600', marginBottom: 6 },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 4,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  meta: { fontSize: 12, lineHeight: 16 },
  trailing: { flexDirection: 'row', alignItems: 'center' },
  signBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  signText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  kebabBtn: { padding: 4, marginLeft: 4 },
});

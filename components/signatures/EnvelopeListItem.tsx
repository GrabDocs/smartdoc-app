import { Ionicons } from '@expo/vector-icons';
import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import ActionMenuModal, { type ActionMenuItem } from '../ActionMenuModal';
import FileNameText from '../FileNameText';
import { useThemeColors } from '../../hooks/useThemeColors';
import type { EnvelopeTab } from '../../services/envelopeApi';
import type { Envelope } from '../../types/signature';
import {
  envelopeSignerSummary,
  envelopeSourceTypeBadge,
  envelopeStatusBadge,
  formatEnvelopeListDate,
} from '../../utils/envelopeDisplay';
import { SIGNATURE_LIST_TITLE_MAX } from '../../utils/displayFilename';

interface Props {
  envelope: Envelope;
  tab?: EnvelopeTab;
  onPress: () => void;
  onViewOriginal?: () => void | Promise<void>;
  onSign?: () => void;
  onViewCompletedPdf?: () => void | Promise<void>;
  onShare?: () => void | Promise<void>;
  onViewSubmissions?: () => void;
  onViewAuditTrail?: () => void | Promise<void>;
}

function Badge({ badge }: { badge: { label: string; backgroundColor: string; color: string } }) {
  return (
    <View style={[styles.badge, { backgroundColor: badge.backgroundColor }]}>
      <Text style={[styles.badgeText, { color: badge.color }]}>{badge.label}</Text>
    </View>
  );
}

export default function EnvelopeListItem({
  envelope,
  tab,
  onPress,
  onViewOriginal,
  onSign,
  onViewCompletedPdf,
  onShare,
  onViewSubmissions,
  onViewAuditTrail,
}: Props) {
  const colors = useThemeColors();
  const [menuVisible, setMenuVisible] = useState(false);
  const canSign = envelope.inbox_context?.can_sign && envelope.inbox_context?.is_my_turn;
  const statusBadge = envelopeStatusBadge(envelope.status);
  const sourceBadge = envelopeSourceTypeBadge(envelope);
  const signerSummary = envelopeSignerSummary(envelope, tab);
  const sentLabel = envelope.sent_at
    ? `Sent ${formatEnvelopeListDate(envelope.sent_at)}`
    : tab === 'drafts' && envelope.created_at
      ? `Created ${formatEnvelopeListDate(envelope.created_at)}`
      : null;

  const metaParts = [signerSummary, sentLabel].filter(Boolean);

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
    textTransform: 'capitalize',
  },
  meta: { fontSize: 12, lineHeight: 16 },
  trailing: { flexDirection: 'row', alignItems: 'center' },
  signBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  signText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  kebabBtn: { padding: 4, marginLeft: 4 },
});

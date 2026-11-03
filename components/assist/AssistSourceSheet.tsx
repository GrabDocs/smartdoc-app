import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useThemeColors } from '../../hooks/useThemeColors';
import MinimizableBottomSheet from '../MinimizableBottomSheet';

export type AssistSourceEmail = {
  kind?: string;
  subject?: string | null;
  from_address?: string | null;
  to_addresses?: string[] | string | null;
  provider_received_at?: string | null;
  body_text?: string | null;
};

export type AssistSourceContent =
  | { type: 'email'; email: AssistSourceEmail }
  | { type: 'message'; title: string; body: string };

type Props = {
  visible: boolean;
  content: AssistSourceContent | null;
  onClose: () => void;
};

function formatWhen(iso?: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return String(iso);
  }
}

function formatRecipients(to?: string[] | string | null): string {
  if (!to) return '';
  if (Array.isArray(to)) return to.filter(Boolean).join(', ');
  return String(to);
}

export default function AssistSourceSheet({ visible, content, onClose }: Props) {
  const colors = useThemeColors();
  if (!content) return null;

  const title = content.type === 'email' ? content.email.subject || 'Email' : content.title;

  return (
    <MinimizableBottomSheet
      visible={visible}
      onClose={onClose}
      title={title}
      subtitle={content.type === 'email' ? 'Email' : 'Details'}
      heightRatio={0.88}
      minimizable={false}
    >
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
      >
        {content.type === 'email' ? (
          <>
            <View style={styles.meta}>
              {content.email.from_address ? (
                <Text style={[styles.metaLine, { color: colors.textSecondary }]}>
                  <Text style={{ fontWeight: '700', color: colors.text }}>From: </Text>
                  {content.email.from_address}
                </Text>
              ) : null}
              {formatRecipients(content.email.to_addresses) ? (
                <Text style={[styles.metaLine, { color: colors.textSecondary }]}>
                  <Text style={{ fontWeight: '700', color: colors.text }}>To: </Text>
                  {formatRecipients(content.email.to_addresses)}
                </Text>
              ) : null}
              {content.email.provider_received_at ? (
                <Text style={[styles.metaLine, { color: colors.textSecondary }]}>
                  <Text style={{ fontWeight: '700', color: colors.text }}>Date: </Text>
                  {formatWhen(content.email.provider_received_at)}
                </Text>
              ) : null}
            </View>
            <Text style={[styles.bodyText, { color: colors.text }]}>
              {(content.email.body_text || '').trim() || 'No body stored.'}
            </Text>
          </>
        ) : (
          <Text style={[styles.bodyText, { color: colors.text }]}>{content.body}</Text>
        )}
      </ScrollView>
    </MinimizableBottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 16, paddingBottom: 32 },
  meta: { gap: 4, marginBottom: 14 },
  metaLine: { fontSize: 13, lineHeight: 18 },
  bodyText: { fontSize: 15, lineHeight: 22 },
});

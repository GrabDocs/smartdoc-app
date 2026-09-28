import React, { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useThemeColors } from '../../../hooks/useThemeColors';
import { previewAttachmentNames, truncateAttachName } from './emailFormat';

export type AttachPreview = {
  id?: number;
  filename?: string | null;
  file_id?: number | null;
  import_status?: string | null;
};

export function AttachmentNamesRow({
  attachments,
  names,
  onOpen,
  style,
  maxVisible,
}: {
  attachments?: AttachPreview[] | null;
  names?: string[] | null;
  onOpen?: (att: AttachPreview, index: number) => void;
  style?: object;
  /** How many names to show before +N. Default is one row (3). */
  maxVisible?: number;
}) {
  const colors = useThemeColors();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 4 },
        name: { fontSize: 15, fontWeight: '600', color: colors.isDark ? '#7DD3FC' : '#0369A1' },
        more: { fontSize: 14, color: colors.textSecondary },
      }),
    [colors]
  );

  const items: AttachPreview[] = (attachments || []).filter(
    (a) => a && ((a.filename || '').trim() || a.id)
  );
  const fromNames = (names || []).map((n) => (n || '').trim()).filter(Boolean);
  const resolved =
    items.length > 0
      ? items
      : fromNames.map((filename, i) => ({ id: -(i + 1), filename }));
  const labels = resolved.map((a) => (a.filename || '').trim() || 'file');
  const { visible, extra } = previewAttachmentNames(labels, maxVisible);
  if (!visible.length) return null;

  return (
    <View style={[styles.row, style]}>
      {visible.map((label, i) => {
        const att = resolved[i];
        const inner = (
          <Text style={styles.name} numberOfLines={1}>
            {truncateAttachName(label)}
          </Text>
        );
        if (onOpen && att) {
          return (
            <TouchableOpacity key={att.id ?? `${label}-${i}`} onPress={() => onOpen(att, i)}>
              {inner}
            </TouchableOpacity>
          );
        }
        return (
          <View key={att?.id ?? `${label}-${i}`}>{inner}</View>
        );
      })}
      {extra > 0 ? <Text style={styles.more}>+{extra}</Text> : null}
    </View>
  );
}

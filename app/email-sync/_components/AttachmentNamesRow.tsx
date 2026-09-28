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
  variant = 'inline',
}: {
  attachments?: AttachPreview[] | null;
  names?: string[] | null;
  onOpen?: (att: AttachPreview, index: number) => void;
  style?: object;
  /** `panel` shows every file as a larger chip (fullscreen reader). */
  variant?: 'inline' | 'panel';
}) {
  const colors = useThemeColors();
  const panel = variant === 'panel';
  const styles = useMemo(
    () =>
      StyleSheet.create({
        row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: panel ? 10 : 8, marginTop: 4 },
        chip: panel
          ? {
              paddingHorizontal: 12,
              paddingVertical: 10,
              borderRadius: 10,
              backgroundColor: colors.isDark ? '#27272A' : '#E5E7EB',
              maxWidth: '100%',
            }
          : null,
        name: {
          fontSize: panel ? 15 : 11,
          fontWeight: '600',
          color: colors.isDark ? '#7DD3FC' : '#0369A1',
        },
        more: { fontSize: panel ? 14 : 11, color: colors.textSecondary },
      }),
    [colors, panel]
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
  const { visible, extra } = previewAttachmentNames(labels, panel ? labels.length : undefined);
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
            <TouchableOpacity
              key={att.id ?? `${label}-${i}`}
              onPress={() => onOpen(att, i)}
              style={styles.chip}
            >
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

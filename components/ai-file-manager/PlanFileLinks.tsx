import React, { useMemo } from 'react';
import { Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Toast from 'react-native-toast-message';
import { API_BASE_URL } from '../../constants/Config';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiService } from '../../services/api';
import type { PlanFileLinkRow } from '../../types/aiFileManager';

interface Props {
  links?: PlanFileLinkRow[];
  onOpenFile?: (fileId: number, name?: string) => void;
}

function linkDisplayName(link: PlanFileLinkRow): string {
  const name = String(link.name || link.original_filename || link.filename || '').trim();
  return name || (link.file_id != null ? `File ${link.file_id}` : 'File');
}

export default function PlanFileLinks({ links, onOpenFile }: Props) {
  const colors = useThemeColors();
  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const link of links || []) {
      const key = linkDisplayName(link).toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const dups = new Set<string>();
    for (const [key, n] of counts) {
      if (n > 1) dups.add(key);
    }
    return dups;
  }, [links]);

  if (!links?.length) return null;

  const handleOpen = async (link: PlanFileLinkRow) => {
    const fileId = link.file_id;
    if (fileId == null) return;
    const display = linkDisplayName(link);
    if (onOpenFile) {
      onOpenFile(fileId, display);
      return;
    }
    try {
      await apiService.getFileById(fileId);
      const path = link.view_path || `/api/v1/web/files/${fileId}/view`;
      const url = path.startsWith('http') ? path : `${API_BASE_URL}${path}`;
      await Linking.openURL(url);
    } catch {
      Toast.show({ type: 'info', text1: 'File no longer available' });
    }
  };

  return (
    <View style={styles.wrap}>
      {links.map((link, i) => {
        const display = linkDisplayName(link);
        const showId =
          link.file_id != null && duplicateNames.has(display.toLowerCase());
        return (
          <TouchableOpacity
            key={`${link.file_id ?? i}-${display}`}
            style={[styles.chip, { borderColor: colors.border }]}
            onPress={() => void handleOpen(link)}
            disabled={link.file_id == null}
          >
            <Text style={[styles.name, { color: colors.primary }]} numberOfLines={1}>
              {showId ? `${display} · ${link.file_id}` : display}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 5,
    maxWidth: '100%',
    alignSelf: 'flex-start',
  },
  name: { fontSize: 13, fontWeight: '500' },
});

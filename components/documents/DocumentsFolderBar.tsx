import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import React from 'react';
import {
    ActivityIndicator,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { FOLDER_ICON_COLOR } from '../../constants/folderTheme';
import { useThemeColors } from '../../hooks/useThemeColors';
import type { BreadcrumbItem, FolderRowModel } from '../../types/folder';
import FolderBreadcrumb from '../folders/FolderBreadcrumb';
import FolderListItem from '../folders/FolderListItem';

interface Props {
  breadcrumb: BreadcrumbItem[];
  folders: FolderRowModel[];
  loading?: boolean;
  sortBy?: string;
  onSortPress?: () => void;
  selecting?: boolean;
  selectedCount?: number;
  onSelectPress?: () => void;
  onShareSelected?: () => void;
  onBreadcrumbPress: (index: number) => void;
  onOpenFolder: (folderId: number) => void;
  onFolderMenuPress?: (folder: FolderRowModel) => void;
  onNewFolder: () => void;
}

export default function DocumentsFolderBar({
  breadcrumb,
  folders,
  loading,
  sortBy,
  onSortPress,
  selecting,
  selectedCount = 0,
  onSelectPress,
  onShareSelected,
  onBreadcrumbPress,
  onOpenFolder,
  onFolderMenuPress,
  onNewFolder,
}: Props) {
  const colors = useThemeColors();

  return (
    <View style={styles.wrap}>
      <View style={styles.toolbar}>
        <View style={styles.breadcrumbWrap}>
          <FolderBreadcrumb items={breadcrumb} onPress={onBreadcrumbPress} />
        </View>
        {sortBy && onSortPress ? (
          <View style={styles.sortWrap}>
            <TouchableOpacity
              style={[styles.sortButton, { backgroundColor: colors.surface }]}
              onPress={onSortPress}
              accessibilityLabel={`Sort by ${sortBy}`}
              accessibilityRole="button"
            >
              <Text style={[styles.sortButtonText, { color: colors.text }]}>
                {sortBy.charAt(0).toUpperCase() + sortBy.slice(1)}
              </Text>
              <Ionicons name="chevron-down" size={16} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
        ) : null}
        {onSelectPress ? (
          <TouchableOpacity
            onPress={onSelectPress}
            style={styles.selectBtn}
            accessibilityLabel={selecting ? 'Cancel selection' : 'Select files'}
            accessibilityRole="button"
          >
            <Text style={[styles.selectBtnText, { color: colors.primary || '#007AFF' }]}>
              {selecting ? 'Done' : 'Select'}
            </Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity onPress={onNewFolder} style={styles.newBtn} accessibilityLabel="New folder">
          <MaterialCommunityIcons name="folder-plus-outline" size={22} color={FOLDER_ICON_COLOR} />
        </TouchableOpacity>
      </View>
      {selecting ? (
        <View style={styles.selectionBar}>
          <Text style={[styles.selectionCount, { color: colors.text }]}>
            {selectedCount} selected
          </Text>
          <TouchableOpacity
            onPress={onShareSelected}
            disabled={selectedCount === 0}
            accessibilityLabel="Share selected files"
            accessibilityRole="button"
          >
            <Text
              style={[
                styles.selectionShare,
                { color: selectedCount === 0 ? '#999' : colors.primary || '#007AFF' },
              ]}
            >
              Share
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {loading && folders.length === 0 ? (
        <ActivityIndicator style={{ marginVertical: 12 }} color={colors.primary} />
      ) : folders.length > 0 ? (
        <View style={styles.foldersSection}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.foldersScrollContent}
            nestedScrollEnabled
          >
            {folders.map((folder) => (
              <FolderListItem
                key={folder.id}
                folder={folder}
                variant="tile"
                onPress={() => onOpenFolder(folder.id)}
                onMenuPress={onFolderMenuPress ? () => onFolderMenuPress(folder) : undefined}
              />
            ))}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingBottom: 6 },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 8,
  },
  breadcrumbWrap: {
    flex: 1,
    minWidth: 0,
  },
  sortWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    marginRight: 4,
  },
  sortButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  sortButtonText: {
    fontSize: 12,
    marginRight: 2,
  },
  selectBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    flexShrink: 0,
  },
  selectBtnText: {
    fontSize: 13,
    fontWeight: '600',
  },
  selectionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingTop: 4,
    paddingBottom: 2,
  },
  selectionCount: {
    fontWeight: '600',
    fontSize: 13,
  },
  selectionShare: {
    fontWeight: '600',
    fontSize: 13,
  },
  newBtn: { padding: 6 },
  foldersSection: { marginTop: 3 },
  foldersScrollContent: {
    paddingHorizontal: 14,
    paddingBottom: 4,
  },
});

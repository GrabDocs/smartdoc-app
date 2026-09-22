import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useThemeColors } from '../hooks/useThemeColors';
import { floatingDialogSurfaceStyle, modalScrimOverlayStyle } from '../utils/dialogSurfaceStyles';

export type ListFilterOption = { value: string; label: string };

export type ListFilterSection = {
  title: string;
  options: readonly ListFilterOption[];
  value: string;
  onChange: (value: string) => void;
};

export function ListFilterButton({
  activeCount,
  onPress,
}: {
  activeCount: number;
  onPress: () => void;
}) {
  const colors = useThemeColors();
  const active = activeCount > 0;
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[
        styles.filterBtn,
        {
          backgroundColor: active
            ? colors.isDark
              ? 'rgba(59, 130, 246, 0.24)'
              : '#DBEAFE'
            : colors.surface,
        },
      ]}
      accessibilityRole="button"
      accessibilityLabel={activeCount ? `Filters, ${activeCount} active` : 'Filters'}
      hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
    >
      <Ionicons name="options-outline" size={20} color={active ? '#1D4ED8' : colors.text} />
      <Text style={[styles.filterBtnText, { color: active ? '#1D4ED8' : colors.text }]}>Filter</Text>
      {active ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{activeCount}</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

export default function ListFilterDialog({
  visible,
  sections,
  onClose,
  onClear,
  hasActiveFilters,
}: {
  visible: boolean;
  sections: ListFilterSection[];
  onClose: () => void;
  onClear: () => void;
  hasActiveFilters: boolean;
}) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={modalScrimOverlayStyle(colors.isDark, styles.overlay)}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View
          style={[
            styles.sheet,
            floatingDialogSurfaceStyle(colors, colors.isDark, { borderRadius: 14 }),
            { paddingBottom: 12 + insets.bottom },
          ]}
        >
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <Text style={[styles.title, { color: colors.text }]}>Filters</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {sections.map((section) => (
            <View key={section.title} style={styles.section}>
              <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
                {section.title}
              </Text>
              <View style={styles.chipsWrap}>
                {section.options.map((opt) => {
                  const selected = section.value === opt.value;
                  return (
                    <TouchableOpacity
                      key={`${section.title}-${opt.value || 'all'}`}
                      style={[
                        styles.chip,
                        { backgroundColor: colors.surface },
                        selected && {
                          backgroundColor: colors.isDark ? 'rgba(59, 130, 246, 0.24)' : '#DBEAFE',
                        },
                      ]}
                      onPress={() => section.onChange(opt.value)}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          { color: colors.textSecondary },
                          selected && styles.chipTextActive,
                        ]}
                      >
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          ))}

          <View style={styles.footer}>
            <TouchableOpacity
              onPress={onClear}
              disabled={!hasActiveFilters}
              style={styles.footerBtn}
            >
              <Text
                style={[
                  styles.clearText,
                  { color: hasActiveFilters ? '#007AFF' : colors.textSecondary },
                ]}
              >
                Clear
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onClose}
              style={[styles.doneBtn, { backgroundColor: colors.primary || '#007AFF' }]}
            >
              <Text style={styles.doneText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    justifyContent: 'flex-end',
    padding: 16,
  },
  sheet: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    paddingBottom: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
  },
  section: {
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  chipsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
  },
  chipText: {
    fontSize: 13,
    fontWeight: '500',
  },
  chipTextActive: {
    color: '#1D4ED8',
    fontWeight: '600',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 12,
  },
  footerBtn: {
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  clearText: {
    fontSize: 15,
    fontWeight: '600',
  },
  doneBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 10,
  },
  doneText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  filterBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 4,
    marginLeft: 8,
  },
  filterBtnText: {
    fontSize: 13,
    fontWeight: '600',
  },
  badge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#1D4ED8',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
    marginLeft: 2,
  },
  badgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
});

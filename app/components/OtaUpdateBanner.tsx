import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS } from '../../constants/Config';
import { useTheme } from '../../contexts/ThemeContext';
import { reloadToApplyUpdate } from '../../services/updateService';

export default function OtaUpdateBanner() {
  const { isDark } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.banner, { paddingTop: Math.max(insets.top, 8), backgroundColor: isDark ? COLORS.primaryDark : COLORS.primary }]}>
      <Text style={styles.text} numberOfLines={1}>
        An update is ready. Restart to apply.
      </Text>
      <TouchableOpacity style={styles.button} onPress={() => reloadToApplyUpdate()} activeOpacity={0.8}>
        <Text style={styles.buttonText}>Restart</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 16,
    // Persistent network indicator sits at the far top-right (~20px dot + margins).
    // Keep a small gap so Restart does not overlap it, but leave enough width for one-line text.
    paddingRight: 44,
    paddingBottom: 10,
    gap: 8,
  },
  text: {
    color: COLORS.white,
    fontSize: 14,
    flex: 1,
    flexShrink: 1,
    marginRight: 4,
  },
  button: {
    backgroundColor: 'rgba(255,255,255,0.25)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    flexShrink: 0,
  },
  buttonText: {
    color: COLORS.white,
    fontSize: 14,
    fontWeight: '600',
  },
});

import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS } from '../../constants/Config';
import { useTheme } from '../../contexts/ThemeContext';

export interface ReachMeetingStartedBannerProps {
  message: string;
  onJoin: () => void;
  onDismiss: () => void;
}

/** Top banner when a workspace/chat Reach meeting starts and the user has not joined yet. */
export default function ReachMeetingStartedBanner({
  message,
  onJoin,
  onDismiss,
}: ReachMeetingStartedBannerProps) {
  const { isDark } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.banner,
        {
          paddingTop: Math.max(insets.top, 8),
          backgroundColor: isDark ? COLORS.primaryDark : COLORS.primary,
        },
      ]}
    >
      <Text style={styles.text} numberOfLines={2}>
        {message}
      </Text>
      <View style={styles.buttons}>
        <TouchableOpacity style={styles.buttonSecondary} onPress={onDismiss} activeOpacity={0.8}>
          <Text style={styles.buttonSecondaryText}>Later</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.buttonPrimary} onPress={onJoin} activeOpacity={0.8}>
          <Text style={styles.buttonPrimaryText}>Join</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 10,
  },
  text: {
    color: COLORS.white,
    fontSize: 14,
  },
  buttons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    alignSelf: 'flex-end',
  },
  buttonSecondary: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  buttonSecondaryText: {
    color: COLORS.white,
    fontSize: 14,
  },
  buttonPrimary: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.95)',
  },
  buttonPrimaryText: {
    color: COLORS.primary,
    fontSize: 14,
    fontWeight: '600',
  },
});

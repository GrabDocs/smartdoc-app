import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React from 'react';
import { StyleProp, StyleSheet, ViewStyle } from 'react-native';
import { FeedbackTouchable } from './FeedbackTouchable';
import { useThemeColors } from '../hooks/useThemeColors';
import { APP_HEADER_ICON_SIZE } from './AppHeaderIcon';

/** Approximate width for balancing header spacers opposite this control. */
export const APP_BACK_BUTTON_SLOT = 44;

type AppBackButtonProps = {
  onPress?: () => void;
  /** Override icon tint; defaults to theme text (email-style). */
  color?: string;
  size?: number;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * Shared back control matching email-sync: iOS-style chevron, theme text color.
 */
export default function AppBackButton({
  onPress,
  color,
  size = APP_HEADER_ICON_SIZE,
  accessibilityLabel = 'Back',
  style,
}: AppBackButtonProps) {
  const router = useRouter();
  const colors = useThemeColors();

  return (
    <FeedbackTouchable
      onPress={onPress ?? (() => router.back())}
      style={[styles.button, style]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
    >
      <Ionicons name="chevron-back" size={size} color={color ?? colors.text} />
    </FeedbackTouchable>
  );
}

const styles = StyleSheet.create({
  button: {
    padding: 8,
    marginLeft: -8, // Offset padding so icon aligns with header content edge
    justifyContent: 'center',
    alignItems: 'center',
  },
});

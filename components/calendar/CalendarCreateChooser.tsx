import { Ionicons } from '@expo/vector-icons';
import React, { useMemo } from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useThemeColors } from '../../hooks/useThemeColors';
import MinimizableBottomSheet from '../MinimizableBottomSheet';

interface Props {
  visible: boolean;
  onClose: () => void;
  onCreateEvent: () => void;
  onScheduleEvent: () => void;
  /** Bump on every open so a minimized sheet expands again. */
  expandNonce?: number;
}

export default function CalendarCreateChooser({
  visible,
  onClose,
  onCreateEvent,
  onScheduleEvent,
  expandNonce = 0,
}: Props) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  // Presented in a root Modal above PersistentBottomNavigation — only home-indicator pad.
  const bottomPad = Math.max(insets.bottom, 12);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        host: {
          ...StyleSheet.absoluteFillObject,
        },
        body: {
          paddingHorizontal: 20,
          paddingBottom: 4,
        },
        subtitle: {
          fontSize: 14,
          color: colors.textSecondary,
          marginBottom: 16,
          paddingHorizontal: 4,
        },
        option: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 14,
          padding: 16,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: colors.border ?? '#E5E7EB',
          marginBottom: 12,
        },
        optionLast: {
          marginBottom: 0,
        },
        optionIcon: {
          width: 44,
          height: 44,
          borderRadius: 12,
          alignItems: 'center',
          justifyContent: 'center',
        },
        optionTitle: {
          fontSize: 16,
          fontWeight: '700',
          color: colors.text,
        },
        optionDesc: {
          fontSize: 13,
          color: colors.textSecondary,
          marginTop: 2,
          lineHeight: 18,
        },
      }),
    [colors]
  );

  if (!visible) return null;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      presentationStyle="overFullScreen"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.host} pointerEvents="box-none">
        <MinimizableBottomSheet
          visible={visible}
          onClose={onClose}
          expandNonce={expandNonce}
          title="Create"
          fitContent
          minimizable={false}
          heightRatio={0.55}
          paddingBottom={bottomPad}
        >
          <View style={styles.body}>
            <Text style={styles.subtitle}>Choose what you want to add</Text>

            <TouchableOpacity
              style={styles.option}
              onPress={() => {
                onClose();
                onCreateEvent();
              }}
              accessibilityRole="button"
              accessibilityLabel="Create new event"
            >
              <View style={[styles.optionIcon, { backgroundColor: `${colors.primary}18` }]}>
                <Ionicons name="calendar-outline" size={24} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.optionTitle}>Create new event</Text>
                <Text style={styles.optionDesc}>
                  Put an event on your calendar for a date and time.
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.option, styles.optionLast]}
              onPress={() => {
                onClose();
                onScheduleEvent();
              }}
              accessibilityRole="button"
              accessibilityLabel="Booking page"
            >
              <View style={[styles.optionIcon, { backgroundColor: '#EDE9FE' }]}>
                <Ionicons name="link-outline" size={24} color="#6D28D9" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.optionTitle}>Booking page</Text>
                <Text style={styles.optionDesc}>
                  Open a booking page so someone else can pick a time.
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
        </MinimizableBottomSheet>
      </View>
    </Modal>
  );
}

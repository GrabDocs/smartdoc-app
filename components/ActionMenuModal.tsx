import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { InteractionManager, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { FeedbackTouchable } from './FeedbackTouchable';
import { useThemeColors } from '../hooks/useThemeColors';
import { floatingDialogSurfaceStyle, modalScrimOverlayStyle } from '../utils/dialogSurfaceStyles';

export interface ActionMenuItem {
  id: string;
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  iconColor?: string;
  onPress: () => void | Promise<void>;
  destructive?: boolean;
}

interface Props {
  visible: boolean;
  title?: string;
  /** Optional body copy below the title (e.g. reminder or picker hint). */
  message?: string;
  items: ActionMenuItem[];
  onClose: () => void;
}

export default function ActionMenuModal({ visible, title, message, items, onClose }: Props) {
  const colors = useThemeColors();
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) setBusyId(null);
  }, [visible]);

  const handleClose = () => {
    if (busyId) return;
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <TouchableOpacity
        style={modalScrimOverlayStyle(colors.isDark, styles.overlay)}
        activeOpacity={1}
        onPress={handleClose}
        disabled={!!busyId}
      >
        <View
          style={[
            styles.menu,
            floatingDialogSurfaceStyle(colors, colors.isDark, { minWidth: 220 }),
          ]}
          onStartShouldSetResponder={() => true}
        >
            {title || message ? (
              <View
                style={[
                  styles.headerBlock,
                  items.length > 0 && {
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: colors.border,
                  },
                ]}
              >
                {title ? (
                  <Text
                    style={[styles.title, { color: colors.text }]}
                    numberOfLines={2}
                    ellipsizeMode="tail"
                  >
                    {title}
                  </Text>
                ) : null}
                {message ? (
                  <Text style={[styles.message, { color: colors.textSecondary }]}>{message}</Text>
                ) : null}
              </View>
            ) : null}
            {items.map((item) => {
              const spinnerColor = item.destructive
                ? '#EF4444'
                : item.iconColor ?? colors.text;
              return (
                <FeedbackTouchable
                  key={item.id}
                  style={styles.row}
                  disabled={!!busyId && busyId !== item.id}
                  spinnerColor={spinnerColor}
                  onPress={async () => {
                    if (busyId) return;
                    setBusyId(item.id);
                    const run = item.onPress;
                    // Dismiss this Modal before the action opens another Modal/screen.
                    // Same-tick Modal→Modal transitions freeze touch handling on iOS.
                    onClose();
                    try {
                      await new Promise<void>((resolve) => {
                        InteractionManager.runAfterInteractions(() => resolve());
                      });
                      await Promise.resolve(run());
                    } finally {
                      setBusyId(null);
                    }
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={item.label}
                >
                  {item.icon ? (
                    <Ionicons
                      name={item.icon}
                      size={20}
                      color={item.destructive ? '#EF4444' : item.iconColor ?? colors.text}
                    />
                  ) : null}
                  <Text
                    style={[
                      styles.rowLabel,
                      { color: item.destructive ? '#EF4444' : colors.text },
                      !item.icon && styles.rowLabelNoIcon,
                    ]}
                  >
                    {item.label}
                  </Text>
                </FeedbackTouchable>
              );
            })}
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  menu: {
    width: '100%',
    maxWidth: 320,
    paddingVertical: 8,
    overflow: 'hidden',
  },
  headerBlock: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
  },
  message: {
    fontSize: 14,
    lineHeight: 20,
    marginTop: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  rowLabel: {
    fontSize: 16,
    fontWeight: '500',
    flex: 1,
  },
  rowLabelNoIcon: {
    marginLeft: 0,
  },
});

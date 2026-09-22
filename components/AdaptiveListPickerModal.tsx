import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useThemeColors } from '../hooks/useThemeColors';
import {
  floatingDialogSurfaceStyle,
  modalScrimOverlayStyle,
} from '../utils/dialogSurfaceStyles';

/** Center the card when the list is this short; otherwise use a bottom sheet. */
export const ADAPTIVE_PICKER_CENTER_MAX_ITEMS = 4;

const OPEN_MS = 260;
const CLOSE_MS = 200;
const SHEET_SLIDE_PX = 56;
const CENTER_SLIDE_PX = 12;

type Props = {
  visible: boolean;
  onClose: () => void;
  title: string;
  /** Number of selectable rows — decides centered vs bottom layout. */
  itemCount: number;
  children: React.ReactNode;
  /** Center when itemCount <= this (default 4). */
  centerMaxItems?: number;
  headerRight?: React.ReactNode;
  footer?: React.ReactNode;
};

/**
 * List picker that centers for short lists (avoids a thin bottom strip)
 * and uses a bottom sheet with a minimum height for longer lists.
 *
 * Uses animationType="none" + custom fade/slide so the scrim does not
 * slide with the sheet (avoids the common transparent-Modal flicker).
 */
export default function AdaptiveListPickerModal({
  visible,
  onClose,
  title,
  itemCount,
  children,
  centerMaxItems = ADAPTIVE_PICKER_CENTER_MAX_ITEMS,
  headerRight,
  footer,
}: Props) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const centered = itemCount <= centerMaxItems;

  const [rendered, setRendered] = useState(visible);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const backdropOpacity = useSharedValue(0);
  const contentOffsetY = useSharedValue(centered ? CENTER_SLIDE_PX : SHEET_SLIDE_PX);
  const contentScale = useSharedValue(centered ? 0.98 : 1);

  useEffect(() => {
    if (!rendered) {
      setKeyboardHeight(0);
      return;
    }
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, (e) => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [rendered]);

  const openAnim = useCallback(() => {
    backdropOpacity.value = 0;
    contentOffsetY.value = centered ? CENTER_SLIDE_PX : SHEET_SLIDE_PX;
    contentScale.value = centered ? 0.98 : 1;
    backdropOpacity.value = withTiming(1, {
      duration: OPEN_MS,
      easing: Easing.out(Easing.cubic),
    });
    contentOffsetY.value = withTiming(0, {
      duration: OPEN_MS,
      easing: Easing.out(Easing.cubic),
    });
    contentScale.value = withTiming(1, {
      duration: OPEN_MS,
      easing: Easing.out(Easing.cubic),
    });
  }, [backdropOpacity, centered, contentOffsetY, contentScale]);

  const finishUnmount = useCallback(() => {
    setRendered(false);
  }, []);

  const closeAnim = useCallback(() => {
    backdropOpacity.value = withTiming(0, {
      duration: CLOSE_MS,
      easing: Easing.in(Easing.cubic),
    });
    contentOffsetY.value = withTiming(
      centered ? CENTER_SLIDE_PX : SHEET_SLIDE_PX,
      { duration: CLOSE_MS, easing: Easing.in(Easing.cubic) },
      (finished) => {
        if (finished) runOnJS(finishUnmount)();
      },
    );
    contentScale.value = withTiming(centered ? 0.98 : 1, {
      duration: CLOSE_MS,
      easing: Easing.in(Easing.cubic),
    });
  }, [backdropOpacity, centered, contentOffsetY, contentScale, finishUnmount]);

  useEffect(() => {
    if (visible) {
      setRendered(true);
      openAnim();
      return;
    }
    if (rendered) closeAnim();
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps -- drive open/close from visibility only

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));

  const contentAnimStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
    transform: [
      { translateY: contentOffsetY.value },
      { scale: contentScale.value },
    ],
  }));

  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1 },
        scrim: {
          ...StyleSheet.absoluteFillObject,
          backgroundColor: modalScrimOverlayStyle(colors.isDark).backgroundColor as string,
        },
        layout: {
          ...StyleSheet.absoluteFillObject,
          justifyContent: centered ? 'center' : 'flex-end',
          paddingHorizontal: centered ? 24 : 0,
          // Lift sheet/card above the keyboard so search/create fields stay visible.
          paddingBottom: keyboardHeight,
        },
        card: centered
          ? {
              ...floatingDialogSurfaceStyle(colors, colors.isDark, { borderRadius: 16 }),
              width: '100%' as const,
              maxHeight: Math.round(windowHeight * 0.7),
              overflow: 'hidden' as const,
            }
          : {
              backgroundColor: colors.card,
              borderTopLeftRadius: 16,
              borderTopRightRadius: 16,
              maxHeight: '80%' as const,
              minHeight: Math.round(windowHeight * 0.4),
              paddingBottom: keyboardHeight > 0 ? 12 : Math.max(insets.bottom, 12),
            },
        header: {
          flexDirection: 'row' as const,
          alignItems: 'center' as const,
          justifyContent: 'space-between' as const,
          paddingHorizontal: 16,
          paddingVertical: 14,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        },
        title: {
          flex: 1,
          fontSize: 16,
          fontWeight: '600' as const,
          color: colors.text,
          marginRight: 12,
        },
        closeBtn: { padding: 4 },
        footerSlot: {
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          paddingBottom: centered ? 8 : 0,
        },
      }),
    [centered, colors, insets.bottom, keyboardHeight, windowHeight],
  );

  const requestClose = () => {
    if (!visible) return;
    Keyboard.dismiss();
    onClose();
  };

  return (
    <Modal
      visible={rendered}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={requestClose}
    >
      <View style={styles.root}>
        <Animated.View pointerEvents="none" style={[styles.scrim, backdropStyle]} />
        <Pressable style={StyleSheet.absoluteFill} onPress={requestClose} accessibilityLabel="Close" />
        <View style={styles.layout} pointerEvents="box-none">
          <Animated.View style={[styles.card, contentAnimStyle]}>
            <View style={styles.header}>
              <Text style={styles.title} numberOfLines={1}>
                {title}
              </Text>
              {headerRight ?? (
                <TouchableOpacity style={styles.closeBtn} onPress={requestClose} hitSlop={8}>
                  <Ionicons name="close" size={22} color={colors.text} />
                </TouchableOpacity>
              )}
            </View>
            <ScrollView bounces={itemCount > centerMaxItems} keyboardShouldPersistTaps="handled">
              {children}
            </ScrollView>
            {footer ? <View style={styles.footerSlot}>{footer}</View> : null}
          </Animated.View>
        </View>
      </View>
    </Modal>
  );
}

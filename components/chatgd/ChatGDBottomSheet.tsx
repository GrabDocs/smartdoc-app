import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Dimensions,
  Keyboard,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  ChatGDSheetHostParamsContext,
  useChatGDSheet,
} from '../../contexts/ChatGDSheetContext';
import { useThemeColors } from '../../hooks/useThemeColors';
import MinimizableBottomSheet from '../MinimizableBottomSheet';
import AppHeaderTitle from '../AppHeaderTitle';
import ChatsScreen from '../../app/(tabs)/chats';

const KEYBOARD_EXTRA_INSET = 0;

/**
 * Global ChatGD overlay — mounted once at app root (same pattern as AI FM).
 * When minimized, touches pass through to the screen underneath.
 */
export default function ChatGDBottomSheetHost({ nested = false }: { nested?: boolean }) {
  const colors = useThemeColors();
  const router = useRouter();
  const { visible, expandNonce, params, closeChatGD, nestedHostCount, registerNestedHost } = useChatGDSheet();
  const [keyboardTop, setKeyboardTop] = useState<number | null>(null);

  useEffect(() => {
    if (!nested) return undefined;
    return registerNestedHost();
  }, [nested, registerNestedHost]);

  const openFullChatGD = useCallback(() => {
    const { isSheet: _isSheet, ...rest } = params;
    closeChatGD();
    const navParams: Record<string, string> = { openStartNew: '1' };
    for (const [key, value] of Object.entries(rest)) {
      if (value == null || value === '') continue;
      navParams[key] = Array.isArray(value) ? value[0] : String(value);
    }
    router.navigate({ pathname: '/(tabs)/chats', params: navParams });
  }, [closeChatGD, params, router]);

  useEffect(() => {
    if (!visible) {
      setKeyboardTop(null);
      return;
    }
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, (e) => setKeyboardTop(e.endCoordinates.screenY));
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardTop(null));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [visible]);

  const keyboardInset =
    keyboardTop != null
      ? Math.max(0, Dimensions.get('window').height - keyboardTop + KEYBOARD_EXTRA_INSET)
      : undefined;

  if (!nested && nestedHostCount > 0) return null;
  if (!visible) return null;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      presentationStyle="overFullScreen"
      statusBarTranslucent
      onRequestClose={closeChatGD}
    >
    <View style={styles.host} pointerEvents="box-none">
      <MinimizableBottomSheet
        visible={visible}
        onClose={closeChatGD}
        heightRatio={0.8}
        expandNonce={expandNonce}
        paddingBottom={keyboardInset}
        renderHeader={({ minimized, onExpand, onClose }) => (
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <Ionicons name="chatbubbles" size={20} color="#007AFF" />
              <View style={styles.headerTitles}>
                <AppHeaderTitle fill={false}>ChatGD</AppHeaderTitle>
                <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
                  {minimized ? 'Tap to continue' : 'Ask anything about your files'}
                </Text>
              </View>
            </View>
            <View style={styles.headerActions}>
              {!minimized ? (
                <TouchableOpacity
                  onPress={openFullChatGD}
                  hitSlop={12}
                  style={styles.headerIconBtn}
                  accessibilityLabel="Open full ChatGD"
                >
                  <Ionicons name="expand-outline" size={24} color={colors.textSecondary} />
                </TouchableOpacity>
              ) : null}
              {minimized ? (
                <TouchableOpacity onPress={onExpand} hitSlop={12} accessibilityLabel="Expand">
                  <Ionicons name="chevron-up" size={26} color={colors.textSecondary} />
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity onPress={onClose} hitSlop={12} accessibilityLabel="Close">
                <Ionicons name="close" size={26} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
          </View>
        )}
      >
        <ChatGDSheetHostParamsContext.Provider value={params}>
          <ChatsScreen key={expandNonce} />
        </ChatGDSheetHostParamsContext.Provider>
      </MinimizableBottomSheet>
    </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  host: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 200,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 },
  headerTitles: { flex: 1, minWidth: 0 },
  title: { fontSize: 17, fontWeight: '600' },
  subtitle: { fontSize: 12, marginTop: 2 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  headerIconBtn: { padding: 4 },
});

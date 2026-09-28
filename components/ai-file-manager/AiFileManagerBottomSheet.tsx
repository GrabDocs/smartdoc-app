import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Dimensions,
  Keyboard,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { AI_FM_ICON_COLOR } from '../../constants/aiFileManagerHelp';
import { useAiFileManager } from '../../hooks/useAiFileManager';
import { useThemeColors } from '../../hooks/useThemeColors';
import AppHeaderTitle from '../AppHeaderTitle';
import { FolderCogIcon } from '../FolderCogIcon';
import MinimizableBottomSheet from '../MinimizableBottomSheet';
import AiFileManagerHelpModal from './AiFileManagerHelpModal';
import CommandTab from './CommandTab';
import HistoryTab from './HistoryTab';
import ScheduledTab from './ScheduledTab';

type TabId = 'command' | 'history' | 'scheduled';

const KEYBOARD_EXTRA_INSET = 28;

export interface AiFileManagerBottomSheetProps {
  visible: boolean;
  onClose: () => void;
  workspaceId?: number | null;
  currentFolderId?: number | null;
  onExecuted?: () => void | Promise<void>;
  expandNonce?: number;
}

export default function AiFileManagerBottomSheet({
  visible,
  onClose,
  workspaceId,
  currentFolderId,
  onExecuted,
  expandNonce = 0,
}: AiFileManagerBottomSheetProps) {
  const colors = useThemeColors();
  const { height } = useWindowDimensions();
  const router = useRouter();
  const [tab, setTab] = useState<TabId>('command');
  const [keyboardTop, setKeyboardTop] = useState<number | null>(null);
  const [showHelp, setShowHelp] = useState(false);

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

  const handleHandoff = useCallback(
    (query: string) => {
      onClose();
      router.navigate(`/(tabs)/chats?initialQuery=${encodeURIComponent(query)}&autosubmit=1` as any);
    },
    [onClose, router]
  );

  const fm = useAiFileManager({
    workspaceId,
    currentFolderId,
    visible,
    onExecuted,
    onHandoffToChat: handleHandoff,
  });

  const handleClose = useCallback(() => {
    fm.onSheetClose();
    setShowHelp(false);
    onClose();
  }, [fm, onClose]);

  const tabs: { id: TabId; label: string }[] = [
    { id: 'command', label: 'Command' },
    { id: 'history', label: 'History' },
    { id: 'scheduled', label: 'Scheduled' },
  ];

  return (
    <>
      <MinimizableBottomSheet
        visible={visible}
        onClose={handleClose}
        expandNonce={expandNonce}
        heightRatio={0.8}
        paddingBottom={keyboardInset}
        overlay={
          showHelp ? <AiFileManagerHelpModal visible onClose={() => setShowHelp(false)} /> : null
        }
        renderHeader={({ minimized, onMinimize, onExpand, onClose: closeSheet }) => (
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <FolderCogIcon size={20} color={AI_FM_ICON_COLOR} />
              <View style={styles.headerTitles}>
                <AppHeaderTitle fill={false}>AI File Manager</AppHeaderTitle>
                <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
                  {minimized ? 'Swipe up to continue' : 'Quick file actions · owned files only'}
                </Text>
              </View>
            </View>
            <View style={styles.headerActions}>
              {!minimized ? (
                <>
                  <TouchableOpacity
                    onPress={() => setShowHelp(true)}
                    hitSlop={10}
                    style={styles.headerIconBtn}
                    accessibilityLabel="Help"
                  >
                    <Ionicons name="help-circle-outline" size={24} color={colors.textSecondary} />
                  </TouchableOpacity>
                  {tab === 'command' ? (
                    <TouchableOpacity
                      onPress={() => fm.startNewCommand()}
                      hitSlop={10}
                      style={styles.headerIconBtn}
                      accessibilityLabel="New command"
                    >
                      <Ionicons name="add" size={26} color={colors.textSecondary} />
                    </TouchableOpacity>
                  ) : null}
                </>
              ) : (
                <TouchableOpacity onPress={onExpand} hitSlop={12} accessibilityLabel="Expand">
                  <Ionicons name="chevron-up" size={26} color={colors.textSecondary} />
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={closeSheet} hitSlop={12} accessibilityLabel="Close">
                <Ionicons name="close" size={26} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
          </View>
        )}
      >
        {workspaceId == null ? (
          <View style={styles.noWs}>
            <Text style={{ color: colors.textSecondary, textAlign: 'center' }}>
              Open files in a workspace to use AI file operations.
            </Text>
          </View>
        ) : (
          <>
            <View style={[styles.tabBar, { borderBottomColor: colors.border }]}>
              {tabs.map((t) => (
                <TouchableOpacity
                  key={t.id}
                  onPress={() => setTab(t.id)}
                  style={[styles.tab, tab === t.id && { borderBottomColor: colors.primary }]}
                >
                  <Text
                    style={{
                      color: tab === t.id ? colors.primary : colors.textSecondary,
                      fontWeight: tab === t.id ? '600' : '400',
                    }}
                  >
                    {t.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.tabBody}>
              {tab === 'command' ? (
                <CommandTab fm={fm} onOpenHistoryTab={() => setTab('history')} />
              ) : null}
              {tab === 'history' ? <HistoryTab fm={fm} onResume={() => setTab('command')} /> : null}
              {tab === 'scheduled' ? <ScheduledTab fm={fm} /> : null}
            </View>
          </>
        )}
      </MinimizableBottomSheet>
    </>
  );
}

const styles = StyleSheet.create({
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
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  headerIconBtn: { padding: 4 },
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
  },
  tab: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabBody: { flex: 1 },
  noWs: { flex: 1, justifyContent: 'center', padding: 24 },
});

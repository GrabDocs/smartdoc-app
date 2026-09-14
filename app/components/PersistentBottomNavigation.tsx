import { Ionicons } from '@expo/vector-icons';
import { usePathname, useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useThemeColors } from '../../hooks/useThemeColors';
import { shouldShowPersistentBottomNav } from '../../utils/persistentBottomNavInset';
import { isPrimaryShellRouteActive, navigatePrimaryShell } from '../../utils/tabNavigation';

interface TabItem {
  name: string;
  label: string;
  icon: string;
  route: string;
}

const tabs: TabItem[] = [
  {
    name: 'home',
    label: 'Home',
    icon: 'home',
    route: '/(tabs)',
  },
  {
    name: 'documents',
    label: 'Documents',
    icon: 'document-text',
    route: '/(tabs)/documents',
  },
  {
    name: 'chats',
    label: 'Chats',
    icon: 'chatbubbles',
    route: '/(tabs)/chats',
  },
  {
    name: 'calendar',
    label: 'Calendar',
    icon: 'calendar-outline',
    route: '/calendar',
  },
  {
    name: 'help',
    label: 'Help',
    icon: 'help-circle',
    route: '/(tabs)/help',
  },
];

export default function PersistentBottomNavigation() {
  const router = useRouter();
  const pathname = usePathname();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();

  if (!shouldShowPersistentBottomNav(pathname)) {
    return null;
  }

  const handleTabPress = (route: string) => {
    // navigate (not push) so tab switches don't stack duplicate history entries
    navigatePrimaryShell(router, route, pathname);
  };

  const activeColor = colors.isDark ? '#fff' : '#007AFF';
  const inactiveColor = colors.isDark ? colors.textLight : '#999';

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: colors.isDark ? colors.headerBackground : '#fff',
          borderTopColor: colors.border,
          paddingBottom: Math.max(insets.bottom, 5),
        },
      ]}
    >
      {tabs.map((tab) => {
        const active = isPrimaryShellRouteActive(pathname, tab.route);
        const color = active ? activeColor : inactiveColor;
        return (
          <TouchableOpacity
            key={tab.name}
            style={styles.tab}
            onPress={() => handleTabPress(tab.route)}
            activeOpacity={0.7}
            accessibilityLabel={`${tab.label}, tab`}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
          >
            <Ionicons name={tab.icon as any} size={22} color={color} />
            <Text style={[styles.label, { color }]} numberOfLines={1}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    borderTopWidth: 1,
    paddingTop: 5,
    minHeight: 56,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  label: {
    fontSize: 10,
    fontWeight: '500',
    marginTop: 2,
  },
});

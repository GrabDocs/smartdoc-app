import { Ionicons } from '@expo/vector-icons';
import React, { useMemo } from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GoogleLogo } from '../../../components/GoogleLogo';
import { MicrosoftLogo } from '../../../components/MicrosoftLogo';
import type { CalendarProvider } from '../../../services/calendarApi';
import { useThemeColors } from '../../../hooks/useThemeColors';
import { dialogSurfaceBorder, dialogSurfaceShadow, modalScrimOverlayStyle } from '../../../utils/dialogSurfaceStyles';

type Props = {
  visible: boolean;
  hasGoogle: boolean;
  hasMicrosoft: boolean;
  onClose: () => void;
  onConnectGoogle: () => void;
  onConnectMicrosoft: () => void;
};

function ProviderRow({
  name,
  subtitle,
  connected,
  onConnect,
  icon,
  colors,
}: {
  name: string;
  subtitle: string;
  connected: boolean;
  onConnect: () => void;
  icon: React.ReactNode;
  colors: ReturnType<typeof useThemeColors>;
}) {
  const styles = useMemo(
    () =>
      StyleSheet.create({
        row: {
          flexDirection: 'row',
          alignItems: 'center',
          padding: 14,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface,
          marginBottom: 10,
        },
        iconWrap: {
          width: 40,
          height: 40,
          borderRadius: 10,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.background,
          marginRight: 12,
        },
        body: { flex: 1, minWidth: 0 },
        name: { fontSize: 15, fontWeight: '600', color: colors.text },
        sub: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
        connectBtn: {
          marginTop: 10,
          backgroundColor: '#007AFF',
          borderRadius: 10,
          paddingVertical: 10,
          alignItems: 'center',
        },
        connectTxt: { color: '#fff', fontWeight: '600', fontSize: 14 },
      }),
    [colors]
  );

  return (
    <View style={styles.row}>
      <View style={styles.iconWrap}>{icon}</View>
      <View style={styles.body}>
        <Text style={styles.name}>{name}</Text>
        <Text style={styles.sub}>{subtitle}</Text>
        {connected ? (
          <Text style={[styles.sub, { marginTop: 6, color: '#16a34a', fontWeight: '600' }]}>Connected</Text>
        ) : (
          <TouchableOpacity style={styles.connectBtn} onPress={onConnect} accessibilityRole="button">
            <Text style={styles.connectTxt}>Connect</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

export function ConnectCalendarModal({
  visible,
  hasGoogle,
  hasMicrosoft,
  onClose,
  onConnectGoogle,
  onConnectMicrosoft,
}: Props) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        wrap: modalScrimOverlayStyle(colors.isDark, { justifyContent: 'flex-end' }),
        sheet: {
          backgroundColor: colors.surface,
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          paddingHorizontal: 20,
          paddingTop: 10,
          paddingBottom: Math.max(insets.bottom, 16) + 8,
          ...dialogSurfaceBorder(colors.isDark, colors.border),
          ...dialogSurfaceShadow(colors.isDark),
        },
        handle: {
          alignSelf: 'center',
          width: 40,
          height: 4,
          borderRadius: 2,
          backgroundColor: colors.border,
          marginBottom: 14,
        },
        header: {
          flexDirection: 'row',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          marginBottom: 4,
        },
        title: { fontSize: 18, fontWeight: '700', color: colors.text, flex: 1 },
        sub: { fontSize: 13, color: colors.textSecondary, marginTop: 6, marginBottom: 16, lineHeight: 20 },
        close: { padding: 4, marginLeft: 8 },
      }),
    [colors, insets.bottom]
  );

  const providers: Array<{
    id: CalendarProvider;
    name: string;
    subtitle: string;
    connected: boolean;
    onConnect: () => void;
    icon: React.ReactNode;
  }> = [
    {
      id: 'google',
      name: 'Google',
      subtitle: 'Gmail & Workspace accounts',
      connected: hasGoogle,
      onConnect: onConnectGoogle,
      icon: <GoogleLogo size={24} />,
    },
    {
      id: 'microsoft',
      name: 'Microsoft',
      subtitle: 'Outlook & Exchange calendars',
      connected: hasMicrosoft,
      onConnect: onConnectMicrosoft,
      icon: <MicrosoftLogo size={24} />,
    },
  ];

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.wrap}>
        <View style={StyleSheet.absoluteFillObject} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.title}>Connect a calendar</Text>
            <TouchableOpacity style={styles.close} onPress={onClose} accessibilityLabel="Close">
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <Text style={styles.sub}>
            Import events from Google or Microsoft 365. Changes sync both ways.
          </Text>
          {providers.map((p) => (
            <ProviderRow
              key={p.id}
              name={p.name}
              subtitle={p.subtitle}
              connected={p.connected}
              onConnect={p.onConnect}
              icon={p.icon}
              colors={colors}
            />
          ))}
        </View>
      </View>
    </Modal>
  );
}

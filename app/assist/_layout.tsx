import { Redirect, Stack } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { useVisibleApps } from '../../contexts/VisibleAppsContext';

export default function AssistLayout() {
  const { loaded, isHomeAppVisible } = useVisibleApps();

  if (!loaded) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!isHomeAppVisible('assist')) {
    return <Redirect href="/(tabs)" />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="ask" />
      <Stack.Screen name="calls/index" />
      <Stack.Screen name="calls/[id]" />
      <Stack.Screen name="people" />
      <Stack.Screen name="settings" />
      <Stack.Screen name="setup" />
    </Stack>
  );
}

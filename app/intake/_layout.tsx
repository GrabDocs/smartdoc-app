import { Stack } from 'expo-router';

export default function IntakeLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="create" />
      <Stack.Screen name="template/[id]" />
      <Stack.Screen
        name="schedules/[id]"
        options={{
          presentation: 'card',
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="[id]"
        options={{
          presentation: 'card',
          headerShown: false,
        }}
      />
    </Stack>
  );
}

import { Stack } from 'expo-router';

export default function QuickReachLayout() {
  return (
    // Keep inactive screens mounted so swipe-back from a live call can leave HMS
    // underneath (detach/freeze would tear down WebRTC and freeze rejoin).
    <Stack screenOptions={{ headerShown: false, detachInactiveScreens: false }}>
      <Stack.Screen name="meeting-call" />
      <Stack.Screen 
        name="meeting-details" 
        options={{ 
          presentation: 'card',
          headerShown: false 
        }} 
      />
      <Stack.Screen name="create-meeting" />
      <Stack.Screen name="schedule-meeting" />
      <Stack.Screen
        name="hms-meeting-interface"
        options={{ freezeOnBlur: false, gestureEnabled: true }}
      />
    </Stack>
  );
}

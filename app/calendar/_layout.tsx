import { Stack } from 'expo-router';
import React from 'react';

export default function CalendarLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="scheduling" />
      <Stack.Screen name="[id]" />
      <Stack.Screen name="create" />
      <Stack.Screen name="connections" />
      <Stack.Screen name="rsvp" />
      <Stack.Screen name="ics" />
      <Stack.Screen name="edit/[id]" />
      <Stack.Screen name="assets/[eventId]" />
      <Stack.Screen name="pending/[localId]" />
    </Stack>
  );
}

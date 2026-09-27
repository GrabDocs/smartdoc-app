import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useThemeColors } from '../../hooks/useThemeColors';
import { parseMeetingChat } from '../../utils/parseMeetingChat';

export default function MeetingChatThread({ chatContent }: { chatContent?: string | null }) {
  const colors = useThemeColors();
  const messages = useMemo(() => parseMeetingChat(chatContent), [chatContent]);
  if (!messages.length) return null;

  return (
    <View style={[styles.card, { backgroundColor: colors.surface || colors.card, borderColor: colors.border }]}>
      <Text style={[styles.title, { color: colors.text }]}>Meeting chat</Text>
      {messages.map((message, index) => (
        <View key={`${message.timestamp}-${message.sender}-${index}`} style={{ gap: 2 }}>
          <View style={styles.meta}>
            <Text style={[styles.sender, { color: colors.text }]}>{message.sender}</Text>
            <Text style={[styles.time, { color: colors.textSecondary }]}>{message.timestamp}</Text>
          </View>
          <Text style={[styles.body, { color: colors.text }]}>{message.content}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 12 },
  title: { fontSize: 14, fontWeight: '600' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sender: { fontSize: 12, fontWeight: '700' },
  time: { fontSize: 11, fontVariant: ['tabular-nums'] },
  body: { fontSize: 14, lineHeight: 20 },
});

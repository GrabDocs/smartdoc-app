import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AppBackButton from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiClient } from '../../services/api';
import { askAssist, getAssistArchiveMessage } from '../../services/assistApi';

export default function AssistAskScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ owner_user_id?: string }>();
  const ownerId = params.owner_user_id ? Number(params.owner_user_id) : undefined;
  const colors = useThemeColors();
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState('');
  const [citations, setCitations] = useState<any[]>([]);
  const [note, setNote] = useState('');

  const run = async () => {
    if (!q.trim()) return;
    setLoading(true);
    try {
      const res = await askAssist(q.trim(), ownerId);
      setAnswer(res?.answer || '');
      setCitations(res?.citations || []);
      setNote(res?.note || '');
    } catch (e: any) {
      setAnswer(e?.response?.data?.error || 'Ask failed');
      setCitations([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['top']}>
      <View style={styles.header}>
        <AppBackButton onPress={() => router.back()} />
        <AppHeaderTitle title="Ask My History" />
        <View style={{ width: 40 }} />
      </View>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Ask about emails, attachments, or calls…"
          placeholderTextColor={colors.textSecondary}
          style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.card }]}
          multiline
        />
        <TouchableOpacity style={styles.btn} onPress={() => void run()} disabled={loading}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Ask</Text>}
        </TouchableOpacity>
        {!!answer && (
          <View style={[styles.answer, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={{ color: colors.text, fontSize: 15, lineHeight: 22 }}>{answer}</Text>
            {!!note && (
              <Text style={{ color: colors.textSecondary, marginTop: 12, fontSize: 12 }}>{note}</Text>
            )}
            {citations.length > 0 && (
              <View style={{ marginTop: 12 }}>
                <Text style={{ fontWeight: '700', color: colors.text, marginBottom: 6 }}>Sources</Text>
                {citations.map((c, i) => (
                  <TouchableOpacity
                    key={i}
                    onPress={() => {
                      void (async () => {
                        if (c.kind === 'email' && c.id) {
                          try {
                            const res = await getAssistArchiveMessage(c.id, ownerId);
                            const email = res?.email || {};
                            Alert.alert(
                              email.subject || 'Email',
                              (email.body_text || 'No body stored.').slice(0, 1200),
                            );
                          } catch {
                            Alert.alert('Email', 'Could not open this email.');
                          }
                          return;
                        }
                        if (c.kind === 'call' && c.id) {
                          router.push({
                            pathname: `/assist/calls/${c.id}`,
                            params: ownerId ? { owner_user_id: String(ownerId) } : {},
                          } as any);
                          return;
                        }
                        if (c.kind === 'file' && c.file_url) {
                          const base = String(apiClient.client.defaults.baseURL || '').replace(/\/$/, '');
                          await Linking.openURL(`${base}${c.file_url}`);
                        }
                      })();
                    }}
                  >
                    <Text style={{ color: '#0284C7', fontSize: 12, marginBottom: 4 }}>
                      • {c.kind} {c.subject || c.headline || c.filename || c.id}{' '}
                      {c.date ? `(${c.date})` : ''}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  input: {
    minHeight: 90,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    textAlignVertical: 'top',
    marginBottom: 12,
  },
  btn: {
    backgroundColor: '#0284C7',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 16,
  },
  btnText: { color: '#fff', fontWeight: '700' },
  answer: { borderWidth: 1, borderRadius: 12, padding: 14 },
});

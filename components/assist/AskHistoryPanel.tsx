import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiClient } from '../../services/api';
import { askAssist, getAssistArchiveMessage } from '../../services/assistApi';
import MinimizableBottomSheet from '../MinimizableBottomSheet';
import AssistSourceSheet, { type AssistSourceContent } from './AssistSourceSheet';

type Props = {
  visible: boolean;
  onClose: () => void;
  ownerUserId?: number;
};

export default function AskHistoryPanel({ visible, onClose, ownerUserId }: Props) {
  const router = useRouter();
  const colors = useThemeColors();

  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState('');
  const [citations, setCitations] = useState<any[]>([]);
  const [note, setNote] = useState('');
  const [source, setSource] = useState<AssistSourceContent | null>(null);

  useEffect(() => {
    if (!visible) return;
    setQ('');
    setAnswer('');
    setCitations([]);
    setNote('');
    setSource(null);
  }, [visible]);

  const run = async () => {
    if (!q.trim()) return;
    setLoading(true);
    try {
      const res = await askAssist(q.trim(), ownerUserId);
      setAnswer(res?.answer || '');
      setCitations(res?.citations || []);
      setNote(res?.note || '');
    } catch (e: any) {
      setAnswer(e?.response?.data?.error || 'Ask failed');
      setCitations([]);
      setNote('');
    } finally {
      setLoading(false);
    }
  };

  const openCitation = (c: any) => {
    void (async () => {
      if (c.kind === 'email' && c.id) {
        try {
          const res = await getAssistArchiveMessage(c.id, ownerUserId);
          const email = res?.email || {};
          setSource({ type: 'email', email });
        } catch {
          setSource({ type: 'message', title: 'Email', body: 'Could not open this email.' });
        }
        return;
      }
      if (c.kind === 'call' && c.id) {
        onClose();
        router.push({
          pathname: `/assist/calls/${c.id}`,
          params: ownerUserId ? { owner_user_id: String(ownerUserId) } : {},
        } as any);
        return;
      }
      if (c.kind === 'file' && c.file_url) {
        const base = String(apiClient.client.defaults.baseURL || '').replace(/\/$/, '');
        const url = String(c.file_url).startsWith('http')
          ? String(c.file_url)
          : `${base}${c.file_url}`;
        await Linking.openURL(url);
      }
    })();
  };

  return (
    <>
      <MinimizableBottomSheet
        visible={visible}
        onClose={onClose}
        title="Ask My History"
        subtitle="Assist"
        heightRatio={0.9}
        minimizable={false}
      >
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 28 }}
          keyboardShouldPersistTaps="handled"
        >
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder="Ask about emails, attachments, or calls…"
            placeholderTextColor={colors.textSecondary}
            style={[
              styles.input,
              { color: colors.text, borderColor: colors.border, backgroundColor: colors.background },
            ]}
            multiline
          />
          <TouchableOpacity
            style={[styles.btn, (!q.trim() || loading) && { opacity: 0.6 }]}
            onPress={() => void run()}
            disabled={loading || !q.trim()}
          >
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Ask</Text>}
          </TouchableOpacity>

          {!!answer && (
            <View style={[styles.answer, { borderColor: colors.border, backgroundColor: colors.background }]}>
              <Text style={{ color: colors.text, fontSize: 15, lineHeight: 22 }}>{answer}</Text>
              {!!note && (
                <Text style={{ color: colors.textSecondary, marginTop: 12, fontSize: 12 }}>{note}</Text>
              )}
              {citations.length > 0 && (
                <View style={{ marginTop: 12 }}>
                  <Text style={{ fontWeight: '700', color: colors.text, marginBottom: 6 }}>Sources</Text>
                  {citations.map((c, i) => (
                    <TouchableOpacity key={i} onPress={() => openCitation(c)}>
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
      </MinimizableBottomSheet>

      <AssistSourceSheet
        visible={Boolean(source)}
        content={source}
        onClose={() => setSource(null)}
      />
    </>
  );
}

const styles = StyleSheet.create({
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

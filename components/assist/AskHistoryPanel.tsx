import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { API_BASE_URL } from '../../constants/Config';
import { useThemeColors } from '../../hooks/useThemeColors';
import {
  askAssist,
  formatAssistCitationDate,
  getAssistArchiveMessage,
  getAssistAskThread,
  listAssistAskThreads,
  type AssistAskThread,
} from '../../services/assistApi';
import GeneralFileViewerModal from '../GeneralFileViewerModal';
import MinimizableBottomSheet from '../MinimizableBottomSheet';
import AssistSourceSheet, { type AssistSourceContent } from './AssistSourceSheet';
import MarkdownPlainText from './MarkdownPlainText';

type Props = {
  visible: boolean;
  onClose: () => void;
  ownerUserId?: number;
};

type Turn = {
  question: string;
  answer: string;
  citations: any[];
  note: string;
};

function citationLabel(c: any): string {
  if (c.kind === 'calendar') {
    const when = formatAssistCitationDate(c.date || c.start_time);
    return `• calendar ${c.title || 'Event'}${when ? ` (${when})` : ''}`;
  }
  const when = formatAssistCitationDate(c.date);
  return `• ${c.kind} ${c.subject || c.headline || c.filename || c.id}${when ? ` (${when})` : ''}`;
}

function messagesToTurns(
  messages: { role: string; content: string; citations?: any[]; note?: string }[],
): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      turns.push({ question: m.content, answer: '', citations: [], note: '' });
    } else if (m.role === 'assistant' && turns.length) {
      turns[turns.length - 1].answer = m.content;
      turns[turns.length - 1].citations = Array.isArray(m.citations) ? m.citations : [];
      turns[turns.length - 1].note = m.note || '';
    }
  }
  return turns;
}

export default function AskHistoryPanel({ visible, onClose, ownerUserId }: Props) {
  const router = useRouter();
  const colors = useThemeColors();

  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [threadId, setThreadId] = useState<number | null>(null);
  const [threads, setThreads] = useState<AssistAskThread[]>([]);
  const [source, setSource] = useState<AssistSourceContent | null>(null);
  const [fileViewer, setFileViewer] = useState<{
    visible: boolean;
    fileId: number;
    title: string;
    pdfUri: string | null;
    expandNonce: number;
  }>({ visible: false, fileId: 0, title: 'Document', pdfUri: null, expandNonce: 0 });

  const refreshThreads = () => {
    listAssistAskThreads(ownerUserId)
      .then((res) => setThreads(res?.threads || []))
      .catch(() => setThreads([]));
  };

  useEffect(() => {
    if (!visible) return;
    setQ('');
    setTurns([]);
    setThreadId(null);
    setSource(null);
    setFileViewer((s) => ({ ...s, visible: false }));
    refreshThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, ownerUserId]);

  const startNew = () => {
    setQ('');
    setTurns([]);
    setThreadId(null);
    refreshThreads();
  };

  const openThread = async (id: number) => {
    try {
      const res = await getAssistAskThread(id, ownerUserId);
      setTurns(messagesToTurns(res?.messages || []));
      setThreadId(id);
    } catch {
      setTurns([]);
      setThreadId(null);
    }
  };

  const run = async () => {
    const question = q.trim();
    if (!question) return;
    setLoading(true);
    try {
      const res = await askAssist(question, ownerUserId, threadId);
      // No Sources when Ask failed (e.g. out of credits) or returned no usable answer.
      const showSources = res?.ok !== false && Boolean(res?.answer) && !res?.error;
      setTurns((prev) => [
        ...prev,
        {
          question,
          answer: res?.answer || '',
          citations: showSources ? res?.citations || [] : [],
          note: showSources ? res?.note || '' : '',
        },
      ]);
      if (res?.chat_history_id) setThreadId(Number(res.chat_history_id));
      setQ('');
    } catch (e: any) {
      setTurns((prev) => [
        ...prev,
        {
          question,
          answer:
            e?.response?.data?.answer ||
            e?.response?.data?.error ||
            (e?.response?.status === 402 ? 'Not enough credits to Ask right now.' : null) ||
            'Ask failed',
          citations: [],
          note: '',
        },
      ]);
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
      if (c.kind === 'file' && (c.file_url || c.id)) {
        const path = String(c.file_url || '');
        const pdfUri = path
          ? path.startsWith('http')
            ? path
            : `${String(API_BASE_URL || '').replace(/\/$/, '')}${path}`
          : null;
        setFileViewer((prev) => ({
          visible: true,
          fileId: Number(c.id) || 0,
          title: c.filename || 'Document',
          pdfUri,
          expandNonce: prev.expandNonce + 1,
        }));
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
          {turns.length === 0 && threads.length > 0 && (
            <View style={{ marginBottom: 12 }}>
              <Text style={{ fontWeight: '700', color: colors.text, marginBottom: 6 }}>Recent</Text>
              {threads.slice(0, 8).map((t) => (
                <TouchableOpacity key={t.id} onPress={() => void openThread(t.id)}>
                  <Text numberOfLines={1} style={{ color: '#0284C7', fontSize: 13, marginBottom: 6 }}>
                    {t.title || t.last_message_preview || 'Question'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {turns.map((t, idx) => (
            <View
              key={idx}
              style={[styles.answer, { borderColor: colors.border, backgroundColor: colors.background }]}
            >
              <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 8 }}>{t.question}</Text>
              {!!t.answer && (
                <MarkdownPlainText
                  text={t.answer}
                  style={{ color: colors.text, fontSize: 15, lineHeight: 22 }}
                />
              )}
              {!!t.note && (
                <Text style={{ color: colors.textSecondary, marginTop: 12, fontSize: 12 }}>{t.note}</Text>
              )}
              {t.citations.length > 0 && (
                <View style={{ marginTop: 12 }}>
                  <Text style={{ fontWeight: '700', color: colors.text, marginBottom: 6 }}>Sources</Text>
                  {t.citations.map((c, i) =>
                    c.kind === 'calendar' ? (
                      <Text key={i} style={{ color: colors.textSecondary, fontSize: 12, marginBottom: 4 }}>
                        {citationLabel(c)}
                      </Text>
                    ) : (
                      <TouchableOpacity key={i} onPress={() => openCitation(c)}>
                        <Text style={{ color: '#0284C7', fontSize: 12, marginBottom: 4 }}>{citationLabel(c)}</Text>
                      </TouchableOpacity>
                    ),
                  )}
                </View>
              )}
            </View>
          ))}

          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder={turns.length ? 'Ask a follow-up…' : 'Ask about emails, attachments, calls, or meetings…'}
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
          {turns.length > 0 && !loading && (
            <TouchableOpacity onPress={startNew} style={{ alignItems: 'center', paddingVertical: 6 }}>
              <Text style={{ color: '#0284C7', fontWeight: '600' }}>New question</Text>
            </TouchableOpacity>
          )}
        </ScrollView>
      </MinimizableBottomSheet>

      <AssistSourceSheet
        visible={Boolean(source)}
        content={source}
        onClose={() => setSource(null)}
      />

      <GeneralFileViewerModal
        visible={fileViewer.visible}
        expandNonce={fileViewer.expandNonce}
        fileId={fileViewer.fileId}
        title={fileViewer.title}
        pdfUri={fileViewer.pdfUri}
        onClose={() => setFileViewer((s) => ({ ...s, visible: false }))}
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
  answer: { borderWidth: 1, borderRadius: 12, padding: 14, marginBottom: 12 },
});

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

export default function AskHistoryPanel({ visible, onClose, ownerUserId }: Props) {
  const router = useRouter();
  const colors = useThemeColors();

  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState('');
  const [citations, setCitations] = useState<any[]>([]);
  const [note, setNote] = useState('');
  const [source, setSource] = useState<AssistSourceContent | null>(null);
  const [fileViewer, setFileViewer] = useState<{
    visible: boolean;
    fileId: number;
    title: string;
    pdfUri: string | null;
    expandNonce: number;
  }>({ visible: false, fileId: 0, title: 'Document', pdfUri: null, expandNonce: 0 });

  useEffect(() => {
    if (!visible) return;
    setQ('');
    setAnswer('');
    setCitations([]);
    setNote('');
    setSource(null);
    setFileViewer((s) => ({ ...s, visible: false }));
  }, [visible]);

  const run = async () => {
    if (!q.trim()) return;
    setLoading(true);
    try {
      const res = await askAssist(q.trim(), ownerUserId);
      setAnswer(res?.answer || '');
      // No Sources when Ask failed (e.g. out of credits) or returned no usable answer.
      const showSources = res?.ok !== false && Boolean(res?.answer) && !res?.error;
      setCitations(showSources ? res?.citations || [] : []);
      setNote(showSources ? res?.note || '' : '');
    } catch (e: any) {
      setAnswer(
        e?.response?.data?.answer ||
          e?.response?.data?.error ||
          (e?.response?.status === 402 ? 'Not enough credits to Ask right now.' : null) ||
          'Ask failed',
      );
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
              <MarkdownPlainText
                text={answer}
                style={{ color: colors.text, fontSize: 15, lineHeight: 22 }}
              />
              {!!note && (
                <Text style={{ color: colors.textSecondary, marginTop: 12, fontSize: 12 }}>{note}</Text>
              )}
              {citations.length > 0 && (
                <View style={{ marginTop: 12 }}>
                  <Text style={{ fontWeight: '700', color: colors.text, marginBottom: 6 }}>Sources</Text>
                  {citations.map((c, i) => {
                    const when = formatAssistCitationDate(c.date);
                    return (
                      <TouchableOpacity key={i} onPress={() => openCitation(c)}>
                        <Text style={{ color: '#0284C7', fontSize: 12, marginBottom: 4 }}>
                          • {c.kind} {c.subject || c.headline || c.filename || c.id}{' '}
                          {when ? `(${when})` : ''}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
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
  answer: { borderWidth: 1, borderRadius: 12, padding: 14 },
});

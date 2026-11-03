import React, { useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { explainAssistDocument } from '../../services/assistApi';

type Props = {
  fileId?: number;
  text?: string;
  /** When false, render nothing (flag off). */
  enabled?: boolean;
};

/**
 * One-tap Assist Explain. Shown when Assist flag is on for the user.
 */
export default function ExplainDocumentButton({ fileId, text, enabled = true }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');

  if (!enabled) return null;

  const run = async () => {
    setOpen(true);
    setLoading(true);
    setError('');
    try {
      const res = await explainAssistDocument(
        fileId ? { file_id: fileId } : { text: text || '' },
      );
      if (!res?.ok) {
        setError(res?.error || 'Explain failed');
        setResult(null);
      } else {
        setResult(res.result);
      }
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Explain failed');
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <TouchableOpacity style={styles.btn} onPress={() => void run()}>
        <Text style={styles.btnText}>Explain</Text>
      </TouchableOpacity>
      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={styles.modal}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Explain this document</Text>
            <TouchableOpacity onPress={() => setOpen(false)}>
              <Text style={{ color: '#0284C7', fontWeight: '700' }}>Close</Text>
            </TouchableOpacity>
          </View>
          {loading ? (
            <ActivityIndicator style={{ marginTop: 40 }} color="#0284C7" />
          ) : error ? (
            <Text style={{ padding: 16, color: '#DC2626' }}>{error}</Text>
          ) : result ? (
            <ScrollView contentContainerStyle={{ padding: 16 }}>
              <Text style={styles.h}>What it says</Text>
              <Text style={styles.p}>{result.what_it_says}</Text>
              <Text style={styles.h}>What you may need to do</Text>
              <Text style={styles.p}>{result.what_you_may_need_to_do || '—'}</Text>
              <Text style={styles.h}>Assist suggestion</Text>
              <Text style={styles.p}>{result.assist_suggestion || '—'}</Text>
              {result.incomplete ? (
                <Text style={[styles.p, { color: '#B45309' }]}>
                  Some parts could not be read with confidence.
                </Text>
              ) : null}
            </ScrollView>
          ) : null}
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  btn: {
    backgroundColor: '#0284C7',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  modal: { flex: 1, backgroundColor: '#fff', paddingTop: 48 },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
  },
  modalTitle: { fontSize: 18, fontWeight: '700' },
  h: { fontWeight: '700', marginTop: 12, marginBottom: 4 },
  p: { fontSize: 15, lineHeight: 22, color: '#111827' },
});

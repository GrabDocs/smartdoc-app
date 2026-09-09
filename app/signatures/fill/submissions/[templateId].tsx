import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import DocumentViewer from '../../../../components/DocumentViewer';
import FileNameText from '../../../../components/FileNameText';
import { useThemeColors } from '../../../../hooks/useThemeColors';
import { listTemplateSubmissions, type FillSubmission } from '../../../../services/fillApi';
import { formatEnvelopeListDate } from '../../../../utils/envelopeDisplay';
import { submissionDisplayTitle } from '../../../../utils/signatureActivity';

import AppBackButton from '../../../../components/AppBackButton';
import AppHeaderTitle from '../../../../components/AppHeaderTitle';
import { truncateAppHeaderTitle } from '../../../../utils/chatTitleDisplay';

export default function TemplateSubmissionsScreen() {
  const { templateId } = useLocalSearchParams<{ templateId: string }>();
  const router = useRouter();
  const colors = useThemeColors();
  const [submissions, setSubmissions] = useState<FillSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [viewerFile, setViewerFile] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(
    async (opts?: { background?: boolean }) => {
      if (!templateId) return;
      if (!opts?.background) setLoading(true);
      try {
        const rows = await listTemplateSubmissions(templateId);
        setSubmissions(rows);
      } catch {
        setSubmissions([]);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [templateId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const templateTitle = submissions[0]?.template_name?.trim() || 'Completed submissions';

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.background },
        header: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 14,
          paddingVertical: 12,
          gap: 12, backgroundColor: colors.headerBackground },
        headerTitle: { flex: 1, fontSize: 18, fontWeight: '700', color: colors.text },
        row: {
          flexDirection: 'row',
          alignItems: 'center',
          padding: 14,
          marginHorizontal: 14,
          marginBottom: 8,
          borderRadius: 10,
          borderWidth: 1,
          backgroundColor: colors.card,
          borderColor: colors.border,
        },
        rowBody: { flex: 1, minWidth: 0 },
        rowTitle: { fontSize: 15, fontWeight: '600', color: colors.text, marginBottom: 4 },
        rowMeta: { fontSize: 12, color: colors.textSecondary },
        badge: {
          alignSelf: 'flex-start',
          backgroundColor: '#DCFCE7',
          paddingHorizontal: 8,
          paddingVertical: 3,
          borderRadius: 6,
          marginBottom: 4,
        },
        badgeText: { fontSize: 11, fontWeight: '600', color: '#166534' },
        empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
      }),
    [colors],
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <AppBackButton />
        <AppHeaderTitle shrink={false}>
          {truncateAppHeaderTitle(templateTitle || 'Submissions')}
        </AppHeaderTitle>
      </View>

      {loading && submissions.length === 0 ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={submissions}
          keyExtractor={(item) => String(item.id)}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                void load({ background: true });
              }}
            />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={{ color: colors.textSecondary }}>No completed submissions yet</Text>
            </View>
          }
          renderItem={({ item }) => {
            const filledDate = formatEnvelopeListDate(item.filled_at);
            const meta = [filledDate ? `Completed ${filledDate}` : null, item.filled_by_name?.trim()]
              .filter(Boolean)
              .join(' · ');
            const canView = item.filled_file_id != null;

            return (
              <TouchableOpacity
                style={styles.row}
                disabled={!canView}
                onPress={() => {
                  if (item.filled_file_id == null) return;
                  setViewerFile({
                    id: String(item.filled_file_id),
                    name: submissionDisplayTitle(item),
                  });
                }}
              >
                <View style={styles.rowBody}>
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>Completed</Text>
                  </View>
                  <FileNameText
                    name={submissionDisplayTitle(item)}
                    style={styles.rowTitle}
                    sanitize={false}
                  />
                  {meta ? <Text style={styles.rowMeta}>{meta}</Text> : null}
                </View>
                {canView ? (
                  <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
                ) : null}
              </TouchableOpacity>
            );
          }}
          contentContainerStyle={
            submissions.length === 0 ? { flexGrow: 1 } : { paddingTop: 4, paddingBottom: 24 }
          }
        />
      )}

      {viewerFile ? (
        <DocumentViewer
          fileId={viewerFile.id}
          fileName={viewerFile.name}
          fileType="application/pdf"
          onClose={() => setViewerFile(null)}
        />
      ) : null}
    </SafeAreaView>
  );
}

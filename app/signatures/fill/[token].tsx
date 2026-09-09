/**
 * Plain fill session (Mode A) — complete a shared fillable document.
 * Full annotation toolbar + submit flow: see mobile_fill_implementation plan.
 */

import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useThemeColors } from '../../../hooks/useThemeColors';
import { getFillDocument, type FillDocumentResponse } from '../../../services/fillApi';

import AppBackButton from '../../../components/AppBackButton';
import AppHeaderTitle from '../../../components/AppHeaderTitle';
import { truncateAppHeaderTitle } from '../../../utils/chatTitleDisplay';

export default function FillSessionScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { token } = useLocalSearchParams<{ token: string }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [doc, setDoc] = useState<FillDocumentResponse | null>(null);

  const load = useCallback(async () => {
    if (!token) {
      setError('Missing fill link');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await getFillDocument(token);
      setDoc(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not load document');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <SafeAreaView style={[styles.centered, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={{ color: colors.textSecondary, marginTop: 12 }}>Loading document…</Text>
      </SafeAreaView>
    );
  }

  if (error || !doc) {
    return (
      <SafeAreaView style={[styles.centered, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.error ?? '#EF4444', textAlign: 'center', paddingHorizontal: 24 }}>
          {error ?? 'Document not found'}
        </Text>
        <TouchableOpacity onPress={() => void load()} style={{ marginTop: 16 }}>
          <Text style={{ color: colors.primary, fontWeight: '600' }}>Retry</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 12 }}>
          <Text style={{ color: colors.textSecondary }}>Go back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const readOnly = doc.link_type === 'view';

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { backgroundColor: colors.headerBackground }]}>
        <AppBackButton />
        <View style={{ flex: 1 }}>
          <AppHeaderTitle shrink={false}>
            {truncateAppHeaderTitle(doc.template_name || 'Document')}
          </AppHeaderTitle>
          <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
            {readOnly ? 'View only' : 'Fill mode'}
          </Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.pages}>
        {doc.page_images.map((uri, index) => (
          <Image
            key={`page-${index}`}
            source={{ uri }}
            style={styles.pageImage}
            resizeMode="contain"
          />
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 12},
  headerTitle: { fontSize: 17, fontWeight: '600' },
  pages: { padding: 12, paddingBottom: 24, gap: 16, alignItems: 'center' },
  pageImage: { width: '100%', aspectRatio: 0.77, backgroundColor: '#fff' } });

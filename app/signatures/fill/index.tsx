import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FeedbackTouchable } from '../../../components/FeedbackTouchable';
import { pickDocumentForFill } from '../../../components/signatures/DocumentSourcePicker';
import { useThemeColors } from '../../../hooks/useThemeColors';
import { uploadDocumentForFillable } from '../../../services/uploadWithGlobalProgress';
import { hubFillEditorRoute, hubFillPickRoute } from '../../../utils/signatureRouteResolver';

import AppBackButton from '../../../components/AppBackButton';
import AppHeaderTitle from '../../../components/AppHeaderTitle';

export default function FillEntryScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const [busy, setBusy] = useState(false);

  const handleUpload = useCallback(async () => {
    try {
      setBusy(true);
      const asset = await pickDocumentForFill();
      if (!asset?.uri) return;
      const { templateId } = await uploadDocumentForFillable(asset);
      router.replace(hubFillEditorRoute(templateId));
    } catch (e: unknown) {
      Alert.alert('Upload failed', e instanceof Error ? e.message : 'Try again');
    } finally {
      setBusy(false);
    }
  }, [router]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { backgroundColor: colors.headerBackground }]}>
        <AppBackButton onPress={() => { if (!busy) router.back(); }} />
        <AppHeaderTitle>Fill a document</AppHeaderTitle>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.hero, { backgroundColor: `${colors.primary}10` }]}>
          <Ionicons name="create-outline" size={32} color={colors.primary} />
          <Text style={[styles.heroTitle, { color: colors.text }]}>Complete it yourself</Text>
          <Text style={[styles.heroText, { color: colors.textSecondary }]}>
            Fill is for finishing a document on your own — signature, initials, text, and checkboxes.
            It is not the same as sending a document out for others to sign.
          </Text>
        </View>

        <FeedbackTouchable
          style={[styles.primaryBtn, { backgroundColor: colors.primary, opacity: busy ? 0.6 : 1 }]}
          disabled={busy}
          loading={busy}
          onPress={handleUpload}
          spinnerColor="#fff"
        >
          <Ionicons name="cloud-upload-outline" size={22} color="#fff" />
          <Text style={styles.primaryBtnText}>Upload document</Text>
        </FeedbackTouchable>

        <TouchableOpacity
          style={[styles.secondaryBtn, { borderColor: colors.border ?? '#E5E7EB', opacity: busy ? 0.6 : 1 }]}
          disabled={busy}
          onPress={() => router.push(hubFillPickRoute())}
        >
          <Ionicons name="folder-open-outline" size={20} color={colors.text} />
          <Text style={[styles.secondaryBtnText, { color: colors.text }]}>Choose existing document</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12 },
  headerTitle: { fontSize: 18, fontWeight: '600' },
  content: { padding: 16, paddingBottom: 40 },
  hero: {
    borderRadius: 14,
    padding: 20,
    alignItems: 'center',
    marginBottom: 24,
    gap: 8 },
  heroTitle: { fontSize: 18, fontWeight: '700', marginTop: 4 },
  heroText: { fontSize: 14, lineHeight: 21, textAlign: 'center' },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 16,
    borderRadius: 10,
    marginBottom: 12 },
  primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 14,
    borderRadius: 10,
    borderWidth: 1 },
  secondaryBtnText: { fontWeight: '600', fontSize: 15 } });

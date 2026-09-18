import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import React from 'react';
import { Alert, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import FileNameText from '../FileNameText';
import { SIGNATURE_LIST_TITLE_MAX } from '../../utils/displayFilename';
import { useThemeColors } from '../../hooks/useThemeColors';
import type { WizardSourceDraft } from '../../types/signature';

interface Props {
  sources: WizardSourceDraft[];
  onSourcesChange: (sources: WizardSourceDraft[]) => void;
  onOpenUpload: () => void;
  onPrepare: (templateId: number) => void;
}

export default function DocumentSourcePicker({
  sources,
  onSourcesChange,
  onOpenUpload,
  onPrepare,
}: Props) {
  const colors = useThemeColors();

  const move = (index: number, dir: -1 | 1) => {
    const next = [...sources];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    onSourcesChange(next);
  };

  const remove = (index: number) => {
    Alert.alert('Remove document?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => onSourcesChange(sources.filter((_, i) => i !== index)),
      },
    ]);
  };

  return (
    <View style={styles.section}>
      <Text style={[styles.sectionLabel, { color: colors.text }]}>Documents</Text>

      {sources.length === 0 ? (
        <TouchableOpacity
          style={[
            styles.emptyUpload,
            { borderColor: colors.primary, backgroundColor: `${colors.primary}08` },
          ]}
          onPress={onOpenUpload}
          accessibilityLabel="Upload document"
          accessibilityRole="button"
        >
          <View style={[styles.emptyIconWrap, { backgroundColor: `${colors.primary}18` }]}>
            <Ionicons name="cloud-upload-outline" size={24} color={colors.primary} />
          </View>
          <Text style={[styles.emptyTitle, { color: colors.text }]}>Upload document</Text>
          <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
            PDF, Office, images, or text
          </Text>
        </TouchableOpacity>
      ) : (
        <>
          {sources.map((s, i) => (
            <View key={s.localId} style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <FileNameText
                  name={s.display_name || s.source_type}
                  style={[styles.name, { color: colors.text }]}
                  maxLength={SIGNATURE_LIST_TITLE_MAX}
                />
                <Text style={{ color: colors.textSecondary, fontSize: 12 }}>{s.source_type}</Text>
              </View>
              {s.source_type === 'fillable' && s.fillable_template_id ? (
                <TouchableOpacity onPress={() => onPrepare(s.fillable_template_id!)} style={styles.iconBtn}>
                  <Text style={{ color: colors.primary, fontSize: 12 }}>Prepare</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity onPress={() => move(i, -1)} disabled={i === 0}>
                <Ionicons name="arrow-up" size={20} color={i === 0 ? colors.border : colors.text} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => move(i, 1)} disabled={i === sources.length - 1}>
                <Ionicons name="arrow-down" size={20} color={i === sources.length - 1 ? colors.border : colors.text} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => remove(i)}>
                <Ionicons name="trash-outline" size={20} color="#dc2626" />
              </TouchableOpacity>
            </View>
          ))}
          <TouchableOpacity
            style={[styles.addBtn, { borderColor: colors.border }]}
            onPress={onOpenUpload}
            accessibilityLabel="Add another document"
            accessibilityRole="button"
          >
            <Ionicons name="add-circle-outline" size={20} color={colors.primary} />
            <Text style={[styles.addBtnText, { color: colors.primary }]}>Add document</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 12 },
  sectionLabel: { fontWeight: '600', marginBottom: 8 },
  emptyUpload: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1.5,
    borderStyle: 'dashed',
  },
  emptyIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  emptyTitle: { fontSize: 15, fontWeight: '700', marginBottom: 2 },
  emptySubtitle: { fontSize: 13, textAlign: 'center' },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    marginTop: 4,
    borderWidth: 1,
    borderRadius: 8,
    borderStyle: 'dashed',
  },
  addBtnText: { fontSize: 15, fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    marginBottom: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  name: { fontWeight: '600' },
  iconBtn: { paddingHorizontal: 8 },
});

export async function pickDocumentPdf(): Promise<DocumentPicker.DocumentPickerAsset | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: 'application/pdf',
    copyToCacheDirectory: true,
  });
  if (result.canceled || !result.assets?.[0]) return null;
  return result.assets[0];
}

const FILES_SCREEN_DOCUMENT_TYPES = [
  'application/pdf',
  'image/*',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

/** Types Fill and signature-create accept (CSV/txt are covered by text/*). */
export const FILLABLE_DOCUMENT_TYPES = [
  'application/pdf',
  'text/*',
  'text/html',
  'application/rtf',
  'text/rtf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'image/*',
] as const;

function enforceMobileUploadLimit(count: number): boolean {
  const isMobile = Platform.OS === 'ios' || Platform.OS === 'android';
  if (isMobile && count > 3) {
    Alert.alert('Upload Limit', 'Sorry, our maximum upload is 3', [{ text: 'OK' }]);
    return false;
  }
  return true;
}

/** Same document picker as the Files screen upload dialog. */
export async function pickDocumentsLikeFilesScreen(): Promise<DocumentPicker.DocumentPickerAsset[] | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: [...FILES_SCREEN_DOCUMENT_TYPES],
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled || !result.assets?.length) return null;
  if (!enforceMobileUploadLimit(result.assets.length)) return null;
  return result.assets;
}

/** Same gallery picker as the Files screen upload dialog. */
export async function pickGalleryImagesLikeFilesScreen(): Promise<
  Array<{ uri: string; name?: string; mimeType?: string }> | null
> {
  const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permissionResult.granted) {
    Alert.alert('Permission required', 'Media library permission is required to select files.');
    return null;
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 1,
    allowsMultipleSelection: true,
  });
  if (result.canceled || !result.assets?.length) return null;
  if (!enforceMobileUploadLimit(result.assets.length)) return null;

  return result.assets.map((asset, i) => ({
    uri: asset.uri,
    name: asset.fileName || `image_${Date.now()}_${i}.jpg`,
    mimeType: asset.mimeType || asset.type || 'image/jpeg',
  }));
}

/** Pick a document for Fill — PDF, text, HTML, RTF, OpenDocument, or Office. */
export async function pickDocumentForFill(): Promise<DocumentPicker.DocumentPickerAsset | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: [...FILLABLE_DOCUMENT_TYPES],
    copyToCacheDirectory: true,
  });
  if (result.canceled || !result.assets?.[0]) return null;
  return result.assets[0];
}

/** Same types as Fill, multiple selection — used by signature create (not intake). */
export async function pickDocumentsForFillable(): Promise<DocumentPicker.DocumentPickerAsset[] | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: [...FILLABLE_DOCUMENT_TYPES],
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled || !result.assets?.length) return null;
  if (!enforceMobileUploadLimit(result.assets.length)) return null;
  return result.assets;
}

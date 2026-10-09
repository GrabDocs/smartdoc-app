import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { Image as ExpoImage } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import { captureRef } from 'react-native-view-shot';
import { SafeAreaView } from 'react-native-safe-area-context';
import AppHeaderTitle from '../../components/AppHeaderTitle';
import { useLimitError } from '../../contexts/LimitErrorContext';
import { extractLimitErrorData, getErrorResponseData } from '../../utils/limitErrorUtils';

type EnhancementMode = 'auto' | 'high_contrast' | 'black_white';

interface FilterOption {
  key: EnhancementMode;
  label: string;
  icon: string;
  filter: Array<Record<string, number>>;
  description: string;
}

const FILTER_OPTIONS: FilterOption[] = [
  {
    key: 'auto',
    label: 'Auto',
    icon: 'auto-fix-high',
    filter: [{ brightness: 1.06 }, { contrast: 1.15 }, { saturate: 0.9 }],
    description: 'Optimised for readability',
  },
  {
    key: 'high_contrast',
    label: 'Contrast',
    icon: 'contrast',
    filter: [{ contrast: 2.0 }, { brightness: 1.1 }, { saturate: 0.6 }],
    description: 'Sharp black & white text',
  },
  {
    key: 'black_white',
    label: 'B&W',
    icon: 'filter-b-and-w',
    filter: [{ grayscale: 1 }, { contrast: 1.6 }, { brightness: 1.05 }],
    description: 'Grayscale document',
  },
];

export default function ProcessScanScreen() {
  const router = useRouter();
  const { showLimitError } = useLimitError();
  const { imageUri, returnTo } = useLocalSearchParams<{ imageUri: string; returnTo?: string | string[] }>();
  const guestReturn = returnTo === 'scheduling-guest'
    || (Array.isArray(returnTo) && returnTo[0] === 'scheduling-guest');
  const [uploading, setUploading] = useState(false);
  const [enhancement, setEnhancement] = useState<EnhancementMode>('auto');
  const imageViewRef = useRef<View>(null);

  const activeFilter = FILTER_OPTIONS.find(f => f.key === enhancement)!;

  const handleClose = () => {
    if (uploading) {
      Alert.alert('Upload in progress', 'Please wait for the upload to finish.', [
        { text: 'OK', style: 'cancel' },
      ]);
    } else {
      router.back();
    }
  };

  const saveDocument = async () => {
    if (uploading || !imageUri) return;
    setUploading(true);

    try {
      // Capture the rendered view with CSS filters applied
      let processedUri = imageUri;
      try {
        processedUri = await captureRef(imageViewRef, {
          format: 'jpg',
          quality: 0.92,
          result: 'tmpfile',
        });
      } catch (captureErr) {
        console.warn('View capture failed, using original image:', captureErr);
        processedUri = imageUri;
      }

      // Convert HEIC if needed
      let fileToUpload = {
        uri: processedUri,
        name: `scanned_document_${Date.now()}.jpg`,
        type: 'image/jpeg',
      };
      try {
        const { convertHeicToPng } = await import('../../utils/imageConversion');
        fileToUpload = await convertHeicToPng(fileToUpload);
      } catch {
        // continue with original
      }

      if (guestReturn) {
        try {
          const { getInfoAsync } = await import('expo-file-system/legacy');
          const info = await getInfoAsync(fileToUpload.uri);
          if (info.exists && typeof info.size === 'number' && info.size > 10 * 1024 * 1024) {
            Alert.alert('File too large', 'Each file must be 10 MB or smaller.');
            return;
          }
          const formData = new FormData();
          formData.append('file', {
            uri: fileToUpload.uri,
            type: fileToUpload.type,
            name: fileToUpload.name,
          } as any);
          const { apiClient } = await import('../../services/api');
          const response = await apiClient.uploadFileWithProgressPolling(formData, undefined, {
            filename: fileToUpload.name,
          });
          const fileId = (response as { file?: { id?: number } }).file?.id;
          if (!fileId) {
            Alert.alert('Upload Failed', 'Upload finished without a file.');
            return;
          }
          const { queueGuestFile } = await import('../../utils/schedulingGuestFiles');
          queueGuestFile({ fileId, name: fileToUpload.name });
          if (router.canDismiss()) router.dismiss(2);
          else router.back();
        } catch (error: any) {
          const limitData = extractLimitErrorData(getErrorResponseData(error));
          if (limitData) {
            showLimitError(limitData);
            return;
          }
          Alert.alert('Upload Failed', error?.message || 'Failed to upload document. Please try again.');
        }
        return;
      }

      // Navigate immediately — upload runs in background.
      // Pop scanner (+ this review screen) off the stack first so Back from
      // Files returns to the homepage, not the camera.
      try {
        if (router.canDismiss()) {
          router.dismissAll();
        }
      } catch {
        // dismissAll throws when there is nothing to dismiss
      }
      router.replace('/(tabs)/documents');

      (async () => {
        try {
          const formData = new FormData();
          formData.append('file', {
            uri: fileToUpload.uri,
            type: fileToUpload.type,
            name: fileToUpload.name,
          } as any);

          const { apiClient } = await import('../../services/api');
          await apiClient.uploadFile(formData, (progress) => {
            console.log('Upload progress:', progress);
          });

          const { useFileStore } = await import('../../stores/fileStore');
          const fileStore = useFileStore.getState();
          fileStore.setLastUploadTime(Date.now());
          setTimeout(() => fileStore.fetchFiles(1), 500);
        } catch (error: any) {
          const limitData = extractLimitErrorData(getErrorResponseData(error));
          if (limitData) {
            showLimitError(limitData);
            return;
          }
          Alert.alert('Upload Failed', 'Failed to upload document. Please try again.');
        }
      })();
    } catch (error) {
      console.error('Save error:', error);
      Alert.alert('Error', 'Failed to prepare document. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  if (!imageUri) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centered}>
          <Text style={styles.errorText}>No image provided.</Text>
          <Pressable style={styles.retakeButton} onPress={() => router.back()}>
            <Text style={styles.retakeButtonText}>Go Back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable
          style={styles.headerButton}
          onPress={handleClose}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="close" size={28} color="#fff" />
        </Pressable>
        <AppHeaderTitle style={{ color: '#fff' }}>Review Scan</AppHeaderTitle>
        <Pressable
          style={[styles.saveBtn, uploading && styles.saveBtnDisabled]}
          onPress={saveDocument}
          disabled={uploading}
        >
          {uploading ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <Ionicons name="cloud-upload-outline" size={16} color="#fff" style={{ marginRight: 6 }} />
              <Text style={styles.saveBtnText}>Save</Text>
            </>
          )}
        </Pressable>
      </View>

      {/* Image preview with filter applied */}
      <View
        ref={imageViewRef}
        style={[styles.imageContainer, { filter: activeFilter.filter } as any]}
        collapsable={false}
      >
        <ExpoImage
          source={{ uri: imageUri }}
          style={styles.image}
          contentFit="contain"
          onError={() => {
            Alert.alert('Error', 'Failed to load image. Please try scanning again.', [
              { text: 'OK', onPress: () => router.back() },
            ]);
          }}
        />
      </View>

      {/* Enhancement panel */}
      <View style={styles.panel}>
        <Text style={styles.panelLabel}>Enhancement</Text>
        <View style={styles.filterRow}>
          {FILTER_OPTIONS.map(option => {
            const isActive = enhancement === option.key;
            return (
              <Pressable
                key={option.key}
                style={[styles.filterChip, isActive && styles.filterChipActive]}
                onPress={() => setEnhancement(option.key)}
              >
                <MaterialIcons
                  name={option.icon as any}
                  size={20}
                  color={isActive ? '#fff' : '#aaa'}
                />
                <Text style={[styles.filterChipLabel, isActive && styles.filterChipLabelActive]}>
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.filterDescription}>{activeFilter.description}</Text>

        {/* Retake button */}
        <Pressable style={styles.retakeRow} onPress={() => router.back()}>
          <Ionicons name="camera-outline" size={16} color="#888" style={{ marginRight: 6 }} />
          <Text style={styles.retakeText}>Retake photo</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f0f',
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  errorText: {
    color: '#aaa',
    fontSize: 16,
    marginBottom: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 12,
    backgroundColor: '#0f0f0f',
  },
  headerButton: {
    width: 46,
    height: 46,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 4,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#fff',
    letterSpacing: 0.2,
  },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#007AFF',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    minWidth: 80,
    justifyContent: 'center',
  },
  saveBtnDisabled: {
    backgroundColor: '#555',
  },
  saveBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  imageContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  image: {
    flex: 1,
  },
  panel: {
    backgroundColor: '#1a1a1a',
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: Platform.OS === 'ios' ? 8 : 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#333',
  },
  panelLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#666',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  filterRow: {
    flexDirection: 'row',
    gap: 10,
  },
  filterChip: {
    flex: 1,
    flexDirection: 'column',
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#2a2a2a',
    gap: 6,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  filterChipActive: {
    backgroundColor: '#1c3d6e',
    borderColor: '#007AFF',
  },
  filterChipLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#888',
  },
  filterChipLabelActive: {
    color: '#fff',
  },
  filterDescription: {
    fontSize: 12,
    color: '#555',
    marginTop: 10,
    textAlign: 'center',
  },
  retakeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 14,
    paddingVertical: 4,
  },
  retakeText: {
    fontSize: 13,
    color: '#666',
  },
  retakeButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  retakeButtonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 15,
  },
});

import { Ionicons } from '@expo/vector-icons';
import React, { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import MinimizableBottomSheet from '../../components/MinimizableBottomSheet';
import { useThemeColors } from '../../hooks/useThemeColors';

export type UploadOptionsModalProps = {
  visible: boolean;
  isUploading: boolean;
  onDismiss: () => void;
  onFiles: () => void;
  onCamera: () => void;
  onGallery: () => void;
  onLink: () => void;
  /** Bump on every open so a minimized sheet expands again. */
  expandNonce?: number;
};

/**
 * Upload sheet (Files, Camera, Gallery, Upload by Link) — same on home and Financials.
 */
export function UploadOptionsModal({
  visible,
  isUploading,
  onDismiss,
  onFiles,
  onCamera,
  onGallery,
  onLink,
  expandNonce = 0,
}: UploadOptionsModalProps) {
  const colors = useThemeColors();

  const styles = useMemo(
    () =>
      StyleSheet.create({
        uploadOption: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingVertical: 12,
          paddingHorizontal: 16,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        },
        uploadOptionDisabled: {
          opacity: 0.5,
        },
        uploadOptionIcon: {
          width: 40,
          height: 40,
          borderRadius: 20,
          justifyContent: 'center',
          alignItems: 'center',
          marginRight: 12,
        },
        uploadOptionText: {
          flex: 1,
          marginRight: 10,
        },
        uploadOptionTitle: {
          fontSize: 16,
          fontWeight: '600',
          color: colors.text,
        },
        uploadOptionSubtitle: {
          fontSize: 12,
          color: colors.textSecondary,
          marginTop: 2,
        },
      }),
    [colors]
  );

  return (
    <MinimizableBottomSheet
      visible={visible}
      onClose={onDismiss}
      expandNonce={expandNonce}
      title="Upload"
      fitContent
      heightRatio={0.85}
      minimizedSubtitle="Swipe up to upload"
    >
      <TouchableOpacity
        style={[styles.uploadOption, isUploading && styles.uploadOptionDisabled]}
        onPress={onFiles}
        disabled={isUploading}
      >
        <View style={[styles.uploadOptionIcon, { backgroundColor: '#007AFF' }]}>
          <Ionicons name="document" size={24} color="#fff" />
        </View>
        <View style={styles.uploadOptionText}>
          <Text style={styles.uploadOptionTitle}>Files</Text>
          <Text style={styles.uploadOptionSubtitle}>Upload from your device</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color="#ccc" />
      </TouchableOpacity>

      <TouchableOpacity style={styles.uploadOption} onPress={onCamera}>
        <View style={[styles.uploadOptionIcon, { backgroundColor: '#FF9500' }]}>
          <Ionicons name="camera" size={24} color="#fff" />
        </View>
        <View style={styles.uploadOptionText}>
          <Text style={styles.uploadOptionTitle}>Camera</Text>
          <Text style={styles.uploadOptionSubtitle}>Take a photo or scan document</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color="#ccc" />
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.uploadOption, isUploading && styles.uploadOptionDisabled]}
        onPress={onGallery}
        disabled={isUploading}
      >
        <View style={[styles.uploadOptionIcon, { backgroundColor: '#5856D6' }]}>
          <Ionicons name="images" size={24} color="#fff" />
        </View>
        <View style={styles.uploadOptionText}>
          <Text style={styles.uploadOptionTitle}>Images Gallery</Text>
          <Text style={styles.uploadOptionSubtitle}>Upload from your photo gallery</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color="#ccc" />
      </TouchableOpacity>

      <TouchableOpacity style={styles.uploadOption} onPress={onLink}>
        <View style={[styles.uploadOptionIcon, { backgroundColor: '#34C759' }]}>
          <Ionicons name="link" size={24} color="#fff" />
        </View>
        <View style={styles.uploadOptionText}>
          <Text style={styles.uploadOptionTitle}>Upload by Link</Text>
          <Text style={styles.uploadOptionSubtitle}>Upload using an upload code</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color="#ccc" />
      </TouchableOpacity>
    </MinimizableBottomSheet>
  );
}

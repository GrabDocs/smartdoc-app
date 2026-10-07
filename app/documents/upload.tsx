import { MaterialIcons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AppHeaderTitle from '../../components/AppHeaderTitle';
import { useLimitError } from '../../contexts/LimitErrorContext';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiService } from '../../services/api';
import { extractLimitErrorData, getErrorResponseData } from '../../utils/limitErrorUtils';

export default function UploadScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { showLimitError } = useLimitError();
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  const handleClose = () => {
    if (uploading) {
      Alert.alert('Upload in Progress', 'Upload is in progress. Are you sure you want to cancel?', [
        { text: 'Continue Upload', style: 'cancel' },
        { text: 'Cancel Upload', style: 'destructive', onPress: () => router.back() }
      ]);
    } else {
      router.back();
    }
  };

  const handleUpload = async () => {
    const { useFileStore } = require('../../stores/fileStore');
    const fileStore = useFileStore.getState();
    
    if (fileStore.isDocumentPickerOpen) {
      console.log('Document picker already in progress, ignoring request');
      return;
    }
    
    try {
      fileStore.setDocumentPickerOpen(true);
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'image/*', 'application/msword',
               'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
        multiple: true,
      });

      if (result.canceled) {
        fileStore.setDocumentPickerOpen(false);
        return;
      }

      // Check mobile file limit (3 files max)
      const isMobile = Platform.OS === 'ios' || Platform.OS === 'android';
      if (isMobile && result.assets.length > 3) {
        Alert.alert(
          'Upload Limit',
          'Sorry, our maximum upload is 3',
          [{ text: 'OK' }]
        );
        fileStore.setDocumentPickerOpen(false);
        return;
      }

      setUploading(true);

      let successCount = 0;
      let failCount = 0;

      // Process each selected file
      for (const file of result.assets) {
        try {
          console.log('Uploading file:', file.name, file.uri);
          
          // Convert HEIC to PNG before upload if needed
          let fileToUpload = {
            uri: file.uri,
            name: file.name || 'unnamed_file',
            type: file.mimeType || 'application/octet-stream',
            size: file.size,
          };

          try {
            const { convertHeicToPng } = await import('../../utils/imageConversion');
            fileToUpload = await convertHeicToPng(fileToUpload, (progress, message) => {
              // Show conversion progress (0-10% of total)
              setProgress(progress * 0.1);
              console.log(`🔄 Conversion progress: ${progress}% - ${message}`);
            });
          } catch (conversionError) {
            console.warn('HEIC conversion failed, continuing with original:', conversionError);
          }
          
          // Upload file using hybrid method (chunked for large files >= 5MB, retry for small)
          // Automatically handles network resilience, resume, and retry
          const uploadResult = await apiService.uploadFileHybrid(
            {
              uri: fileToUpload.uri,
              name: fileToUpload.name,
              type: fileToUpload.type,
              size: fileToUpload.size
            },
            undefined, // workspaceId
            undefined, // signal (can add abort controller here)
            (progress, message, phase) => {
              // Scale server progress to 10-100% (conversion was 0-10%)
              setProgress(10 + (progress * 0.9));
              console.log(`📊 Upload progress: ${progress}% - ${message} (${phase})`);
            },
            () => {
              // onPause callback
              console.log('⏸️ Upload paused');
            },
            () => {
              // onResume callback
              console.log('▶️ Upload resumed');
            }
          );

          if (uploadResult.success) {
            const limitData = extractLimitErrorData(uploadResult);
            if (limitData) {
              showLimitError(limitData);
              setUploading(false);
              setProgress(0);
              fileStore.setDocumentPickerOpen(false);
              return;
            }
            successCount++;
            console.log('Upload successful:', uploadResult);
          } else {
            const limitData = extractLimitErrorData(uploadResult);
            if (limitData) {
              showLimitError(limitData);
              setUploading(false);
              setProgress(0);
              fileStore.setDocumentPickerOpen(false);
              return;
            }
            failCount++;
            console.error('Upload failed for:', file.name, uploadResult);
          }

        } catch (error: any) {
          const limitData = extractLimitErrorData(getErrorResponseData(error));
          if (limitData) {
            showLimitError(limitData);
            setUploading(false);
            setProgress(0);
            fileStore.setDocumentPickerOpen(false);
            return;
          }
          failCount++;
          console.error('Error uploading file:', file.name, error);
        }
      }

      // Show appropriate message based on results
      if (successCount > 0 && failCount === 0) {
        Alert.alert('Success', `All ${successCount} document${successCount !== 1 ? 's' : ''} uploaded successfully!`, [
          { text: 'OK', onPress: () => router.replace('/(tabs)/documents') }
        ]);
      } else if (successCount > 0 && failCount > 0) {
        Alert.alert('Partial Success', `${successCount} file${successCount !== 1 ? 's' : ''} uploaded, ${failCount} failed.`, [
          { text: 'OK', onPress: () => router.replace('/(tabs)/documents') }
        ]);
      } else {
        Alert.alert('Upload Failed', 'Failed to upload documents. Please try again.');
      }
    } catch (error: any) {
      const limitData = extractLimitErrorData(getErrorResponseData(error));
      if (limitData) {
        showLimitError(limitData);
        return;
      }
      console.error('Error picking document:', error);
      Alert.alert('Error', 'Failed to upload documents. Please try again.');
    } finally {
      setUploading(false);
      setProgress(0);
      fileStore.setDocumentPickerOpen(false);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { backgroundColor: colors.headerBackground, borderBottomColor: colors.border }]}>
        <Pressable
          onPress={handleClose}
          style={styles.closeButton}
          accessibilityLabel="Close"
          accessibilityRole="button"
        >
          <MaterialIcons name="close" size={24} color="#007AFF" />
        </Pressable>
        <AppHeaderTitle>Upload Documents</AppHeaderTitle>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.content}>
        <Pressable
          style={[styles.uploadArea, uploading && styles.uploadAreaDisabled]}
          onPress={handleUpload}
          disabled={uploading}
          accessibilityLabel={uploading ? `Uploading, ${progress}%` : 'Select documents to upload'}
          accessibilityRole="button"
        >
          {uploading ? (
            <View style={styles.uploadingContainer}>
              <ActivityIndicator size="large" color="#007AFF" />
              <Text style={styles.uploadingText}>Uploading... {progress}%</Text>
              <Text style={styles.uploadSubtext}>Please don&apos;t close this screen</Text>
            </View>
          ) : (
            <>
              <MaterialIcons name="cloud-upload" size={64} color="#007AFF" />
              <Text style={styles.uploadText}>Tap to select documents</Text>
              <Text style={styles.supportedFormats}>
                Supported formats: PDF, Images, Word documents
              </Text>
              <Text style={styles.hint}>
                You can select multiple files at once
              </Text>
            </>
          )}
        </Pressable>
        
        {!uploading && (
          <Pressable
            style={styles.cancelButton}
            onPress={handleClose}
            accessibilityLabel="Cancel"
            accessibilityRole="button"
          >
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f0f0f0',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  closeButton: {
    marginRight: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#333',
  },
  headerSpacer: {
    flex: 1,
  },
  content: {
    flex: 1,
    padding: 16,
  },
  uploadArea: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#007AFF',
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  uploadAreaDisabled: {
    borderColor: '#ccc',
    backgroundColor: '#f8f8f8',
  },
  uploadText: {
    fontSize: 18,
    color: '#007AFF',
    marginTop: 16,
  },
  supportedFormats: {
    fontSize: 14,
    color: '#666',
    marginTop: 8,
    textAlign: 'center',
  },
  uploadingContainer: {
    alignItems: 'center',
  },
  uploadingText: {
    fontSize: 16,
    color: '#666',
    marginTop: 16,
  },
  uploadSubtext: {
    fontSize: 14,
    color: '#666',
    marginTop: 8,
    textAlign: 'center',
  },
  hint: {
    fontSize: 14,
    color: '#666',
    marginTop: 8,
    textAlign: 'center',
  },
  cancelButton: {
    backgroundColor: '#007AFF',
    padding: 16,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 16,
  },
  cancelButtonText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#fff',
  },
}); 
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FeedbackTouchable } from '../components/FeedbackTouchable';
import { API_BASE_URL } from '../constants/Config';
import { useLimitError } from '../contexts/LimitErrorContext';
import { useThemeColors } from '../hooks/useThemeColors';
import { useFileStore } from '../stores/fileStore';
import { extractLimitErrorData } from '../utils/limitErrorUtils';
import { sanitizeDisplayFilename } from '../utils/displayFilename';
import {
  getRemainingUploadSlots,
  getUploadLinkErrorMessage,
  type UploadLinkErrorPayload,
} from '../utils/uploadLinkErrors';
import {
  assertUploadAllowedForCurrentNetwork,
  WIFI_ONLY_UPLOAD_MESSAGE,
} from '../utils/wifiOnlyUpload';
import {
  getUserPreferences,
  validateFileAgainstUploadSettings,
} from '../utils/userPreferences';

import AppBackButton from '../components/AppBackButton';
import AppHeaderTitle from '../components/AppHeaderTitle';

interface IntakeChecklistItem {
  label: string;
  description: string | null;
  required: boolean;
  status: 'pending' | 'matched' | 'confirmed' | 'not_applicable';
}

interface UploadLinkInfo {
  name: string;
  description: string;
  current_uploads: number;
  max_uploads: number | null;
  remaining_uploads: number | null;
  is_full: boolean;
  expires_at: string | null;
  company_id?: number;
  /** Present only when this File Request link belongs to an Intake (client document checklist). */
  intake: { id: number; title: string; checklist: IntakeChecklistItem[] } | null;
}

interface UploadFile {
  uri: string;
  name: string;
  size: number;
  type: string;
}

type UploadPostResult = {
  ok: boolean;
  status: number;
  data: {
    success?: boolean;
    message?: string;
    uploaded_files?: Array<{ filename?: string; id?: number } | string>;
    failed_files?: Array<{ filename?: string; error?: string }>;
    errors?: string[];
    auth_required?: boolean;
    error_code?: string;
  } & UploadLinkErrorPayload;
};

/** POST multipart with upload progress (fetch has no upload progress on RN). */
function postFormDataWithProgress(
  url: string,
  formData: FormData,
  onProgress?: (percent: number) => void,
): Promise<UploadPostResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.onload = () => {
      let data: UploadPostResult['data'] = {};
      try {
        data = JSON.parse(xhr.responseText || '{}');
      } catch {
        data = { message: `Server returned non-JSON response. Status: ${xhr.status}` };
      }
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        data,
      });
    };
    xhr.onerror = () => reject(new Error('Network request failed'));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) {
          onProgress(Math.round((event.loaded * 100) / event.total));
        }
      };
    }
    xhr.send(formData);
  });
}

export default function UploadByLinkScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const router = useRouter();
  const colors = useThemeColors();
  const { showLimitError } = useLimitError();
  const [uploadInfo, setUploadInfo] = useState<UploadLinkInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<UploadFile[]>([]);
  const [uploadProgress, setUploadProgress] = useState<{ [key: string]: number }>({});
  const [refreshing, setRefreshing] = useState(false);

  // Form fields
  const [senderName, setSenderName] = useState('');
  const [senderEmail, setSenderEmail] = useState('');
  const [message, setMessage] = useState('');
  const [actionCode, setActionCode] = useState('');

  const loadUploadInfo = useCallback(async () => {
    if (!token) return;
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/web/upload-to/${encodeURIComponent(token)}`);
      let data: {
        success?: boolean;
        upload_link?: Record<string, any>;
      } & UploadLinkErrorPayload = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }

      if (response.ok && data.success && data.upload_link) {
        const raw = data.upload_link;
        const current = raw.upload_count ?? raw.current_uploads ?? 0;
        const maxUploads = raw.max_uploads ?? null;
        const remaining =
          raw.remaining_uploads ??
          (maxUploads != null ? Math.max(0, maxUploads - current) : null);
        setUploadInfo({
          name: raw.link_name ?? raw.name ?? 'File Request',
          description: raw.description ?? '',
          current_uploads: current,
          max_uploads: maxUploads,
          remaining_uploads: remaining,
          is_full: Boolean(raw.is_full) || remaining === 0,
          expires_at: raw.expires_at ?? null,
          company_id: raw.company_id,
          intake: raw.intake ?? null,
        });
      } else {
        Alert.alert(
          'Error',
          getUploadLinkErrorMessage(data, 'Invalid or expired upload link'),
          [{ text: 'OK', onPress: () => router.back() }],
        );
        setUploadInfo(null);
      }
    } catch (error) {
      console.error('Failed to load upload info:', error);
      Alert.alert('Error', 'Failed to load upload information', [
        { text: 'OK', onPress: () => router.back() },
      ]);
      setUploadInfo(null);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token, router]);

  useEffect(() => {
    if (token) {
      void loadUploadInfo();
    }
  }, [token, loadUploadInfo]);

  const handleRefresh = () => {
    setRefreshing(true);
    void loadUploadInfo();
  };

  const selectFiles = async () => {
    if (uploading) return;
    const fileStore = useFileStore.getState();

    // Reset stuck picker lock from a prior attempt before opening again.
    if (fileStore.isDocumentPickerOpen) {
      await fileStore.forceResetDocumentPicker();
    }

    try {
      fileStore.setDocumentPickerOpen(true);
      const result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        type: '*/*',
        copyToCacheDirectory: true,
      });

      if (!result.canceled && result.assets) {
        const blockedExtensions = new Set([
          'zip', 'rar', '7z', 'tar', 'gz', 'bz2',
          'mp4', 'avi', 'mov', 'mkv', 'flv', 'wmv', 'webm', 'mpeg', 'mpg', 'm4v', '3gp',
          'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'aiff', 'ape', 'opus',
        ]);
        const newFiles: UploadFile[] = result.assets.map((asset) => ({
          uri: asset.uri,
          name: asset.name,
          size: asset.size || 0,
          type: asset.mimeType || 'application/octet-stream',
        }));

        const validationErrors: string[] = [];
        for (const file of newFiles) {
          const ext = (file.name.split('.').pop() || '').toLowerCase();
          if (ext && blockedExtensions.has(ext)) {
            validationErrors.push(
              `${sanitizeDisplayFilename(file.name)}: .${ext} is not allowed (ZIP, audio, and video are blocked).`,
            );
          }
        }
        if (validationErrors.length > 0) {
          Alert.alert(
            'Invalid files',
            `No files were added. Fix these issues and select again:\n\n${validationErrors.join('\n')}`,
          );
          return;
        }

        const remaining = getRemainingUploadSlots(uploadInfo ?? {});
        if (remaining != null && selectedFiles.length + newFiles.length > remaining) {
          Alert.alert(
            'Upload Limit',
            remaining === 0
              ? 'This upload link has reached its file limit.'
              : remaining === 1
                ? 'This link accepts only 1 more file. Please select a single file.'
                : `This link only accepts ${remaining} more file(s). Please select fewer files.`,
          );
          return;
        }

        setSelectedFiles((prev) => [...prev, ...newFiles]);
      }
    } catch (error) {
      console.error('Failed to select files:', error);
      Alert.alert('Error', 'Failed to select files');
    } finally {
      useFileStore.getState().setDocumentPickerOpen(false);
    }
  };

  const removeFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const uploadFiles = async () => {
    if (!uploadInfo || !token) return;

    if (selectedFiles.length === 0) {
      Alert.alert('Error', 'Please select files to upload');
      return;
    }

    if (!senderName.trim()) {
      Alert.alert('Error', 'Please enter your name');
      return;
    }

    const remaining = getRemainingUploadSlots(uploadInfo);
    if (uploadInfo.is_full || remaining === 0) {
      Alert.alert('Upload Limit', 'This upload link has reached its file limit.');
      return;
    }
    if (remaining != null && selectedFiles.length > remaining) {
      Alert.alert(
        'Upload Limit',
        remaining === 1
          ? 'This link accepts only 1 more file. Please remove extra files before uploading.'
          : `This link accepts only ${remaining} more file(s). Please remove extra files before uploading.`,
      );
      return;
    }

    try {
      await assertUploadAllowedForCurrentNetwork();
      const prefs = await getUserPreferences();
      for (const f of selectedFiles) {
        validateFileAgainstUploadSettings(
          { name: f.name, size: f.size, type: f.type },
          prefs,
        );
      }
    } catch (error: any) {
      const msg = error?.message || WIFI_ONLY_UPLOAD_MESSAGE;
      Alert.alert(
        msg.includes('Wi‑Fi') || msg.includes('Wi-Fi') ? 'Wi‑Fi Required' : 'Upload Blocked',
        msg,
      );
      return;
    }

    setUploading(true);
    setUploadProgress({ overall: 0 });

    try {
      const preparedFiles: UploadFile[] = [];
      for (let i = 0; i < selectedFiles.length; i++) {
        let file = selectedFiles[i];
        try {
          const { convertHeicToPng } = await import('../utils/imageConversion');
          const converted = await convertHeicToPng(file, (progress) => {
            // HEIC prep is a small slice before the network upload.
            const prepShare = ((i + progress / 100) / selectedFiles.length) * 10;
            setUploadProgress({ overall: Math.round(prepShare) });
          });
          file = {
            uri: converted.uri,
            name: converted.name,
            type: converted.type,
            size: converted.size ?? file.size,
          };
        } catch (conversionError) {
          console.warn('HEIC conversion failed, continuing with original:', conversionError);
        }
        preparedFiles.push(file);
      }

      const formData = new FormData();
      for (const file of preparedFiles) {
        formData.append('files', {
          uri: file.uri,
          name: file.name,
          type: file.type,
        } as any);
      }
      formData.append('sender_name', senderName.trim());
      if (senderEmail.trim()) {
        formData.append('sender_email', senderEmail.trim());
      }
      if (message.trim()) {
        formData.append('sender_message', message.trim());
      }
      if (actionCode.trim()) {
        formData.append('action_code', actionCode.trim());
      }

      const uploadUrl = `${API_BASE_URL}/api/v1/web/upload-to/${encodeURIComponent(token)}`;
      const result = await postFormDataWithProgress(uploadUrl, formData, (percent) => {
        // Map network upload into 10–100% after prep.
        setUploadProgress({ overall: Math.min(100, 10 + Math.round(percent * 0.9)) });
      });

      if (result.data.auth_required || result.status === 401) {
        Alert.alert(
          'Sign in required',
          getUploadLinkErrorMessage(result.data, 'This upload link requires you to sign in before uploading.'),
        );
        return;
      }

      const limitData = extractLimitErrorData(result.data);
      if (limitData) {
        showLimitError(limitData);
        return;
      }

      if (!result.ok || !result.data.success) {
        const failed = result.data.failed_files ?? [];
        const detail = failed
          .map((f) =>
            typeof f === 'string'
              ? f
              : `${sanitizeDisplayFilename(f.filename || 'file')}: ${f.error || 'failed'}`,
          )
          .join('\n');
        Alert.alert(
          result.data.validation_failed ? 'Upload rejected' : 'Upload Error',
          detail
            ? `${getUploadLinkErrorMessage(result.data, result.data.message || 'Upload failed')}\n\n${detail}`
            : getUploadLinkErrorMessage(result.data, result.data.message || 'Upload failed'),
        );
        return;
      }

      const uploaded = result.data.uploaded_files ?? [];
      const failed = result.data.failed_files ?? [];
      const uploadedCount = uploaded.length;
      const remainingAfter =
        typeof result.data.remaining_uploads === 'number'
          ? result.data.remaining_uploads
          : null;
      setUploadProgress({ overall: 100 });

      const finishOk = () => {
        setSelectedFiles([]);
        setUploadProgress({});
        setSenderName('');
        setSenderEmail('');
        setMessage('');
        setActionCode('');
        void loadUploadInfo();
      };

      if (failed.length > 0 && uploadedCount === 0) {
        const detail = failed
          .map((f) =>
            typeof f === 'string'
              ? f
              : `${sanitizeDisplayFilename(f.filename || 'file')}: ${f.error || 'failed'}`,
          )
          .join('\n');
        Alert.alert('Upload Failed', detail || 'No files were uploaded.');
        return;
      }

      if (failed.length > 0) {
        const detail = failed
          .map((f) =>
            typeof f === 'string'
              ? f
              : `${sanitizeDisplayFilename(f.filename || 'file')}: ${f.error || 'failed'}`,
          )
          .join('\n');
        const remainingNote =
          remainingAfter != null && remainingAfter > 0
            ? `\n\nThis link accepts ${remainingAfter} more file${remainingAfter === 1 ? '' : 's'}. Retry only the failed ones.`
            : '\n\nSuccessful files were kept; retry only the failed ones.';
        Alert.alert(
          'Partially uploaded',
          `Uploaded ${uploadedCount} of ${uploadedCount + failed.length} file(s).${remainingNote}\n\nFailed:\n${detail}`,
          [{ text: 'OK', onPress: finishOk }],
        );
        return;
      }

      Alert.alert(
        'Success',
        uploadedCount > 0
          ? `Successfully uploaded ${uploadedCount} file(s). Processing will continue in the background.`
          : result.data.message || 'Files uploaded successfully!',
        [{ text: 'OK', onPress: finishOk }],
      );
    } catch (error: any) {
      console.error('Upload failed:', error);
      Alert.alert('Error', error?.message || 'Failed to upload files');
    } finally {
      setUploading(false);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatExpiryDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffInHours = Math.floor((date.getTime() - now.getTime()) / (1000 * 60 * 60));

    if (diffInHours < 1) return 'Expires soon';
    if (diffInHours < 24) return `Expires in ${diffInHours} hours`;

    const diffInDays = Math.floor(diffInHours / 24);
    return `Expires in ${diffInDays} day${diffInDays !== 1 ? 's' : ''}`;
  };

  const getFileIcon = (fileName: string, fileKind?: string) => {
    if (fileKind) {
      const kind = fileKind.toLowerCase();
      if (kind.includes('receipt')) return 'receipt-outline';
      if (kind.includes('invoice')) return 'document-text-outline';
      if (kind.includes('form')) return 'clipboard-outline';
    }
    
    const extension = fileName.split('.').pop()?.toLowerCase();
    switch (extension) {
      case 'pdf':
        return 'document-text';
      case 'jpg':
      case 'jpeg':
      case 'png':
      case 'gif':
      case 'heic':
      case 'heif':
        return 'image';
      case 'mp4':
      case 'avi':
      case 'mov':
        return 'videocam';
      case 'mp3':
      case 'wav':
        return 'musical-notes';
      case 'doc':
      case 'docx':
        return 'document';
      case 'xls':
      case 'xlsx':
        return 'grid';
      case 'zip':
      case 'rar':
        return 'archive';
      default:
        return 'document-outline';
    }
  };


  const dynamicStyles = StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingVertical: 16,
      backgroundColor: colors.headerBackground,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    headerTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: colors.text,
    },
    headerSubtitle: {
      fontSize: 12,
      color: colors.textSecondary,
      marginTop: 2,
    },
    content: {
      flex: 1,
      padding: 12,
    },
    infoCard: {
      backgroundColor: colors.card,
      borderRadius: 8,
      padding: 12,
      marginBottom: 12,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.05,
      shadowRadius: 2,
      elevation: 1,
    },
    infoStats: {
      flexDirection: 'row',
    },
    statItem: {
      flex: 1,
    },
    statLabel: {
      fontSize: 11,
      color: colors.textSecondary,
      marginBottom: 2,
    },
    statValue: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.text,
    },
    section: {
      backgroundColor: colors.card,
      borderRadius: 8,
      padding: 12,
      marginBottom: 12,
    },
    sectionTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.text,
      marginBottom: 12,
    },
    inputGroup: {
      marginBottom: 12,
    },
    label: {
      fontSize: 13,
      fontWeight: '500',
      color: colors.text,
      marginBottom: 6,
    },
    input: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 12,
      fontSize: 16,
      color: colors.text,
    },
    textArea: {
      height: 80,
      textAlignVertical: 'top',
    },
    selectButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: '#E3F2FD',
      borderRadius: 6,
      paddingVertical: 12,
      borderWidth: 2,
      borderColor: '#007AFF',
      borderStyle: 'dashed',
    },
    selectButtonText: {
      fontSize: 14,
      color: '#007AFF',
      fontWeight: '500',
      marginLeft: 6,
    },
    fileItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    fileIcon: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: '#E3F2FD',
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 12,
    },
    fileInfo: {
      flex: 1,
    },
    fileName: {
      fontSize: 13,
      fontWeight: '500',
      color: colors.text,
      marginBottom: 2,
    },
    fileSize: {
      fontSize: 11,
      color: colors.textSecondary,
    },
    progressContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: 8,
    },
    progressBar: {
      flex: 1,
      height: 4,
      backgroundColor: colors.border,
      borderRadius: 2,
      marginRight: 8,
    },
    progressFill: {
      height: '100%',
      backgroundColor: '#007AFF',
      borderRadius: 2,
    },
    progressText: {
      fontSize: 10,
      color: colors.textSecondary,
      minWidth: 30,
    },
    removeButton: {
      padding: 4,
    },
    uploadContainer: {
      paddingTop: 16,
    },
    uploadButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: '#007AFF',
      borderRadius: 8,
      paddingVertical: 16,
    },
    uploadButtonDisabled: {
      backgroundColor: colors.border,
    },
    uploadButtonText: {
      fontSize: 14,
      color: '#fff',
      fontWeight: '600',
      marginLeft: 6,
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    loadingText: {
      marginTop: 16,
      fontSize: 16,
      color: colors.textSecondary,
    },
    errorContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 40,
    },
    errorText: {
      fontSize: 18,
      fontWeight: '600',
      color: colors.textSecondary,
      marginTop: 16,
      textAlign: 'center',
    },
    backButton: {
      marginTop: 24,
      paddingHorizontal: 24,
      paddingVertical: 12,
      backgroundColor: '#007AFF',
      borderRadius: 8,
    },
    backButtonText: {
      color: '#fff',
      fontSize: 16,
      fontWeight: '600',
    },
    checklistItem: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    checklistIcon: {
      marginRight: 10,
      marginTop: 1,
    },
    checklistTextCol: {
      flex: 1,
    },
    checklistLabel: {
      fontSize: 13,
      fontWeight: '500',
      color: colors.text,
    },
    checklistLabelDone: {
      textDecorationLine: 'line-through',
      color: colors.textSecondary,
    },
    checklistOptional: {
      fontSize: 11,
      color: colors.textLight,
    },
    checklistDescription: {
      fontSize: 11,
      color: colors.textSecondary,
      marginTop: 2,
    },
  });

  if (loading) {
    return (
      <SafeAreaView style={dynamicStyles.container}>
        <View style={dynamicStyles.loadingContainer}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={dynamicStyles.loadingText}>Loading upload information...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!uploadInfo) {
    return (
      <SafeAreaView style={dynamicStyles.container}>
        <View style={dynamicStyles.errorContainer}>
          <Ionicons name="alert-circle" size={64} color="#FF3B30" />
          <Text style={dynamicStyles.errorText}>Upload link not available</Text>
          <TouchableOpacity style={dynamicStyles.backButton} onPress={() => router.back()}>
            <Text style={dynamicStyles.backButtonText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={dynamicStyles.container}>
      <View style={dynamicStyles.header}>
        <AppBackButton />
        <View style={{ flex: 1, marginLeft: 12 }}>
          <AppHeaderTitle>Upload Files</AppHeaderTitle>
          {uploadInfo && (
            <Text style={dynamicStyles.headerSubtitle}>Upload to: {uploadInfo.name}</Text>
          )}
        </View>
        <Ionicons name="cloud-upload" size={28} color="#007AFF" />
      </View>

      <ScrollView
          style={dynamicStyles.content}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#007AFF" />
          }
        >
          {/* Upload Info */}
          <View style={dynamicStyles.infoCard}>
            <View style={dynamicStyles.infoStats}>
              <View style={dynamicStyles.statItem}>
                <Text style={dynamicStyles.statLabel}>Uploads</Text>
                <Text style={dynamicStyles.statValue}>
                  {uploadInfo.current_uploads}
                  {uploadInfo.max_uploads != null && ` / ${uploadInfo.max_uploads}`}
                </Text>
              </View>
              {uploadInfo.expires_at && (
                <View style={dynamicStyles.statItem}>
                  <Text style={dynamicStyles.statLabel}>Expires</Text>
                  <Text style={dynamicStyles.statValue}>
                    {formatExpiryDate(uploadInfo.expires_at)}
                  </Text>
                </View>
              )}
            </View>
            {uploadInfo.is_full ? (
              <Text style={{ marginTop: 10, fontSize: 13, color: '#FF3B30', fontWeight: '500' }}>
                This upload link has reached its file limit.
              </Text>
            ) : getRemainingUploadSlots(uploadInfo) != null ? (
              <Text style={{ marginTop: 10, fontSize: 12, color: colors.textSecondary }}>
                {getRemainingUploadSlots(uploadInfo)} file(s) remaining
              </Text>
            ) : null}
          </View>

          {/* Intake checklist — only present when this link belongs to an Intake */}
          {uploadInfo.intake && uploadInfo.intake.checklist.length > 0 && (
            <View style={dynamicStyles.section}>
              <Text style={dynamicStyles.sectionTitle}>Documents needed for &quot;{uploadInfo.intake.title}&quot;</Text>
              {uploadInfo.intake.checklist.map((item, idx) => {
                const done = item.status === 'confirmed' || item.status === 'matched' || item.status === 'not_applicable';
                const icon =
                  item.status === 'confirmed'
                    ? 'checkmark-circle'
                    : item.status === 'matched'
                    ? 'checkmark-circle-outline'
                    : item.status === 'not_applicable'
                    ? 'remove-circle-outline'
                    : 'ellipse-outline';
                const iconColor =
                  item.status === 'confirmed'
                    ? '#34C759'
                    : item.status === 'matched'
                    ? '#007AFF'
                    : item.status === 'not_applicable'
                    ? colors.textLight
                    : colors.textLight;
                return (
                  <View key={`${item.label}-${idx}`} style={dynamicStyles.checklistItem}>
                    <Ionicons name={icon as any} size={18} color={iconColor} style={dynamicStyles.checklistIcon} />
                    <View style={dynamicStyles.checklistTextCol}>
                      <Text style={[dynamicStyles.checklistLabel, done && dynamicStyles.checklistLabelDone]}>
                        {item.label}
                        {!item.required && <Text style={dynamicStyles.checklistOptional}> (optional)</Text>}
                      </Text>
                      {item.description && <Text style={dynamicStyles.checklistDescription}>{item.description}</Text>}
                    </View>
                  </View>
                );
              })}
            </View>
          )}

          {/* Sender Information */}
          <View style={dynamicStyles.section}>
            <Text style={dynamicStyles.sectionTitle}>Your Information</Text>
            <View style={dynamicStyles.inputGroup}>
              <Text style={dynamicStyles.label}>Your Name *</Text>
              <TextInput
                style={dynamicStyles.input}
                value={senderName}
                onChangeText={setSenderName}
                placeholder="Enter your name"
                placeholderTextColor={colors.textLight}
                editable={!uploading}
              />
            </View>
            <View style={dynamicStyles.inputGroup}>
              <Text style={dynamicStyles.label}>Your Email</Text>
              <TextInput
                style={dynamicStyles.input}
                value={senderEmail}
                onChangeText={setSenderEmail}
                placeholder="Enter your email"
                placeholderTextColor={colors.textLight}
                keyboardType="email-address"
                autoCapitalize="none"
                editable={!uploading}
              />
            </View>
            <View style={dynamicStyles.inputGroup}>
              <Text style={dynamicStyles.label}>Action Code</Text>
              <TextInput
                style={dynamicStyles.input}
                value={actionCode}
                onChangeText={setActionCode}
                placeholder="Enter action code"
                placeholderTextColor={colors.textLight}
                autoCapitalize="none"
                editable={!uploading}
              />
            </View>
            <View style={dynamicStyles.inputGroup}>
              <Text style={dynamicStyles.label}>Message</Text>
              <TextInput
                style={[dynamicStyles.input, dynamicStyles.textArea]}
                value={message}
                onChangeText={setMessage}
                placeholder="Add any additional message or comments..."
                placeholderTextColor={colors.textLight}
                multiline
                numberOfLines={4}
                editable={!uploading}
              />
            </View>
          </View>

          {/* File Selection */}
          {!uploadInfo.is_full && (
            <View style={dynamicStyles.section}>
              <Text style={dynamicStyles.sectionTitle}>Select Files</Text>
              <TouchableOpacity
                style={dynamicStyles.selectButton}
                onPress={() => void selectFiles()}
                disabled={uploading}
              >
                <Ionicons name="add-circle" size={24} color="#007AFF" />
                <Text style={dynamicStyles.selectButtonText}>Choose Files</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Selected Files */}
          {selectedFiles.length > 0 && (
            <View style={dynamicStyles.section}>
              <Text style={dynamicStyles.sectionTitle}>
                Selected Files ({selectedFiles.length})
              </Text>
              {selectedFiles.map((file, index) => (
                <View key={`file-${file.name}-${index}`} style={dynamicStyles.fileItem}>
                  <View style={dynamicStyles.fileIcon}>
                    <Ionicons name={getFileIcon(file.name) as any} size={20} color="#007AFF" />
                  </View>
                  <View style={dynamicStyles.fileInfo}>
                    <Text style={dynamicStyles.fileName}>{file.name}</Text>
                    <Text style={dynamicStyles.fileSize}>{formatFileSize(file.size)}</Text>
                  </View>
                  {!uploading && (
                    <TouchableOpacity
                      style={dynamicStyles.removeButton}
                      onPress={() => removeFile(index)}
                    >
                      <Ionicons name="close-circle" size={20} color="#FF3B30" />
                    </TouchableOpacity>
                  )}
                </View>
              ))}
              {uploading && (
                <View style={[dynamicStyles.progressContainer, { marginTop: 12 }]}>
                  <View style={dynamicStyles.progressBar}>
                    <View
                      style={[
                        dynamicStyles.progressFill,
                        { width: `${uploadProgress.overall || 0}%` },
                      ]}
                    />
                  </View>
                  <Text style={dynamicStyles.progressText}>
                    {Math.round(uploadProgress.overall || 0)}%
                  </Text>
                </View>
              )}
            </View>
          )}

          {/* Upload Button */}
          {selectedFiles.length > 0 && !uploadInfo.is_full && (
            <View style={dynamicStyles.uploadContainer}>
              <FeedbackTouchable
                style={[dynamicStyles.uploadButton, uploading && dynamicStyles.uploadButtonDisabled]}
                onPress={uploadFiles}
                disabled={uploading}
                loading={uploading}
                spinnerColor="#fff"
                replaceWithSpinner={false}
              >
                {uploading ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Ionicons name="cloud-upload" size={20} color="#fff" />
                )}
                <Text style={dynamicStyles.uploadButtonText}>
                  {uploading
                    ? 'Uploading...'
                    : `Upload ${selectedFiles.length} File${selectedFiles.length !== 1 ? 's' : ''}`}
                </Text>
              </FeedbackTouchable>
            </View>
          )}
        </ScrollView>
    </SafeAreaView>
  );
}

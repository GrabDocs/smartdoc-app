import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Clipboard,
  FlatList,
  Keyboard,
  Modal,
  Platform,
  RefreshControl,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import DocumentViewer from '../../components/DocumentViewer';
import ClientsButton from '../../components/clients/ClientsButton';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import FileNameText from '../../components/FileNameText';
import { FRONTEND_URL } from '../../constants/Config';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiService } from '../../services/api';
import { uploadLinkDetailScreenKey, uploadLinksListScreenKey } from '../../services/userScopedCache';
import { sanitizeDisplayFilename } from '../../utils/displayFilename';
import { screenCache } from '../../utils/screenCache';
import { getUploadToBaseUrl } from '../../utils/uploadLinkHelpers';
import { useAuth } from '../context/auth';

import AppBackButton from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';

interface UploadLink {
  id: number;
  name: string;
  description?: string;
  token: string;
  is_active: boolean;
  expires_at?: string;
  created_at: string;
  upload_count: number;
  max_uploads?: number;
  url: string;
  upload_code?: string | null;
  uploaded_files: UploadedFile[];
}

interface UploadedFile {
  id: number;
  file_id?: number; // File ID from the files table
  filename: string;
  original_filename?: string;
  file_size: number;
  file_type?: string; // Optional - may not be in backend response
  file_kind?: string; // Optional - may not be in backend response
  upload_date?: string; // Optional - backend uses created_at instead
  created_at?: string; // Main date field from backend
  status?: string;
  sender_info?: any;
}

const UPLOAD_LINK_DETAIL_CACHE_MS = 30_000;

export default function UploadLinkDetailsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams();
  const [uploadLink, setUploadLink] = useState<UploadLink | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [shareModalVisible, setShareModalVisible] = useState(false);
  const [emails, setEmails] = useState('');
  const [shareMessage, setShareMessage] = useState('');
  const [shareLoading, setShareLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<UploadedFile | null>(null);
  const [showDocumentViewer, setShowDocumentViewer] = useState(false);
  const [renameModalVisible, setRenameModalVisible] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [regeneratingCode, setRegeneratingCode] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [togglingActive, setTogglingActive] = useState(false);

  const linkId = Number(id);
  const detailCacheKey = uploadLinkDetailScreenKey(user?.id, linkId);

  const invalidateUploadLinkCaches = useCallback(() => {
    if (!user?.id) return;
    if (detailCacheKey) screenCache.invalidate(detailCacheKey);
    const listKey = uploadLinksListScreenKey(user.id);
    if (listKey) screenCache.invalidate(listKey);
  }, [user?.id, detailCacheKey]);

  const loadUploadLink = useCallback(async (forceRefresh = false) => {
    if (!user) {
      setLoading(false);
      return;
    }

    if (!forceRefresh && detailCacheKey) {
      const cached = screenCache.get<UploadLink>(detailCacheKey, UPLOAD_LINK_DETAIL_CACHE_MS);
      if (cached) {
        setUploadLink(cached);
        setLoading(false);
        setRefreshing(false);
        return;
      }
    }
    
    try {
      if (!forceRefresh && !uploadLink) setLoading(true);
      const response = await apiService.getUploadLink(linkId);
      if (response.success) {
        setUploadLink(response.upload_link);
        if (detailCacheKey) screenCache.set(detailCacheKey, response.upload_link);
      } else {
        Alert.alert('Error', response.message || 'Failed to load upload link');
        router.back();
      }
    } catch (error: any) {
      console.error('Load upload link error:', error);
      Alert.alert('Error', error.message || 'Failed to load upload link');
      router.back();
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user, linkId, router, detailCacheKey, uploadLink]);

  // Add debounce to prevent excessive reloads
  const lastLoadTimeRef = useRef<number>(0);
  const RELOAD_DEBOUNCE_MS = 2000; // Don't reload if less than 2 seconds since last load
  
  useFocusEffect(
    useCallback(() => {
      if (user) {
        const now = Date.now();
        if (now - lastLoadTimeRef.current > RELOAD_DEBOUNCE_MS) {
          lastLoadTimeRef.current = now;
          loadUploadLink();
        }
      }
    }, [user, id])
  );

  const handleRefresh = () => {
    if (!user) return;
    setRefreshing(true);
    if (detailCacheKey) screenCache.invalidate(detailCacheKey);
    loadUploadLink(true);
  };

  const getFullUrl = (url: string): string => {
    // Construct full URL if it's just a path
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    // Ensure the URL starts with / and prepend the frontend URL
    const path = url.startsWith('/') ? url : `/${url}`;
    return `${FRONTEND_URL}${path}`;
  };

  const handleCopyLink = async () => {
    if (uploadLink) {
      const fullUrl = getFullUrl(uploadLink.url);
      Clipboard.setString(fullUrl);
      Alert.alert('Copied', 'Upload link copied to clipboard');
    }
  };

  const handleCopyCode = async () => {
    if (!uploadLink?.upload_code) return;
    Clipboard.setString(uploadLink.upload_code);
    Alert.alert('Copied', 'Upload code copied to clipboard');
  };

  const handleRegenerateCode = () => {
    if (!uploadLink) return;
    Alert.alert(
      'Regenerate upload code',
      'Generate a new upload code? The old code will stop working.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Regenerate',
          style: 'destructive',
          onPress: async () => {
            setRegeneratingCode(true);
            try {
              const response = await apiService.regenerateUploadLinkCode(uploadLink.id);
              if (response.success) {
                invalidateUploadLinkCaches();
                await loadUploadLink(true);
                const newCode = response.upload_code || response.upload_link?.upload_code;
                Alert.alert('Done', newCode ? `New code: ${newCode}` : 'Upload code regenerated');
              } else {
                Alert.alert('Error', response.message || 'Failed to regenerate code');
              }
            } catch (error: any) {
              Alert.alert('Error', error.message || 'Failed to regenerate code');
            } finally {
              setRegeneratingCode(false);
            }
          },
        },
      ],
    );
  };

  const handleShareLink = async () => {
    if (!uploadLink) return;
    
    try {
      const fullUrl = getFullUrl(uploadLink.url);
      const codeLine = uploadLink.upload_code ? `\n\nOr enter upload code: ${uploadLink.upload_code} at ${getUploadToBaseUrl()}` : '';
      const message = `Upload files using this link: ${fullUrl}${codeLine}\n\nLink: ${uploadLink.name}\n${uploadLink.description ? `Description: ${uploadLink.description}` : ''}`;
      
      if (Platform.OS === 'ios' || Platform.OS === 'android') {
        await Share.share({
          message,
          url: fullUrl,
          title: `Upload Link: ${uploadLink.name}`,
        });
      }
    } catch (error) {
      console.error('Share error:', error);
    }
  };

  const handleEmailShare = () => {
    setEmails('');
    setShareMessage('');
    setShareModalVisible(true);
  };

  /** Dismiss keyboard before tearing down modals so underlying back taps stay responsive. */
  const closeShareModal = useCallback(() => {
    Keyboard.dismiss();
    setShareModalVisible(false);
  }, []);

  const closeRenameModal = useCallback(() => {
    Keyboard.dismiss();
    setRenameModalVisible(false);
  }, []);

  const handleSendEmails = async () => {
    if (!emails.trim()) {
      Alert.alert('Error', 'Please enter at least one email address');
      return;
    }

    const emailList = emails.split(',').map(email => email.trim()).filter(email => email);
    
    if (emailList.length === 0) {
      Alert.alert('Error', 'Please enter valid email addresses');
      return;
    }

    setShareLoading(true);
    try {
      const response = await apiService.shareUploadLink(Number(id), {
        emails: emailList,
        message: shareMessage.trim() || undefined,
      });

      if (response.success) {
        // Close modal first; Alert + Modal together leaves iOS touches flaky.
        closeShareModal();
        setTimeout(() => {
          Alert.alert('Success', `Upload link shared with ${emailList.length} recipient(s)`);
        }, 150);
      } else {
        Alert.alert('Error', response.message || 'Failed to share upload link');
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to share upload link');
    } finally {
      setShareLoading(false);
    }
  };

  const handleToggleActive = async () => {
    if (!uploadLink) return;

    setTogglingActive(true);
    try {
      const response = await apiService.updateUploadLink(uploadLink.id, {
        is_active: !uploadLink.is_active
      });
      
      if (response.success) {
        setUploadLink((prev) => {
          if (!prev) return null;
          const next = { ...prev, is_active: !prev.is_active };
          if (detailCacheKey) screenCache.set(detailCacheKey, next);
          return next;
        });
        const listKey = uploadLinksListScreenKey(user?.id);
        if (listKey) screenCache.invalidate(listKey);
      } else {
        Alert.alert('Error', response.message || 'Failed to update link');
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to update link');
    } finally {
      setTogglingActive(false);
    }
  };

  const openRenameModal = () => {
    if (uploadLink) {
      setRenameValue(uploadLink.name || '');
      setRenameModalVisible(true);
    }
  };

  const handleRenameSave = async () => {
    const trimmed = renameValue.trim();
    if (!trimmed) {
      Alert.alert('Error', 'Name is required');
      return;
    }
    if (!uploadLink) return;
    setRenaming(true);
    try {
      const response = await apiService.updateUploadLink(uploadLink.id, { link_name: trimmed });
      if (response.success) {
        setUploadLink((prev) => {
          if (!prev) return null;
          const next = { ...prev, name: trimmed };
          if (detailCacheKey) screenCache.set(detailCacheKey, next);
          return next;
        });
        const listKey = uploadLinksListScreenKey(user?.id);
        if (listKey) screenCache.invalidate(listKey);
        closeRenameModal();
      } else {
        Alert.alert('Error', response.message || 'Failed to rename');
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to rename');
    } finally {
      setRenaming(false);
    }
  };

  const handleBack = useCallback(() => {
    Keyboard.dismiss();
    router.back();
  }, [router]);

  const handleDeleteLink = () => {
    if (!uploadLink) return;

    Alert.alert(
      'Delete File Request',
      `Are you sure you want to delete "${uploadLink.name}"? This action cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            try {
              const response = await apiService.deleteUploadLink(uploadLink.id);
              if (response.success) {
                invalidateUploadLinkCaches();
                router.back();
              } else {
                Alert.alert('Error', response.message || 'Failed to delete link');
              }
            } catch (error: any) {
              Alert.alert('Error', error.message || 'Failed to delete link');
            } finally {
              setDeleting(false);
            }
          },
        },
      ]
    );
  };

  const parseUtc = (dateString: string | undefined): Date => {
    if (!dateString || typeof dateString !== 'string') return new Date(NaN);
    const s = dateString.trim();
    if (!s) return new Date(NaN);
    if (!/Z|[-+]\d{2}:?\d{2}$/.test(s)) return new Date(s + 'Z');
    return new Date(s);
  };

  const formatDate = (dateString: string | undefined) => {
    if (!dateString) return 'Unknown date';
    const date = parseUtc(dateString);
    if (isNaN(date.getTime())) return 'Invalid date';
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const isExpired = (expiresAt?: string) => {
    if (!expiresAt) return false;
    return parseUtc(expiresAt).getTime() < Date.now();
  };

  const getFileTypeFromFilename = (filename: string): string => {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'heic', 'heif'];
    const pdfExts = ['pdf'];
    const docExts = ['doc', 'docx'];
    const xlsExts = ['xls', 'xlsx', 'csv'];
    const pptExts = ['ppt', 'pptx'];
    const textExts = ['txt', 'md', 'rtf'];
    
    if (imageExts.includes(ext)) return 'image';
    if (pdfExts.includes(ext)) return 'application/pdf';
    if (docExts.includes(ext)) return 'application/msword';
    if (xlsExts.includes(ext)) return 'application/vnd.ms-excel';
    if (pptExts.includes(ext)) return 'application/vnd.ms-powerpoint';
    if (textExts.includes(ext)) return 'text/plain';
    
    return 'document';
  };

  const getFileIcon = (fileKind?: string, fileType?: string, filename?: string) => {
    // Infer file type from filename if not provided
    if (!fileType && filename) {
      fileType = getFileTypeFromFilename(filename);
    }
    
    if (!fileKind) {
      // Fallback to file type
      if (fileType?.includes('image')) return 'image';
      if (fileType?.includes('pdf')) return 'document';
      return 'document-text';
    }
    
    const kind = fileKind.toLowerCase().trim();
    switch (kind) {
      case 'receipt':
      case 'receipts':
        return 'receipt-outline';
      case 'invoice':
      case 'invoices':
        return 'document-text-outline';
      case 'form':
      case 'forms':
        return 'clipboard-outline';
      case 'document':
      case 'documents':
        return 'document-outline';
      case 'transcript':
      case 'transcripts':
        return 'mic-outline';
      case 'meeting_notes':
      case 'meeting_upload':
        return 'document-text-outline';
      case 'meeting_chat':
        return 'chatbubbles-outline';
      case 'meeting_summary':
      case 'ai_summary':
        return 'sparkles-outline';
      case 'spreadsheet':
      case 'spreadsheets':
        return 'grid-outline';
      case 'picture':
      case 'image':
      case 'images':
        return 'image-outline';
      default:
        return 'document-outline';
    }
  };

  const dynamicStyles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: 16,
      backgroundColor: colors.headerBackground,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      zIndex: 2,
      elevation: 2,
    },
    title: {
      fontSize: 18,
      fontWeight: '600',
      color: colors.text,
    },
    placeholder: {
      width: 24,
    },
    centerContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    loadingText: {
      fontSize: 16,
      color: colors.textSecondary,
    },
    errorText: {
      fontSize: 16,
      color: colors.textSecondary,
    },
    listContainer: {
      padding: 16,
    },
    linkCard: {
      backgroundColor: colors.card,
      borderRadius: 12,
      padding: 16,
      marginBottom: 12,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.1,
      shadowRadius: 4,
      elevation: 3,
    },
    linkHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 8,
    },
    linkName: {
      fontSize: 18,
      fontWeight: '600',
      color: colors.text,
      flex: 1,
    },
    renameButton: {
      padding: 4,
      marginLeft: 4,
    },
    statusBadge: {
      backgroundColor: '#FF3B30',
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 4,
    },
    statusText: {
      fontSize: 12,
      color: '#fff',
      fontWeight: '600',
    },
    linkDescription: {
      fontSize: 14,
      color: colors.textSecondary,
      marginBottom: 12,
    },
    linkStats: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: 12,
    },
    statItem: {
      alignItems: 'center',
    },
    statValue: {
      fontSize: 20,
      fontWeight: '700',
      color: colors.text,
      marginBottom: 4,
    },
    statLabel: {
      fontSize: 12,
      color: colors.textSecondary,
    },
    linkUrl: {
      fontSize: 12,
      color: '#007AFF',
      fontFamily: 'monospace',
      marginTop: 8,
    },
    actionsCard: {
      flexDirection: 'row',
      backgroundColor: colors.card,
      borderRadius: 12,
      padding: 12,
      marginBottom: 12,
      gap: 8,
    },
    actionButton: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: 12,
      borderRadius: 8,
      backgroundColor: colors.surface,
    },
    actionText: {
      marginTop: 4,
      fontSize: 12,
      fontWeight: '500',
      color: colors.text,
    },
    sectionHeader: {
      marginBottom: 12,
    },
    sectionTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: colors.text,
    },
    fileCard: {
      backgroundColor: colors.card,
      borderRadius: 12,
      padding: 16,
      marginBottom: 12,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.1,
      shadowRadius: 4,
      elevation: 3,
    },
    fileHeader: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    fileIcon: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: colors.surface,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 12,
    },
    fileInfo: {
      flex: 1,
      minWidth: 0,
    },
    fileName: {
      fontSize: 16,
      fontWeight: '600',
      color: colors.text,
      marginBottom: 4,
    },
    fileMetadata: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    fileSize: {
      fontSize: 12,
      color: colors.textSecondary,
    },
    fileSeparator: {
      fontSize: 12,
      color: colors.textSecondary,
    },
    fileDate: {
      fontSize: 12,
      color: colors.textSecondary,
    },
    fileBadge: {
      alignSelf: 'flex-start',
      backgroundColor: colors.surface,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 12,
      marginTop: 8,
    },
    fileBadgeText: {
      fontSize: 12,
      color: colors.text,
      textTransform: 'capitalize',
    },
    emptyContainer: {
      alignItems: 'center',
      paddingVertical: 48,
    },
    emptyTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: colors.text,
      marginTop: 16,
      marginBottom: 8,
    },
    emptyDescription: {
      fontSize: 14,
      color: colors.textSecondary,
      textAlign: 'center',
      paddingHorizontal: 32,
    },
    modalContainer: {
      flex: 1,
      backgroundColor: colors.background,
    },
    modalHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: colors.card,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    modalTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: colors.text,
    },
    modalCancelText: {
      fontSize: 16,
      color: '#007AFF',
    },
    modalSendText: {
      fontSize: 16,
      fontWeight: '600',
      color: '#007AFF',
    },
    disabledText: {
      color: colors.textLight,
    },
    modalContent: {
      padding: 16,
    },
    inputGroup: {
      marginBottom: 24,
    },
    label: {
      fontSize: 16,
      fontWeight: '500',
      color: colors.text,
      marginBottom: 8,
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
      height: 100,
      textAlignVertical: 'top',
    },
    codeSection: {
      marginTop: 12,
      paddingTop: 12,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    codeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginBottom: 6,
    },
    codeValue: {
      fontSize: 18,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      fontWeight: '700',
      color: '#007AFF',
      flex: 1,
    },
    codeHint: {
      fontSize: 12,
      color: colors.textSecondary,
      marginBottom: 8,
    },
    codeActions: {
      flexDirection: 'row',
      gap: 8,
    },
    codeActionBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 6,
      backgroundColor: colors.surface,
      gap: 4,
    },
    codeActionText: {
      fontSize: 12,
      fontWeight: '500',
      color: colors.text,
    },
  }), [colors]);

  const handleFilePress = async (file: UploadedFile) => {
    // Uploaded files from upload links are File records, so file.id is the File.id
    // DocumentViewer uses apiClient.getFileById which calls /api/v1/mobile/file/{id}
    // Backend decrypts files automatically through the /view endpoint
    const fileId = file.file_id || file.id;
    
    // Use the same DocumentViewer as files - it handles decryption via backend
    setSelectedFile(file);
    setShowDocumentViewer(true);
  };

  const renderFile = ({ item }: { item: UploadedFile }) => {
    // Use created_at if upload_date is not available
    const dateField = item.upload_date || item.created_at || '';
    
    return (
      <TouchableOpacity 
        style={dynamicStyles.fileCard} 
        onPress={() => handleFilePress(item)}
        activeOpacity={0.7}
      >
        <View style={dynamicStyles.fileHeader}>
          <View style={dynamicStyles.fileIcon}>
            <Ionicons 
              name={getFileIcon(item.file_kind, item.file_type, item.filename) as any}
              size={24} 
              color="#007AFF" 
            />
          </View>
          <View style={dynamicStyles.fileInfo}>
            <FileNameText name={item.filename} style={dynamicStyles.fileName} />
            <View style={dynamicStyles.fileMetadata}>
              <Text style={dynamicStyles.fileSize}>{formatFileSize(item.file_size)}</Text>
              <Text style={dynamicStyles.fileSeparator}>•</Text>
              <Text style={dynamicStyles.fileDate}>{formatDate(dateField)}</Text>
            </View>
          </View>
        </View>
        {item.file_kind && (
          <View style={dynamicStyles.fileBadge}>
            <Text style={dynamicStyles.fileBadgeText}>{item.file_kind}</Text>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  if (loading) {
    return (
      <SafeAreaView style={dynamicStyles.container}>
        <View style={dynamicStyles.header}>
          <AppBackButton onPress={handleBack} />
          <AppHeaderTitle>File Request</AppHeaderTitle>
          <TouchableOpacity
            onPress={handleRefresh}
            disabled={refreshing}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityLabel="Refresh"
            accessibilityRole="button"
          >
            <Ionicons name="refresh" size={24} color={refreshing ? '#999' : '#007AFF'} />
          </TouchableOpacity>
        </View>
        <View style={dynamicStyles.centerContainer}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={dynamicStyles.loadingText}>Loading upload link...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!uploadLink) {
    return (
      <SafeAreaView style={dynamicStyles.container}>
        <View style={dynamicStyles.header}>
          <AppBackButton onPress={handleBack} />
          <AppHeaderTitle>File Request</AppHeaderTitle>
          <View style={dynamicStyles.placeholder} />
        </View>
        <View style={dynamicStyles.centerContainer}>
          <Text style={dynamicStyles.errorText}>Upload link not found</Text>
        </View>
      </SafeAreaView>
    );
  }

  const expired = isExpired(uploadLink.expires_at);
  const limitReached = uploadLink.max_uploads && uploadLink.upload_count >= uploadLink.max_uploads;

  return (
    <>
    <SafeAreaView style={dynamicStyles.container}>
      <View style={dynamicStyles.header}>
        <AppBackButton onPress={handleBack} />
        <AppHeaderTitle>File Request</AppHeaderTitle>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <TouchableOpacity
            onPress={handleRefresh}
            disabled={refreshing}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityLabel="Refresh"
            accessibilityRole="button"
          >
            <Ionicons name="refresh" size={24} color={refreshing ? '#999' : '#007AFF'} />
          </TouchableOpacity>
          <FeedbackTouchable onPress={handleDeleteLink} loading={deleting} spinnerColor="#FF3B30" hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Ionicons name="trash" size={24} color="#FF3B30" />
          </FeedbackTouchable>
        </View>
      </View>

      <FlatList
        data={uploadLink.uploaded_files}
        renderItem={renderFile}
        keyExtractor={(item) => `file-${item.id}`}
        contentContainerStyle={dynamicStyles.listContainer}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor="#007AFF"
          />
        }
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <View>
            {/* Link Info */}
            <View style={dynamicStyles.linkCard}>
              <View style={dynamicStyles.linkHeader}>
                <Text style={dynamicStyles.linkName} numberOfLines={1} ellipsizeMode="tail">{uploadLink.name}</Text>
                <ClientsButton
                  itemType="file_upload_link"
                  itemId={uploadLink.id}
                  compact
                  allowCreate
                />
                <TouchableOpacity onPress={openRenameModal} style={dynamicStyles.renameButton} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="pencil" size={20} color={colors.textSecondary} />
                </TouchableOpacity>
                {(!uploadLink.is_active || expired || limitReached) && (
                  <View style={dynamicStyles.statusBadge}>
                    <Text style={dynamicStyles.statusText}>
                      {!uploadLink.is_active ? 'Inactive' : 
                       expired ? 'Expired' : 
                       'Limit Reached'}
                    </Text>
                  </View>
                )}
              </View>
              
              {uploadLink.description && (
                <Text style={dynamicStyles.linkDescription}>{uploadLink.description}</Text>
              )}

              <View style={dynamicStyles.linkStats}>
                <View style={dynamicStyles.statItem}>
                  <Text style={dynamicStyles.statValue}>{uploadLink.upload_count}</Text>
                  <Text style={dynamicStyles.statLabel}>
                    {uploadLink.max_uploads ? `of ${uploadLink.max_uploads} uploads` : 'uploads'}
                  </Text>
                </View>
                <View style={dynamicStyles.statItem}>
                  <Text style={dynamicStyles.statValue}>
                    {uploadLink.expires_at ? 
                      formatDate(uploadLink.expires_at).split(' ')[0] : 
                      '∞'
                    }
                  </Text>
                  <Text style={dynamicStyles.statLabel}>
                    {uploadLink.expires_at ? 'expires on' : 'never expires'}
                  </Text>
                </View>
              </View>

              <Text style={dynamicStyles.linkUrl}>{getFullUrl(uploadLink.url)}</Text>

              <View style={dynamicStyles.codeSection}>
                <Text style={dynamicStyles.codeHint}>
                  Or tell recipients to enter the code at {getUploadToBaseUrl()}
                </Text>
                {uploadLink.upload_code ? (
                  <>
                    <View style={dynamicStyles.codeRow}>
                      <Text style={dynamicStyles.codeValue}>{uploadLink.upload_code}</Text>
                    </View>
                    <View style={dynamicStyles.codeActions}>
                      <TouchableOpacity style={dynamicStyles.codeActionBtn} onPress={handleCopyCode}>
                        <Ionicons name="copy-outline" size={14} color="#007AFF" />
                        <Text style={dynamicStyles.codeActionText}>Copy code</Text>
                      </TouchableOpacity>
                      <FeedbackTouchable
                        style={dynamicStyles.codeActionBtn}
                        onPress={handleRegenerateCode}
                        disabled={regeneratingCode}
                        loading={regeneratingCode}
                        spinnerColor="#007AFF"
                        replaceWithSpinner={false}
                      >
                        <Ionicons name="refresh" size={14} color="#007AFF" />
                        <Text style={dynamicStyles.codeActionText}>
                          {regeneratingCode ? 'Regenerating...' : 'Regenerate'}
                        </Text>
                      </FeedbackTouchable>
                    </View>
                  </>
                ) : (
                  <View style={dynamicStyles.codeActions}>
                    <Text style={dynamicStyles.codeHint}>No upload code yet.</Text>
                    <FeedbackTouchable
                      style={dynamicStyles.codeActionBtn}
                      onPress={handleRegenerateCode}
                      disabled={regeneratingCode}
                      loading={regeneratingCode}
                      spinnerColor="#007AFF"
                      replaceWithSpinner={false}
                    >
                      <Ionicons name="refresh" size={14} color="#007AFF" />
                      <Text style={dynamicStyles.codeActionText}>
                        {regeneratingCode ? 'Generating...' : 'Generate code'}
                      </Text>
                    </FeedbackTouchable>
                  </View>
                )}
              </View>
            </View>

            {/* Actions */}
            <View style={dynamicStyles.actionsCard}>
              <TouchableOpacity style={dynamicStyles.actionButton} onPress={handleCopyLink}>
                <Ionicons name="copy" size={20} color="#007AFF" />
                <Text style={dynamicStyles.actionText}>Copy Link</Text>
              </TouchableOpacity>
              
              {uploadLink.is_active && !expired && !limitReached && (
                <>
                  <TouchableOpacity style={dynamicStyles.actionButton} onPress={handleShareLink}>
                    <Ionicons name="share" size={20} color="#007AFF" />
                    <Text style={dynamicStyles.actionText}>Share</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={dynamicStyles.actionButton} onPress={handleEmailShare}>
                    <Ionicons name="mail" size={20} color="#007AFF" />
                    <Text style={dynamicStyles.actionText}>Email</Text>
                  </TouchableOpacity>
                </>
              )}
              
              <FeedbackTouchable
                style={dynamicStyles.actionButton}
                onPress={handleToggleActive}
                loading={togglingActive}
                spinnerColor={uploadLink.is_active ? '#FF9500' : '#34C759'}
                replaceWithSpinner={false}
              >
                <Ionicons 
                  name={uploadLink.is_active ? "pause" : "play"} 
                  size={20} 
                  color={uploadLink.is_active ? "#FF9500" : "#34C759"} 
                />
                <Text style={[dynamicStyles.actionText, { color: uploadLink.is_active ? "#FF9500" : "#34C759" }]}>
                  {togglingActive
                    ? 'Updating...'
                    : uploadLink.is_active
                      ? 'Deactivate'
                      : 'Activate'}
                </Text>
              </FeedbackTouchable>
            </View>

            {/* Files Header */}
            <View style={dynamicStyles.sectionHeader}>
              <Text style={dynamicStyles.sectionTitle}>Uploaded Files ({uploadLink.uploaded_files.length})</Text>
            </View>
          </View>
        }
        ListEmptyComponent={
          <View style={dynamicStyles.emptyContainer}>
            <Ionicons name="cloud-upload" size={64} color={colors.textLight} />
            <Text style={dynamicStyles.emptyTitle}>No Files Uploaded</Text>
            <Text style={dynamicStyles.emptyDescription}>
              Files uploaded through this link will appear here
            </Text>
          </View>
        }
      />
    </SafeAreaView>

      {/* Email Share Modal — unmount when closed so native sheet cannot steal touches */}
      {shareModalVisible ? (
      <Modal
        visible
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={closeShareModal}
      >
        <SafeAreaView style={dynamicStyles.modalContainer} edges={['left', 'right', 'bottom']}>
          <View style={[dynamicStyles.modalHeader, { paddingTop: insets.top + 12 }]}>
            <TouchableOpacity onPress={closeShareModal} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Text style={dynamicStyles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
            <Text style={dynamicStyles.modalTitle}>Share via Email</Text>
            <FeedbackTouchable
              onPress={handleSendEmails}
              disabled={shareLoading}
              loading={shareLoading}
              spinnerColor="#007AFF"
              replaceWithSpinner={false}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <Text style={[dynamicStyles.modalSendText, shareLoading && dynamicStyles.disabledText]}>
                {shareLoading ? 'Sending...' : 'Send'}
              </Text>
            </FeedbackTouchable>
          </View>

          <View style={dynamicStyles.modalContent}>
            <View style={dynamicStyles.inputGroup}>
              <Text style={dynamicStyles.label}>Email Addresses (comma separated)</Text>
              <TextInput
                style={[dynamicStyles.input, dynamicStyles.textArea]}
                value={emails}
                onChangeText={setEmails}
                placeholder="john@example.com, jane@example.com"
                placeholderTextColor={colors.textLight}
                multiline
                numberOfLines={3}
                blurOnSubmit
                returnKeyType="done"
                onSubmitEditing={Keyboard.dismiss}
              />
            </View>

            <View style={dynamicStyles.inputGroup}>
              <Text style={dynamicStyles.label}>Custom Message (Optional)</Text>
              <TextInput
                style={[dynamicStyles.input, dynamicStyles.textArea]}
                value={shareMessage}
                onChangeText={setShareMessage}
                placeholder="Add a personal message..."
                placeholderTextColor={colors.textLight}
                multiline
                numberOfLines={4}
                blurOnSubmit
              />
            </View>
          </View>
        </SafeAreaView>
      </Modal>
      ) : null}

      {/* Rename File Request Modal */}
      {renameModalVisible ? (
      <Modal
        visible
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={closeRenameModal}
      >
        <SafeAreaView style={dynamicStyles.modalContainer} edges={['left', 'right', 'bottom']}>
          <View style={[dynamicStyles.modalHeader, { paddingTop: insets.top + 12 }]}>
            <TouchableOpacity onPress={closeRenameModal} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Text style={dynamicStyles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
            <Text style={dynamicStyles.modalTitle}>Rename</Text>
            <FeedbackTouchable
              onPress={handleRenameSave}
              disabled={renaming}
              loading={renaming}
              spinnerColor="#007AFF"
              replaceWithSpinner={false}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <Text style={dynamicStyles.modalSendText}>{renaming ? 'Saving...' : 'Save'}</Text>
            </FeedbackTouchable>
          </View>
          <View style={dynamicStyles.modalContent}>
            <View style={dynamicStyles.inputGroup}>
              <Text style={dynamicStyles.label}>Name</Text>
              <TextInput
                style={dynamicStyles.input}
                value={renameValue}
                onChangeText={setRenameValue}
                placeholder="File request name"
                placeholderTextColor={colors.textLight}
                maxLength={100}
                autoFocus
                returnKeyType="done"
                blurOnSubmit
                onSubmitEditing={() => {
                  void handleRenameSave();
                }}
              />
            </View>
          </View>
        </SafeAreaView>
      </Modal>
      ) : null}
      
      {/* Document Viewer Modal - Same viewer as files, handles decryption via backend */}
      {showDocumentViewer && selectedFile && (
        <DocumentViewer
          fileId={String(selectedFile.file_id || selectedFile.id)}
          fileName={sanitizeDisplayFilename(
            selectedFile.filename || selectedFile.original_filename || 'Untitled',
          )}
          fileType={selectedFile.file_type || getFileTypeFromFilename(selectedFile.filename || '')}
          fileCategory={selectedFile.file_kind || ''}
          onClose={() => {
            setShowDocumentViewer(false);
            setSelectedFile(null);
          }}
        />
      )}
    </>
  );
}

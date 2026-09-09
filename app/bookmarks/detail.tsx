import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    FlatList,
    Modal,
    Platform,
    RefreshControl,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import AdaptiveListPickerModal from '../../components/AdaptiveListPickerModal';
import AppBackButton from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';
import { truncateAppHeaderTitle } from '../../utils/chatTitleDisplay';
import DocumentViewer from '../../components/DocumentViewer';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import FileNameText from '../../components/FileNameText';
import { useScrollRestoresHeaderProps } from '../../contexts/HeaderVisibilityContext';
import { useOpenChatGD } from '../../contexts/ChatGDSheetContext';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiClient } from '../../services/api';
import { bookmarkDetailScreenKey, bookmarksListScreenKey } from '../../services/userScopedCache';
import { formatDateToLocal } from '../../utils/timeFormatting';
import { screenCache } from '../../utils/screenCache';
import { shareDocumentFile, prefetchShareDocumentFile } from '../../utils/shareDocumentFile';
import { floatingDialogSurfaceStyle, modalScrimOverlayStyle } from '../../utils/dialogSurfaceStyles';
import { AnimatedHeaderContainer } from '../components/AnimatedHeaderContainer';
import { TapToToggleHeaderView } from '../components/TapToToggleHeaderView';
import { useAuth } from '../context/auth';

interface Bookmark {
  id: number;
  name: string;
  description?: string;
  color: string;
  file_count: number;
  is_active: boolean;
  is_locked?: boolean;
}

interface Document {
  id: string;
  name: string;
  type: string;
  category?: string;
  size?: string;
  created_at: string;
  status: string;
}

/** For receipts use store name, for invoices use vendor name, else filename. */
function getFileDisplayName(file: any): string {
  const kind = (file.file_kind || file.category || '').toString().toLowerCase();
  const data = file.json_data && typeof file.json_data === 'object' ? file.json_data : {};
  const storeOrVendor =
    kind === 'receipt'
      ? (data.store_name || data.business_name || data.merchant_name || data.vendor_name || '').trim()
      : kind === 'invoice'
        ? (data.vendor_name || data.business_name || data.merchant_name || data.store_name || '').trim()
        : '';
  if (storeOrVendor) return storeOrVendor;
  return file.filename || file.original_filename || 'Unknown file';
}

export default function BookmarkDetailScreen() {
  const router = useRouter();
  const openChatGD = useOpenChatGD();
  const params = useLocalSearchParams();
  const { user } = useAuth();
  const themeColors = useThemeColors();
  const insets = useSafeAreaInsets();
  const scrollRestoresHeaderProps = useScrollRestoresHeaderProps();

  const [bookmark, setBookmark] = useState<Bookmark | null>(null);
  const [files, setFiles] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showAddFilesModal, setShowAddFilesModal] = useState(false);
  const [availableFiles, setAvailableFiles] = useState<Document[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [loadingAvailableFiles, setLoadingAvailableFiles] = useState(false);
  const [selectedDocument, setSelectedDocument] = useState<Document | null>(null);
  const [showDocumentViewer, setShowDocumentViewer] = useState(false);
  const [showKebabMenu, setShowKebabMenu] = useState(false);
  const [selectedDocumentForMenu, setSelectedDocumentForMenu] = useState<Document | null>(null);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [showPaymentStatusModal, setShowPaymentStatusModal] = useState(false);
  const [categorizingReceipt, setCategorizingReceipt] = useState(false);
  const [updatingPaymentStatus, setUpdatingPaymentStatus] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameInputValue, setRenameInputValue] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingBookmark, setDeletingBookmark] = useState(false);
  const [togglingLock, setTogglingLock] = useState(false);
  const [addingFiles, setAddingFiles] = useState(false);

  const receiptCategories = [
    'Uncategorized', 'Advertising', 'Supplies', 'Professional Services', 'Personal',
    'Rent and Lease', 'Education and Training', 'Cars and Truck', 'Travel', 'Office Expenses',
    'Meals and Entertainment', 'Contractors', 'Employee Benefit', 'Banking', 'Other Expenses'
  ];
  const paymentStatuses = ['Paid', 'Unpaid', 'Partial'];

  // Edit form state
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editColor, setEditColor] = useState('#007AFF');
  
  const bookmarkColors = [
    '#007AFF', '#34C759', '#FF9500', '#FF3B30', 
    '#AF52DE', '#5856D6', '#8E44AD', '#E74C3C'
  ];

  const bookmarkId = params.id ? parseInt(params.id as string) : null;
  const openAddFiles = params.addFiles === '1' || params.addFiles === true;

  const DETAIL_CACHE_MS = 30_000;
  const detailCacheKey = bookmarkId ? bookmarkDetailScreenKey(user?.id, bookmarkId) : null;
  const listCacheKey = bookmarksListScreenKey(user?.id);

  const loadBookmarkDetails = async (forceRefresh = false) => {
    if (!bookmarkId || !user?.id) return;

    if (!forceRefresh && detailCacheKey) {
      const cached = screenCache.get<{ bookmark: Bookmark; files: Document[] }>(
        detailCacheKey,
        DETAIL_CACHE_MS
      );
      if (cached) {
        setBookmark(cached.bookmark);
        setEditName(cached.bookmark.name);
        setEditDescription(cached.bookmark.description || '');
        setEditColor(cached.bookmark.color);
        setFiles(cached.files);
        setLoading(false);
        setRefreshing(false);
        return;
      }
    }
    
    try {
      setLoading(true);
      
      // Load bookmark info and files in parallel
      const [bookmarkResponse, filesResponse] = await Promise.all([
        apiClient.getBookmarks(),
        apiClient.getBookmarkFiles(bookmarkId)
      ]);

      if (bookmarkResponse.success && bookmarkResponse.data) {
        const bookmarksData = Array.isArray(bookmarkResponse.data) 
          ? bookmarkResponse.data 
          : (bookmarkResponse.data.bookmarks || []);
        
        const foundBookmark = bookmarksData.find((b: Bookmark) => b.id === bookmarkId);
        if (foundBookmark) {
          setBookmark(foundBookmark);
          setEditName(foundBookmark.name);
          setEditDescription(foundBookmark.description || '');
          setEditColor(foundBookmark.color);
        }
      }
      
      if (filesResponse.success && filesResponse.data) {
        const filesData = filesResponse.data;

        // Map backend field names to frontend interface (receipts/invoices show store/vendor name)
        const mappedFiles = filesData.map((file: any) => ({
          id: file.id.toString(),
          name: getFileDisplayName(file),
          type: file.file_type || file.file_kind || 'document',
          category: file.file_kind || file.file_type,
          size: file.file_size ? `${(file.file_size / 1024).toFixed(1)} KB` : undefined,
          created_at: file.created_at,
          status: 'processed' // Assume processed for bookmark files
        }));
        
        setFiles(mappedFiles);

        // Cache both bookmark metadata and files together
        setBookmark(prev => {
          if (prev && detailCacheKey) screenCache.set(detailCacheKey, { bookmark: prev, files: mappedFiles });
          return prev;
        });
      }
      
    } catch {
      Alert.alert('Error', 'Failed to load bookmark details');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // Reload on each focus so changes from "add files" flow are reflected,
  // but use cache to avoid spinner on quick back-navigation.
  useFocusEffect(
    useCallback(() => {
      if (bookmarkId && user?.id) loadBookmarkDetails();
    }, [bookmarkId, user?.id])
  );

  const onRefresh = () => {
    setRefreshing(true);
    if (detailCacheKey) screenCache.invalidate(detailCacheKey);
    loadBookmarkDetails(true);
  };

  const handleEditBookmark = async () => {
    if (!bookmark || !editName.trim()) {
      Alert.alert('Error', 'Bookmark name is required');
      return;
    }

    setSavingEdit(true);
    try {
      const response = await apiClient.updateBookmark(bookmark.id, {
        name: editName.trim(),
        description: editDescription.trim(),
        color: editColor
      });

      if (response.success) {
        if (detailCacheKey) screenCache.invalidate(detailCacheKey);
        if (listCacheKey) screenCache.invalidate(listCacheKey);
        setBookmark(prev => prev ? {
          ...prev,
          name: editName.trim(),
          description: editDescription.trim(),
          color: editColor
        } : null);
        setShowEditModal(false);
        Alert.alert('Success', 'Bookmark updated successfully');
      } else {
        Alert.alert('Error', response.message || 'Failed to update bookmark');
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to update bookmark');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDeleteBookmark = () => {
    if (!bookmark) return;

    Alert.alert(
      'Delete Bookmark',
      `Are you sure you want to delete "${bookmark.name}"? This action cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeletingBookmark(true);
            try {
              const response = await apiClient.deleteBookmark(bookmark.id);
              if (response.success) {
                Alert.alert('Success', 'Bookmark deleted successfully', [
                  { text: 'OK', onPress: () => router.back() }
                ]);
              } else {
                Alert.alert('Error', response.message || 'Failed to delete bookmark');
              }
            } catch (error: any) {
              Alert.alert('Error', error.message || 'Failed to delete bookmark');
            } finally {
              setDeletingBookmark(false);
            }
          }
        }
      ]
    );
  };

  const handleToggleLock = () => {
    if (!bookmark) return;
    const newLocked = !bookmark.is_locked;

    const doToggle = async () => {
      setTogglingLock(true);
      try {
        const response = await apiClient.updateBookmark(bookmark.id, { is_locked: newLocked });
        if (response.success) {
          if (detailCacheKey) screenCache.invalidate(detailCacheKey);
          if (listCacheKey) screenCache.invalidate(listCacheKey);
          setBookmark(prev => prev ? { ...prev, is_locked: newLocked } : null);
          Alert.alert('Success', newLocked ? 'Bookmark locked' : 'Bookmark unlocked');
        } else {
          Alert.alert('Error', response.message || 'Failed to update bookmark lock');
        }
      } catch (error: any) {
        Alert.alert('Error', error.message || 'Failed to update bookmark lock');
      } finally {
        setTogglingLock(false);
      }
    };

    if (!newLocked) {
      Alert.alert(
        'Unlock Bookmark',
        `Unlock "${bookmark.name}"? Files can be added or removed once unlocked.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Unlock', onPress: doToggle },
        ]
      );
    } else {
      doToggle();
    }
  };

  const handleRemoveFile = (fileId: string) => {
    if (!bookmark) return;
    if (bookmark.is_locked) {
      Alert.alert('Bookmark locked', 'Unlock the bookmark to add or remove files.');
      return;
    }

    Alert.alert(
      'Remove File',
      'Are you sure you want to remove this file from the bookmark?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              const response = await apiClient.removeFileFromBookmark(bookmark.id, parseInt(fileId, 10));
              if (response.success) {
                if (detailCacheKey) screenCache.invalidate(detailCacheKey);
                setFiles((prev) => prev.filter((f) => f.id !== fileId));
                setBookmark((prev) =>
                  prev ? { ...prev, file_count: Math.max(0, prev.file_count - 1) } : null
                );
              } else {
                Alert.alert('Error', response.message || 'Failed to remove file');
              }
            } catch (error: any) {
              Alert.alert('Error', error.message || 'Failed to remove file');
            }
          },
        },
      ]
    );
  };

  const handleKebabMenuPress = (document: Document, event: any) => {
    event?.stopPropagation?.();
    setSelectedDocumentForMenu(document);
    setShowKebabMenu(true);
    prefetchShareDocumentFile(document.id, document.name);
  };

  const handleViewDocument = () => {
    if (selectedDocumentForMenu) {
      setSelectedDocument(selectedDocumentForMenu);
      setShowDocumentViewer(true);
      setShowKebabMenu(false);
    }
  };

  const handleShareDocument = () => {
    if (!selectedDocumentForMenu) return;
    const doc = selectedDocumentForMenu;
    setShowKebabMenu(false);
    void shareDocumentFile(doc.id, doc.name).catch((error: unknown) => {
      Alert.alert('Error', error instanceof Error ? error.message : 'Failed to share document');
    });
  };

  const handleChatDocument = () => {
    if (!selectedDocumentForMenu) return;
    openChatGD({
      fileId: String(selectedDocumentForMenu.id),
      fileName: selectedDocumentForMenu.name || '',
    });
    setShowKebabMenu(false);
  };

  const handleCategorizeReceipt = () => {
    if (!selectedDocumentForMenu) return;
    setShowKebabMenu(false);
    setShowCategoryModal(true);
  };

  const handleSelectCategory = async (category: string) => {
    if (!selectedDocumentForMenu) return;
    setCategorizingReceipt(true);
    try {
      const response = await apiClient.categorizeReceipt(parseInt(selectedDocumentForMenu.id), category);
      if (response.success) {
        Alert.alert('Success', `Receipt categorized as "${category}"`);
        setFiles(prev => prev.map(f => f.id === selectedDocumentForMenu.id ? { ...f, category } : f));
        setShowCategoryModal(false);
        setSelectedDocumentForMenu(null);
      } else {
        Alert.alert('Error', response.message || 'Failed to categorize receipt');
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to categorize receipt');
    } finally {
      setCategorizingReceipt(false);
    }
  };

  const handleUpdatePaymentStatus = () => {
    if (!selectedDocumentForMenu) return;
    setShowKebabMenu(false);
    setShowPaymentStatusModal(true);
  };

  const handleSelectPaymentStatus = async (paymentStatus: string) => {
    if (!selectedDocumentForMenu) return;
    setUpdatingPaymentStatus(true);
    try {
      const response = await apiClient.updateInvoicePaymentStatus(parseInt(selectedDocumentForMenu.id), paymentStatus);
      if (response.success) {
        Alert.alert('Success', `Invoice payment status updated to "${paymentStatus}"`);
        setShowPaymentStatusModal(false);
        setSelectedDocumentForMenu(null);
      } else {
        Alert.alert('Error', response.message || 'Failed to update payment status');
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to update payment status');
    } finally {
      setUpdatingPaymentStatus(false);
    }
  };

  const handleRemoveFromBookmark = () => {
    if (!selectedDocumentForMenu) return;
    const docId = selectedDocumentForMenu.id;
    setShowKebabMenu(false);
    setSelectedDocumentForMenu(null);
    handleRemoveFile(docId);
  };

  const handleRenameDocument = () => {
    if (!selectedDocumentForMenu || bookmark?.is_locked) return;
    const name = selectedDocumentForMenu.name || '';
    setRenameInputValue(name.replace(/\.[^/.]+$/, ''));
    setShowKebabMenu(false);
    setShowRenameModal(true);
  };

  const handleConfirmRename = async () => {
    if (!selectedDocumentForMenu || !renameInputValue.trim() || bookmark?.is_locked) return;
    const ext = (selectedDocumentForMenu.name || '').split('.').pop() || '';
    const newName = ext ? `${renameInputValue.trim()}.${ext}` : renameInputValue.trim();
    setRenaming(true);
    try {
      const response = await apiClient.renameFile(parseInt(selectedDocumentForMenu.id), newName);
      if (response.success) {
        setFiles(prev => prev.map(f => f.id === selectedDocumentForMenu.id ? { ...f, name: newName } : f));
        setShowRenameModal(false);
        setSelectedDocumentForMenu(null);
        Alert.alert('Success', 'File renamed');
      } else {
        Alert.alert('Error', response.message || 'Failed to rename');
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to rename');
    } finally {
      setRenaming(false);
    }
  };

  const handleDeleteDocument = () => {
    if (!selectedDocumentForMenu) return;
    const doc = selectedDocumentForMenu;
    // Close the action menu before the confirm dialog so it cannot linger under Alerts.
    setShowKebabMenu(false);
    Alert.alert(
      'Delete Document',
      `Are you sure you want to delete "${doc.name}"?`,
      [
        {
          text: 'Cancel',
          style: 'cancel',
          onPress: () => setSelectedDocumentForMenu(null),
        },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              const response = await apiClient.deleteFile(parseInt(doc.id, 10));
              if (response.success) {
                setFiles((prev) => prev.filter((d) => d.id !== doc.id));
                setBookmark((prev) =>
                  prev ? { ...prev, file_count: Math.max(0, prev.file_count - 1) } : null
                );
                if (detailCacheKey) screenCache.invalidate(detailCacheKey);
                setSelectedDocumentForMenu(null);
              } else {
                Alert.alert('Error', response.message || 'Failed to delete');
                setSelectedDocumentForMenu(null);
              }
            } catch (error: any) {
              Alert.alert('Error', error.message || 'Failed to delete');
              setSelectedDocumentForMenu(null);
            }
          },
        },
      ]
    );
  };

  const handleCloseKebabMenu = () => {
    setShowKebabMenu(false);
    setSelectedDocumentForMenu(null);
  };

  const loadAvailableFiles = async () => {
    try {
      setLoadingAvailableFiles(true);
      let allFiles: any[] = [];
      let page = 1;
      const perPage = 100;
      const maxPages = 15; // cap ~1500 files; avoids N sequential API calls for huge libraries
      let hasMore = true;

      while (hasMore && page <= maxPages) {
        const response = await apiClient.getFiles(page, perPage);

        if (response.success && response.files) {
          const filesData = response.files;
          allFiles = allFiles.concat(filesData);
          hasMore = filesData.length === perPage;
          page++;
        } else {
          hasMore = false;
        }
      }

      // Map backend field names to frontend interface (receipts/invoices show store/vendor name)
      const mappedFiles = allFiles.map((file: any) => ({
        id: file.id.toString(),
        name: getFileDisplayName(file),
        type: file.file_type || file.file_kind || 'document',
        category: file.file_kind || file.file_type,
        size: file.file_size ? `${(file.file_size / 1024).toFixed(1)} KB` : undefined,
        created_at: file.created_at,
        status: 'processed' // Assume processed for available files
      }));
      
      // Filter out files that are already in the bookmark
      const bookmarkFileIds = new Set(files.map(f => f.id));
      const available = mappedFiles.filter((f: Document) => !bookmarkFileIds.has(f.id));
      setAvailableFiles(available);
    } catch {
      Alert.alert('Error', 'Failed to load available files');
    } finally {
      setLoadingAvailableFiles(false);
    }
  };

  const handleShowAddFilesModal = () => {
    loadAvailableFiles();
    setShowAddFilesModal(true);
  };

  const handleAddSelectedFiles = async () => {
    if (!bookmark || selectedFiles.size === 0) return;

    setAddingFiles(true);
    try {
      const fileIds = Array.from(selectedFiles).map(id => parseInt(id));
      const response = await apiClient.addFilesToBookmark(bookmark.id, fileIds);
      
      if (response.success) {
        // Reload bookmark details to get updated file list
        if (detailCacheKey) screenCache.invalidate(detailCacheKey);
        await loadBookmarkDetails(true);
        setSelectedFiles(new Set());
        setShowAddFilesModal(false);
        Alert.alert('Success', `${fileIds.length} file(s) added to bookmark`);
      } else {
        Alert.alert('Error', response.message || 'Failed to add files');
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to add files');
    } finally {
      setAddingFiles(false);
    }
  };

  const toggleFileSelection = (fileId: string) => {
    setSelectedFiles(prev => {
      const newSet = new Set(prev);
      if (newSet.has(fileId)) {
        newSet.delete(fileId);
      } else {
        newSet.add(fileId);
      }
      return newSet;
    });
  };

  const dynamicStyles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: themeColors.headerBackground || themeColors.card,
    },
    content: {
      flex: 1,
      backgroundColor: themeColors.background,
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    loadingText: {
      marginTop: 16,
      fontSize: 16,
      color: themeColors.textSecondary,
    },
    errorContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 20,
    },
    errorTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: themeColors.text,
      marginTop: 16,
      marginBottom: 24,
    },
    backButton: {
      backgroundColor: '#007AFF',
      paddingHorizontal: 24,
      paddingVertical: 12,
      borderRadius: 8,
    },
    backButtonText: {
      color: 'white',
      fontSize: 16,
      fontWeight: '600',
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-start',
      gap: 4,
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: themeColors.headerBackground || themeColors.card,
      borderBottomWidth: 1,
      borderBottomColor: themeColors.border,
    },
    headerTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: themeColors.text,
      flex: 1,
      marginHorizontal: 16,
    },
    headerActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    headerIconButton: {
      padding: 4,
    },
    bookmarkInfo: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: 12,
      backgroundColor: themeColors.card,
      marginBottom: 6,
    },
    colorIndicator: {
      width: 16,
      height: 16,
      borderRadius: 8,
      marginRight: 12,
    },
    bookmarkDetails: {
      flex: 1,
    },
    bookmarkName: {
      fontSize: 20,
      fontWeight: '600',
      color: themeColors.text,
      marginBottom: 4,
    },
    bookmarkDescription: {
      fontSize: 14,
      color: themeColors.textSecondary,
      marginBottom: 4,
    },
    fileCount: {
      fontSize: 14,
      color: '#007AFF',
      fontWeight: '500',
    },
    filesList: {
      flex: 1,
      paddingHorizontal: 12,
    },
    fileItem: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: 10,
      backgroundColor: themeColors.card,
      borderRadius: 8,
      marginBottom: 6,
    },
    availableFileItem: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: 10,
      backgroundColor: themeColors.card,
      borderRadius: 8,
      marginBottom: 6,
    },
    selectedFileItem: {
      backgroundColor: themeColors.surface,
      borderWidth: 1,
      borderColor: '#007AFF',
    },
    fileInfo: {
      flexDirection: 'row',
      alignItems: 'center',
      flex: 1,
    },
    fileDetails: {
      flex: 1,
      minWidth: 0,
    },
    fileName: {
      fontSize: 16,
      fontWeight: '500',
      color: themeColors.text,
      marginBottom: 2,
    },
    fileMeta: {
      fontSize: 14,
      color: themeColors.textSecondary,
    },
    fileTimestamp: {
      fontSize: 12,
      color: themeColors.textSecondary,
      marginTop: 2,
    },
    kebabButton: {
      padding: 6,
      marginLeft: 6,
    },
    modalOverlay: modalScrimOverlayStyle(themeColors.isDark, {
      justifyContent: 'center',
      alignItems: 'center',
    }),
    kebabMenuContainer: {
      ...floatingDialogSurfaceStyle(themeColors, themeColors.isDark, { minWidth: 150 }),
      padding: 8,
    },
    kebabMenuItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      paddingHorizontal: 16,
      borderRadius: 8,
    },
    kebabMenuText: {
      fontSize: 16,
      color: themeColors.text,
      marginLeft: 12,
      fontWeight: '500',
    },
    categoryModalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      justifyContent: 'flex-end',
    },
    categoryModalContent: {
      backgroundColor: themeColors.card,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      maxHeight: '70%',
      paddingBottom: 20,
    },
    categoryModalHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: 20,
      borderBottomWidth: 1,
      borderBottomColor: themeColors.border,
    },
    categoryModalTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: themeColors.text,
    },
    categoryList: {
      maxHeight: 400,
    },
    categoryModalItem: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingVertical: 16,
      borderBottomWidth: 1,
      borderBottomColor: themeColors.border,
    },
    categoryItemText: {
      fontSize: 16,
      color: themeColors.text,
    },
    categoryModalLoading: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(255, 255, 255, 0.9)',
      justifyContent: 'center',
      alignItems: 'center',
    },
    renameModalContent: {
      backgroundColor: themeColors.card,
      borderRadius: 16,
      padding: 20,
      width: '90%',
      maxWidth: 360,
    },
    renameModalTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: themeColors.text,
      marginBottom: 16,
    },
    emptyState: {
      alignItems: 'center',
      paddingVertical: 48,
    },
    emptyStateTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: themeColors.text,
      marginTop: 16,
      marginBottom: 8,
    },
    emptyStateDescription: {
      fontSize: 14,
      color: themeColors.textSecondary,
      textAlign: 'center',
      paddingHorizontal: 32,
    },
    modalContainer: {
      flex: 1,
      backgroundColor: themeColors.background,
    },
    modalHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: themeColors.card,
      borderBottomWidth: 1,
      borderBottomColor: themeColors.border,
    },
    modalTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: themeColors.text,
    },
    modalCancelButton: {
      fontSize: 16,
      color: '#007AFF',
    },
    modalSaveButton: {
      fontSize: 16,
      fontWeight: '600',
      color: '#007AFF',
    },
    disabledButton: {
      color: themeColors.textLight,
    },
    modalContent: {
      padding: 16,
    },
    inputGroup: {
      marginBottom: 24,
    },
    inputLabel: {
      fontSize: 16,
      fontWeight: '500',
      color: themeColors.text,
      marginBottom: 8,
    },
    textInput: {
      borderWidth: 1,
      borderColor: themeColors.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 12,
      fontSize: 16,
      backgroundColor: themeColors.surface,
      color: themeColors.text,
    },
    textArea: {
      height: 80,
      textAlignVertical: 'top',
    },
    colorPicker: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 12,
    },
    colorOption: {
      width: 40,
      height: 40,
      borderRadius: 20,
      borderWidth: 2,
      borderColor: 'transparent',
    },
    selectedColor: {
      borderColor: themeColors.text,
    },
    availableFilesList: {
      flex: 1,
      paddingHorizontal: 16,
    },
  }), [themeColors]);

  const handleFilePress = async (file: Document) => {
    setSelectedDocument(file);
    setShowDocumentViewer(true);
  };

  const isReceipt = (doc: Document) => (doc.category || '').toString().toLowerCase() === 'receipt';
  const isInvoice = (doc: Document) => (doc.category || '').toString().toLowerCase() === 'invoice';
  const isReceiptOrInvoice = (doc: Document) => isReceipt(doc) || isInvoice(doc);

  const renderFileItem = ({ item }: { item: Document }) => (
    <TouchableOpacity 
      style={dynamicStyles.fileItem}
      onPress={() => handleFilePress(item)}
      activeOpacity={0.7}
    >
      <View style={dynamicStyles.fileInfo}>
        <View style={dynamicStyles.fileDetails}>
          <FileNameText name={item.name} style={dynamicStyles.fileName} />
          <Text style={dynamicStyles.fileMeta}>
            {[item.category || item.type, item.created_at && formatDateToLocal(item.created_at)].filter(Boolean).join(' • ')}
          </Text>
        </View>
      </View>
      <TouchableOpacity
        style={dynamicStyles.kebabButton}
        onPress={(e) => {
          e.stopPropagation();
          handleKebabMenuPress(item, e);
        }}
      >
        <Ionicons name="ellipsis-vertical" size={20} color="#666" />
      </TouchableOpacity>
    </TouchableOpacity>
  );

  const renderAvailableFileItem = ({ item }: { item: Document }) => (
    <TouchableOpacity
      style={[
        dynamicStyles.availableFileItem,
        selectedFiles.has(item.id) && dynamicStyles.selectedFileItem
      ]}
      onPress={() => toggleFileSelection(item.id)}
    >
      <View style={dynamicStyles.fileInfo}>
        <View style={dynamicStyles.fileDetails}>
          <FileNameText name={item.name} style={dynamicStyles.fileName} />
          <Text style={dynamicStyles.fileMeta}>
            {[item.category || item.type, item.created_at && formatDateToLocal(item.created_at)].filter(Boolean).join(' • ')}
          </Text>
        </View>
      </View>
      {selectedFiles.has(item.id) && (
        <Ionicons name="checkmark-circle" size={24} color="#34C759" />
      )}
    </TouchableOpacity>
  );

  if (loading) {
    return (
      <SafeAreaView style={dynamicStyles.container}>
        <View style={dynamicStyles.loadingContainer}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={dynamicStyles.loadingText}>Loading bookmark...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!bookmark) {
    return (
      <SafeAreaView style={dynamicStyles.container}>
        <View style={dynamicStyles.errorContainer}>
          <Ionicons name="bookmark-outline" size={64} color={themeColors.textLight} />
          <Text style={dynamicStyles.errorTitle}>Bookmark not found</Text>
          <TouchableOpacity style={dynamicStyles.backButton} onPress={() => router.back()}>
            <Text style={dynamicStyles.backButtonText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={dynamicStyles.container} edges={['top']}>
      <TapToToggleHeaderView style={dynamicStyles.content}>
      <AnimatedHeaderContainer>
        <View style={dynamicStyles.header}>
          <AppBackButton />
          <AppHeaderTitle shrink={false}>
            {truncateAppHeaderTitle(bookmark.name || 'Bookmark')}
          </AppHeaderTitle>
          <View style={dynamicStyles.headerActions}>
            <FeedbackTouchable
              onPress={handleToggleLock}
              style={dynamicStyles.headerIconButton}
              accessibilityLabel={bookmark.is_locked ? 'Unlock bookmark' : 'Lock bookmark'}
              loading={togglingLock}
              spinnerColor="#F59E0B"
            >
              <Ionicons name={bookmark.is_locked ? 'lock-open' : 'lock-closed-outline'} size={24} color="#F59E0B" />
            </FeedbackTouchable>
            {!bookmark.is_locked && (
              <TouchableOpacity onPress={handleShowAddFilesModal} style={dynamicStyles.headerIconButton} accessibilityLabel="Add files to bookmark">
                <Ionicons name="add" size={24} color="#007AFF" />
              </TouchableOpacity>
            )}
            {!bookmark.is_locked && (
              <FeedbackTouchable
                onPress={handleDeleteBookmark}
                style={dynamicStyles.headerIconButton}
                loading={deletingBookmark}
                spinnerColor="#FF3B30"
              >
                <Ionicons name="trash-outline" size={24} color="#FF3B30" />
              </FeedbackTouchable>
            )}
          </View>
        </View>
      </AnimatedHeaderContainer>

      <TouchableOpacity style={dynamicStyles.bookmarkInfo} onPress={() => !bookmark.is_locked && setShowEditModal(true)} activeOpacity={0.7} disabled={bookmark.is_locked}>
        <View style={[dynamicStyles.colorIndicator, { backgroundColor: bookmark.color }]} />
        <View style={dynamicStyles.bookmarkDetails}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={dynamicStyles.bookmarkName}>{bookmark.name.length > 30 ? `${bookmark.name.slice(0, 30)}...` : bookmark.name}</Text>
            {bookmark.is_locked && <Ionicons name="lock-closed" size={18} color="#F59E0B" />}
          </View>
          {bookmark.description && (
            <Text style={dynamicStyles.bookmarkDescription}>{bookmark.description}</Text>
          )}
          <Text style={dynamicStyles.fileCount}>{bookmark.file_count} file(s)</Text>
        </View>
      </TouchableOpacity>

      <FlatList
        data={files}
        renderItem={renderFileItem}
        keyExtractor={(item) => item.id}
        style={dynamicStyles.filesList}
        {...scrollRestoresHeaderProps}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          <View style={dynamicStyles.emptyState}>
            <Ionicons name="document-outline" size={48} color={themeColors.textLight} />
            <Text style={dynamicStyles.emptyStateTitle}>No files in this bookmark</Text>
            <Text style={dynamicStyles.emptyStateDescription}>
              Add files to organize them in this bookmark
            </Text>
          </View>
        }
      />

      {/* Edit Bookmark Modal */}
      <Modal visible={showEditModal} animationType="slide" presentationStyle="fullScreen">
        <SafeAreaView style={dynamicStyles.modalContainer} edges={['left', 'right', 'bottom']}>
          <View style={[dynamicStyles.modalHeader, { paddingTop: insets.top + 12 }]}>
            <TouchableOpacity onPress={() => setShowEditModal(false)} disabled={savingEdit}>
              <Text style={dynamicStyles.modalCancelButton}>Cancel</Text>
            </TouchableOpacity>
            <Text style={dynamicStyles.modalTitle}>Edit Bookmark</Text>
            <FeedbackTouchable
              onPress={handleEditBookmark}
              disabled={savingEdit}
              loading={savingEdit}
              spinnerColor="#007AFF"
              replaceWithSpinner={false}
            >
              <Text style={dynamicStyles.modalSaveButton}>{savingEdit ? 'Saving...' : 'Save'}</Text>
            </FeedbackTouchable>
          </View>

          <View style={dynamicStyles.modalContent}>
            <View style={dynamicStyles.inputGroup}>
              <Text style={dynamicStyles.inputLabel}>Name</Text>
              <TextInput
                style={dynamicStyles.textInput}
                value={editName}
                onChangeText={setEditName}
                placeholder="Bookmark name"
                placeholderTextColor={themeColors.textLight}
                maxLength={50}
              />
            </View>

            <View style={dynamicStyles.inputGroup}>
              <Text style={dynamicStyles.inputLabel}>Description</Text>
              <TextInput
                style={[dynamicStyles.textInput, dynamicStyles.textArea]}
                value={editDescription}
                onChangeText={setEditDescription}
                placeholder="Optional description"
                placeholderTextColor={themeColors.textLight}
                multiline
                numberOfLines={3}
                maxLength={200}
              />
            </View>

            <View style={dynamicStyles.inputGroup}>
              <Text style={dynamicStyles.inputLabel}>Color</Text>
              <View style={dynamicStyles.colorPicker}>
                {bookmarkColors.map((color) => (
                  <TouchableOpacity
                    key={color}
                    style={[
                      dynamicStyles.colorOption,
                      { backgroundColor: color },
                      editColor === color && dynamicStyles.selectedColor
                    ]}
                    onPress={() => setEditColor(color)}
                  />
                ))}
              </View>
            </View>
          </View>
        </SafeAreaView>
      </Modal>

      {/* Add Files Modal */}
      <Modal visible={showAddFilesModal} animationType="slide" presentationStyle="fullScreen">
        <SafeAreaView style={dynamicStyles.modalContainer} edges={['left', 'right', 'bottom']}>
          <View style={[dynamicStyles.modalHeader, { paddingTop: insets.top + 12 }]}>
            <TouchableOpacity onPress={() => {
              setShowAddFilesModal(false);
              setSelectedFiles(new Set());
            }}>
              <Text style={dynamicStyles.modalCancelButton}>Cancel</Text>
            </TouchableOpacity>
            <Text style={dynamicStyles.modalTitle}>Add Files</Text>
            <FeedbackTouchable
              onPress={handleAddSelectedFiles}
              disabled={selectedFiles.size === 0 || addingFiles}
              loading={addingFiles}
              spinnerColor="#007AFF"
              replaceWithSpinner={false}
            >
              <Text style={[
                dynamicStyles.modalSaveButton,
                (selectedFiles.size === 0 || addingFiles) && dynamicStyles.disabledButton
              ]}>
                {addingFiles ? 'Adding...' : `Add (${selectedFiles.size})`}
              </Text>
            </FeedbackTouchable>
          </View>

           {loadingAvailableFiles ? (
             <View style={dynamicStyles.loadingContainer}>
               <ActivityIndicator size="large" color="#007AFF" />
               <Text style={dynamicStyles.loadingText}>Loading your files...</Text>
             </View>
           ) : (
             <FlatList
               data={availableFiles}
               renderItem={renderAvailableFileItem}
               keyExtractor={(item) => item.id}
               style={dynamicStyles.availableFilesList}
               {...scrollRestoresHeaderProps}
               ListEmptyComponent={
                 <View style={dynamicStyles.emptyState}>
                   <Ionicons name="document-outline" size={48} color={themeColors.textLight} />
                   <Text style={dynamicStyles.emptyStateTitle}>No available files</Text>
                   <Text style={dynamicStyles.emptyStateDescription}>
                     All your files are already in this bookmark
                   </Text>
                 </View>
               }
             />
           )}
        </SafeAreaView>
      </Modal>

      {/* Kebab Menu Modal */}
      <Modal
        visible={showKebabMenu}
        transparent
        animationType="fade"
        onRequestClose={handleCloseKebabMenu}
      >
        <TouchableOpacity
          style={dynamicStyles.modalOverlay}
          activeOpacity={1}
          onPress={handleCloseKebabMenu}
        >
          <View style={dynamicStyles.kebabMenuContainer} onStartShouldSetResponder={() => true}>
            <TouchableOpacity style={dynamicStyles.kebabMenuItem} onPress={handleViewDocument}>
              <Ionicons name="eye-outline" size={20} color="#007AFF" />
              <Text style={dynamicStyles.kebabMenuText}>View</Text>
            </TouchableOpacity>
            {selectedDocumentForMenu && isReceipt(selectedDocumentForMenu) && (
              <TouchableOpacity style={dynamicStyles.kebabMenuItem} onPress={handleCategorizeReceipt}>
                <Ionicons name="pricetag-outline" size={20} color="#FF9500" />
                <Text style={dynamicStyles.kebabMenuText}>Categorize</Text>
              </TouchableOpacity>
            )}
            {selectedDocumentForMenu && isInvoice(selectedDocumentForMenu) && (
              <TouchableOpacity style={dynamicStyles.kebabMenuItem} onPress={handleUpdatePaymentStatus}>
                <Ionicons name="card-outline" size={20} color="#2563EB" />
                <Text style={dynamicStyles.kebabMenuText}>Update Payment Status</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={dynamicStyles.kebabMenuItem} onPress={handleShareDocument}>
              <Ionicons name="share-outline" size={20} color="#10B981" />
              <Text style={dynamicStyles.kebabMenuText}>Share</Text>
            </TouchableOpacity>
            <TouchableOpacity style={dynamicStyles.kebabMenuItem} onPress={handleChatDocument}>
              <Ionicons name="chatbubble-outline" size={20} color="#4F46E5" />
              <Text style={dynamicStyles.kebabMenuText}>Ask ChatGD</Text>
            </TouchableOpacity>
            {!bookmark.is_locked && (
              <TouchableOpacity style={dynamicStyles.kebabMenuItem} onPress={handleRemoveFromBookmark}>
                <Ionicons name="bookmark" size={20} color="#FF9500" />
                <Text style={dynamicStyles.kebabMenuText}>Remove from Bookmark</Text>
              </TouchableOpacity>
            )}
            {selectedDocumentForMenu && !bookmark.is_locked && !isReceiptOrInvoice(selectedDocumentForMenu) && (
              <TouchableOpacity style={dynamicStyles.kebabMenuItem} onPress={handleRenameDocument}>
                <Ionicons name="pencil-outline" size={20} color="#6B7280" />
                <Text style={dynamicStyles.kebabMenuText}>Rename</Text>
              </TouchableOpacity>
            )}
            {!bookmark.is_locked && (
              <TouchableOpacity
                style={dynamicStyles.kebabMenuItem}
                onPress={handleDeleteDocument}
              >
                <Ionicons name="trash-outline" size={20} color="#EF4444" />
                <Text style={[dynamicStyles.kebabMenuText, { color: '#EF4444' }]}>Delete</Text>
              </TouchableOpacity>
            )}
          </View>
        </TouchableOpacity>
      </Modal>

      <AdaptiveListPickerModal
        visible={showCategoryModal}
        onClose={() => setShowCategoryModal(false)}
        title="Select Category"
        itemCount={receiptCategories.length}
        footer={
          categorizingReceipt ? (
            <View style={dynamicStyles.categoryModalLoading}>
              <ActivityIndicator size="large" color="#007AFF" />
            </View>
          ) : null
        }
      >
        {receiptCategories.map((category) => (
          <TouchableOpacity
            key={category}
            style={dynamicStyles.categoryModalItem}
            onPress={() => handleSelectCategory(category)}
            disabled={categorizingReceipt}
          >
            <Text style={dynamicStyles.categoryItemText}>{category}</Text>
            <Ionicons name="chevron-forward" size={20} color="#999" />
          </TouchableOpacity>
        ))}
      </AdaptiveListPickerModal>

      <AdaptiveListPickerModal
        visible={showPaymentStatusModal}
        onClose={() => setShowPaymentStatusModal(false)}
        title="Update Payment Status"
        itemCount={paymentStatuses.length}
        footer={
          updatingPaymentStatus ? (
            <View style={dynamicStyles.categoryModalLoading}>
              <ActivityIndicator size="large" color="#007AFF" />
            </View>
          ) : null
        }
      >
        {paymentStatuses.map((status) => (
          <TouchableOpacity
            key={status}
            style={dynamicStyles.categoryModalItem}
            onPress={() => handleSelectPaymentStatus(status)}
            disabled={updatingPaymentStatus}
          >
            <Text style={dynamicStyles.categoryItemText}>{status}</Text>
            <Ionicons name="chevron-forward" size={20} color="#999" />
          </TouchableOpacity>
        ))}
      </AdaptiveListPickerModal>

      {/* Rename File Modal */}
      <Modal
        visible={showRenameModal}
        transparent
        animationType="fade"
        onRequestClose={() => !renaming && setShowRenameModal(false)}
      >
        <TouchableOpacity
          style={dynamicStyles.modalOverlay}
          activeOpacity={1}
          onPress={() => !renaming && setShowRenameModal(false)}
        >
          <View style={dynamicStyles.renameModalContent} onStartShouldSetResponder={() => true}>
            <Text style={dynamicStyles.renameModalTitle}>Rename File</Text>
            <TextInput
              style={dynamicStyles.textInput}
              value={renameInputValue}
              onChangeText={setRenameInputValue}
              placeholder="File name (without extension)"
              placeholderTextColor={themeColors.textLight}
              autoFocus
            />
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 16, gap: 12 }}>
              <TouchableOpacity onPress={() => !renaming && setShowRenameModal(false)}>
                <Text style={dynamicStyles.modalCancelButton}>Cancel</Text>
              </TouchableOpacity>
              <FeedbackTouchable
                onPress={handleConfirmRename}
                disabled={renaming || !renameInputValue.trim()}
                loading={renaming}
                spinnerColor="#007AFF"
                replaceWithSpinner={false}
              >
                <Text style={[dynamicStyles.modalSaveButton, (renaming || !renameInputValue.trim()) && dynamicStyles.disabledButton]}>
                  {renaming ? 'Saving...' : 'Save'}
                </Text>
              </FeedbackTouchable>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Document Viewer */}
      {showDocumentViewer && selectedDocument && (
        <DocumentViewer
          fileId={selectedDocument.id}
          fileName={selectedDocument.name}
          fileType={selectedDocument.type}
          fileCategory={selectedDocument.category}
          onClose={() => {
            setShowDocumentViewer(false);
            setSelectedDocument(null);
          }}
        />
      )}
      </TapToToggleHeaderView>
    </SafeAreaView>
  );
}


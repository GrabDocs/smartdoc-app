import { Feather, Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    FlatList,
    Keyboard,
    KeyboardAvoidingView,
    Modal,
    Platform,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
    type ViewStyle
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ActionMenuModal, { type ActionMenuItem } from '../../components/ActionMenuModal';
import AdaptiveListPickerModal from '../../components/AdaptiveListPickerModal';
import AiFileManagerBottomSheet from '../../components/ai-file-manager/AiFileManagerBottomSheet';
import ClientsButton from '../../components/clients/ClientsButton';
import DeletedFolderGroups from '../../components/documents/DeletedFolderGroups';
import DocumentsFolderBar from '../../components/documents/DocumentsFolderBar';
import DocumentViewer from '../../components/DocumentViewer';
import ExternalFilePicker from '../../components/ExternalFilePicker';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import FileNameText from '../../components/FileNameText';
import CreateFolderSheet from '../../components/folders/CreateFolderSheet';
import FolderKebabMenu, { type FolderKebabAction } from '../../components/folders/FolderKebabMenu';
import FolderMovePicker from '../../components/folders/FolderMovePicker';
import RenameFolderSheet from '../../components/folders/RenameFolderSheet';
import LoadingDots from '../../components/LoadingDots';
import QuickFormViewer from '../../components/QuickFormViewer';
import { AI_FM_ICON_COLOR } from '../../constants/aiFileManagerHelp';
import { useScrollRestoresHeaderProps } from '../../contexts/HeaderVisibilityContext';
import { useOpenChatGD } from '../../contexts/ChatGDSheetContext';
import { useUserPreferences } from '../../contexts/UserPreferencesContext';
import { useFolderSystem } from '../../hooks/useFolderSystem';
import { useMinimizableSheet } from '../../hooks/useMinimizableSheet';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiClient } from '../../services/api';
import { ExternalFile } from '../../services/externalFileServices';
import { useFileStore } from '../../stores/fileStore';
import type { DeletedFolderGroup, FolderRowModel } from '../../types/folder';
import { toAlertMessage } from '../../utils/alertUtils';
import {
  docNeedsClassificationPollFromRow,
  isFileKindPending,
  resolveDocumentListStatus,
} from '../../utils/fileDisplayStatus';
import { floatingDialogSurfaceStyle, modalScrimOverlayStyle } from '../../utils/dialogSurfaceStyles';
import { sanitizeDisplayFilename } from '../../utils/displayFilename';
import { removeFileExtension } from '../../utils/fileUtils';
import { mapFileRowToDocument } from '../../utils/mapFileRowToDocument';
import { shareDocumentFile, prefetchShareDocumentFile } from '../../utils/shareDocumentFile';
import { scaleStyleObject } from '../../utils/styleUtils';
import { AnimatedHeaderContainer } from '../components/AnimatedHeaderContainer';
import { TapToToggleHeaderView } from '../components/TapToToggleHeaderView';
import { UploadOptionsModal } from '../components/UploadOptionsModal';
import { useAuth } from '../context/auth';

import AppBackButton from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';

interface Document {
  id: string;
  name: string;
  type: string; // Now supports more specific types like 'docx', 'xlsx', 'pptx', 'txt', etc.
  size: string;
  uploadDate: Date;
  status: 'processed' | 'processing' | 'pending' | 'error';
  tags: string[];
  category?: string;
  file_kind?: string; // Store the raw file_kind from backend
  formData?: any; // Store original form data for form-specific actions
  responseCount?: number; // Number of responses for forms
  totalAmount?: number; // For receipt/invoice: from json_data
  is_global?: boolean; // File is global (available across workspaces)
  json_data?: Record<string, unknown> | null; // Store json_data to check if store name is populated
  original_filename?: string;
  user_id?: number; // File owner's user ID
  /** Workspace list: row opens bookmark detail instead of a file */
  listKind?: 'file' | 'bookmark';
  bookmarkId?: number;
  bookmarkColor?: string;
  /** For listKind bookmark: used when sorting by size */
  bookmarkFileCount?: number;
  /** From folder/web file API — file is in at least one locked bookmark */
  in_locked_bookmark?: boolean;
}

interface ApiDocument {
  id: number;
  original_filename: string;
  filename?: string;
  file_size: number;
  file_type?: string;
  created_at: string;
  receipt_category?: string;
  file_path?: string;
  mime_type?: string;
  file_kind?: string;
  json_data?: Record<string, unknown> | null;
  processing_status?: 'pending' | 'processing' | 'processed' | 'error';
  is_global?: boolean;
  user_id?: number; // File owner's user ID
  /** When present from API, trashed rows must not appear on the main Files list */
  is_deleted?: boolean;
  lifecycle_state?: string | null;
}

type SortOption = 'name' | 'date' | 'size' | 'type';
type FilterOption =
  | 'all'
  | 'documents'
  | 'receipts'
  | 'forms'
  | 'transcripts'
  | 'invoice'
  | 'meeting_notes'
  | 'meeting_chat'
  | 'meeting_summary'
  | 'draft'
  | 'spreadsheet'
  | 'picture'
  | 'pending'
  | 'unknown'
  | 'deleted';

// Helper to check if a file is editable as Draft (text-like formats)
function isEditableTextFormat(file: Document | { original_filename?: string; filename?: string; file_kind?: string }): boolean {
  const name = file?.original_filename || (file as any)?.filename || '';
  const ext = name.toLowerCase().substring(name.lastIndexOf('.'));
  const excluded = ['.pdf', '.zip', '.exe', '.dll', '.bin'];
  const editable = ['.txt', '.doc', '.docx', '.md', '.log', '.csv', '.json'];
  if (excluded.includes(ext)) return false;
  if (editable.includes(ext)) return true;
  // Also check file_kind - Draft files are editable
  const fk = (file as any)?.file_kind?.toLowerCase();
  if (fk === 'draft') return true;
  return false;
}

/** True when API marks a bookmark as locked (handles 0/1 and string flags). */
function isBookmarkLocked(b: any): boolean {
  const v = b?.is_locked;
  if (v === true || v === false) return v;
  if (v === 1 || v === 0) return v === 1;
  if (typeof v === 'string') return ['true', '1', 'yes', 't'].includes(v.toLowerCase());
  return false;
}

function isLockedBookmarkFile(
  fileId: string | number | undefined | null,
  lockedIds: Set<string>,
  inLockedBookmark?: boolean
): boolean {
  if (inLockedBookmark) return true;
  if (fileId == null || fileId === '') return false;
  return lockedIds.has(String(fileId));
}

/** Module-level so list items keep a stable component identity (avoids remount/janky spinners). */
const DocumentListIcon = React.memo(function DocumentListIcon({
  pending,
  iconName,
  iconColor,
  containerStyle,
}: {
  pending: boolean;
  iconName: React.ComponentProps<typeof Ionicons>['name'];
  iconColor: string;
  containerStyle: ViewStyle;
}) {
  if (pending) {
    return (
      <View style={containerStyle}>
        <ActivityIndicator size="small" color={iconColor} />
      </View>
    );
  }
  return (
    <View style={containerStyle}>
      <Ionicons name={iconName} size={24} color={iconColor} />
    </View>
  );
});

export default function QuickFilesScreen() {
  const router = useRouter();
  const openChatGD = useOpenChatGD();
  const navigation = useNavigation();
  const params = useLocalSearchParams();
  const { user } = useAuth();
  const colors = useThemeColors();
  const { preferences } = useUserPreferences();
  const scrollRestoresHeaderProps = useScrollRestoresHeaderProps();
  const { uploadFromGallery, lastUploadTime, pendingUploads, setUploadFolderContext } = useFileStore();
  const [documents, setDocuments] = useState<Document[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastLoadTime, setLastLoadTime] = useState<number>(0);
  const [gridView, setGridView] = useState(preferences.display.grid_view_default);
  
  // Get workspaceId from route params if provided
  const workspaceId = params.workspaceId ? Number(params.workspaceId) : undefined;
  
  // Re-read params and reload when screen comes into focus (important for tab navigation)
  // This ensures workspaceId is properly read when navigating from workspace details
  // Add debounce to prevent excessive reloads, but allow immediate refresh after upload
  const lastLoadTimeRef = useRef<number>(0);
  // Match the cache TTL — serving stale data within 30 s is better than a network round-trip on every tab switch.
  const CACHE_DURATION = 30000; // 30 seconds cache
  const RELOAD_DEBOUNCE_MS = CACHE_DURATION;
  const lastUploadTimeRef = useRef<number>(0); // Track when upload happened locally

  const handleDocumentsHeaderBack = useCallback(() => {
    if (navigation.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)');
    }
  }, [navigation, router]);

  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('date');
  const [showSortMenu, setShowSortMenu] = useState(false);
  const sortMenuItems = useMemo(
    (): ActionMenuItem[] => [
      { id: 'name', label: 'Name', icon: 'text-outline', onPress: () => setSortBy('name') },
      { id: 'date', label: 'Date', icon: 'calendar-outline', onPress: () => setSortBy('date') },
      { id: 'size', label: 'Size', icon: 'resize-outline', onPress: () => setSortBy('size') },
      { id: 'type', label: 'Type', icon: 'folder-outline', onPress: () => setSortBy('type') },
    ],
    [],
  );
  const showSortOptions = useCallback(() => {
    setShowSortMenu(true);
  }, []);
  const [filterBy, setFilterBy] = useState<FilterOption>('all');

  const useFolderMode = filterBy !== 'forms' && filterBy !== 'deleted';

  const folderSystem = useFolderSystem({
    workspaceId,
    initialFolderId: params.folderId ? Number(params.folderId) : null,
    enabled: useFolderMode,
  });

  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [renameFolderTarget, setRenameFolderTarget] = useState<FolderRowModel | null>(null);
  const [showFolderMovePicker, setShowFolderMovePicker] = useState(false);
  const [moveFileIds, setMoveFileIds] = useState<number[]>([]);
  const [moveFolderTarget, setMoveFolderTarget] = useState<FolderRowModel | null>(null);
  const [folderMenuTarget, setFolderMenuTarget] = useState<FolderRowModel | null>(null);
  const [showFolderKebabMenu, setShowFolderKebabMenu] = useState(false);
  const [deletedFolderGroups, setDeletedFolderGroups] = useState<DeletedFolderGroup[]>([]);
  const [showAiFmSheet, setShowAiFmSheet] = useState(false);
  const [aiFmExpandNonce, setAiFmExpandNonce] = useState(0);
  const [aiFmWorkspaceId, setAiFmWorkspaceId] = useState<number | null>(null);
  const uploadSheet = useMinimizableSheet();
  const folderSystemRef = useRef(folderSystem);
  folderSystemRef.current = folderSystem;

  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  /** Trash tab: server soft-deleted files */
  type DeletedFileRow = {
    id: number;
    original_filename?: string;
    file_kind?: string;
    file_type?: string;
    deleted_at?: string | null;
    days_remaining?: number | null;
    purge_at?: string | null;
    restoring?: boolean;
    lifecycle_state?: string | null;
  };
  const [deletedFiles, setDeletedFiles] = useState<DeletedFileRow[]>([]);
  const [deletedLoading, setDeletedLoading] = useState(false);
  const [deletedActionId, setDeletedActionId] = useState<number | null>(null);
  const [showDeletedKebabMenu, setShowDeletedKebabMenu] = useState(false);
  const [selectedDeletedFileForMenu, setSelectedDeletedFileForMenu] = useState<DeletedFileRow | null>(null);
  /** Poll until restored files disappear from trash (indexing finished on server). */
  const restorePollRef = useRef<{
    intervalId: ReturnType<typeof setInterval> | null;
    pendingIds: Set<number>;
    attempts: number;
  }>({ intervalId: null, pendingIds: new Set(), attempts: 0 });
  // Refs mirror the pagination state so loadDocuments can read them without
  // being in its dependency array (prevents the useCallback from being recreated
  // on every page load, which would re-trigger useEffect and reset to page 1).
  const hasMoreRef = React.useRef(true);
  const loadingMoreRef = React.useRef(false);
  const currentPageRef = React.useRef(1);
  const [selectedDocument, setSelectedDocument] = useState<Document | null>(null);
  const [showExternalFilePicker, setShowExternalFilePicker] = useState(false);
  const [showDocumentViewer, setShowDocumentViewer] = useState(false);
  const [showQuickFormViewer, setShowQuickFormViewer] = useState(false);
  const [isAutoRefreshing, setIsAutoRefreshing] = useState(false);
  
  // Kebab menu state
  const [showKebabMenu, setShowKebabMenu] = useState(false);
  const [selectedDocumentForMenu, setSelectedDocumentForMenu] = useState<Document | null>(null);
  
  // Category selection modal states
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [categorizingReceipt, setCategorizingReceipt] = useState(false);
  
  // Payment status selection modal states
  const [showPaymentStatusModal, setShowPaymentStatusModal] = useState(false);
  const [updatingPaymentStatus, setUpdatingPaymentStatus] = useState(false);
  
  // Rename modal state
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameInputValue, setRenameInputValue] = useState('');
  const [renaming, setRenaming] = useState(false);
  
  // Receipt categories (must match backend validation)
  const receiptCategories = [
    'Uncategorized',
    'Advertising',
    'Supplies',
    'Professional Services',
    'Personal',
    'Rent and Lease',
    'Education and Training',
    'Cars and Truck',
    'Travel',
    'Office Expenses',
    'Meals and Entertainment',
    'Contractors',
    'Employee Benefit',
    'Banking',
    'Other Expenses'
  ];
  
  // Invoice payment statuses (must match backend validation)
  const paymentStatuses = [
    'Paid',
    'Unpaid',
    'Partial'
  ];

  // Bookmark state
  const [bookmarks, setBookmarks] = useState<any[]>([]);
  /** Bookmarks visible in the current workspace (shared there or owned with that workspace id) */
  const [workspaceBookmarks, setWorkspaceBookmarks] = useState<any[]>([]);
  /** File IDs that are in at least one locked bookmark; hidden from the files list */
  const [fileIdsInLockedBookmarks, setFileIdsInLockedBookmarks] = useState<Set<string>>(new Set());
  const [showBookmarkModal, setShowBookmarkModal] = useState(false);
  const [selectedBookmark, setSelectedBookmark] = useState<any>(null);
  // Create new bookmark (from Add to Bookmark modal)
  const [newBookmarkName, setNewBookmarkName] = useState('');
  const [newBookmarkColor, setNewBookmarkColor] = useState('#007AFF');
  const [creatingBookmark, setCreatingBookmark] = useState(false);
  const bookmarkColors = ['#007AFF', '#34C759', '#FF9500', '#FF3B30', '#AF52DE', '#5856D6', '#8E44AD', '#E74C3C'];

  // Make Global (workspace visibility) state
  const [showMakeGlobalModal, setShowMakeGlobalModal] = useState(false);
  const [makeGlobalDocument, setMakeGlobalDocument] = useState<Document | null>(null);
  const [makeGlobalWorkspaces, setMakeGlobalWorkspaces] = useState<{ id: number; name?: string }[]>([]);
  const [makeGlobalSelectedIds, setMakeGlobalSelectedIds] = useState<number[]>([]);
  const [makeGlobalLoading, setMakeGlobalLoading] = useState(false);
  const [makeGlobalSaving, setMakeGlobalSaving] = useState(false);

  // Status indicator state for recently completed files
  const [recentlyCompletedFiles, setRecentlyCompletedFiles] = useState<Set<string>>(new Set());

  const AUTO_REFRESH_INTERVAL = 60000; // Auto-refresh every 60 seconds
  /** Files list pagination size — follows Settings → Items Per Page. */
  const MOBILE_FILES_PAGE_SIZE = Math.max(5, Math.min(100, preferences.display.items_per_page || 20));

  useEffect(() => {
    setGridView(preferences.display.grid_view_default);
  }, [preferences.display.grid_view_default]);

  // Use a ref for the API cache so loadDocuments always reads the latest value
  // without needing to be in its own dependency array (avoids stale-closure cache misses).
  const apiCacheRef = React.useRef<{
    data: Document[];
    timestamp: number;
    isFormsMode: boolean;
    workspaceId?: number;
    workspaceBookmarks?: any[];
    userId?: string | number;
  } | null>(null);

  /** Optimistic move-to-trash: hide these ids on every server-driven list merge until DELETE completes + refresh. */
  const pendingMoveToTrashIdsRef = React.useRef<Set<string>>(new Set());
  const filterPendingTrash = useCallback((docs: Document[]) => {
    const p = pendingMoveToTrashIdsRef.current;
    if (p.size === 0) return docs;
    return docs.filter((d) => !p.has(String(d.id)));
  }, []);

  // Locked-bookmark file ID cache — keyed so we don't re-fetch on every loadDocuments call.
  // Refreshed when bookmark mutations happen or after LOCKED_BOOKMARK_CACHE_MS elapses.
  const lockedBookmarkCacheRef = React.useRef<{
    fileIds: Set<string>;
    bookmarks: any[];
    timestamp: number;
    scopeWorkspaceId?: number;
    userId?: string | number;
  } | null>(null);
  const LOCKED_BOOKMARK_CACHE_MS = 5 * 60 * 1000; // 5 minutes

  // Ref so loadDocuments can read the latest filterBy without being a dep
  const filterByRef = React.useRef(filterBy);
  filterByRef.current = filterBy;

  const useFolderModeRef = React.useRef(useFolderMode);
  useFolderModeRef.current = useFolderMode;

  /** True when a file still needs classification polling (file_kind pending, or receipt/invoice json_data). */
  const docNeedsClassificationPoll = useCallback((doc: Document) => {
    return docNeedsClassificationPollFromRow(doc, {
      useFolderMode: useFolderModeRef.current,
    });
  }, []);

  // Polling for pending files (classification polling)
  const classificationPollingIntervalRef = React.useRef<NodeJS.Timeout | null>(null);
  // Safety counter: stop classification polling after 60 polls (3 minutes) to prevent infinite loops
  const classificationPollCountRef = React.useRef(0);
  // In-flight guard: prevents concurrent loadDocuments calls from producing duplicate requests
  const isLoadingDocumentsRef = React.useRef(false);
  // FlatList momentum guard to prevent duplicate onEndReached calls per fling
  const onEndReachedCalledDuringMomentumRef = React.useRef(false);
  // Persists locked-bookmark file IDs across renders so the filter can be applied
  // immediately on subsequent loads without waiting for the background refresh.
  const lockedFileIdsRef = React.useRef<Set<string>>(new Set());
  /** User-triggered reprocess/retry — keep spinner until processing_status clears (matches web). */
  const reprocessingFileIdsRef = React.useRef<Set<number>>(new Set());

  useEffect(() => {
    apiCacheRef.current = null;
    lockedBookmarkCacheRef.current = null;
  }, [user?.id]);

  const handleGalleryUpload = async () => {
    try {
      console.log('🖼️ Starting gallery upload from files screen...');
      
      const success = await uploadFromGallery();
      if (success === true) {
        // Immediately reload files to show them with pending status
        console.log('📁 Upload complete, immediately reloading files to show pending status...');
        
        // Mark upload time for focus effect to bypass debounce
        lastUploadTimeRef.current = Date.now();
        
        // Bypass debounce and cache - force immediate refresh
        lastLoadTimeRef.current = 0; // Reset debounce timer
        apiCacheRef.current = null; // Clear cache to force fresh load
        
        // Refresh immediately, then retry after short delay in case backend needs time
        loadDocuments(true);
        
        // Retry after 500ms in case backend hasn't created file record yet
        setTimeout(() => {
          console.log('📁 Retrying file load after gallery upload...');
          loadDocuments(true);
        }, 500);
        
        // Final retry after 2 seconds to catch any delayed file creation
        setTimeout(() => {
          console.log('📁 Final retry file load after gallery upload...');
          loadDocuments(true);
        }, 2000);
      } else if (success === false) {
        // Get the error from the file store
        const fileStore = useFileStore.getState();
        const errorMessage = fileStore.error || 'Failed to upload photos. Please try again.';
        
        Alert.alert('Upload Failed', errorMessage, [
          { text: 'Try Again', onPress: () => handleGalleryUpload() },
          { text: 'Cancel', style: 'cancel' }
        ]);
      }
      // null = cancelled or upload-limit alert already shown
    } catch (error: any) {
      console.error('Gallery upload error:', error);
      Alert.alert('Error', error.message || 'Failed to upload photos. Please try again.');
    }
  };

  const getFileIcon = (type: string, status: string, fileKind?: string) => {
    // Spinner only while classifying (file_kind pending) or explicit user retry
    if (isFileKindPending(fileKind) || status === 'processing') return 'time-outline';
    if (status === 'error') return 'alert-circle-outline';
    
    // Handle form type specifically
    if (type === 'form') return 'clipboard-outline';
    if (type === 'bookmark') return 'bookmark';
    
    // Use file_kind to determine icon (file_kind is the file type: receipt, invoice, document, spreadsheet, picture, etc.)
    if (fileKind) {
      const kind = fileKind.toLowerCase().trim();
      switch (kind) {
        case 'receipt':
        case 'receipts':
          return 'receipt-outline'; // Receipt-specific icon
        case 'invoice':
        case 'invoices':
          return 'document-text-outline'; // Invoice icon (document with text)
        case 'form':
        case 'forms':
          return 'clipboard-outline'; // Form-specific icon (clipboard for forms)
        case 'document':
        case 'documents':
          return 'document-outline';
        case 'transcript':
        case 'transcripts':
          return 'mic-outline'; // Microphone icon for transcripts
        case 'meeting_notes':
        case 'meeting_upload':
          return 'document-text-outline'; // Document icon for meeting notes
        case 'meeting_chat':
          return 'chatbubbles-outline'; // Chat bubbles icon for meeting chat
        case 'meeting_summary':
        case 'ai_summary':
          return 'sparkles-outline'; // Sparkles icon for AI summaries
        case 'draft':
        case 'drafts':
          return 'create-outline'; // Draft (document + pencil / edit) icon
        case 'spreadsheet':
        case 'spreadsheets':
          return 'grid-outline'; // Grid icon for spreadsheets
        case 'picture':
        case 'image':
        case 'images':
          return 'image-outline'; // Image icon for pictures
        case 'unknown':
          return 'help-circle-outline';
        default:
          // If file_kind doesn't match, fall through to file type check
          break;
      }
    }
    
    // Fallback to file type icons
    switch (type) {
      case 'pdf': return 'document-outline';
      case 'doc': return 'document-text-outline';
      case 'image': return 'image-outline';
      default: return 'document-outline';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'processed': return '#22c55e'; // Green for processed
      case 'processing': return '#f59e0b'; // Orange for processing
      case 'error': return '#ef4444'; // Red for error
      default: return '#64748b'; // Gray for unknown
    }
  };

  const getTypeColor = (type: string, fileKind?: string) => {
    // Handle form type specifically
    if (type === 'form') return '#3b82f6'; // Blue for forms
    
    // Use file_kind to determine color (file_kind is the file type: receipt, invoice, document, spreadsheet, picture, etc.)
    if (fileKind) {
      const kind = fileKind.toLowerCase().trim();
      switch (kind) {
        case 'receipt':
        case 'receipts':
          return '#10b981'; // Emerald green for receipts
        case 'invoice':
        case 'invoices':
          return '#2563eb'; // Blue for invoices
        case 'form':
        case 'forms':
          return '#3b82f6'; // Blue for forms
        case 'document':
        case 'documents':
          return '#6366f1'; // Indigo for documents
        case 'transcript':
        case 'transcripts':
          return '#8b5cf6'; // Purple for transcripts
        case 'meeting_notes':
        case 'meeting_upload':
          return '#a855f7'; // Violet for meeting notes
        case 'meeting_chat':
          return '#3b82f6'; // Blue for meeting chat
        case 'meeting_summary':
        case 'ai_summary':
          return '#10b981'; // Green for AI summaries
        case 'draft':
        case 'drafts':
          return '#5AC8FA'; // Teal for drafts
        case 'spreadsheet':
        case 'spreadsheets':
          return '#10b981'; // Green for spreadsheets
        case 'picture':
        case 'image':
        case 'images':
          return '#ec4899'; // Pink for pictures/images
        case 'unknown':
          return '#64748b'; // Gray for unknown
        default:
          // If file_kind doesn't match, fall through to file type check
          break;
      }
    }
    
    // Fallback to file type colors
    switch (type) {
      case 'pdf': return '#ef4444'; // Red for PDF
      case 'doc': return '#2563eb'; // Blue for documents
      case 'image': return '#059669'; // Green for images
      default: return '#64748b'; // Gray for others
    }
  };

  const normalizeCategory = (fileKind: string | null | undefined): string => {
    if (!fileKind) return 'unknown';
    
    const kind = fileKind.toLowerCase().trim();
    
    // Map backend file_kind values to frontend categories
    switch (kind) {
      case 'pending':
        return 'pending';
      case 'receipt':
      case 'receipts':
        return 'receipts';
      case 'invoice':
      case 'invoices':
        return 'invoice';
      case 'form':
      case 'forms':
        return 'forms';
      case 'document':
      case 'documents':
        return 'documents';
      case 'transcript':
      case 'transcripts':
        return 'transcripts';
      case 'meeting_notes':
      case 'meeting_upload':
        return 'meeting_notes';
      case 'meeting_chat':
        return 'meeting_chat';
      case 'meeting_summary':
      case 'ai_summary':
        return 'meeting_summary';
      case 'draft':
      case 'drafts':
        return 'draft';
      case 'spreadsheet':
      case 'spreadsheets':
        return 'spreadsheet';
      case 'picture':
      case 'image':
      case 'images':
        return 'picture';
      default:
        return 'unknown';
    }
  };

  // Calculate which categories have files
  const availableCategories = useMemo(() => {
    const categoryCounts = new Map<FilterOption, number>();
    
    // Always include 'all' if there are any documents
    if (documents.length > 0) {
      categoryCounts.set('all', documents.length);
    }

    // Count files by category
    documents.forEach(doc => {
      // Check for pending status first
      if (doc.status === 'pending') {
        categoryCounts.set('pending', (categoryCounts.get('pending') || 0) + 1);
      }
      
      // Count by normalized file_kind (not category - category is for receipt categorization like "Supplies", "Rent", etc.)
      // Use file_kind to determine the file type (receipt, invoice, document, etc.)
      const category = normalizeCategory(doc.file_kind) as FilterOption;
      if (category !== 'pending') {
        categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
      }
    });
    
    // Return only categories that have at least one file, sorted with custom order
    const categories = Array.from(categoryCounts.entries())
      .filter(([_, count]) => count > 0)
      .map(([category]) => category);
    
    // Define the desired order for filter tabs
    const categoryOrder: FilterOption[] = [
      'all',
      'documents',
      'receipts',
      'invoice',
      'meeting_summary',
      'forms',
      'transcripts',
      'meeting_notes',
      'meeting_chat',
      'draft',
      'spreadsheet',
      'picture',
      'pending',
      'unknown',
    ];
    
    // Sort: use predefined order, then alphabetically for any not in the list
    return categories.sort((a, b) => {
      const indexA = categoryOrder.indexOf(a);
      const indexB = categoryOrder.indexOf(b);
      
      // If both are in the predefined order, sort by their position
      if (indexA !== -1 && indexB !== -1) {
        return indexA - indexB;
      }
      // If only A is in the order, A comes first
      if (indexA !== -1) return -1;
      // If only B is in the order, B comes first
      if (indexB !== -1) return 1;
      // If neither is in the order, sort alphabetically
      return a.localeCompare(b);
    });
  }, [documents]);

  const loadDeletedFiles = useCallback(
    async (opts?: { silent?: boolean }): Promise<DeletedFileRow[]> => {
      if (!user) {
        setDeletedFiles([]);
        return [];
      }
      if (!opts?.silent) setDeletedLoading(true);
      try {
        const res = await apiClient.getDeletedFiles(1, 100);
        const groups = (res as { folder_groups?: DeletedFolderGroup[] }).folder_groups;
        setDeletedFolderGroups(Array.isArray(groups) ? groups : []);
        const standalone = (res as { standalone_files?: DeletedFileRow[] }).standalone_files;
        const list =
          Array.isArray(standalone) && standalone.length > 0
            ? standalone
            : (res as { files?: DeletedFileRow[] }).files;
        const next = Array.isArray(list) ? list : [];
        setDeletedFiles(next);
        return next;
      } catch {
        setDeletedFiles([]);
        return [];
      } finally {
        if (!opts?.silent) setDeletedLoading(false);
      }
    },
    [user]
  );

  useEffect(() => {
    if (filterBy === 'deleted' && user) {
      loadDeletedFiles();
    }
  }, [filterBy, user, loadDeletedFiles]);

  // Folder-aware My Files: sync file list from useFolderSystem
  useEffect(() => {
    if (!useFolderMode) return;
    const mapped = folderSystem.files
      .filter(
        (f) => !isLockedBookmarkFile(f.id, fileIdsInLockedBookmarks, f.in_locked_bookmark)
      )
      .map((f) =>
        mapFileRowToDocument(f, {
          isUserReprocessing: reprocessingFileIdsRef.current.has(f.id),
        }) as Document
      );
    setDocuments(filterPendingTrash(mapped));
    hasMoreRef.current = folderSystem.filesHasMore;
    setHasMore(folderSystem.filesHasMore);
    if (!folderSystem.loading) setLoading(false);
  }, [
    useFolderMode,
    folderSystem.files,
    folderSystem.filesHasMore,
    folderSystem.loading,
    filterPendingTrash,
    fileIdsInLockedBookmarks,
  ]);

  useEffect(() => {
    if (!useFolderMode) return;
    setUploadFolderContext(
      folderSystem.currentFolderId,
      folderSystem.currentFolderWorkspaceId
    );
  }, [
    useFolderMode,
    folderSystem.currentFolderId,
    folderSystem.currentFolderWorkspaceId,
    setUploadFolderContext,
  ]);

  const prevSearchQueryRef = useRef<string | null>(null);

  // Debounced server search — global across all files when query is non-empty
  useEffect(() => {
    if (!useFolderMode) return;
    const q = searchQuery.trim();
    if (prevSearchQueryRef.current === null) {
      prevSearchQueryRef.current = q;
      return;
    }
    if (prevSearchQueryRef.current === q) return;
    prevSearchQueryRef.current = q;
    const timer = setTimeout(() => {
      void folderSystemRef.current.runSearch(q, q ? 'global' : 'current_folder');
    }, 400);
    return () => clearTimeout(timer);
  }, [searchQuery, useFolderMode]);

  const handleSearchQueryChange = useCallback((text: string) => {
    setSearchQuery(text);
  }, []);

  const visibleFolders = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return folderSystem.folders;
    return folderSystem.folders.filter((folder) => folder.name.toLowerCase().includes(q));
  }, [folderSystem.folders, searchQuery]);

  // Memoized filtered and sorted documents for better performance
  const filteredAndSortedDocuments = useMemo(() => {
    if (filterBy === 'deleted') {
      return [];
    }

    let filtered = documents;

    // Hide files that are in a locked bookmark (empty Set = no-op)
    filtered = filtered.filter(
      (doc) =>
        !isLockedBookmarkFile(doc.id, fileIdsInLockedBookmarks, doc.in_locked_bookmark)
    );

    // Apply search filter (client-side only when not using folder-mode server search)
    if (searchQuery.trim() && !useFolderMode) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(doc => 
        (doc.name?.toLowerCase() || '').includes(query) ||
        (doc.category?.toLowerCase() || '').includes(query) ||
        (doc.tags || []).some(tag => (tag?.toLowerCase() || '').includes(query))
      );
    }

    // Apply category filter
    if (filterBy !== 'all') {
      filtered = filtered.filter(doc => {
        if (doc.listKind === 'bookmark') return false;
        // Use file_kind to determine file type (receipt, invoice, document, etc.)
        // doc.category is for receipt categorization (Supplies, Rent, etc.), not file type
        const fileTypeCategory = normalizeCategory(doc.file_kind).toLowerCase();
        switch (filterBy) {
          case 'documents':
            return fileTypeCategory === 'documents';
          case 'receipts':
            return fileTypeCategory === 'receipts';
          case 'forms':
            return fileTypeCategory === 'forms';
          case 'transcripts':
            return fileTypeCategory === 'transcripts';
          case 'invoice':
            return fileTypeCategory === 'invoice';
          case 'meeting_notes':
            return fileTypeCategory === 'meeting_notes';
          case 'meeting_chat':
            return fileTypeCategory === 'meeting_chat';
          case 'meeting_summary':
            return fileTypeCategory === 'meeting_summary';
          case 'draft':
            return fileTypeCategory === 'draft';
          case 'spreadsheet':
            return fileTypeCategory === 'spreadsheet';
          case 'picture':
            return fileTypeCategory === 'picture';
          case 'pending':
            return fileTypeCategory === 'pending' || doc.status === 'pending';
          case 'unknown':
            return fileTypeCategory === 'unknown';
          default:
            return true;
        }
      });
    }

    // Workspace "View Files": include bookmarks shared in this workspace (only when showing All)
    let combined = filtered;
    if (
      workspaceId != null &&
      Number.isFinite(workspaceId) &&
      filterBy === 'all' &&
      workspaceBookmarks.length > 0
    ) {
      const q = searchQuery.trim().toLowerCase();
      const bmRows: Document[] = workspaceBookmarks
        .filter((b: any) => !isBookmarkLocked(b))
        .filter(
          (b: any) => !q || (String(b.name || '').toLowerCase().includes(q))
        )
        .map((b: any) => ({
          id: `bm-${b.id}`,
          name: b.name || 'Bookmark',
          type: 'bookmark',
          size:
            (b.file_count ?? 0) === 1
              ? '1 file'
              : `${b.file_count ?? 0} files`,
          uploadDate: new Date(b.updated_at || b.created_at || Date.now()),
          status: 'processed' as const,
          tags: [] as string[],
          listKind: 'bookmark' as const,
          bookmarkId: b.id,
          bookmarkColor: b.color || '#007AFF',
          bookmarkFileCount: b.file_count ?? 0,
        }));
      combined = [...filtered, ...bmRows];
    }

    // Apply sorting
    // Optimistic files (pending status) should always appear first, then sort by selected criteria
    combined.sort((a, b) => {
        // Always put pending files first
        const aIsPending = isFileKindPending(a.file_kind) || a.status === 'pending';
        const bIsPending = isFileKindPending(b.file_kind) || b.status === 'pending';
        
        if (aIsPending && !bIsPending) return -1; // a comes first
        if (!aIsPending && bIsPending) return 1;  // b comes first
        
        // Both are pending or both are not pending - apply normal sort
        switch (sortBy) {
          case 'name':
            return (a.name || '').localeCompare(b.name || '');
          case 'date':
            return b.uploadDate.getTime() - a.uploadDate.getTime();
          case 'size': {
            const sa =
              a.listKind === 'bookmark'
                ? a.bookmarkFileCount ?? 0
                : parseInt(a.size, 10) || 0;
            const sb =
              b.listKind === 'bookmark'
                ? b.bookmarkFileCount ?? 0
                : parseInt(b.size, 10) || 0;
            return sb - sa;
          }
          case 'type':
            return (a.type || '').localeCompare(b.type || '');
          default:
            return 0;
        }
      });

    return combined;
  }, [documents, searchQuery, filterBy, sortBy, fileIdsInLockedBookmarks, workspaceBookmarks, workspaceId, useFolderMode]);

  /**
   * Fetches IDs of all files that belong to at least one locked bookmark.
   * Results are cached for LOCKED_BOOKMARK_CACHE_MS to avoid N+1 queries on every load.
   * Per-locked-bookmark file fetches are parallelised for speed.
   */
  const fetchLockedBookmarkFileIds = useCallback(async (forceRefresh = false): Promise<Set<string>> => {
    const now = Date.now();

    // Return cached result if still fresh (avoids N+1 on every loadDocuments call)
    if (
      !forceRefresh &&
      lockedBookmarkCacheRef.current &&
      now - lockedBookmarkCacheRef.current.timestamp < LOCKED_BOOKMARK_CACHE_MS &&
      lockedBookmarkCacheRef.current.scopeWorkspaceId === workspaceId &&
      lockedBookmarkCacheRef.current.userId === user?.id
    ) {
      const cachedIds = lockedBookmarkCacheRef.current.fileIds;
      setBookmarks(lockedBookmarkCacheRef.current.bookmarks);
      lockedFileIdsRef.current = cachedIds;
      setFileIdsInLockedBookmarks(cachedIds);
      return cachedIds;
    }

    try {
      const allBookmarks: any[] = [];
      let bmOffset = 0;
      const bmPage = 100;
      for (;;) {
        const response = await apiClient.getBookmarks(
          bmPage,
          bmOffset,
          workspaceId != null && Number.isFinite(workspaceId) ? workspaceId : undefined
        );
        if (!response.success || !response.data) break;
        const batch = Array.isArray(response.data)
          ? response.data
          : (response.data as any).bookmarks || [];
        allBookmarks.push(...batch);
        const pag = (response as any).pagination;
        const hasMore = pag?.has_more === true || (pag?.has_more !== false && batch.length >= bmPage);
        if (!hasMore || batch.length === 0) break;
        bmOffset += bmPage;
      }

      setBookmarks(allBookmarks);

      const locked = allBookmarks.filter(isBookmarkLocked);

      // Fetch all locked bookmarks' file lists in parallel (fixes N+1)
      const fileIdArrays = await Promise.all(
        locked.map(async (b) => {
          const ids: string[] = [];
          let fOffset = 0;
          const fLimit = 100;
          for (;;) {
            try {
              const fr = await apiClient.getBookmarkFiles(b.id, { limit: fLimit, offset: fOffset });
              const files = (fr as any).data ?? (fr as any).files ?? [];
              const arr = Array.isArray(files) ? files : [];
              arr.forEach((f: any) => {
                const id = f.id ?? f.file_id ?? f.document_id ?? f.fileId;
                if (id != null && id !== '') ids.push(String(id));
              });
              const fpag = (fr as any).pagination;
              const more =
                fpag?.has_more === true ||
                (fpag?.has_more !== false && arr.length >= fLimit);
              if (!more || arr.length === 0) break;
              fOffset += fLimit;
            } catch {
              break;
            }
          }
          return ids;
        })
      );

      const lockedFileIds = new Set<string>(fileIdArrays.flat());

      lockedBookmarkCacheRef.current = {
        fileIds: lockedFileIds,
        bookmarks: allBookmarks,
        timestamp: now,
        scopeWorkspaceId: workspaceId,
        userId: user?.id,
      };
      lockedFileIdsRef.current = lockedFileIds;
      setFileIdsInLockedBookmarks(lockedFileIds);
      return lockedFileIds;
    } catch {
      return new Set();
    }
  }, [workspaceId, user?.id]);

  // Folder mode loads via getWebFiles — fetch locked-bookmark membership separately.
  useEffect(() => {
    if (!user || !useFolderMode) return;
    void fetchLockedBookmarkFileIds();
  }, [user, useFolderMode, workspaceId, fetchLockedBookmarkFileIds]);

  // Optimized loadDocuments function with caching
  const loadDocuments = useCallback(async (
    forceRefresh = false,
    pageToLoad = 1,
    append = false,
    silent = false
  ) => {
    if (append && (!hasMoreRef.current || loadingMoreRef.current)) return;
    if (isLoadingDocumentsRef.current) return;

    const currentFilterBy = filterByRef.current;
    const isFormsMode = currentFilterBy === 'forms';
    const isFolderPersonalMode =
      workspaceId == null && currentFilterBy !== 'forms' && currentFilterBy !== 'deleted';

    if (isFolderPersonalMode) {
      isLoadingDocumentsRef.current = true;
      try {
        if (append) {
          loadingMoreRef.current = true;
          setLoadingMore(true);
          await folderSystemRef.current.loadMoreFiles();
        } else if (forceRefresh) {
          // Explicit force — bypass folder TTL cache.
          if (!silent) setLoading(true);
          await folderSystemRef.current.syncFromServer({ silent });
        } else {
          // Tab-switch / debounced reload — respect the 60-second folder cache so we
          // don't fire a network request if the data is still fresh.
          if (!silent) setLoading(true);
          await folderSystemRef.current.loadFolderView(
            folderSystemRef.current.currentFolderId,
            { silent }
          );
        }
      } catch (err) {
        console.error('Folder sync failed:', err);
      } finally {
        loadingMoreRef.current = false;
        setLoadingMore(false);
        if (!silent) setLoading(false);
        isLoadingDocumentsRef.current = false;
      }
      return;
    }

    const now = Date.now();

    // Check ref-based cache (avoids stale-closure issues of state-based cache)
    const cache = apiCacheRef.current;
    if (
      !append &&
      !forceRefresh &&
      cache &&
      cache.userId === user?.id &&
      now - cache.timestamp < CACHE_DURATION &&
      cache.isFormsMode === isFormsMode &&
      cache.workspaceId === workspaceId
    ) {
      console.log('📁 Using cached documents for workspaceId:', workspaceId);
      const filtered = filterPendingTrash(
        cache.data.filter((doc) => !lockedFileIdsRef.current.has(doc.id))
      );
      setDocuments(filtered);
      setWorkspaceBookmarks(cache.workspaceBookmarks ?? []);
      setLoading(false);
      return;
    }

    isLoadingDocumentsRef.current = true;
    setError(null);
    if (append) {
      loadingMoreRef.current = true;
      setLoadingMore(true);
    } else if (!silent) {
      setLoading(true);
    }

    // Fetch locked bookmark file IDs and documents in parallel so we never show
    // locked files — avoids the flash of locked files appearing then disappearing.
    // The locked-bookmark fetch is internally cached (LOCKED_BOOKMARK_CACHE_MS).
    const fetchDocumentsResponse = async () => {
      if (isFormsMode) {
        return apiClient.getForms();
      }
      if (workspaceId != null) {
        return apiClient.getWorkspaceFiles(workspaceId, {
          page: pageToLoad,
          perPage: MOBILE_FILES_PAGE_SIZE,
          offset: (pageToLoad - 1) * MOBILE_FILES_PAGE_SIZE,
        });
      }
      try {
        console.log('📁 Loading documents (no workspace)');
        // Longer than default 25s — slow DB / background work on server can exceed axios default
        const FILES_LIST_TIMEOUT_MS = 60000;
        const res = await apiClient.getDocuments(
          pageToLoad,
          MOBILE_FILES_PAGE_SIZE,
          undefined,
          undefined,
          undefined,
          false,
          false,
          FILES_LIST_TIMEOUT_MS
        );
        console.log('📁 Documents response received:', res?.success, 'Files count:', (res as any)?.data?.length || (res as any)?.files?.length || 0);
        return res;
      } catch (err) {
        console.warn('Documents endpoint failed, trying files endpoint:', err);
        return apiClient.getFiles(pageToLoad, MOBILE_FILES_PAGE_SIZE, undefined, undefined);
      }
    };

    let response: any;
    let lockedFileIds = new Set<string>();
    let workspaceBookmarksPayload: any[] = [];
    try {
      // Forms list does not filter by locked bookmarks — skip that slow multi-request sweep here.
      if (isFormsMode) {
        response = await fetchDocumentsResponse();
        setWorkspaceBookmarks([]);
      } else {
        const wsId =
          workspaceId != null && Number.isFinite(workspaceId) ? workspaceId : undefined;
        // For infinite-scroll pagination, avoid repeating expensive bookmark sweeps.
        // Reuse the cached locked IDs/workspace bookmarks from the initial load.
        if (append && !forceRefresh) {
          lockedFileIds = lockedFileIdsRef.current;
          response = await fetchDocumentsResponse();
          if (wsId == null) {
            workspaceBookmarksPayload = [];
          } else {
            workspaceBookmarksPayload = workspaceBookmarks;
          }
          setWorkspaceBookmarks(workspaceBookmarksPayload);
        } else {
          // Do not await locked-bookmark sweep: it can be many requests and was blocking first paint.
          // Use cached/stale locked IDs for this response; refresh in background and filter when ready.
          const bookmarksPromise =
            wsId != null
              ? apiClient.getBookmarks(100, 0, wsId)
              : Promise.resolve({ success: false } as const);
          let docsRes: any;
          let bmRes: any;
          if (wsId != null) {
            [docsRes, bmRes] = await Promise.all([
              fetchDocumentsResponse(),
              bookmarksPromise,
            ]);
          } else {
            docsRes = await fetchDocumentsResponse();
            bmRes = { success: false } as const;
          }
          lockedFileIds = lockedFileIdsRef.current;
          response = docsRes;
          if (wsId == null) {
            workspaceBookmarksPayload = [];
          } else if (bmRes && (bmRes as any).success && (bmRes as any).data) {
            const raw = (bmRes as any).data;
            workspaceBookmarksPayload = Array.isArray(raw)
              ? raw
              : ((raw as any).bookmarks || []);
          } else {
            workspaceBookmarksPayload = [];
          }
          setWorkspaceBookmarks(workspaceBookmarksPayload);

          void fetchLockedBookmarkFileIds(forceRefresh).then((ids) => {
            lockedFileIdsRef.current = ids;
            setFileIdsInLockedBookmarks(ids);
            setDocuments((prev) => prev.filter((d) => !ids.has(d.id)));
          });
        }
      }
    } catch (err) {
      isLoadingDocumentsRef.current = false;
      setLoading(false);
      if (isFormsMode) {
        console.error('Forms endpoint failed:', err);
        throw err;
      }
      if (workspaceId != null) {
        console.error('Workspace files endpoint failed:', err);
        throw err;
      }
      console.error('Documents endpoint failed:', err);
      throw err;
    }

    try {
      
      // Handle forms data differently from documents
      if (isFormsMode) {
        const formsArray = (response as any).forms || (response as any).data || [];
        if (Array.isArray(formsArray)) {
          const mappedForms = formsArray.map((form: any) => {
            return {
              id: String(form.id),
              name: form.name || form.title || 'Untitled Form',
              type: 'form' as const,
              size: `Form • ${form.response_count || 0} responses`,
              uploadDate: new Date(form.created_at || form.updated_at),
              status: 'processed' as const,
              tags: [],
              category: 'forms' as const,
              formData: form,
              responseCount: form.response_count || 0,
            };
          });
          
          setDocuments(mappedForms);
          currentPageRef.current = 1;
          setCurrentPage(1);
          hasMoreRef.current = false;
          setHasMore(false);
          setLastLoadTime(now);
          
          apiCacheRef.current = {
            data: mappedForms,
            timestamp: now,
            isFormsMode: true,
            workspaceId,
            workspaceBookmarks: [],
            userId: user?.id,
          };
        } else {
          setDocuments([]);
          setError('No forms found or API returned unexpected format.');
        }
      } else {
        // Handle documents data (non-forms)
        if ((response as { timedOut?: boolean })?.timedOut) {
          if (!append) {
            setError(
              "Couldn't refresh — request timed out. Pull down to try again."
            );
          }
          // Same as chats @-mention cache: do not replace the list with an empty timed-out response
        } else {
        const docsArray = (response as any).data || (response as any).files || (response as any).documents || [];
        if (Array.isArray(docsArray)) {
          const mappedDocs = docsArray
            .filter((doc: ApiDocument) => !lockedFileIds.has(String(doc.id)))
            .filter((doc: ApiDocument) => {
              if (doc.is_deleted === true) return false;
              const ls = (doc.lifecycle_state || '').toLowerCase();
              if (ls === 'deleted') return false;
              return true;
            })
            .map((doc: ApiDocument) => {
              const originalName = doc.original_filename || doc.filename || 'Untitled';
              const fallbackName = removeFileExtension(originalName);
              // For receipt: show store name; for invoice: show vendor name
              let displayName = fallbackName;
              const kind = doc.file_kind?.toLowerCase();
              const data = doc.json_data && typeof doc.json_data === 'object' ? doc.json_data as Record<string, unknown> : null;
              if (kind === 'receipt' && data) {
                const storeName = (data.store_name || data.business_name || data.merchant_name ||
                  (data.receipt_data && typeof data.receipt_data === 'object' && (data.receipt_data as Record<string, unknown>).store_name)) as string | undefined;
                if (storeName && String(storeName).trim()) displayName = String(storeName).trim();
              } else if (kind === 'invoice' && data) {
                const vendorName = (data.vendor_name || data.business_name || data.store_name ||
                  (data.invoice_data && typeof data.invoice_data === 'object' && (data.invoice_data as Record<string, unknown>).vendor_name)) as string | undefined;
                if (vendorName && String(vendorName).trim()) displayName = String(vendorName).trim();
              }
              // Total amount for receipt/invoice (from json_data)
              let totalAmount: number | undefined;
              if ((kind === 'receipt' || kind === 'invoice') && data) {
                const amt = data.total_amount ?? data.amount ?? data.total ?? (data as Record<string, unknown>).invoice_amount;
                if (typeof amt === 'number' && !Number.isNaN(amt)) totalAmount = amt;
                else if (typeof amt === 'string') {
                  const parsed = parseFloat(amt.replace(/[^0-9.-]/g, ''));
                  if (!Number.isNaN(parsed)) totalAmount = parsed;
                }
              }
              const fileIdNum = Number(doc.id);
              const status = resolveDocumentListStatus(doc, {
                isUserReprocessing:
                  Number.isFinite(fileIdNum) &&
                  reprocessingFileIdsRef.current.has(fileIdNum),
              });
              
              return {
                id: String(doc.id),
                name: displayName,
                type: getFileTypeFromExtension(doc.original_filename || doc.filename),
                size: formatFileSize(doc.file_size),
                uploadDate: new Date(doc.created_at),
                status: status,
                tags: [],
                category: doc.receipt_category || undefined,
                file_kind: doc.file_kind,
                totalAmount,
                is_global: doc.is_global,
                json_data: doc.json_data,
                original_filename: doc.original_filename || doc.filename,
                user_id: doc.user_id ?? (doc as any).owner?.id,
              };
            });

          const pagination = (response as any)?.pagination;
          const hasMoreFromApi =
            (response as any)?.has_more === true ||
            (response as any)?.next_offset != null ||
            pagination?.has_more === true ||
            (pagination?.has_more !== false && docsArray.length >= MOBILE_FILES_PAGE_SIZE);

          if (append) {
            const mappedFiltered = filterPendingTrash(mappedDocs);
            setDocuments((prev) => {
              const existingIds = new Set(prev.map((doc) => doc.id));
              const next = mappedFiltered.filter((doc) => !existingIds.has(doc.id));
              return [...prev, ...next];
            });
          } else {
            setDocuments(filterPendingTrash(mappedDocs));
          }
          currentPageRef.current = pageToLoad;
          setCurrentPage(pageToLoad);
          hasMoreRef.current = Boolean(hasMoreFromApi);
          setHasMore(Boolean(hasMoreFromApi));
          setLastLoadTime(now);

          if (!append && pageToLoad === 1) {
            apiCacheRef.current = {
              data: mappedDocs,
              timestamp: now,
              isFormsMode: false,
              workspaceId,
              workspaceBookmarks:
                workspaceId != null && Number.isFinite(workspaceId)
                  ? workspaceBookmarksPayload
                  : [],
              userId: user?.id,
            };
          }
        } else {
          setDocuments([]);
          setError('No documents found or API returned unexpected format.');
        }
        }
      }
    } catch (err: any) {
      console.error('Unexpected error in loadDocuments:', err);
      setDocuments([]);
      setWorkspaceBookmarks([]);
      if (err.message?.includes('CORS') || err.message?.includes('Network error') || err.message?.toLowerCase().includes('backend') || err.message?.toLowerCase().includes('connection')) {
        setError('Connection Error: Connecting you back ...');
      } else {
        setError(`Failed to load documents: ${err.message}`);
      }
    } finally {
      isLoadingDocumentsRef.current = false;
      loadingMoreRef.current = false;
      setLoadingMore(false);
      if (!silent) setLoading(false);
    }
  }, [workspaceId, fetchLockedBookmarkFileIds, filterPendingTrash, MOBILE_FILES_PAGE_SIZE]);

  // When connection error is shown, retry so it clears as soon as connection is back
  const CONNECTION_ERROR_MSG = 'Connection Error: Connecting you back ...';
  useEffect(() => {
    if (error !== CONNECTION_ERROR_MSG) return;
    const CONNECTION_RETRY_MS = 2000;
    const id = setInterval(async () => {
      try {
        const result = await apiClient.checkAuth();
        if (result?.success) {
          setError(null);
          loadDocuments(true);
        }
      } catch {
        // still offline, keep retrying
      }
    }, CONNECTION_RETRY_MS);
    return () => clearInterval(id);
  }, [error, loadDocuments]);

  // Re-read params and reload when screen comes into focus (must be after loadDocuments is defined)
  useFocusEffect(
    useCallback(() => {
      const currentWorkspaceId = params.workspaceId ? Number(params.workspaceId) : undefined;
      console.log('📁 Documents screen focused - workspaceId from params:', params.workspaceId, 'parsed:', currentWorkspaceId);
      if (user) {
        const now = Date.now();
        const fileStore = useFileStore.getState();
        const globalUploadTime = fileStore.lastUploadTime || 0;
        const timeSinceUpload = Math.min(
          now - lastUploadTimeRef.current,
          globalUploadTime > 0 ? now - globalUploadTime : Infinity
        );
        const timeSinceLastLoad = now - lastLoadTimeRef.current;
        if (timeSinceUpload < 5000 || timeSinceLastLoad > RELOAD_DEBOUNCE_MS) {
          lastLoadTimeRef.current = now;
          const isPostUpload = timeSinceUpload < 5000;
          // Only wipe the cache when there was a recent upload — for a normal tab-switch let the
          // 30-second cache serve the data instantly.
          if (isPostUpload) apiCacheRef.current = null;
          loadDocuments(isPostUpload);
        }
      }

      // Leaving Files: drop sticky workspace filter so the personal library is restored next visit.
      // (e.g. older navigations that pushed workspaceId onto this tab.)
      return () => {
        if (params.workspaceId != null && String(params.workspaceId).length > 0) {
          router.setParams({ workspaceId: '', fileId: '' });
        }
      };
    }, [params.workspaceId, user, loadDocuments, lastUploadTime, router])
  );

  const getFileTypeFromExtension = (filename: string | null | undefined): string => {
    if (!filename || typeof filename !== 'string') {
      return 'other';
    }
    
    const ext = filename.toLowerCase().split('.').pop();
    if (!ext) return 'other';
    
    // PDF files
    if (ext === 'pdf') return 'pdf';
    
    // Word documents
    if (['doc', 'docx'].includes(ext)) return 'docx';
    
    // Excel spreadsheets
    if (['xls', 'xlsx'].includes(ext)) return 'xlsx';
    
    // PowerPoint presentations
    if (['ppt', 'pptx'].includes(ext)) return 'pptx';
    
    // Text files
    if (['txt', 'rtf', 'md'].includes(ext)) return 'txt';
    
    // Image files
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'heic', 'heif'].includes(ext)) return 'image';
    
    return 'other';
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  // Merge optimistic placeholder rows (from in-flight uploads) at the top of the list
  // (must be after getFileTypeFromExtension / formatFileSize — defined above)
  const documentsWithPending = useMemo<Document[]>(() => {
    if (filterBy === 'deleted') {
      return [];
    }
    const placeholders: Document[] = pendingUploads.map((u) => ({
      id: u.id,
      name: u.name,
      type: getFileTypeFromExtension(u.name),
      size: u.size ? formatFileSize(u.size) : 'Uploading...',
      uploadDate: new Date(),
      status: 'pending' as const,
      tags: [],
    }));
    // Avoid two rows (optimistic + server pending) with the same display name briefly showing duplicate spinners
    const pendingNameKeys = new Set(pendingUploads.map((u) => u.name.trim().toLowerCase()));
    const withoutDupServerPending = filteredAndSortedDocuments.filter((doc) => {
      if (!isFileKindPending(doc.file_kind) && doc.status !== 'processing') return true;
      return !pendingNameKeys.has(doc.name.trim().toLowerCase());
    });
    return [...placeholders, ...withoutDupServerPending];
  }, [pendingUploads, filteredAndSortedDocuments, filterBy]);

  // Hand off optimistic upload rows once the server row is in the list (no spinner gap).
  useEffect(() => {
    if (pendingUploads.length === 0 || filterBy === 'deleted') return;

    const matchesPendingName = (pendingName: string, docName: string) => {
      const pendingKey = pendingName.trim().toLowerCase();
      const docKey = docName.trim().toLowerCase();
      if (pendingKey === docKey) return true;
      // HEIC→PNG (or other ext) rename: compare basenames
      const pendingBase = pendingKey.replace(/\.[^.]+$/, '');
      const docBase = docKey.replace(/\.[^.]+$/, '');
      return !!pendingBase && pendingBase === docBase;
    };

    const HANDOFF_SKEW_MS = 15_000;
    const { removePendingUpload } = useFileStore.getState();
    for (const pending of pendingUploads) {
      // Keep the placeholder while the upload is still in flight.
      if (!pending.settled) continue;

      const createdAt = pending.createdAt ?? 0;
      const matched = filteredAndSortedDocuments.some((doc) => {
        if (!matchesPendingName(pending.name, doc.name)) return false;
        // New upload still classifying — safe handoff target.
        if (
          isFileKindPending(doc.file_kind) ||
          doc.status === 'processing' ||
          doc.status === 'pending'
        ) {
          return true;
        }
        // Classification finished before reload: only accept rows created around this upload
        // so an older same-named file does not clear the spinner early.
        const uploadedAt =
          doc.uploadDate instanceof Date
            ? doc.uploadDate.getTime()
            : Date.parse(String(doc.uploadDate));
        return Number.isFinite(uploadedAt) && uploadedAt >= createdAt - HANDOFF_SKEW_MS;
      });

      if (matched) {
        removePendingUpload(pending.id);
      }
    }
  }, [pendingUploads, filteredAndSortedDocuments, filterBy]);

  const filteredDeletedFiles = useMemo(() => {
    if (!searchQuery.trim()) return deletedFiles;
    const q = searchQuery.toLowerCase().trim();
    return deletedFiles.filter(
      (f) =>
        (f.original_filename || '').toLowerCase().includes(q) ||
        (f.file_kind || '').toLowerCase().includes(q) ||
        (f.file_type || '').toLowerCase().includes(q)
    );
  }, [deletedFiles, searchQuery]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    if (filterByRef.current === 'deleted') {
      await loadDeletedFiles();
      setRefreshing(false);
      return;
    }
    currentPageRef.current = 1;
    setCurrentPage(1);
    hasMoreRef.current = true;
    setHasMore(true);
    await loadDocuments(true, 1, false);
    setRefreshing(false);
  }, [loadDocuments, loadDeletedFiles]);

  const openAiFileManager = useCallback(async () => {
    let ws = workspaceId ?? folderSystem.currentFolderWorkspaceId ?? null;
    if (ws == null) {
      ws = await apiClient.resolveEffectiveWorkspaceId({
        folderId: folderSystem.currentFolderId,
        explicitWorkspaceId: workspaceId,
      });
    }
    setAiFmWorkspaceId(ws);
    setShowAiFmSheet(true);
    setAiFmExpandNonce((n) => n + 1);
  }, [workspaceId, folderSystem.currentFolderId, folderSystem.currentFolderWorkspaceId]);

  const onFmExecuted = useCallback(async () => {
    if (filterByRef.current !== 'forms' && filterByRef.current !== 'deleted') {
      await folderSystem.syncFromServer();
    } else {
      currentPageRef.current = 1;
      setCurrentPage(1);
      await loadDocuments(true, 1, false);
    }
  }, [folderSystem, loadDocuments]);

  const onEndReached = useCallback(async () => {
    if (onEndReachedCalledDuringMomentumRef.current) return;
    onEndReachedCalledDuringMomentumRef.current = true;
    if (loading || refreshing || loadingMoreRef.current || !hasMoreRef.current) return;
    await loadDocuments(false, currentPageRef.current + 1, true);
  }, [loading, refreshing, loadDocuments]);

  useEffect(() => {
    if (user) {
      loadDocuments(true); // Force refresh when workspaceId changes
    }
  }, [user, workspaceId, loadDocuments]);

  // Monitor document status changes to show completion indicators
  useEffect(() => {
    documents.forEach(doc => {
      // If a document was previously processing and is now processed, mark it as recently completed
      if (doc.status === 'processed') {
        // For now, we'll assume all loaded documents are processed
        // In a real implementation, you'd track the previous status
        // This is a simplified version
      }
    });
  }, [documents]);

  // Auto-refresh documents periodically when user is authenticated
  useEffect(() => {
    if (!user) return;

    const interval = setInterval(async () => {
      // Skip the 60s refresh when the faster 3s classification poll is already running
      if (classificationPollingIntervalRef.current) return;
      console.log('🔄 Auto-refreshing documents...');
      setIsAutoRefreshing(true);
      await loadDocuments(true, 1, false, true); // Force refresh without loading UI
      setTimeout(() => setIsAutoRefreshing(false), 1000); // Show indicator for 1 second
    }, AUTO_REFRESH_INTERVAL);

    return () => clearInterval(interval);
  }, [user, loadDocuments]);

  // Polling for pending files (classification polling)
  const hasPendingFiles = useMemo(() => {
    return documents.some(docNeedsClassificationPoll);
  }, [documents, docNeedsClassificationPoll]);

  useEffect(() => {
    if (!hasPendingFiles) {
      if (classificationPollingIntervalRef.current) {
        console.log('🛑 No pending files, stopping classification polling');
        clearInterval(classificationPollingIntervalRef.current);
        classificationPollingIntervalRef.current = null;
      }
      return;
    }

    if (classificationPollingIntervalRef.current) return;

    console.log('🔄 Starting classification polling for pending files and receipts/invoices without json_data...');
    classificationPollCountRef.current = 0;
    classificationPollingIntervalRef.current = setInterval(async () => {
      classificationPollCountRef.current += 1;
      if (classificationPollCountRef.current > 60) {
        console.warn('⏰ Classification polling reached max poll limit (60), stopping to prevent infinite loop');
        clearInterval(classificationPollingIntervalRef.current!);
        classificationPollingIntervalRef.current = null;
        return;
      }
      try {
        await loadDocuments(true, 1, false, true);
        setDocuments((currentDocs) => {
          const stillPending = currentDocs.some(docNeedsClassificationPoll);
          if (!stillPending && classificationPollingIntervalRef.current) {
            console.log('✅ All files processed and json_data populated, stopping classification polling');
            clearInterval(classificationPollingIntervalRef.current);
            classificationPollingIntervalRef.current = null;
          }
          return currentDocs;
        });
      } catch (pollError) {
        console.error('Error polling for file updates:', pollError);
      }
    }, 3000);

    return () => {
      if (classificationPollingIntervalRef.current) {
        clearInterval(classificationPollingIntervalRef.current);
        classificationPollingIntervalRef.current = null;
      }
    };
  }, [hasPendingFiles, loadDocuments, docNeedsClassificationPoll]);

  const handleDocumentPress = async (document: Document) => {
    if (document.listKind === 'bookmark' && document.bookmarkId != null) {
      router.push({
        pathname: '/bookmarks/detail',
        params: { id: String(document.bookmarkId) },
      } as any);
      return;
    }

    if (document.status === 'processing' || document.status === 'pending') {
      Alert.alert('Document Processing', `"${document.name}" is still being processed. Please wait a few moments and try again.`);
      return;
    }

    // Remove green dot if file was recently completed
    if (document.status === 'processed' && recentlyCompletedFiles.has(document.id)) {
      setRecentlyCompletedFiles(prev => {
        const newSet = new Set(prev);
        newSet.delete(document.id);
        return newSet;
      });
    }

    // If the document is a draft, open draft editor
    if ((document.file_kind || '').toString().toLowerCase() === 'draft') {
      (router.push as (path: string) => void)(`/drafts/edit/${document.id}`);
      return;
    }

    // If the document is a form (either by type or category), open quick form viewer
    if (
      document.type === 'form' ||
      document.category?.toLowerCase() === 'form' ||
      document.category?.toLowerCase() === 'forms'
    ) {
      // Open quick form viewer instead of form builder
      setSelectedDocument(document);
      setShowQuickFormViewer(true);
      return;
    }

    // If the document is a transcript, show transcript viewer
    if (
      document.category?.toLowerCase() === 'transcript' ||
      document.category?.toLowerCase() === 'transcripts'
    ) {
      // For now, open in document viewer - can be enhanced later with transcript-specific viewer
      setSelectedDocument(document);
      setShowDocumentViewer(true);
      return;
    }

    setSelectedDocument(document);
    setShowDocumentViewer(true);
  };

  const handleKebabMenuPress = (document: Document, event: any) => {
    // Remove green dot if file was recently completed
    if (document.status === 'processed' && recentlyCompletedFiles.has(document.id)) {
      setRecentlyCompletedFiles(prev => {
        const newSet = new Set(prev);
        newSet.delete(document.id);
        return newSet;
      });
    }

    setSelectedDocumentForMenu(document);
    setShowKebabMenu(true);
    // Warm the share cache while the user reads the menu — Share sheet opens immediately on tap.
    prefetchShareDocumentFile(document.id, document.name);
  };

  const handleViewDocument = () => {
    if (selectedDocumentForMenu) {
      if ((selectedDocumentForMenu.file_kind || '').toString().toLowerCase() === 'draft') {
        setShowKebabMenu(false);
        (router.push as (path: string) => void)(`/drafts/edit/${selectedDocumentForMenu.id}`);
        return;
      }
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

  const handleDeleteDocument = () => {
    if (!selectedDocumentForMenu) return;
    const docToRemove = selectedDocumentForMenu;

    Alert.alert(
      'Move this file to trash?',
      'You can restore it within 30 days from the Deleted tab.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Move to trash',
          style: 'destructive',
          onPress: () => {
            const idStr = String(docToRemove.id);
            apiCacheRef.current = null;
            pendingMoveToTrashIdsRef.current.add(idStr);
            setShowKebabMenu(false);
            setSelectedDocumentForMenu(null);
            setDocuments((prev) => prev.filter((d) => String(d.id) !== idStr));

            const waitForLoadSlot = async (maxMs = 12000) => {
              const step = 100;
              let waited = 0;
              while (isLoadingDocumentsRef.current && waited < maxMs) {
                await new Promise((r) => setTimeout(r, step));
                waited += step;
              }
            };

            void (async () => {
              try {
                const response = await apiClient.deleteFile(parseInt(idStr, 10));
                if (response && typeof response === 'object' && response.success === false) {
                  pendingMoveToTrashIdsRef.current.delete(idStr);
                  await waitForLoadSlot();
                  await loadDocuments(true, 1, false);
                  Alert.alert('Error', response.message || 'Could not move to trash');
                  return;
                }
                await waitForLoadSlot();
                await loadDocuments(true, 1, false);
                pendingMoveToTrashIdsRef.current.delete(idStr);
              } catch (error: any) {
                pendingMoveToTrashIdsRef.current.delete(idStr);
                await waitForLoadSlot();
                await loadDocuments(true, 1, false);
                Alert.alert('Error', toAlertMessage(error?.message, 'Could not move to trash'));
              }
            })();
          },
        },
      ]
    );
  };

  const handleCloseKebabMenu = () => {
    setShowKebabMenu(false);
    setSelectedDocumentForMenu(null);
  };

  const handleRenameDocument = () => {
    if (!selectedDocumentForMenu) return;
    const name = selectedDocumentForMenu.name || selectedDocumentForMenu.original_filename || '';
    const nameWithoutExt = name.replace(/\.[^/.]+$/, '');
    setRenameInputValue(nameWithoutExt);
    setShowKebabMenu(false);
    setShowRenameModal(true);
  };

  const handleSubmitRename = async () => {
    if (!selectedDocumentForMenu || !renameInputValue.trim()) return;
    const name = selectedDocumentForMenu.name || selectedDocumentForMenu.original_filename || '';
    const ext = name.match(/\.[^/.]+$/)?.[0] || '';
    const finalFilename = renameInputValue.trim() + ext;
    if (finalFilename === name) {
      setShowRenameModal(false);
      return;
    }
    setRenaming(true);
    try {
      const response = await apiClient.renameFile(parseInt(selectedDocumentForMenu.id), finalFilename);
      if (response.success) {
        setDocuments(prev => prev.map(doc =>
          doc.id === selectedDocumentForMenu.id ? { ...doc, name: finalFilename } : doc
        ));
        setShowRenameModal(false);
        setSelectedDocumentForMenu(null);
        Alert.alert('Success', 'File renamed successfully.');
      } else {
        Alert.alert('Error', (response as any).message || 'Failed to rename file');
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to rename file');
    } finally {
      setRenaming(false);
    }
  };

  const handleViewFormResponses = () => {
    if (!selectedDocumentForMenu) return;
    
    // Navigate to form builder responses tab
    router.push(`/forms/builder?formId=${selectedDocumentForMenu.id}&formName=${encodeURIComponent(selectedDocumentForMenu.name)}&tab=responses`);
    setShowKebabMenu(false);
  };

  const handleChatDocument = () => {
    if (!selectedDocumentForMenu) return;
    openChatGD({
      fileId: String(selectedDocumentForMenu.id),
      fileName: selectedDocumentForMenu.name || '',
      ...(workspaceId ? { workspaceId: String(workspaceId) } : {}),
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
        // Update the document in the local state
        setDocuments(prev => prev.map(doc => 
          doc.id === selectedDocumentForMenu.id ? { ...doc, category } : doc
        ));
        setShowCategoryModal(false);
        setSelectedDocumentForMenu(null);
        // Reload documents to get updated data
        loadDocuments(true);
      } else {
        Alert.alert('Error', response.message || 'Failed to categorize receipt');
      }
    } catch (error) {
      console.error('Error categorizing receipt:', error);
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
        // Reload documents to get updated data
        loadDocuments(true);
      } else {
        Alert.alert('Error', response.message || 'Failed to update payment status');
      }
    } catch (error) {
      console.error('Error updating payment status:', error);
      Alert.alert('Error', 'Failed to update payment status');
    } finally {
      setUpdatingPaymentStatus(false);
    }
  };

  const loadBookmarks = async () => {
    try {
      const response = await apiClient.getBookmarks();
      if (response.success && response.data) {
        // Handle both response structures: data.bookmarks or data as array
        const bookmarksData = Array.isArray(response.data) 
          ? response.data 
          : (response.data.bookmarks || []);
        
        console.log('Bookmarks loaded:', bookmarksData.length);
        setBookmarks(bookmarksData);
      } else {
        console.log('Failed to load bookmarks:', response.message);
        setBookmarks([]);
      }
    } catch (error) {
      console.log('Error loading bookmarks:', error);
      setBookmarks([]);
    }
  };

  const handleAddToBookmark = async (bookmark: any) => {
    if (!selectedDocumentForMenu) return;

    try {
      const response = await apiClient.addFileToBookmark(bookmark.id, parseInt(selectedDocumentForMenu.id));
      if (response.success) {
        // Invalidate locked-bookmark cache so next load re-fetches membership
        lockedBookmarkCacheRef.current = null;
        Alert.alert('Success', `"${selectedDocumentForMenu.name}" added to "${bookmark.name}"`);
        setShowBookmarkModal(false);
        setShowKebabMenu(false);
      } else {
        Alert.alert('Error', response.message || 'Failed to add file to bookmark');
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to add file to bookmark');
    }
  };

  const handleCreateNewBookmarkAndAddFile = async () => {
    if (!selectedDocumentForMenu) return;
    const name = newBookmarkName.trim();
    if (!name) {
      Alert.alert('Error', 'Please enter a bookmark name');
      return;
    }
    setCreatingBookmark(true);
    try {
      const createResponse = await apiClient.createBookmark({
        name,
        color: newBookmarkColor,
      });
      if (!createResponse.success) {
        Alert.alert('Error', createResponse.message || 'Failed to create bookmark');
        setCreatingBookmark(false);
        return;
      }
      const newBookmark = (createResponse as any).data ?? (createResponse as any).bookmark;
      const newId = newBookmark?.id ?? newBookmark?.bookmark_id;
      if (newId == null) {
        Alert.alert('Error', 'Bookmark created but could not add file. Please add it from the bookmark.');
        setShowBookmarkModal(false);
        setNewBookmarkName('');
        setCreatingBookmark(false);
        loadBookmarks();
        return;
      }
      const addResponse = await apiClient.addFileToBookmark(newId, parseInt(selectedDocumentForMenu.id));
      if (addResponse.success) {
        // Invalidate locked-bookmark cache so next load re-fetches membership
        lockedBookmarkCacheRef.current = null;
        Alert.alert('Success', `"${selectedDocumentForMenu.name}" added to new bookmark "${name}"`);
        setShowBookmarkModal(false);
        setShowKebabMenu(false);
        setNewBookmarkName('');
        setNewBookmarkColor('#007AFF');
        loadBookmarks();
      } else {
        Alert.alert('Success', `Bookmark "${name}" created. Could not add file: ${addResponse.message || 'Please add it from the bookmark.'}`);
        setShowBookmarkModal(false);
        setNewBookmarkName('');
        loadBookmarks();
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to create bookmark');
    } finally {
      setCreatingBookmark(false);
    }
  };

  const handleShowBookmarkModal = () => {
    loadBookmarks();
    setNewBookmarkName('');
    setNewBookmarkColor('#007AFF');
    setShowBookmarkModal(true);
    setShowKebabMenu(false);
  };

  const handleEditAsDraft = async () => {
    const doc = selectedDocumentForMenu;
    if (!doc) return;

    // If it's already a Draft, navigate to edit
    if (doc.file_kind?.toLowerCase() === 'draft') {
      setShowKebabMenu(false);
      router.push(`/drafts/edit/${doc.id}`);
      return;
    }
    
    // Check if file is editable
    if (!isEditableTextFormat(doc)) {
      Alert.alert('Not Editable', 'This file format cannot be edited as Note. Supported formats: .txt, .doc, .docx, .md, .log, .csv, .json');
      return;
    }
    
    // Check processing status
    if (doc.status === 'processing' || doc.status === 'pending') {
      Alert.alert('File Processing', 'Please wait for the file to finish processing before editing as Note.');
      return;
    }
    
    try {
      const res = await apiClient.createDraft(Number(doc.id));
      if ((res as any)?.success && (res as any)?.draft?.id) {
        const draftId = (res as any).draft.id;
        setShowKebabMenu(false);
        router.push(`/drafts/edit/${draftId}`);
      } else {
        Alert.alert('Error', toAlertMessage((res as any)?.message, 'Failed to create Note'));
      }
    } catch (e: any) {
      Alert.alert('Error', toAlertMessage(e?.response?.data?.message ?? e?.message, 'Failed to create Note'));
    }
  };

  const handleShowMakeGlobalModal = async () => {
    const doc = selectedDocumentForMenu;
    if (!doc) return;
    setShowKebabMenu(false);
    setMakeGlobalDocument(doc);
    setMakeGlobalWorkspaces([]);
    setMakeGlobalSelectedIds([]);
    setShowMakeGlobalModal(true);
    setMakeGlobalLoading(true);
    try {
      const [workspacesRes, visibilityRes] = await Promise.all([
        apiClient.getMobileWorkspaces(100, 0),
        apiClient.getFileWorkspaceVisibility(Number(doc.id)).catch(() => ({ success: false, visible_workspaces: [] })),
      ]);
      const list = (workspacesRes as any)?.data ?? (workspacesRes as any)?.workspaces ?? (Array.isArray(workspacesRes) ? workspacesRes : []);
      setMakeGlobalWorkspaces(Array.isArray(list) ? list : []);
      const visible = (visibilityRes as any)?.visible_workspaces ?? [];
      const ids = Array.isArray(visible) ? visible.map((w: { id: number }) => w.id) : [];
      setMakeGlobalSelectedIds(ids);
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to load workspaces');
      setShowMakeGlobalModal(false);
    } finally {
      setMakeGlobalLoading(false);
    }
  };

  const handleMakeGlobalToggleWorkspace = (workspaceId: number) => {
    setMakeGlobalSelectedIds((prev) =>
      prev.includes(workspaceId) ? prev.filter((id) => id !== workspaceId) : [...prev, workspaceId]
    );
  };

  const handleMakeGlobalSave = async () => {
    const doc = makeGlobalDocument;
    if (!doc) return;
    setMakeGlobalSaving(true);
    try {
      const res = await apiClient.setFileWorkspaceVisibility(Number(doc.id), makeGlobalSelectedIds);
      if ((res as any)?.success) {
        Alert.alert('Success', 'Workspace visibility updated. This file is now shared with the selected workspaces.');
        setShowMakeGlobalModal(false);
        setMakeGlobalDocument(null);
        loadDocuments(true);
      } else {
        Alert.alert('Error', toAlertMessage((res as any)?.message, 'Failed to update workspace visibility'));
      }
    } catch (e: any) {
      Alert.alert('Error', toAlertMessage(e?.message ?? e?.response?.data?.message, 'Failed to update workspace visibility'));
    } finally {
      setMakeGlobalSaving(false);
    }
  };

  const handleExternalFileImport = (file: ExternalFile) => {
    console.log('External file import:', file);
    // Handle external file import logic here
  };

  const handleImportSuccess = () => {
    loadDocuments(true);
    setShowExternalFilePicker(false);
  };

  const markFileAsRecentlyCompleted = (fileId: string) => {
    setRecentlyCompletedFiles(prev => new Set([...prev, fileId]));
    
    // Remove the green dot after 3 hours
    setTimeout(() => {
      setRecentlyCompletedFiles(prev => {
        const newSet = new Set(prev);
        newSet.delete(fileId);
        return newSet;
      });
    }, 3 * 60 * 60 * 1000); // 3 hours in milliseconds
  };

  const shouldShowStatusIndicator = (document: Document) => {
    // Show for files that are currently processing or pending
    if (document.status === 'processing' || document.status === 'pending') {
      return true;
    }
    
    // Show for files that recently completed processing
    if (document.status === 'processed' && recentlyCompletedFiles.has(document.id)) {
      return true;
    }
    
    return false;
  };

  const handleUploadFromFiles = async () => {
    try {
      // Use the fileStore's built-in upload method which handles state properly
      const fileStore = useFileStore.getState();
      const success = await fileStore.uploadFromDocuments();
      
      if (success === true) {
        // Immediately reload files to show them with pending status
        console.log('📁 Upload complete, immediately reloading files to show pending status...');
        
        // Mark upload time for focus effect to bypass debounce
        lastUploadTimeRef.current = Date.now();
        
        // Bypass debounce and cache - force immediate refresh
        lastLoadTimeRef.current = 0; // Reset debounce timer
        apiCacheRef.current = null; // Clear cache to force fresh load
        
        // Refresh immediately, then retry after short delay in case backend needs time
        loadDocuments(true);
        
        // Retry after 500ms in case backend hasn't created file record yet
        setTimeout(() => {
          console.log('📁 Retrying file load after upload...');
          loadDocuments(true);
        }, 500);
        
        // Final retry after 2 seconds to catch any delayed file creation
        setTimeout(() => {
          console.log('📁 Final retry file load after upload...');
          loadDocuments(true);
        }, 2000);
      }
    } catch (error) {
      console.error('Document upload error:', error);
      Alert.alert('Error', 'Failed to upload files. Please try again.');
    }
  };

  const dismissUploadModal = useCallback(() => {
    uploadSheet.close();
  }, [uploadSheet]);

  const handleUploadFromFilesViaModal = useCallback(async () => {
    uploadSheet.close();
    await handleUploadFromFiles();
  }, [handleUploadFromFiles, uploadSheet]);

  const handleUploadFromCameraViaModal = useCallback(() => {
    uploadSheet.close();
    router.push('/scanner');
  }, [router, uploadSheet]);

  const handleUploadFromGalleryViaModal = useCallback(async () => {
    uploadSheet.close();
    await handleGalleryUpload();
  }, [handleGalleryUpload, uploadSheet]);

  const handleUploadByLinkViaModal = useCallback(() => {
    uploadSheet.close();
    router.push('/upload-by-link-code');
  }, [router, uploadSheet]);

  const isUploading = pendingUploads.length > 0;


  const renderDocument = ({ item }: { item: Document }) => {
    const kindLabel = item.listKind === 'bookmark'
      ? 'Bookmark'
      : item.file_kind
        ? item.file_kind.replace(/_/g, ' ')
        : '';
    const metaParts: string[] = [];
    if (kindLabel) metaParts.push(kindLabel);
    if (preferences.display.show_file_sizes && item.size) metaParts.push(item.size);
    if (preferences.display.show_upload_dates && item.uploadDate) {
      metaParts.push(item.uploadDate.toLocaleDateString());
    }

    return (
    <TouchableOpacity
      style={[dynamicStyles.documentItem, gridView && dynamicStyles.documentItemGrid]}
      onPress={() => handleDocumentPress(item)}
      onLongPress={
        item.listKind === 'bookmark'
          ? undefined
          : (event) => handleKebabMenuPress(item, event)
      }
      accessibilityRole="button"
      accessibilityLabel={`${item.name}${item.file_kind ? `, ${item.file_kind.replace(/_/g, ' ')}` : ''}`}
    >
      <DocumentListIcon
        pending={isFileKindPending(item.file_kind) || item.status === 'processing'}
        iconName={getFileIcon(item.type, item.status, item.file_kind) as React.ComponentProps<typeof Ionicons>['name']}
        iconColor={
          item.listKind === 'bookmark'
            ? item.bookmarkColor || '#AF52DE'
            : getTypeColor(item.type, item.file_kind)
        }
        containerStyle={
          gridView
            ? { ...dynamicStyles.documentIcon, ...dynamicStyles.documentIconGrid }
            : dynamicStyles.documentIcon
        }
      />
      
      <View style={dynamicStyles.documentInfo}>
        <FileNameText
          name={item.name}
          style={[dynamicStyles.documentName, gridView && dynamicStyles.documentNameGrid]}
        />
        {(metaParts.length > 0 || item.category || item.totalAmount != null) && (
        <View style={dynamicStyles.documentMetaRow}>
          <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', flex: 1 }}>
            {metaParts.length > 0 && (
              <Text style={dynamicStyles.documentMeta}>
                {metaParts.join(' • ')}
              </Text>
            )}
            {item.listKind !== 'bookmark' && item.is_global && (
              <Ionicons name="globe-outline" size={12} color={colors.tint} style={{ marginLeft: 4 }} />
            )}
            {item.listKind !== 'bookmark' && item.category && (
              <Text style={dynamicStyles.documentMeta}> • {item.category}</Text>
            )}
          </View>
          {!gridView &&
            item.listKind !== 'bookmark' &&
            item.totalAmount != null &&
            !Number.isNaN(item.totalAmount) && (
            <Text style={dynamicStyles.documentMetaAmount}>
              {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(item.totalAmount)}
            </Text>
          )}
        </View>
        )}
      </View>

      {!gridView && item.listKind !== 'bookmark' && (
      <TouchableOpacity
        style={dynamicStyles.kebabButton}
        onPress={(event) => {
          event.stopPropagation();
          handleKebabMenuPress(item, event);
        }}
      >
        <Ionicons name="ellipsis-vertical" size={20} color="#666" />
      </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
  };

  const FilterButton = ({ option, label }: { option: FilterOption; label: string }) => (
    <TouchableOpacity
      style={[dynamicStyles.filterButton, filterBy === option && dynamicStyles.filterButtonActive]}
      onPress={() => setFilterBy(option)}
      accessibilityLabel={`Filter by ${label}`}
      accessibilityRole="button"
      accessibilityState={{ selected: filterBy === option }}
    >
      <Text style={[dynamicStyles.filterButtonText, filterBy === option && dynamicStyles.filterButtonTextActive]}>
        {label}
      </Text>
    </TouchableOpacity>
  );

  const dynamicStyles = useMemo(() => {
    const scaledStyles = scaleStyleObject({
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
    },
    backButton: {
      marginRight: 12,
      padding: 4,
    },
    headerTitleContainer: {
      flex: 1,
    },
    headerTitle: {
      fontSize: 24,
      fontWeight: '700',
      color: colors.text,
    },
    autoRefreshIndicator: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: 2,
    },
    autoRefreshText: {
      fontSize: 12,
      color: '#007AFF',
      marginLeft: 4,
    },
    headerActions: {
      flexDirection: 'row',
      gap: 8,
    },
    headerButton: {
      padding: 10,
      marginTop: 4,
    },
    refreshingButton: {
      opacity: 0.5,
    },
    searchContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.card,
      marginHorizontal: 16,
      marginTop: 16,
      paddingHorizontal: 12,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
    },
    searchIcon: {
      marginRight: 8,
    },
    searchInput: {
      flex: 1,
      paddingVertical: 12,
      fontSize: 16,
      color: colors.text,
    },
    filtersContainer: {
      marginTop: 16,
    },
    filtersContent: {
      paddingHorizontal: 16,
    },
    filterButton: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      marginRight: 8,
      borderRadius: 20,
      backgroundColor: colors.surface,
    },
    filterButtonActive: {
      backgroundColor: '#007AFF',
    },
    filterButtonText: {
      fontSize: 14,
      fontWeight: '500',
      color: colors.textSecondary,
    },
    filterButtonTextActive: {
      color: '#fff',
    },
    sortContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    sortLabel: {
      fontSize: 14,
      color: colors.textSecondary,
      marginRight: 8,
    },
    sortButton: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 6,
      backgroundColor: colors.surface,
    },
    sortButtonText: {
      fontSize: 14,
      color: colors.text,
      marginRight: 4,
    },
    documentsList: {
      flex: 1,
      paddingHorizontal: 12,
    },
    documentItem: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.card,
      borderRadius: 8,
      padding: 12,
      marginBottom: 8,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.08,
      shadowRadius: 2,
      elevation: 2,
    },
    documentItemGrid: {
      flex: 1,
      flexDirection: 'column',
      alignItems: 'center',
      marginHorizontal: 4,
      maxWidth: '48%',
      minHeight: 120,
    },
    documentIcon: {
      width: 40,
      height: 40,
      borderRadius: 20,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 10,
    },
    documentIconGrid: {
      marginRight: 0,
      marginBottom: 8,
      width: 48,
      height: 48,
      borderRadius: 24,
    },
    documentInfo: {
      flex: 1,
      minWidth: 0,
    },
    documentName: {
      fontSize: 15,
      fontWeight: '600',
      color: colors.text,
      marginBottom: 2,
    },
    documentNameGrid: {
      textAlign: 'center',
      fontSize: 13,
    },
    documentMetaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
    },
    documentMeta: {
      fontSize: 11,
      color: colors.textSecondary,
      flex: 1,
    },
    documentMetaAmount: {
      fontSize: 11,
      color: colors.textSecondary,
      fontWeight: '600',
      flexShrink: 0,
    },
    documentActions: {
      position: 'absolute',
      top: 0,
      right: 0,
      width: 10,
      height: 10,
      borderRadius: 5,
      marginTop: 8,
      marginRight: 8,
    },
    statusIndicator: {
      width: '100%',
      height: '100%',
      borderRadius: 5,
    },
    emptyContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingVertical: 64,
    },
    emptyText: {
      fontSize: 18,
      fontWeight: '600',
      color: colors.textSecondary,
      marginTop: 16,
      marginBottom: 8,
    },
    emptySubtext: {
      fontSize: 14,
      color: colors.textLight,
      textAlign: 'center',
      maxWidth: 250,
    },
    uploadButton: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: '#007AFF',
      paddingHorizontal: 20,
      paddingVertical: 12,
      borderRadius: 8,
      marginTop: 16,
    },
    uploadButtonText: {
      color: '#fff',
      fontWeight: '600',
      marginLeft: 8,
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingVertical: 64,
    },
    loadingText: {
      fontSize: 18,
      fontWeight: '600',
      color: colors.text,
      marginTop: 16,
    },
    loadingSubtext: {
      fontSize: 14,
      color: colors.textLight,
      marginTop: 4,
    },
    kebabButton: {
      padding: 6,
      marginLeft: 6,
    },
    modalOverlay: modalScrimOverlayStyle(colors.isDark, {
      justifyContent: 'center',
      alignItems: 'center',
    }),
    kebabMenuContainer: {
      ...floatingDialogSurfaceStyle(colors, colors.isDark, { minWidth: 150 }),
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
      color: colors.text,
      marginLeft: 12,
      fontWeight: '500',
    },
    renameModalContent: {
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 20,
      width: '90%',
      maxWidth: 360,
    },
    renameModalTitle: {
      fontSize: 18,
      fontWeight: '700',
      color: colors.text,
      marginBottom: 8,
    },
    renameModalCurrentLabel: {
      fontSize: 13,
      color: colors.textLight,
      marginBottom: 12,
    },
    renameModalInput: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 16,
      color: colors.text,
      marginBottom: 16,
    },
    renameModalButtons: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 12,
    },
    renameModalCancelBtn: {
      paddingVertical: 10,
      paddingHorizontal: 18,
    },
    renameModalCancelText: {
      fontSize: 16,
      color: colors.textLight,
      fontWeight: '500',
    },
    renameModalRenameBtn: {
      backgroundColor: '#007AFF',
      paddingVertical: 10,
      paddingHorizontal: 18,
      borderRadius: 10,
      minWidth: 88,
      alignItems: 'center',
    },
    renameModalRenameText: {
      fontSize: 16,
      color: '#fff',
      fontWeight: '600',
    },
    renameModalBtnDisabled: {
      opacity: 0.6,
    },
    bookmarkModalContainer: {
      backgroundColor: colors.card,
      borderRadius: 20,
      width: '90%',
      maxWidth: 400,
      maxHeight: '80%',
      overflow: 'hidden',
    },
    bookmarkModalHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: 16,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    bookmarkModalTitle: {
      fontSize: 20,
      fontWeight: '700',
      color: colors.text,
    },
    bookmarkModalContent: {
      padding: 16,
    },
    bookmarkList: {
      padding: 16,
    },
    bookmarkItem: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    bookmarkColor: {
      width: 20,
      height: 20,
      borderRadius: 10,
      marginRight: 12,
    },
    bookmarkName: {
      flex: 1,
      fontSize: 16,
      fontWeight: '500',
      color: colors.text,
    },
    bookmarkCreateSection: {
      paddingVertical: 12,
    },
    bookmarkSectionLabel: {
      fontSize: 12,
      fontWeight: '600',
      marginBottom: 8,
      textTransform: 'uppercase',
    },
    bookmarkInputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginBottom: 12,
    },
    bookmarkNameInput: {
      flex: 1,
      minWidth: 0,
      borderWidth: 1,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 16,
    },
    bookmarkCreateButtonIcon: {
      width: 44,
      height: 44,
      borderRadius: 10,
      backgroundColor: '#007AFF',
      alignItems: 'center',
      justifyContent: 'center',
    },
    bookmarkColorRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      marginBottom: 12,
    },
    bookmarkColorChip: {
      width: 28,
      height: 28,
      borderRadius: 14,
    },
    bookmarkColorChipSelected: {
      borderWidth: 3,
      borderColor: '#fff',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.3,
      shadowRadius: 2,
      elevation: 2,
    },
    bookmarkDivider: {
      height: 1,
      marginVertical: 16,
    },
    bookmarkItemText: {
      fontSize: 16,
      color: colors.text,
      marginLeft: 12,
      flex: 1,
    },
    
    // Category Modal Styles
    categoryModalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      justifyContent: 'flex-end',
    },
    categoryModalContent: {
      backgroundColor: colors.card,
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
      borderBottomColor: colors.border,
    },
    categoryModalTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: colors.text,
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
      borderBottomColor: colors.border,
    },
    categoryItemText: {
      fontSize: 16,
      color: colors.text,
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
    }, colors.scale);
    return StyleSheet.create(scaledStyles);
  }, [colors, colors.scale]);

  const filterTabOptions = useMemo(() => {
    const labels: Record<FilterOption, string> = {
      all: 'All',
      documents: 'Documents',
      receipts: 'Receipts',
      invoice: 'Invoices',
      forms: 'Forms',
      transcripts: 'Transcripts',
      meeting_notes: 'Meeting Notes',
      meeting_chat: 'Meeting Chat',
      meeting_summary: 'AI Summary',
      draft: 'Note',
      spreadsheet: 'Spreadsheets',
      picture: 'Pictures',
      pending: 'Pending',
      unknown: 'Unknown',
      deleted: 'Deleted',
    };
    const base = availableCategories.filter((c) => c !== 'deleted');
    const ordered: FilterOption[] = user ? [...base, 'deleted'] : base;
    return ordered.map((category) => ({
      option: category,
      label: labels[category] || category,
    }));
  }, [availableCategories, user]);

  const MAX_RESTORE_POLL_ATTEMPTS = 150;

  const runRestorePollTick = useCallback(async () => {
    const poll = restorePollRef.current;
    if (poll.pendingIds.size === 0) {
      if (poll.intervalId) {
        clearInterval(poll.intervalId);
        poll.intervalId = null;
      }
      poll.attempts = 0;
      return;
    }
    poll.attempts += 1;
    if (poll.attempts > MAX_RESTORE_POLL_ATTEMPTS) {
      if (poll.intervalId) {
        clearInterval(poll.intervalId);
        poll.intervalId = null;
      }
      poll.pendingIds.clear();
      poll.attempts = 0;
      Alert.alert(
        'Restore',
        'Restoring is taking longer than expected. Pull to refresh to check status.'
      );
      return;
    }
    try {
      const list = await loadDeletedFiles({ silent: true });
      for (const id of [...poll.pendingIds]) {
        if (!list.some((f) => f.id === id)) {
          poll.pendingIds.delete(id);
        }
      }
      if (poll.pendingIds.size === 0) {
        if (poll.intervalId) {
          clearInterval(poll.intervalId);
          poll.intervalId = null;
        }
        poll.attempts = 0;
        await loadDocuments(true, 1, false);
      }
    } catch {
      // transient errors — next tick retries
    }
  }, [loadDeletedFiles, loadDocuments]);

  const performRestoreDeleted = useCallback(
    async (fileId: number) => {
      setDeletedActionId(fileId);
      try {
        const r = await apiClient.restoreFileFromTrash(fileId);
        if ((r as { success?: boolean })?.success === false) {
          Alert.alert('Error', (r as { message?: string })?.message || 'Restore failed');
          return;
        }
        setDeletedFiles((prev) =>
          prev.map((x) =>
            x.id === fileId ? { ...x, restoring: true, lifecycle_state: 'restoring' } : x
          )
        );
        const poll = restorePollRef.current;
        poll.pendingIds.add(fileId);
        if (!poll.intervalId) {
          poll.attempts = 0;
          poll.intervalId = setInterval(() => {
            void runRestorePollTick();
          }, 2000);
          void runRestorePollTick();
        } else {
          void runRestorePollTick();
        }
      } catch (e: any) {
        Alert.alert('Error', toAlertMessage(e?.message, 'Restore failed'));
      } finally {
        setDeletedActionId(null);
      }
    },
    [runRestorePollTick]
  );

  const confirmRestoreDeleted = useCallback(
    (fileId: number, displayName?: string) => {
      const raw = (displayName || 'File').trim();
      const label = raw.length > 80 ? `${raw.slice(0, 77)}…` : raw;
      Alert.alert(
        'Restore this file?',
        `“${label}” will be added back to your library. This might take a few minutes to complete — you can leave this page.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Restore', onPress: () => void performRestoreDeleted(fileId) },
        ]
      );
    },
    [performRestoreDeleted]
  );

  useEffect(() => {
    return () => {
      const poll = restorePollRef.current;
      if (poll.intervalId) {
        clearInterval(poll.intervalId);
        poll.intervalId = null;
      }
      poll.pendingIds.clear();
    };
  }, []);

  const handlePermanentDeleteDeleted = useCallback((row: { id: number; original_filename?: string }) => {
    Alert.alert(
      'Delete forever',
      `Permanently delete "${row.original_filename ? sanitizeDisplayFilename(row.original_filename) : 'this file'}"? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete forever',
          style: 'destructive',
          onPress: async () => {
            setDeletedActionId(row.id);
            try {
              const r = await apiClient.permanentlyDeleteTrashedFile(row.id);
              if ((r as { success?: boolean })?.success !== false) {
                setDeletedFiles((prev) => prev.filter((x) => x.id !== row.id));
              } else {
                Alert.alert('Error', (r as { message?: string })?.message || 'Delete failed');
              }
            } catch (e: any) {
              Alert.alert('Error', toAlertMessage(e?.message, 'Delete failed'));
            } finally {
              setDeletedActionId(null);
            }
          },
        },
      ]
    );
  }, []);

  const handleCloseDeletedKebabMenu = useCallback(() => {
    setShowDeletedKebabMenu(false);
    setSelectedDeletedFileForMenu(null);
  }, []);

  const handleDeletedKebabOpen = useCallback((item: DeletedFileRow) => {
    setSelectedDeletedFileForMenu(item);
    setShowDeletedKebabMenu(true);
  }, []);

  const handleFolderMenuPress = useCallback((folder: FolderRowModel) => {
    setFolderMenuTarget(folder);
    setShowFolderKebabMenu(true);
  }, []);

  const handleCloseFolderKebabMenu = useCallback(() => {
    setShowFolderKebabMenu(false);
    setFolderMenuTarget(null);
  }, []);

  const handleFolderKebabAction = useCallback(
    (action: FolderKebabAction, folder: FolderRowModel) => {
      switch (action) {
        case 'open':
          folderSystem.openFolder(folder.id);
          break;
        case 'rename':
          setRenameFolderTarget(folder);
          break;
        case 'move':
          setMoveFileIds([]);
          setMoveFolderTarget(folder);
          setShowFolderMovePicker(true);
          break;
        case 'details': {
          const pathLabel =
            (folder.path_label || '').trim()
            || (folder.breadcrumb || []).map((c) => c.name).filter(Boolean).join(' / ')
            || folder.name;
          const parentLabel =
            folder.parent_folder_id != null
              ? ((folder.parent_folder_name || '').trim() || '—')
              : 'None (top-level)';
          const workspaceLabel = (folder.workspace_name || '').trim() || '—';
          const lines = [
            `Workspace: ${workspaceLabel}`,
            `Parent folder: ${parentLabel}`,
            `Path: ${pathLabel}`,
            `Subfolders: ${folder.subfolder_count ?? 0}`,
            `Files: ${folder.file_count ?? 0}`,
            folder.created_at
              ? `Created: ${new Date(folder.created_at).toLocaleString()}`
              : null,
            folder.updated_at
              ? `Last updated: ${new Date(folder.updated_at).toLocaleString()}`
              : null,
          ].filter(Boolean);
          Alert.alert(folder.name, lines.join('\n'));
          break;
        }
        case 'delete':
          Alert.alert(
            'Delete folder?',
            'Files in this folder will move to trash with the folder.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete',
                style: 'destructive',
                onPress: () => void folderSystem.deleteFolderById(folder.id),
              },
            ]
          );
          break;
      }
    },
    [folderSystem]
  );

  const handleRestoreDeletedFolder = useCallback(
    async (folderRootId: number) => {
      setDeletedActionId(folderRootId);
      try {
        const r = await apiClient.restoreFolderFromTrash(folderRootId);
        if ((r as { success?: boolean })?.success !== false) {
          await loadDeletedFiles();
        } else {
          Alert.alert('Error', (r as { message?: string })?.message || 'Restore failed');
        }
      } catch (e: any) {
        Alert.alert('Error', toAlertMessage(e?.message, 'Restore failed'));
      } finally {
        setDeletedActionId(null);
      }
    },
    [loadDeletedFiles]
  );

  const handlePermanentDeleteDeletedFolder = useCallback((folderRootId: number) => {
    Alert.alert(
      'Delete folder forever?',
      'Folder structure will be removed from trash. Files stay in trash until deleted individually.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete forever',
          style: 'destructive',
          onPress: async () => {
            setDeletedActionId(folderRootId);
            try {
              await apiClient.permanentlyDeleteFolderFromTrash(folderRootId);
              await loadDeletedFiles();
            } catch (e: any) {
              Alert.alert('Error', toAlertMessage(e?.message, 'Delete failed'));
            } finally {
              setDeletedActionId(null);
            }
          },
        },
      ]
    );
  }, [loadDeletedFiles]);

  const renderDeletedFile = ({ item }: { item: DeletedFileRow }) => {
    const isRestoring =
      item.restoring === true ||
      (item.lifecycle_state || '').toLowerCase() === 'restoring';
    const showBusy = isRestoring || deletedActionId === item.id;
    return (
      <View style={dynamicStyles.documentItem}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {showBusy ? (
            <View style={[dynamicStyles.documentIcon, { justifyContent: 'center' }]}>
              <ActivityIndicator size="small" color="#007AFF" />
            </View>
          ) : null}
          <View style={[dynamicStyles.documentInfo, { flex: 1, minWidth: 0 }]}>
            <FileNameText
              name={item.original_filename || 'File'}
              style={dynamicStyles.documentName}
            />
            <Text style={dynamicStyles.documentMeta}>
              {isRestoring
                ? 'Restoring…'
                : [
                    item.file_kind || item.file_type || '—',
                    item.deleted_at ? ` · ${new Date(item.deleted_at).toLocaleString()}` : '',
                    item.days_remaining != null ? ` · ${item.days_remaining} days left` : '',
                  ]
                    .filter(Boolean)
                    .join('')}
            </Text>
          </View>
          <TouchableOpacity
            style={[dynamicStyles.kebabButton, showBusy && { opacity: 0.4 }]}
            onPress={() => handleDeletedKebabOpen(item)}
            disabled={showBusy}
            accessibilityLabel="Deleted file actions"
            accessibilityRole="button"
          >
            <Ionicons name="ellipsis-vertical" size={20} color="#666" />
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // Loading state with bouncing dots
  if (
    (loading || (useFolderMode && folderSystem.loading)) &&
    documents.length === 0 &&
    filterBy !== 'deleted'
  ) {
    return (
      <SafeAreaView style={dynamicStyles.container}>
        <TapToToggleHeaderView style={dynamicStyles.container}>
          <AnimatedHeaderContainer>
            <View style={dynamicStyles.header}>
              <AppBackButton onPress={handleDocumentsHeaderBack} />
              <AppHeaderTitle>Files</AppHeaderTitle>
              <View style={dynamicStyles.headerActions}>
                {useFolderMode ? (
                  <TouchableOpacity
                    style={dynamicStyles.headerButton}
                    onPress={() => void openAiFileManager()}
                    accessibilityLabel="AI File Manager"
                    accessibilityRole="button"
                  >
                    <Feather name="cpu" size={26} color={AI_FM_ICON_COLOR} />
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity
                  style={dynamicStyles.headerButton}
                  onPress={() => uploadSheet.open()}
                  accessibilityLabel="Upload"
                  accessibilityRole="button"
                >
                  <Ionicons name="cloud-upload-outline" size={28} color={colors.primary || '#007AFF'} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={[dynamicStyles.headerButton, refreshing && dynamicStyles.refreshingButton]}
                  onPress={onRefresh}
                  disabled={refreshing}
                  accessibilityLabel="Refresh file list"
                  accessibilityRole="button"
                >
                  <Ionicons
                    name="refresh"
                    size={24}
                    color={refreshing ? '#999' : colors.primary || '#007AFF'}
                  />
                </TouchableOpacity>
              </View>
            </View>
          </AnimatedHeaderContainer>
        <View style={dynamicStyles.loadingContainer}>
          <LoadingDots size={12} color="#007AFF" duration={800} />
          <Text style={dynamicStyles.loadingText}>Loading your files...</Text>
          <Text style={dynamicStyles.loadingSubtext}>This will only take a moment</Text>
        </View>
        <AiFileManagerBottomSheet
          visible={showAiFmSheet}
          onClose={() => setShowAiFmSheet(false)}
          workspaceId={aiFmWorkspaceId ?? workspaceId ?? folderSystem.currentFolderWorkspaceId}
          currentFolderId={folderSystem.currentFolderId}
          onExecuted={onFmExecuted}
          expandNonce={aiFmExpandNonce}
        />
        <UploadOptionsModal
          visible={uploadSheet.visible}
          expandNonce={uploadSheet.expandNonce}
          isUploading={isUploading}
          onDismiss={dismissUploadModal}
          onFiles={handleUploadFromFilesViaModal}
          onCamera={handleUploadFromCameraViaModal}
          onGallery={handleUploadFromGalleryViaModal}
          onLink={handleUploadByLinkViaModal}
        />
        </TapToToggleHeaderView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={dynamicStyles.container}>
      <TapToToggleHeaderView style={dynamicStyles.container}>
      {/* Error message display */}
      {(error || (useFolderMode && folderSystem.error)) && (
        <View style={{ backgroundColor: '#fee2e2', padding: 12, margin: 12, borderRadius: 8 }}>
          <Text style={{ color: '#b91c1c', fontWeight: 'bold' }}>
            {error || folderSystem.error}
          </Text>
        </View>
      )}
      
      {/* Header */}
      <AnimatedHeaderContainer>
        <View style={dynamicStyles.header}>
          <AppBackButton onPress={handleDocumentsHeaderBack} />
          <View style={dynamicStyles.headerTitleContainer}>
            <AppHeaderTitle fill={false}>
              {workspaceId ? 'Workspace Files' : 'Files'}
            </AppHeaderTitle>
            {isAutoRefreshing && (
              <View style={dynamicStyles.autoRefreshIndicator}>
                <Ionicons name="sync" size={16} color="#007AFF" />
                <Text style={dynamicStyles.autoRefreshText}>Syncing...</Text>
              </View>
            )}
          </View>
          <View style={dynamicStyles.headerActions}>
            {useFolderMode ? (
              <TouchableOpacity
                style={dynamicStyles.headerButton}
                onPress={() => void openAiFileManager()}
                accessibilityLabel="AI File Manager"
                accessibilityRole="button"
              >
                <Feather name="cpu" size={26} color={AI_FM_ICON_COLOR} />
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              style={dynamicStyles.headerButton}
              onPress={() => setGridView((v) => !v)}
              accessibilityLabel={gridView ? 'Switch to list view' : 'Switch to grid view'}
              accessibilityRole="button"
            >
              <Ionicons
                name={gridView ? 'list-outline' : 'grid-outline'}
                size={24}
                color={colors.primary || '#007AFF'}
              />
            </TouchableOpacity>
            <TouchableOpacity
              style={dynamicStyles.headerButton}
              onPress={() => uploadSheet.open()}
              accessibilityLabel="Upload"
              accessibilityRole="button"
            >
              <Ionicons name="cloud-upload-outline" size={28} color={colors.primary || '#007AFF'} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[dynamicStyles.headerButton, refreshing && dynamicStyles.refreshingButton]}
              onPress={onRefresh}
              disabled={refreshing}
              accessibilityLabel="Refresh file list"
              accessibilityRole="button"
            >
              <Ionicons
                name="refresh"
                size={24}
                color={refreshing ? '#999' : colors.primary || '#007AFF'}
              />
            </TouchableOpacity>
          </View>
        </View>
      </AnimatedHeaderContainer>

      {/* Search Bar */}
      <View style={dynamicStyles.searchContainer}>
        <Ionicons name="search" size={20} color="#666" style={dynamicStyles.searchIcon} />
        <TextInput
          style={dynamicStyles.searchInput}
          placeholder="Search files and folders..."
          value={searchQuery}
          onChangeText={handleSearchQueryChange}
          returnKeyType="search"
          onSubmitEditing={() => Keyboard.dismiss()}
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity
            onPress={() => handleSearchQueryChange('')}
            accessibilityLabel="Clear search"
            accessibilityRole="button"
          >
            <Ionicons name="close-circle" size={20} color="#666" />
          </TouchableOpacity>
        )}
      </View>

      {/* Filters */}
      <View style={dynamicStyles.filtersContainer}>
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          {...scrollRestoresHeaderProps}
          data={filterTabOptions}
          renderItem={({ item }) => (
            <FilterButton option={item.option} label={item.label} />
          )}
          keyExtractor={(item) => item.option}
          contentContainerStyle={dynamicStyles.filtersContent}
        />
      </View>

      {/* Sort Options — forms tab only (folder mode shows sort in breadcrumb bar) */}
      {!useFolderMode && filterBy !== 'deleted' && (
      <View style={dynamicStyles.sortContainer}>
        <TouchableOpacity
          style={dynamicStyles.sortButton}
          onPress={showSortOptions}
          accessibilityLabel={`Sort by ${sortBy}`}
          accessibilityRole="button"
        >
          <Text style={dynamicStyles.sortButtonText}>
            {sortBy.charAt(0).toUpperCase() + sortBy.slice(1)}
          </Text>
          <Ionicons name="chevron-down" size={16} color="#666" />
        </TouchableOpacity>
      </View>
      )}

      {/* Files List */}
      <FlatList
        key={filterBy === 'deleted' ? 'deleted-list' : gridView ? 'files-grid' : 'files-list'}
        data={
          (filterBy === 'deleted' ? filteredDeletedFiles : documentsWithPending) as Array<
            Document | DeletedFileRow
          >
        }
        renderItem={({ item }) =>
          filterBy === 'deleted'
            ? renderDeletedFile({ item: item as DeletedFileRow })
            : renderDocument({ item: item as Document })
        }
        keyExtractor={(item) =>
          filterBy === 'deleted'
            ? String((item as DeletedFileRow).id)
            : String((item as Document).id)
        }
        numColumns={filterBy !== 'deleted' && gridView ? 2 : 1}
        columnWrapperStyle={
          filterBy !== 'deleted' && gridView
            ? ({ paddingHorizontal: 8, justifyContent: 'space-between' } as const)
            : undefined
        }
        extraData={
          filterBy === 'deleted'
            ? `${filterBy}-${showDeletedKebabMenu}-${selectedDeletedFileForMenu?.id ?? ''}-${deletedActionId ?? ''}-${deletedFiles.map((f) => `${f.id}:${f.restoring ? 1 : 0}`).join(',')}`
            : `${filterBy}-${gridView}-${preferences.display.show_file_sizes}-${preferences.display.show_upload_dates}`
        }
        style={dynamicStyles.documentsList}
        contentContainerStyle={{ paddingBottom: 88 }}
        {...scrollRestoresHeaderProps}
        accessibilityRole="list"
        accessibilityLabel={filterBy === 'deleted' ? 'Deleted files' : 'Documents'}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        showsVerticalScrollIndicator={false}
        onEndReached={filterBy === 'deleted' ? undefined : onEndReached}
        onEndReachedThreshold={0.4}
        onMomentumScrollBegin={() => {
          onEndReachedCalledDuringMomentumRef.current = false;
        }}
        ListHeaderComponent={
          filterBy === 'deleted' ? (
            <DeletedFolderGroups
              groups={deletedFolderGroups}
              onRestoreFolder={handleRestoreDeletedFolder}
              onPermanentDeleteFolder={handlePermanentDeleteDeletedFolder}
              onRestoreFile={(id) => confirmRestoreDeleted(id)}
              onPermanentDeleteFile={handlePermanentDeleteDeleted}
              actionId={deletedActionId}
            />
          ) : useFolderMode ? (
            <DocumentsFolderBar
              breadcrumb={folderSystem.breadcrumb}
              folders={visibleFolders}
              loading={folderSystem.loading}
              sortBy={sortBy}
              onSortPress={showSortOptions}
              onBreadcrumbPress={folderSystem.goToBreadcrumb}
              onOpenFolder={folderSystem.openFolder}
              onFolderMenuPress={handleFolderMenuPress}
              onNewFolder={() => setShowCreateFolder(true)}
            />
          ) : null
        }
        ListFooterComponent={
          filterBy === 'deleted'
            ? null
            : loadingMore
              ? (
                  <View style={{ paddingVertical: 16 }}>
                    <ActivityIndicator size="small" color="#007AFF" />
                  </View>
                )
              : null
        }
        ListEmptyComponent={
          filterBy === 'deleted' ? (
            deletedLoading ? (
              <View style={{ paddingVertical: 40, alignItems: 'center' }}>
                <ActivityIndicator size="large" color="#007AFF" />
              </View>
            ) : (
              <View style={dynamicStyles.emptyContainer}>
                <Ionicons name="trash-outline" size={64} color="#ccc" />
                <Text style={dynamicStyles.emptyText}>
                  {searchQuery.trim() ? 'No deleted files match your search' : 'No deleted files'}
                </Text>
                <Text style={dynamicStyles.emptySubtext}>
                  Files you move to trash appear here. You can restore them or delete forever.
                </Text>
              </View>
            )
          ) : (
          <View style={dynamicStyles.emptyContainer}>
            <Ionicons name="folder-open-outline" size={64} color="#ccc" />
            <Text style={dynamicStyles.emptyText}>
              {searchQuery ? 'No files match your search' : 'No files yet'}
            </Text>
            <Text style={dynamicStyles.emptySubtext}>
              {searchQuery 
                ? 'Try adjusting your search terms or filters to find what you\'re looking for' 
                : 'Start by uploading your first file using the upload button above'
              }
            </Text>
            {!searchQuery && (
              <TouchableOpacity
                style={dynamicStyles.uploadButton}
                onPress={() => uploadSheet.open()}
              >
                <Ionicons name="cloud-upload-outline" size={20} color="#fff" />
                <Text style={dynamicStyles.uploadButtonText}>Upload</Text>
              </TouchableOpacity>
            )}
          </View>
          )
        }
      />

      {/* Document Viewer */}
      {showDocumentViewer && selectedDocument && (
        <DocumentViewer
          fileId={selectedDocument.id}
          fileName={selectedDocument.name}
          fileType={selectedDocument.type}
          fileCategory={selectedDocument.category}
          workspaceId={
            workspaceId != null && Number.isFinite(workspaceId) ? workspaceId : undefined
          }
          onClose={() => {
            setShowDocumentViewer(false);
            setSelectedDocument(null);
          }}
        />
      )}

      {/* Quick Form Viewer */}
      {showQuickFormViewer && selectedDocument && (
        <QuickFormViewer
          formId={selectedDocument.id}
          formName={selectedDocument.name}
          onClose={() => {
            setShowQuickFormViewer(false);
            setSelectedDocument(null);
          }}
        />
      )}

      {/* External File Picker */}
      <ExternalFilePicker
        visible={showExternalFilePicker}
        onClose={() => setShowExternalFilePicker(false)}
        onFileImport={handleExternalFileImport}
        onImportSuccess={handleImportSuccess}
      />

      {/* Deleted tab: kebab menu (restore / delete forever) */}
      <Modal
        visible={showDeletedKebabMenu}
        transparent
        animationType="fade"
        onRequestClose={handleCloseDeletedKebabMenu}
      >
        <TouchableOpacity
          style={dynamicStyles.modalOverlay}
          activeOpacity={1}
          onPress={handleCloseDeletedKebabMenu}
        >
          <View style={dynamicStyles.kebabMenuContainer}>
            <FeedbackTouchable
              style={dynamicStyles.kebabMenuItem}
              onPress={() => {
                const row = selectedDeletedFileForMenu;
                handleCloseDeletedKebabMenu();
                if (row) confirmRestoreDeleted(row.id, row.original_filename);
              }}
              disabled={
                !!selectedDeletedFileForMenu &&
                (deletedActionId === selectedDeletedFileForMenu.id ||
                  selectedDeletedFileForMenu.restoring === true ||
                  (selectedDeletedFileForMenu.lifecycle_state || '').toLowerCase() === 'restoring')
              }
              loading={
                !!selectedDeletedFileForMenu &&
                deletedActionId === selectedDeletedFileForMenu.id
              }
              replaceWithSpinner={false}
              spinnerColor="#007AFF"
            >
              <Ionicons name="arrow-undo-outline" size={20} color="#007AFF" />
              <Text style={dynamicStyles.kebabMenuText}>Restore</Text>
            </FeedbackTouchable>
            <FeedbackTouchable
              style={dynamicStyles.kebabMenuItem}
              onPress={() => {
                const row = selectedDeletedFileForMenu;
                handleCloseDeletedKebabMenu();
                if (row) handlePermanentDeleteDeleted(row);
              }}
              disabled={
                !!selectedDeletedFileForMenu &&
                (deletedActionId === selectedDeletedFileForMenu.id ||
                  selectedDeletedFileForMenu.restoring === true ||
                  (selectedDeletedFileForMenu.lifecycle_state || '').toLowerCase() === 'restoring')
              }
              loading={
                !!selectedDeletedFileForMenu &&
                deletedActionId === selectedDeletedFileForMenu.id
              }
              replaceWithSpinner={false}
              spinnerColor="#EF4444"
            >
              <Ionicons name="trash-outline" size={20} color="#EF4444" />
              <Text style={[dynamicStyles.kebabMenuText, { color: '#EF4444' }]}>Delete forever</Text>
            </FeedbackTouchable>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Kebab Menu Modal */}
      <Modal
        visible={showKebabMenu}
        transparent={true}
        animationType="fade"
        onRequestClose={handleCloseKebabMenu}
      >
        <TouchableOpacity
          style={dynamicStyles.modalOverlay}
          activeOpacity={1}
          onPress={handleCloseKebabMenu}
        >
          <View style={dynamicStyles.kebabMenuContainer}>
            {selectedDocumentForMenu?.id &&
            !isNaN(Number(selectedDocumentForMenu.id)) &&
            (selectedDocumentForMenu.file_kind || '').toString().toLowerCase() !== 'form' ? (
              <View style={[dynamicStyles.kebabMenuItem, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }]}>
                <ClientsButton
                  itemType="file"
                  itemId={Number(selectedDocumentForMenu.id)}
                  compact
                  allowCreate
                />
              </View>
            ) : null}
            <TouchableOpacity
              style={dynamicStyles.kebabMenuItem}
              onPress={handleViewDocument}
            >
              <Ionicons name="eye-outline" size={20} color="#007AFF" />
              <Text style={dynamicStyles.kebabMenuText}>View</Text>
            </TouchableOpacity>
            
            {/* Show View Responses option for forms */}
            {selectedDocumentForMenu?.type === 'form' && (
              <TouchableOpacity
                style={dynamicStyles.kebabMenuItem}
                onPress={handleViewFormResponses}
              >
                <Ionicons name="clipboard-outline" size={20} color="#8B5CF6" />
                <Text style={dynamicStyles.kebabMenuText}>View Responses</Text>
              </TouchableOpacity>
            )}
            
            {/* Show Categorize option for receipts - check file_kind */}
            {selectedDocumentForMenu?.file_kind?.toLowerCase() === 'receipt' && (
              <TouchableOpacity
                style={dynamicStyles.kebabMenuItem}
                onPress={handleCategorizeReceipt}
              >
                <Ionicons name="pricetag-outline" size={20} color="#FF9500" />
                <Text style={dynamicStyles.kebabMenuText}>Categorize</Text>
              </TouchableOpacity>
            )}
            
            {/* Show Update Payment Status option for invoices - check file_kind */}
            {selectedDocumentForMenu?.file_kind?.toLowerCase() === 'invoice' && (
              <TouchableOpacity
                style={dynamicStyles.kebabMenuItem}
                onPress={handleUpdatePaymentStatus}
              >
                <Ionicons name="card-outline" size={20} color="#2563EB" />
                <Text style={dynamicStyles.kebabMenuText}>Update Payment Status</Text>
              </TouchableOpacity>
            )}
            
            <FeedbackTouchable
              style={dynamicStyles.kebabMenuItem}
              onPress={handleShareDocument}
              replaceWithSpinner={false}
              spinnerColor="#10B981"
            >
              <Ionicons name="share-outline" size={20} color="#10B981" />
              <Text style={dynamicStyles.kebabMenuText}>Share</Text>
            </FeedbackTouchable>

            <TouchableOpacity
              style={dynamicStyles.kebabMenuItem}
              onPress={handleChatDocument}
            >
              <Ionicons name="chatbubble-outline" size={20} color="#4F46E5" />
              <Text style={dynamicStyles.kebabMenuText}>Ask ChatGD</Text>
            </TouchableOpacity>

            {!isLockedBookmarkFile(
              selectedDocumentForMenu?.id,
              fileIdsInLockedBookmarks,
              selectedDocumentForMenu?.in_locked_bookmark
            ) && (
              <TouchableOpacity
                style={dynamicStyles.kebabMenuItem}
                onPress={handleShowBookmarkModal}
              >
                <Ionicons name="bookmark-outline" size={20} color="#FF9500" />
                <Text style={dynamicStyles.kebabMenuText}>Add to Bookmark</Text>
              </TouchableOpacity>
            )}

            {useFolderMode &&
              selectedDocumentForMenu?.listKind !== 'bookmark' &&
              !isLockedBookmarkFile(
                selectedDocumentForMenu?.id,
                fileIdsInLockedBookmarks,
                selectedDocumentForMenu?.in_locked_bookmark
              ) && (
              <TouchableOpacity
                style={dynamicStyles.kebabMenuItem}
                onPress={() => {
                  const doc = selectedDocumentForMenu;
                  setShowKebabMenu(false);
                  if (doc) {
                    setMoveFolderTarget(null);
                    setMoveFileIds([Number(doc.id)]);
                    setShowFolderMovePicker(true);
                  }
                }}
              >
                <Ionicons name="folder-outline" size={20} color="#007AFF" />
                <Text style={dynamicStyles.kebabMenuText}>Move to folder</Text>
              </TouchableOpacity>
            )}

            {/* Edit as Draft: for editable text files (not Forms, not PDFs) */}
            {(() => {
              const doc = selectedDocumentForMenu;
              if (!doc) return false;
              // Must be editable format
              if (!isEditableTextFormat(doc)) return false;
              // Not a Form
              const fk = doc.file_kind?.toLowerCase();
              if (fk === 'form') return false;
              // Must be processed (not pending/processing)
              if (doc.status === 'processing' || doc.status === 'pending') return false;
              // User must be owner or have edit access (if user_id matches, they're owner)
              if (doc.user_id && user?.id && Number(doc.user_id) === Number(user.id)) return true;
              // For shared files, we could check can_edit but for now only show for owner
              return false;
            })() && (
              <FeedbackTouchable
                style={dynamicStyles.kebabMenuItem}
                onPress={handleEditAsDraft}
                replaceWithSpinner={false}
                spinnerColor="#007AFF"
              >
                <Ionicons name="document-text-outline" size={20} color="#007AFF" />
                <Text style={dynamicStyles.kebabMenuText}>
                  {selectedDocumentForMenu?.file_kind?.toLowerCase() === 'draft' ? 'Edit Note' : 'Edit as Note'}
                </Text>
              </FeedbackTouchable>
            )}

            {/* Make Global / Change Global: only for file owner */}
            {selectedDocumentForMenu?.user_id && user?.id && Number(selectedDocumentForMenu.user_id) === Number(user.id) && (
              <FeedbackTouchable
                style={dynamicStyles.kebabMenuItem}
                onPress={handleShowMakeGlobalModal}
                replaceWithSpinner={false}
                spinnerColor="#0EA5E9"
              >
                <Ionicons name="globe-outline" size={20} color="#0EA5E9" />
                <Text style={dynamicStyles.kebabMenuText}>{selectedDocumentForMenu?.is_global ? 'Change Global' : 'Make Global'}</Text>
              </FeedbackTouchable>
            )}

            {/* Rename: only for files that are not receipt or invoice, and not in a locked bookmark */}
            {!isLockedBookmarkFile(
              selectedDocumentForMenu?.id,
              fileIdsInLockedBookmarks,
              selectedDocumentForMenu?.in_locked_bookmark
            ) &&
            (() => {
              const fk = selectedDocumentForMenu?.file_kind?.toLowerCase();
              const isReceiptOrInvoice = fk === 'receipt' || fk === 'receipts' || fk === 'invoice' || fk === 'invoices';
              return !isReceiptOrInvoice;
            })() && (
              <TouchableOpacity
                style={dynamicStyles.kebabMenuItem}
                onPress={handleRenameDocument}
              >
                <Ionicons name="pencil-outline" size={20} color="#6B7280" />
                <Text style={dynamicStyles.kebabMenuText}>Rename</Text>
              </TouchableOpacity>
            )}

            {!isLockedBookmarkFile(
              selectedDocumentForMenu?.id,
              fileIdsInLockedBookmarks,
              selectedDocumentForMenu?.in_locked_bookmark
            ) && (
              <FeedbackTouchable
                style={dynamicStyles.kebabMenuItem}
                onPress={() => {
                  console.log('🗑️ Delete button pressed in kebab menu');
                  handleDeleteDocument();
                }}
                replaceWithSpinner={false}
                spinnerColor="#EF4444"
              >
                <Ionicons name="trash-outline" size={20} color="#EF4444" />
                <Text style={[dynamicStyles.kebabMenuText, { color: '#EF4444' }]}>Delete</Text>
              </FeedbackTouchable>
            )}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Rename File Modal */}
      <Modal
        visible={showRenameModal}
        transparent
        animationType="fade"
        onRequestClose={() => !renaming && setShowRenameModal(false)}
      >
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <TouchableOpacity
            style={dynamicStyles.modalOverlay}
            activeOpacity={1}
            onPress={() => {
              Keyboard.dismiss();
              if (!renaming) setShowRenameModal(false);
            }}
          >
            <View style={dynamicStyles.renameModalContent} onStartShouldSetResponder={() => true}>
              <Text style={dynamicStyles.renameModalTitle}>Rename File</Text>
              {selectedDocumentForMenu ? (
                <FileNameText
                  name={`Current: ${selectedDocumentForMenu.name || selectedDocumentForMenu.original_filename}`}
                  style={dynamicStyles.renameModalCurrentLabel}
                  sanitize={false}
                />
              ) : null}
              <TextInput
                style={dynamicStyles.renameModalInput}
                value={renameInputValue}
                onChangeText={setRenameInputValue}
                placeholder="New filename (no extension)"
                placeholderTextColor="#999"
                editable={!renaming}
                autoCapitalize="none"
              />
              <View style={dynamicStyles.renameModalButtons}>
                <TouchableOpacity
                  style={dynamicStyles.renameModalCancelBtn}
                  onPress={() => !renaming && setShowRenameModal(false)}
                  disabled={renaming}
                >
                  <Text style={dynamicStyles.renameModalCancelText}>Cancel</Text>
                </TouchableOpacity>
                <FeedbackTouchable
                  style={[dynamicStyles.renameModalRenameBtn, (!renameInputValue.trim() || renaming) && dynamicStyles.renameModalBtnDisabled]}
                  onPress={handleSubmitRename}
                  disabled={!renameInputValue.trim() || renaming}
                  loading={renaming}
                  spinnerColor="#fff"
                >
                  <Text style={dynamicStyles.renameModalRenameText}>Rename</Text>
                </FeedbackTouchable>
              </View>
            </View>
          </TouchableOpacity>
        </KeyboardAvoidingView>
      </Modal>

      {/* Bookmark Selection Modal */}
      <Modal
        visible={showBookmarkModal}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setShowBookmarkModal(false)}
      >
        <TouchableOpacity
          style={dynamicStyles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowBookmarkModal(false)}
        >
          <View style={dynamicStyles.bookmarkModalContainer} onStartShouldSetResponder={() => true}>
            <View style={dynamicStyles.bookmarkModalHeader}>
              <Text style={dynamicStyles.bookmarkModalTitle}>Add to Bookmark</Text>
              <TouchableOpacity
                onPress={() => setShowBookmarkModal(false)}
              >
                <Ionicons name="close" size={24} color="#666" />
              </TouchableOpacity>
            </View>
            
            <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={dynamicStyles.bookmarkList} keyboardShouldPersistTaps="handled">
              {/* Create new bookmark section */}
              <View style={dynamicStyles.bookmarkCreateSection}>
                <Text style={[dynamicStyles.bookmarkSectionLabel, { color: colors.textSecondary }]}>Create new bookmark</Text>
                <View style={dynamicStyles.bookmarkInputRow}>
                  <TextInput
                    style={[dynamicStyles.bookmarkNameInput, { backgroundColor: colors.background, color: colors.text, borderColor: colors.border }]}
                    placeholder="Bookmark name"
                    placeholderTextColor={colors.textSecondary}
                    value={newBookmarkName}
                    onChangeText={setNewBookmarkName}
                    editable={!creatingBookmark}
                  />
                  <FeedbackTouchable
                    style={[dynamicStyles.bookmarkCreateButtonIcon, { opacity: creatingBookmark || !newBookmarkName.trim() ? 0.5 : 1 }]}
                    onPress={handleCreateNewBookmarkAndAddFile}
                    disabled={creatingBookmark || !newBookmarkName.trim()}
                    loading={creatingBookmark}
                    spinnerColor="#fff"
                  >
                    <Ionicons name="add-circle" size={28} color="#fff" />
                  </FeedbackTouchable>
                </View>
                <View style={dynamicStyles.bookmarkColorRow}>
                  {bookmarkColors.map((color) => (
                    <TouchableOpacity
                      key={color}
                      style={[
                        dynamicStyles.bookmarkColorChip,
                        { backgroundColor: color },
                        newBookmarkColor === color && dynamicStyles.bookmarkColorChipSelected,
                      ]}
                      onPress={() => setNewBookmarkColor(color)}
                    />
                  ))}
                </View>
              </View>

              <View style={[dynamicStyles.bookmarkDivider, { backgroundColor: colors.border }]} />
              <Text style={[dynamicStyles.bookmarkSectionLabel, { color: colors.textSecondary }]}>Existing bookmarks</Text>
              
              {bookmarks.filter((b: any) => !b.is_locked).map((bookmark) => (
                <FeedbackTouchable
                  key={bookmark.id}
                  style={dynamicStyles.bookmarkItem}
                  onPress={() => handleAddToBookmark(bookmark)}
                  replaceWithSpinner={false}
                  spinnerColor="#007AFF"
                >
                  <View style={[dynamicStyles.bookmarkColor, { backgroundColor: bookmark.color || '#007AFF' }]} />
                  <Text style={dynamicStyles.bookmarkName}>{bookmark.name}</Text>
                  <Ionicons name="chevron-forward" size={20} color="#ccc" />
                </FeedbackTouchable>
              ))}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Make Global (workspace visibility) Modal */}
      <Modal
        visible={showMakeGlobalModal}
        transparent
        animationType="fade"
        onRequestClose={() => !makeGlobalSaving && setShowMakeGlobalModal(false)}
      >
        <TouchableOpacity
          style={dynamicStyles.modalOverlay}
          activeOpacity={1}
          onPress={() => !makeGlobalSaving && setShowMakeGlobalModal(false)}
        >
          <View style={[dynamicStyles.bookmarkModalContainer, { maxWidth: 360 }]} onStartShouldSetResponder={() => true}>
            <View style={dynamicStyles.bookmarkModalHeader}>
              <Text style={dynamicStyles.bookmarkModalTitle}>{makeGlobalDocument?.is_global ? 'Change Global' : 'Make Global'}</Text>
              <TouchableOpacity
                onPress={() => !makeGlobalSaving && setShowMakeGlobalModal(false)}
                disabled={makeGlobalSaving}
              >
                <Ionicons name="close" size={24} color="#666" />
              </TouchableOpacity>
            </View>
            {makeGlobalDocument && (
              <Text style={[dynamicStyles.bookmarkSectionLabel, { color: colors.textSecondary, marginBottom: 8 }]} numberOfLines={1}>
                Share &quot;{makeGlobalDocument.name}&quot; with workspaces
              </Text>
            )}
            {makeGlobalLoading ? (
              <View style={{ padding: 24, alignItems: 'center' }}>
                <ActivityIndicator size="large" color="#007AFF" />
                <Text style={{ marginTop: 8, color: colors.textSecondary }}>Loading workspaces…</Text>
              </View>
            ) : (
              <>
                <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={dynamicStyles.bookmarkList} keyboardShouldPersistTaps="handled">
                  {makeGlobalWorkspaces.length === 0 && !makeGlobalLoading && (
                    <Text style={{ color: colors.textSecondary, padding: 16 }}>No workspaces. Create one in Workspaces.</Text>
                  )}
                  {makeGlobalWorkspaces.map((ws) => (
                    <TouchableOpacity
                      key={ws.id}
                      style={dynamicStyles.bookmarkItem}
                      onPress={() => handleMakeGlobalToggleWorkspace(ws.id)}
                      activeOpacity={0.7}
                    >
                      <Ionicons
                        name={makeGlobalSelectedIds.includes(ws.id) ? 'checkbox' : 'square-outline'}
                        size={24}
                        color={makeGlobalSelectedIds.includes(ws.id) ? '#007AFF' : colors.textSecondary}
                      />
                      <Text style={[dynamicStyles.bookmarkName, { flex: 1 }]} numberOfLines={1}>{ws.name ?? `Workspace ${ws.id}`}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
                <View style={{ flexDirection: 'row', padding: 16, gap: 12, borderTopWidth: 1, borderTopColor: colors.border }}>
                  <TouchableOpacity
                    style={{ flex: 1, padding: 12, borderRadius: 8, backgroundColor: colors.border, alignItems: 'center' }}
                    onPress={() => setShowMakeGlobalModal(false)}
                    disabled={makeGlobalSaving}
                  >
                    <Text style={{ color: colors.text }}>Cancel</Text>
                  </TouchableOpacity>
                  <FeedbackTouchable
                    style={{ flex: 1, padding: 12, borderRadius: 8, backgroundColor: '#007AFF', alignItems: 'center' }}
                    onPress={handleMakeGlobalSave}
                    disabled={makeGlobalSaving}
                    loading={makeGlobalSaving}
                    spinnerColor="#fff"
                  >
                    <Text style={{ color: '#fff', fontWeight: '600' }}>Save</Text>
                  </FeedbackTouchable>
                </View>
              </>
            )}
          </View>
        </TouchableOpacity>
      </Modal>
      
      {/* Category Selection Modal */}
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
          <FeedbackTouchable
            key={category}
            style={dynamicStyles.categoryModalItem}
            onPress={() => handleSelectCategory(category)}
            disabled={categorizingReceipt}
            loading={categorizingReceipt}
            replaceWithSpinner={false}
            spinnerColor="#007AFF"
          >
            <Text style={dynamicStyles.categoryItemText}>{category}</Text>
            <Ionicons name="chevron-forward" size={20} color="#999" />
          </FeedbackTouchable>
        ))}
      </AdaptiveListPickerModal>

      {/* Payment Status Selection Modal */}
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
          <FeedbackTouchable
            key={status}
            style={dynamicStyles.categoryModalItem}
            onPress={() => handleSelectPaymentStatus(status)}
            disabled={updatingPaymentStatus}
            loading={updatingPaymentStatus}
            replaceWithSpinner={false}
            spinnerColor="#007AFF"
          >
            <Text style={dynamicStyles.categoryItemText}>{status}</Text>
            <Ionicons name="chevron-forward" size={20} color="#999" />
          </FeedbackTouchable>
        ))}
      </AdaptiveListPickerModal>

      <CreateFolderSheet
        visible={showCreateFolder}
        onClose={() => setShowCreateFolder(false)}
        onSubmit={(name) => folderSystem.createFolder(name)}
      />
      <RenameFolderSheet
        visible={renameFolderTarget != null}
        initialName={renameFolderTarget?.name ?? ''}
        onClose={() => setRenameFolderTarget(null)}
        onSubmit={(name) =>
          renameFolderTarget
            ? folderSystem.renameFolderById(renameFolderTarget.id, name)
            : Promise.resolve()
        }
      />
      <FolderKebabMenu
        visible={showFolderKebabMenu}
        folder={folderMenuTarget}
        onClose={handleCloseFolderKebabMenu}
        onAction={handleFolderKebabAction}
      />
      <FolderMovePicker
        visible={showFolderMovePicker}
        onClose={() => {
          setShowFolderMovePicker(false);
          setMoveFileIds([]);
          setMoveFolderTarget(null);
        }}
        workspaceId={folderSystem.currentFolderWorkspaceId ?? workspaceId}
        title={moveFileIds.length ? 'Move files to' : 'Move folder to'}
        onSelect={(folderId) => {
          if (moveFileIds.length) {
            void folderSystem.moveFiles(moveFileIds, folderId);
          } else if (moveFolderTarget) {
            void folderSystem.moveFolderById(moveFolderTarget.id, folderId);
          }
        }}
      />
      <AiFileManagerBottomSheet
        visible={showAiFmSheet}
        onClose={() => setShowAiFmSheet(false)}
        workspaceId={aiFmWorkspaceId ?? workspaceId ?? folderSystem.currentFolderWorkspaceId}
        currentFolderId={folderSystem.currentFolderId}
        onExecuted={onFmExecuted}
        expandNonce={aiFmExpandNonce}
      />
      <UploadOptionsModal
        visible={uploadSheet.visible}
        expandNonce={uploadSheet.expandNonce}
        isUploading={isUploading}
        onDismiss={dismissUploadModal}
        onFiles={handleUploadFromFilesViaModal}
        onCamera={handleUploadFromCameraViaModal}
        onGallery={handleUploadFromGalleryViaModal}
        onLink={handleUploadByLinkViaModal}
      />
      <ActionMenuModal
        visible={showSortMenu}
        title="Sort options"
        items={sortMenuItems}
        onClose={() => setShowSortMenu(false)}
      />
      </TapToToggleHeaderView>
    </SafeAreaView>
  );
}

import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
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
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AppBackButton, { APP_BACK_BUTTON_SLOT } from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import { useThemeColors } from '../../hooks/useThemeColors';
import { useOpenChatGD } from '../../contexts/ChatGDSheetContext';
import { apiClient } from '../../services/api';
import { bookmarksListScreenKey } from '../../services/userScopedCache';
import { screenCache } from '../../utils/screenCache';
import { floatingDialogSurfaceStyle, modalScrimOverlayStyle } from '../../utils/dialogSurfaceStyles';
import { useAuth } from '../context/auth';

interface Bookmark {
  id: number;
  name: string;
  description?: string;
  color: string;
  file_count: number;
  created_at: string;
  is_active: boolean;
  is_locked?: boolean;
}

type PaginatedBookmarksCache = {
  items: Bookmark[];
  hasMore: boolean;
};

const BOOKMARKS_PAGE_SIZE = 20;

export default function ManageBookmarksScreen() {
  const router = useRouter();
  const openChatGD = useOpenChatGD();
  const { user } = useAuth();
  const colors = useThemeColors();
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const hasMoreRef = useRef(true);
  const loadingMoreRef = useRef(false);
  const offsetRef = useRef(0);
  const onEndReachedCalledDuringMomentumRef = useRef(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [bookmarkToRename, setBookmarkToRename] = useState<Bookmark | null>(null);
  const [renameInputValue, setRenameInputValue] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [togglingLockId, setTogglingLockId] = useState<number | null>(null);
  const [newBookmarkName, setNewBookmarkName] = useState('');
  const [newBookmarkDescription, setNewBookmarkDescription] = useState('');
  const [selectedColor, setSelectedColor] = useState('#007AFF');

  const bookmarkColors = [
    '#007AFF', '#34C759', '#FF9500', '#FF3B30', 
    '#AF52DE', '#5856D6', '#8E44AD', '#E74C3C'
  ];

  const BOOKMARKS_LIST_CACHE_MS = 30_000;
  const bookmarksCacheKey = bookmarksListScreenKey(user?.id);

  const loadBookmarks = async (forceRefresh = false, append = false) => {
    if (!user?.id) return;

    if (append && (!hasMoreRef.current || loadingMoreRef.current)) return;

    if (!forceRefresh && !append && bookmarksCacheKey) {
      const cached = screenCache.get<PaginatedBookmarksCache>(bookmarksCacheKey, BOOKMARKS_LIST_CACHE_MS);
      if (cached) {
        setBookmarks(cached.items);
        setHasMore(cached.hasMore);
        hasMoreRef.current = cached.hasMore;
        offsetRef.current = cached.items.length;
        setLoading(false);
        setRefreshing(false);
        return;
      }
    }

    const fetchOffset = append ? offsetRef.current : 0;
    if (append) {
      loadingMoreRef.current = true;
      setLoadingMore(true);
    } else if (!forceRefresh) {
      setLoading(true);
    }

    try {
      const response = await apiClient.getBookmarks(BOOKMARKS_PAGE_SIZE, fetchOffset);
      
      if (response.success && response.data) {
        const bookmarksData = Array.isArray(response.data) 
          ? response.data 
          : (response.data.bookmarks || []);
        const pagination = response.pagination ?? response.data?.pagination;
        const hasMorePage =
          pagination?.has_more === true ||
          (pagination?.has_more !== false && bookmarksData.length >= BOOKMARKS_PAGE_SIZE);

        setBookmarks((prev) => {
          const merged = append ? [...prev, ...bookmarksData] : bookmarksData;
          offsetRef.current = merged.length;
          if (!append && bookmarksCacheKey) {
            screenCache.set(bookmarksCacheKey, { items: merged, hasMore: hasMorePage });
          }
          return merged;
        });
        setHasMore(hasMorePage);
        hasMoreRef.current = hasMorePage;
      } else if (!append) {
        setBookmarks([]);
      }
    } catch {
      if (!append) setBookmarks([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  };

  const loadMoreBookmarks = () => {
    if (loading || refreshing || loadingMoreRef.current || !hasMoreRef.current) return;
    void loadBookmarks(false, true);
  };

  // Reload on focus so the list reflects changes made inside a bookmark detail,
  // but respect the cache TTL to avoid redundant calls on quick tab switches.
  useFocusEffect(
    useCallback(() => {
      if (user?.id) loadBookmarks();
    }, [user?.id])
  );

  const onRefresh = () => {
    setRefreshing(true);
    offsetRef.current = 0;
    hasMoreRef.current = true;
    if (bookmarksCacheKey) screenCache.invalidate(bookmarksCacheKey);
    loadBookmarks(true);
  };

  const handleCreateBookmark = async () => {
    if (!newBookmarkName.trim()) {
      Alert.alert('Error', 'Please enter a bookmark name');
      return;
    }

    setCreating(true);
    try {
      const response = await apiClient.createBookmark({
        name: newBookmarkName.trim(),
        description: newBookmarkDescription.trim() || undefined,
        color: selectedColor
      });

      if (response.success) {
        Alert.alert('Success', 'Bookmark created successfully!');
        setShowCreateModal(false);
        setNewBookmarkName('');
        setNewBookmarkDescription('');
        setSelectedColor('#007AFF');
        if (bookmarksCacheKey) screenCache.invalidate(bookmarksCacheKey);
        loadBookmarks(true);
      } else {
        Alert.alert('Error', response.message || 'Failed to create bookmark');
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to create bookmark');
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteBookmark = (bookmark: Bookmark) => {
    Alert.alert(
      'Delete Bookmark',
      `Are you sure you want to delete "${bookmark.name}"? This action cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeletingId(bookmark.id);
            try {
              const response = await apiClient.deleteBookmark(bookmark.id);
              if (response.success) {
                Alert.alert('Success', 'Bookmark deleted successfully!');
                if (bookmarksCacheKey) screenCache.invalidate(bookmarksCacheKey);
                loadBookmarks(true);
              } else {
                Alert.alert('Error', response.message || 'Failed to delete bookmark');
              }
            } catch (error: any) {
              Alert.alert('Error', error.message || 'Failed to delete bookmark');
            } finally {
              setDeletingId(null);
            }
          }
        }
      ]
    );
  };

  const handleBookmarkPress = (bookmark: Bookmark) => {
    router.push({
      pathname: '/bookmarks/detail',
      params: { id: bookmark.id.toString() }
    });
  };

  const handleOpenRename = (bookmark: Bookmark, e: any) => {
    e?.stopPropagation?.();
    setBookmarkToRename(bookmark);
    setRenameInputValue(bookmark.name);
    setShowRenameModal(true);
  };

  const handleRenameBookmark = async () => {
    if (!bookmarkToRename || !renameInputValue.trim()) return;
    setRenaming(true);
    try {
      const response = await apiClient.updateBookmark(bookmarkToRename.id, {
        name: renameInputValue.trim(),
      });
      if (response.success) {
        setShowRenameModal(false);
        setBookmarkToRename(null);
        setRenameInputValue('');
        if (bookmarksCacheKey) screenCache.invalidate(bookmarksCacheKey);
        loadBookmarks(true);
        Alert.alert('Success', 'Bookmark renamed successfully');
      } else {
        Alert.alert('Error', response.message || 'Failed to rename bookmark');
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to rename bookmark');
    } finally {
      setRenaming(false);
    }
  };

  const handleChatWithBookmark = (bookmark: Bookmark, e: any) => {
    e?.stopPropagation?.();
    openChatGD({
      bookmark_id: bookmark.id.toString(),
      bookmark_name: bookmark.name,
      bookmark_description: bookmark.description || '',
      bookmark_file_count: bookmark.file_count.toString(),
    });
  };

  const handleToggleLock = (item: Bookmark, e: any) => {
    e?.stopPropagation?.();
    const newLocked = !item.is_locked;

    const doToggle = async () => {
      setTogglingLockId(item.id);
      try {
        const response = await apiClient.updateBookmark(item.id, { is_locked: newLocked });
        if (response.success) {
          setBookmarks(prev => prev.map(b =>
            b.id === item.id ? { ...b, is_locked: newLocked } : b
          ));
          if (bookmarksCacheKey) screenCache.invalidate(bookmarksCacheKey);
          Alert.alert('Success', newLocked ? 'Bookmark locked' : 'Bookmark unlocked');
        } else {
          Alert.alert('Error', response.message || 'Failed to update bookmark lock');
        }
      } catch (error: any) {
        Alert.alert('Error', error.message || 'Failed to update bookmark lock');
      } finally {
        setTogglingLockId(null);
      }
    };

    if (!newLocked) {
      Alert.alert(
        'Unlock Bookmark',
        `Unlock "${item.name}"? Files can be added or removed once unlocked.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Unlock', onPress: doToggle },
        ]
      );
    } else {
      doToggle();
    }
  };

  const dynamicStyles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.headerBackground,
    },
    content: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-start',
      gap: 4,
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: colors.headerBackground,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    headerTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: colors.text,
    },
    addButton: {
      padding: 4,
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    loadingText: {
      marginTop: 8,
      color: colors.textSecondary,
    },
    content: {
      flex: 1,
      padding: 10,
    },
    listContent: {
      padding: 10,
      paddingBottom: 24,
    },
    emptyListContent: {
      flexGrow: 1,
      padding: 10,
    },
    emptyState: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingVertical: 64,
    },
    emptyStateTitle: {
      fontSize: 20,
      fontWeight: '600',
      color: colors.text,
      marginTop: 16,
      marginBottom: 8,
    },
    emptyStateDescription: {
      fontSize: 14,
      color: colors.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
      marginBottom: 24,
    },
    createFirstButton: {
      backgroundColor: '#007AFF',
      paddingVertical: 12,
      paddingHorizontal: 24,
      borderRadius: 8,
    },
    createFirstButtonText: {
      color: '#fff',
      fontSize: 16,
      fontWeight: '600',
    },
    bookmarkCard: {
      backgroundColor: colors.card,
      borderRadius: 8,
      padding: 10,
      paddingRight: 8,
      marginBottom: 6,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.1,
      shadowRadius: 2,
      elevation: 2,
    },
    bookmarkHeader: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    bookmarkActions: {
      flexDirection: 'row',
      alignItems: 'center',
      marginLeft: 'auto',
      gap: 4,
    },
    bookmarkColorIndicator: {
      width: 16,
      height: 16,
      borderRadius: 8,
      marginRight: 12,
    },
    bookmarkInfo: {
      flex: 1,
    },
    bookmarkNameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginBottom: 4,
    },
    bookmarkName: {
      fontSize: 16,
      fontWeight: '600',
      color: colors.text,
      flex: 1,
    },
    chatgdButton: {
      padding: 4,
    },
    bookmarkDescription: {
      fontSize: 14,
      color: colors.textSecondary,
      marginBottom: 4,
    },
    bookmarkMeta: {
      fontSize: 12,
      color: colors.textLight,
    },
    deleteButton: {
      padding: 4,
    },
    modalOverlay: modalScrimOverlayStyle(colors.isDark, {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 16,
    }),
    modalContainer: {
      ...floatingDialogSurfaceStyle(colors, colors.isDark),
      width: '100%',
      maxWidth: 400,
    },
    modalHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    modalTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: colors.text,
    },
    modalContent: {
      padding: 12,
    },
    inputLabel: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.text,
      marginBottom: 6,
      marginTop: 8,
    },
    textInput: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      padding: 10,
      fontSize: 14,
      color: colors.text,
      backgroundColor: colors.surface,
    },
    textArea: {
      height: 60,
      textAlignVertical: 'top',
    },
    colorPicker: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      marginTop: 4,
    },
    colorOption: {
      width: 32,
      height: 32,
      borderRadius: 16,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 2,
      borderColor: 'transparent',
    },
    selectedColorOption: {
      borderColor: colors.text,
    },
    modalActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      padding: 12,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      gap: 8,
    },
    cancelButton: {
      paddingVertical: 8,
      paddingHorizontal: 16,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
    },
    cancelButtonText: {
      color: colors.textSecondary,
      fontSize: 14,
      fontWeight: '600',
    },
    createButton: {
      backgroundColor: '#007AFF',
      paddingVertical: 8,
      paddingHorizontal: 16,
      borderRadius: 8,
    },
    createButtonText: {
      color: '#fff',
      fontSize: 14,
      fontWeight: '600',
    },
  }), [colors]);

  const renderBookmarkItem = ({ item }: { item: Bookmark }) => (
    <TouchableOpacity 
      style={dynamicStyles.bookmarkCard}
      onPress={() => handleBookmarkPress(item)}
    >
      <View style={dynamicStyles.bookmarkHeader}>
        <View style={[dynamicStyles.bookmarkColorIndicator, { backgroundColor: item.color }]} />
        <View style={dynamicStyles.bookmarkInfo}>
          <View style={dynamicStyles.bookmarkNameRow}>
            <Text style={dynamicStyles.bookmarkName}>{item.name.length > 30 ? `${item.name.slice(0, 30)}...` : item.name}</Text>
            {item.is_locked && (
              <Ionicons name="lock-closed" size={16} color="#F59E0B" style={{ marginLeft: 4 }} />
            )}
          </View>
          {item.description && (
            <Text style={dynamicStyles.bookmarkDescription}>{item.description}</Text>
          )}
          <Text style={dynamicStyles.bookmarkMeta}>
            {item.file_count} file{item.file_count !== 1 ? 's' : ''}
          </Text>
        </View>
        <View style={dynamicStyles.bookmarkActions}>
          <TouchableOpacity
            style={dynamicStyles.chatgdButton}
            onPress={(e) => handleChatWithBookmark(item, e)}
          >
            <Ionicons name="chatbubble-outline" size={20} color="#4F46E5" />
          </TouchableOpacity>
          <FeedbackTouchable
            style={dynamicStyles.chatgdButton}
            onPress={(e) => handleToggleLock(item, e)}
            accessibilityLabel={item.is_locked ? 'Unlock bookmark' : 'Lock bookmark'}
            loading={togglingLockId === item.id}
            spinnerColor="#F59E0B"
          >
            <Ionicons name={item.is_locked ? 'lock-open-outline' : 'lock-closed-outline'} size={20} color="#F59E0B" />
          </FeedbackTouchable>
          {!item.is_locked && (
            <TouchableOpacity
              style={dynamicStyles.chatgdButton}
              onPress={(e) => {
                e.stopPropagation();
                router.push({ pathname: '/bookmarks/detail', params: { id: item.id.toString(), addFiles: '1' } });
              }}
              accessibilityLabel="Add files to bookmark"
            >
              <Ionicons name="add" size={20} color="#007AFF" />
            </TouchableOpacity>
          )}
          {!item.is_locked && (
            <FeedbackTouchable
              style={dynamicStyles.deleteButton}
              onPress={(e) => {
                e.stopPropagation();
                handleDeleteBookmark(item);
              }}
              loading={deletingId === item.id}
              spinnerColor="#FF3B30"
            >
              <Ionicons name="trash-outline" size={20} color="#FF3B30" />
            </FeedbackTouchable>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );

  const renderColorOption = (color: string) => (
    <TouchableOpacity
      key={color}
      style={[
        dynamicStyles.colorOption,
        { backgroundColor: color },
        selectedColor === color && dynamicStyles.selectedColorOption
      ]}
      onPress={() => setSelectedColor(color)}
    >
      {selectedColor === color && (
        <Ionicons name="checkmark" size={16} color="#fff" />
      )}
    </TouchableOpacity>
  );

  if (loading) {
    return (
      <SafeAreaView style={dynamicStyles.container} edges={['top']}>
        <View style={dynamicStyles.header}>
          <AppBackButton />
          <AppHeaderTitle>Bookmarks</AppHeaderTitle>
          <View style={{ width: APP_BACK_BUTTON_SLOT }} />
        </View>
        <View style={[dynamicStyles.loadingContainer, dynamicStyles.content]}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={dynamicStyles.loadingText}>Loading bookmarks...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={dynamicStyles.container} edges={['top']}>
      <View style={dynamicStyles.header}>
        <AppBackButton />
        <AppHeaderTitle>Manage Bookmarks</AppHeaderTitle>
        <TouchableOpacity
          style={dynamicStyles.addButton}
          onPress={() => setShowCreateModal(true)}
        >
          <Ionicons name="add" size={24} color="#007AFF" />
        </TouchableOpacity>
      </View>

      <FlatList
        style={dynamicStyles.content}
        data={bookmarks}
        renderItem={renderBookmarkItem}
        keyExtractor={(item) => item.id.toString()}
        contentContainerStyle={bookmarks.length === 0 ? dynamicStyles.emptyListContent : dynamicStyles.listContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        onEndReached={loadMoreBookmarks}
        onEndReachedThreshold={0.4}
        onMomentumScrollBegin={() => {
          onEndReachedCalledDuringMomentumRef.current = false;
        }}
        ListEmptyComponent={
          !loading ? (
            <View style={dynamicStyles.emptyState}>
              <Ionicons name="bookmark-outline" size={64} color={colors.textLight} />
              <Text style={dynamicStyles.emptyStateTitle}>No bookmarks yet</Text>
              <Text style={dynamicStyles.emptyStateDescription}>
                Create your first bookmark to organize your documents
              </Text>
              <TouchableOpacity
                style={dynamicStyles.createFirstButton}
                onPress={() => setShowCreateModal(true)}
              >
                <Text style={dynamicStyles.createFirstButtonText}>Create Bookmark</Text>
              </TouchableOpacity>
            </View>
          ) : null
        }
        ListFooterComponent={
          loadingMore ? (
            <View style={{ paddingVertical: 16, alignItems: 'center' }}>
              <ActivityIndicator size="small" color="#007AFF" />
            </View>
          ) : null
        }
        showsVerticalScrollIndicator={false}
      />

      {/* Create Bookmark Modal */}
      {showCreateModal && (
        <KeyboardAvoidingView
          style={dynamicStyles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={dynamicStyles.modalContainer}>
            <View style={dynamicStyles.modalHeader}>
              <Text style={dynamicStyles.modalTitle}>Create Bookmark</Text>
              <TouchableOpacity onPress={() => setShowCreateModal(false)}>
                <Ionicons name="close" size={20} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={dynamicStyles.modalContent}>
              <Text style={[dynamicStyles.inputLabel, { marginTop: 0 }]}>Name *</Text>
              <TextInput
                style={dynamicStyles.textInput}
                value={newBookmarkName}
                onChangeText={setNewBookmarkName}
                placeholder="Enter bookmark name"
                placeholderTextColor={colors.textLight}
              />

              <Text style={dynamicStyles.inputLabel}>Description</Text>
              <TextInput
                style={[dynamicStyles.textInput, dynamicStyles.textArea]}
                value={newBookmarkDescription}
                onChangeText={setNewBookmarkDescription}
                placeholder="Enter description (optional)"
                placeholderTextColor={colors.textLight}
                multiline
                numberOfLines={3}
              />

              <Text style={dynamicStyles.inputLabel}>Color</Text>
              <View style={dynamicStyles.colorPicker}>
                {bookmarkColors.map(renderColorOption)}
              </View>
            </View>

            <View style={dynamicStyles.modalActions}>
              <TouchableOpacity
                style={dynamicStyles.cancelButton}
                onPress={() => setShowCreateModal(false)}
              >
                <Text style={dynamicStyles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <FeedbackTouchable
                style={dynamicStyles.createButton}
                onPress={handleCreateBookmark}
                disabled={creating}
                loading={creating}
                spinnerColor="#fff"
                replaceWithSpinner={false}
              >
                <Text style={dynamicStyles.createButtonText}>{creating ? 'Creating...' : 'Create'}</Text>
              </FeedbackTouchable>
            </View>
          </View>
        </KeyboardAvoidingView>
      )}

      {/* Rename Bookmark Modal */}
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
            <View style={dynamicStyles.modalContainer} onStartShouldSetResponder={() => true}>
              <View style={dynamicStyles.modalHeader}>
                <Text style={dynamicStyles.modalTitle}>Rename Bookmark</Text>
                <TouchableOpacity onPress={() => !renaming && setShowRenameModal(false)}>
                  <Ionicons name="close" size={20} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>
              <View style={dynamicStyles.modalContent}>
                <Text style={[dynamicStyles.inputLabel, { marginTop: 0 }]}>Name</Text>
                <TextInput
                  style={dynamicStyles.textInput}
                  value={renameInputValue}
                  onChangeText={setRenameInputValue}
                  placeholder="Enter bookmark name"
                  placeholderTextColor={colors.textLight}
                  editable={!renaming}
                  autoFocus
                />
              </View>
              <View style={dynamicStyles.modalActions}>
                <TouchableOpacity
                  style={dynamicStyles.cancelButton}
                  onPress={() => !renaming && setShowRenameModal(false)}
                  disabled={renaming}
                >
                  <Text style={dynamicStyles.cancelButtonText}>Cancel</Text>
                </TouchableOpacity>
                <FeedbackTouchable
                  style={dynamicStyles.createButton}
                  onPress={handleRenameBookmark}
                  disabled={renaming || !renameInputValue.trim()}
                  loading={renaming}
                  spinnerColor="#fff"
                  replaceWithSpinner={false}
                >
                  <Text style={dynamicStyles.createButtonText}>
                    {renaming ? 'Saving...' : 'Save'}
                  </Text>
                </FeedbackTouchable>
              </View>
            </View>
          </TouchableOpacity>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}


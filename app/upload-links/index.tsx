import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Clipboard,
  FlatList,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiService } from '../../services/api';
import { uploadLinksListScreenKey } from '../../services/userScopedCache';
import { screenCache } from '../../utils/screenCache';
import { buildUploadLinkUrl, getUploadToBaseUrl } from '../../utils/uploadLinkHelpers';
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
}

const UPLOAD_LINKS_LIST_CACHE_MS = 30_000;
const UPLOAD_LINKS_PAGE_SIZE = 20;

const ANDROID_TEXT_INPUT_PROPS =
  Platform.OS === 'android' ? { underlineColorAndroid: 'transparent' as const } : {};

type PaginatedUploadLinksCache = {
  items: UploadLink[];
  hasMore: boolean;
  page: number;
};

export default function UploadLinksScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const colors = useThemeColors();
  const [uploadLinks, setUploadLinks] = useState<UploadLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [menuVisible, setMenuVisible] = useState(false);
  const [selectedLink, setSelectedLink] = useState<UploadLink | null>(null);
  const [menuBusy, setMenuBusy] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const hasMoreRef = useRef(true);
  const loadingMoreRef = useRef(false);
  const pageRef = useRef(1);
  const onEndReachedCalledDuringMomentumRef = useRef(false);
  const searchQueryRef = useRef('');
  const skipFirstSearchReloadRef = useRef(true);

  searchQueryRef.current = searchQuery;

  const listCacheKey = uploadLinksListScreenKey(user?.id);

  const loadUploadLinks = useCallback(async (forceRefresh = false, append = false) => {
    if (!user) {
      setLoading(false);
      return;
    }

    if (append && (!hasMoreRef.current || loadingMoreRef.current)) return;

    const q = searchQueryRef.current;
    const cacheKey = q ? null : listCacheKey;

    if (!forceRefresh && !append && cacheKey) {
      const cached = screenCache.get<PaginatedUploadLinksCache>(cacheKey, UPLOAD_LINKS_LIST_CACHE_MS);
      if (cached) {
        setUploadLinks(cached.items);
        setHasMore(cached.hasMore);
        hasMoreRef.current = cached.hasMore;
        pageRef.current = cached.page;
        setLoading(false);
        setRefreshing(false);
        return;
      }
    }

    const fetchPage = append ? pageRef.current + 1 : 1;
    if (append) {
      loadingMoreRef.current = true;
      setLoadingMore(true);
    } else if (!forceRefresh) {
      setLoading(true);
    }

    try {
      const response = await apiService.getUploadLinks(fetchPage, UPLOAD_LINKS_PAGE_SIZE, q || undefined);
      if (response.success) {
        const rows = response.upload_links || [];
        const pagination = response.pagination;
        const hasMorePage =
          pagination?.has_more === true ||
          (pagination?.has_more !== false && rows.length >= UPLOAD_LINKS_PAGE_SIZE);

        setUploadLinks((prev) => {
          const merged = append ? [...prev, ...rows] : rows;
          pageRef.current = fetchPage;
          if (!append && cacheKey) {
            screenCache.set(cacheKey, { items: merged, hasMore: hasMorePage, page: fetchPage });
          }
          return merged;
        });
        setHasMore(hasMorePage);
        hasMoreRef.current = hasMorePage;
      } else if (!append) {
        console.error('Get upload links error:', response.message || 'Failed to load upload links');
        Alert.alert('Error', response.message || 'Failed to load upload links');
      }
    } catch (error: any) {
      console.error('Load upload links error:', error);
      if (!append) Alert.alert('Error', error.message || 'Failed to load upload links');
    } finally {
      setLoading(false);
      setRefreshing(false);
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [user, listCacheKey]);

  const loadMoreUploadLinks = useCallback(() => {
    if (loading || refreshing || loadingMoreRef.current || !hasMoreRef.current) return;
    void loadUploadLinks(false, true);
  }, [loading, refreshing, loadUploadLinks]);

  // Add debounce to prevent excessive reloads
  const lastLoadTimeRef = useRef<number>(0);
  const RELOAD_DEBOUNCE_MS = 2000; // Don't reload if less than 2 seconds since last load
  
  useFocusEffect(
    useCallback(() => {
      if (!user) return;
      const now = Date.now();
      // After create/update/delete the list cache is invalidated — always refetch then,
      // even inside the debounce window, so new items appear immediately on return.
      const hasFreshCache = !!(
        listCacheKey &&
        screenCache.get<PaginatedUploadLinksCache>(listCacheKey, UPLOAD_LINKS_LIST_CACHE_MS)
      );
      if (!hasFreshCache || now - lastLoadTimeRef.current > RELOAD_DEBOUNCE_MS) {
        lastLoadTimeRef.current = now;
        loadUploadLinks(!hasFreshCache);
      }
    }, [user, loadUploadLinks, listCacheKey])
  );

  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    if (skipFirstSearchReloadRef.current) {
      skipFirstSearchReloadRef.current = false;
      return;
    }
    pageRef.current = 1;
    hasMoreRef.current = true;
    void loadUploadLinks(true);
  }, [searchQuery, loadUploadLinks]);

  const handleRefresh = () => {
    if (!user) return;
    setRefreshing(true);
    pageRef.current = 1;
    hasMoreRef.current = true;
    if (listCacheKey) screenCache.invalidate(listCacheKey);
    loadUploadLinks(true);
  };

  const handleCreateLink = () => {
    router.push('/upload-links/create');
  };

  const handleLinkPress = (link: UploadLink) => {
    router.push(`/upload-links/${link.id}`);
  };

  const doShare = async (link: UploadLink) => {
    const fullUrl = buildUploadLinkUrl(link.token || link.url);
    if (!fullUrl) {
      Alert.alert('Error', 'This file request has no shareable link yet');
      return;
    }
    const message = `Upload files using this link: ${fullUrl}\n\nLink: ${link.name}\n${link.description ? `Description: ${link.description}` : ''}`;
    if (Platform.OS === 'ios' || Platform.OS === 'android') {
      await Share.share({
        message,
        url: fullUrl,
        title: `Upload Link: ${link.name}`,
      });
      return;
    }
    // Web / desktop: no native share sheet — copy instead so the action still works
    Clipboard.setString(fullUrl);
    Alert.alert('Link copied', 'The upload link was copied to your clipboard.');
  };

  const handleShareLink = async (link: UploadLink) => {
    try {
      await doShare(link);
    } catch (error: any) {
      console.error('Share error:', error);
      Alert.alert('Error', error?.message || 'Failed to share upload link');
    }
  };

  const handleToggleActive = async (link: UploadLink) => {
    setMenuBusy(true);
    try {
      const response = await apiService.updateUploadLink(link.id, {
        is_active: !link.is_active
      });
      
      if (response.success) {
        setUploadLinks(prev => 
          prev.map(l => 
            l.id === link.id ? { ...l, is_active: !l.is_active } : l
          )
        );
      } else {
        Alert.alert('Error', response.message || 'Failed to update link');
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to update link');
    } finally {
      setMenuBusy(false);
    }
  };

  const handleDeleteLink = (link: UploadLink) => {
    Alert.alert(
      'Delete File Request',
      `Are you sure you want to delete "${link.name}"? This action cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setMenuBusy(true);
            try {
              const response = await apiService.deleteUploadLink(link.id);
              if (response.success) {
                setUploadLinks(prev => prev.filter(l => l.id !== link.id));
              } else {
                Alert.alert('Error', response.message || 'Failed to delete link');
              }
            } catch (error: any) {
              Alert.alert('Error', error.message || 'Failed to delete link');
            } finally {
              setMenuBusy(false);
            }
          },
        },
      ]
    );
  };

  const handleViewFiles = (link: UploadLink) => {
    router.push(`/upload-links/${link.id}`);
  };

  const openMenu = (link: UploadLink) => {
    setSelectedLink(link);
    setMenuVisible(true);
  };

  const closeMenu = () => {
    setMenuVisible(false);
    setSelectedLink(null);
  };

  const onMenuShare = () => {
    const link = selectedLink;
    closeMenu();
    if (link) {
      requestAnimationFrame(() => {
        handleShareLink(link);
      });
    }
  };

  const onMenuDelete = () => {
    if (selectedLink) handleDeleteLink(selectedLink);
    closeMenu();
  };

  const onMenuOpen = () => {
    if (selectedLink) handleViewFiles(selectedLink);
    closeMenu();
  };

  const onMenuToggleActive = async () => {
    if (!selectedLink) return;
    await handleToggleActive(selectedLink);
    closeMenu();
  };

  const parseUtc = (dateString: string | undefined): Date => {
    if (!dateString || typeof dateString !== 'string') return new Date(NaN);
    const s = dateString.trim();
    if (!s) return new Date(NaN);
    if (!/Z|[-+]\d{2}:?\d{2}$/.test(s)) return new Date(s + 'Z');
    return new Date(s);
  };

  const formatDate = (dateString: string) => {
    const date = parseUtc(dateString);
    if (isNaN(date.getTime())) return dateString;
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const isExpired = (expiresAt?: string) => {
    if (!expiresAt) return false;
    return parseUtc(expiresAt).getTime() < Date.now();
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
    searchContainer: {
      paddingHorizontal: 16,
      paddingTop: 10,
      paddingBottom: 6,
    },
    searchInputContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    searchIcon: {
      marginRight: 8,
    },
    searchInput: {
      flex: 1,
      fontSize: 14,
      color: colors.text,
      padding: 0,
      backgroundColor: 'transparent',
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
    emptyContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 32,
    },
    emptyTitle: {
      fontSize: 20,
      fontWeight: '600',
      color: colors.text,
      marginTop: 16,
      marginBottom: 8,
    },
    emptyDescription: {
      fontSize: 16,
      color: colors.textSecondary,
      textAlign: 'center',
      marginBottom: 24,
    },
    createButton: {
      backgroundColor: '#007AFF',
      paddingHorizontal: 24,
      paddingVertical: 12,
      borderRadius: 8,
    },
    createButtonText: {
      color: '#fff',
      fontSize: 16,
      fontWeight: '600',
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
    inactiveLinkCard: {
      opacity: 0.6,
    },
    linkHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      marginBottom: 12,
    },
    linkInfo: {
      flex: 1,
      marginRight: 12,
    },
    linkName: {
      fontSize: 16,
      fontWeight: '600',
      color: colors.text,
      marginBottom: 4,
    },
    linkDescription: {
      fontSize: 14,
      color: colors.textSecondary,
    },
    linkActions: {
      flexDirection: 'row',
    },
    actionButton: {
      padding: 8,
      marginLeft: 4,
    },
    linkStats: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: 8,
    },
    statItem: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    statText: {
      fontSize: 12,
      color: colors.textSecondary,
      marginLeft: 4,
    },
    statusBadge: {
      alignSelf: 'flex-start',
      backgroundColor: '#FF3B30',
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 4,
      marginBottom: 8,
    },
    statusText: {
      fontSize: 12,
      color: '#fff',
      fontWeight: '600',
    },
    createdDate: {
      fontSize: 12,
      color: colors.textLight,
    },
    menuOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      justifyContent: 'center',
      alignItems: 'center',
    },
    menuContainer: {
      backgroundColor: colors.card,
      borderRadius: 12,
      padding: 8,
      minWidth: 200,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.25,
      shadowRadius: 8,
      elevation: 5,
    },
    menuItem: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: 12,
      borderRadius: 8,
    },
    menuItemDanger: {
      marginTop: 4,
    },
    menuItemText: {
      fontSize: 16,
      color: colors.text,
      marginLeft: 12,
    },
    menuItemTextDanger: {
      color: '#FF3B30',
    },
    codeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: 6,
      marginTop: 8,
    },
    codeLabel: {
      fontSize: 11,
      color: colors.textSecondary,
    },
    codeValue: {
      fontSize: 12,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      fontWeight: '700',
      color: '#007AFF',
    },
    copyCodeBtn: {
      padding: 4,
    },
    listHint: {
      fontSize: 12,
      color: colors.textSecondary,
      paddingHorizontal: 16,
      paddingBottom: 8,
    },
  }), [colors, selectedLink]);

  const renderUploadLink = ({ item }: { item: UploadLink }) => {
    const expired = isExpired(item.expires_at);
    const limitReached = item.max_uploads && item.upload_count >= item.max_uploads;
    
    return (
      <TouchableOpacity
        style={[
          dynamicStyles.linkCard,
          (!item.is_active || expired || limitReached) && dynamicStyles.inactiveLinkCard
        ]}
        onPress={() => handleLinkPress(item)}
      >
        <View style={dynamicStyles.linkHeader}>
          <View style={dynamicStyles.linkInfo}>
            <Text style={dynamicStyles.linkName} numberOfLines={1} ellipsizeMode="tail">{item.name}</Text>
            {item.description && (
              <Text style={dynamicStyles.linkDescription}>{item.description}</Text>
            )}
          </View>
          <View style={dynamicStyles.linkActions}>
            <TouchableOpacity
              style={dynamicStyles.actionButton}
              onPress={(e) => {
                e.stopPropagation();
                openMenu(item);
              }}
            >
              <Ionicons name="ellipsis-vertical" size={20} color={colors.text} />
            </TouchableOpacity>
          </View>
        </View>

        <View style={dynamicStyles.linkStats}>
          <View style={dynamicStyles.statItem}>
            <Ionicons name="cloud-upload" size={16} color={colors.textSecondary} />
            <Text style={dynamicStyles.statText}>
              {item.upload_count}{item.max_uploads ? `/${item.max_uploads}` : ''} uploads
            </Text>
          </View>
          <View style={dynamicStyles.statItem}>
            <Ionicons name="time" size={16} color={colors.textSecondary} />
            <Text style={dynamicStyles.statText}>
              {item.expires_at ? 
                `Expires ${formatDate(item.expires_at)}` : 
                'Never expires'
              }
            </Text>
          </View>
        </View>

        {(!item.is_active || expired || limitReached) && (
          <View style={dynamicStyles.statusBadge}>
            <Text style={dynamicStyles.statusText}>
              {!item.is_active ? 'Inactive' : 
               expired ? 'Expired' : 
               'Limit Reached'}
            </Text>
          </View>
        )}

        <Text style={dynamicStyles.createdDate}>
          Created {formatDate(item.created_at)}
        </Text>

        {item.upload_code ? (
          <View style={dynamicStyles.codeRow}>
            <Text style={dynamicStyles.codeLabel}>Code:</Text>
            <Text style={dynamicStyles.codeValue}>{item.upload_code}</Text>
            <TouchableOpacity
              style={dynamicStyles.copyCodeBtn}
              onPress={(e) => {
                e.stopPropagation?.();
                Clipboard.setString(item.upload_code || '');
                Alert.alert('Copied', 'Upload code copied');
              }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="copy-outline" size={14} color="#007AFF" />
            </TouchableOpacity>
            <TouchableOpacity
              style={dynamicStyles.copyCodeBtn}
              onPress={(e) => {
                e.stopPropagation?.();
                const fullUrl = buildUploadLinkUrl(item.token || item.url);
                Clipboard.setString(fullUrl);
                Alert.alert('Copied', 'Upload link copied');
              }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="link-outline" size={14} color="#007AFF" />
            </TouchableOpacity>
          </View>
        ) : (
          <Text style={[dynamicStyles.codeLabel, { marginTop: 8, textAlign: 'right' }]}>No code</Text>
        )}
      </TouchableOpacity>
    );
  };

  if (loading) {
    return (
      <SafeAreaView style={dynamicStyles.container}>
        <View style={dynamicStyles.header}>
          <AppBackButton />
          <AppHeaderTitle>File Request</AppHeaderTitle>
          <View style={dynamicStyles.placeholder} />
        </View>
        <View style={dynamicStyles.centerContainer}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={dynamicStyles.loadingText}>Loading file requests...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={dynamicStyles.container}>
      <View style={dynamicStyles.header}>
        <AppBackButton />
        <AppHeaderTitle>File Request</AppHeaderTitle>
        <TouchableOpacity onPress={handleCreateLink} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Ionicons name="add" size={24} color="#007AFF" />
        </TouchableOpacity>
      </View>

      <View style={dynamicStyles.searchContainer}>
        <View style={dynamicStyles.searchInputContainer}>
          <Ionicons name="search" size={18} color={colors.textSecondary} style={dynamicStyles.searchIcon} />
          <TextInput
            {...ANDROID_TEXT_INPUT_PROPS}
            style={dynamicStyles.searchInput}
            placeholder="Search by name or upload code…"
            placeholderTextColor={colors.textSecondary}
            value={searchInput}
            onChangeText={setSearchInput}
            returnKeyType="search"
            onSubmitEditing={() => Keyboard.dismiss()}
          />
          {searchInput.length > 0 ? (
            <TouchableOpacity
              onPress={() => {
                setSearchInput('');
                setSearchQuery('');
                searchQueryRef.current = '';
              }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="close-circle" size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {uploadLinks.length === 0 ? (
        <View style={dynamicStyles.emptyContainer}>
          <Ionicons name="link" size={64} color={colors.textLight} />
          <Text style={dynamicStyles.emptyTitle}>
            {searchQuery ? 'No matching file requests' : 'No File Requests'}
          </Text>
          <Text style={dynamicStyles.emptyDescription}>
            {searchQuery
              ? 'Try a different name or upload code.'
              : 'Create file requests to receive files from others'}
          </Text>
          {!searchQuery ? (
            <TouchableOpacity style={dynamicStyles.createButton} onPress={handleCreateLink}>
              <Text style={dynamicStyles.createButtonText}>Create Your First File Request</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : (
        <FlatList
          data={uploadLinks}
          renderItem={renderUploadLink}
          keyExtractor={(item) => `upload-link-${item.id}`}
          contentContainerStyle={dynamicStyles.listContainer}
          ListHeaderComponent={
            <Text style={dynamicStyles.listHint}>
              Upload codes work at {getUploadToBaseUrl()}
            </Text>
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor="#007AFF"
            />
          }
          onEndReached={loadMoreUploadLinks}
          onEndReachedThreshold={0.4}
          onMomentumScrollBegin={() => {
            onEndReachedCalledDuringMomentumRef.current = false;
          }}
          ListFooterComponent={
            loadingMore ? (
              <View style={{ paddingVertical: 16 }}>
                <ActivityIndicator size="small" color="#007AFF" />
              </View>
            ) : null
          }
          showsVerticalScrollIndicator={false}
        />
      )}

      <Modal
        visible={menuVisible}
        transparent
        animationType="fade"
        onRequestClose={closeMenu}
      >
        <Pressable style={dynamicStyles.menuOverlay} onPress={closeMenu}>
          <Pressable style={dynamicStyles.menuContainer} onPress={(e) => e.stopPropagation()}>
            <TouchableOpacity style={dynamicStyles.menuItem} onPress={onMenuOpen}>
              <Ionicons name="folder-open" size={20} color={colors.text} />
              <Text style={dynamicStyles.menuItemText}>Open</Text>
            </TouchableOpacity>
            {selectedLink &&
             selectedLink.is_active &&
             !isExpired(selectedLink.expires_at) &&
             !(selectedLink.max_uploads != null && selectedLink.upload_count >= selectedLink.max_uploads) && (
              <TouchableOpacity style={dynamicStyles.menuItem} onPress={onMenuShare}>
                <Ionicons name="share" size={20} color={colors.text} />
                <Text style={dynamicStyles.menuItemText}>Share</Text>
              </TouchableOpacity>
            )}
            <FeedbackTouchable
              style={dynamicStyles.menuItem}
              onPress={onMenuToggleActive}
              loading={menuBusy}
              spinnerColor={colors.text}
              replaceWithSpinner={false}
            >
              <Ionicons
                name={selectedLink?.is_active ? 'pause' : 'play'}
                size={20}
                color={colors.text}
              />
              <Text style={dynamicStyles.menuItemText}>
                {menuBusy
                  ? 'Updating...'
                  : selectedLink?.is_active
                    ? 'Deactivate'
                    : 'Activate'}
              </Text>
            </FeedbackTouchable>
            <FeedbackTouchable
              style={[dynamicStyles.menuItem, dynamicStyles.menuItemDanger]}
              onPress={onMenuDelete}
              spinnerColor="#FF3B30"
              replaceWithSpinner={false}
            >
              <Ionicons name="trash" size={20} color="#FF3B30" />
              <Text style={[dynamicStyles.menuItemText, dynamicStyles.menuItemTextDanger]}>Delete</Text>
            </FeedbackTouchable>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

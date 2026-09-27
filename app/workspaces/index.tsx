import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    FlatList,
    RefreshControl,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiService } from '../../services/api';
import { workspacesListScreenKey } from '../../services/userScopedCache';
import { screenCache } from '../../utils/screenCache';
import { useAuth } from '../context/auth';

import AppBackButton from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';

interface Workspace {
  id: number;
  name: string;
  description?: string;
  slug: string;
  owner_id: number;
  is_personal: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  member_count: number;
  user_role: 'owner' | 'admin' | 'member' | 'viewer';
  can_manage: boolean;
  can_invite: boolean;
  can_edit: boolean;
}

type PaginatedWorkspacesCache = {
  items: Workspace[];
  hasMore: boolean;
};

const WORKSPACES_PAGE_SIZE = 20;
const WORKSPACES_CACHE_MS = 30_000;

export default function WorkspacesScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const colors = useThemeColors();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [busyWorkspaceId, setBusyWorkspaceId] = useState<number | null>(null);

  const hasMoreRef = useRef(true);
  const loadingMoreRef = useRef(false);
  const offsetRef = useRef(0);
  const onEndReachedCalledDuringMomentumRef = useRef(false);
  /** Prevents double-delete while the API/list refresh is still in flight. */
  const deletingIdsRef = useRef<Set<number>>(new Set());

  const workspacesCacheKey = workspacesListScreenKey(user?.id);

  const handleBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)' as any);
    }
  }, [router]);

  const loadWorkspaces = async (forceRefresh = false, append = false) => {
    if (!user) return;

    if (append && (!hasMoreRef.current || loadingMoreRef.current)) return;

    if (!forceRefresh && !append && workspacesCacheKey) {
      const cached = screenCache.get<PaginatedWorkspacesCache>(workspacesCacheKey, WORKSPACES_CACHE_MS);
      if (cached) {
        setWorkspaces(cached.items);
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
      const response = await apiService.getMobileWorkspaces(WORKSPACES_PAGE_SIZE, fetchOffset);
      if (response.success && response.data) {
        const workspacesData = Array.isArray(response.data) 
          ? response.data 
          : (response.data.workspaces || []);
        const pagination = response.pagination ?? response.data?.pagination;
        const hasMorePage =
          pagination?.has_more === true ||
          (pagination?.has_more !== false && workspacesData.length >= WORKSPACES_PAGE_SIZE);

        setWorkspaces((prev) => {
          const merged = append ? [...prev, ...workspacesData] : workspacesData;
          offsetRef.current = merged.length;
          if (!append && workspacesCacheKey) {
            screenCache.set(workspacesCacheKey, { items: merged, hasMore: hasMorePage });
          }
          return merged;
        });
        setHasMore(hasMorePage);
        hasMoreRef.current = hasMorePage;
      } else {
        if (!append) setWorkspaces([]);
      }
    } catch (error: any) {
      console.error('❌ Failed to load workspaces:', error);
      if (!append) setWorkspaces([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  };

  const loadMoreWorkspaces = () => {
    if (loading || refreshing || loadingMoreRef.current || !hasMoreRef.current) return;
    void loadWorkspaces(false, true);
  };

  useFocusEffect(
    useCallback(() => {
      if (user) loadWorkspaces();
    }, [user])
  );

  const handleRefresh = () => {
    if (!user) return;
    setRefreshing(true);
    offsetRef.current = 0;
    hasMoreRef.current = true;
    if (workspacesCacheKey) screenCache.invalidate(workspacesCacheKey);
    loadWorkspaces(true);
  };

  const handleDeleteWorkspace = (workspace: Workspace) => {
    if (deletingIdsRef.current.has(workspace.id) || busyWorkspaceId === workspace.id) {
      return;
    }

    Alert.alert(
      'Delete Workspace',
      `Are you sure you want to delete "${workspace.name}"? This action cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            if (deletingIdsRef.current.has(workspace.id)) return;
            deletingIdsRef.current.add(workspace.id);
            setBusyWorkspaceId(workspace.id);
            try {
              const response = await apiService.deleteWorkspace(workspace.id);
              if (response.success) {
                // Remove immediately so the user cannot tap delete again while refresh runs.
                setWorkspaces((prev) => prev.filter((w) => w.id !== workspace.id));
                if (workspacesCacheKey) screenCache.invalidate(workspacesCacheKey);
                await loadWorkspaces(true);
              } else {
                Alert.alert('Error', response.message || 'Failed to delete workspace');
              }
            } catch (error: any) {
              Alert.alert('Error', error.message || 'Failed to delete workspace');
            } finally {
              deletingIdsRef.current.delete(workspace.id);
              setBusyWorkspaceId((current) => (current === workspace.id ? null : current));
            }
          },
        },
      ]
    );
  };

  const handleToggleActive = async (workspace: Workspace) => {
    setBusyWorkspaceId(workspace.id);
    try {
      const response = await apiService.updateWorkspace(workspace.id, {
        is_active: !workspace.is_active
      });
      if (response.success) {
        if (workspacesCacheKey) screenCache.invalidate(workspacesCacheKey);
        loadWorkspaces(true);
      } else {
        Alert.alert('Error', response.message || 'Failed to update workspace');
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to update workspace');
    } finally {
      setBusyWorkspaceId(null);
    }
  };

  const handleLinkPress = (workspace: Workspace) => {
    // Check if workspace is inactive
    if (!workspace.is_active) {
      Alert.alert(
        'Workspace Inactive',
        'This workspace is currently paused and cannot be accessed. Contact the workspace owner to activate it.',
        [
          { text: 'OK' }
        ]
      );
      return;
    }
    
    router.push(`/workspaces/${workspace.id}`);
  };

  const dynamicStyles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-start',
      gap: 4,
      paddingHorizontal: 12,
      paddingVertical: 12,
      backgroundColor: colors.headerBackground,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      zIndex: 2,
      elevation: 2,
    },
    headerTitle: {
      flex: 1,
      fontSize: 18,
      fontWeight: '600',
      color: colors.text,
      textAlign: 'left',
      marginHorizontal: 4,
    },
    headerIconButton: {
      minWidth: 44,
      minHeight: 44,
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 3,
    },
    loadingContainer: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    listContainer: {
      padding: 16,
    },
    emptyContainer: {
      flex: 1,
    },
    workspaceCard: {
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
    workspaceHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
    },
    workspaceInfo: {
      flex: 1,
      marginRight: 12,
    },
    workspaceName: {
      fontSize: 16,
      fontWeight: '600',
      color: colors.text,
      marginBottom: 4,
    },
    workspaceDescription: {
      fontSize: 14,
      color: colors.textSecondary,
      marginBottom: 8,
    },
    workspaceMeta: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: 12,
    },
    roleContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surface,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 12,
    },
    roleText: {
      fontSize: 12,
      color: colors.textSecondary,
      marginLeft: 4,
      textTransform: 'capitalize',
    },
    memberCount: {
      fontSize: 12,
      color: colors.textSecondary,
    },
    inactiveTag: {
      backgroundColor: '#FFE5E5',
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 12,
    },
    inactiveText: {
      fontSize: 12,
      color: '#FF6B6B',
      fontWeight: '500',
    },
    defaultTag: {
      backgroundColor: '#E3F2FD',
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 12,
    },
    defaultText: {
      fontSize: 12,
      color: '#007AFF',
      fontWeight: '500',
    },
    workspaceActions: {
      flexDirection: 'row',
      gap: 8,
    },
    actionButton: {
      width: 32,
      height: 32,
      borderRadius: 16,
      alignItems: 'center',
      justifyContent: 'center',
    },
    emptyState: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 32,
    },
    emptyStateTitle: {
      fontSize: 20,
      fontWeight: '600',
      color: colors.text,
      marginTop: 16,
      marginBottom: 8,
    },
    emptyStateText: {
      fontSize: 14,
      color: colors.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
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
  }), [colors]);

  const renderWorkspaceItem = ({ item: workspace }: { item: Workspace }) => (
    <TouchableOpacity
      style={dynamicStyles.workspaceCard}
      onPress={() => handleLinkPress(workspace)}
    >
      <View style={dynamicStyles.workspaceHeader}>
        <View style={dynamicStyles.workspaceInfo}>
          <Text style={dynamicStyles.workspaceName} numberOfLines={1} ellipsizeMode="tail">{workspace.name}</Text>
          {workspace.description && (
            <Text style={dynamicStyles.workspaceDescription}>{workspace.description}</Text>
          )}
          <View style={dynamicStyles.workspaceMeta}>
            <View style={dynamicStyles.roleContainer}>
              <Ionicons 
                name={workspace.user_role === 'owner' ? 'star' : 
                      workspace.user_role === 'admin' ? 'shield' : 
                      workspace.user_role === 'member' ? 'person' : 'eye'} 
                size={14} 
                color={colors.textSecondary} 
              />
              <Text style={dynamicStyles.roleText}>{workspace.user_role}</Text>
            </View>
            <Text style={dynamicStyles.memberCount}>
              {workspace.member_count} member{workspace.member_count !== 1 ? 's' : ''}
            </Text>
            {workspace.is_personal && (
              <View style={dynamicStyles.defaultTag}>
                <Text style={dynamicStyles.defaultText}>Default</Text>
              </View>
            )}
            {!workspace.is_active && (
              <View style={dynamicStyles.inactiveTag}>
                <Text style={dynamicStyles.inactiveText}>Inactive</Text>
              </View>
            )}
          </View>
        </View>
        
        {workspace.can_manage && (
          <View style={dynamicStyles.workspaceActions}>
            <FeedbackTouchable
              style={[dynamicStyles.actionButton, { backgroundColor: workspace.is_active ? '#FF6B6B' : '#4ECDC4' }]}
              onPress={() => handleToggleActive(workspace)}
              loading={busyWorkspaceId === workspace.id}
              spinnerColor="#fff"
            >
              <Ionicons 
                name={workspace.is_active ? 'pause' : 'play'} 
                size={16} 
                color="#fff" 
              />
            </FeedbackTouchable>
            
            {/* Don't show delete button for default/personal workspace */}
            {!workspace.is_personal && (
              <FeedbackTouchable
                style={[dynamicStyles.actionButton, { backgroundColor: '#FF6B6B' }]}
                onPress={() => handleDeleteWorkspace(workspace)}
                loading={busyWorkspaceId === workspace.id}
                disabled={busyWorkspaceId != null}
                spinnerColor="#fff"
                accessibilityLabel={`Delete workspace ${workspace.name}`}
              >
                <Ionicons name="trash" size={16} color="#fff" />
              </FeedbackTouchable>
            )}
          </View>
        )}
      </View>
    </TouchableOpacity>
  );

  const renderEmptyState = () => (
    <View style={dynamicStyles.emptyState}>
      <Ionicons name="business" size={64} color={colors.textLight} />
      <Text style={dynamicStyles.emptyStateTitle}>No Workspaces</Text>
      <Text style={dynamicStyles.emptyStateText}>
        You don&apos;t belong to any workspaces yet. Create one to get started!
      </Text>
      <TouchableOpacity
        style={dynamicStyles.createButton}
        onPress={() => router.push('/workspaces/create')}
      >
        <Text style={dynamicStyles.createButtonText}>Create Workspace</Text>
      </TouchableOpacity>
    </View>
  );

  if (loading) {
    return (
      <SafeAreaView style={dynamicStyles.container}>
        <View style={dynamicStyles.header}>
          <AppBackButton onPress={handleBack} />
          <AppHeaderTitle pointerEvents="none">Workspaces</AppHeaderTitle>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <TouchableOpacity
              style={dynamicStyles.headerIconButton}
              onPress={handleRefresh}
              disabled={refreshing}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              accessibilityRole="button"
              accessibilityLabel="Refresh"
            >
              <Ionicons name="refresh" size={28} color={refreshing ? '#999' : '#007AFF'} />
            </TouchableOpacity>
            <TouchableOpacity
              style={dynamicStyles.headerIconButton}
              onPress={() => router.push('/workspaces/create')}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              accessibilityRole="button"
              accessibilityLabel="Create workspace"
            >
              <Ionicons name="add" size={28} color="#007AFF" />
            </TouchableOpacity>
          </View>
        </View>
        <View style={dynamicStyles.loadingContainer}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={{ color: colors.textSecondary, marginTop: 12 }}>Loading workspaces...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={dynamicStyles.container}>
      <View style={dynamicStyles.header}>
        <AppBackButton onPress={handleBack} />
        <AppHeaderTitle pointerEvents="none">Workspaces</AppHeaderTitle>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <TouchableOpacity
            style={dynamicStyles.headerIconButton}
            onPress={handleRefresh}
            disabled={refreshing}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel="Refresh"
          >
            <Ionicons name="refresh" size={28} color={refreshing ? '#999' : '#007AFF'} />
          </TouchableOpacity>
          <TouchableOpacity
            style={dynamicStyles.headerIconButton}
            onPress={() => router.push('/workspaces/create')}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel="Create workspace"
          >
            <Ionicons name="add" size={28} color="#007AFF" />
          </TouchableOpacity>
        </View>
      </View>

      <FlatList
        data={workspaces}
        renderItem={renderWorkspaceItem}
        keyExtractor={(item) => item.id.toString()}
        contentContainerStyle={workspaces.length === 0 ? dynamicStyles.emptyContainer : dynamicStyles.listContainer}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
        onEndReached={loadMoreWorkspaces}
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
        ListEmptyComponent={renderEmptyState}
        showsVerticalScrollIndicator={false}
      />
    </SafeAreaView>
  );
}

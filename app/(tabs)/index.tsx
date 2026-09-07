import { Ionicons } from '@expo/vector-icons';
import { SpaceGrotesk_500Medium, useFonts } from '@expo-google-fonts/space-grotesk';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Alert,
    Animated,
    Image,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    useWindowDimensions,
    View
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import MinimizableBottomSheet from '../../components/MinimizableBottomSheet';
import { SignatureIcon } from '../../components/SignatureIcon';
import { useMinimizableSheet } from '../../hooks/useMinimizableSheet';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiClient } from '../../services/api';
import {
  getAttentionQueue,
  getClientsCount,
  type AttentionQueueItem,
} from '../../services/clientsApi';
import { useProgressStore } from '../../services/progressService';
import { dashboardScreenKey } from '../../services/userScopedCache';
import { useFileStore } from '../../stores/fileStore';
import { expoHrefForWebDefaultHome } from '../../utils/defaultHomePath';
import { getRecentApps, trackRecentApp } from '../../utils/recentApps';
import { screenCache } from '../../utils/screenCache';
import { navigatePrimaryShell } from '../../utils/tabNavigation';
import { NotificationsInboxContent } from '../components/NotificationsInboxContent';
import { ProfileMenuPopover } from '../components/ProfileMenuPopover';
import { UploadOptionsModal } from '../components/UploadOptionsModal';
import { useAuth } from '../context/auth';
import { pushNotificationService } from '../services/pushNotifications';

// Debug functions removed for production build

interface DashboardStats {
  totalDocuments: number;
  totalForms: number;
  formResponses: number;
  chatSessions: number;
  processingFiles: number;
  unreadNotifications?: number;
  recentAnalytics?: number;
}

function ReachLiveMeetingDot() {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.35, duration: 900, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 900, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);
  return (
    <Animated.View
      style={[reachLiveDotStyles.dot, { opacity }]}
      accessibilityLabel="In a meeting"
    />
  );
}

const reachLiveDotStyles = StyleSheet.create({
  dot: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#34C759',
    borderWidth: 2,
    borderColor: '#fff',
  },
});

function DashboardScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { user, signOut } = useAuth();
  const { uploadFromGallery, uploadFromDocuments } = useFileStore();
  const colors = useThemeColors();
  const [fontsLoaded] = useFonts({ SpaceGrotesk_500Medium });
  const isAuthenticated = !!user;
  const [stats, setStats] = useState({
    totalDocuments: 0,
    totalDrafts: 0,
    totalForms: 0,
    formResponses: 0,
    chatSessions: 0,
    processingFiles: 0,
    unreadNotifications: 0,
    recentAnalytics: 0,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState<{ success: boolean; message: string } | null>(null);
  const uploadSheet = useMinimizableSheet();
  const notificationsSheet = useMinimizableSheet();
  const [isUploading, setIsUploading] = useState(false);
  const [uploadTimeout, setUploadTimeout] = useState<number | null>(null);
  const [isOpeningPicker, setIsOpeningPicker] = useState(false);
  const [reachInMeeting, setReachInMeeting] = useState(false);
  const [clientsCount, setClientsCount] = useState(0);
  const [attentionItems, setAttentionItems] = useState<AttentionQueueItem[]>([]);
  const [recentAppKeys, setRecentAppKeys] = useState<string[]>([]);

  const AUTO_REFRESH_INTERVAL = 120000; // Auto-refresh every 2 minutes for dashboard
  const DASHBOARD_CACHE_MS = 60000; // 60 s TTL for dashboard data

  const getDashboardCacheKey = useCallback(
    () => (user?.id ? dashboardScreenKey(user.id) : null),
    [user?.id],
  );

  // When not signed in, stay on login screen (redirect to sign-in)
  useFocusEffect(
    useCallback(() => {
      if (!user) {
        router.replace('/(auth)/sign-in');
      }
    }, [user, router])
  );

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try {
          const id = await AsyncStorage.getItem(REACH_CURRENT_MEETING_KEY);
          if (!cancelled) {
            setReachInMeeting(typeof id === 'string' && id.trim().length > 0);
          }
        } catch {
          if (!cancelled) setReachInMeeting(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [])
  );

  // Helper function to safely set upload state with timeout
  const setUploadStateWithTimeout = (uploading: boolean) => {
    setIsUploading(uploading);
    
    if (uploading) {
      // Clear any existing timeout
      if (uploadTimeout) {
        clearTimeout(uploadTimeout);
      }
      
      // Set a timeout to automatically reset upload state after 30 seconds
      const timeout = setTimeout(() => {
        setIsUploading(false);
        setUploadTimeout(null);
      }, 30000);
      
      setUploadTimeout(timeout);
    } else {
      // Clear timeout when upload is complete
      if (uploadTimeout) {
        clearTimeout(uploadTimeout);
        setUploadTimeout(null);
      }
    }
  };

  const loadHomeExtras = useCallback(async () => {
    try {
      setRecentAppKeys(await getRecentApps());
    } catch {
      /* keep prior */
    }
    try {
      const count = await getClientsCount();
      setClientsCount(count);
      if (count > 0) {
        const att = await getAttentionQueue('all', { limit: 8, offset: 0 });
        setAttentionItems(att.items || []);
      } else {
        setAttentionItems([]);
      }
    } catch {
      /* keep prior attention rather than flashing an empty block */
    }
  }, []);

  const loadDashboardData = useCallback(async (forceRefresh = false) => {
    // console.log('🏠 Starting dashboard data load...');
    
    // Check if user is authenticated before making API calls
    if (!isAuthenticated || !user) {
      setLoading(false);
      return;
    }

    // Serve cached stats immediately (skip spinner on tab re-focus).
    // Attention + recently used still load — they are not in the stats cache.
    if (!forceRefresh) {
      const cacheKey = getDashboardCacheKey();
      const cached = cacheKey
        ? screenCache.get<{ stats: typeof stats }>(cacheKey, DASHBOARD_CACHE_MS)
        : null;
      if (cached) {
        setStats(cached.stats);
        setLoading(false);
        void loadHomeExtras();
        return;
      }
    }
    
    try {
      setLoading(true);
      
      // Set default fallback data immediately to prevent crashes
      const defaultStats = {
        totalDocuments: 0,
        totalDrafts: 0,
        totalForms: 0,
        formResponses: 0,
        chatSessions: 0,
        processingFiles: 0,
        unreadNotifications: 0,
        recentAnalytics: 0,
      };

      // First test backend connectivity
      // console.log('🔍 Testing backend connectivity before loading dashboard...');
      let connectivityTest;
      try {
        connectivityTest = await apiClient.checkAuth();
        // console.log('🔍 Dashboard connectivity test result:', connectivityTest);
        setConnectionStatus({
          success: connectivityTest.success,
          message: connectivityTest.message || 'Auth check completed'
        });
      } catch (error) {
        // console.error('❌ Connectivity test failed:', error);
        connectivityTest = { success: false, message: 'Connection test failed' };
        setConnectionStatus(connectivityTest);
      }
      
      if (!connectivityTest.success) {
        // Set fallback data for development
        setStats({
          totalDocuments: 5,
          totalDrafts: 0,
          totalForms: 2,
          formResponses: 3,
          chatSessions: 2,
          processingFiles: 1,
          unreadNotifications: 0,
          recentAnalytics: 8,
        });
        void loadHomeExtras();
        return; // Exit early with fallback data
      }
      
      // console.log('✅ Backend connectivity OK, loading dashboard data...');
      
      // Load dashboard stats in parallel with notifications
      const statsPromise = (async () => {
        try {
          // console.log('📊 Attempting to load dashboard stats...');
          const dashboardResponse = await (apiClient as any).getDashboardStats();
          // console.log('📊 Dashboard stats response:', dashboardResponse);
          
          if (dashboardResponse && dashboardResponse.success && dashboardResponse.data) {
            // Handle both direct stats and nested stats structure
            const statsData = dashboardResponse.data.stats || dashboardResponse.data;
            
            const safeStats = {
              totalDocuments: Number(statsData.totalDocuments) || 0,
              totalDrafts: Number(statsData.totalDrafts) || 0,
              totalForms: Number(statsData.totalForms) || 0,
              formResponses: Number(statsData.formResponses) || 0,
              chatSessions: Number(statsData.chatSessions) || 0,
              processingFiles: Number(statsData.processingFiles) || 0,
              unreadNotifications: Number(statsData.unreadNotifications) || 0,
              recentAnalytics: Number(statsData.recentAnalytics) || 0,
            };
            
            // console.log('📊 Setting safe dashboard stats:', safeStats);
            setStats(safeStats);
            return safeStats;
          } else {
            console.warn('📊 Dashboard stats API call succeeded but no valid data returned');
            setStats(defaultStats);
            return defaultStats;
          }
        } catch (error) {
          console.warn('📊 Dashboard stats failed, using defaults:', error);
          // Fallback: use files endpoint with minimal request (page 1, 1 item) and use pagination.total for count
          try {
            const filesResponse = await apiClient.getFiles(1, 1);
            if (filesResponse && filesResponse.success) {
              const pagination = (filesResponse as any).pagination;
              const fileCount = typeof pagination?.total === 'number' ? pagination.total : 0;
              const fallbackStats = {
                ...defaultStats,
                totalDocuments: fileCount,
              };
              setStats(fallbackStats);
              return fallbackStats;
            }
            setStats(defaultStats);
            return defaultStats;
          } catch (filesError) {
            console.warn('📊 Files fallback also failed:', filesError);
            setStats(defaultStats);
            return defaultStats;
          }
        }
      })();
    
    const notifPromise = (async () => {
      try {
        const notifRes = await apiClient.getNotifications();
        if (notifRes?.success && notifRes?.data?.notifications) {
          const list = notifRes.data.notifications as { read?: boolean; type?: string }[];
          const nonChatUnread = list.filter((n) => !n.read && n.type !== 'chat_message').length;
          setStats((prev) => ({ ...prev, unreadNotifications: nonChatUnread }));
        }
      } catch {
        // keep existing badge count
      }
    })();

    const [resolvedStats] = await Promise.all([statsPromise, notifPromise]);

    if (resolvedStats) {
      const cacheKey = getDashboardCacheKey();
      if (cacheKey) screenCache.set(cacheKey, { stats: resolvedStats });
    }

    await loadHomeExtras();
      
    } catch (error) {
      // console.error('🏠 Unexpected error in dashboard data loading:', error);
      // Ensure we always have safe defaults
      setStats({
        totalDocuments: 0,
        totalDrafts: 0,
        totalForms: 0,
        formResponses: 0,
        chatSessions: 0,
        processingFiles: 0,
        unreadNotifications: 0,
        recentAnalytics: 0,
      });
    } finally {
      setLoading(false);
      // console.log('🏠 Dashboard data loading completed');
    }
  }, [user, isAuthenticated, getDashboardCacheKey, loadHomeExtras]);

  const onNotificationsListMutated = useCallback(() => {
    const cacheKey = getDashboardCacheKey();
    if (cacheKey) screenCache.invalidate(cacheKey);
    void loadDashboardData(true);
  }, [loadDashboardData]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    const cacheKey = getDashboardCacheKey();
    if (cacheKey) screenCache.invalidate(cacheKey);
    await loadDashboardData(true);
    setRefreshing(false);
  }, [getDashboardCacheKey, loadDashboardData]);

  // useFocusEffect fires on first mount AND on every subsequent focus — a separate mount
  // useEffect would fire simultaneously on cold open, doubling all API requests (6-8 extra calls).
  useFocusEffect(
    useCallback(() => {
      loadDashboardData();
    }, [loadDashboardData])
  );

  // Keep app icon badge in sync with unread notification count
  useEffect(() => {
    if (user && typeof stats.unreadNotifications === 'number') {
      pushNotificationService.setBadgeCount(stats.unreadNotifications);
    }
  }, [user, stats.unreadNotifications]);

  // Auto-refresh dashboard periodically when user is authenticated
  useEffect(() => {
    if (!isAuthenticated || !user) return;

    const interval = setInterval(() => {
      const cacheKey = getDashboardCacheKey();
      if (cacheKey) screenCache.invalidate(cacheKey);
      loadDashboardData(true);
    }, AUTO_REFRESH_INTERVAL);

    return () => clearInterval(interval);
  }, [isAuthenticated, user, loadDashboardData, getDashboardCacheKey]);

  // When connection failed, retry with exponential backoff so we don't hammer the server
  useEffect(() => {
    if (!connectionStatus || connectionStatus.success) return;
    let delay = 2000;
    const MAX_DELAY = 30000;
    let timeoutId: ReturnType<typeof setTimeout>;
    let cancelled = false;

    const attempt = async () => {
      if (cancelled) return;
      try {
        const result = await apiClient.checkAuth();
        if (result?.success) {
          setConnectionStatus({ success: true, message: '' });
          loadDashboardData();
          return;
        }
      } catch {
        // still offline
      }
      delay = Math.min(delay * 2, MAX_DELAY);
      if (!cancelled) timeoutId = setTimeout(attempt, delay);
    };

    timeoutId = setTimeout(attempt, delay);
    return () => { cancelled = true; clearTimeout(timeoutId); };
  }, [connectionStatus?.success, connectionStatus?.message, loadDashboardData]);

  // Cleanup upload timeout on unmount
  useEffect(() => {
    return () => {
      if (uploadTimeout) {
        clearTimeout(uploadTimeout);
      }
    };
  }, [uploadTimeout]);

  const StatCard = ({
    title,
    icon,
    color,
    onPress,
    badge,
    subtitle,
  }: {
    title: string;
    icon: string;
    color: string;
    onPress?: () => void;
    badge?: number;
    subtitle?: string;
  }) => (
    <TouchableOpacity
      style={[dynamicStyles.statCard, { borderLeftColor: color }]}
      onPress={onPress}
      accessibilityLabel={subtitle ? `${title}. ${subtitle}` : title}
      accessibilityRole="button"
    >
      <View style={dynamicStyles.statCardRow}>
        <View style={{ position: 'relative' }}>
          <Ionicons name={icon as any} size={26} color={color} />
          {badge != null && badge > 0 ? (
            <View style={dynamicStyles.badge}>
              <Text style={dynamicStyles.badgeText}>{badge > 99 ? '99+' : String(badge)}</Text>
            </View>
          ) : null}
        </View>
        <View style={dynamicStyles.statTextBlock}>
          <Text style={dynamicStyles.statTitle}>{title}</Text>
          {subtitle ? <Text style={dynamicStyles.statSubtitle}>{subtitle}</Text> : null}
        </View>
      </View>
    </TouchableOpacity>
  );

  const QuickActionCard = ({ title, subtitle, icon, iconElement, color, onPress, isNew, showLiveMeetingIndicator }: {
    title: string;
    subtitle: string;
    icon?: string;
    iconElement?: React.ReactNode;
    color: string;
    onPress: () => void;
    isNew?: boolean;
    showLiveMeetingIndicator?: boolean;
  }) => (
    <TouchableOpacity
      style={dynamicStyles.quickActionCard}
      onPress={onPress}
      accessibilityLabel={
        showLiveMeetingIndicator ? `${title}: ${subtitle}. In a meeting.` : `${title}: ${subtitle}`
      }
      accessibilityRole="button"
    >
      <View style={[dynamicStyles.quickActionIcon, { backgroundColor: color }]}>
        {iconElement ?? <Ionicons name={icon as any} size={22} color="#fff" />}
        {showLiveMeetingIndicator ? <ReachLiveMeetingDot /> : null}
        {isNew ? <View style={dynamicStyles.newBadge}><Text style={dynamicStyles.newBadgeText}>NEW</Text></View> : null}
      </View>
      <View style={dynamicStyles.quickActionContent}>
        <Text style={dynamicStyles.quickActionTitle}>{title}</Text>
        <Text style={dynamicStyles.quickActionSubtitle}>{subtitle}</Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color="#ccc" />
    </TouchableOpacity>
  );

  const handleUploadFromFiles = async () => {
    if (isUploading) {
      // console.log('📁 Upload already in progress, ignoring request');
      return;
    }
    
    // console.log('📁 Files upload button clicked');
    setUploadStateWithTimeout(true);
    setIsOpeningPicker(true);
    uploadSheet.close();
    
    // Wait for modal to fully close before opening picker
    await new Promise(resolve => setTimeout(resolve, 500));
    
    try {
      // Use the reactive hook method which handles state properly
      const success = await uploadFromDocuments();
      
      if (success === true) {
        Alert.alert('Success', 'Files uploaded successfully!');
        loadDashboardData();
      }
      // false/null = failure, cancel, or limit alert already shown
    } catch (error) {
      // console.error('📁 Document upload error:', error);
      Alert.alert('Error', 'Failed to upload files. Please try again.');
    } finally {
      // Always reset the uploading state
      // console.log('📁 Resetting upload state');
      setUploadStateWithTimeout(false);
      setIsOpeningPicker(false);
    }
  };

  const handleUploadFromCamera = () => {
    uploadSheet.close();
    router.push('/scanner');
  };

  const handleUploadByLink = () => {
    uploadSheet.close();
    router.push('/upload-by-link-code');
  };

  const handleUploadFromGallery = async () => {
    if (isUploading) {
      // console.log('🖼️ Upload already in progress, ignoring request');
      return;
    }
    
    // console.log('🖼️ Gallery upload button clicked');
    setUploadStateWithTimeout(true);
    setIsOpeningPicker(true);
    uploadSheet.close();
    
    // Wait for modal to fully close before opening picker
    await new Promise(resolve => setTimeout(resolve, 500));
    
    try {
      // console.log('🖼️ Starting gallery upload...');
      const success = await uploadFromGallery();
      // console.log('🖼️ Gallery upload result:', success);
      
      if (success === true) {
        Alert.alert('Success', 'Photos uploaded successfully!');
        loadDashboardData();
      } else if (success === false) {
        Alert.alert('Upload Failed', 'Failed to upload photos. Please try again.');
      }
      // null = cancelled or upload-limit alert already shown
    } catch (error: any) {
      // console.error('🖼️ Gallery upload error:', error);
      Alert.alert('Error', error.message || 'Failed to upload photos. Please try again.');
    } finally {
      // Always reset the uploading state
      // console.log('🖼️ Resetting upload state');
      setUploadStateWithTimeout(false);
      setIsOpeningPicker(false);
    }
  };

  const handleQuickAction = (action: string) => {
    void trackRecentApp(action).then(() => getRecentApps().then(setRecentAppKeys));
    switch (action) {
      case 'scan':
        navigatePrimaryShell(router, '/(tabs)/documents');
        break;
      case 'upload':
        // Show upload options modal
        uploadSheet.open();
        break;
      case 'chat':
        // Navigate to user chat screen (user-to-user and workspace chats ONLY)
        router.push('/user-chat');
        break;
      case 'chatgd':
        router.push(expoHrefForWebDefaultHome('/upload'));
        break;
      case 'clients':
        router.push('/clients' as any);
        break;
      case 'form':
        router.push('/forms/create');
        break;
      case 'workspaces':
        router.push('/workspaces');
        break;
      case 'notifications':
      case 'analytics':
        router.push('/analytics/dashboard');
        break;
      case 'upload-links':
        router.push('/upload-links');
        break;
      case 'intake':
        router.push('/intake');
        break;
      case 'email-sync':
        router.push('/email-sync');
        break;
      case 'notes':
        router.push('/drafts');
        break;
      case 'signatures':
        router.push('/signatures' as any);
        break;
      case 'meeting-call':
        router.push('/quick-reach/meeting-call');
        break;
      case 'calendar':
        navigatePrimaryShell(router, '/calendar');
        break;
      case 'bookmarks':
        router.push('/bookmarks/manage');
        break;
      case 'fillable-file':
        navigatePrimaryShell(router, '/(tabs)/documents');
        break;
      default:
        break;
    }
  };

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  }, []);

  const firstName =
    (user as any)?.firstName ||
    (user as any)?.first_name ||
    (typeof (user as any)?.name === 'string' ? String((user as any).name).split(' ')[0] : '') ||
    'there';

  type HomeAppDef = {
    key: string;
    title: string;
    subtitle?: string;
    icon: string;
    iconElement?: React.ReactNode;
    color: string;
    action: string;
    showLive?: boolean;
  };

  const ALL_APPS: HomeAppDef[] = useMemo(
    () => [
      { key: 'upload', title: 'Upload', subtitle: 'Add documents', icon: 'cloud-upload', color: '#34C759', action: 'upload' },
      { key: 'clients', title: 'My Clients', subtitle: 'Attention & work', icon: 'people', color: '#0D9488', action: 'clients' },
      { key: 'chatgd', title: 'ChatGD', subtitle: 'Ask GrabDocs', icon: 'chatbubbles', color: '#AF52DE', action: 'chatgd' },
      { key: 'intake', title: 'Intake', subtitle: 'Document checklists', icon: 'checkbox-outline', color: '#14B8A6', action: 'intake' },
      { key: 'calendar', title: 'Calendar', icon: 'calendar-outline', color: '#5856D6', action: 'calendar' },
      { key: 'meeting-call', title: 'Reach', icon: 'call', color: '#007AFF', action: 'meeting-call', showLive: reachInMeeting },
      {
        key: 'signatures',
        title: 'Signatures',
        icon: 'create',
        iconElement: <SignatureIcon size={22} color="#fff" />,
        color: '#0EA5E9',
        action: 'signatures',
      },
      { key: 'upload-links', title: 'File Request', icon: 'link', color: '#8E44AD', action: 'upload-links' },
      { key: 'form', title: 'Forms', icon: 'clipboard-outline', color: '#34C759', action: 'form' },
      { key: 'workspaces', title: 'Workspaces', icon: 'people', color: '#5856D6', action: 'workspaces' },
      { key: 'notes', title: 'Notes', icon: 'create-outline', color: '#5AC8FA', action: 'notes' },
      { key: 'bookmarks', title: 'Bookmarks', icon: 'bookmark', color: '#FF9500', action: 'bookmarks' },
      { key: 'chat', title: 'Secure Messaging', icon: 'chatbubbles', color: '#FF2D55', action: 'chat' },
      { key: 'email-sync', title: 'Email Replies', subtitle: 'Draft reply with AI', icon: 'mail-outline', color: '#007AFF', action: 'email-sync' },
      { key: 'analytics', title: 'Financials', icon: 'analytics', color: '#FF9500', action: 'analytics' },
    ],
    [reachInMeeting]
  );

  const appByKey = useMemo(() => {
    const m = new Map<string, HomeAppDef>();
    ALL_APPS.forEach((a) => m.set(a.key, a));
    return m;
  }, [ALL_APPS]);

  const recentApps = useMemo(() => {
    const keys = recentAppKeys.length ? recentAppKeys : ['upload', 'clients', 'chatgd', 'intake'];
    return keys.map((k) => appByKey.get(k)).filter(Boolean) as HomeAppDef[];
  }, [recentAppKeys, appByKey]);

  const moreApps = useMemo(() => {
    // Quick-action tiles — omit from Apps to avoid duplicating the grid above.
    // Recent is shortcuts only; do not remove those apps from this list.
    const coreKeys = new Set(['upload', 'chatgd', 'analytics', 'email-sync']);
    return ALL_APPS.filter((a) => !coreKeys.has(a.key));
  }, [ALL_APPS]);

  const hasPendingAttention = attentionItems.some(
    (i) =>
      (i.attention?.open_counts?.waiting_on_client || 0) +
        (i.attention?.open_counts?.waiting_on_us || 0) >
        0 ||
      i.attention?.status === 'needs_attention' ||
      i.attention?.status === 'waiting'
  );

  const handleNotificationBellPress = useCallback(() => {
    // Defer opening so the same pointer event cannot hit the modal backdrop (web + some native).
    setTimeout(() => notificationsSheet.open(), 0);
  }, []);

  const handleTestProgress = () => {
    const progressStore = useProgressStore.getState();
    const taskId = `test_${Date.now()}`;
    const fileName = 'test-file.pdf';
    
    // Start progress
    const progressId = progressStore.addProgress({
      title: fileName,
      progress: 0,
      status: 'pending'
    });
    
    // Simulate progress updates
    let progress = 0;
    const progressInterval = setInterval(() => {
      progress += 20;
      
      progressStore.updateProgress(progressId, {
        progress: progress,
        status: 'in-progress',
        message: `Processing test file... ${progress}%`
      });
      
      // console.log(`📊 Test progress update: ${progress}%`);
      
      if (progress >= 100) {
        clearInterval(progressInterval);
        setTimeout(() => {
          progressStore.updateProgress(progressId, {
            status: 'completed',
            progress: 100,
            message: 'Test file processing completed!'
          });
          // console.log('✅ Test progress completed');
        }, 1000);
      }
    }, 1000); // Update every second
  };

  const dynamicStyles = useMemo(() => StyleSheet.create({
  container: {
    flex: 1,
      backgroundColor: colors.background,
  },
  scrollView: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 7,
    backgroundColor: colors.headerBackground,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  logoWithName: {
    height: 36,
      width: 135,
  },
  welcomeText: {
    fontSize: 15,
      color: colors.textSecondary,
  },
  userNameText: {
    fontSize: 22,
    fontWeight: '700',
      color: colors.text,
    marginTop: 2,
  },
  statsContainer: {
    padding: 14,
  },
  statsRow: {
    flexDirection: 'row',
    marginBottom: 8,
    gap: 8,
  },
  statCard: {
    flex: 1,
      backgroundColor: colors.card,
    borderRadius: 9,
    padding: 14,
    borderLeftWidth: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 2,
  },
  statCardRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  statTextBlock: {
    flex: 1,
    marginLeft: 10,
    minWidth: 0,
  },
  statTitle: {
    fontSize: 13,
    fontWeight: '600',
      color: colors.text,
    textTransform: 'uppercase',
  },
  statSubtitle: {
    fontSize: 11,
      color: colors.textSecondary,
    marginTop: 3,
    lineHeight: 15,
  },
  section: {
    padding: 14,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
      color: colors.text,
  },
  quickActionsContainer: {
    gap: 6,
  },
  quickActionCard: {
    flexDirection: 'row',
    alignItems: 'center',
      backgroundColor: colors.card,
    padding: 10,
    borderRadius: 9,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 2,
  },
  quickActionIcon: {
    position: 'relative',
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
  },
  quickActionContent: {
    flex: 1,
  },
  quickActionTitle: {
    fontSize: 14,
    fontWeight: '600',
      color: colors.text,
    marginBottom: 2,
  },
  quickActionSubtitle: {
    fontSize: 12,
      color: colors.textSecondary,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerButton: {
    padding: 8,
    marginTop: 4,
  },
  refreshingButton: {
    opacity: 0.5,
  },
  headerBadge: {
    position: 'absolute',
    top: -5,
    right: -5,
    backgroundColor: '#FF3B30',
    borderRadius: 12,
    padding: 2,
  },
  headerBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#fff',
    textAlign: 'center',
  },
  fab: {
    position: 'absolute',
    bottom: 20,
    right: 20,
    backgroundColor: '#007AFF',
    borderRadius: 26,
    width: 52,
    height: 52,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 6,
  },
  badge: {
    position: 'absolute',
    top: -5,
    right: -5,
    backgroundColor: '#FF3B30',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  badgeText: {
    color: 'white',
    fontSize: 10,
    fontWeight: 'bold',
  },
  newBadge: {
    position: 'absolute',
    top: -8,
    right: -8,
    backgroundColor: '#FF3B30',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  newBadgeText: {
    color: 'white',
    fontSize: 8,
    fontWeight: 'bold',
  },
  connectionBanner: {
    backgroundColor: '#fef3c7',
    borderColor: '#f59e0b',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    margin: 16,
    flexDirection: 'row',
    alignItems: 'center',
  },
        connectionBannerText: {
    color: '#92400e',
    fontSize: 14,
    fontWeight: '500',
    marginLeft: 8,
    flex: 1,
  },
  }), [colors]);

  return (
    <SafeAreaView style={dynamicStyles.container}>
      {/* Connection Status Banner */}
      {connectionStatus && !connectionStatus.success && (
        <View style={dynamicStyles.connectionBanner}>
          <Ionicons name="warning" size={20} color="#f59e0b" />
          <Text style={dynamicStyles.connectionBannerText}>
            {connectionStatus.message.includes('CORS') 
              ? 'CORS Error: Please configure backend for web development'
              : 'Connection Error: Connecting you back ...'
            }
          </Text>
        </View>
      )}

      <ScrollView
        style={dynamicStyles.scrollView}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={dynamicStyles.header}>
          <View style={dynamicStyles.headerLeft}>
            <Image 
              source={require('../../assets/images/grabdocs-brand-app-images/png/name-transparent.png')} 
              style={dynamicStyles.logoWithName}
              resizeMode="contain"
            />
          </View>
          <View style={dynamicStyles.headerActions}>
            {!user ? (
              <TouchableOpacity
                style={dynamicStyles.headerButton}
                onPress={() => router.push('/(auth)')}
              >
                  <Ionicons name="log-in-outline" size={26} color="#007AFF" />
              </TouchableOpacity>
            ) : (
              <>
                <TouchableOpacity
                  style={dynamicStyles.headerButton}
                  onPress={handleNotificationBellPress}
                  hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
                  accessibilityLabel="Notifications"
                  accessibilityRole="button"
                >
                  <View style={{ position: 'relative' }}>
                    <Ionicons name="notifications-outline" size={30} color="#007AFF" />
                    {stats.unreadNotifications > 0 ? (
                      <View style={dynamicStyles.headerBadge}>
                        <Text style={dynamicStyles.headerBadgeText}>{String(stats.unreadNotifications)}</Text>
                      </View>
                    ) : null}
                  </View>
                </TouchableOpacity>
                <TouchableOpacity
                  style={dynamicStyles.headerButton}
                  onPress={() => navigatePrimaryShell(router, '/(tabs)/help')}
                >
                  <Ionicons name="help-circle-outline" size={30} color="#007AFF" />
                </TouchableOpacity>
                <ProfileMenuPopover user={user} buttonStyle={dynamicStyles.headerButton} />
              </>
            )}
          </View>
        </View>


        {/* Greeting (search/ask entry hidden for now) */}
        <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 12 }}>
          <Text
            style={{
              fontFamily: fontsLoaded ? 'SpaceGrotesk_500Medium' : undefined,
              fontSize: 21,
              fontWeight: fontsLoaded ? undefined : '500',
              lineHeight: 28,
              color: colors.text,
            }}
          >
            {greeting}, {firstName}
          </Text>
        </View>

        {/* Client attention — only if user has clients */}
        {clientsCount > 0 ? (
          <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
            {hasPendingAttention ? (
              <>
                <Text style={[dynamicStyles.sectionTitle, { marginBottom: 8 }]}>Needs attention</Text>
                {attentionItems.slice(0, 5).map((item) => (
                  <TouchableOpacity
                    key={item.client.id}
                    onPress={() => router.push(`/clients/${item.client.id}` as any)}
                    style={{
                      backgroundColor: colors.card,
                      borderRadius: 12,
                      borderWidth: StyleSheet.hairlineWidth,
                      borderColor: colors.border,
                      padding: 12,
                      marginBottom: 8,
                    }}
                  >
                    <Text style={{ color: colors.text, fontWeight: '600' }}>{item.client.display_name}</Text>
                    <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }} numberOfLines={2}>
                      {item.attention?.next_step?.label ||
                        (item.attention?.status === 'needs_attention'
                          ? 'Needs attention'
                          : 'Waiting')}
                    </Text>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity onPress={() => router.push('/clients' as any)}>
                  <Text style={{ color: '#0D9488', fontWeight: '600', marginTop: 4 }}>View all clients</Text>
                </TouchableOpacity>
              </>
            ) : (
              <View
                style={{
                  backgroundColor: 'rgba(13,148,136,0.1)',
                  borderRadius: 12,
                  padding: 14,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <Ionicons name="checkmark-circle" size={22} color="#0D9488" />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text, fontWeight: '600' }}>No open waits</Text>
                  <Text style={{ color: colors.textSecondary, fontSize: 12 }}>Everything looks on track</Text>
                </View>
              </View>
            )}
          </View>
        ) : null}

        {/* Quick Actions — 4 core cards */}
        <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
          <Text style={[dynamicStyles.sectionTitle, { marginBottom: 8 }]}>
            Quick actions
          </Text>
          <View style={dynamicStyles.statsRow}>
            <StatCard
              key="stat-files"
              title="Upload"
              icon="cloud-upload"
              color="#34C759"
              subtitle="Add documents"
              onPress={() => handleQuickAction('upload')}
            />
            <StatCard
              key="stat-chats"
              title="ChatGD"
              icon="chatbubbles"
              color="#AF52DE"
              subtitle="Ask a question"
              onPress={() => handleQuickAction('chatgd')}
            />
          </View>
          <View style={[dynamicStyles.statsRow, { marginBottom: 0 }]}>
            <StatCard
              key="stat-analytics"
              title="Financials"
              icon="analytics"
              color="#FF9500"
              subtitle="Manage expenses"
              onPress={() => handleQuickAction('analytics')}
            />
            <StatCard
              key="stat-email-replies"
              title="Email Replies"
              icon="mail-outline"
              color="#007AFF"
              subtitle="Draft reply with AI"
              onPress={() => handleQuickAction('email-sync')}
            />
          </View>
        </View>

        {/* Recently used — horizontal */}
        <View style={{ paddingTop: 8 }}>
          <Text style={[dynamicStyles.sectionTitle, { marginHorizontal: 16, marginBottom: 10 }]}>
            Recently used
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}
          >
            {recentApps.map((app) => (
              <TouchableOpacity
                key={app.key}
                onPress={() => handleQuickAction(app.action)}
                style={{
                  width: 108,
                  backgroundColor: colors.card,
                  borderRadius: 14,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: colors.border,
                  padding: 12,
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <View
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 12,
                    backgroundColor: app.color,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {app.iconElement ?? <Ionicons name={app.icon as any} size={22} color="#fff" />}
                  {app.showLive ? <ReachLiveMeetingDot /> : null}
                </View>
                <Text style={{ color: colors.text, fontSize: 12, fontWeight: '600', textAlign: 'center' }} numberOfLines={2}>
                  {app.title}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

        {/* Apps */}
        <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
          <Text style={[dynamicStyles.sectionTitle, { marginBottom: 10 }]}>Apps</Text>
          <View style={dynamicStyles.quickActionsContainer}>
            {moreApps.map((app) => (
              <QuickActionCard
                key={`app-${app.key}`}
                title={app.title}
                subtitle={app.subtitle || 'Open'}
                icon={app.icon}
                iconElement={app.iconElement}
                color={app.color}
                onPress={() => handleQuickAction(app.action)}
                showLiveMeetingIndicator={app.showLive}
              />
            ))}
          </View>
        </View>

        {/* Add some padding at the bottom for better scrolling */}
        <View style={{ height: 100 }} />
      </ScrollView>

      <UploadOptionsModal
        visible={uploadSheet.visible}
        expandNonce={uploadSheet.expandNonce}
        isUploading={isUploading}
        onDismiss={() => {
          uploadSheet.close();
          if (isUploading && !isOpeningPicker) {
            setUploadStateWithTimeout(false);
          }
        }}
        onFiles={handleUploadFromFiles}
        onCamera={handleUploadFromCamera}
        onGallery={handleUploadFromGallery}
        onLink={handleUploadByLink}
      />

      <MinimizableBottomSheet
        visible={notificationsSheet.visible}
        expandNonce={notificationsSheet.expandNonce}
        onClose={notificationsSheet.close}
        showHeader={false}
        // Inbox is dismiss-only — minimize left a sticky bottom peek after "close".
        minimizable={false}
        heightRatio={0.8}
      >
        <View
          style={{
            flex: 1,
            minHeight: Math.min(
              Math.max(240, Math.round(windowHeight * 0.62)),
              Math.round(windowHeight * 0.8) - 48
            ),
          }}
        >
          <NotificationsInboxContent
            variant="modal"
            onDismiss={notificationsSheet.close}
            onListMutated={onNotificationsListMutated}
          />
        </View>
      </MinimizableBottomSheet>
    </SafeAreaView>
  );
}


// Export memoized component to prevent unnecessary re-renders
export default React.memo(DashboardScreen); 
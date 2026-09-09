import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import { useAppLock } from '../../contexts/AppLockContext';
import { MAX_SCALE, MIN_SCALE, useDisplayScale } from '../../contexts/DisplayScaleContext';
import { useEnhanced2FAAuth } from '../../contexts/Enhanced2FAAuthContext';
import { useScrollRestoresHeaderProps } from '../../contexts/HeaderVisibilityContext';
import { useTheme } from '../../contexts/ThemeContext';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiService as api } from '../../services/api';
import { getMyPlan, getSettingsUsageStats } from '../../services/subscriptionApi';
import { userProfileScreenKey } from '../../services/userScopedCache';
import deviceSecurityService from '../../services/deviceSecurity';
import { useUserPreferences } from '../../contexts/UserPreferencesContext';
import type { UserPreferences } from '../../utils/userPreferences';
import {
  DEFAULT_HOME_SCREEN_OPTIONS,
  extractDefaultHomeFromAuthPayload,
  loadPersistedDefaultHomeWebPath,
  MOBILE_MAIN_HOME_WEB_ALIAS,
  normalizeWebDefaultHomePath,
  persistDefaultHomeWebPath,
  reconcilePersistenceWithServerNoDefault,
  WebDefaultHomePath,
} from '../../utils/defaultHomePath';
import { screenCache } from '../../utils/screenCache';
import { parseAsUTC } from '../../utils/timeFormatting';
import {
  dialogSurfaceBorder,
  dialogSurfaceShadow,
  floatingDialogSurfaceStyle,
  modalScrimOverlayStyle,
} from '../../utils/dialogSurfaceStyles';
import { AnimatedHeaderContainer } from '../components/AnimatedHeaderContainer';
import { TapToToggleHeaderView } from '../components/TapToToggleHeaderView';
import { useAuth } from '../context/auth';

import AppBackButton from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';

interface UserProfile {
  id: number;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  is_admin: boolean;
  created_at: string;
  google_linked?: boolean;
  apple_linked?: boolean;
  supports_password_biometric?: boolean;
}

interface DeviceFingerprint {
  deviceId: string;
  deviceName: string;
  platform: string;
  osVersion: string;
  appVersion: string;
  installationId: string;
  createdAt: string;
}

export default function SettingsScreen() {
  const router = useRouter();
  const { signOut, user: authUser } = useAuth();
  const { user, logout } = useEnhanced2FAAuth();
  const { theme, setTheme } = useTheme();
  const colors = useThemeColors();
  const { scale, setScale } = useDisplayScale();
  const {
    preferences,
    setPreferences,
    togglePreference: toggleStoredPreference,
  } = useUserPreferences();
  const {
    appLockEnabled,
    setAppLockEnabled,
    checkHasPinSet, // still used in loadSettings; returns false (PIN hidden)
    // hasPinSet, setPin - GrabDocs PIN hidden; app lock uses biometric + device passcode only
    lockAfterMinutes,
  } = useAppLock();
  const scrollRestoresHeaderProps = useScrollRestoresHeaderProps();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [deviceTrustEnabled, setDeviceTrustEnabled] = useState(true);
  const [remember2FA, setRemember2FA] = useState(true);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  /** False for SSO accounts — biometric quick-login needs username/password enrollment. */
  const [passwordBiometricSupported, setPasswordBiometricSupported] = useState(true);
  const [deviceInfo, setDeviceInfo] = useState<DeviceFingerprint | null>(null);
  const [defaultHomeWebPath, setDefaultHomeWebPath] = useState<WebDefaultHomePath>(
    normalizeWebDefaultHomePath(MOBILE_MAIN_HOME_WEB_ALIAS),
  );
  const [defaultHomePickerOpen, setDefaultHomePickerOpen] = useState(false);
  const [defaultHomeSaving, setDefaultHomeSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [clearingDeviceTrust, setClearingDeviceTrust] = useState(false);
  const [planDisplayName, setPlanDisplayName] = useState<string | null>(null);
  // const [showSetPinModal, setShowSetPinModal] = useState(false);
  // const [pinValue, setPinValue] = useState('');
  // const [pinConfirm, setPinConfirm] = useState('');
  // const [pinError, setPinError] = useState('');

  // Collapsible sections state - only About expanded by default
  const [expandedSections, setExpandedSections] = useState({
    notifications: false,
    security: false,
    fileManagement: false,
    uploadSettings: false,
    display: false,
    privacy: false,
    about: true,
    account: false,
  });

  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections(prev => {
      const isCurrentlyExpanded = prev[section];
      
      // If clicking an already expanded section, collapse it
      if (isCurrentlyExpanded) {
        return {
          ...prev,
          [section]: false
        };
      }
      
      // If clicking a collapsed section, expand it and collapse all others
      const newState: typeof expandedSections = {
        notifications: false,
        security: false,
        fileManagement: false,
        uploadSettings: false,
        display: false,
        privacy: false,
        about: false,
        account: false,
      };
      newState[section] = true;
      return newState;
    });
  };

  useEffect(() => {
    loadSettings();
  }, []);

  // Auto-expand About section when screen comes into focus
  useFocusEffect(
    useCallback(() => {
      setExpandedSections({
        notifications: false,
        security: false,
        fileManagement: false,
        uploadSettings: false,
        display: false,
        privacy: false,
        about: true, // Always expand About section on focus
        account: false,
      });
    }, [])
  );

  const scopedUserId = authUser?.id ?? user?.id;
  const SETTINGS_CACHE_MS = 5 * 60_000; // 5-minute TTL — profile rarely changes
  const settingsCacheKey = userProfileScreenKey(scopedUserId);

  const loadSettings = async (forceRefresh = false) => {
    if (!forceRefresh && settingsCacheKey) {
      const cached = screenCache.get<UserProfile>(settingsCacheKey, SETTINGS_CACHE_MS);
      if (cached) {
        setProfile(cached);
        if (typeof cached.supports_password_biometric === 'boolean') {
          setPasswordBiometricSupported(cached.supports_password_biometric);
        }
      }
    }

    try {
      setLoading(false);

      const [profileResponse, fromPersist, chk] = await Promise.all([
        api.getUserProfile(),
        loadPersistedDefaultHomeWebPath(),
        api.checkAuth().catch(() => null),
      ]);

      if (profileResponse.success && profileResponse.data) {
        const userData = profileResponse.data;
        const supportsPasswordBiometric =
          userData.supports_password_biometric !== false &&
          !userData.google_linked &&
          !userData.apple_linked;
        const profileData: UserProfile = {
          id: userData.id || 0,
          username: userData.username || '',
          email: userData.email || '',
          first_name: userData.first_name || userData.name?.split(' ')[0] || '',
          last_name: userData.last_name || userData.name?.split(' ').slice(1).join(' ') || '',
          is_admin: userData.is_admin || false,
          created_at: userData.created_at || new Date().toISOString(),
          google_linked: !!userData.google_linked,
          apple_linked: !!userData.apple_linked,
          supports_password_biometric: supportsPasswordBiometric,
        };
        setProfile(profileData);
        setPasswordBiometricSupported(supportsPasswordBiometric);
        if (settingsCacheKey) screenCache.set(settingsCacheKey, profileData);
      }

      let resolvedForServer: WebDefaultHomePath = MOBILE_MAIN_HOME_WEB_ALIAS;
      let serverSpecified = false;

      try {
        if (chk && typeof chk === 'object') {
          const p = extractDefaultHomeFromAuthPayload(chk);
          if (!p || p.kind === 'absent') {
            /* no server default-home field */
          } else if (p.kind === 'none') {
            // DB NULL / empty / invalid → Home
            serverSpecified = true;
            await reconcilePersistenceWithServerNoDefault();
            resolvedForServer = MOBILE_MAIN_HOME_WEB_ALIAS;
          } else if (p.kind === 'path') {
            serverSpecified = true;
            await persistDefaultHomeWebPath(p.path);
            resolvedForServer = p.path;
          }
        }
      } catch {
        /* keep persisted / fallback */
      }

      let displaySelection: WebDefaultHomePath;
      if (!serverSpecified) {
        displaySelection =
          fromPersist && fromPersist !== MOBILE_MAIN_HOME_WEB_ALIAS
            ? (fromPersist as WebDefaultHomePath)
            : MOBILE_MAIN_HOME_WEB_ALIAS;
      } else {
        displaySelection = resolvedForServer;
      }

      setDefaultHomeWebPath(displaySelection);

      // Real plan label for Account (not hardcoded Free/Enterprise)
      try {
        const usage = await getSettingsUsageStats('month');
        const fromUsage = usage?.plan_display_name || usage?.subscription?.plan?.display_name;
        if (fromUsage) {
          setPlanDisplayName(fromUsage);
        } else {
          const myPlan = await getMyPlan().catch(() => null);
          const name =
            myPlan?.subscription?.plan?.display_name ||
            myPlan?.subscription?.plan_display_name ||
            myPlan?.plan_display_name;
          if (name) setPlanDisplayName(name);
        }
      } catch {
        /* keep previous / fallback label */
      }

      const [biometricConfig, info, userPrefs] = await Promise.all([
        deviceSecurityService.initializeBiometrics(),
        deviceSecurityService.getDeviceFingerprint(),
        deviceSecurityService.getUserPreferences(),
      ]);
      setBiometricAvailable(biometricConfig.enabled);
      setDeviceInfo(info);

      // SSO accounts cannot enroll biometric quick-login (requires username/password).
      const ssoBlocksBiometric =
        profileResponse.success &&
        profileResponse.data &&
        (profileResponse.data.supports_password_biometric === false ||
          profileResponse.data.google_linked ||
          profileResponse.data.apple_linked);
      if (ssoBlocksBiometric) {
        setPasswordBiometricSupported(false);
        setBiometricEnabled(false);
        if (userPrefs.biometricEnabled) {
          await deviceSecurityService.disableBiometricLoginPreference();
        }
      } else {
        setPasswordBiometricSupported(true);
        setBiometricEnabled(userPrefs.biometricEnabled);
      }
      setDeviceTrustEnabled(userPrefs.rememberDevice);
      setRemember2FA(userPrefs.rememberDevice);

      await checkHasPinSet();
    } catch (error) {
      console.error('Failed to load settings:', error);
      Alert.alert('Error', 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  const updatePreferences = async (updatedPreferences: UserPreferences) => {
    try {
      setUpdating(true);
      await setPreferences(updatedPreferences);
    } catch (error) {
      console.error('Failed to update preferences:', error);
      Alert.alert('Error', 'Failed to update preferences');
    } finally {
      setUpdating(false);
    }
  };

  const togglePreference = (key: string, value: boolean) => {
    void (async () => {
      try {
        setUpdating(true);
        await toggleStoredPreference(key, value);
      } catch (error) {
        console.error('Failed to update preferences:', error);
        Alert.alert('Error', 'Failed to update preferences');
      } finally {
        setUpdating(false);
      }
    })();
  };

  const formatJoinDate = (dateString: string) => {
    const date = parseAsUTC(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
    });
  };

  // Check if user can access feature (admin-only features)
  const canAccessFeature = (feature: string): boolean => {
    const adminOnlyFeatures = [
      'analytics.dashboard',
      'analytics.export',
      'file_management.auto_backup',
      'privacy.usage_statistics',
      'upload_settings.max_file_size',
      'display.items_per_page'
    ];
    
    if (adminOnlyFeatures.includes(feature)) {
      return profile?.is_admin || false;
    }
    
    return true;
  };

  const defaultHomeLabel = useMemo(() => {
    const path = defaultHomeWebPath || MOBILE_MAIN_HOME_WEB_ALIAS;
    return DEFAULT_HOME_SCREEN_OPTIONS.find((o) => o.webPath === path)?.label ?? 'Home';
  }, [defaultHomeWebPath]);

  const applyDefaultHomeSelection = async (selection: WebDefaultHomePath) => {
    try {
      setDefaultHomeSaving(true);
      let next = selection;
      if (selection === MOBILE_MAIN_HOME_WEB_ALIAS) {
        // Home → DB NULL; login opens main dashboard
        await api.updateWebDefaultHomePath(null);
        next = MOBILE_MAIN_HOME_WEB_ALIAS;
      } else {
        const res = await api.updateWebDefaultHomePath(selection);
        const returned =
          (res as { defaultHomePath?: string | null }).defaultHomePath ??
          (res as { default_home_path?: string | null }).default_home_path;
        next =
          typeof returned === 'string' && returned.trim()
            ? normalizeWebDefaultHomePath(returned)
            : selection;
      }
      await persistDefaultHomeWebPath(next);
      setDefaultHomeWebPath(next);
      setDefaultHomePickerOpen(false);
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Could not update default screen');
    } finally {
      setDefaultHomeSaving(false);
    }
  };

  const InfoItem = ({
    icon,
    title,
    value,
    onPress,
    adminOnly = false,
  }: {
    icon: string;
    title: string;
    value: string;
    onPress?: () => void;
    adminOnly?: boolean;
  }) => {
    // Hide admin-only features for non-admin users
    if (adminOnly && !profile?.is_admin) {
      return null;
    }

    return (
      <TouchableOpacity style={dynamicStyles.infoItem} onPress={onPress} disabled={!onPress}>
        <View style={dynamicStyles.settingIcon}>
          <Ionicons name={icon as any} size={20} color={colors.textSecondary} />
        </View>
        <View style={dynamicStyles.settingContent}>
          <Text style={dynamicStyles.settingTitle}>{title}</Text>
          <Text style={dynamicStyles.settingValue}>{value}</Text>
        </View>
        {onPress && <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />}
      </TouchableOpacity>
    );
  };

  const handleSignOut = () => {
    Alert.alert(
      'Sign Out',
      'Are you sure you want to sign out?',
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Sign Out',
          style: 'destructive',
          onPress: async () => {
            setSigningOut(true);
            try {
              await signOut();
              router.replace('/(auth)');
            } catch (error) {
              console.error('Sign out error:', error);
              Alert.alert('Error', 'Failed to sign out');
              setSigningOut(false);
            }
          },
        },
      ]
    );
  };

  const CollapsibleSection = ({
    title,
    isExpanded,
    onToggle,
    children,
    isDanger = false,
    adminOnly = false,
  }: {
    title: string;
    isExpanded: boolean;
    onToggle: () => void;
    children: React.ReactNode;
    isDanger?: boolean;
    adminOnly?: boolean;
  }) => {
    // Hide admin-only sections for non-admin users
    if (adminOnly && !profile?.is_admin) {
      return null;
    }

    return (
      <View style={dynamicStyles.section}>
        <TouchableOpacity style={dynamicStyles.sectionHeader} onPress={onToggle}>
          <Text style={[dynamicStyles.sectionTitle, isDanger && dynamicStyles.dangerText]}>{title}</Text>
          <Ionicons 
            name={isExpanded ? "chevron-up" : "chevron-down"} 
            size={20} 
            color={isDanger ? "#FF3B30" : colors.textSecondary} 
          />
        </TouchableOpacity>
        {isExpanded && <View style={dynamicStyles.sectionContent}>{children}</View>}
      </View>
    );
  };

  const getImplementationStatus = (feature: string): 'implemented' | 'partial' | 'placeholder' => {
    const implementedFeatures = [
      'notifications.push_enabled',
      'notifications.email_enabled',
      'file_management.auto_categorization',
      'file_management.auto_receipt_processing',
      'file_management.file_preview',
      'file_management.compress_images',
      'display.show_file_sizes',
      'display.show_upload_dates',
      'display.grid_view_default',
      'privacy.analytics_tracking',
      'privacy.crash_reporting',
      'privacy.usage_statistics',
      'security.biometric',
      'security.remember_device',
      'security.remember_2fa',
      'security.app_lock',
      'upload_settings.wifi_only_upload',
    ];

    const partialFeatures = [
      'notifications.file_upload',
      'notifications.file_processing',
      'notifications.form_responses',
      'notifications.upload_link_activity',
      'notifications.workspace_updates',
    ];

    if (implementedFeatures.includes(feature)) {
      return 'implemented';
    } else if (partialFeatures.includes(feature)) {
      return 'partial';
    } else {
      return 'placeholder';
    }
  };

  const StatusIndicator = ({ status }: { status: 'implemented' | 'partial' | 'placeholder' }) => {
    const colors = {
      implemented: '#34C759',
      partial: '#FF9500', 
      placeholder: '#8E8E93'
    };
    
    const symbols = {
      implemented: '✓',
      partial: '◐',
      placeholder: '○'
    };

    return (
      <View style={[dynamicStyles.statusIndicator, { backgroundColor: colors[status] }]}>
        <Text style={dynamicStyles.statusText}>{symbols[status]}</Text>
      </View>
    );
  };

  const EnhancedSettingItem = ({
    icon,
    title,
    subtitle,
    value,
    onToggle,
    disabled = false,
    feature,
    adminOnly = false,
  }: {
    icon: string;
    title: string;
    subtitle?: string;
    value: boolean;
    onToggle: (value: boolean) => void;
    disabled?: boolean;
    feature: string;
    adminOnly?: boolean;
  }) => {
    // Hide admin-only features for non-admin users
    if (adminOnly && !profile?.is_admin) {
      return null;
    }

    const status = getImplementationStatus(feature);
    const isDisabled = disabled || status === 'placeholder';
    
    return (
      <View style={[dynamicStyles.settingItem, isDisabled && dynamicStyles.disabledItem]} key={feature}>
      <View style={dynamicStyles.settingIcon}>
          <Ionicons name={icon as any} size={20} color={isDisabled ? colors.textLight : colors.textSecondary} />
      </View>
      <View style={dynamicStyles.settingContent}>
          <View style={dynamicStyles.settingTitleRow}>
            <Text style={[dynamicStyles.settingTitle, isDisabled && dynamicStyles.disabledText]}>{title}</Text>
            <StatusIndicator status={status} />
          </View>
          {subtitle && (
            <Text style={[dynamicStyles.settingSubtitle, isDisabled && dynamicStyles.disabledText]}>{subtitle}</Text>
          )}
      </View>
      <Switch
        value={value}
        onValueChange={onToggle}
          disabled={isDisabled}
          trackColor={{ false: colors.switchTrackOff, true: colors.success }}
          thumbColor={colors.switchThumbAndroid(value)}
          ios_backgroundColor={colors.switchTrackOff}
      />
    </View>
  );
  };

  const { scaledFontSize } = useThemeColors();
  
  const dynamicStyles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: colors.headerBackground,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    headerTitle: {
      fontSize: scaledFontSize(24),
      fontWeight: 'bold',
      color: colors.text,
    },
    scrollView: {
      flex: 1,
    },
    section: {
      backgroundColor: colors.sectionBackground,
      marginTop: 12,
    },
    sectionTitle: {
      fontSize: scaledFontSize(16),
      fontWeight: '600',
      color: colors.text,
      flex: 1,
    },
    dangerTitle: {
      color: '#FF3B30',
    },
    profileCard: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: 16,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    profileIcon: {
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: '#007AFF',
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 16,
    },
    profileInitials: {
      fontSize: 22,
      fontWeight: '700',
      color: '#fff',
    },
    profileInfo: {
      flex: 1,
    },
    profileName: {
      fontSize: scaledFontSize(18),
      fontWeight: '600',
      color: colors.text,
      marginBottom: 4,
    },
    profileEmail: {
      fontSize: scaledFontSize(14),
      color: colors.textSecondary,
      marginBottom: 8,
    },
    adminBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: '#FF6B35',
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 12,
      alignSelf: 'flex-start',
    },
    adminText: {
      fontSize: 12,
      color: '#fff',
      fontWeight: '600',
      marginLeft: 4,
    },
    settingItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    disabledSetting: {
      opacity: 0.5,
    },
    infoItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    dangerItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    settingIcon: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colors.surface,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 12,
    },
    settingContent: {
      flex: 1,
    },
    settingTitle: {
      fontSize: scaledFontSize(16),
      fontWeight: '500',
      color: colors.text,
      marginBottom: 2,
    },
    settingSubtitle: {
      fontSize: scaledFontSize(12),
      color: colors.textSecondary,
      lineHeight: scaledFontSize(16),
    },
    settingValue: {
      fontSize: 14,
      color: '#007AFF',
      fontWeight: '500',
    },
    dangerText: {
      color: '#FF3B30',
      fontWeight: '600',
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: colors.background,
    },
    loadingText: {
      marginTop: 12,
      fontSize: 16,
      color: colors.textSecondary,
    },
    collapsibleHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: colors.surface,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    testButton: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingVertical: 12,
      marginVertical: 8,
      backgroundColor: colors.surface,
      borderRadius: 8,
      marginHorizontal: 20,
    },
    testButtonText: {
      fontSize: 14,
      color: '#007AFF',
      fontWeight: '500',
      marginLeft: 12,
    },
    actionButton: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingVertical: 12,
      marginVertical: 4,
      backgroundColor: colors.surface,
      borderRadius: 8,
      marginHorizontal: 20,
    },
    actionButtonText: {
      fontSize: 14,
      color: '#007AFF',
      fontWeight: '500',
      marginLeft: 12,
    },
    dangerButton: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingVertical: 12,
      marginVertical: 4,
      backgroundColor: '#fff5f5',
      borderRadius: 8,
      marginHorizontal: 20,
    },
    dangerButtonText: {
      fontSize: 14,
      color: '#FF3B30',
      fontWeight: '500',
      marginLeft: 12,
    },
    deviceInfoSection: {
      marginTop: 16,
      marginHorizontal: 20,
      padding: 16,
      backgroundColor: colors.surface,
      borderRadius: 8,
    },
    deviceInfoTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.text,
      marginBottom: 8,
    },
    deviceInfoText: {
      fontSize: 12,
      color: colors.textSecondary,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      marginBottom: 4,
    },
    settingTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    statusIndicator: {
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: '#64748b',
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 8,
    },
    statusText: {
      fontSize: 12,
      fontWeight: '600',
      color: '#fff',
    },
    implementationNote: {
      fontSize: 12,
      color: colors.textSecondary,
      marginTop: 4,
    },
    sectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: colors.surface,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    sectionContent: {
      paddingTop: 0,
      paddingHorizontal: 0,
    },
    disabledItem: {
      opacity: 0.5,
    },
    disabledText: {
      color: colors.textLight,
    },
    themeOptions: {
      flexDirection: 'row',
      paddingHorizontal: 12,
      paddingBottom: 12,
      gap: 8,
    },
    themeOption: {
      flex: 1,
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 10,
      paddingHorizontal: 6,
      borderRadius: 8,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      minHeight: 76,
    },
    themeOptionActive: {
      backgroundColor: '#e3f2fd',
      borderColor: '#007AFF',
      borderWidth: 2,
    },
    themeIcon: {
      width: 26,
      height: 26,
      borderRadius: 5,
      borderWidth: 1,
      marginBottom: 6,
      overflow: 'hidden',
    },
    themeIconInner: {
      width: '100%',
      height: '100%',
    },
    themeOptionText: {
      fontSize: scaledFontSize(12),
      fontWeight: '600',
      color: colors.text,
      textAlign: 'center',
    },
    themeOptionTextActive: {
      color: '#007AFF',
      fontWeight: '600',
    },
    modalOverlay: modalScrimOverlayStyle(colors.isDark, {
      justifyContent: 'center',
      alignItems: 'center',
      padding: 24,
    }),
    modalCard: {
      ...floatingDialogSurfaceStyle(colors, colors.isDark, { borderRadius: 16 }),
      width: '100%',
      maxWidth: 340,
      padding: 24,
    },
    pinInput: {
      paddingVertical: 12,
      paddingHorizontal: 16,
      borderRadius: 10,
      borderWidth: 1,
      fontSize: 18,
    },
    primaryButton: {
      paddingVertical: 12,
      borderRadius: 10,
      backgroundColor: colors.tint,
      alignItems: 'center',
    },
    primaryButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: '#fff',
    },
    secondaryButton: {
      paddingVertical: 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
    },
    secondaryButtonText: {
      fontSize: 16,
      fontWeight: '500',
      color: colors.text,
    },
    scaleSliderContainer: {
      paddingHorizontal: 16,
      paddingBottom: 16,
    },
    scaleLabels: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: 8,
    },
    scaleLabel: {
      fontSize: 12,
      color: colors.textSecondary,
    },
    scaleButtons: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 4,
    },
    scaleButton: {
      flex: 1,
      height: 36,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 6,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    scaleButtonActive: {
      backgroundColor: '#e3f2fd',
      borderColor: '#007AFF',
    },
    scaleButtonDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    defaultHomeModalCard: {
      maxHeight: '72%',
      width: '100%',
      maxWidth: 400,
      padding: 16,
      borderRadius: 16,
      backgroundColor: colors.sectionBackground,
      ...dialogSurfaceBorder(colors.isDark, colors.border),
      ...dialogSurfaceShadow(colors.isDark),
    },
    defaultHomeModalTitle: {
      fontSize: scaledFontSize(18),
      fontWeight: '700',
      color: colors.text,
      marginBottom: 4,
    },
    defaultHomeModalSubtitle: {
      fontSize: scaledFontSize(13),
      color: colors.textSecondary,
      marginBottom: 12,
    },
    defaultHomeOptionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 12,
      paddingHorizontal: 4,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    defaultHomeOptionLabel: {
      fontSize: scaledFontSize(15),
      color: colors.text,
      flex: 1,
      paddingRight: 8,
    },
  }), [colors, scaledFontSize]);

  if (loading) {
    return (
      <SafeAreaView style={dynamicStyles.container}>
        <View style={dynamicStyles.loadingContainer}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={dynamicStyles.loadingText}>Loading settings...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={dynamicStyles.container}>
      <TapToToggleHeaderView style={dynamicStyles.container}>
      <AnimatedHeaderContainer>
        <View style={dynamicStyles.header}>
          <AppBackButton />
          <AppHeaderTitle>Settings</AppHeaderTitle>
        </View>
      </AnimatedHeaderContainer>

      <ScrollView
        style={dynamicStyles.scrollView}
        contentContainerStyle={{ paddingBottom: 96 }}
        showsVerticalScrollIndicator={false}
        {...scrollRestoresHeaderProps}
      >

        {/* Notifications Section - HIDDEN */}
        {/* {preferences && (
          <CollapsibleSection
            title="Notifications"
            isExpanded={expandedSections.notifications}
            onToggle={() => toggleSection('notifications')}
          >
            ...
          </CollapsibleSection>
        )} */}

        {/* Billing & Usage — top-level (not nested under Account) */}
        <InfoItem
          icon="card-outline"
          title="Billing & Usage"
          value={planDisplayName || 'View plan, usage, and invoices'}
          onPress={() => router.push('/billing' as any)}
        />

        {/* Enhanced 2FA Security Section */}
        <CollapsibleSection
          title="Security & 2FA"
          isExpanded={expandedSections.security}
          onToggle={() => toggleSection('security')}
        >
          <EnhancedSettingItem
            icon="finger-print"
            title="Biometric Authentication"
            subtitle={
              !passwordBiometricSupported
                ? "Unavailable for Google/Apple sign-in accounts. Sign in with username and password to use biometric login."
                : biometricAvailable
                  ? "Use Face ID, Touch ID/fingerprint, or your device PIN/passcode for quick login"
                  : "Set up Face ID, fingerprint, or a device PIN/passcode in your phone Settings first"
            }
            value={passwordBiometricSupported && biometricEnabled}
            onToggle={async (value) => {
              if (!passwordBiometricSupported) {
                Alert.alert(
                  'Biometric Unavailable',
                  'Accounts signed in with Google or Apple cannot use biometric quick login because it requires a username and password. Use Google/Apple sign-in, or App Lock for on-device unlock.',
                  [{ text: 'OK' }]
                );
                return;
              }
              if (!biometricAvailable) {
                Alert.alert(
                  'Device Lock Not Available',
                  'Set up Face ID, Touch ID/fingerprint, or a device PIN/passcode in your phone Settings, then try again.',
                  [{ text: 'OK' }]
                );
                return;
              }
              
              if (value) {
                try {
                  const result = await deviceSecurityService.authenticateWithBiometrics('Enable biometric authentication');
                  if (result.success) {
                    setBiometricEnabled(true);
                    const userPrefs = await deviceSecurityService.getUserPreferences();
                    await deviceSecurityService.setUserPreferences({
                      ...userPrefs,
                      biometricEnabled: true,
                    });
                    Alert.alert('Success', 'Biometric authentication enabled!');
                  }
                } catch (error) {
                  Alert.alert('Error', 'Failed to enable biometric authentication');
                }
              } else {
                setBiometricEnabled(false);
                const userPrefs = await deviceSecurityService.getUserPreferences();
                await deviceSecurityService.setUserPreferences({
                  ...userPrefs,
                  biometricEnabled: false,
                });
              }
            }}
            disabled={!biometricAvailable || !passwordBiometricSupported}
            feature="security.biometric"
          />

          <EnhancedSettingItem
            icon="lock-closed"
            title="App lock"
            subtitle={`Lock app ${lockAfterMinutes} min after background. Unlock with Face ID, Touch ID, or your device passcode.`}
            value={appLockEnabled}
            onToggle={async (value) => {
              try {
                await setAppLockEnabled(value);
              } catch (e: any) {
                Alert.alert('Error', e?.message || 'Failed to update app lock');
              }
            }}
            feature="security.app_lock"
          />
          
          <EnhancedSettingItem
            icon="shield-checkmark"
            title="Device Trust"
            subtitle="Remember this device to reduce 2FA prompts"
            value={deviceTrustEnabled}
            onToggle={async (value) => {
              setDeviceTrustEnabled(value);
              const userPrefs = await deviceSecurityService.getUserPreferences();
              await deviceSecurityService.setUserPreferences({
                ...userPrefs,
                rememberDevice: value,
              });

              if (!value) {
                await deviceSecurityService.revokeDeviceTrust();
                Alert.alert(
                  'Device Trust Disabled',
                  'This device will no longer be remembered. You may need to go through 2FA verification on your next login.',
                  [{ text: 'OK' }]
                );
                return;
              }

              try {
                const fingerprint = await deviceSecurityService.getDeviceFingerprint();
                const trustRes = await api.trustCurrentDevice({
                  fingerprint: fingerprint as unknown as Record<string, unknown>,
                  deviceName: fingerprint.deviceName,
                  platform: fingerprint.platform,
                  installationId: fingerprint.installationId,
                  deviceId: fingerprint.deviceId,
                });
                if (trustRes?.success) {
                  await deviceSecurityService.setDeviceTrust(
                    'trusted',
                    userPrefs.trustedDevicesDuration || 30
                  );
                }
              } catch (trustErr) {
                console.warn('Failed to register trusted device on backend:', trustErr);
                Alert.alert(
                  'Device Trust',
                  'Saved on this phone, but could not sync with the server. Try again while online.',
                  [{ text: 'OK' }]
                );
              }
            }}
            feature="security.remember_device"
          />
          
          <EnhancedSettingItem
            icon="time"
            title="Remember 2FA"
            subtitle="Skip 2FA on trusted devices for 30 days"
            value={remember2FA}
            onToggle={async (value) => {
              setRemember2FA(value);
              const userPrefs = await deviceSecurityService.getUserPreferences();
              await deviceSecurityService.setUserPreferences({
                ...userPrefs,
                rememberDevice: value,
              });
            }}
            feature="security.remember_2fa"
          />

          {/* Test Biometric Authentication - HIDDEN */}
          {/* {biometricAvailable && (
            <TouchableOpacity 
              style={dynamicStyles.testButton} 
              onPress={async () => {
                try {
                  const result = await deviceSecurityService.authenticateWithBiometrics('Test biometric authentication');
                  if (result.success) {
                    Alert.alert('Success', 'Biometric authentication successful!');
                  }
                } catch (error) {
                  Alert.alert('Error', error.message || 'Biometric authentication failed');
                }
              }}
            >
              <View style={dynamicStyles.settingIcon}>
                <Ionicons name="finger-print" size={20} color="#007AFF" />
              </View>
              <Text style={dynamicStyles.testButtonText}>Test Biometric Authentication</Text>
            </TouchableOpacity>
          )} */}

          <FeedbackTouchable 
            style={dynamicStyles.actionButton} 
            onPress={async () => {
              try {
                const score = await deviceSecurityService.calculateRiskScore();
                Alert.alert(
                  'Current Risk Score',
                  `Your current risk score is ${score}/100\n\n` +
                  `0-30: Low Risk (Trusted)\n` +
                  `31-60: Medium Risk (2FA Required)\n` +
                  `61-100: High Risk (Full Verification)`
                );
              } catch (error) {
                Alert.alert('Error', 'Failed to calculate risk score');
              }
            }}
            replaceWithSpinner={false}
            spinnerColor="#007AFF"
          >
            <View style={dynamicStyles.settingIcon}>
              <Ionicons name="analytics" size={20} color="#007AFF" />
            </View>
            <Text style={dynamicStyles.actionButtonText}>Check Security Risk Score</Text>
          </FeedbackTouchable>

          <FeedbackTouchable 
            style={dynamicStyles.actionButton} 
            onPress={async () => {
              try {
                // Ensure this device is registered when Device Trust is enabled so it appears in the list
                if (deviceTrustEnabled) {
                  try {
                    const fingerprint = await deviceSecurityService.getDeviceFingerprint();
                    await api.trustCurrentDevice({
                      fingerprint: fingerprint as unknown as Record<string, unknown>,
                      deviceName: fingerprint.deviceName,
                      platform: fingerprint.platform,
                      installationId: fingerprint.installationId,
                      deviceId: fingerprint.deviceId,
                    });
                  } catch (ensureErr) {
                    console.warn('Could not ensure current device is trusted before listing:', ensureErr);
                  }
                }

                const response = await api.getRegisteredDevices();
                // Handle both response structures: direct data or wrapped in success response
                const devices = (response as any).devices || (response as any).data?.devices || (Array.isArray(response) ? response : []);
                
                if (devices.length === 0) {
                  Alert.alert(
                    'Registered Devices',
                    'No registered devices found',
                    [{ text: 'OK' }]
                  );
                  return;
                }
                
                const deviceList = devices.map((device: any) => {
                  const deviceId = String(device.deviceId || device.id || 'Unknown');
                  const deviceName = device.deviceName || device.name || device.device_name || 'Unknown Device';
                  const lastUsed = device.lastUsed || device.last_used || device.last_used_at || device.updated_at;
                  const isActive = device.isActive !== undefined ? device.isActive : (device.is_active !== undefined ? device.is_active : true);
                  const isCurrent = !!(device.isCurrent || device.is_current);
                  
                  return `• ${deviceName}${isCurrent ? ' (This device)' : ''}\n  ID: ${deviceId.length > 12 ? deviceId.substring(0, 12) + '...' : deviceId}\n  Last used: ${lastUsed ? new Date(lastUsed).toLocaleDateString() : 'Never'}\n  ${isActive ? '✅ Active' : '❌ Inactive'}`;
                }).join('\n\n');
                
                Alert.alert(
                  'Registered Devices',
                  deviceList,
                  [{ text: 'OK' }]
                );
              } catch (error: any) {
                console.error('Device retrieval error:', error);
                const statusCode = error?.response?.status;
                const errorMessage = error?.response?.data?.message || error?.message || 'Failed to retrieve registered devices';
                
                // Handle 404 specifically - endpoint not implemented
                if (statusCode === 404) {
                  Alert.alert(
                    'Feature Not Available',
                    'The device management feature is not yet available on this server. Please contact support if you need this functionality.',
                    [{ text: 'OK' }]
                  );
                } else {
                  Alert.alert('Error', errorMessage);
                }
              }
            }}
            replaceWithSpinner={false}
            spinnerColor="#007AFF"
          >
            <View style={dynamicStyles.settingIcon}>
              <Ionicons name="phone-portrait" size={20} color="#007AFF" />
            </View>
            <Text style={dynamicStyles.actionButtonText}>View Registered Devices</Text>
          </FeedbackTouchable>

          <FeedbackTouchable 
            style={dynamicStyles.dangerButton} 
            onPress={() => {
              Alert.alert(
                'Clear All Device Trust',
                'This will remove trust from all devices and you will need to verify with 2FA on all devices. Continue?',
                [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Clear All',
                    style: 'destructive',
                    onPress: async () => {
                      setClearingDeviceTrust(true);
                      try {
                        await deviceSecurityService.revokeDeviceTrust();
                        await deviceSecurityService.clearAllDeviceData();
                        
                        // Also clear from backend
                        try {
                          const response = await api.revokeAllDevices() as any;
                          if (response.success) {
                            const count = response.count || response.revokedCount || response.data?.count || 0;
                            Alert.alert('Success', `Device trust cleared for ${count} device${count !== 1 ? 's' : ''}`);
                          } else {
                            Alert.alert('Success', 'Local device trust cleared');
                          }
                        } catch (apiError: any) {
                          console.error('Failed to revoke devices on backend:', apiError);
                          // Still show success for local clearing
                          Alert.alert('Success', 'Local device trust cleared. Backend sync may have failed.');
                        }
                      } catch (error) {
                        console.error('Failed to clear device trust:', error);
                        Alert.alert('Error', error instanceof Error ? error.message : 'Failed to clear all device trust');
                      } finally {
                        setClearingDeviceTrust(false);
                      }
                    },
                  },
                ]
              );
            }}
            loading={clearingDeviceTrust}
            replaceWithSpinner={false}
            spinnerColor="#FF3B30"
          >
            <View style={dynamicStyles.settingIcon}>
              <Ionicons name="trash" size={20} color="#FF3B30" />
            </View>
            <Text style={dynamicStyles.dangerButtonText}>Clear All Device Trust</Text>
          </FeedbackTouchable>

          {deviceInfo && (
            <View style={dynamicStyles.deviceInfoSection}>
              <Text style={dynamicStyles.deviceInfoTitle}>Device Information</Text>
              <Text style={dynamicStyles.deviceInfoText}>Device ID: {deviceInfo.deviceId.substring(0, 12)}...</Text>
              <Text style={dynamicStyles.deviceInfoText}>Platform: {deviceInfo.platform}</Text>
              <Text style={dynamicStyles.deviceInfoText}>OS Version: {deviceInfo.osVersion}</Text>
              <Text style={dynamicStyles.deviceInfoText}>App Version: {deviceInfo.appVersion}</Text>
            </View>
          )}
        </CollapsibleSection>

        {/* File Management Section - HIDDEN */}
        {/* {preferences && (
          <CollapsibleSection
            title="File Management"
            isExpanded={expandedSections.fileManagement}
            onToggle={() => toggleSection('fileManagement')}
          >
            ...
          </CollapsibleSection>
        )} */}

        {/* Upload Settings Section */}
        {preferences && (
          <CollapsibleSection
            title="Upload Settings"
            isExpanded={expandedSections.uploadSettings}
            onToggle={() => toggleSection('uploadSettings')}
          >
            <EnhancedSettingItem
              icon="wifi-outline"
              title="WiFi Only Upload"
              subtitle="Only upload files when connected to WiFi"
              value={preferences.upload_settings.wifi_only_upload}
              onToggle={(value) => togglePreference('upload_settings.wifi_only_upload', value)}
              feature="upload_settings.wifi_only_upload"
            />
            <InfoItem
              icon="archive-outline"
              title="Max File Size"
              value={`${preferences.upload_settings.max_file_size_mb} MB`}
              onPress={() => Alert.alert('File Size Limit', 'Current maximum file size is 50MB. This helps ensure faster uploads and better performance. Contact support if you need to upload larger files.')}
              adminOnly={true}
            />
            <InfoItem
              icon="document-outline"
              title="Allowed File Types"
              value={`${preferences.upload_settings.allowed_file_types.length} types`}
              onPress={() => Alert.alert('Supported File Types', `Currently supported file types:\n\n• ${preferences.upload_settings.allowed_file_types.join('\n• ')}\n\nThese formats ensure optimal processing and compatibility with our AI analysis features.`)}
              adminOnly={true}
            />
          </CollapsibleSection>
        )}

        {/* Display Settings Section */}
        {preferences && (
          <CollapsibleSection
            title="Display"
            isExpanded={expandedSections.display}
            onToggle={() => toggleSection('display')}
          >
            {/* Theme Selector */}
            <View style={dynamicStyles.settingItem}>
              <View style={dynamicStyles.settingIcon}>
                <Ionicons name="color-palette-outline" size={20} color={colors.textSecondary} />
              </View>
              <View style={dynamicStyles.settingContent}>
                <Text style={dynamicStyles.settingTitle}>Theme</Text>
              </View>
            </View>
            <View style={dynamicStyles.themeOptions}>
              <TouchableOpacity
                style={[dynamicStyles.themeOption, theme === 'light' && dynamicStyles.themeOptionActive]}
                onPress={() => setTheme('light')}
              >
                <View style={[dynamicStyles.themeIcon, { backgroundColor: '#ffffff', borderColor: '#e0e0e0' }]}>
                  <View style={[dynamicStyles.themeIconInner, { backgroundColor: '#f5f5f5' }]} />
                </View>
                <Text style={[dynamicStyles.themeOptionText, theme === 'light' && dynamicStyles.themeOptionTextActive]}>
                  Light
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[dynamicStyles.themeOption, theme === 'dark' && dynamicStyles.themeOptionActive]}
                onPress={() => setTheme('dark')}
              >
                <View style={[dynamicStyles.themeIcon, { backgroundColor: '#1a1a1a', borderColor: '#333' }]}>
                  <View style={[dynamicStyles.themeIconInner, { backgroundColor: '#2a2a2a' }]} />
                </View>
                <Text style={[dynamicStyles.themeOptionText, theme === 'dark' && dynamicStyles.themeOptionTextActive]}>
                  Dark
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[dynamicStyles.themeOption, theme === 'system' && dynamicStyles.themeOptionActive]}
                onPress={() => setTheme('system')}
              >
                <View style={[dynamicStyles.themeIcon, { backgroundColor: '#ffffff', borderColor: '#e0e0e0' }]}>
                  <View style={[dynamicStyles.themeIconInner, { backgroundColor: '#1a1a1a', width: '50%' }]} />
                </View>
                <Text style={[dynamicStyles.themeOptionText, theme === 'system' && dynamicStyles.themeOptionTextActive]}>
                  System
                </Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={dynamicStyles.infoItem}
              onPress={() => !defaultHomeSaving && setDefaultHomePickerOpen(true)}
              disabled={defaultHomeSaving}
            >
              <View style={dynamicStyles.settingIcon}>
                <Ionicons name="home-outline" size={20} color={colors.textSecondary} />
              </View>
              <View style={dynamicStyles.settingContent}>
                <Text style={dynamicStyles.settingTitle}>Default screen</Text>
                <Text style={dynamicStyles.settingSubtitle}>Opens after you sign in</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                {defaultHomeSaving ? (
                  <ActivityIndicator size="small" color="#007AFF" />
                ) : (
                  <>
                    <Text style={[dynamicStyles.settingValue, { marginRight: 4 }]} numberOfLines={1}>
                      {defaultHomeLabel}
                    </Text>
                    <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
                  </>
                )}
              </View>
            </TouchableOpacity>
            
            {/* Display Scale Control */}
            <View style={dynamicStyles.settingItem}>
              <View style={dynamicStyles.settingIcon}>
                <Ionicons name="text-outline" size={20} color={colors.textSecondary} />
              </View>
              <View style={dynamicStyles.settingContent}>
                <Text style={dynamicStyles.settingTitle}>Display Size</Text>
                <Text style={dynamicStyles.settingSubtitle}>
                  {scale === 1.0 ? 'Default' : scale < 1.0 ? 'Smaller' : 'Larger'} ({Math.round(scale * 100)}%)
                </Text>
              </View>
            </View>
            <View style={dynamicStyles.scaleSliderContainer}>
              <View style={dynamicStyles.scaleLabels}>
                <Text style={dynamicStyles.scaleLabel}>Smaller</Text>
                <Text style={dynamicStyles.scaleLabel}>Default</Text>
                <Text style={dynamicStyles.scaleLabel}>Larger</Text>
              </View>
              <View style={dynamicStyles.scaleButtons}>
                <TouchableOpacity
                  style={[dynamicStyles.scaleButton, scale === MIN_SCALE && dynamicStyles.scaleButtonActive]}
                  onPress={() => setScale(MIN_SCALE)}
                >
                  <Ionicons name="remove-outline" size={18} color={scale === MIN_SCALE ? '#007AFF' : colors.textSecondary} />
                </TouchableOpacity>
                {[0.9, 1.0, 1.1, 1.2, 1.3, 1.4, MAX_SCALE].map((value) => (
                  <TouchableOpacity
                    key={value}
                    style={[
                      dynamicStyles.scaleButton,
                      scale === value && dynamicStyles.scaleButtonActive,
                      Math.abs(scale - value) < 0.05 && dynamicStyles.scaleButtonActive
                    ]}
                    onPress={() => setScale(value)}
                  >
                    <View style={[
                      dynamicStyles.scaleButtonDot,
                      scale === value || Math.abs(scale - value) < 0.05
                        ? { backgroundColor: '#007AFF' }
                        : { backgroundColor: colors.border }
                    ]} />
                  </TouchableOpacity>
                ))}
                <TouchableOpacity
                  style={[dynamicStyles.scaleButton, scale === MAX_SCALE && dynamicStyles.scaleButtonActive]}
                  onPress={() => setScale(MAX_SCALE)}
                >
                  <Ionicons name="add-outline" size={18} color={scale === MAX_SCALE ? '#007AFF' : colors.textSecondary} />
                </TouchableOpacity>
              </View>
            </View>
            
            <EnhancedSettingItem
              icon="resize-outline"
              title="Show File Sizes"
              subtitle="Display file sizes in document lists"
              value={preferences.display.show_file_sizes}
              onToggle={(value) => togglePreference('display.show_file_sizes', value)}
              feature="display.show_file_sizes"
            />
            <EnhancedSettingItem
              icon="time-outline"
              title="Show Upload Dates"
              subtitle="Display upload dates in document lists"
              value={preferences.display.show_upload_dates}
              onToggle={(value) => togglePreference('display.show_upload_dates', value)}
              feature="display.show_upload_dates"
            />
            <EnhancedSettingItem
              icon="grid-outline"
              title="Grid View Default"
              subtitle="Use grid view by default for documents"
              value={preferences.display.grid_view_default}
              onToggle={(value) => togglePreference('display.grid_view_default', value)}
              feature="display.grid_view_default"
            />
            <InfoItem
              icon="list-outline"
              title="Items Per Page"
              value={`${preferences.display.items_per_page} items`}
              onPress={() => {
                Alert.alert(
                  'Items Per Page',
                  'How many documents to load per page in file lists.',
                  [
                    {
                      text: '10',
                      onPress: () =>
                        void updatePreferences({
                          ...preferences,
                          display: { ...preferences.display, items_per_page: 10 },
                        }),
                    },
                    {
                      text: '20',
                      onPress: () =>
                        void updatePreferences({
                          ...preferences,
                          display: { ...preferences.display, items_per_page: 20 },
                        }),
                    },
                    {
                      text: '50',
                      onPress: () =>
                        void updatePreferences({
                          ...preferences,
                          display: { ...preferences.display, items_per_page: 50 },
                        }),
                    },
                    { text: 'Cancel', style: 'cancel' },
                  ],
                );
              }}
              adminOnly={true}
            />
          </CollapsibleSection>
        )}

        {/* Privacy Section */}
        {preferences && (
          <CollapsibleSection
            title="Privacy & Data"
            isExpanded={expandedSections.privacy}
            onToggle={() => toggleSection('privacy')}
          >
            <EnhancedSettingItem
              icon="analytics-outline"
              title="Analytics Tracking"
              subtitle="Help improve the app with usage data"
              value={preferences.privacy.analytics_tracking}
              onToggle={(value) => togglePreference('privacy.analytics_tracking', value)}
              feature="privacy.analytics_tracking"
            />
            <EnhancedSettingItem
              icon="bug-outline"
              title="Crash Reporting"
              subtitle="Send crash reports to help fix issues"
              value={preferences.privacy.crash_reporting}
              onToggle={(value) => togglePreference('privacy.crash_reporting', value)}
              feature="privacy.crash_reporting"
            />
            <EnhancedSettingItem
              icon="stats-chart-outline"
              title="Usage Statistics"
              subtitle="Share anonymous usage statistics"
              value={preferences.privacy.usage_statistics}
              onToggle={(value) => togglePreference('privacy.usage_statistics', value)}
              feature="privacy.usage_statistics"
              adminOnly={true}
            />
          </CollapsibleSection>
        )}

        {/* About Section */}
        <CollapsibleSection
          title="About"
          isExpanded={expandedSections.about}
          onToggle={() => toggleSection('about')}
        >
          <InfoItem
            icon="information-circle-outline"
            title="App Version"
            value={(() => {
              const appVersion = Constants.expoConfig?.version || '1.0.0';
              const buildNumber = Platform.OS === 'ios' 
                ? Constants.expoConfig?.ios?.buildNumber 
                : Constants.expoConfig?.android?.versionCode;
              return buildNumber 
                ? `${appVersion} (Build ${buildNumber})`
                : appVersion;
            })()}
          />
          <InfoItem
            icon="help-circle-outline"
            title="Help & Support"
            value="Get help with the app"
            onPress={() => router.navigate('/(tabs)/help')}
          />
          <InfoItem
            icon="accessibility-outline"
            title="Report Accessibility Issue"
            value="Contact us about accessibility"
            onPress={() => Linking.openURL('mailto:support@grabdocs.com?subject=Accessibility%20Support')}
          />
          <InfoItem
            icon="document-text-outline"
            title="Privacy Policy"
            value="Read our privacy policy"
            onPress={() => {
              Alert.alert(
                'Privacy Policy',
                'Open Privacy Policy in browser?',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { 
                    text: 'Open', 
                    onPress: () => {
                                             const url = 'https://www.grabdocs.com/privacy-policy';
                       if (Platform.OS === 'web') {
                         window.open(url, '_blank');
                       } else {
                         Linking.openURL(url);
                       }
                    }
                  }
                ]
              );
            }}
          />
          <InfoItem
            icon="shield-checkmark-outline"
            title="Terms of Service"
            value="Read our terms of service"
            onPress={() => {
              Alert.alert(
                'Terms of Service',
                'Open Terms of Service in browser?',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { 
                    text: 'Open', 
                    onPress: () => {
                                             const url = 'https://www.grabdocs.com/terms-of-service';
                       if (Platform.OS === 'web') {
                         window.open(url, '_blank');
                       } else {
                         Linking.openURL(url);
                       }
                    }
                  }
                ]
              );
            }}
          />
        </CollapsibleSection>

        {/* Account Section */}
        <CollapsibleSection
          title="Account"
          isExpanded={expandedSections.account}
          onToggle={() => toggleSection('account')}
        >
          {/* User Profile Info */}
          {profile && (
            <>
              <View style={dynamicStyles.profileCard}>
                <View style={dynamicStyles.profileIcon}>
                  {(() => {
                    const first = (profile.first_name || '').trim();
                    const last = (profile.last_name || '').trim();
                    const initials = (first.charAt(0) + last.charAt(0)).toUpperCase();
                    if (initials) {
                      return <Text style={dynamicStyles.profileInitials}>{initials}</Text>;
                    }
                    return <Ionicons name="person" size={32} color="#fff" />;
                  })()}
                </View>
                <View style={dynamicStyles.profileInfo}>
                  <Text style={dynamicStyles.profileName}>
                    {profile.first_name || profile.last_name
                      ? `${profile.first_name} ${profile.last_name}`.trim()
                      : profile.username}
                  </Text>
                  <Text style={dynamicStyles.profileEmail}>{profile.email}</Text>
                  <Text style={[dynamicStyles.profileEmail, { marginTop: 4, fontSize: 13, opacity: 0.8 }]}>
                    Member since • {formatJoinDate(profile.created_at)} •{' '}
                    {planDisplayName || (profile.is_admin ? 'Enterprise' : 'Free Plan')}
                  </Text>
                  {profile.is_admin && (
                    <View style={dynamicStyles.adminBadge}>
                      <Ionicons name="shield" size={12} color="#fff" />
                      <Text style={dynamicStyles.adminText}>Admin</Text>
                    </View>
                  )}
                </View>
              </View>
            </>
          )}
          
          <TouchableOpacity 
            style={dynamicStyles.dangerItem}
            onPress={() => {
              Alert.alert(
                'Delete Account',
                'Are you sure you want to delete your account? This action is irreversible and will permanently delete all your data, documents, and account information.\n\nYou will be redirected to our data deletion request page.',
                [
                  { 
                    text: 'Cancel', 
                    style: 'cancel' 
                  },
                  {
                    text: 'Continue',
                    style: 'destructive',
                    onPress: () => {
                      const url = 'https://grabdocs.com/data-deletion-request';
                      if (Platform.OS === 'web') {
                        window.open(url, '_blank');
                      } else {
                        Linking.openURL(url);
                      }
                    }
                  }
                ]
              );
            }}
          >
            <View style={dynamicStyles.settingIcon}>
              <Ionicons name="trash-outline" size={20} color="#FF3B30" />
            </View>
            <View style={dynamicStyles.settingContent}>
              <Text style={[dynamicStyles.settingTitle, dynamicStyles.dangerText]}>Delete Account</Text>
              <Text style={dynamicStyles.settingSubtitle}>Request account deletion</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#FF3B30" />
          </TouchableOpacity>
          
          <FeedbackTouchable 
            style={dynamicStyles.dangerItem}
            onPress={handleSignOut}
            loading={signingOut}
            replaceWithSpinner={false}
            spinnerColor="#FF3B30"
          >
            <View style={dynamicStyles.settingIcon}>
              <Ionicons name="log-out-outline" size={20} color="#FF3B30" />
            </View>
            <View style={dynamicStyles.settingContent}>
              <Text style={[dynamicStyles.settingTitle, dynamicStyles.dangerText]}>Sign Out</Text>
              <Text style={dynamicStyles.settingSubtitle}>Sign out of your account</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#FF3B30" />
          </FeedbackTouchable>
        </CollapsibleSection>
      </ScrollView>

      <Modal
        visible={defaultHomePickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => !defaultHomeSaving && setDefaultHomePickerOpen(false)}
      >
        <TouchableOpacity
          style={dynamicStyles.modalOverlay}
          activeOpacity={1}
          onPress={() => !defaultHomeSaving && setDefaultHomePickerOpen(false)}
        >
          <TouchableOpacity
            activeOpacity={1}
            onPress={(e) => e.stopPropagation()}
            style={[dynamicStyles.modalCard, dynamicStyles.defaultHomeModalCard, { backgroundColor: colors.sectionBackground }]}
          >
            <Text style={dynamicStyles.defaultHomeModalTitle}>Default screen</Text>
            <Text style={dynamicStyles.defaultHomeModalSubtitle}>
              Choose where the app opens after you sign in (same as web).
            </Text>
            <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
              {DEFAULT_HOME_SCREEN_OPTIONS.map((opt) => (
                <FeedbackTouchable
                  key={opt.webPath}
                  style={dynamicStyles.defaultHomeOptionRow}
                  onPress={() => applyDefaultHomeSelection(opt.webPath)}
                  disabled={defaultHomeSaving}
                  loading={defaultHomeSaving}
                  replaceWithSpinner={false}
                  spinnerColor="#007AFF"
                >
                  <Text style={dynamicStyles.defaultHomeOptionLabel}>{opt.label}</Text>
                  {(defaultHomeWebPath || MOBILE_MAIN_HOME_WEB_ALIAS) === opt.webPath ? (
                    <Ionicons name="checkmark-circle" size={22} color="#007AFF" />
                  ) : (
                    <Ionicons name="ellipse-outline" size={22} color={colors.border} />
                  )}
                </FeedbackTouchable>
              ))}
            </ScrollView>
            <TouchableOpacity
              style={[dynamicStyles.secondaryButton, { marginTop: 16 }]}
              onPress={() => !defaultHomeSaving && setDefaultHomePickerOpen(false)}
            >
              <Text style={dynamicStyles.secondaryButtonText}>Cancel</Text>
            </TouchableOpacity>
            {defaultHomeSaving && (
              <View style={{ alignItems: 'center', marginTop: 12 }}>
                <ActivityIndicator color="#007AFF" />
              </View>
            )}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* GrabDocs Set/Change PIN modal - commented out; app lock uses biometric + device passcode only
      <Modal visible={showSetPinModal} ...>
        ... Set PIN / Confirm PIN / Save ...
      </Modal>
      */}

      </TapToToggleHeaderView>
    </SafeAreaView>
  );
}

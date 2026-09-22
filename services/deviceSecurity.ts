// import * as Crypto from 'expo-crypto'; // Temporarily disabled for build
import * as Device from 'expo-device';
import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';
import { secureStorage } from '../utils/storage';

// Types and interfaces
interface DeviceFingerprint {
  deviceId: string;
  deviceName: string;
  platform: string;
  osVersion: string;
  appVersion: string;
  installationId: string;
  createdAt: string;
}

interface DeviceTrust {
  deviceId: string;
  trustLevel: 'unknown' | 'trusted' | 'verified';
  trustedUntil: string;
  lastSeen: string;
  authMethods: string[];
}

interface BiometricConfig {
  enabled: boolean;
  types: LocalAuthentication.AuthenticationType[];
  fallbackEnabled: boolean;
  /** True when fingerprint/Face ID/iris data is enrolled. */
  biometricsEnrolled: boolean;
  /** True when device PIN/pattern/passcode is enrolled (SecurityLevel.SECRET+). */
  passcodeEnrolled: boolean;
}

interface RiskContext {
  isNewDevice: boolean;
  locationChanged: boolean;
  networkChanged: boolean;
  daysSinceLastLogin: number;
  failedAttempts: number;
  timeOfDay: 'normal' | 'unusual';
}

interface User2FAPreferences {
  biometricEnabled: boolean;
  rememberDevice: boolean;
  trustedDevicesDuration: 7 | 30 | 90; // days
  smsBackupRequired: boolean;
  highRiskSMSRequired: boolean;
  riskThreshold: 'low' | 'medium' | 'high';
}

/** How the user last authenticated. Password is the only path that can enroll biometric quick-login. */
export type AuthMethod = 'password' | 'google' | 'apple' | 'phone' | 'biometric';

interface LastLoginData {
  timestamp: string;
  location?: string;
  authMethod?: AuthMethod;
  /** Login identifier last used (email/username) — kept in sync after email change. */
  email?: string;
}

// Storage keys
const STORAGE_KEYS = {
  DEVICE_FINGERPRINT: 'device_fingerprint',
  DEVICE_TRUST: 'device_trust',
  USER_PREFERENCES: 'user_2fa_preferences',
  LAST_LOGIN: 'last_login_data',
  FAILED_ATTEMPTS: 'failed_attempts',
  BIOMETRIC_CONFIG: 'biometric_config',
} as const;

// Web-compatible UUID generator
function generateUUID(): string {
  if (Platform.OS === 'web' && typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for platforms without crypto.randomUUID
  return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}-${Math.random().toString(36).substring(2, 15)}`;
}

class DeviceSecurityService {
  private deviceFingerprint: DeviceFingerprint | null = null;
  private biometricConfig: BiometricConfig | null = null;

  // ==================== DEVICE FINGERPRINTING ====================

  async generateDeviceFingerprint(): Promise<DeviceFingerprint> {
    if (this.deviceFingerprint) {
      return this.deviceFingerprint;
    }

    try {
      // Generate unique installation ID if not exists
      let installationId = await secureStorage.getItem('installation_id');
      if (!installationId) {
        installationId = generateUUID();
        await secureStorage.setItem('installation_id', installationId);
      }

      const fingerprint: DeviceFingerprint = {
        deviceId: Platform.OS === 'web' 
          ? `web-${navigator.userAgent.slice(0, 50)}` 
          : (Device.osInternalBuildId || Device.modelId || 'unknown'),
        deviceName: Platform.OS === 'web'
          ? navigator.userAgent
          : (Device.deviceName || Device.modelName || 'Unknown Device'),
        platform: Platform.OS,
        osVersion: Platform.OS === 'web'
          ? navigator.platform
          : (Device.osVersion || 'unknown'),
        appVersion: '1.0.0', // Get from app.json in real implementation
        installationId,
        createdAt: new Date().toISOString(),
      };

      // Cache and store
      this.deviceFingerprint = fingerprint;
      await secureStorage.setItem(STORAGE_KEYS.DEVICE_FINGERPRINT, JSON.stringify(fingerprint));

      return fingerprint;
    } catch (error) {
      console.error('Failed to generate device fingerprint:', error);
      // On web, don't throw - return a basic fingerprint instead
      if (Platform.OS === 'web') {
        const fallbackFingerprint: DeviceFingerprint = {
          deviceId: 'web-fallback',
          deviceName: 'Web Browser',
          platform: 'web',
          osVersion: navigator.platform || 'unknown',
          appVersion: '1.0.0',
          installationId: generateUUID(),
          createdAt: new Date().toISOString(),
        };
        this.deviceFingerprint = fallbackFingerprint;
        return fallbackFingerprint;
      }
      throw new Error('Device fingerprinting failed');
    }
  }

  async getDeviceFingerprint(): Promise<DeviceFingerprint> {
    if (this.deviceFingerprint) {
      return this.deviceFingerprint;
    }

    try {
      const stored = await secureStorage.getItem(STORAGE_KEYS.DEVICE_FINGERPRINT);
      if (stored) {
        this.deviceFingerprint = JSON.parse(stored);
        return this.deviceFingerprint!;
      }
    } catch (error) {
      console.warn('Failed to load device fingerprint:', error);
    }

    // Generate new if not found
    return this.generateDeviceFingerprint();
  }

  // ==================== DEVICE TRUST MANAGEMENT ====================

  async setDeviceTrust(trustLevel: DeviceTrust['trustLevel'], duration: number = 30): Promise<void> {
    try {
      const fingerprint = await this.getDeviceFingerprint();
      const trustData: DeviceTrust = {
        deviceId: fingerprint.deviceId,
        trustLevel,
        trustedUntil: new Date(Date.now() + duration * 24 * 60 * 60 * 1000).toISOString(),
        lastSeen: new Date().toISOString(),
        authMethods: await this.getAvailableAuthMethods(),
      };

      await secureStorage.setItem(STORAGE_KEYS.DEVICE_TRUST, JSON.stringify(trustData));
      console.log(`Device trust set to: ${trustLevel} for ${duration} days`);
    } catch (error) {
      console.error('Failed to set device trust:', error);
      throw new Error('Failed to update device trust');
    }
  }

  async getDeviceTrust(): Promise<DeviceTrust | null> {
    try {
      const stored = await secureStorage.getItem(STORAGE_KEYS.DEVICE_TRUST);
      if (!stored) return null;

      const trust: DeviceTrust = JSON.parse(stored);
      
      // Check if trust has expired
      if (new Date() > new Date(trust.trustedUntil)) {
        await secureStorage.removeItem(STORAGE_KEYS.DEVICE_TRUST);
        return null;
      }

      // Update last seen
      trust.lastSeen = new Date().toISOString();
      await secureStorage.setItem(STORAGE_KEYS.DEVICE_TRUST, JSON.stringify(trust));

      return trust;
    } catch (error) {
      console.warn('Failed to get device trust:', error);
      return null;
    }
  }

  async revokeDeviceTrust(): Promise<void> {
    try {
      await secureStorage.removeItem(STORAGE_KEYS.DEVICE_TRUST);
      console.log('Device trust revoked');
    } catch (error) {
      console.error('Failed to revoke device trust:', error);
    }
  }

  // ==================== BIOMETRIC AUTHENTICATION ====================

  async initializeBiometrics(): Promise<BiometricConfig> {
    // Biometrics / device credentials are not available on web
    if (Platform.OS === 'web') {
      const config: BiometricConfig = {
        enabled: false,
        types: [],
        fallbackEnabled: false,
        biometricsEnrolled: false,
        passcodeEnrolled: false,
      };
      this.biometricConfig = config;
      return config;
    }

    try {
      // Always re-check enrollment — users can add a PIN/biometrics after first launch.
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const supportedTypes = await LocalAuthentication.supportedAuthenticationTypesAsync();
      const biometricsEnrolled = await LocalAuthentication.isEnrolledAsync();
      const enrolledLevel = await LocalAuthentication.getEnrolledLevelAsync();
      // SECRET = device PIN/pattern/passcode; BIOMETRIC_* = fingerprint/face.
      const passcodeEnrolled = enrolledLevel >= LocalAuthentication.SecurityLevel.SECRET;
      const deviceCredentialAvailable = passcodeEnrolled || biometricsEnrolled;

      console.log('🔐 Device credential check:', {
        hasHardware,
        supportedTypes: supportedTypes.map(type =>
          type === LocalAuthentication.AuthenticationType.FINGERPRINT ? 'Fingerprint' :
          type === LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION ? 'Face ID' :
          type === LocalAuthentication.AuthenticationType.IRIS ? 'Iris' : 'Unknown'
        ),
        biometricsEnrolled,
        enrolledLevel,
        passcodeEnrolled,
        deviceCredentialAvailable,
      });

      // Accept biometrics OR device PIN/passcode. PIN-only devices have no biometric
      // hardware enrollment, so hasHardware/isEnrolled alone would incorrectly block them.
      const config: BiometricConfig = {
        enabled: deviceCredentialAvailable,
        types: supportedTypes,
        fallbackEnabled: true,
        biometricsEnrolled,
        passcodeEnrolled,
      };

      this.biometricConfig = config;
      await secureStorage.setItem(STORAGE_KEYS.BIOMETRIC_CONFIG, JSON.stringify(config));

      console.log('🔐 Final biometric config:', config);
      return config;
    } catch (error) {
      console.error('Failed to initialize biometrics:', error);
      return {
        enabled: false,
        types: [],
        fallbackEnabled: true,
        biometricsEnrolled: false,
        passcodeEnrolled: false,
      };
    }
  }

  /** Returns success and optional error code so UI can distinguish "cancelled" from "failed". */
  async authenticateWithBiometrics(reason: string = 'Authenticate to access your account'): Promise<{ success: boolean; error?: string }> {
    // Biometrics not available on web
    if (Platform.OS === 'web') {
      console.log('❌ Biometric authentication not available on web');
      return { success: false, error: 'not_available' };
    }

    try {
      const config = await this.initializeBiometrics();
      console.log('🔐 Biometric config:', config);

      if (!config.enabled) {
        console.log('❌ No device credentials enrolled (biometrics or PIN/passcode)');
        return { success: false, error: 'not_enrolled' };
      }

      // disableDeviceFallback: false → iOS LAPolicyDeviceOwnerAuthentication /
      // Android device credential — accepts fingerprint/Face ID OR device PIN/passcode.
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: reason,
        fallbackLabel: 'Use Passcode',
        disableDeviceFallback: false,
        cancelLabel: 'Cancel',
      });

      console.log('🔐 Biometric authentication result:', result);
      if (result.success) return { success: true };
      return { success: false, error: result.error ?? 'unknown' };
    } catch (error) {
      console.error('Biometric authentication failed:', error);
      return { success: false, error: 'unknown' };
    }
  }

  async getBiometricTypesAvailable(): Promise<string[]> {
    const config = await this.initializeBiometrics();
    return config.types.map(type => {
      switch (type) {
        case LocalAuthentication.AuthenticationType.FINGERPRINT:
          return 'Fingerprint';
        case LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION:
          return 'Face ID';
        case LocalAuthentication.AuthenticationType.IRIS:
          return 'Iris';
        default:
          return 'Biometric';
      }
    });
  }

  // ==================== RISK ASSESSMENT ====================

  async calculateRiskScore(context?: Partial<RiskContext>): Promise<number> {
    try {
      let riskScore = 0;
      const trust = await this.getDeviceTrust();
      const lastLogin = await this.getLastLoginData();
      const failedAttempts = await this.getFailedAttemptsCount();

      // Device trust factor (0-40 points)
      if (!trust) {
        riskScore += 40; // New/untrusted device
      } else if (trust.trustLevel === 'unknown') {
        riskScore += 25;
      } else if (trust.trustLevel === 'trusted') {
        riskScore += 10;
      }
      // Verified devices add 0 points

      // Time since last login (0-25 points)
      if (lastLogin) {
        const daysSince = (Date.now() - new Date(lastLogin.timestamp).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSince > 90) riskScore += 25;
        else if (daysSince > 30) riskScore += 15;
        else if (daysSince > 7) riskScore += 5;
      } else {
        riskScore += 20; // No previous login
      }

      // Failed attempts (0-20 points)
      if (failedAttempts > 5) riskScore += 20;
      else if (failedAttempts > 2) riskScore += 10;
      else if (failedAttempts > 0) riskScore += 5;

      // Time of day factor (0-10 points)
      const hour = new Date().getHours();
      if (hour < 6 || hour > 23) riskScore += 10; // Very late/early
      else if (hour < 8 || hour > 22) riskScore += 5; // Unusual hours

      // Context-specific factors
      if (context) {
        if (context.isNewDevice) riskScore += 15;
        if (context.locationChanged) riskScore += 10;
        if (context.networkChanged) riskScore += 5;
        if (context.failedAttempts && context.failedAttempts > failedAttempts) {
          riskScore += Math.min(context.failedAttempts * 5, 20);
        }
      }

      // Cap at 100
      return Math.min(riskScore, 100);
    } catch (error) {
      console.error('Risk calculation failed:', error);
      return 50; // Medium risk as fallback
    }
  }

  determineRequiredAuthMethod(riskScore: number, userPrefs?: User2FAPreferences): string {
    const prefs = userPrefs || this.getDefaultPreferences();
    
    // High risk always requires SMS
    if (riskScore >= 70 || prefs.highRiskSMSRequired) {
      return 'SMS_2FA';
    }
    
    // Medium risk
    if (riskScore >= 40) {
      if (prefs.biometricEnabled) {
        return 'BIOMETRIC_PLUS_PASSWORD';
      }
      return 'PASSWORD_PLUS_SMS';
    }
    
    // Low risk
    if (riskScore < 40) {
      if (prefs.biometricEnabled) {
        return 'BIOMETRIC_ONLY';
      }
      if (prefs.rememberDevice) {
        return 'PASSWORD_ONLY';
      }
    }
    
    return 'PASSWORD_PLUS_SMS'; // Fallback
  }

  // ==================== USER PREFERENCES ====================

  async getUserPreferences(): Promise<User2FAPreferences> {
    try {
      const stored = await secureStorage.getItem(STORAGE_KEYS.USER_PREFERENCES);
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (error) {
      console.warn('Failed to load user preferences:', error);
    }
    
    return this.getDefaultPreferences();
  }

  async setUserPreferences(prefs: User2FAPreferences): Promise<void> {
    try {
      await secureStorage.setItem(STORAGE_KEYS.USER_PREFERENCES, JSON.stringify(prefs));
    } catch (error) {
      console.error('Failed to save user preferences:', error);
      throw new Error('Failed to save preferences');
    }
  }

  private getDefaultPreferences(): User2FAPreferences {
    return {
      biometricEnabled: true,
      rememberDevice: true,
      trustedDevicesDuration: 30,
      smsBackupRequired: true,
      highRiskSMSRequired: true,
      riskThreshold: 'medium',
    };
  }

  // ==================== HELPER METHODS ====================

  private async getAvailableAuthMethods(): Promise<string[]> {
    const methods: string[] = ['password'];
    
    const biometricTypes = await this.getBiometricTypesAvailable();
    methods.push(...biometricTypes);
    
    return methods;
  }

  private async getLastLoginData(): Promise<LastLoginData | null> {
    try {
      const stored = await secureStorage.getItem(STORAGE_KEYS.LAST_LOGIN);
      return stored ? JSON.parse(stored) : null;
    } catch (error) {
      return null;
    }
  }

  async setLastLoginData(data: LastLoginData): Promise<void> {
    try {
      // Preserve prior authMethod/email when callers only refresh timestamp.
      const existing = await this.getLastLoginData();
      const merged: LastLoginData = {
        ...existing,
        ...data,
        authMethod: data.authMethod ?? existing?.authMethod,
        email: data.email ?? existing?.email,
      };
      await secureStorage.setItem(STORAGE_KEYS.LAST_LOGIN, JSON.stringify(merged));
    } catch (error) {
      console.warn('Failed to save last login data:', error);
    }
  }

  async setLastAuthMethod(authMethod: AuthMethod): Promise<void> {
    await this.setLastLoginData({
      timestamp: new Date().toISOString(),
      authMethod,
    });
  }

  /** Update stored last-login email after a confirmed email change (biometric / remember flows). */
  async updateLastLoginEmail(email: string): Promise<void> {
    const trimmed = (email || '').trim();
    if (!trimmed) return;
    try {
      const existing = await this.getLastLoginData();
      await this.setLastLoginData({
        timestamp: existing?.timestamp || new Date().toISOString(),
        email: trimmed,
        authMethod: existing?.authMethod,
      });
    } catch (error) {
      console.warn('Failed to update last login email:', error);
    }
  }

  async getLastLoginEmail(): Promise<string | null> {
    const data = await this.getLastLoginData();
    return data?.email?.trim() || null;
  }

  async getLastAuthMethod(): Promise<AuthMethod | null> {
    const data = await this.getLastLoginData();
    return data?.authMethod ?? null;
  }

  /**
   * Biometric quick-login is enrolled via username/password.
   * SSO (Google/Apple) accounts cannot complete that enrollment path.
   */
  isPasswordBiometricCompatible(authMethod: AuthMethod | null | undefined): boolean {
    return authMethod === 'password' || authMethod === 'biometric';
  }

  async isBiometricLoginEligibleForLastUser(): Promise<boolean> {
    const method = await this.getLastAuthMethod();
    if (!this.isPasswordBiometricCompatible(method)) {
      return false;
    }
    try {
      const prefs = await this.getUserPreferences();
      return !!prefs.biometricEnabled;
    } catch {
      return false;
    }
  }

  /** Disable stored biometric quick-login preference (e.g. after detecting SSO account). */
  async disableBiometricLoginPreference(): Promise<void> {
    const prefs = await this.getUserPreferences();
    if (!prefs.biometricEnabled) return;
    await this.setUserPreferences({ ...prefs, biometricEnabled: false });
  }

  private async getFailedAttemptsCount(): Promise<number> {
    try {
      const stored = await secureStorage.getItem(STORAGE_KEYS.FAILED_ATTEMPTS);
      return stored ? parseInt(stored, 10) : 0;
    } catch (error) {
      return 0;
    }
  }

  async incrementFailedAttempts(): Promise<number> {
    const current = await this.getFailedAttemptsCount();
    const newCount = current + 1;
    try {
      await secureStorage.setItem(STORAGE_KEYS.FAILED_ATTEMPTS, newCount.toString());
    } catch (error) {
      console.warn('Failed to increment failed attempts:', error);
    }
    return newCount;
  }

  async resetFailedAttempts(): Promise<void> {
    try {
      await secureStorage.removeItem(STORAGE_KEYS.FAILED_ATTEMPTS);
    } catch (error) {
      console.warn('Failed to reset failed attempts:', error);
    }
  }

  // ==================== CLEANUP METHODS ====================

  async clearAllDeviceData(): Promise<void> {
    try {
      const keys = Object.values(STORAGE_KEYS);
      await Promise.all(keys.map(key => secureStorage.removeItem(key).catch(() => {})));
      // Also clear installation_id
      await secureStorage.removeItem('installation_id').catch(() => {});
      
      this.deviceFingerprint = null;
      this.biometricConfig = null;
      
      console.log('All device security data cleared');
    } catch (error) {
      console.error('Failed to clear device data:', error);
    }
  }

  // ==================== DEBUG METHODS ====================

  async getDeviceSecurityStatus(): Promise<{
    deviceFingerprint: DeviceFingerprint | null;
    deviceTrust: DeviceTrust | null;
    biometricConfig: BiometricConfig | null;
    userPreferences: User2FAPreferences;
    riskScore: number;
    failedAttempts: number;
  }> {
    return {
      deviceFingerprint: await this.getDeviceFingerprint(),
      deviceTrust: await this.getDeviceTrust(),
      biometricConfig: await this.initializeBiometrics(),
      userPreferences: await this.getUserPreferences(),
      riskScore: await this.calculateRiskScore(),
      failedAttempts: await this.getFailedAttemptsCount(),
    };
  }
}

// Export singleton instance
export const deviceSecurityService = new DeviceSecurityService();
export default deviceSecurityService;

// Export types for use in other files
export type {
    BiometricConfig, DeviceFingerprint,
    DeviceTrust, RiskContext,
    User2FAPreferences
};


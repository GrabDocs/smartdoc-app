import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useAuth } from '../app/context/auth';
import { API_BASE_URL, STORAGE_KEYS } from '../constants/Config';
import { apiClient } from '../services/api';
import { deviceSecurityService } from '../services/deviceSecurity';
import { googleAuthService } from '../services/googleAuth';
import { secureStorage } from '../utils/storage';
import { persistMobileAuthTokens, clearMobileAuthTokens } from '../utils/authTokenStorage';

// Import types from the real service
type DeviceFingerprint = any;
type User2FAPreferences = any;

// Enhanced auth types
interface Enhanced2FAUser {
  id: number;
  username: string;
  email: string;
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
  isSystemAdmin?: boolean;
  authMethod?: 'password' | 'google' | 'phone_2fa';
  deviceTrusted?: boolean;
}

interface AuthState {
  isAuthenticated: boolean;
  user: Enhanced2FAUser | null;
  isLoading: boolean;
  deviceFingerprint: DeviceFingerprint | null;
  userPreferences: User2FAPreferences | null;
  lastRiskScore: number;
}

interface LoginCredentials {
  username: string;
  password: string;
  rememberDevice?: boolean;
}

interface Enhanced2FAContextType {
  // Auth state
  isAuthenticated: boolean;
  user: Enhanced2FAUser | null;
  isLoading: boolean;
  
  // Device security
  deviceFingerprint: DeviceFingerprint | null;
  userPreferences: User2FAPreferences | null;
  lastRiskScore: number;
  
  // Authentication methods
  login: (credentials: LoginCredentials) => Promise<{ success: boolean; requires2FA?: boolean; authMethod?: string; message?: string }>;
  loginWithBiometric: () => Promise<{ success: boolean; message?: string }>;
  signInWithGoogle: () => Promise<{ success: boolean; requires2FA?: boolean; authMethod?: string; message?: string; completedViaDeepLink?: boolean }>;
  signup: (data: { username: string; email: string; password: string; firstName?: string; lastName?: string }) => Promise<{ success: boolean; message?: string }>;
  logout: () => Promise<void>;
  
  // 2FA methods
  requestOTP: (phoneNumber: string, countryCode?: string) => Promise<{ success: boolean; message?: string; testOtp?: string }>;
  verifyOTP: (phoneNumber: string, otpCode: string) => Promise<{ success: boolean; message?: string }>;
  loginWithPhone: (phoneNumber: string, password: string) => Promise<{ success: boolean; message?: string }>;
  
  // Device management
  updateUserPreferences: (prefs: User2FAPreferences) => Promise<void>;
  revokeDeviceTrust: () => Promise<void>;
  getSecurityStatus: () => Promise<any>;
  
  // Utility
  refreshAuth: () => Promise<void>;
  calculateCurrentRiskScore: () => Promise<number>;
}

const Enhanced2FAAuthContext = createContext<Enhanced2FAContextType | undefined>(undefined);

export function Enhanced2FAAuthProvider({ children }: { children: React.ReactNode }) {
  const authContext = useAuth(); // Get the regular auth context
  
  const [authState, setAuthState] = useState<AuthState>({
    isAuthenticated: false,
    user: null,
    isLoading: true,
    deviceFingerprint: null,
    userPreferences: null,
    lastRiskScore: 0,
  });

  // ==================== INITIALIZATION ====================

  useEffect(() => {
    initializeAuth();
  }, []);

  const initializeAuth = useCallback(async () => {
    try {
      setAuthState(prev => ({ ...prev, isLoading: true }));

      // Initialize device security
      const deviceFingerprint = await deviceSecurityService.generateDeviceFingerprint();
      const userPreferences = await deviceSecurityService.getUserPreferences();
      const riskScore = await deviceSecurityService.calculateRiskScore();

      const authResult = await checkAuthStatus();

      setAuthState({
        isAuthenticated: authResult.success,
        user: authResult.user || null,
        isLoading: false,
        deviceFingerprint,
        userPreferences,
        lastRiskScore: riskScore,
      });

    } catch (error) {
      console.error('Failed to initialize Enhanced 2FA Auth:', error);
      setAuthState(prev => ({ 
        ...prev, 
        isLoading: false,
        isAuthenticated: false
      }));
    }
  }, []);

  const checkAuthStatus = async () => {
    try {
      // Use apiClient instead of plain fetch so auth token is automatically included
      const response = await apiClient.checkAuth();
      
      if (response && response.success) {
        // Handle different response structures: response.data or response.user
        const userData = response.data || response.user || null;
        
        if (userData) {
          return {
            success: true,
            user: {
              id: userData.id,
              username: userData.username,
              email: userData.email,
              firstName: userData.first_name || userData.firstName,
              lastName: userData.last_name || userData.lastName,
            },
          };
        } else {
          return { success: true, user: null };
        }
      } else {
        return { success: false, user: null };
      }
    } catch (error: any) {
      // Don't log as error if it's just an unauthenticated state
      const errorMessage = error.response?.data?.message || error.message || 'Auth check failed';
      const statusCode = error.response?.status;
      const isExpectedAuthFailure =
        statusCode === 401 ||
        statusCode === 403 ||
        statusCode === undefined || // e.g. apiClient re-threw plain Error with no response
        errorMessage.toLowerCase().includes('unauthorized') ||
        errorMessage.toLowerCase().includes('token') ||
        errorMessage.toLowerCase().includes('authentication') ||
        errorMessage === 'Auth check failed'; // common when not logged in

      if (isExpectedAuthFailure) {
        console.log('🔐 User not authenticated (expected if not logged in)');
      } else {
        console.error('Auth check failed:', errorMessage, 'Status:', statusCode);
      }
      return { success: false, user: null };
    }
  };

  // ==================== ENHANCED LOGIN ====================

  const login = useCallback(async (credentials: LoginCredentials) => {
    try {
      console.log('🔐 LOGIN START:', credentials.username);
      setAuthState(prev => ({ ...prev, isLoading: true }));

      // Step 1: Calculate risk score
      const riskScore = await deviceSecurityService.calculateRiskScore();
      const userPrefs = await deviceSecurityService.getUserPreferences();
      const requiredAuthMethod = deviceSecurityService.determineRequiredAuthMethod(riskScore, userPrefs);

      console.log(`Login attempt - Risk: ${riskScore}, Method: ${requiredAuthMethod}`);

      // Step 2: Handle biometric pre-authentication
      if (requiredAuthMethod === 'BIOMETRIC_ONLY' || requiredAuthMethod === 'BIOMETRIC_PLUS_PASSWORD') {
        console.log('🔒 Biometric pre-auth required');
        
        // Check if biometrics are actually available
        const biometricConfig = await deviceSecurityService.initializeBiometrics();
        if (!biometricConfig.enabled) {
          console.log('⚠️ Biometrics not available, skipping biometric auth');
          // Continue with password-only login since biometrics aren't available
        } else {
          const biometricResult = await deviceSecurityService.authenticateWithBiometrics(
            'Verify your identity to sign in'
          );

          if (!biometricResult.success && requiredAuthMethod === 'BIOMETRIC_ONLY') {
            console.log('❌ Biometric pre-auth failed');
            setAuthState(prev => ({ ...prev, isLoading: false }));
            return {
              success: false,
              requires2FA: true,
              authMethod: 'BIOMETRIC',
              message: 'Biometric authentication required',
            };
          }
          console.log('✅ Biometric pre-auth success');
        }
      }

      // Step 3: Regular login attempt
      console.log('🌐 Making API login request...');
      const deviceFingerprint = await deviceSecurityService.generateDeviceFingerprint();
      
      // Get stored device token if available (for trusted device check)
      const storedDeviceToken = await secureStorage.getItem(STORAGE_KEYS.DEVICE_TOKEN);
      
      const loginData = {
        username: credentials.username,
        password: credentials.password,
        deviceInfo: {
          fingerprint: deviceFingerprint,
          riskScore,
          requiredAuthMethod,
          rememberDevice: credentials.rememberDevice,
        },
      };

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Platform': 'mobile',
      };

      // Include device token if available (for trusted device verification)
      if (storedDeviceToken) {
        headers['X-Device-Token'] = storedDeviceToken;
        console.log('🔐 Including device token in login request');
      }

      const response = await fetch(`${API_BASE_URL}/api/v1/mobile/login`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(loginData),
      });

      console.log('📡 API Response status:', response.status);
      const result = await response.json();
      console.log('📊 API Response data:', result);

      if (result.success) {
        // Check if 2FA is required even though success is true
        if (result.requires2FA) {
          console.log('🔐 2FA required - OTP sent, navigating to verification screen');
          setAuthState(prev => ({ ...prev, isLoading: false }));
          
          // Return requires2FA flag so the UI can navigate to OTP screen
          return {
            success: false, // Set to false so UI knows login isn't complete
            requires2FA: true,
            authMethod: result.preferredAuthMethod || 'phone',
            message: 'Please verify the code sent to your ' + (result.preferredAuthMethod === 'phone' ? 'phone' : 'email'),
            user: result.user,
            identifier: result.user?.masked_phone_number || result.user?.email,
          };
        }
        
        console.log('✅ LOGIN SUCCESS');
        // Login successful (no 2FA required)
        await deviceSecurityService.resetFailedAttempts();
        
        if (result.session_info?.deviceTrusted) {
          await deviceSecurityService.setDeviceTrust('trusted', 30);
        }

        await deviceSecurityService.setLastLoginData({
          timestamp: new Date().toISOString(),
          authMethod: 'password',
          email: credentials.username,
        });

        // Store authentication tokens and user data
        await persistMobileAuthTokens({
          token: result.token || 'session_token',
          access_token: result.access_token ?? result.token,
          refresh_token: result.refresh_token,
        });
        if (result.token) {
          console.log('💾 Stored authentication token');
        } else {
          console.log('💾 Stored fallback session_token');
        }

        if (result.user) {
          await secureStorage.setItem(STORAGE_KEYS.USER_DATA, JSON.stringify(result.user));
          console.log('💾 Stored user data');
        }

        // Store device token if device is trusted
        if (result.deviceToken) {
          await secureStorage.setItem(STORAGE_KEYS.DEVICE_TOKEN, result.deviceToken);
          console.log('💾 Stored device token for trusted device');
        }

        setAuthState(prev => ({
          ...prev,
          isAuthenticated: true,
          user: result.user,
          isLoading: false,
          lastRiskScore: riskScore,
        }));

          // 🔄 SYNC WITH REGULAR AUTH CONTEXT FOR NAVIGATION
          console.log('🔄 Syncing with regular auth context...');
          try {
            if (authContext?.signIn) {
              await authContext.signIn(credentials.username, credentials.password, credentials.rememberDevice || false);
              console.log('✅ Regular auth context updated successfully');
            }
          } catch (error) {
            console.warn('⚠️ Failed to sync with regular auth context:', error);
            // Continue anyway since Enhanced2FA login was successful
          }

          return {
            success: true,
            message: 'Login successful',
          };
      } else {
        console.log('❌ LOGIN FAILED:', result.message);
        // Login failed
        await deviceSecurityService.incrementFailedAttempts();
        
        // Check if 2FA is required
        if (requiredAuthMethod.includes('SMS') || riskScore >= 60) {
          setAuthState(prev => ({ ...prev, isLoading: false }));
          return {
            success: false,
            requires2FA: true,
            authMethod: 'SMS_2FA',
            message: 'Additional verification required',
          };
        }

        setAuthState(prev => ({ ...prev, isLoading: false }));
        return {
          success: false,
          message: result.message || 'Login failed',
        };
      }

    } catch (error) {
      console.error('💥 Enhanced login error:', error);
      await deviceSecurityService.incrementFailedAttempts();
      
      setAuthState(prev => ({ ...prev, isLoading: false }));
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Login failed',
      };
    }
  }, []);

  // ==================== BIOMETRIC LOGIN ====================

  const loginWithBiometric = useCallback(async () => {
    try {
      setAuthState(prev => ({ ...prev, isLoading: true }));

      // First, check if biometrics are available on this device
      const biometricConfig = await deviceSecurityService.initializeBiometrics();
      if (!biometricConfig.enabled) {
        setAuthState(prev => ({ ...prev, isLoading: false }));
        return {
          success: false,
          message: 'Biometric authentication is not available on this device',
        };
      }

      // Perform biometric authentication first
      const biometricResult = await deviceSecurityService.authenticateWithBiometrics(
        'Sign in with biometric authentication'
      );

      if (!biometricResult.success) {
        setAuthState(prev => ({ ...prev, isLoading: false }));
        return {
          success: false,
          message: 'Biometric authentication was cancelled or failed',
        };
      }

      // Check if device is trusted for biometric login
      const deviceTrust = await deviceSecurityService.getDeviceTrust();
      
      if (!deviceTrust || deviceTrust.trustLevel !== 'trusted') {
        // Device not trusted - inform user they need to login with username/password first
        setAuthState(prev => ({ ...prev, isLoading: false }));
        return {
          success: false,
          message: 'Device not enrolled for biometric login. Please sign in with your username and password first to enable biometric authentication.',
        };
      }

      // Verify with backend using device trust
      const deviceFingerprint = await deviceSecurityService.generateDeviceFingerprint();
      const response = await fetch(`${API_BASE_URL}/api/v1/mobile/auth/biometric-login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Platform': 'mobile',
        },
        credentials: 'include',
        body: JSON.stringify({
          deviceFingerprint,
          trustData: deviceTrust,
        }),
      });

      const result = await response.json();

      if (result.success) {
        await deviceSecurityService.setLastLoginData({
          timestamp: new Date().toISOString(),
          authMethod: 'biometric',
        });

        // Store authentication token and user data
        await persistMobileAuthTokens({
          token: result.token || 'session_token',
          access_token: result.access_token ?? result.token,
          refresh_token: result.refresh_token,
        });
        if (result.token) {
          console.log('💾 Stored authentication token (biometric)');
        } else {
          console.log('💾 Stored fallback session_token (biometric)');
        }

        if (result.user) {
          await secureStorage.setItem(STORAGE_KEYS.USER_DATA, JSON.stringify(result.user));
          console.log('💾 Stored user data (biometric)');
        }

        setAuthState(prev => ({
          ...prev,
          isAuthenticated: true,
          user: result.user,
          isLoading: false,
        }));

        // 🔄 SYNC WITH REGULAR AUTH CONTEXT FOR NAVIGATION
        console.log('🔄 Syncing biometric login with regular auth context...');
        try {
          if (authContext?.setUserFromExternal && result.user) {
            const ru = result.user as Record<string, any>;
            const fullName =
              `${ru.first_name || ru.firstName || ''} ${ru.last_name || ru.lastName || ''}`.trim();
            await authContext.setUserFromExternal(
              {
                id: String(ru.id ?? ru.user_id ?? ''),
                email: (typeof ru.email === 'string' && ru.email) || (typeof ru.username === 'string' && ru.username) || '',
                name: fullName || ru.name || ru.username || ru.email || '',
                first_name: ru.first_name ?? ru.firstName,
                last_name: ru.last_name ?? ru.lastName,
                username: typeof ru.username === 'string' ? ru.username : undefined,
              },
              typeof result.token === 'string' ? result.token : undefined
            );
            console.log('✅ Regular auth context updated successfully');
          }
        } catch (error) {
          console.warn('⚠️ Failed to sync with regular auth context:', error);
          // Continue anyway since biometric login was successful
        }

        return {
          success: true,
          message: 'Biometric login successful',
        };
      } else {
        setAuthState(prev => ({ ...prev, isLoading: false }));
        return {
          success: false,
          message: result.message || 'Biometric login failed',
        };
      }

    } catch (error) {
      console.error('Biometric login error:', error);
      setAuthState(prev => ({ ...prev, isLoading: false }));
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Biometric login failed',
      };
    }
  }, [authContext]);

  // ==================== GOOGLE SIGN-IN ====================

  const signInWithGoogle = useCallback(async () => {
    try {
      setAuthState(prev => ({ ...prev, isLoading: true }));

      const result = await googleAuthService.signInWithGoogleEnhanced();

      // Native: OAuth finishes via grabdocs://login-success; no user object here.
      if (result.success && result.completedViaDeepLink) {
        setAuthState(prev => ({ ...prev, isLoading: false }));
        return {
          success: true,
          message: result.message || 'Complete sign-in in the browser.',
          completedViaDeepLink: true,
        };
      }

      if (result.success && result.user) {
        // Store authentication token and user data
        await persistMobileAuthTokens({
          token: result.token || 'session_token',
          access_token: result.access_token ?? result.token,
          refresh_token: result.refresh_token,
        });
        if (result.token) {
          console.log('💾 Stored authentication token (Google)');
        } else {
          console.log('💾 Stored fallback session_token (Google)');
        }

        if (result.user) {
          await secureStorage.setItem(STORAGE_KEYS.USER_DATA, JSON.stringify(result.user));
          console.log('💾 Stored user data (Google)');
        }

        setAuthState(prev => ({
          ...prev,
          isAuthenticated: true,
          user: result.user,
          isLoading: false,
        }));

        return {
          success: true,
          message: 'Google sign-in successful',
        };
      } else {
        setAuthState(prev => ({ ...prev, isLoading: false }));
        return {
          success: false,
          requires2FA: result.requires2FA,
          authMethod: result.authMethod,
          message: result.message || 'Google sign-in failed',
        };
      }

    } catch (error) {
      console.error('Google sign-in error:', error);
      setAuthState(prev => ({ ...prev, isLoading: false }));
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Google sign-in failed',
      };
    }
  }, []);

  // ==================== 2FA METHODS ====================

  const requestOTP = useCallback(async (phoneNumber: string, countryCode: string = 'US') => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/mobile/auth/request-otp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Platform': 'mobile',
        },
        body: JSON.stringify({
          phoneNumber,
          countryCode,
          purpose: 'verification',
        }),
      });

      const result = await response.json();
      return {
        success: result.success,
        message: result.message,
        testOtp: result.testOtp, // For development/test numbers
      };
    } catch (error) {
      console.error('OTP request error:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to send OTP',
      };
    }
  }, []);

  const verifyOTP = useCallback(async (phoneNumber: string, otpCode: string) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/mobile/auth/verify-otp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Platform': 'mobile',
        },
        body: JSON.stringify({
          phoneNumber,
          otpCode,
        }),
      });

      const result = await response.json();
      return {
        success: result.success,
        message: result.message,
      };
    } catch (error) {
      console.error('OTP verification error:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to verify OTP',
      };
    }
  }, []);

  const loginWithPhone = useCallback(async (phoneNumber: string, password: string) => {
    try {
      const deviceFingerprint = await deviceSecurityService.generateDeviceFingerprint();
      
      const response = await fetch(`${API_BASE_URL}/api/v1/mobile/auth/login-with-phone`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Platform': 'mobile',
        },
        credentials: 'include',
        body: JSON.stringify({
          phoneNumber,
          password,
          deviceInfo: {
            fingerprint: deviceFingerprint,
          },
        }),
      });

      const result = await response.json();

      if (result.success) {
        await deviceSecurityService.resetFailedAttempts();
        await deviceSecurityService.setLastLoginData({
          timestamp: new Date().toISOString(),
          authMethod: 'password',
          email: credentials.username,
        });

        // Store authentication token and user data
        await persistMobileAuthTokens({
          token: result.token || 'session_token',
          access_token: result.access_token ?? result.token,
          refresh_token: result.refresh_token,
        });
        if (result.token) {
          console.log('💾 Stored authentication token (phone)');
        } else {
          console.log('💾 Stored fallback session_token (phone)');
        }

        if (result.user) {
          await secureStorage.setItem(STORAGE_KEYS.USER_DATA, JSON.stringify(result.user));
          console.log('💾 Stored user data (phone)');
        }

        setAuthState(prev => ({
          ...prev,
          isAuthenticated: true,
          user: result.user,
        }));

        return {
          success: true,
          message: 'Phone login successful',
        };
      } else {
        await deviceSecurityService.incrementFailedAttempts();
        return {
          success: false,
          message: result.message || 'Phone login failed',
        };
      }

    } catch (error) {
      console.error('Phone login error:', error);
      await deviceSecurityService.incrementFailedAttempts();
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Phone login failed',
      };
    }
  }, []);

  // ==================== SIGNUP ====================
  // Uses web signup endpoint (/api/v1/web/signup), then mobile login to get token/user

  const signup = useCallback(async (data: { username: string; email: string; password: string; firstName?: string; lastName?: string }) => {
    try {
      setAuthState(prev => ({ ...prev, isLoading: true }));

      const signupBody = {
        username: data.username,
        email: data.email,
        password: data.password,
        firstName: (data.firstName && data.firstName.trim()) ? data.firstName.trim() : 'Mobile',
        lastName: (data.lastName && data.lastName.trim()) ? data.lastName.trim() : 'User',
      };

      const signupRes = await fetch(`${API_BASE_URL}/api/v1/web/signup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Platform': 'mobile',
        },
        credentials: 'include',
        body: JSON.stringify(signupBody),
      });

      let signupResult: { success?: boolean; message?: string };
      const contentType = signupRes.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        signupResult = await signupRes.json();
      } else {
        const text = await signupRes.text();
        console.error('Signup response was not JSON:', text?.slice(0, 200));
        setAuthState(prev => ({ ...prev, isLoading: false }));
        return {
          success: false,
          message: signupRes.ok ? 'Invalid server response' : `Signup failed (${signupRes.status})`,
        };
      }

      if (!signupRes.ok || !signupResult.success) {
        setAuthState(prev => ({ ...prev, isLoading: false }));
        return {
          success: false,
          message: signupResult.message || 'Signup failed',
        };
      }

      // Account created; log in via mobile endpoint to get token and user
      const loginRes = await fetch(`${API_BASE_URL}/api/v1/mobile/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Platform': 'mobile',
        },
        credentials: 'include',
        body: JSON.stringify({
          username: data.username,
          password: data.password,
        }),
      });

      if (!loginRes.ok) {
        setAuthState(prev => ({ ...prev, isLoading: false }));
        return {
          success: true,
          message: 'Account created. Please sign in.',
        };
      }

      const loginContentType = loginRes.headers.get('content-type');
      if (!loginContentType || !loginContentType.includes('application/json')) {
        setAuthState(prev => ({ ...prev, isLoading: false }));
        return {
          success: true,
          message: 'Account created. Please sign in.',
        };
      }

      const loginResult = await loginRes.json();
      if (loginResult.requires2FA) {
        setAuthState(prev => ({ ...prev, isLoading: false }));
        return {
          success: true,
          message: 'Account created. Please complete sign-in with the verification code sent to you.',
        };
      }

      if (loginResult.success && (loginResult.token || loginResult.user)) {
        if (loginResult.user) {
          const u = loginResult.user;
          await secureStorage.setItem(STORAGE_KEYS.USER_DATA, JSON.stringify(u));
          const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || u.email || '';
          console.log('💾 Stored user data (signup)');
          // Use setUserFromExternal so the auth context is updated directly without
          // re-calling checkAuth. Calling refreshSession() here was racing against the
          // newly created session: if checkAuth returned an error (timing / cookie not yet
          // established) forceReset() would wipe the freshly stored credentials and leave
          // the user on a blank screen even though signup was successful.
          try {
            await authContext.setUserFromExternal(
              {
                id: String(u.id),
                email: u.email || '',
                name,
                first_name: u.first_name ?? u.firstName ?? undefined,
                last_name: u.last_name ?? u.lastName ?? undefined,
                username: typeof u.username === 'string' ? u.username : undefined,
              },
              typeof loginResult.token === 'string' ? loginResult.token : undefined,
            );
          } catch (_) {}
        }
        setAuthState(prev => ({
          ...prev,
          isAuthenticated: true,
          user: loginResult.user ?? undefined,
          isLoading: false,
        }));
        return {
          success: true,
          message: 'Account created successfully',
        };
      }

      setAuthState(prev => ({ ...prev, isLoading: false }));
      return {
        success: true,
        message: 'Account created. Please sign in.',
      };
    } catch (error) {
      console.error('Signup error:', error);
      setAuthState(prev => ({ ...prev, isLoading: false }));
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Signup failed',
      };
    }
  }, []);

  // ==================== LOGOUT ====================

  const logout = useCallback(async () => {
    try {
      await fetch(`${API_BASE_URL}/api/v1/mobile/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Platform': 'mobile',
        },
        credentials: 'include',
      });

      // Clear Google auth if used
      await googleAuthService.signOut();

      // Clear stored authentication data
      try {
        await clearMobileAuthTokens();
        await secureStorage.removeItem(STORAGE_KEYS.USER_DATA);
        await secureStorage.removeItem(STORAGE_KEYS.DEVICE_TOKEN);
        console.log('💾 Cleared authentication data and device token');
      } catch (error) {
        console.warn('Failed to clear auth data:', error);
      }

      setAuthState({
        isAuthenticated: false,
        user: null,
        isLoading: false,
        deviceFingerprint: authState.deviceFingerprint,
        userPreferences: authState.userPreferences,
        lastRiskScore: 0,
      });

      console.log('Logout successful');
    } catch (error) {
      console.error('Logout error:', error);
    }
  }, [authState.deviceFingerprint, authState.userPreferences]);

  // ==================== DEVICE MANAGEMENT ====================

  const updateUserPreferences = useCallback(async (prefs: User2FAPreferences) => {
    try {
      await deviceSecurityService.setUserPreferences(prefs);
      setAuthState(prev => ({
        ...prev,
        userPreferences: prefs,
      }));
    } catch (error) {
      console.error('Failed to update preferences:', error);
      throw error;
    }
  }, []);

  const revokeDeviceTrust = useCallback(async () => {
    try {
      await deviceSecurityService.revokeDeviceTrust();
      console.log('Device trust revoked');
    } catch (error) {
      console.error('Failed to revoke device trust:', error);
      throw error;
    }
  }, []);

  const getSecurityStatus = useCallback(async () => {
    return await deviceSecurityService.getDeviceSecurityStatus();
  }, []);

  const refreshAuth = useCallback(async () => {
    await initializeAuth();
  }, [initializeAuth]);

  const calculateCurrentRiskScore = useCallback(async () => {
    const riskScore = await deviceSecurityService.calculateRiskScore();
    setAuthState(prev => ({ ...prev, lastRiskScore: riskScore }));
    return riskScore;
  }, []);

  // ==================== CONTEXT VALUE ====================

  const contextValue: Enhanced2FAContextType = {
    // Auth state
    isAuthenticated: authState.isAuthenticated,
    user: authState.user,
    isLoading: authState.isLoading,
    
    // Device security
    deviceFingerprint: authState.deviceFingerprint,
    userPreferences: authState.userPreferences,
    lastRiskScore: authState.lastRiskScore,
    
    // Authentication methods
    login,
    loginWithBiometric,
    signInWithGoogle,
    signup,
    logout,
    
    // 2FA methods
    requestOTP,
    verifyOTP,
    loginWithPhone,
    
    // Device management
    updateUserPreferences,
    revokeDeviceTrust,
    getSecurityStatus,
    
    // Utility
    refreshAuth,
    calculateCurrentRiskScore,
  };

  return (
    <Enhanced2FAAuthContext.Provider value={contextValue}>
      {children}
    </Enhanced2FAAuthContext.Provider>
  );
}

// ==================== HOOK ====================

export function useEnhanced2FAAuth() {
  const context = useContext(Enhanced2FAAuthContext);
  if (context === undefined) {
    throw new Error('useEnhanced2FAAuth must be used within an Enhanced2FAAuthProvider');
  }
  return context;
}

// Export types
export type {
    AuthState, Enhanced2FAContextType, Enhanced2FAUser, LoginCredentials
};


import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Linking } from 'react-native';
import { STORAGE_KEYS } from '../../constants/Config';
import { persistMobileAuthTokens } from '../../utils/authTokenStorage';
import { apiService } from '../../services/api';
import {
    extractDefaultHomePathFromUser,
    persistDefaultHomeWebPath,
    reconcilePersistenceWithServerNoDefault,
    refreshDefaultHomePathFromWebAuthCheck,
} from '../../utils/defaultHomePath';
import { exchangeGoogleLoginToken, parseLoginSuccessToken } from '../../utils/googleOAuthDeepLink';
import { secureStorage } from '../../utils/storage';

interface User {
  id: string;
  email: string;
  name: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string, remember?: boolean) => Promise<void>;
  signUp: (email: string, password: string, name: string) => Promise<void>;
  signOut: () => Promise<void>;
  forceReset: () => Promise<void>;
  loadRememberedCredentials: () => Promise<{ email: string; password: string; remember: boolean } | null>;
  refreshSession: () => Promise<void>;
  /** Directly set authenticated user from external providers (Apple, Google) without calling checkAuth. */
  setUserFromExternal: (userData: User, token?: string, refreshToken?: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Using real API - no mock authentication needed

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const prevUserIdRef = useRef<string | null>(null);

  // Purge in-memory caches when switching accounts without a full logout cycle.
  useEffect(() => {
    const nextId = user?.id ?? null;
    const prevId = prevUserIdRef.current;
    if (prevId && nextId && prevId !== nextId) {
      void (async () => {
        try {
          const { clearAllUserScopedCaches } = await import('../../services/userScopedCache');
          const { clearMeetingAssetsCache } = await import('../../services/api');
          await clearAllUserScopedCaches();
          clearMeetingAssetsCache();
        } catch {
          // non-fatal
        }
      })();
    }
    prevUserIdRef.current = nextId;
  }, [user?.id]);

  useEffect(() => {
    // Check for existing session
    checkSession();
  }, []); // Empty dependency array ensures this only runs once

  // Handle Google OAuth backend redirect: grabdocs://login-success?code=... or grabdocs://login-error?...
  // Uses setUserFromExternal (defined below) so storage + React state are set in one consistent call,
  // matching the Apple sign-in path. Safe to reference here because this function is only called
  // from useEffect/Linking listeners, well after all const declarations are initialised.
  const handleOAuthDeepLink = async (url: string) => {
    if (!url || !url.startsWith('grabdocs://')) return;
    try {
      const parsed = new URL(url);
      const loginToken = parseLoginSuccessToken(url);
      if (loginToken) {
        const exchanged = await exchangeGoogleLoginToken(loginToken);
        if (exchanged) {
          await setUserFromExternal(exchanged.user, exchanged.jwt, exchanged.refreshToken);
          try {
            const deviceSecurityService = (await import('../../services/deviceSecurity')).default;
            await deviceSecurityService.setLastLoginData({
              timestamp: new Date().toISOString(),
              authMethod: 'google',
            });
            await deviceSecurityService.disableBiometricLoginPreference();
          } catch {
            /* non-fatal */
          }
          console.log('✅ Google OAuth deep link: session established');
        }
      } else if (parsed.hostname === 'login-error') {
        const error = parsed.searchParams.get('error') || 'Unknown error';
        const description = parsed.searchParams.get('description') || '';
        console.warn('Google OAuth deep link error:', error, description);
      }
    } catch (e) {
      console.warn('Error handling OAuth deep link:', e);
    }
  };

  useEffect(() => {
    const sub = Linking.addEventListener('url', ({ url }) => handleOAuthDeepLink(url));
    Linking.getInitialURL().then((url) => {
      if (url) handleOAuthDeepLink(url);
    });
    return () => sub.remove();
  }, []);

  const checkSession = async () => {
    try {
      const userData = await secureStorage.getItem('user');
      if (userData) {
        // Verify session with backend before setting user
        try {
          const response = await apiService.checkAuth();
          if (response.success) {
            // Some auth-check responses return success without a data envelope.
            // Prefer backend user payload when present, otherwise keep stored user.
            const parsedUser = JSON.parse(userData);
            const backendUser = (response as any).user || (response as any).data?.user || null;
            const fromCheck = extractDefaultHomePathFromUser(backendUser);
            if (fromCheck === undefined) {
              void refreshDefaultHomePathFromWebAuthCheck();
            } else if (fromCheck === null) {
              await reconcilePersistenceWithServerNoDefault();
            } else {
              await persistDefaultHomeWebPath(fromCheck);
            }
            if (backendUser?.id) {
              const fullName = `${backendUser.first_name || backendUser.firstName || ''} ${backendUser.last_name || backendUser.lastName || ''}`.trim();
              const displayName = fullName || backendUser.name || backendUser.username || backendUser.email || parsedUser?.name || '';
              const normalizedUser = {
                id: String(backendUser.id),
                email: backendUser.email || backendUser.username || parsedUser?.email || '',
                name: displayName,
                first_name: backendUser.first_name ?? backendUser.firstName ?? parsedUser?.first_name,
                last_name: backendUser.last_name ?? backendUser.lastName ?? parsedUser?.last_name,
                username: backendUser.username ?? parsedUser?.username,
              };
              await secureStorage.setItem('user', JSON.stringify(normalizedUser));
              setUser(normalizedUser);
            } else {
              setUser(parsedUser);
            }
          } else {
            // Explicit unauthenticated response from backend
            await forceReset();
          }
        } catch (error) {
          // Network / transient failures must NOT wipe a logged-in session.
          // Meeting heartbeat/leave 401s used to clear the token; keep local user so
          // join/leave never drops users onto a Sign In wall.
          console.warn('⚠️ Auth check failed; keeping stored session:', error);
          try {
            setUser(JSON.parse(userData));
          } catch {
            await forceReset();
          }
        }
      }
    } catch (error) {
      console.error('Error checking session:', error);
      // Only wipe if we cannot even read stored user
      try {
        const fallback = await secureStorage.getItem('user');
        if (fallback) {
          setUser(JSON.parse(fallback));
        } else {
          await forceReset();
        }
      } catch {
        await forceReset();
      }
    } finally {
      setLoading(false);
    }
  };

  const forceReset = async () => {
      console.log('🧹 Performing complete authentication reset');
      
      try {
        const { clearAllPendingCalendarCreates } = await import('../../utils/calendarPendingCreates');
        const { clearCalendarOfflineOnLogout } = await import('../../utils/calendarCache');
        const { clearAllUserScopedCaches } = await import('../../services/userScopedCache');
        const { clearMeetingAssetsCache } = await import('../../services/api');
        await clearAllPendingCalendarCreates();
        await clearCalendarOfflineOnLogout();
        await clearAllUserScopedCaches();
        clearMeetingAssetsCache();
      } catch (calErr) {
        console.warn('Calendar local clear on logout:', calErr);
      }
      
      // Clear user state immediately
    setUser(null);
    
    // Clear all possible storage locations
    const storageKeys = [
      'user',
      'auth_token',
      'refresh_token',
      'session_id',
      'auth-storage', // Zustand persistence
      'user_data',
      'authentication',
      'login_data',
      'device_token', // Clear device token
    ];
    
    try {
      // Clear SecureStore
      for (const key of storageKeys) {
        try {
          await secureStorage.removeItem(key);
        } catch (error) {
          console.warn(`Failed to clear SecureStore key: ${key}`, error);
        }
      }
      
      // Clear AsyncStorage 
      for (const key of storageKeys) {
        try {
          await AsyncStorage.removeItem(key);
        } catch (error) {
          console.warn(`Failed to clear AsyncStorage key: ${key}`, error);
        }
      }

      try {
        await AsyncStorage.removeItem(STORAGE_KEYS.DEFAULT_HOME_WEB_PATH);
      } catch (e) {
        console.warn('Failed to clear default home preference', e);
      }
      
      console.log('✅ Complete storage reset completed');
    } catch (error) {
      console.error('❌ Error during force reset:', error);
    }
  };

  useEffect(() => {
    apiService.setOnSessionExpired(() => {
      forceReset();
    });
  }, []);

  const signIn = async (email: string, password: string, remember: boolean = false) => {
    try {
      // Do NOT set loading=true here: it would unmount the entire app (AuthWrapper returns null)
      // and the sign-in screen would remount with lost state, so the user wouldn't see the error.
      // The sign-in screen uses its own loading state for the button.
      const trimmedEmail = (email ?? '').trim();
      const trimmedPassword = (password ?? '').trim();
      // Use real API only - no fallback
      const response = await apiService.login({
        username: trimmedEmail, // API expects username, not email
        password: trimmedPassword,
      });
      
      console.log('🔍 Full API response in auth:', JSON.stringify(response, null, 2));
      console.log('🔍 Response success:', response.success);
      console.log('🔍 Response requires2FA:', (response as any).requires2FA);
      console.log('🔍 Response user:', response.user);
      console.log('🔍 Response session_info:', response.session_info);
      
      // Check if 2FA is required (even if success is true, backend may require OTP verification)
      if ((response as any).requires2FA) {
        console.log('🔐 2FA required - throwing error to trigger OTP flow');
        const error: any = new Error((response as any).message || 'Please verify the code sent to your device');
        error.requires2FA = true;
        error.user = (response as any).user;
        error.preferredAuthMethod = (response as any).preferredAuthMethod;
        error.identifier = (response as any).identifier;
        throw error;
      }
      
      if (response.success) {
        // Store credentials if remember is enabled (store trimmed values)
        if (remember) {
          console.log('💾 Storing login credentials for remember functionality');
          await secureStorage.setItem('remembered_email', trimmedEmail);
          await secureStorage.setItem('remembered_password', trimmedPassword);
          await secureStorage.setItem('remember_enabled', 'true');
        } else {
          // Clear remembered credentials if remember is disabled
          await secureStorage.removeItem('remembered_email');
          await secureStorage.removeItem('remembered_password');
          await secureStorage.removeItem('remember_enabled');
        }
        
        // Case 1: Direct user data in response (older API format)
        if (response.user) {
          console.log('✅ Using direct user data from response');
          
          // Create a proper name from the user data
          const fullName = `${response.user.first_name || ''} ${response.user.last_name || ''}`.trim();
          const displayName = fullName || response.user.username || response.user.email || email;
          
          const localUser: User = {
            id: response.user.id.toString(),
            email: response.user.email || email,
            name: displayName,
            first_name: (response.user as any).first_name ?? undefined,
            last_name: (response.user as any).last_name ?? undefined,
            username: (response.user as any).username ?? undefined,
          };
          
          console.log('💾 Storing user data:', localUser);
          await secureStorage.setItem('user', JSON.stringify(localUser));
          if (response.token) {
            await secureStorage.setItem('auth_token', response.token);
          } else {
            await secureStorage.removeItem('auth_token');
          }
          const dhLogin = extractDefaultHomePathFromUser(response.user as any);
          if (dhLogin === undefined) {
            void refreshDefaultHomePathFromWebAuthCheck();
          } else if (dhLogin === null) {
            await reconcilePersistenceWithServerNoDefault();
          } else {
            await persistDefaultHomeWebPath(dhLogin);
          }
          setUser(localUser);
          console.log('✅ Sign in successful for:', localUser.name);
          try {
            const deviceSecurityService = (await import('../../services/deviceSecurity')).default;
            await deviceSecurityService.setLastLoginData({
              timestamp: new Date().toISOString(),
              authMethod: 'password',
            });
          } catch {
            /* non-fatal */
          }
          return;
        }
        
        // Case 2: Session info format (current backend response)
        if (response.session_info && response.session_info.user_id) {
          console.log('✅ Using session_info - creating user from login data');
          
          // Create user object from the login info we have
          const localUser = {
            id: response.session_info.user_id.toString(),
            email: email, // Use the login email/username
            name: email, // Use email as display name for now (can be updated later)
          };
          
          console.log('💾 Storing user data:', localUser);
          await secureStorage.setItem('user', JSON.stringify(localUser));
          await secureStorage.removeItem('auth_token');
          void refreshDefaultHomePathFromWebAuthCheck();
          setUser(localUser);
          console.log('✅ Sign in successful with session info for:', localUser.name);
          return;
        }
        
        console.error('❌ Login successful but no user data or session info received');
        throw new Error('Login successful but no user data received');
      } else {
        // Login failed - ensure user state is cleared
        setUser(null);
        throw new Error(response.message || 'Login failed');
      }
    } catch (error) {
      console.error('❌ Sign in failed:', error);
      // Ensure user state is cleared on any error so we never redirect to home
      setUser(null);
      throw error;
    }
    // Note: no finally { setLoading(false) } here — signIn intentionally never sets loading=true
    // (doing so would unmount the entire app via AuthWrapper and destroy sign-in screen state).
  };

  const signUp = async (email: string, password: string, name: string) => {
    try {
      setLoading(true);
      
      // Use real API for signup
      const [firstName, ...lastNameParts] = name.split(' ');
      const lastName = lastNameParts.join(' ') || '';
      
      const response = await apiService.signup({
        username: email, // Using email as username
        email,
        password,
        first_name: firstName,
        last_name: lastName,
      });
      
      if (response.success) {
        // After successful signup, we could auto-login or require manual login
        // For now, let's require manual login for security
        throw new Error('Signup successful! Please log in with your credentials.');
      } else {
        throw new Error(response.message || 'Signup failed');
      }
    } catch (error) {
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const signOut = async () => {
    try {
      console.log('🔄 signOut function called');
      console.log('🔍 Current user before logout:', user);
      setLoading(true);
      console.log('🔄 Starting sign out process...');
      
      // Grab the current device's Expo push token (if any) so the backend can
      // unregister ONLY this device. Without this, notifications intended for
      // the now-logged-out user would keep arriving on this device after
      // someone else logs in (cross-account push leak).
      let currentPushToken: string | null = null;
      try {
        const { pushNotificationService } = await import('../services/pushNotifications');
        currentPushToken = pushNotificationService.getPushToken();
      } catch (tokenErr) {
        console.warn('⚠️ Could not read current push token before logout:', tokenErr);
      }

      // Call backend logout API
      try {
        console.log('📡 Calling backend logout API...');
        await apiService.logout(currentPushToken);
        console.log('✅ Successfully logged out from backend');
      } catch (apiError) {
        console.warn('⚠️ Backend logout failed, continuing with local logout:', apiError);
      }
      
      // Clear user state FIRST
      console.log('🧹 Clearing user state...');
      setUser(null);
      console.log('✅ User state set to null');
      
      // Small delay to ensure state propagation
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Then perform complete reset
      console.log('🧹 Clearing all local storage...');
      await forceReset();
      
      console.log('✅ Sign out completed - user should be null:', user);
      
    } catch (error) {
      console.error('❌ Error during sign out:', error);
      // Force reset even if there are errors
      setUser(null);
      await forceReset();
    } finally {
      setLoading(false);
      console.log('🔄 signOut loading set to false');
      console.log('🔍 Final user state after logout:', user);
    }
  };

  const loadRememberedCredentials = async () => {
    try {
      const rememberEnabled = await secureStorage.getItem('remember_enabled');
      if (rememberEnabled === 'true') {
        const email = await secureStorage.getItem('remembered_email');
        const password = await secureStorage.getItem('remembered_password');
        
        if (email && password) {
          console.log('🔐 Loaded remembered credentials for:', email);
          return { email, password, remember: true };
        }
      }
      return null;
    } catch (error) {
      console.error('Error loading remembered credentials:', error);
      return null;
    }
  };

  // Method to refresh session (useful after external auth like Apple/Google)
  const refreshSession = async () => {
    await checkSession();
  };

  // Directly establishes an authenticated session from an external provider (Apple, Google).
  // Bypasses checkAuth so a missing or cookie-only session cannot bounce the user back to login.
  const setUserFromExternal = async (userData: User, token?: string, refreshToken?: string) => {
    try {
      // Only touch token storage when caller explicitly passes token/refresh;
      // undefined must not clear a JWT already persisted by loginWithPhone.
      if (token !== undefined || refreshToken !== undefined) {
        await persistMobileAuthTokens({
          ...(token !== undefined ? { token: token || null } : {}),
          ...(refreshToken !== undefined ? { refresh_token: refreshToken || null } : {}),
        });
      }
      await secureStorage.setItem('user', JSON.stringify(userData));
      setUser(userData);
      void (async () => {
        const dh = extractDefaultHomePathFromUser(userData as any);
        if (dh === undefined) {
          await refreshDefaultHomePathFromWebAuthCheck();
        } else if (dh === null) {
          await reconcilePersistenceWithServerNoDefault();
        } else {
          await persistDefaultHomeWebPath(dh);
        }
      })();
      console.log('✅ setUserFromExternal: session established for', userData.email);
    } catch (error) {
      console.error('❌ setUserFromExternal failed:', error);
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signUp, signOut, forceReset, loadRememberedCredentials, refreshSession, setUserFromExternal }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

// Default export for Expo Router compatibility
export default AuthProvider; 
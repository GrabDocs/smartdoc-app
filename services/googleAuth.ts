import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import {
  API_BASE_URL,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_ID_IOS,
  GOOGLE_CLIENT_ID_WEB,
} from '../constants/Config';
import {
  createLoginSuccessDeepLinkCapture,
  parseLoginSuccessToken,
} from '../utils/googleOAuthDeepLink';
import { deviceSecurityService } from './deviceSecurity';

// Google OAuth configuration
interface GoogleAuthConfig {
  clientId: string;
  redirectUri: string;
  scopes: string[];
}

interface GoogleUserInfo {
  id: string;
  email: string;
  name: string;
  given_name: string;
  family_name: string;
  picture: string;
  verified_email: boolean;
}

interface GoogleAuthResult {
  success: boolean;
  user?: GoogleUserInfo;
  accessToken?: string;
  idToken?: string;
  error?: string;
  /** True when native app opened backend OAuth URL via openAuthSessionAsync; loginToken contains the session token to exchange. */
  completedViaDeepLink?: boolean;
  /** Session token extracted from the grabdocs://login-success redirect; exchange for a JWT via /api/v1/web/oauth/exchange-token. */
  loginToken?: string;
  /** True when the native Google Sign-In SDK completed in-session (Android); idToken is sent to the backend to establish a session. */
  completedViaNativeSignIn?: boolean;
  /** Server auth code from the native SDK (offlineAccess) — optional; backend may use it for refresh tokens. */
  serverAuthCode?: string;
}

interface MobileGoogleLoginResponse {
  success: boolean;
  message: string;
  user?: any;
  token?: string;
  requires2FA?: boolean;
  deviceTrusted?: boolean;
  deviceName?: string;
}

type GoogleSignInNativeModule = typeof import('@react-native-google-signin/google-signin');

/** Loaded on demand on Android only — top-level import crashes iOS/Expo Go when native module is absent. */
let nativeGoogleSignInModule: GoogleSignInNativeModule | null | undefined;

async function loadNativeGoogleSignIn(): Promise<GoogleSignInNativeModule | null> {
  if (Platform.OS !== 'android') return null;
  if (nativeGoogleSignInModule !== undefined) {
    return nativeGoogleSignInModule;
  }
  try {
    nativeGoogleSignInModule = await import('@react-native-google-signin/google-signin');
    return nativeGoogleSignInModule;
  } catch (error) {
    console.warn(
      'Native Google Sign-In unavailable; falling back to browser OAuth flow:',
      error
    );
    nativeGoogleSignInModule = null;
    return null;
  }
}

class GoogleAuthService {
  private config: GoogleAuthConfig;
  private request: AuthSession.AuthRequest | null = null;
  private discovery: AuthSession.DiscoveryDocument | null = null;

  constructor() {
    // Determine redirect URI based on environment.
    // CRITICAL: Google Web OAuth clients do NOT accept custom schemes (grabdocs://). We always
    // use the backend HTTPS callback for native (Android/iOS); the backend redirects to
    // grabdocs://login-success so the app receives the token via deep link.
    // Add this exact URI in Google Cloud Console → Credentials → Authorized redirect URIs:
    // https://api.grabdocs.com/api/v1/web/auth/callback
    const backendCallbackUrl = `${API_BASE_URL}/api/v1/web/auth/callback`;
    let redirectUri: string;

    // Allow explicit override from env only if it is https (never use custom scheme for Google)
    const envRedirectUri = process.env.EXPO_PUBLIC_GOOGLE_REDIRECT_URI?.trim();
    if (envRedirectUri && envRedirectUri.startsWith('https://')) {
      redirectUri = envRedirectUri;
    } else if (Platform.OS === 'web') {
      // Web: use current origin so Google accepts it (must be https or http with valid domain)
      redirectUri = AuthSession.makeRedirectUri({
        path: 'auth/callback',
      });
      // If makeRedirectUri returned a custom scheme (e.g. in Expo webview), use backend instead
      if (!redirectUri || redirectUri.startsWith('grabdocs://')) {
        redirectUri = backendCallbackUrl;
      }
    } else {
      // Native (Android/iOS): always use backend HTTPS callback — never grabdocs:// (Google rejects it).
      redirectUri = backendCallbackUrl;
    }

    // Final safeguard: Google rejects custom schemes; never send grabdocs://
    if (redirectUri.startsWith('grabdocs://')) {
      console.warn('Google Auth: redirect_uri was custom scheme, overriding to backend HTTPS');
      redirectUri = backendCallbackUrl;
    }

    // Initialize configuration
    this.config = {
      clientId: GOOGLE_CLIENT_ID || process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID || '', // Will be set from environment or config
      redirectUri,
      scopes: ['openid', 'profile', 'email'],
    };

    // Log so you can verify in Google Console: same client ID must have this redirect URI
    // Only initialize on client-side (avoid SSR issues)
    if (Platform.OS !== 'web' || typeof window !== 'undefined') {
      this.initializeAuth();
    }
  }

  private async initializeAuth() {
    try {
      // Only proceed if we're in a proper client environment
      if (Platform.OS === 'web' && typeof window === 'undefined') {
        return;
      }

      // Set up WebBrowser for better UX
      WebBrowser.maybeCompleteAuthSession();

      // Create discovery document
      this.discovery = await AuthSession.fetchDiscoveryAsync(
        'https://accounts.google.com'
      );

      // Create auth request
      this.request = new AuthSession.AuthRequest({
        clientId: this.config.clientId,
        scopes: this.config.scopes,
        redirectUri: this.config.redirectUri,
        responseType: AuthSession.ResponseType.Code,
        extraParams: {
          access_type: 'offline',
          // Always show the account chooser so users can switch Gmail accounts after logout.
          prompt: 'select_account',
        },
      });
    } catch (error) {
      console.error('Failed to initialize Google Auth:', error);
    }
  }

  // ==================== GOOGLE SIGN-IN FLOW ====================

  private googleSigninConfigured = false;

  /** Configure the native Google Sign-In SDK once. webClientId is required to receive an idToken. */
  private ensureGoogleSigninConfigured(mod: GoogleSignInNativeModule): void {
    if (this.googleSigninConfigured) return;
    mod.GoogleSignin.configure({
      webClientId: GOOGLE_CLIENT_ID_WEB,
      iosClientId: GOOGLE_CLIENT_ID_IOS || undefined,
      offlineAccess: true, // returns serverAuthCode so the backend can obtain a refresh token if needed
      scopes: ['openid', 'profile', 'email'],
    });
    this.googleSigninConfigured = true;
  }

  /**
   * Android: native Google Sign-In SDK. Opens the native account-picker dialog and returns an
   * idToken in-session — no browser, no grabdocs:// deep link, so the post-login navigation race
   * that stranded Android users on /notifications cannot happen. The idToken is sent to the backend
   * (apiService.googleSignInWithIdToken) to establish the session.
   */
  private async signInWithGoogleNativeSdk(): Promise<GoogleAuthResult> {
    const mod = await loadNativeGoogleSignIn();
    if (!mod) {
      return this.signInWithGoogleNativeBackendFlow();
    }

    const { GoogleSignin, isSuccessResponse, isErrorWithCode, statusCodes } = mod;

    try {
      this.ensureGoogleSigninConfigured(mod);
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });

      // Clear prior Google Sign-In association so the account picker appears
      // (e.g. after GrabDocs logout, or when switching Gmail accounts).
      // Does not revoke app access and does not sign out of Google on the device.
      try {
        await GoogleSignin.signOut();
      } catch {
        /* ignore — may not have been signed in */
      }

      const response = await GoogleSignin.signIn();
      if (!isSuccessResponse(response)) {
        // User dismissed the native dialog.
        return { success: false, error: 'User cancelled' };
      }

      const { idToken, serverAuthCode, user } = response.data;
      if (!idToken) {
        return { success: false, error: 'No ID token returned from Google' };
      }

      return {
        success: true,
        completedViaNativeSignIn: true,
        idToken,
        serverAuthCode: serverAuthCode ?? undefined,
        user: {
          id: user.id,
          email: user.email,
          name: user.name ?? '',
          given_name: user.givenName ?? '',
          family_name: user.familyName ?? '',
          picture: user.photo ?? '',
          verified_email: true,
        },
      };
    } catch (error) {
      if (isErrorWithCode(error)) {
        if (error.code === statusCodes.SIGN_IN_CANCELLED) {
          return { success: false, error: 'User cancelled' };
        }
        if (error.code === statusCodes.IN_PROGRESS) {
          return { success: false, error: 'Sign-in already in progress' };
        }
        if (error.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
          return { success: false, error: 'Google Play Services not available or outdated' };
        }
      }
      console.error('Native Google Sign-In error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Google sign-in failed',
      };
    }
  }

  /**
   * Native (Android/iOS): Use backend-issued auth URL (no PKCE) so the backend can exchange
   * the code. Opens the browser via openAuthSessionAsync which behaves differently per platform:
   *
   *  iOS  — uses ASWebAuthenticationSession: intercepts the grabdocs:// redirect internally
   *          and returns { type: 'success', url }. Linking event does NOT fire.
   *          → loginToken is extracted here; sign-in.tsx exchanges it inline (no race).
   *
   *  Android — uses Chrome Custom Tab: when grabdocs:// fires, the OS routes it to the app
   *            via intent (Linking event DOES fire) and the tab dismisses, returning
   *            { type: 'dismiss' }. loginToken is absent; sign-in.tsx watches user state.
   */
  private async signInWithGoogleNativeBackendFlow(): Promise<GoogleAuthResult> {
    const res = await fetch(`${API_BASE_URL}/api/v1/web/auth/google-url`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.url) {
      const err = data?.error || `Failed to get auth URL (${res.status})`;
      console.error('Google auth URL fetch failed:', err);
      return { success: false, error: err };
    }

    WebBrowser.maybeCompleteAuthSession();

    // Android: the grabdocs:// URL often fires before openAuthSessionAsync resolves.
    // Capture it during the session instead of relying on AuthContext's Linking listener.
    const deepLinkCapture = createLoginSuccessDeepLinkCapture();
    let browserResult: WebBrowser.WebBrowserAuthSessionResult;
    try {
      browserResult = await WebBrowser.openAuthSessionAsync(data.url, 'grabdocs://');
    } finally {
      deepLinkCapture.stop();
    }

    const resolveLoginToken = (url: string | null | undefined): string | null =>
      parseLoginSuccessToken(url);

    // iOS success path: ASWebAuthenticationSession intercepted the redirect URL directly.
    if (browserResult.type === 'success' && browserResult.url) {
      const loginToken = resolveLoginToken(browserResult.url);
      if (!loginToken) {
        return { success: false, error: 'No authentication token in redirect' };
      }
      return { success: true, completedViaDeepLink: true, loginToken };
    }

    // Android dismiss path: Chrome Custom Tab closed after deep link fired.
    // Token was captured by the listener active during the session.
    if (browserResult.type === 'dismiss') {
      const loginToken = resolveLoginToken(deepLinkCapture.getCapturedUrl());
      if (loginToken) {
        return { success: true, completedViaDeepLink: true, loginToken };
      }
      return { success: true, completedViaDeepLink: true };
    }

    // Explicit user cancel (both platforms) or unexpected failure.
    return { success: false, error: 'User cancelled' };
  }

  async signInWithGoogle(): Promise<GoogleAuthResult> {
    try {
      // Check if we're in a proper client environment
      if (Platform.OS === 'web' && typeof window === 'undefined') {
        return {
          success: false,
          error: 'Google OAuth is not available on server-side rendering',
        };
      }

      // Android: native Google Sign-In SDK (dialog from button, in-session idToken, no deep-link race).
      if (Platform.OS === 'android') {
        return this.signInWithGoogleNativeSdk();
      }

      // iOS: keep the working ASWebAuthenticationSession backend flow (intercepts the redirect in-session).
      if (Platform.OS === 'ios') {
        return this.signInWithGoogleNativeBackendFlow();
      }

      // Web: use AuthSession (PKCE); app receives code and exchanges it
      if (!this.config.clientId || this.config.clientId === '') {
        return {
          success: false,
          error: 'Google OAuth is not configured. Please set up Google OAuth credentials.',
        };
      }

      if (!this.request || !this.discovery) {
        await this.initializeAuth();
        if (!this.request || !this.discovery) {
          throw new Error('Google Auth initialization failed');
        }
      }

      console.log('Starting Google OAuth with redirect URI:', this.config.redirectUri);

      const result = await this.request.promptAsync(this.discovery);

      if (result.type === 'success') {
        const { code } = result.params;
        
        if (code) {
          const tokenResponse = await AuthSession.exchangeCodeAsync(
            {
              clientId: this.config.clientId,
              code,
              redirectUri: this.config.redirectUri,
              extraParams: {},
            },
            this.discovery
          );

          if (tokenResponse.accessToken) {
            const userInfo = await this.fetchGoogleUserInfo(tokenResponse.accessToken);
            if (userInfo) {
              return {
                success: true,
                user: userInfo,
                accessToken: tokenResponse.accessToken,
                idToken: tokenResponse.idToken || undefined,
              };
            }
          }
        }
      }

      return {
        success: false,
        error: result.type === 'cancel' ? 'User cancelled' : 'Authentication failed',
      };

    } catch (error) {
      console.error('Google Sign-In error:', error);
      if (error instanceof Error && error.message.includes('invalid_request')) {
        return {
          success: false,
          error: 'Google OAuth configuration error. The redirect URI is not properly configured. Please contact support.',
        };
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  private async fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo | null> {
    try {
      const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (response.ok) {
        const userInfo: GoogleUserInfo = await response.json();
        return userInfo;
      }

      console.error('Failed to fetch user info:', response.status, response.statusText);
      return null;
    } catch (error) {
      console.error('Error fetching Google user info:', error);
      return null;
    }
  }

  // ==================== BACKEND INTEGRATION ====================

  async loginWithGoogleToBackend(googleUser: GoogleUserInfo, accessToken: string): Promise<MobileGoogleLoginResponse> {
    try {
      // Get device fingerprint for security
      const deviceFingerprint = await deviceSecurityService.getDeviceFingerprint();
      const deviceTrust = await deviceSecurityService.getDeviceTrust();

      // Calculate risk score
      const riskScore = await deviceSecurityService.calculateRiskScore({
        isNewDevice: !deviceTrust,
        daysSinceLastLogin: 0, // Will be determined by backend
        failedAttempts: 0,
      });

      // Prepare login request
      const loginData = {
        googleId: googleUser.id,
        email: googleUser.email,
        name: googleUser.name,
        firstName: googleUser.given_name,
        lastName: googleUser.family_name,
        picture: googleUser.picture,
        accessToken,
        deviceInfo: {
          fingerprint: deviceFingerprint,
          trustLevel: deviceTrust?.trustLevel || 'unknown',
          riskScore,
        },
      };

      // Send request to mobile backend
      const response = await fetch(`${API_BASE_URL}/api/v1/mobile/auth/google-login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Platform': 'mobile',
        },
        credentials: 'include',
        body: JSON.stringify(loginData),
      });

      const result: MobileGoogleLoginResponse = await response.json();

      if (result.success) {
        // Update device trust if login successful
        if (result.deviceTrusted) {
          await deviceSecurityService.setDeviceTrust('trusted', 30);
        }

        // Reset failed attempts
        await deviceSecurityService.resetFailedAttempts();

        // Update last login data
        await deviceSecurityService.setLastLoginData({
          timestamp: new Date().toISOString(),
          authMethod: 'google',
        });
        await deviceSecurityService.disableBiometricLoginPreference();

        console.log('Google login successful:', result.message);
      } else {
        // Increment failed attempts
        await deviceSecurityService.incrementFailedAttempts();
        console.warn('Google login failed:', result.message);
      }

      return result;

    } catch (error) {
      console.error('Backend Google login error:', error);
      await deviceSecurityService.incrementFailedAttempts();
      
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Login failed',
      };
    }
  }

  // ==================== ENHANCED 2FA INTEGRATION ====================

  async signInWithGoogleEnhanced(): Promise<{
    success: boolean;
    user?: any;
    requires2FA?: boolean;
    authMethod?: string;
    message?: string;
    completedViaDeepLink?: boolean;
  }> {
    try {
      // Step 1: Google OAuth
      const googleResult = await this.signInWithGoogle();

      // Native backend flow: app opened backend URL; completion via grabdocs://login-success deep link
      if (googleResult.completedViaDeepLink) {
        return { success: true, completedViaDeepLink: true, message: 'Complete sign-in in the browser.' };
      }
      
      if (!googleResult.success || !googleResult.user) {
        return {
          success: false,
          message: googleResult.error || 'Google authentication failed',
        };
      }

      // Step 2: Risk Assessment
      const riskScore = await deviceSecurityService.calculateRiskScore();
      const userPrefs = await deviceSecurityService.getUserPreferences();
      const requiredAuthMethod = deviceSecurityService.determineRequiredAuthMethod(riskScore, userPrefs);

      console.log(`Risk score: ${riskScore}, Required auth: ${requiredAuthMethod}`);

      // Step 3: Enhanced Authentication
      if (requiredAuthMethod === 'BIOMETRIC_ONLY') {
        const biometricResult = await deviceSecurityService.authenticateWithBiometrics(
          'Verify your identity to complete Google sign-in'
        );

        if (!biometricResult.success) {
          return {
            success: false,
            message: 'Biometric authentication required',
            requires2FA: true,
            authMethod: 'BIOMETRIC',
          };
        }
      }

      // Step 4: Backend Login
      const backendResult = await this.loginWithGoogleToBackend(
        googleResult.user,
        googleResult.accessToken!
      );

      if (backendResult.success) {
        return {
          success: true,
          user: backendResult.user,
          message: 'Google sign-in successful',
        };
      }

      // Step 5: Handle 2FA requirement
      if (backendResult.requires2FA || requiredAuthMethod.includes('SMS')) {
        return {
          success: false,
          requires2FA: true,
          authMethod: 'SMS_2FA',
          message: 'Additional verification required',
        };
      }

      return {
        success: false,
        message: backendResult.message || 'Login failed',
      };

    } catch (error) {
      console.error('Enhanced Google sign-in error:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Sign-in failed',
      };
    }
  }

  // ==================== CONFIGURATION ====================

  setClientId(clientId: string): void {
    this.config.clientId = clientId;
    // Reinitialize with new client ID
    this.initializeAuth();
  }

  getRedirectUri(): string {
    return this.config.redirectUri;
  }

  // ==================== UTILITY METHODS ====================

  async signOut(): Promise<void> {
    try {
      // Clear any cached auth state
      this.request = null;

      // Sign out of the native SDK (Android) so the account picker is shown on next sign-in
      // and a different account can be chosen. No-op if never signed in natively.
      if (Platform.OS === 'android') {
        try {
          const mod = await loadNativeGoogleSignIn();
          if (mod) {
            this.ensureGoogleSigninConfigured(mod);
            await mod.GoogleSignin.signOut();
          }
        } catch (nativeErr) {
          console.warn('Native Google sign-out skipped:', nativeErr);
        }
      }

      console.log('Google sign-out completed');
    } catch (error) {
      console.error('Google sign-out error:', error);
    }
  }

  isConfigured(): boolean {
    return !!this.config.clientId;
  }

  // ==================== DEBUG METHODS ====================

  getAuthConfig(): GoogleAuthConfig {
    return { ...this.config };
  }

  async testGoogleConnection(): Promise<boolean> {
    try {
      if (!this.discovery) {
        await this.initializeAuth();
      }
      return !!this.discovery;
    } catch (error) {
      console.error('Google connection test failed:', error);
      return false;
    }
  }
}

// Export singleton instance
export const googleAuthService = new GoogleAuthService();
export default googleAuthService;

// Export types
export type {
    GoogleAuthConfig, GoogleAuthResult, GoogleUserInfo, MobileGoogleLoginResponse
};


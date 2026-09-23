import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import * as LocalAuthentication from 'expo-local-authentication';
import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
    Alert,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    StyleSheet,
    Switch,
    Text,
    TextInput,
    TouchableOpacity,
    View
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import { GoogleLogo } from '../../components/GoogleLogo';
import { Colors } from '../../constants/Colors';
import { API_BASE_URL } from '../../constants/Config';
import { useEnhanced2FAAuth } from '../../contexts/Enhanced2FAAuthContext';
import { useThemeColors } from '../../hooks/useThemeColors';
import { appleAuthService } from '../../services/appleAuth';
import { googleAuthService } from '../../services/googleAuth';
import deviceSecurityService from '../../services/deviceSecurity';
import { navigateTabsThenDefaultHome, resolveDefaultHomeWebPath } from '../../utils/defaultHomePath';
import { exchangeGoogleLoginToken } from '../../utils/googleOAuthDeepLink';
import { apiService } from '../../services/api';
import { secureStorage } from '../../utils/storage';
import { useAuth } from '../context/auth';

export default function SignInScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ email?: string; username?: string }>();
  const themeColorsHook = useThemeColors();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberDevice, setRememberDevice] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricType, setBiometricType] = useState('Biometric');
  const [needsOtp, setNeedsOtp] = useState(false);
  const [appleSignInAvailable, setAppleSignInAvailable] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [dataRightsConsent, setDataRightsConsent] = useState(false);
  const insets = useSafeAreaInsets();

  // Use regular auth for normal login, Enhanced2FA only for biometric
  // Note: We use local isSubmitting for the button so the screen doesn't unmount on login (auth loading would hide entire app)
  const { signIn, loading: authLoading, setUserFromExternal } = useAuth();
  const loading = authLoading || isSubmitting || googleLoading;
  const { loginWithBiometric } = useEnhanced2FAAuth();

  // Prefill from email-change success, last-login, or remembered email.
  useEffect(() => {
    const fromEmail = typeof params.email === 'string' ? params.email.trim() : '';
    const fromUsername = typeof params.username === 'string' ? params.username.trim() : '';
    const prefill = fromEmail || fromUsername;
    if (prefill) {
      setUsername(prefill);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const deviceSecurityService = (await import('../../services/deviceSecurity')).default;
        const lastEmail = await deviceSecurityService.getLastLoginEmail();
        if (!cancelled && lastEmail) {
          setUsername(lastEmail);
          return;
        }
        const remembered = await secureStorage.getItem('remembered_email');
        if (!cancelled && remembered) setUsername(remembered);
      } catch {
        // non-fatal
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.email, params.username]);

  // Check biometric availability on component mount
  useEffect(() => {
    checkBiometricAvailability();
    checkAppleSignInAvailability();
  }, []);

  const checkAppleSignInAvailability = async () => {
    if (Platform.OS === 'ios') {
      try {
        const available = await appleAuthService.isAvailableAsync();
        setAppleSignInAvailable(available);
      } catch (error) {
        console.error('Error checking Apple Sign In availability:', error);
        setAppleSignInAvailable(false);
      }
    }
  };

  const checkBiometricAvailability = async () => {
    try {
      // Disable biometric in Expo Go (development only)
      const isExpoGo = __DEV__ && !Constants.executionEnvironment || Constants.executionEnvironment === 'storeClient';
      if (isExpoGo) {
        setBiometricAvailable(false);
        return;
      }

      // Accept fingerprint/Face ID OR device PIN/passcode (same rules as deviceSecurityService).
      const config = await deviceSecurityService.initializeBiometrics();
      const deviceReady = config.enabled;

      // Only offer biometric when the last account used username/password
      // (SSO Google/Apple accounts cannot enroll biometric quick-login).
      const eligibleForLastUser = deviceReady
        ? await deviceSecurityService.isBiometricLoginEligibleForLastUser()
        : false;

      setBiometricAvailable(eligibleForLastUser);

      if (eligibleForLastUser) {
        const supportedTypes = config.types;
        if (supportedTypes.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
          setBiometricType('Face ID');
        } else if (supportedTypes.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
          setBiometricType(config.biometricsEnrolled ? 'Touch ID' : 'Passcode');
        } else if (supportedTypes.includes(LocalAuthentication.AuthenticationType.IRIS)) {
          setBiometricType('Iris');
        } else if (config.passcodeEnrolled) {
          setBiometricType('Passcode');
        } else {
          setBiometricType('Biometric');
        }
      }

      console.log('Biometric check:', {
        deviceReady,
        eligibleForLastUser,
        biometricsEnrolled: config.biometricsEnrolled,
        passcodeEnrolled: config.passcodeEnrolled,
      });
    } catch (error) {
      console.error('Error checking biometric availability:', error);
      setBiometricAvailable(false);
    }
  };

  // Handle regular login with OTP verification
  const handleSignIn = async () => {
    try {
      setError('');
      if (!username || !password) {
        setError('Please enter both username and password');
        return;
      }

      setIsSubmitting(true);

      // Step 1: Try regular login first
      try {
        await signIn(username, password, rememberDevice);
        const webPath = await resolveDefaultHomeWebPath();
        navigateTabsThenDefaultHome(router, webPath);
        return;
      } catch (loginError: any) {
        // IMPORTANT: On login failure, stay on login screen and show error
        // Do NOT navigate away - user should see the error message
        
        // Check if error is due to 2FA requirement
        if (loginError.requires2FA) {
          console.log('🔐 2FA required - navigating to OTP verification');
          console.log('📦 User data from login:', loginError.user);
          
          // Store user data for OTP verification
          const userData = loginError.user;
          const preferredMethod = loginError.preferredAuthMethod || 'email';
          
          // Get email or phone based on preferred method
          const email = userData?.email || '';
          const phoneNumber = userData?.phone_number || userData?.phoneNumber || '';
          
          setIsSubmitting(false);
          // Navigate to OTP verification screen with user info
          // Note: We pass password temporarily so we can complete login after OTP verification
          // This is stored in memory only and cleared after use
          router.push({
            pathname: '/(auth)/otp-verification',
            params: {
              username: username, // Keep for backward compatibility
              method: preferredMethod === 'phone' ? 'sms' : 'email',
              identifier: loginError.identifier || (preferredMethod === 'phone' ? phoneNumber : email),
              expiresIn: '600', // 10 minutes
              // Pass user data as JSON string (router params are strings)
              userEmail: email,
              userPhone: phoneNumber,
              preferredAuthMethod: preferredMethod,
              tempPassword: password, // Temporary: needed to complete login after OTP
              rememberDevice: rememberDevice ? 'true' : 'false', // Pass remember device preference
            }
          });
          return;
        }
        
        // If login fails for other reasons, check if user needs OTP verification.
        // Capture the original login error now so we can fall back to it if OTP also fails.
        const originalLoginError = loginError.message || 'Invalid username or password';
        console.log('Initial login failed, checking if OTP verification is needed');
        
        // Step 2: Check if user needs OTP verification
        const shouldUseOtp = await checkUserForOtpVerification(username);
        
        if (shouldUseOtp) {
          // Attempt OTP flow. If OTP request fails (e.g. "Phone number is required"),
          // show the original login error instead of the internal OTP error.
          const otpSent = await requestOtpForUser(username, password, rememberDevice);
          if (!otpSent) {
            console.log('❌ OTP request failed - showing original login error');
            setError(originalLoginError);
          }
        } else {
          console.log('❌ Login failed - showing error on login screen:', originalLoginError);
          setError(originalLoginError);
          return;
        }
      }
    } catch (error: any) {
      console.error('Enhanced login error:', error);
      // On any error, show error on login screen and stay here (do not redirect to home)
      const errorMessage = error.message || 'Login failed. Please try again.';
      setError(errorMessage);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Check if user exists and needs OTP verification
  const checkUserForOtpVerification = async (username: string): Promise<boolean> => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/mobile/auth/check-user`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username }),
      });

      if (response.ok) {
        const data = await response.json();
        return data.exists && (data.hasPhone || data.hasEmail);
      }
      return false;
    } catch (error) {
      console.error('Error checking user for OTP:', error);
      return false;
    }
  };

  // Request OTP for the user (password needed so after verify-otp we can POST /login with otpVerified: true).
  // Returns true if OTP was sent and the user was navigated to the verification screen,
  // false if the OTP request failed (caller is responsible for showing an error).
  const requestOtpForUser = async (
    username: string,
    password: string,
    rememberDevice: boolean
  ): Promise<boolean> => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/mobile/auth/request-otp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: username,
          purpose: 'login'
        }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        const email =
          (typeof data.email === 'string' && data.email) ||
          (typeof data.userEmail === 'string' && data.userEmail) ||
          '';
        const phoneNumber =
          (typeof data.phoneNumber === 'string' && data.phoneNumber) ||
          (typeof data.userPhone === 'string' && data.userPhone) ||
          '';
        const method =
          data.method === 'sms' || data.method === 'email' ? data.method : 'email';
        const preferred =
          data.preferredAuthMethod === 'phone' || data.preferredAuthMethod === 'email'
            ? data.preferredAuthMethod
            : method === 'sms'
              ? 'phone'
              : 'email';
        const expires =
          data.expiresIn != null ? Number(data.expiresIn) : 600;

        router.push({
          pathname: '/(auth)/otp-verification',
          params: {
            username,
            method,
            identifier:
              data.identifier ||
              (preferred === 'phone' ? phoneNumber : email) ||
              username,
            expiresIn: String(Number.isFinite(expires) ? expires : 600),
            userEmail: email,
            userPhone: phoneNumber,
            preferredAuthMethod: preferred,
            tempPassword: password,
            rememberDevice: rememberDevice ? 'true' : 'false',
          }
        });
        return true;
      } else {
        console.warn('OTP request failed:', data.message);
        return false;
      }
    } catch (error) {
      console.error('Error requesting OTP:', error);
      return false;
    }
  };

  // Handle biometric login
  const handleBiometricLogin = async () => {
    try {
      setError('');
      
      const result = await loginWithBiometric();
      
      if (!result.success) {
        if (result.message?.includes('not enrolled') || result.message?.includes('not trusted')) {
          Alert.alert(
            'Biometric Setup Required',
            'To use biometric authentication:\n\n1. First login with your username and password (not Google or Apple)\n2. Enable biometric authentication in Settings\n3. Device will be trusted for future biometric logins',
            [{ text: 'OK' }]
          );
        } else if (result.message?.includes('not available') || result.message?.includes('hardware')) {
          Alert.alert(
            'Biometric Not Available',
            'Biometric authentication is not available on this device. Please use username and password to sign in.',
            [{ text: 'OK' }]
          );
        } else {
          setError(result.message || 'Biometric authentication failed');
        }
      } else {
        const webPath = await resolveDefaultHomeWebPath();
        navigateTabsThenDefaultHome(router, webPath);
      }
    } catch (error: any) {
      console.error('Biometric login error:', error);
      setError('Biometric authentication failed. Please try again or use your password.');
    }
  };

  // Handle Google Sign-In
  const handleGoogleSignIn = async () => {
    let deepLinkHandled = false;
    try {
      setError('');
      if (!dataRightsConsent) {
        setError('Please confirm you have the necessary rights and permissions to upload others\' information');
        return;
      }
      setGoogleLoading(true);

      const googleResult = await googleAuthService.signInWithGoogle();

      // Android native SDK flow: idToken obtained in-session via the native account-picker dialog.
      // Verify it server-side and navigate synchronously — no browser, no grabdocs:// deep link,
      // so the post-login navigation race that stranded users on /notifications cannot occur.
      if (googleResult.completedViaNativeSignIn && googleResult.idToken) {
        deepLinkHandled = true; // keep the spinner up while we exchange + navigate
        const sessionResult = await apiService.googleSignInWithIdToken(googleResult.idToken);
        if (!sessionResult.success || !sessionResult.user) {
          deepLinkHandled = false;
          setError(sessionResult.message || 'Google sign-in failed. Please try again.');
          return;
        }
        const backendUser = sessionResult.user;
        const fullName = backendUser.firstName
          ? `${backendUser.firstName || ''} ${backendUser.lastName || ''}`.trim()
          : '';
        const displayName =
          fullName || backendUser.name || backendUser.username || backendUser.email || 'Google User';
        const userData = {
          id: (backendUser.id ?? '').toString(),
          email: backendUser.email || backendUser.username || '',
          name: displayName,
          first_name: backendUser.firstName,
          last_name: backendUser.lastName,
          username: backendUser.username,
        };
        if (!userData.id) {
          deepLinkHandled = false;
          setError('Failed to retrieve user information. Please try again.');
          return;
        }
        await setUserFromExternal(
          userData,
          sessionResult.token ?? sessionResult.access_token,
          sessionResult.refresh_token,
        );
        const webPath = await resolveDefaultHomeWebPath(backendUser);
        navigateTabsThenDefaultHome(router, webPath);
        return;
      }

      // iOS backend flow: openAuthSessionAsync returned the redirect URL synchronously.
      // Exchange the session token for a JWT and navigate — no Linking event or login-success
      // screen required, so the transition is immediate and reliable.
      if (googleResult.completedViaDeepLink && googleResult.loginToken) {
        deepLinkHandled = true;
        const exchanged = await exchangeGoogleLoginToken(googleResult.loginToken);
        if (!exchanged) {
          deepLinkHandled = false;
          setError('Google sign-in failed. Please try again.');
          return;
        }
        await setUserFromExternal(exchanged.user, exchanged.jwt, exchanged.refreshToken);
        const webPath = await resolveDefaultHomeWebPath();
        navigateTabsThenDefaultHome(router, webPath);
        return;
      }

      // iOS: session sheet closed without returning a token (e.g. user dismissed it) — stop the
      // spinner. Any genuine grabdocs://login-success redirect is still handled by login-success.tsx
      // and the AuthContext deep-link listener (web/legacy).
      if (googleResult.completedViaDeepLink) {
        return;
      }

      if (!googleResult.success || !googleResult.user || !googleResult.accessToken) {
        const err = googleResult.error || '';
        if (err === 'User cancelled' || /cancel/i.test(err)) {
          return;
        }
        setError(err || 'Google sign-in failed');
        return;
      }

      const backendResult = await googleAuthService.loginWithGoogleToBackend(
        googleResult.user,
        googleResult.accessToken
      );

      if (backendResult.requires2FA) {
        setError(backendResult.message || 'Additional verification required');
        return;
      }

      if (!backendResult.success || !backendResult.user) {
        setError(backendResult.message || 'Google sign-in failed');
        return;
      }

      const backendUser = backendResult.user;
      const fullName =
        backendUser.first_name || backendUser.firstName
          ? `${backendUser.first_name || backendUser.firstName || ''} ${backendUser.last_name || backendUser.lastName || ''}`.trim()
          : '';
      const displayName =
        fullName || backendUser.name || backendUser.username || backendUser.email || 'Google User';

      const userData = {
        id: (backendUser.id || backendUser.user_id || '').toString(),
        email: backendUser.email || backendUser.username || '',
        name: displayName,
        first_name: backendUser.first_name ?? backendUser.firstName,
        last_name: backendUser.last_name ?? backendUser.lastName,
        username: backendUser.username,
      };

      if (!userData.id) {
        setError('Failed to retrieve user information. Please try again.');
        return;
      }

      await setUserFromExternal(userData, backendResult.token);
      const webPath = await resolveDefaultHomeWebPath(backendResult.user ?? backendUser);
      navigateTabsThenDefaultHome(router, webPath);
    } catch (error: any) {
      console.error('Google sign-in error:', error);
      setError(error.message || 'Google sign-in failed');
      deepLinkHandled = false;
    } finally {
      // Keep loading spinner while navigating to avoid flash; cleared once navigation completes.
      if (!deepLinkHandled) {
        setGoogleLoading(false);
      }
    }
  };

  // Handle Apple Sign-In
  const handleAppleSignIn = async () => {
    try {
      setError('');
      if (!dataRightsConsent) {
        setError('Please confirm you have the necessary rights and permissions to upload others\' information');
        return;
      }
      
      // Use enhanced Apple Sign In with backend integration
      const result = await appleAuthService.signInWithAppleEnhanced();
      
      if (result.success && result.user) {
        const backendUser = result.user;
        const fullName = backendUser.first_name || backendUser.firstName
          ? `${backendUser.first_name || backendUser.firstName || ''} ${backendUser.last_name || backendUser.lastName || ''}`.trim()
          : '';
        const displayName = fullName || backendUser.name || backendUser.username || backendUser.email || 'Apple User';
        
        const userData = {
          id: (backendUser.id || backendUser.user_id || '').toString(),
          email: backendUser.email || backendUser.username || '',
          name: displayName,
        };
        
        if (!userData.id) {
          console.error('Invalid user data from Apple sign-in: missing ID', backendUser);
          setError('Failed to retrieve user information. Please try again.');
          return;
        }
        
        // Apple only returns email on first consent — use a stable placeholder when hidden.
        if (!userData.email) {
          userData.email = `apple-${userData.id}@grabdocs.app`;
        }
        
        // Directly set user in auth context — bypasses checkAuth so a cookie/token
        // hiccup cannot bounce the user back to the login screen.
        await setUserFromExternal(userData, result.token || undefined);
        
        const webPath = await resolveDefaultHomeWebPath(result.user ?? backendUser);
        navigateTabsThenDefaultHome(router, webPath);
      } else {
        if (result.requires2FA) {
          // Handle 2FA requirement if needed
          setError(result.message || 'Additional verification required');
        } else {
          setError(result.message || 'Apple sign-in failed');
        }
      }
    } catch (error: any) {
      console.error('Apple sign-in error:', error);
      if (error.code === 'ERR_CANCELED' || error.message?.includes('canceled') || error.message?.includes('User cancelled')) {
        // User cancelled - don't show error
        return;
      }
      setError(error.message || 'Apple sign-in failed');
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.container}
    >
      <View style={[styles.content, { paddingTop: insets.top + (Platform.OS === 'android' ? 20 : 28) }]}>
        <View style={styles.centeredBlock}>
          {/* Top spacer */}
          <View style={styles.topSpacer} />
          {/* Profile Section */}
          <View style={styles.profileSection}>
            <Text style={styles.welcomeText}>GrabDocs</Text>
          </View>
          
          {/* Form */}
          <View style={styles.form}>
          {/* Username Input */}
          <View style={styles.inputContainer}>
            <View style={styles.inputWrapper}>
              <Ionicons name="person-outline" size={20} color="#666" style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="Username"
                value={username}
                onChangeText={setUsername}
                autoCapitalize="none"
                textContentType="username"
                autoComplete="username"
                placeholderTextColor="#999"
              />
              {username.length > 0 && (
                <TouchableOpacity onPress={() => setUsername('')}>
                  <Ionicons name="close-circle" size={20} color="#ccc" />
                </TouchableOpacity>
              )}
            </View>
          </View>

          {/* Password Input */}
          <View style={styles.inputContainer}>
            <View style={styles.inputWrapper}>
              <Ionicons name="lock-closed-outline" size={20} color="#666" style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="Password"
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
                autoCorrect={false}
                autoCapitalize="none"
                textContentType="password"
                placeholderTextColor="#999"
              />
              <TouchableOpacity onPress={() => setShowPassword(!showPassword)}>
                <Ionicons 
                  name={showPassword ? "eye-off-outline" : "eye-outline"} 
                  size={20} 
                  color="#666" 
                />
              </TouchableOpacity>
            </View>
          </View>

          {/* Remember Me & Biometric Row */}
          <View style={styles.optionsRow}>
            <View style={styles.rememberMeContainer}>
              <Switch
                value={rememberDevice}
                onValueChange={setRememberDevice}
                trackColor={{ false: themeColorsHook.switchTrackOff, true: themeColorsHook.switchTrackOn }}
                thumbColor={themeColorsHook.switchThumbAndroid(rememberDevice)}
                ios_backgroundColor={themeColorsHook.switchTrackOff}
                style={styles.switch}
              />
              <Text style={styles.rememberMeLabel}>Remember me</Text>
            </View>
            
            {biometricAvailable && (
              <FeedbackTouchable 
                style={styles.faceIdContainer}
                onPress={handleBiometricLogin}
                disabled={loading}
                loading={loading}
                spinnerColor="#007AFF"
                replaceWithSpinner={false}
              >
                <Ionicons 
                  name={
                    biometricType === 'Face ID' ? 'scan' :
                    biometricType === 'Touch ID' ? 'finger-print' :
                    biometricType === 'Iris' ? 'eye' : 
                    'finger-print'
                  } 
                  size={20} 
                  color="#007AFF" 
                />
                <Text style={styles.faceIdText}>{biometricType}</Text>
              </FeedbackTouchable>
            )}
          </View>

          {/* Error Message */}
          {error ? (
            <View style={styles.errorContainer}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {/* Sign In Button */}
          <FeedbackTouchable
            style={[styles.signInButton, loading && styles.buttonDisabled]}
            onPress={handleSignIn}
            disabled={loading}
            loading={loading}
            spinnerColor="#fff"
          >
            <Text style={styles.signInButtonText}>Sign in</Text>
          </FeedbackTouchable>

          {/* Forgot Password */}
          <Link href="/forgot-password" asChild>
            <TouchableOpacity style={styles.forgotPasswordContainer}>
              <Text style={styles.forgotPasswordText}>Forgot username or password?</Text>
              <Ionicons name="open-outline" size={16} color="#007AFF" />
            </TouchableOpacity>
          </Link>

          {/* Divider */}
          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>or</Text>
            <View style={styles.dividerLine} />
          </View>

          <Pressable
            style={styles.consentRow}
            onPress={() => setDataRightsConsent((v) => !v)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: dataRightsConsent }}
          >
            <View style={[styles.consentBox, dataRightsConsent && styles.consentBoxChecked]} />
            <Text style={styles.consentText}>
              I confirm I have the necessary rights and permissions to upload others' information to GrabDocs.
            </Text>
          </Pressable>

          {/* Social sign-in: regular full-width buttons with "Sign in with Google" / "Sign in with Apple" */}
          <View style={styles.socialContainer}>
            <FeedbackTouchable
              style={[styles.socialButton, styles.googleButton, loading && styles.buttonDisabled]}
              onPress={handleGoogleSignIn}
              disabled={loading}
              loading={loading}
              spinnerColor="#007AFF"
              replaceWithSpinner={false}
            >
              <GoogleLogo size={20} />
              <Text style={styles.socialButtonText}>Sign in with Google</Text>
            </FeedbackTouchable>
            {Platform.OS === 'ios' && appleSignInAvailable && (
              <FeedbackTouchable
                style={[styles.socialButton, styles.appleButton, loading && styles.buttonDisabled]}
                onPress={handleAppleSignIn}
                disabled={loading}
                loading={loading}
                spinnerColor="#fff"
                replaceWithSpinner={false}
                activeOpacity={0.8}
              >
                <Ionicons name="logo-apple" size={20} color="#fff" />
                <Text style={[styles.socialButtonText, styles.appleButtonText]}>Sign in with Apple</Text>
              </FeedbackTouchable>
            )}
          </View>

          {/* Sign Up Link */}
          <View style={styles.signUpContainer}>
            <Text style={styles.signUpText}>New to GrabDocs? </Text>
            <Link href="/sign-up" asChild>
              <TouchableOpacity>
                <Text style={styles.signUpLink}>Create an account</Text>
              </TouchableOpacity>
            </Link>
          </View>
        </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const isAndroid = Platform.OS === 'android';

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8f9fa',
  },
  content: {
    flex: 1,
    paddingHorizontal: isAndroid ? 20 : 24,
    // paddingTop set dynamically with insets.top so content stays below status bar
  },
  centeredBlock: {
    flex: 1,
  },
  topSpacer: {
    minHeight: 32,
  },
  profileSection: {
    alignItems: 'center',
    marginBottom: isAndroid ? 16 : 40,
  },
  welcomeText: {
    fontSize: isAndroid ? 26 : 32,
    fontWeight: '700',
    color: Colors.primary,
  },
  form: {
    flex: 1,
  },
  inputContainer: {
    marginBottom: 18,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 48,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  inputIcon: {
    marginRight: 10,
  },
  input: {
    flex: 1,
    fontSize: 16,
    color: '#333',
    minHeight: 24,
    paddingVertical: 4,
  },
  optionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: isAndroid ? 14 : 24,
  },
  rememberMeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  switch: {
    marginRight: 8,
  },
  rememberMeLabel: {
    fontSize: isAndroid ? 14 : 16,
    color: '#333',
  },
  faceIdContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  faceIdText: {
    fontSize: isAndroid ? 14 : 16,
    color: '#007AFF',
    marginLeft: 6,
    fontWeight: '500',
  },
  errorContainer: {
    backgroundColor: '#ffebee',
    padding: isAndroid ? 8 : 12,
    borderRadius: 8,
    marginBottom: isAndroid ? 10 : 16,
    borderLeftWidth: 4,
    borderLeftColor: '#f44336',
  },
  errorText: {
    color: '#c62828',
    fontSize: 14,
  },
  signInButton: {
    backgroundColor: '#007AFF',
    paddingVertical: isAndroid ? 12 : 16,
    borderRadius: isAndroid ? 8 : 12,
    alignItems: 'center',
    marginBottom: isAndroid ? 14 : 24,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  signInButtonText: {
    color: '#fff',
    fontSize: isAndroid ? 16 : 18,
    fontWeight: '600',
  },
  forgotPasswordContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: isAndroid ? 10 : 16,
  },
  forgotPasswordText: {
    color: '#007AFF',
    fontSize: isAndroid ? 14 : 16,
    marginRight: 6,
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: isAndroid ? 8 : 12,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#e0e0e0',
  },
  dividerText: {
    marginHorizontal: isAndroid ? 8 : 10,
    color: '#666',
    fontSize: 14,
  },
  consentRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 14,
    paddingHorizontal: 2,
  },
  consentBox: {
    width: 20,
    height: 20,
    borderWidth: 2,
    borderColor: Colors.primary,
    borderRadius: 4,
    marginRight: 10,
    marginTop: 2,
  },
  consentBoxChecked: {
    backgroundColor: Colors.primary,
  },
  consentText: {
    flex: 1,
    fontSize: isAndroid ? 13 : 14,
    lineHeight: isAndroid ? 18 : 20,
    color: '#333',
  },
  socialContainer: {
    width: '100%',
    marginBottom: isAndroid ? 16 : 24,
    gap: 12,
  },
  socialButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    borderRadius: 12,
    gap: 10,
  },
  googleButton: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  appleButton: {
    backgroundColor: '#000',
  },
  socialButtonText: {
    fontSize: 18,
    fontWeight: '500',
    color: '#333',
  },
  appleButtonText: {
    color: '#fff',
  },
  signUpContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: isAndroid ? 20 : 40,
  },
  signUpText: {
    fontSize: isAndroid ? 14 : 16,
    color: '#666',
  },
  signUpLink: {
    fontSize: isAndroid ? 14 : 16,
    color: '#007AFF',
    fontWeight: '500',
  },
}); 
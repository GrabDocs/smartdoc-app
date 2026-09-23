import { Ionicons } from '@expo/vector-icons';
import * as AppleAuthentication from 'expo-apple-authentication';
import { Link, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import React, { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import { GoogleLogo } from '../../components/GoogleLogo';
import { Colors } from '../../constants/Colors';
import { STORAGE_KEYS } from '../../constants/Config';
import { useEnhanced2FAAuth } from '../../contexts/Enhanced2FAAuthContext';
import { appleAuthService } from '../../services/appleAuth';
import { apiService } from '../../services/api';
import { googleAuthService } from '../../services/googleAuth';
import { navigateTabsThenDefaultHome, resolveDefaultHomeWebPath } from '../../utils/defaultHomePath';
import { exchangeGoogleLoginToken } from '../../utils/googleOAuthDeepLink';
import { useAuth } from '../context/auth';

const isAndroid = Platform.OS === 'android';

export default function SignUpScreen() {
  const router = useRouter();
  const { signup } = useEnhanced2FAAuth();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [smsConsent, setSmsConsent] = useState(false);
  const [dataRightsConsent, setDataRightsConsent] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [appleSignInAvailable, setAppleSignInAvailable] = useState(false);
  const insets = useSafeAreaInsets();
  const { setUserFromExternal } = useAuth();
  const loading = isLoading || googleLoading;

  // Check Apple Sign In availability on mount
  useEffect(() => {
    if (Platform.OS === 'ios') {
      appleAuthService.isAvailableAsync().then(setAppleSignInAvailable);
    }
  }, []);

  const handleSignUp = async () => {
    try {
      setError('');
      setIsLoading(true);

      if (!username || !email || !password || !confirmPassword) {
        setError('Please fill in all fields');
        return;
      }

      if (password !== confirmPassword) {
        setError('Passwords do not match');
        return;
      }

      if (!dataRightsConsent) {
        setError('Please confirm you have the necessary rights and permissions to upload others\' information');
        return;
      }

      // Call Enhanced 2FA signup function
      const result = await signup({
        username,
        email,
        password,
        firstName: firstName || undefined,
        lastName: lastName || undefined,
        smsConsent,
        dataRightsConsent: true,
      });

      if (result.success) {
        Alert.alert('Success', 'Account created successfully!');
        const webPath = await resolveDefaultHomeWebPath();
        navigateTabsThenDefaultHome(router, webPath);
      } else {
        setError(result.message || 'An error occurred during sign up');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred during sign up');
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleSignUp = async () => {
    let deepLinkHandled = false;
    try {
      setError('');

      if (!dataRightsConsent) {
        setError('Please confirm you have the necessary rights and permissions to upload others\' information before continuing');
        return;
      }

      setGoogleLoading(true);

      const googleResult = await googleAuthService.signInWithGoogle();

      // Android native SDK flow: idToken obtained in-session via the native account-picker dialog.
      // Verify it server-side and navigate synchronously — no browser, no grabdocs:// deep link.
      if (googleResult.completedViaNativeSignIn && googleResult.idToken) {
        deepLinkHandled = true; // keep the spinner up while we exchange + navigate
        const sessionResult = await apiService.googleSignInWithIdToken(googleResult.idToken);
        if (!sessionResult.success || !sessionResult.user) {
          deepLinkHandled = false;
          setError(sessionResult.message || 'Google sign-up failed. Please try again.');
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

      // iOS: openAuthSessionAsync returns redirect URL with session token inline.
      if (googleResult.completedViaDeepLink && googleResult.loginToken) {
        deepLinkHandled = true;
        const exchanged = await exchangeGoogleLoginToken(googleResult.loginToken);
        if (!exchanged) {
          deepLinkHandled = false;
          setError('Google sign-up failed. Please try again.');
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
        setError(err || 'Google sign-up failed');
        return;
      }

      const backendResult = await googleAuthService.loginWithGoogleToBackend(
        googleResult.user,
        googleResult.accessToken
      );

      if (backendResult.requires2FA) {
        Alert.alert(
          '2FA Required',
          backendResult.message || 'Additional verification required. Please use phone verification.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Continue with Phone', onPress: () => router.push('/phone-login') },
          ]
        );
        return;
      }

      if (!backendResult.success || !backendResult.user) {
        setError(backendResult.message || 'Google sign-up failed');
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-up failed');
      deepLinkHandled = false;
    } finally {
      if (!deepLinkHandled) {
        setGoogleLoading(false);
      }
    }
  };

  const handleAppleSignUp = async () => {
    try {
      setError('');
      setIsLoading(true);

      if (!dataRightsConsent) {
        setError('Please confirm you have the necessary rights and permissions to upload others\' information before continuing');
        return;
      }

      // Use Apple Auth service for sign-up
      const result = await appleAuthService.signInWithAppleEnhanced();
      
      if (result.success) {
        // Format and store user data
        const { secureStorage } = await import('../../utils/storage');
        const backendUser = result.user;
        
        // Format user data similar to sign-in
        const fullName = backendUser.first_name || backendUser.firstName
          ? `${backendUser.first_name || backendUser.firstName || ''} ${backendUser.last_name || backendUser.lastName || ''}`.trim()
          : '';
        const displayName = fullName || backendUser.name || backendUser.username || backendUser.email || 'Apple User';
        
        const userData = {
          id: (backendUser.id || backendUser.user_id || '').toString(),
          email: backendUser.email || backendUser.username || '',
          name: displayName,
        };
        
        // Validate user data
        if (!userData.id) {
          console.error('Invalid user data from Apple sign-up: missing ID', backendUser);
          setError('Failed to create account. Please try again.');
          return;
        }
        
        // Email might be null if user chose to hide it - use a placeholder
        if (!userData.email) {
          userData.email = `apple-${userData.id}@grabdocs.app`;
          console.warn('Apple user email hidden, using placeholder:', userData.email);
        }
        
        await secureStorage.setItem('user', JSON.stringify(userData));
        
        // CRITICAL FIX: Store the actual JWT token returned from backend, not 'session_token'
        const authToken = result.token || 'session_token';
        await secureStorage.setItem(STORAGE_KEYS.AUTH_TOKEN, authToken);
        
        if (authToken && authToken !== 'session_token') {
          console.log('✅ Apple Sign-Up: JWT token stored');
        } else {
          console.warn('⚠️ Apple Sign-Up: No JWT token received, using session_token fallback');
        }
        
        Alert.alert('Success', 'Account created with Apple successfully!');
        
        // Small delay to ensure state propagation
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const webPath = await resolveDefaultHomeWebPath(backendUser as any);
        navigateTabsThenDefaultHome(router, webPath);
      } else if (result.requires2FA) {
        Alert.alert(
          '2FA Required',
          result.message || 'Additional verification required. Please use phone verification.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Continue with Phone', onPress: () => router.push('/phone-login') },
          ]
        );
      } else {
        setError(result.message || 'Apple sign-up failed');
      }
    } catch (err: any) {
      if (err.code === 'ERR_CANCELED' || err.message?.includes('canceled')) {
        // User cancelled - don't show error
        return;
      }
      setError(err instanceof Error ? err.message : 'Apple sign-up failed');
    } finally {
      setIsLoading(false);
    }
  };

  const openTermsOfService = () => {
    WebBrowser.openBrowserAsync('https://grabdocs.com/terms-of-service');
  };

  const openPrivacyPolicy = () => {
    WebBrowser.openBrowserAsync('https://grabdocs.com/privacy-policy');
  };

  // Ensure content clears status bar (time, battery). Use insets; on Android fallback if insets are 0.
  const statusBarHeight = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 24) : 0;
  const topPadding = Math.max(insets.top, statusBarHeight) + (isAndroid ? 8 : 12);

  return (
    <KeyboardAvoidingView
      style={styles.keyboardAvoid}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
    >
      <ScrollView
        contentContainerStyle={[styles.container, { paddingTop: topPadding }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.content}>
        <Text style={styles.title}>Create Account</Text>
        
        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <View style={styles.inputContainer}>
          <Text style={styles.inputLabel}>Username *</Text>
          <View style={styles.inputWrapper}>
            <Ionicons name="person-outline" size={20} color="#666" style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              placeholder="Enter your username"
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
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

        <View style={styles.nameContainer}>
          <View style={styles.nameInputContainer}>
            <Text style={styles.inputLabel}>First Name</Text>
            <View style={styles.inputWrapper}>
              <Ionicons name="person-outline" size={20} color="#666" style={styles.inputIcon} />
              <TextInput
                style={[styles.input, styles.nameInput]}
                placeholder="First name"
                value={firstName}
                onChangeText={setFirstName}
                autoComplete="given-name"
                placeholderTextColor="#999"
              />
              {firstName.length > 0 && (
                <TouchableOpacity onPress={() => setFirstName('')}>
                  <Ionicons name="close-circle" size={20} color="#ccc" />
                </TouchableOpacity>
              )}
            </View>
          </View>
          <View style={styles.nameInputContainer}>
            <Text style={styles.inputLabel}>Last Name</Text>
            <View style={styles.inputWrapper}>
              <Ionicons name="person-outline" size={20} color="#666" style={styles.inputIcon} />
              <TextInput
                style={[styles.input, styles.nameInput]}
                placeholder="Last name"
                value={lastName}
                onChangeText={setLastName}
                autoComplete="family-name"
                placeholderTextColor="#999"
              />
              {lastName.length > 0 && (
                <TouchableOpacity onPress={() => setLastName('')}>
                  <Ionicons name="close-circle" size={20} color="#ccc" />
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>

        <View style={styles.inputContainer}>
          <Text style={styles.inputLabel}>Email Address *</Text>
          <View style={styles.inputWrapper}>
            <Ionicons name="mail-outline" size={20} color="#666" style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              placeholder="Enter your email address"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
              placeholderTextColor="#999"
            />
            {email.length > 0 && (
              <TouchableOpacity onPress={() => setEmail('')}>
                <Ionicons name="close-circle" size={20} color="#ccc" />
              </TouchableOpacity>
            )}
          </View>
        </View>

        <View style={styles.inputContainer}>
          <Text style={styles.inputLabel}>Password *</Text>
          <View style={styles.inputWrapper}>
            <Ionicons name="lock-closed-outline" size={20} color="#666" style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              placeholder="Enter your password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
              autoCorrect={false}
              autoCapitalize="none"
              textContentType="newPassword"
              autoComplete="new-password"
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

        <View style={styles.inputContainer}>
          <Text style={styles.inputLabel}>Confirm Password *</Text>
          <View style={styles.inputWrapper}>
            <Ionicons name="lock-closed-outline" size={20} color="#666" style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              placeholder="Re-enter your password"
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              secureTextEntry={!showConfirmPassword}
              autoCorrect={false}
              autoCapitalize="none"
              textContentType="newPassword"
              autoComplete="new-password"
              placeholderTextColor="#999"
            />
            <TouchableOpacity onPress={() => setShowConfirmPassword(!showConfirmPassword)}>
              <Ionicons 
                name={showConfirmPassword ? "eye-off-outline" : "eye-outline"} 
                size={20} 
                color="#666" 
              />
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.termsContainer}>
          <Pressable
            style={styles.checkbox}
            onPress={() => setSmsConsent(!smsConsent)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: smsConsent }}
          >
            <View style={[styles.checkboxInner, smsConsent && styles.checkboxChecked]} />
          </Pressable>
          <Text style={styles.termsText}>
            I consent to receiving text messages for account notifications. Message and data rates may apply.
          </Text>
        </View>

        <View style={styles.termsContainer}>
          <Pressable
            style={styles.checkbox}
            onPress={() => setDataRightsConsent(!dataRightsConsent)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: dataRightsConsent }}
          >
            <View style={[styles.checkboxInner, dataRightsConsent && styles.checkboxChecked]} />
          </Pressable>
          <Text style={styles.termsText}>
            I confirm I have the necessary rights and permissions to upload others' information to GrabDocs.
          </Text>
        </View>

        <FeedbackTouchable
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={handleSignUp}
          disabled={loading}
          loading={loading}
          spinnerColor="#fff"
          replaceWithSpinner={false}
        >
          <Text style={styles.buttonText}>
            {isLoading ? 'Creating Account...' : 'Sign Up'}
          </Text>
        </FeedbackTouchable>

        <Text style={[styles.termsText, styles.termsFooter]}>
          By signing up, you agree to our{' '}
          <Text style={styles.link} onPress={openTermsOfService}>
            Terms of Service
          </Text>
          {' '}and{' '}
          <Text style={styles.link} onPress={openPrivacyPolicy}>
            Privacy Policy
          </Text>
        </Text>

        <View style={styles.divider}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>or</Text>
          <View style={styles.dividerLine} />
        </View>

        <View style={styles.socialSection}>
          {Platform.OS === 'android' ? (
            <FeedbackTouchable
              style={[styles.socialButtonFull, styles.googleButton, loading && styles.buttonDisabled]}
              onPress={handleGoogleSignUp}
              disabled={loading}
              loading={loading}
              spinnerColor="#007AFF"
              replaceWithSpinner={false}
            >
              <GoogleLogo size={20} />
              <Text style={styles.socialButtonFullText}>Sign up with Google</Text>
            </FeedbackTouchable>
          ) : (
            <>
              <Text style={styles.socialLabel}>Sign up with</Text>
              <View style={styles.socialRow}>
                <FeedbackTouchable
                  style={[styles.socialButtonSquare, styles.googleButton, loading && styles.buttonDisabled]}
                  onPress={handleGoogleSignUp}
                  disabled={loading}
                  loading={loading}
                  spinnerColor="#007AFF"
                  replaceWithSpinner={false}
                >
                  <GoogleLogo size={24} />
                </FeedbackTouchable>
                {appleSignInAvailable && (
                  <FeedbackTouchable
                    style={[styles.socialButtonSquare, styles.appleButtonSquare, loading && styles.buttonDisabled]}
                    onPress={handleAppleSignUp}
                    disabled={loading}
                    loading={loading}
                    spinnerColor="#fff"
                    replaceWithSpinner={false}
                    activeOpacity={0.8}
                  >
                    <Ionicons name="logo-apple" size={24} color="#fff" />
                  </FeedbackTouchable>
                )}
              </View>
            </>
          )}
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>Already have an account? </Text>
          <Link href="/sign-in" style={styles.footerLink}>
            Sign In
          </Link>
        </View>
      </View>
    </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  keyboardAvoid: {
    flex: 1,
  },
  container: {
    flexGrow: 1,
    backgroundColor: '#fff',
    paddingBottom: isAndroid ? 16 : 24,
    // paddingTop set dynamically with insets.top so content stays below status bar
  },
  content: {
    paddingHorizontal: isAndroid ? 16 : 20,
    paddingBottom: isAndroid ? 16 : 24,
    alignItems: 'center',
    width: '100%',
  },
  title: {
    fontSize: isAndroid ? 20 : 24,
    fontWeight: 'bold',
    marginBottom: isAndroid ? 12 : 18,
    color: Colors.text,
  },
  inputContainer: {
    width: '100%',
    marginBottom: 18,
  },
  inputLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: '#333',
    marginBottom: 5,
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
  nameContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    marginBottom: isAndroid ? 8 : 15,
  },
  nameInputContainer: {
    width: '48%',
  },
  nameInput: {
    width: '100%',
  },
  termsContainer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: isAndroid ? 12 : 20,
    paddingHorizontal: isAndroid ? 4 : 10,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderWidth: 2,
    borderColor: Colors.primary,
    borderRadius: 4,
    marginRight: 10,
    marginTop: 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxInner: {
    width: 12,
    height: 12,
    borderRadius: 2,
  },
  checkboxChecked: {
    backgroundColor: Colors.primary,
  },
  termsText: {
    flex: 1,
    fontSize: isAndroid ? 13 : 14,
    lineHeight: isAndroid ? 18 : 20,
    color: Colors.text,
  },
  termsFooter: {
    width: '100%',
    textAlign: 'center',
    marginTop: isAndroid ? 10 : 14,
    paddingHorizontal: isAndroid ? 4 : 10,
  },
  link: {
    color: Colors.primary,
    textDecorationLine: 'underline',
  },
  button: {
    width: '100%',
    height: isAndroid ? 44 : 50,
    backgroundColor: Colors.primary,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: isAndroid ? 6 : 10,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: '#fff',
    fontSize: isAndroid ? 15 : 16,
    fontWeight: 'bold',
  },
  footer: {
    flexDirection: 'row',
    marginTop: isAndroid ? 12 : 20,
    alignItems: 'center',
  },
  footerText: {
    color: Colors.text,
    fontSize: 14,
  },
  footerLink: {
    color: Colors.primary,
    fontSize: 14,
    fontWeight: 'bold',
  },
  errorText: {
    color: 'red',
    marginBottom: isAndroid ? 8 : 15,
    textAlign: 'center',
    fontSize: 13,
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: isAndroid ? 8 : 12,
    width: '100%',
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#ddd',
  },
  dividerText: {
    marginHorizontal: isAndroid ? 8 : 10,
    color: '#666',
    fontSize: 14,
  },
  socialSection: {
    width: '100%',
    alignItems: 'center',
    marginBottom: isAndroid ? 8 : 10,
  },
  socialLabel: {
    color: '#666',
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  socialRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  socialButtonFull: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    paddingVertical: 16,
    borderRadius: 12,
    gap: 10,
  },
  socialButtonFullText: {
    fontSize: 18,
    fontWeight: '500',
    color: '#333',
  },
  socialButtonSquare: {
    width: 56,
    height: 56,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  googleButton: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  appleButtonSquare: {
    backgroundColor: '#000',
  },
}); 
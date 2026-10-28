import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    Animated,
    Keyboard,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    StyleSheet,
    Switch,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import { Colors } from '../../constants/Colors';
import { API_BASE_URL } from '../../constants/Config';
import { useThemeColors } from '../../hooks/useThemeColors';
import { navigateTabsThenDefaultHome, resolveDefaultHomeWebPath } from '../../utils/defaultHomePath';
import { useAuth } from '../context/auth';
import deviceSecurityService from '../../services/deviceSecurity';


interface OtpVerificationParams {
  username: string;
  method: 'sms' | 'email';
  identifier: string;
  expiresIn: string;
  userEmail?: string;
  userPhone?: string;
  preferredAuthMethod?: 'email' | 'phone';
  tempPassword?: string;
  rememberDevice?: string;
}

function buildUserDataFromMobileLoginUser(
  user: Record<string, unknown> | null | undefined,
  fallbackEmail: string,
  fallbackUsername: string
): { id: string; name: string; email: string } | null {
  if (!user) return null;
  const id =
    user.id != null ? String(user.id) : user.user_id != null ? String(user.user_id) : '';
  if (!id) return null;
  const first = typeof user.first_name === 'string' ? user.first_name : '';
  const last = typeof user.last_name === 'string' ? user.last_name : '';
  const fn = typeof user.firstName === 'string' ? user.firstName : '';
  const ln = typeof user.lastName === 'string' ? user.lastName : '';
  const combined = [first, last].filter(Boolean).join(' ').trim();
  const combinedCamel = [fn, ln].filter(Boolean).join(' ').trim();
  const name =
    (typeof user.name === 'string' && user.name) ||
    combined ||
    combinedCamel ||
    (typeof user.username === 'string' && user.username) ||
    fallbackUsername;
  const email = (typeof user.email === 'string' && user.email) || fallbackEmail || '';
  return { id, name, email };
}

function buildUserDataFromAuthCheckData(
  data: Record<string, unknown> | null | undefined,
  fallbackEmail: string
): { id: string; name: string; email: string } | null {
  if (!data || data.id == null) return null;
  const name =
    (typeof data.name === 'string' && data.name) ||
    (typeof data.username === 'string' && data.username) ||
    '';
  const email = (typeof data.email === 'string' && data.email) || fallbackEmail || '';
  return { id: String(data.id), name, email };
}

const OTP_LENGTH = 6;

export default function OtpVerificationScreen() {
  const router = useRouter();
  const palette = useThemeColors();
  const params = useLocalSearchParams<OtpVerificationParams>();
  const { setUserFromExternal } = useAuth();

  const continueToMainApp = async (loginUser?: unknown) => {
    try {
      const webPath = await resolveDefaultHomeWebPath(loginUser);
      navigateTabsThenDefaultHome(router, webPath);
    } catch (err) {
      console.warn('OTP: navigation error, using replace fallback:', err);
      try {
        router.replace('/(tabs)');
      } catch (e2) {
        console.error('OTP: replace fallback also failed:', e2);
      }
    }
  };

  const [otpValue, setOtpValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [timeLeft, setTimeLeft] = useState(parseInt(params.expiresIn || '600'));
  const [isResending, setIsResending] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [trustDevice, setTrustDevice] = useState(
    params.rememberDevice === 'true' || params.rememberDevice === true
  );
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  const hiddenInputRef = useRef<TextInput>(null);
  const cursorAnim = useRef(new Animated.Value(1)).current;
  const shakeAnim = useRef(new Animated.Value(0)).current;
  const needsKeyboardRestoreRef = useRef(false);

  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setKeyboardVisible(true),
    );
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKeyboardVisible(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // Blinking cursor animation
  useEffect(() => {
    const blink = Animated.loop(
      Animated.sequence([
        Animated.timing(cursorAnim, { toValue: 0, duration: 500, useNativeDriver: true }),
        Animated.timing(cursorAnim, { toValue: 1, duration: 500, useNativeDriver: true }),
      ])
    );
    blink.start();
    return () => blink.stop();
  }, [cursorAnim]);

  // Shake animation for errors
  const triggerShake = useCallback(() => {
    shakeAnim.setValue(0);
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 8, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -8, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 6, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -6, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 60, useNativeDriver: true }),
    ]).start();
  }, [shakeAnim]);

  /**
   * Open / restore the soft keyboard.
   * On Android, dismissing the keypad often leaves the TextInput focused, so a
   * plain focus() is a no-op — blur first, then focus again.
   */
  const focusInput = useCallback((opts?: { force?: boolean }) => {
    if (isLoading && !opts?.force) return;
    const input = hiddenInputRef.current;
    if (!input) return;

    const reopen = () => {
      hiddenInputRef.current?.focus();
    };

    if (typeof input.isFocused === 'function' && input.isFocused()) {
      input.blur();
      requestAnimationFrame(() => {
        setTimeout(reopen, Platform.OS === 'android' ? 40 : 16);
      });
      return;
    }
    reopen();
  }, [isLoading]);

  // Auto-focus on mount (retry once — first attempt can miss after navigation)
  useEffect(() => {
    const open = () => {
      const input = hiddenInputRef.current;
      if (!input) return;
      if (typeof input.isFocused === 'function' && input.isFocused()) {
        input.blur();
        setTimeout(() => hiddenInputRef.current?.focus(), Platform.OS === 'android' ? 40 : 16);
      } else {
        input.focus();
      }
    };
    const t1 = setTimeout(open, 200);
    const t2 = setTimeout(open, 500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  // After verify finishes, restore keyboard if we asked for it while loading.
  useEffect(() => {
    if (isLoading || !needsKeyboardRestoreRef.current) return;
    needsKeyboardRestoreRef.current = false;
    const t = setTimeout(() => focusInput({ force: true }), 60);
    return () => clearTimeout(t);
  }, [isLoading, focusInput]);

  // If the user dismisses the keypad while the field stays focused, keep UI in sync.
  useEffect(() => {
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => {
        setIsFocused((focused) => {
          if (focused && hiddenInputRef.current && !hiddenInputRef.current.isFocused?.()) {
            return false;
          }
          return focused;
        });
      },
    );
    return () => hide.remove();
  }, []);

  // Countdown timer
  useEffect(() => {
    if (timeLeft <= 0) return;
    const timer = setInterval(() => setTimeLeft(prev => prev - 1), 1000);
    return () => clearInterval(timer);
  }, [timeLeft]);

  const handleOtpChange = (text: string) => {
    if (isLoading) return;
    const code = text.replace(/[^A-Za-z0-9]/g, '').slice(0, OTP_LENGTH);
    setOtpValue(code);
    setError('');
    if (code.length === OTP_LENGTH) {
      handleVerifyOtp(code);
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleVerifyOtp = async (code?: string) => {
    const finalCode = code ?? otpValue;

    if (finalCode.length !== OTP_LENGTH) {
      setError('Please enter the complete 6-character code');
      return;
    }

    try {
      setError('');
      setIsLoading(true);

      const preferredMethod = params.preferredAuthMethod || (params.method === 'sms' ? 'phone' : 'email');
      const email = params.userEmail || '';
      const phoneNumber = params.userPhone || '';

      let requestBody: Record<string, string>;
      if (preferredMethod === 'phone' && phoneNumber) {
        requestBody = { phoneNumber, otpCode: finalCode };
      } else if (email) {
        requestBody = { email, otpCode: finalCode };
      } else {
        requestBody = { username: params.username, otpCode: finalCode };
      }

      const response = await fetch(`${API_BASE_URL}/api/v1/mobile/auth/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        // Path A: verify-otp returns JWT + user directly
        if (data.token && data.user) {
          const userData = buildUserDataFromMobileLoginUser(
            data.user as Record<string, unknown>,
            params.userEmail || '',
            params.username || ''
          );
          if (userData?.id) {
            const { secureStorage } = await import('../../utils/storage');
            await secureStorage.setItem('auth_token', data.token);
            await secureStorage.setItem('user', JSON.stringify(userData));
            if (data.deviceToken) {
              await secureStorage.setItem('device_token', data.deviceToken);
            }
            await setUserFromExternal(userData, data.token);
            void continueToMainApp(data.user);
            return;
          }
        }

        // Path B: complete login via POST /login with otpVerified: true
        const completeLoginWithOtpVerified = async (): Promise<boolean> => {
          if (!params.username || !params.tempPassword) return false;

          let deviceInfo: Record<string, unknown> | undefined;
          try {
            const fingerprint = await deviceSecurityService.getDeviceFingerprint();
            deviceInfo = {
              fingerprint,
              rememberDevice: trustDevice,
            };
          } catch {
            deviceInfo = { rememberDevice: trustDevice };
          }

          const loginResponse = await fetch(`${API_BASE_URL}/api/v1/mobile/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              username: params.username,
              password: params.tempPassword,
              otpVerified: true,
              rememberDevice: trustDevice,
              deviceInfo,
            }),
          });

          const loginData = await loginResponse.json();

          if (!loginResponse.ok || !loginData.success) return false;
          if (loginData.requires2FA) return false;
          if (!loginData.token || typeof loginData.token !== 'string') return false;

          let userData = buildUserDataFromMobileLoginUser(
            loginData.user as Record<string, unknown> | undefined,
            params.userEmail || '',
            params.username || ''
          );

          if (!userData?.id) {
            try {
              const authCheckResponse = await fetch(`${API_BASE_URL}/api/v1/mobile/auth-check`, {
                method: 'GET',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${loginData.token}`,
                },
              });
              if (authCheckResponse.ok) {
                const authData = await authCheckResponse.json();
                const payload = authData.data || authData.user;
                userData = buildUserDataFromAuthCheckData(
                  payload as Record<string, unknown>,
                  params.userEmail || ''
                );
              }
            } catch (authErr) {
              console.error('auth-check fallback after login:', authErr);
            }
          }

          if (!userData?.id) return false;

          const { secureStorage } = await import('../../utils/storage');
          await secureStorage.setItem('auth_token', loginData.token);
          await secureStorage.setItem('user', JSON.stringify(userData));
          if (loginData.deviceToken) {
            await secureStorage.setItem('device_token', loginData.deviceToken);
          }

          // Update React auth state immediately without a network round-trip.
          // refreshSession() (calls checkAuth) is skipped here: a transient network failure
          // cannot nuke the freshly-written JWT when we use setUserFromExternal directly.
          await setUserFromExternal(userData, loginData.token);
          await deviceSecurityService.setLastLoginData({
            timestamp: new Date().toISOString(),
            authMethod: 'password',
          });
          void continueToMainApp(loginData.user);
          return true;
        };

        try {
          const loginOk = await completeLoginWithOtpVerified();
          if (loginOk) return;
        } catch (loginError) {
          console.error('Error completing login after OTP:', loginError);
        }

        setError('Verification successful but could not complete login. Please sign in again.');
        setTimeout(() => router.replace('/(auth)/sign-in'), 2000);
      } else {
        setError(data.message || 'Incorrect code. Please try again.');
        setOtpValue('');
        triggerShake();
        // Focus while editable=false (isLoading) is ignored — restore after finally.
        needsKeyboardRestoreRef.current = true;
      }
    } catch (err) {
      setError('Network error. Please try again.');
      console.error('OTP verification error:', err);
      needsKeyboardRestoreRef.current = true;
    } finally {
      setIsLoading(false);
    }
  };

  const handleResendOtp = async () => {
    try {
      setIsResending(true);
      setError('');

      const preferredMethod = params.preferredAuthMethod || (params.method === 'sms' ? 'phone' : 'email');
      const email = params.userEmail || '';
      const phoneNumber = params.userPhone || '';

      let requestBody: Record<string, string>;
      if (preferredMethod === 'phone' && phoneNumber) {
        requestBody = { phoneNumber };
      } else if (email) {
        requestBody = { email };
      } else {
        requestBody = { username: params.username };
      }

      const response = await fetch(`${API_BASE_URL}/api/v1/mobile/auth/resend-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setTimeLeft(600);
        setOtpValue('');
        needsKeyboardRestoreRef.current = true;
        // isResending clears in finally; restore keyboard after that tick.
        setTimeout(() => focusInput({ force: true }), 80);
      } else {
        setError(data.message || 'Failed to resend code');
      }
    } catch (err) {
      setError('Failed to resend code. Please try again.');
      console.error('Resend OTP error:', err);
    } finally {
      setIsResending(false);
    }
  };

  const getMethodIcon = () => (params.method === 'sms' ? 'phone-portrait' : 'mail');
  const getMethodText = () => (params.method === 'sms' ? 'phone number' : 'email address');

  const activeIndex = Math.min(otpValue.length, OTP_LENGTH - 1);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <SafeAreaView style={styles.content} edges={['top']}>
        <View style={styles.iconContainer}>
          {keyboardVisible ? (
            <View style={styles.iconSpacer} />
          ) : (
            <View style={styles.iconWrapper}>
              <Ionicons name={getMethodIcon()} size={40} color={Colors.primary} />
            </View>
          )}
        </View>

        <Text style={styles.title}>Enter Verification Code</Text>
        <Text style={styles.subtitle}>
          We&apos;ve sent a 6-character code to your {getMethodText()}
        </Text>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        {/* Hidden real input that captures all keyboard/autofill input */}
        <TextInput
          ref={hiddenInputRef}
          value={otpValue}
          onChangeText={handleOtpChange}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          keyboardType={Platform.OS === 'ios' ? 'default' : 'visible-password'}
          autoCapitalize="characters"
          autoCorrect={false}
          spellCheck={false}
          maxLength={OTP_LENGTH}
          textContentType="oneTimeCode"
          autoComplete={Platform.OS === 'android'
            ? (params.method === 'sms' ? 'sms-otp' : 'one-time-code')
            : undefined}
          importantForAutofill="yes"
          editable={!isLoading}
          showSoftInputOnFocus
          style={styles.hiddenInput}
          caretHidden
          // Allow programmatic focus; taps go through the Pressable overlay.
          accessible={false}
        />

        {/* Visual digit boxes — tap restores keyboard even after manual dismiss */}
        <Pressable onPress={() => focusInput()}>
          <Animated.View style={[styles.otpContainer, { transform: [{ translateX: shakeAnim }] }]}>
            {Array.from({ length: OTP_LENGTH }).map((_, i) => {
              const digit = otpValue[i];
              const isActive = isFocused && i === activeIndex && !isLoading;
              const isFilled = !!digit;

              return (
                <View
                  key={i}
                  style={[
                    styles.otpBox,
                    isFilled && styles.otpBoxFilled,
                    isActive && styles.otpBoxActive,
                    !!error && styles.otpBoxError,
                  ]}
                >
                  {digit ? (
                    <Text style={styles.otpDigit}>{digit}</Text>
                  ) : isActive ? (
                    <Animated.View style={[styles.cursor, { opacity: cursorAnim }]} />
                  ) : null}
                </View>
              );
            })}
          </Animated.View>
        </Pressable>

        {timeLeft > 0 ? (
          <Text style={styles.timerText}>Code expires in {formatTime(timeLeft)}</Text>
        ) : (
          <Text style={styles.expiredText}>Code has expired. Please request a new one.</Text>
        )}

        {/* Trust This Device */}
        <View style={styles.trustDeviceContainer}>
          <Switch
            value={trustDevice}
            onValueChange={setTrustDevice}
            trackColor={{ false: palette.switchTrackOff, true: palette.switchTrackOn }}
            thumbColor={palette.switchThumbAndroid(trustDevice)}
            ios_backgroundColor={palette.switchTrackOff}
            style={styles.trustDeviceSwitch}
          />
          <Text style={styles.trustDeviceLabel}>Trust this device for 60 days</Text>
        </View>

        <FeedbackTouchable
          style={[
            styles.verifyButton,
            (isLoading || otpValue.length < OTP_LENGTH) && styles.buttonDisabled,
          ]}
          onPress={() => handleVerifyOtp()}
          disabled={isLoading || otpValue.length < OTP_LENGTH}
          loading={isLoading}
          spinnerColor="#fff"
        >
          <Text style={styles.verifyButtonText}>Verify Code</Text>
        </FeedbackTouchable>

        <View style={styles.resendContainer}>
          <Text style={styles.resendText}>Didn&apos;t receive the code? </Text>
          <FeedbackTouchable
            onPress={handleResendOtp}
            disabled={isResending || timeLeft > 540}
            loading={isResending}
            spinnerColor={Colors.primary}
          >
            <Text style={[styles.resendLink, timeLeft > 540 && styles.resendLinkDisabled]}>
              Resend Code
            </Text>
          </FeedbackTouchable>
        </View>

        <TouchableOpacity
          style={styles.backToLoginButton}
          onPress={() => router.replace('/(auth)')}
        >
          <Text style={styles.backToLoginText}>Back to Login</Text>
        </TouchableOpacity>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  content: {
    flex: 1,
    padding: 20,
    justifyContent: 'center',
  },
  iconContainer: {
    alignItems: 'center',
    marginBottom: 30,
    height: 80,
    justifyContent: 'center',
  },
  iconSpacer: {
    width: 80,
    height: 80,
  },
  iconWrapper: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#e3f2fd',
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    textAlign: 'center',
    color: Colors.text,
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 16,
    textAlign: 'center',
    color: '#666',
    marginBottom: 30,
  },
  errorText: {
    color: '#ef4444',
    textAlign: 'center',
    marginBottom: 16,
    fontSize: 14,
  },
  hiddenInput: {
    position: 'absolute',
    // Keep tiny + non-interactive; Pressable owns taps. Use near-zero opacity —
    // fully transparent inputs sometimes fail to open the soft keyboard on Android.
    width: 1,
    height: 1,
    opacity: 0.01,
    pointerEvents: 'none',
  },
  otpContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 24,
    paddingHorizontal: 10,
  },
  otpBox: {
    flex: 1,
    maxWidth: 40,
    height: 52,
    marginHorizontal: 2,
    borderWidth: 2,
    borderColor: '#e0e0e0',
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fafafa',
  },
  otpBoxFilled: {
    borderColor: Colors.primary,
    backgroundColor: '#f0f8ff',
  },
  otpBoxActive: {
    borderColor: Colors.primary,
    backgroundColor: '#fff',
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 3,
  },
  otpBoxError: {
    borderColor: '#ef4444',
    backgroundColor: '#fff5f5',
  },
  otpDigit: {
    fontSize: 18,
    fontWeight: 'bold',
    color: Colors.text,
  },
  cursor: {
    width: 2,
    height: 24,
    backgroundColor: Colors.primary,
    borderRadius: 1,
  },
  timerText: {
    textAlign: 'center',
    color: '#666',
    fontSize: 14,
    marginBottom: 20,
  },
  expiredText: {
    textAlign: 'center',
    color: '#ef4444',
    fontSize: 14,
    marginBottom: 20,
  },
  trustDeviceContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
    paddingHorizontal: 20,
  },
  trustDeviceSwitch: {
    marginRight: 12,
  },
  trustDeviceLabel: {
    fontSize: 16,
    color: Colors.text,
    flex: 1,
  },
  verifyButton: {
    backgroundColor: Colors.primary,
    borderRadius: 8,
    height: 50,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  verifyButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  resendContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 30,
  },
  resendText: {
    color: '#666',
    fontSize: 14,
  },
  resendLink: {
    color: Colors.primary,
    fontSize: 14,
    fontWeight: '600',
  },
  resendLinkDisabled: {
    color: '#ccc',
  },
  backToLoginButton: {
    alignItems: 'center',
    padding: 10,
  },
  backToLoginText: {
    color: '#666',
    fontSize: 14,
  },
});

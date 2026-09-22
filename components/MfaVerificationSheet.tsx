import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Toast from 'react-native-toast-message';
import { FeedbackTouchable } from './FeedbackTouchable';
import { useThemeColors } from '../hooks/useThemeColors';
import { apiService } from '../services/api';

const OTP_LENGTH = 6;
const RESEND_COOLDOWN_SEC = 60;

export type MfaPurpose = 'password_change' | 'phone_removal' | 'phone_change' | 'email_change';
export type MfaAuthPolicy = 'phone_preferred' | 'email_only' | 'user_choice';

type Props = {
  visible: boolean;
  onClose: () => void;
  onSuccess: () => void;
  purpose: MfaPurpose;
  email?: string | null;
  hasPhone?: boolean;
  authPolicy?: MfaAuthPolicy;
  preferredMethod?: 'email' | 'phone' | null;
};

const purposeLabels: Record<MfaPurpose, string> = {
  password_change: 'change your password',
  phone_removal: 'remove your phone number',
  phone_change: 'change your phone number',
  email_change: 'change your email address',
};

/**
 * Identity step for sensitive Settings actions — mirrors web MfaVerificationModal.
 * Sends OTP to the account's current phone or email via /auth/request-mfa-otp.
 */
export default function MfaVerificationSheet({
  visible,
  onClose,
  onSuccess,
  purpose,
  email,
  hasPhone = false,
  authPolicy = 'phone_preferred',
  preferredMethod = null,
}: Props) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const [method, setMethod] = useState<'email' | 'phone'>('phone');
  const [otpSent, setOtpSent] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [error, setError] = useState('');
  const [destination, setDestination] = useState<string | null>(null);

  const hasRealEmail = Boolean(email && email !== 'no-2fa@disabled.local');
  const emailOnly = authPolicy === 'email_only';
  const userChoice = authPolicy === 'user_choice';
  const canChoose = userChoice
    ? hasRealEmail && hasPhone
    : !emailOnly && hasRealEmail && hasPhone;

  const resolvePreferred = (): 'email' | 'phone' | null => {
    if (emailOnly) return hasRealEmail ? 'email' : null;
    if (preferredMethod === 'phone' && hasPhone) return 'phone';
    if (preferredMethod === 'email' && hasRealEmail) return 'email';
    if (hasPhone) return 'phone';
    if (hasRealEmail) return 'email';
    return null;
  };

  const sendOtp = async (nextMethod: 'email' | 'phone') => {
    try {
      setLoading(true);
      setError('');
      const res = await apiService.requestMfaOtp({ purpose, method: nextMethod });
      if (!res.success) {
        setError(res.message || 'Failed to send verification code');
        return;
      }
      setMethod(nextMethod);
      setOtpSent(true);
      setDestination((res as any).destination || null);
      setResendCooldown(RESEND_COOLDOWN_SEC);
      if ((res as any).testMode && ((res as any).testOtp || (res as any).otpCode)) {
        Toast.show({
          type: 'info',
          text1: 'Dev OTP',
          text2: String((res as any).testOtp || (res as any).otpCode),
        });
      } else {
        Toast.show({
          type: 'success',
          text1: nextMethod === 'phone' ? 'Code sent to your phone' : 'Code sent to your email',
        });
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to send verification code');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!visible) {
      setOtpSent(false);
      setOtpCode('');
      setError('');
      setResendCooldown(0);
      setDestination(null);
      return;
    }
    const preferred = resolvePreferred();
    if (!preferred) {
      setError('No contact method available for verification');
      return;
    }
    setMethod(preferred);
    if (userChoice && hasRealEmail && hasPhone) {
      // Let the user pick before sending
      return;
    }
    void sendOtp(preferred);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, purpose, authPolicy, preferredMethod]);

  useEffect(() => {
    if (resendCooldown <= 0) return undefined;
    const t = setInterval(() => setResendCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [resendCooldown]);

  const verify = async () => {
    const code = otpCode.trim().toUpperCase();
    if (code.length !== OTP_LENGTH) {
      setError(`Enter the ${OTP_LENGTH}-character code`);
      return;
    }
    try {
      setLoading(true);
      setError('');
      const res = await apiService.verifyMfaOtp({ method, otpCode: code });
      if (!res.success) {
        setError(res.message || 'Invalid verification code');
        return;
      }
      Toast.show({ type: 'success', text1: 'Identity verified' });
      onSuccess();
    } catch (e: any) {
      setError(e?.message || 'Invalid verification code');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
    >
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 12 : 0}
          style={styles.keyboardWrap}
        >
          <View
            style={[
              styles.sheet,
              {
                backgroundColor: colors.background,
                paddingBottom: Math.max(insets.bottom, 16),
              },
            ]}
          >
            <ScrollView
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.scrollContent}
              bounces={false}
            >
              <Text style={[styles.title, { color: colors.text }]}>Verify your identity</Text>
              <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
                Confirm it’s you to {purposeLabels[purpose]}.
              </Text>

              {canChoose && !otpSent ? (
                <View style={styles.methodRow}>
                  <FeedbackTouchable
                    style={[styles.methodBtn, { borderColor: colors.border }]}
                    onPress={() => void sendOtp('phone')}
                    disabled={loading}
                    loading={loading && method === 'phone'}
                  >
                    <Text style={[styles.methodBtnText, { color: colors.text }]}>Text me</Text>
                  </FeedbackTouchable>
                  <FeedbackTouchable
                    style={[styles.methodBtn, { borderColor: colors.border }]}
                    onPress={() => void sendOtp('email')}
                    disabled={loading}
                    loading={loading && method === 'email'}
                  >
                    <Text style={[styles.methodBtnText, { color: colors.text }]}>Email me</Text>
                  </FeedbackTouchable>
                </View>
              ) : null}

              {otpSent || (!canChoose && !error) ? (
                <>
                  {destination ? (
                    <Text style={[styles.hint, { color: colors.textSecondary }]}>
                      Code sent to {destination}
                    </Text>
                  ) : null}
                  <TextInput
                    style={[styles.otpInput, { color: colors.text, borderColor: colors.border }]}
                    value={otpCode}
                    onChangeText={(t) =>
                      setOtpCode(
                        t.replace(/[^A-Za-z0-9]/g, '').slice(0, OTP_LENGTH).toUpperCase(),
                      )
                    }
                    maxLength={OTP_LENGTH}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    placeholder="ABC123"
                    placeholderTextColor={colors.textSecondary}
                  />
                  <FeedbackTouchable
                    style={[
                      styles.btn,
                      { backgroundColor: colors.primary },
                      loading && styles.btnDisabled,
                    ]}
                    onPress={verify}
                    disabled={loading}
                    loading={loading}
                    spinnerColor="#fff"
                  >
                    <Text style={styles.btnText}>Verify</Text>
                  </FeedbackTouchable>
                  <Pressable
                    style={styles.link}
                    disabled={loading || resendCooldown > 0}
                    onPress={() => void sendOtp(method)}
                  >
                    <Text style={{ color: colors.primary }}>
                      {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend code'}
                    </Text>
                  </Pressable>
                  {canChoose ? (
                    <Pressable
                      style={styles.link}
                      disabled={loading}
                      onPress={() => {
                        const next = method === 'phone' ? 'email' : 'phone';
                        setOtpCode('');
                        void sendOtp(next);
                      }}
                    >
                      <Text style={{ color: colors.textSecondary }}>
                        Use {method === 'phone' ? 'email' : 'phone'} instead
                      </Text>
                    </Pressable>
                  ) : null}
                </>
              ) : loading ? (
                <ActivityIndicator color={colors.primary} style={{ marginTop: 16 }} />
              ) : null}

              {error ? <Text style={styles.error}>{error}</Text> : null}

              <Pressable style={styles.link} onPress={onClose}>
                <Text style={{ color: colors.textSecondary }}>Cancel</Text>
              </Pressable>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  keyboardWrap: {
    width: '100%',
  },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 20,
    paddingTop: 16,
    maxHeight: '88%',
  },
  scrollContent: {
    paddingBottom: 8,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 16,
  },
  hint: {
    fontSize: 13,
    marginBottom: 8,
  },
  methodRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },
  methodBtn: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  methodBtnText: {
    fontSize: 15,
    fontWeight: '600',
  },
  otpInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === 'ios' ? 14 : 10,
    fontSize: 22,
    letterSpacing: 4,
    textAlign: 'center',
    marginBottom: 12,
  },
  btn: {
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  btnDisabled: {
    opacity: 0.6,
  },
  btnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  link: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  error: {
    color: '#FF3B30',
    marginTop: 8,
    fontSize: 13,
  },
});

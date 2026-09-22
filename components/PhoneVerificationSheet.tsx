import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Toast from 'react-native-toast-message';
import PhoneNumberInput from './PhoneNumberInput';
import { FeedbackTouchable } from './FeedbackTouchable';
import { useThemeColors } from '../hooks/useThemeColors';
import { apiService } from '../services/api';
import { isValidPhoneNumber } from '../utils/phoneUtils';

const OTP_LENGTH = 6;
const RESEND_COOLDOWN_SEC = 60;

type Props = {
  visible: boolean;
  onClose: () => void;
  onSuccess: (phoneNumber: string) => void;
  initialPhone?: string | null;
};

/**
 * Add / verify phone for Settings — mirrors web PhoneVerificationModal:
 * request-otp (purpose phone_update) → verify-otp → PUT /user with phone_number.
 */
export default function PhoneVerificationSheet({
  visible,
  onClose,
  onSuccess,
  initialPhone,
}: Props) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phone, setPhone] = useState(initialPhone || '');
  const [smsConsent, setSmsConsent] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!visible) return;
    setStep('phone');
    setPhone(initialPhone || '');
    setSmsConsent(false);
    setOtpCode('');
    setError('');
    setResendCooldown(0);
  }, [visible, initialPhone]);

  useEffect(() => {
    if (resendCooldown <= 0) return undefined;
    const t = setInterval(() => setResendCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [resendCooldown]);

  const sendOtp = async () => {
    if (!isValidPhoneNumber(phone)) {
      setError('Enter a valid phone number');
      return;
    }
    if (!smsConsent) {
      setError('SMS consent is required to receive a verification code');
      return;
    }
    try {
      setLoading(true);
      setError('');
      const res = await apiService.requestOtp(phone, 'US', 'phone_update', true);
      if (!res.success) {
        setError(res.message || 'Failed to send verification code');
        return;
      }
      if ((res as any).testMode && (res as any).testOtp) {
        Toast.show({
          type: 'info',
          text1: 'Dev OTP',
          text2: String((res as any).testOtp),
        });
      } else {
        Toast.show({ type: 'success', text1: 'Verification code sent' });
      }
      setStep('otp');
      setResendCooldown(RESEND_COOLDOWN_SEC);
    } catch (e: any) {
      setError(e?.message || 'Failed to send verification code');
    } finally {
      setLoading(false);
    }
  };

  const verifyAndSave = async () => {
    const code = otpCode.trim().toUpperCase();
    if (code.length !== OTP_LENGTH) {
      setError(`Enter the ${OTP_LENGTH}-character code`);
      return;
    }
    try {
      setLoading(true);
      setError('');
      const verify = await apiService.verifyOtp(phone, code);
      if (!verify.success) {
        setError(verify.message || 'Invalid verification code');
        return;
      }
      const save = await apiService.updateUserProfile({
        phone_number: phone,
        smsConsent: true,
      });
      if (!save.success) {
        setError(save.message || 'Failed to save phone number');
        return;
      }
      Toast.show({ type: 'success', text1: 'Phone number verified' });
      onSuccess(phone);
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Could not verify phone');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: colors.background,
              paddingBottom: Math.max(insets.bottom, 16),
            },
          ]}
        >
          <Text style={[styles.title, { color: colors.text }]}>
            {step === 'phone' ? 'Add phone number' : 'Enter verification code'}
          </Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
            {step === 'phone'
              ? 'We’ll text a code to verify this number for secure messaging invites and login.'
              : `Code sent to ${phone}`}
          </Text>

          {step === 'phone' ? (
            <>
              <PhoneNumberInput value={phone} onChange={setPhone} />
              <Pressable style={styles.consentRow} onPress={() => setSmsConsent((v) => !v)}>
                <Text style={[styles.consentBox, { color: colors.text }]}>
                  {smsConsent ? '☑' : '☐'}
                </Text>
                <Text style={[styles.consentText, { color: colors.textSecondary }]}>
                  I agree to receive SMS messages for verification and account notices.
                </Text>
              </Pressable>
              <FeedbackTouchable
                style={[styles.btn, { backgroundColor: colors.primary }, loading && styles.btnDisabled]}
                onPress={sendOtp}
                disabled={loading}
                loading={loading}
                spinnerColor="#fff"
              >
                <Text style={styles.btnText}>Send code</Text>
              </FeedbackTouchable>
            </>
          ) : (
            <>
              <TextInput
                style={[
                  styles.otpInput,
                  { color: colors.text, borderColor: colors.border },
                ]}
                value={otpCode}
                onChangeText={(t) =>
                  setOtpCode(t.replace(/[^A-Za-z0-9]/g, '').slice(0, OTP_LENGTH).toUpperCase())
                }
                maxLength={OTP_LENGTH}
                autoCapitalize="characters"
                autoCorrect={false}
                placeholder="ABC123"
                placeholderTextColor={colors.textSecondary}
              />
              <FeedbackTouchable
                style={[styles.btn, { backgroundColor: colors.primary }, loading && styles.btnDisabled]}
                onPress={verifyAndSave}
                disabled={loading}
                loading={loading}
                spinnerColor="#fff"
              >
                <Text style={styles.btnText}>Verify & save</Text>
              </FeedbackTouchable>
              <Pressable
                style={styles.link}
                disabled={loading || resendCooldown > 0}
                onPress={sendOtp}
              >
                <Text style={{ color: colors.primary }}>
                  {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend code'}
                </Text>
              </Pressable>
              <Pressable style={styles.link} onPress={() => setStep('phone')}>
                <Text style={{ color: colors.textSecondary }}>Change number</Text>
              </Pressable>
            </>
          )}

          {error ? (
            <Text style={styles.error}>{error}</Text>
          ) : null}

          {loading ? (
            <ActivityIndicator style={{ marginTop: 8 }} color={colors.primary} />
          ) : null}

          <Pressable style={styles.link} onPress={onClose}>
            <Text style={{ color: colors.textSecondary }}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 20,
    paddingTop: 20,
    gap: 12,
  },
  title: { fontSize: 20, fontWeight: '600' },
  subtitle: { fontSize: 14, lineHeight: 20, marginBottom: 4 },
  consentRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  consentBox: { fontSize: 18, lineHeight: 22 },
  consentText: { flex: 1, fontSize: 13, lineHeight: 18 },
  btn: {
    marginTop: 8,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  otpInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 12,
    fontSize: 22,
    letterSpacing: 4,
    textAlign: 'center',
  },
  link: { alignItems: 'center', paddingVertical: 8 },
  error: { color: '#c00', textAlign: 'center', fontSize: 14 },
});

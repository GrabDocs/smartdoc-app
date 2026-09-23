import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
    Alert,
    KeyboardAvoidingView,
    Linking,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import PhoneNumberInput from '../../components/PhoneNumberInput';
import { apiService } from '../../services/api';
import { navigateTabsThenDefaultHome, resolveDefaultHomeWebPath } from '../../utils/defaultHomePath';
import { isValidPhoneNumber, parsePhoneNumber } from '../../utils/phoneUtils';
import { useAuth } from '../context/auth';
import {
    loadMobilePendingInviteIntent,
} from '../secure-message-invite';

type PhoneLoginStep = 'phone' | 'verify' | 'password' | 'register';

const RESEND_COOLDOWN_SEC = 60;

const OTP_LENGTH = 6;

export default function PhoneLoginScreen() {
    const router = useRouter();
    const params = useLocalSearchParams<{ mode?: string; redirect?: string }>();
    const [step, setStep] = useState<PhoneLoginStep>('phone');
    const [isRegistering, setIsRegistering] = useState(params.mode === 'register');
    const [phoneNumber, setPhoneNumber] = useState('');
    const [otpCode, setOtpCode] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [username, setUsername] = useState('');
    const [email, setEmail] = useState('');
    const [firstName, setFirstName] = useState('');
    const [lastName, setLastName] = useState('');
    const [smsConsent, setSmsConsent] = useState(true);
    const [dataRightsConsent, setDataRightsConsent] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [maskedPhone, setMaskedPhone] = useState('');
    const [testOtp, setTestOtp] = useState('');
    const [resendCooldown, setResendCooldown] = useState(0);
    const resendCooldownActive = resendCooldown > 0;

    const { setUserFromExternal } = useAuth();

    useEffect(() => {
        if (!resendCooldownActive) return undefined;
        const interval = setInterval(() => {
            setResendCooldown((prev) => Math.max(0, prev - 1));
        }, 1000);
        return () => clearInterval(interval);
    }, [resendCooldownActive]);

    const finishAuthenticated = async (
        user: any,
        auth?: { token?: string | null; refresh_token?: string | null },
    ) => {
        if (user) {
            await setUserFromExternal(
                user,
                auth?.token || undefined,
                auth?.refresh_token || undefined,
            );
        }

        const pending = await loadMobilePendingInviteIntent();
        if (pending?.kind === 'secure_message_invite' && pending.token) {
            router.replace({
                pathname: '/secure-message-invite',
                params: { token: pending.token },
            } as any);
            return;
        }
        if (typeof params.redirect === 'string' && params.redirect.includes('secure-message-invite')) {
            router.replace(params.redirect as any);
            return;
        }

        const webPath = await resolveDefaultHomeWebPath(user as any);
        navigateTabsThenDefaultHome(router, webPath);
    };

    const handlePhoneSubmit = async () => {
        if (!phoneNumber || !isValidPhoneNumber(phoneNumber)) {
            setError('Please enter your phone number');
            return;
        }
        if (isRegistering && !dataRightsConsent) {
            setError('Please confirm you have the necessary rights and permissions to upload others\' information');
            return;
        }

        try {
            setLoading(true);
            setError('');

            const countryCode = parsePhoneNumber(phoneNumber).countryCode;
            const checkResponse = await apiService.checkPhone(phoneNumber, countryCode);
            const registered = !!checkResponse.registered;

            if (!registered && !isRegistering) {
                setIsRegistering(true);
            }
            if (registered && isRegistering) {
                setIsRegistering(false);
            }

            const purpose = registered ? 'login' : 'registration';
            const otpResponse = await apiService.requestOtp(
                phoneNumber,
                countryCode,
                purpose,
                !registered,
            );

            if (otpResponse.success) {
                setMaskedPhone((otpResponse as any).phoneNumber || phoneNumber);
                if ((otpResponse as any).testMode && (otpResponse as any).testOtp) {
                    setTestOtp((otpResponse as any).testOtp);
                    Alert.alert(
                        'Development Mode',
                        `Test OTP: ${(otpResponse as any).testOtp}`,
                        [{ text: 'OK' }],
                    );
                }
                setIsRegistering(!registered);
                setStep('verify');
                setResendCooldown(RESEND_COOLDOWN_SEC);
            } else {
                setError(otpResponse.message || 'Failed to send verification code');
            }
        } catch (err: any) {
            console.error('Phone submit error:', err);
            setError(err.message || 'Failed to process phone number');
        } finally {
            setLoading(false);
        }
    };

    const handleOtpSubmit = async () => {
        const code = otpCode.trim();
        if (!code) {
            setError('Please enter the verification code');
            return;
        }
        if (code.length !== OTP_LENGTH) {
            setError(`Please enter the complete ${OTP_LENGTH}-character code`);
            return;
        }

        try {
            setLoading(true);
            setError('');

            const verifyResponse = await apiService.verifyOtp(phoneNumber, code);

            if (verifyResponse.success) {
                setStep(isRegistering ? 'register' : 'password');
            } else {
                setError(verifyResponse.message || 'Invalid verification code');
            }
        } catch (err: any) {
            console.error('OTP verification error:', err);
            setError(err.message || 'Invalid verification code');
        } finally {
            setLoading(false);
        }
    };

    const handlePasswordSubmit = async () => {
        if (!password) {
            setError('Please enter your password');
            return;
        }

        try {
            setLoading(true);
            setError('');

            const loginResponse = await apiService.loginWithPhone(phoneNumber, password);

            if (loginResponse.success && loginResponse.user) {
                await finishAuthenticated(loginResponse.user, {
                    token: (loginResponse as any).token || (loginResponse as any).access_token,
                    refresh_token: (loginResponse as any).refresh_token,
                });
            } else {
                setError(loginResponse.message || 'Login failed');
            }
        } catch (err: any) {
            console.error('Password login error:', err);
            setError(err.message || 'Login failed');
        } finally {
            setLoading(false);
        }
    };

    const handleRegisterSubmit = async () => {
        if (!username || !email || !firstName || !lastName || !password) {
            setError('Please fill in all fields');
            return;
        }
        if (password !== confirmPassword) {
            setError('Passwords do not match');
            return;
        }
        if (!smsConsent) {
            setError('SMS consent is required to create an account with your phone number');
            return;
        }
        if (!dataRightsConsent) {
            setError('Please confirm you have the necessary rights and permissions to upload others\' information');
            return;
        }

        try {
            setLoading(true);
            setError('');

            const reg = await apiService.registerWithPhone({
                phoneNumber,
                countryCode: parsePhoneNumber(phoneNumber).countryCode,
                username,
                firstName,
                lastName,
                email,
                password,
                smsConsent: true,
                dataRightsConsent: true,
            });

            if (!reg.success) {
                setError((reg as any).message || 'Could not create account');
                return;
            }

            // Establish session with the password just set
            const loginResponse = await apiService.loginWithPhone(phoneNumber, password);
            if (loginResponse.success && loginResponse.user) {
                await finishAuthenticated(loginResponse.user, {
                    token: (loginResponse as any).token || (loginResponse as any).access_token,
                    refresh_token: (loginResponse as any).refresh_token,
                });
            } else {
                Alert.alert(
                    'Account created',
                    'Please sign in with your new phone number and password.',
                );
                setIsRegistering(false);
                setStep('password');
            }
        } catch (err: any) {
            console.error('Phone register error:', err);
            setError(err.message || 'Could not create account');
        } finally {
            setLoading(false);
        }
    };

    const handleResendOtp = async () => {
        if (resendCooldown > 0 || loading) return;
        try {
            setLoading(true);
            setError('');

            const purpose = isRegistering ? 'registration' : 'login';
            const otpResponse = await apiService.requestOtp(
                phoneNumber,
                parsePhoneNumber(phoneNumber).countryCode,
                purpose,
                isRegistering,
            );

            if (otpResponse.success) {
                if ((otpResponse as any).testMode && (otpResponse as any).testOtp) {
                    setTestOtp((otpResponse as any).testOtp);
                    Alert.alert(
                        'Development Mode',
                        `New Test OTP: ${(otpResponse as any).testOtp}`,
                        [{ text: 'OK' }],
                    );
                }
                Alert.alert('Success', 'New verification code sent!');
                setResendCooldown(RESEND_COOLDOWN_SEC);
            } else {
                setError(otpResponse.message || 'Failed to resend code');
            }
        } catch (err: any) {
            setError(err.message || 'Failed to resend code');
        } finally {
            setLoading(false);
        }
    };

    const renderPhoneStep = () => (
        <View style={styles.stepContainer}>
            <Text style={styles.stepTitle}>
                {isRegistering ? 'Create account with phone' : 'Enter Phone Number'}
            </Text>
            <Text style={styles.stepDescription}>
                We&apos;ll send you a verification code to confirm your identity
            </Text>

            <View style={styles.phoneContainer}>
                <PhoneNumberInput
                    value={phoneNumber}
                    onChange={setPhoneNumber}
                    placeholder="Phone number"
                />
            </View>

            {isRegistering ? (
                <Pressable
                    style={styles.consentRow}
                    onPress={() => setDataRightsConsent((v) => !v)}
                >
                    <Text style={styles.consentBox}>{dataRightsConsent ? '☑' : '☐'}</Text>
                    <Text style={styles.consentText}>
                        I confirm I have the necessary rights and permissions to upload others' information to GrabDocs.
                    </Text>
                </Pressable>
            ) : null}

            <FeedbackTouchable
                style={[styles.button, loading && styles.buttonDisabled]}
                onPress={handlePhoneSubmit}
                disabled={loading}
                loading={loading}
                spinnerColor="#fff"
            >
                <Text style={styles.buttonText}>Send Code</Text>
            </FeedbackTouchable>

            <Pressable
                style={styles.linkButton}
                onPress={() => setIsRegistering((v) => !v)}
            >
                <Text style={styles.linkText}>
                    {isRegistering
                        ? 'Already have an account? Sign in'
                        : 'New here? Create an account with this phone'}
                </Text>
            </Pressable>
        </View>
    );

    const renderVerifyStep = () => (
        <View style={styles.stepContainer}>
            <Text style={styles.stepTitle}>Enter Verification Code</Text>
            <Text style={styles.stepDescription}>
                We sent a 6-character code to {maskedPhone}
            </Text>

            {testOtp ? (
                <View style={styles.testModeContainer}>
                    <Text style={styles.testModeText}>🔧 Dev Mode - OTP: {testOtp}</Text>
                </View>
            ) : null}

            <TextInput
                style={styles.otpInput}
                placeholder="ABC123"
                placeholderTextColor="#999"
                value={otpCode}
                onChangeText={(text) => setOtpCode(text.replace(/[^A-Za-z0-9]/g, '').slice(0, OTP_LENGTH))}
                keyboardType={Platform.OS === 'ios' ? 'default' : 'visible-password'}
                autoCapitalize="characters"
                autoCorrect={false}
                spellCheck={false}
                maxLength={OTP_LENGTH}
                autoFocus
            />

            <FeedbackTouchable
                style={[styles.button, loading && styles.buttonDisabled]}
                onPress={handleOtpSubmit}
                disabled={loading}
                loading={loading}
                spinnerColor="#fff"
            >
                <Text style={styles.buttonText}>Verify</Text>
            </FeedbackTouchable>

            <FeedbackTouchable
                style={styles.linkButton}
                onPress={handleResendOtp}
                disabled={loading || resendCooldown > 0}
                loading={loading && resendCooldown === 0}
                spinnerColor="#007AFF"
                replaceWithSpinner={false}
            >
                <Text style={[styles.linkText, resendCooldown > 0 && styles.linkTextDisabled]}>
                    {resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : 'Resend code'}
                </Text>
            </FeedbackTouchable>

            <Pressable
                style={styles.linkButton}
                onPress={() => setStep('phone')}
            >
                <Text style={styles.linkText}>Change phone number</Text>
            </Pressable>
        </View>
    );

    const renderPasswordStep = () => (
        <View style={styles.stepContainer}>
            <Text style={styles.stepTitle}>Enter Password</Text>
            <Text style={styles.stepDescription}>
                Phone verified! Now enter your password to complete login
            </Text>

            <TextInput
                style={styles.input}
                placeholder="Password"
                placeholderTextColor="#999"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCorrect={false}
                autoCapitalize="none"
                textContentType="password"
                autoFocus
            />

            <FeedbackTouchable
                style={[styles.button, loading && styles.buttonDisabled]}
                onPress={handlePasswordSubmit}
                disabled={loading}
                loading={loading}
                spinnerColor="#fff"
            >
                <Text style={styles.buttonText}>Sign In</Text>
            </FeedbackTouchable>

            <Pressable
                style={styles.linkButton}
                onPress={() => setStep('verify')}
            >
                <Text style={styles.linkText}>Back to verification</Text>
            </Pressable>
        </View>
    );

    const renderRegisterStep = () => (
        <View style={styles.stepContainer}>
            <Text style={styles.stepTitle}>Finish creating your account</Text>
            <Text style={styles.stepDescription}>
                Phone verified. Add your details to join GrabDocs.
            </Text>

            <TextInput
                style={styles.input}
                placeholder="Username"
                placeholderTextColor="#999"
                value={username}
                onChangeText={setUsername}
                autoCapitalize="none"
                autoCorrect={false}
            />
            <TextInput
                style={styles.input}
                placeholder="Email"
                placeholderTextColor="#999"
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
            />
            <TextInput
                style={styles.input}
                placeholder="First name"
                placeholderTextColor="#999"
                value={firstName}
                onChangeText={setFirstName}
            />
            <TextInput
                style={styles.input}
                placeholder="Last name"
                placeholderTextColor="#999"
                value={lastName}
                onChangeText={setLastName}
            />
            <TextInput
                style={styles.input}
                placeholder="Password"
                placeholderTextColor="#999"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCorrect={false}
                autoCapitalize="none"
            />
            <TextInput
                style={styles.input}
                placeholder="Confirm password"
                placeholderTextColor="#999"
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                secureTextEntry
                autoCorrect={false}
                autoCapitalize="none"
            />

            <Pressable
                style={styles.consentRow}
                onPress={() => setSmsConsent((v) => !v)}
            >
                <Text style={styles.consentBox}>{smsConsent ? '☑' : '☐'}</Text>
                <Text style={styles.consentText}>
                    I agree to receive SMS messages for verification and account notices.
                </Text>
            </Pressable>

            <Pressable
                style={styles.consentRow}
                onPress={() => setDataRightsConsent((v) => !v)}
            >
                <Text style={styles.consentBox}>{dataRightsConsent ? '☑' : '☐'}</Text>
                <Text style={styles.consentText}>
                    I confirm I have the necessary rights and permissions to upload others' information to GrabDocs.
                </Text>
            </Pressable>

            <FeedbackTouchable
                style={[styles.button, loading && styles.buttonDisabled]}
                onPress={handleRegisterSubmit}
                disabled={loading}
                loading={loading}
                spinnerColor="#fff"
            >
                <Text style={styles.buttonText}>Create account</Text>
            </FeedbackTouchable>

            <Text style={styles.consentText}>
                By signing up, you agree to our{' '}
                <Text
                    style={styles.linkText}
                    onPress={() => Linking.openURL('https://grabdocs.com/terms-of-service')}
                >
                    Terms of Service
                </Text>
                {' '}and{' '}
                <Text
                    style={styles.linkText}
                    onPress={() => Linking.openURL('https://grabdocs.com/privacy-policy')}
                >
                    Privacy Policy
                </Text>
            </Text>
        </View>
    );

    return (
        <SafeAreaView style={styles.container}>
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                style={styles.keyboardView}
            >
                <ScrollView contentContainerStyle={styles.scrollContent}>
                    <View style={styles.header}>
                        <Text style={styles.title}>GrabDocs</Text>
                        <Text style={styles.subtitle}>
                            {isRegistering ? 'Phone sign up' : '2FA Phone Login'}
                        </Text>
                    </View>

                    {step === 'phone' && renderPhoneStep()}
                    {step === 'verify' && renderVerifyStep()}
                    {step === 'password' && renderPasswordStep()}
                    {step === 'register' && renderRegisterStep()}

                    {error ? (
                        <View style={styles.errorContainer}>
                            <Text style={styles.error}>{error}</Text>
                        </View>
                    ) : null}

                    <View style={styles.footer}>
                        <Link href="/sign-in" asChild>
                            <Pressable style={styles.linkButton}>
                                <Text style={styles.linkText}>
                                    Back to regular login
                                </Text>
                            </Pressable>
                        </Link>
                    </View>
                </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#fff',
    },
    keyboardView: {
        flex: 1,
    },
    scrollContent: {
        flexGrow: 1,
        padding: 24,
        justifyContent: 'center',
    },
    header: {
        alignItems: 'center',
        marginBottom: 48,
    },
    title: {
        fontSize: 36,
        fontWeight: 'bold',
        color: '#2563eb',
        textAlign: 'center',
        fontFamily: Platform.OS === 'ios' ? 'System' : 'Roboto',
    },
    subtitle: {
        fontSize: 16,
        color: '#666',
        textAlign: 'center',
        marginTop: 8,
    },
    stepContainer: {
        marginBottom: 32,
    },
    stepTitle: {
        fontSize: 24,
        fontWeight: 'bold',
        color: '#333',
        textAlign: 'center',
        marginBottom: 8,
    },
    stepDescription: {
        fontSize: 15,
        color: '#666',
        textAlign: 'center',
        marginBottom: 24,
        lineHeight: 22,
    },
    phoneContainer: {
        flexDirection: 'row',
        gap: 8,
        marginBottom: 16,
    },
    countryInput: {
        width: 72,
        borderWidth: 1,
        borderColor: '#ddd',
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 14,
        fontSize: 16,
        color: '#333',
    },
    phoneInput: {
        flex: 1,
        borderWidth: 1,
        borderColor: '#ddd',
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 14,
        fontSize: 16,
        color: '#333',
    },
    input: {
        borderWidth: 1,
        borderColor: '#ddd',
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 14,
        fontSize: 16,
        color: '#333',
        marginBottom: 12,
    },
    otpInput: {
        borderWidth: 1,
        borderColor: '#ddd',
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 14,
        fontSize: 22,
        letterSpacing: 4,
        textAlign: 'center',
        color: '#333',
        marginBottom: 16,
    },
    button: {
        backgroundColor: '#007AFF',
        borderRadius: 10,
        paddingVertical: 14,
        alignItems: 'center',
        marginTop: 8,
    },
    buttonDisabled: {
        opacity: 0.6,
    },
    buttonText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: '600',
    },
    linkButton: {
        marginTop: 16,
        alignItems: 'center',
    },
    linkText: {
        color: '#007AFF',
        fontSize: 15,
    },
    linkTextDisabled: {
        color: '#999',
    },
    errorContainer: {
        marginBottom: 16,
        padding: 12,
        backgroundColor: '#fee',
        borderRadius: 8,
    },
    error: {
        color: '#c00',
        textAlign: 'center',
    },
    footer: {
        marginTop: 24,
        alignItems: 'center',
    },
    testModeContainer: {
        backgroundColor: '#fff8e1',
        padding: 10,
        borderRadius: 8,
        marginBottom: 12,
    },
    testModeText: {
        color: '#8a6d00',
        textAlign: 'center',
    },
    consentRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        marginBottom: 8,
        marginTop: 4,
    },
    consentBox: {
        fontSize: 18,
        color: '#333',
        lineHeight: 22,
    },
    consentText: {
        flex: 1,
        fontSize: 13,
        color: '#555',
        lineHeight: 18,
    },
});

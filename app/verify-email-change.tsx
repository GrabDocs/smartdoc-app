import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Toast from 'react-native-toast-message';
import { STORAGE_KEYS } from '../constants/Config';
import { useAuth } from './context/auth';
import { useThemeColors } from '../hooks/useThemeColors';
import { apiService as api } from '../services/api';
import deviceSecurityService from '../services/deviceSecurity';
import {
  extractEmailChangeToken,
  isPermanentEmailChangeFailure,
} from '../utils/emailChangeToken';
import { secureStorage } from '../utils/storage';

type SuccessCache = {
  message: string;
  email?: string;
  /** True only when this device kept a live JWT (tokens re-issued). */
  matchedSession: boolean;
};

type FailCache = { message: string };

/** Survive Strict Mode remounts so a burned one-time token still shows success. */
const succeededTokens = new Map<string, SuccessCache>();
/** Only permanent failures (invalid/expired/used) — transient errors must not block retry. */
const failedTokens = new Map<string, FailCache>();
const inFlightTokens = new Set<string>();

async function syncLocalEmailAfterChange(
  email: string,
  opts: { keepSignedIn: boolean; accountMatched: boolean },
) {
  if (!email) return;
  if (!opts.keepSignedIn && !opts.accountMatched) return;
  try {
    const remembered = await secureStorage.getItem('remembered_email');
    if (remembered) {
      await secureStorage.setItem('remembered_email', email);
    }
    try {
      await deviceSecurityService.updateLastLoginEmail(email);
    } catch {
      // non-fatal
    }
    if (opts.keepSignedIn) {
      const raw = await secureStorage.getItem(STORAGE_KEYS.USER_DATA);
      if (raw) {
        const stored = JSON.parse(raw);
        stored.email = email;
        await secureStorage.setItem(STORAGE_KEYS.USER_DATA, JSON.stringify(stored));
      }
      const userRaw = await secureStorage.getItem('user');
      if (userRaw) {
        const storedUser = JSON.parse(userRaw);
        storedUser.email = email;
        await secureStorage.setItem('user', JSON.stringify(storedUser));
      }
    }
  } catch (syncErr) {
    console.warn('Email change local sync failed:', syncErr);
  }
}

export default function VerifyEmailChangeScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { user, setUserFromExternal, refreshSession } = useAuth();
  const params = useLocalSearchParams<{ token?: string }>();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const [matchedSession, setMatchedSession] = useState(true);
  const [newEmail, setNewEmail] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const userRef = useRef(user);
  userRef.current = user;

  useEffect(() => {
    const token = extractEmailChangeToken(params.token);
    if (!token) {
      setStatus('error');
      setMessage('Invalid verification link. Request a new email change from Settings.');
      return;
    }

    const applySuccess = (cached: SuccessCache) => {
      setStatus('success');
      setMessage(cached.message);
      setMatchedSession(cached.matchedSession);
      setNewEmail(cached.email || null);
    };

    const applyError = (msg: string) => {
      setStatus('error');
      setMessage(msg);
    };

    const cached = succeededTokens.get(token);
    if (cached) {
      applySuccess(cached);
      return;
    }

    const failed = failedTokens.get(token);
    if (failed && !inFlightTokens.has(token)) {
      applyError(failed.message);
      return;
    }

    // Remount while request is still running — wait for the shared result.
    if (inFlightTokens.has(token)) {
      let cancelled = false;
      const poll = setInterval(() => {
        if (cancelled) return;
        const ok = succeededTokens.get(token);
        if (ok) {
          clearInterval(poll);
          applySuccess(ok);
          return;
        }
        if (!inFlightTokens.has(token)) {
          clearInterval(poll);
          const err = failedTokens.get(token);
          // Transient failures are not cached — show message but allow retry on remount.
          applyError(err?.message || 'Verification failed. Please try again.');
        }
      }, 100);
      return () => {
        cancelled = true;
        clearInterval(poll);
      };
    }

    let cancelled = false;
    inFlightTokens.add(token);

    (async () => {
      try {
        const res = await api.verifyEmailChange(token);

        if (res.success) {
          const email = (res.email || res.data?.email || '') as string;
          const hasTokens = !!(res.token || res.access_token || res.refresh_token);
          // Device stays signed in only when tokens were re-issued.
          const keepSignedIn = hasTokens;
          const accountMatched =
            res.account_matched === true ||
            res.accountMatched === true ||
            keepSignedIn;
          const msg =
            res.message ||
            (email
              ? `Your email is now ${email}.`
              : 'Your email address has been updated.');

          const entry: SuccessCache = {
            message: msg,
            email: email || undefined,
            matchedSession: keepSignedIn,
          };
          succeededTokens.set(token, entry);
          failedTokens.delete(token);

          if (keepSignedIn && email) {
            try {
              const current = userRef.current;
              if (current?.id) {
                await setUserFromExternal(
                  { ...current, email },
                  (res.token || res.access_token) as string | undefined,
                  res.refresh_token as string | undefined,
                );
              } else {
                await refreshSession();
              }
              await syncLocalEmailAfterChange(email, {
                keepSignedIn: true,
                accountMatched: true,
              });
            } catch (syncErr) {
              console.warn('Email change auth sync failed:', syncErr);
            }
          } else if (email && accountMatched) {
            // Account matched but JWT re-issue failed — update remember/last-login only.
            await syncLocalEmailAfterChange(email, {
              keepSignedIn: false,
              accountMatched: true,
            });
            try {
              const { clearMobileAuthTokens } = await import('../utils/authTokenStorage');
              await clearMobileAuthTokens();
            } catch {
              // non-fatal
            }
          }

          if (!cancelled) {
            applySuccess(entry);
            Toast.show({ type: 'success', text1: 'Email updated' });
          }
        } else {
          const prior = succeededTokens.get(token);
          if (prior) {
            if (!cancelled) applySuccess(prior);
            return;
          }
          const errMsg = res.message || 'Verification failed';
          if (isPermanentEmailChangeFailure(errMsg)) {
            failedTokens.set(token, { message: errMsg });
          } else {
            failedTokens.delete(token);
          }
          if (!cancelled) applyError(errMsg);
        }
      } catch (e: any) {
        const prior = succeededTokens.get(token);
        if (prior) {
          if (!cancelled) applySuccess(prior);
          return;
        }
        const errMsg = e?.message || 'Verification failed. Please try again.';
        if (isPermanentEmailChangeFailure(errMsg)) {
          failedTokens.set(token, { message: errMsg });
        } else {
          failedTokens.delete(token);
        }
        if (!cancelled) applyError(errMsg);
      } finally {
        inFlightTokens.delete(token);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [params.token, setUserFromExternal, refreshSession, retryKey]);

  const goToSettings = () => {
    router.replace({
      pathname: '/(tabs)/settings',
      params: { section: 'profile', refresh: '1' },
    } as any);
  };

  const goToSignIn = () => {
    router.replace({
      pathname: '/(auth)/sign-in',
      params: newEmail ? { email: newEmail } : undefined,
    } as any);
  };

  const retryVerify = () => {
    const token = extractEmailChangeToken(params.token);
    if (token) failedTokens.delete(token);
    setStatus('loading');
    setMessage('');
    setRetryKey((k) => k + 1);
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.card}>
        {status === 'loading' ? (
          <>
            <ActivityIndicator color={colors.primary} />
            <Text style={[styles.title, { color: colors.text }]}>Verifying your email…</Text>
          </>
        ) : null}

        {status === 'success' ? (
          <>
            <Text style={[styles.icon, { color: '#16a34a' }]}>✓</Text>
            <Text style={[styles.title, { color: colors.text }]}>Email Updated</Text>
            <Text style={[styles.body, { color: colors.textSecondary }]}>{message}</Text>
            {!matchedSession ? (
              <Text style={[styles.body, { color: colors.textSecondary }]}>
                {newEmail
                  ? `Sign in with ${newEmail} to continue. Other sessions were signed out for security.`
                  : 'Sign in with your new email to continue. Other sessions were signed out for security.'}
              </Text>
            ) : (
              <Text style={[styles.body, { color: colors.textSecondary }]}>
                Other devices were signed out. This device stays signed in.
              </Text>
            )}
            {matchedSession ? (
              <TouchableOpacity
                style={[styles.btn, { backgroundColor: colors.primary }]}
                onPress={goToSettings}
              >
                <Text style={styles.btnText}>Go to Settings</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.btn, { backgroundColor: colors.primary }]}
                onPress={goToSignIn}
              >
                <Text style={styles.btnText}>Sign in</Text>
              </TouchableOpacity>
            )}
          </>
        ) : null}

        {status === 'error' ? (
          <>
            <Text style={[styles.icon, { color: '#dc2626' }]}>✗</Text>
            <Text style={[styles.title, { color: colors.text }]}>Verification Failed</Text>
            <Text style={[styles.body, { color: colors.textSecondary }]}>{message}</Text>
            {!isPermanentEmailChangeFailure(message) ? (
              <TouchableOpacity
                style={[styles.btn, { backgroundColor: colors.primary }]}
                onPress={retryVerify}
              >
                <Text style={styles.btnText}>Try again</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: colors.primary, opacity: isPermanentEmailChangeFailure(message) ? 1 : 0.85 }]}
              onPress={goToSettings}
            >
              <Text style={styles.btnText}>Back to Settings</Text>
            </TouchableOpacity>
          </>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24 },
  card: { gap: 14, alignItems: 'center' },
  icon: { fontSize: 40, fontWeight: '700' },
  title: { fontSize: 20, fontWeight: '600', textAlign: 'center' },
  body: { fontSize: 15, lineHeight: 22, textAlign: 'center' },
  btn: {
    marginTop: 8,
    alignSelf: 'stretch',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 16 },
});

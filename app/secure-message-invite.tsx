import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Toast from 'react-native-toast-message';
import { useThemeColors } from '../hooks/useThemeColors';
import { apiService as api } from '../services/api';
import { useAuth } from './context/auth';

const PENDING_INTENT_KEY = 'grabdocs_pending_auth_intent';

export async function saveMobilePendingInviteIntent(
  kind: 'secure_message_invite' | 'workspace_invite',
  token: string,
) {
  await AsyncStorage.setItem(
    PENDING_INTENT_KEY,
    JSON.stringify({ kind, token, at: Date.now() }),
  );
}

export async function loadMobilePendingInviteIntent(): Promise<{
  kind: string;
  token: string;
} | null> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_INTENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.token || !parsed?.kind) return null;
    if (parsed.at && Date.now() - parsed.at > 2 * 60 * 60 * 1000) {
      await AsyncStorage.removeItem(PENDING_INTENT_KEY);
      return null;
    }
    return { kind: parsed.kind, token: parsed.token };
  } catch {
    return null;
  }
}

export async function clearMobilePendingInviteIntent() {
  await AsyncStorage.removeItem(PENDING_INTENT_KEY);
}

export default function SecureMessageInviteScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { user, isLoading: authLoading, signOut } = useAuth();
  const params = useLocalSearchParams<{ token?: string }>();
  const token = typeof params.token === 'string' ? params.token : '';
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [valid, setValid] = useState(false);
  const [inviterName, setInviterName] = useState('Someone');
  const [status, setStatus] = useState('invalid');
  const [identityBlocked, setIdentityBlocked] = useState(false);
  const [blockMessage, setBlockMessage] = useState('');

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    void (async () => {
      await saveMobilePendingInviteIntent('secure_message_invite', token);
      try {
        const res = await api.resolveSecureMessageInvite(token);
        setValid(!!res.valid);
        setStatus((res as any).status || 'invalid');
        if ((res as any).inviter_display_name) {
          setInviterName((res as any).inviter_display_name);
        }
      } catch {
        setValid(false);
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  useEffect(() => {
    if (authLoading || loading) return;
    if (!token) return;
    if (!user) {
      router.replace({
        pathname: '/(auth)/phone-login',
        params: {
          mode: 'register',
          redirect: `/secure-message-invite?token=${encodeURIComponent(token)}`,
        },
      } as any);
    }
  }, [authLoading, loading, user, token, router]);

  const onAccept = async () => {
    if (!token) return;
    setAccepting(true);
    setIdentityBlocked(false);
    try {
      const res = await api.acceptSecureMessageInvite({ token });
      if (res.success) {
        await clearMobilePendingInviteIntent();
        Toast.show({ type: 'success', text1: 'Invitation accepted' });
        const chatId = (res as any).chat?.id;
        router.replace(chatId ? `/user-chat?chatId=${chatId}` : '/user-chat');
      } else {
        const code = (res as any).error_code;
        if (code === 'invite_identity_mismatch') {
          setIdentityBlocked(true);
          setBlockMessage((res as any).error || 'This invitation is for a different account.');
        } else {
          Toast.show({ type: 'error', text1: (res as any).error || 'Could not accept' });
        }
      }
    } catch (e: any) {
      const data = e?.response?.data;
      if (data?.error_code === 'invite_identity_mismatch') {
        setIdentityBlocked(true);
        setBlockMessage(data.error || 'This invitation is for a different account.');
      } else {
        Toast.show({ type: 'error', text1: data?.error || e?.message || 'Could not accept' });
      }
    } finally {
      setAccepting(false);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.card}>
        {loading || authLoading ? (
          <ActivityIndicator color={colors.primary} />
        ) : (
          <>
            <Text style={[styles.title, { color: colors.text }]}>Secure Messaging invite</Text>
            {valid && user ? (
              identityBlocked ? (
                <>
                  <Text style={[styles.body, { color: colors.textSecondary }]}>{blockMessage}</Text>
                  <Text style={[styles.body, { color: colors.textSecondary }]}>
                    Sign in with the account this invite was sent to, or add that phone in Settings,
                    then open this link again.
                  </Text>
                  <TouchableOpacity
                    style={[styles.btn, { backgroundColor: colors.primary }]}
                    onPress={() =>
                      router.push({
                        pathname: '/(tabs)/settings',
                        params: { section: 'profile', openPhone: '1' },
                      } as any)
                    }
                  >
                    <Text style={styles.btnText}>Open Settings</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.btnOutline, { borderColor: colors.border }]}
                    onPress={async () => {
                      await signOut();
                      router.replace({
                        pathname: '/(auth)/phone-login',
                        params: {
                          mode: 'register',
                          redirect: `/secure-message-invite?token=${encodeURIComponent(token)}`,
                        },
                      } as any);
                    }}
                  >
                    <Text style={[styles.btnOutlineText, { color: colors.text }]}>Switch account</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <Text style={[styles.body, { color: colors.textSecondary }]}>
                    {inviterName} invited you to securely message them on GrabDocs.
                  </Text>
                  <TouchableOpacity
                    style={[styles.btn, { backgroundColor: colors.primary }]}
                    disabled={accepting}
                    onPress={onAccept}
                  >
                    <Text style={styles.btnText}>{accepting ? 'Accepting…' : 'Accept invitation'}</Text>
                  </TouchableOpacity>
                </>
              )
            ) : (
              <Text style={[styles.body, { color: colors.textSecondary }]}>
                This invitation is {status === 'expired' ? 'expired' : 'not available'}.
                If you just installed the app, sign in with the invited email or phone — pending
                invites will appear after login.
              </Text>
            )}
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24 },
  card: { gap: 16 },
  title: { fontSize: 22, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 22 },
  btn: { marginTop: 8, paddingVertical: 14, borderRadius: 10, alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  btnOutline: {
    marginTop: 8,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
  },
  btnOutlineText: { fontWeight: '600', fontSize: 16 },
});

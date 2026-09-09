import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    FlatList,
    RefreshControl,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FeedbackTouchable } from '../../components/FeedbackTouchable';
import { GoogleLogo } from '../../components/GoogleLogo';
import { MicrosoftLogo } from '../../components/MicrosoftLogo';
import { useThemeColors } from '../../hooks/useThemeColors';
import {
    composeMailboxEmail,
    dismissMailboxThread,
    dismissMailboxThreads,
    emailApiError,
    emailSyncWorkspaceId,
    listMailboxThreads,
    mailboxCapabilities,
    mailboxPendingCount,
    syncMailbox,
    undismissMailboxThread,
    undoMailboxSend,
    type EmailThread,
    type ThreadAttention,
} from '../../services/emailSyncApi';
import { AttachmentNamesRow } from './_components/AttachmentNamesRow';
import { confirmCloseMailboxThread } from './_components/confirmCloseThread';
import { EmailSyncTopTabs, type EmailSyncTab } from './_components/EmailSyncTopTabs';
import { formatEmailWhen, threadStatusDotColor } from './_components/emailFormat';
import { openEmailInboxOAuth } from './_components/emailOAuth';
import {
    emailSyncCachePending,
    emailSyncCacheReplies,
    emailSyncCacheSetPending,
    emailSyncCacheSetReplies,
    emailSyncCacheSetWorkspace,
    emailSyncConsumeOAuthRefresh,
    emailSyncPeekOAuthRefresh,
    useEmailSyncUndo,
    emailSyncClearUndo,
} from './_components/emailSyncCache';
import { EmailImportsPane } from './imports';
import { EmailSetupPane } from './mailbox';
import AppBackButton from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';
import { formatRemainingCountdown } from '../../utils/timeFormatting';

const FILTERS: { id: ThreadAttention; label: string }[] = [
  { id: 'pending', label: 'To reply' },
  { id: 'candidates', label: 'Review' },
  { id: 'drafts', label: 'Drafts' },
  { id: 'dismissed', label: 'Dismissed' },
];

export default function EmailInboxScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const params = useLocalSearchParams<{
    threadId?: string;
    workspaceId?: string;
    tab?: string;
    oauth?: string;
    compose?: string;
    client_id?: string;
    to?: string;
    subject?: string;
  }>();
  const initialTab: EmailSyncTab =
    params.tab === 'setup' || params.tab === 'imports' ? params.tab : 'replies';
  const [tab, setTab] = useState<EmailSyncTab>(initialTab);
  const [visited, setVisited] = useState({
    replies: initialTab === 'replies',
    setup: initialTab === 'setup',
    imports: initialTab === 'imports',
  });
  const [workspaceId, setWorkspaceId] = useState<number | null>(
    params.workspaceId ? Number(params.workspaceId) : null
  );
  const [filter, setFilter] = useState<ThreadAttention>('pending');
  const [threads, setThreads] = useState<EmailThread[]>(() => emailSyncCacheReplies('pending')?.threads || []);
  const [pending, setPending] = useState(emailSyncCachePending());
  const [hasMailbox, setHasMailbox] = useState<boolean | null>(() => {
    const hit = emailSyncCacheReplies('pending');
    return hit ? hit.hasMailbox : null;
  });
  const [loading, setLoading] = useState(() => !emailSyncCacheReplies('pending'));
  const [refreshing, setRefreshing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [canSend, setCanSend] = useState(false);
  const [composing, setComposing] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [selectMode, setSelectMode] = useState(false);
  const openedRef = useRef<string | null>(null);
  const composeBootRef = useRef(false);
  const swipeRefs = useRef<Map<number, Swipeable>>(new Map());

  const { undo, remainingSec: undoLeft } = useEmailSyncUndo();

  const selectTab = (next: EmailSyncTab) => {
    setTab(next);
    setVisited((v) => ({ ...v, [next]: true }));
  };

  useEffect(() => {
    if (params.tab === 'setup' || params.tab === 'imports' || params.tab === 'replies') {
      selectTab(params.tab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.tab]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const id = await emailSyncWorkspaceId(params.workspaceId ? Number(params.workspaceId) : undefined);
        if (alive) {
          setWorkspaceId(id);
          emailSyncCacheSetWorkspace(id);
        }
      } catch {
        if (alive) setHasMailbox(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [params.workspaceId]);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    const [caps, count, list] = await Promise.all([
      mailboxCapabilities(workspaceId),
      mailboxPendingCount(workspaceId),
      listMailboxThreads(workspaceId, filter),
    ]);
    setHasMailbox(!!caps.has_oauth_mailbox);
    setCanSend((caps.connections || []).some((c) => c.send_enabled));
    setPending(count);
    setThreads(list);
    emailSyncCacheSetPending(count);
    emailSyncCacheSetReplies(filter, { threads: list, hasMailbox: !!caps.has_oauth_mailbox });
  }, [workspaceId, filter]);

  useEffect(() => {
    if (!workspaceId) return;
    const force = emailSyncPeekOAuthRefresh() || params.oauth === 'success';
    const hit = emailSyncCacheReplies(filter);
    if (hit && !force) {
      setThreads(hit.threads);
      setHasMailbox(hit.hasMailbox);
      setLoading(false);
      if (!hit.stale) return;
    }
    let alive = true;
    (async () => {
      if (!hit || force) setLoading(true);
      try {
        await load();
      } catch (e) {
        if (!hit) Alert.alert('Inbox', emailApiError(e, 'Could not load mail'));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [load, workspaceId, filter, params.oauth]);

  const reloadAfterOAuth = useCallback(async () => {
    if (!workspaceId) return;
    for (let i = 0; i < 6; i++) {
      await load();
      const caps = await mailboxCapabilities(workspaceId).catch(() => null);
      if (caps?.has_oauth_mailbox) return;
      await new Promise((r) => setTimeout(r, 400));
    }
  }, [workspaceId, load]);

  useFocusEffect(
    useCallback(() => {
      const fromDeepLink = params.oauth === 'success';
      if (!workspaceId || (!emailSyncConsumeOAuthRefresh() && !fromDeepLink)) return;
      let alive = true;
      (async () => {
        try {
          await reloadAfterOAuth();
        } catch {
          /* load errors already handled */
        }
        if (alive && fromDeepLink) {
          router.setParams({ oauth: undefined } as any);
        }
      })();
      return () => {
        alive = false;
      };
    }, [workspaceId, params.oauth, reloadAfterOAuth, router])
  );

  useEffect(() => {
    if (!params.threadId || openedRef.current === params.threadId || !workspaceId) return;
    openedRef.current = params.threadId;
    router.push({
      pathname: '/email-sync/thread/[id]',
      params: {
        id: params.threadId,
        workspaceId: String(workspaceId),
        filter,
        compose: '1',
      },
    } as any);
  }, [params.threadId, workspaceId, filter, router]);

  useEffect(() => {
    if (!workspaceId) return;
    const flag = Array.isArray(params.compose) ? params.compose[0] : params.compose;
    if (flag !== '1' && flag !== 'true') return;
    if (composeBootRef.current) return;
    composeBootRef.current = true;
    const toRaw = Array.isArray(params.to) ? params.to[0] : params.to;
    const subjectRaw = Array.isArray(params.subject) ? params.subject[0] : params.subject;
    const clientRaw = Array.isArray(params.client_id) ? params.client_id[0] : params.client_id;
    const clientId = clientRaw && /^\d+$/.test(clientRaw) ? Number(clientRaw) : undefined;
    void (async () => {
      try {
        const res = await composeMailboxEmail({
          workspace_id: workspaceId,
          to: typeof toRaw === 'string' && toRaw.trim() ? toRaw.trim() : undefined,
          subject: typeof subjectRaw === 'string' && subjectRaw.trim() ? subjectRaw.trim() : undefined,
          client_id: clientId && Number.isFinite(clientId) ? clientId : undefined,
        });
        const threadId = res.thread?.id;
        if (!threadId) throw new Error('No thread');
        setFilter('drafts');
        router.push({
          pathname: '/email-sync/thread/[id]',
          params: {
            id: String(threadId),
            workspaceId: String(workspaceId),
            filter: 'drafts',
            compose: '1',
            ...(clientId ? { client_id: String(clientId) } : {}),
            ...(typeof toRaw === 'string' && toRaw.trim() ? { to: toRaw.trim() } : {}),
          },
        } as any);
        router.setParams({
          compose: undefined,
          client_id: undefined,
          to: undefined,
          subject: undefined,
        } as any);
      } catch (e) {
        composeBootRef.current = false;
        Alert.alert('Email', emailApiError(e, 'Could not start a new email'));
      }
    })();
  }, [workspaceId, params.compose, params.to, params.client_id, params.subject, filter, router]);

  useEffect(() => {
    if (!workspaceId) return;
    const t = setInterval(() => {
      mailboxPendingCount(workspaceId).then((n) => {
        setPending(n);
        emailSyncCacheSetPending(n);
      }).catch(() => {});
    }, 60000);
    return () => clearInterval(t);
  }, [workspaceId]);

  const onRefresh = useCallback(async () => {
    if (!workspaceId) return;
    setRefreshing(true);
    try {
      await syncMailbox(workspaceId);
      await new Promise((r) => setTimeout(r, 2000));
      await load();
    } catch (e) {
      Alert.alert('Sync', emailApiError(e, 'Failed'));
    } finally {
      setRefreshing(false);
    }
  }, [workspaceId, load]);

  const connect = async (provider: 'gmail' | 'outlook') => {
    if (!workspaceId) return;
    setConnecting(true);
    try {
      const r = await openEmailInboxOAuth(provider, workspaceId);
      if (r.result === 'error') Alert.alert('Could not connect', r.reason.replace(/_/g, ' '));
      if (r.result === 'success') await reloadAfterOAuth();
      else await load();
    } catch (e) {
      Alert.alert('Could not connect', emailApiError(e, 'Try again'));
    } finally {
      setConnecting(false);
    }
  };

  const startCompose = async () => {
    if (!workspaceId || composing) return;
    setComposing(true);
    try {
      const res = await composeMailboxEmail({ workspace_id: workspaceId });
      const threadId = res.thread?.id;
      if (!threadId) throw new Error('No thread');
      setFilter('drafts');
      router.push({
        pathname: '/email-sync/thread/[id]',
        params: {
          id: String(threadId),
          workspaceId: String(workspaceId),
          filter: 'drafts',
          compose: '1',
        },
      } as any);
    } catch (e) {
      Alert.alert('Email', emailApiError(e, 'Could not start a new email'));
    } finally {
      setComposing(false);
    }
  };

  const exitSelect = () => {
    setSelectMode(false);
    setSelected([]);
  };

  const toggleSelect = (id: number) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const styles = useMemo(
    () =>
      StyleSheet.create({
        safe: { flex: 1, backgroundColor: colors.headerBackground },
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, paddingBottom: 4, backgroundColor: colors.headerBackground },
        iconBtn: { padding: 10 },
        pills: {
          flexDirection: 'row',
          marginHorizontal: 16,
          marginBottom: 8,
          backgroundColor: colors.isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
          borderRadius: 10,
          padding: 3,
        },
        pill: { flex: 1, paddingVertical: 7, borderRadius: 8, alignItems: 'center' },
        pillOn: { backgroundColor: colors.surface },
        pillTxt: { fontSize: 12, fontWeight: '600', color: colors.textSecondary },
        pillTxtOn: { color: colors.text },
        selectBar: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingVertical: 8,
          gap: 12,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        },
        row: {
          flexDirection: 'row',
          alignItems: 'flex-start',
          paddingHorizontal: 16,
          paddingVertical: 12,
          backgroundColor: colors.background,
        },
        statusDot: {
          width: 8,
          height: 8,
          borderRadius: 4,
          marginTop: 7,
          marginRight: 10,
        },
        check: {
          width: 22,
          height: 22,
          borderRadius: 4,
          borderWidth: 2,
          borderColor: '#007AFF',
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 1,
          marginRight: 10,
        },
        body: { flex: 1, minWidth: 0 },
        top: { flexDirection: 'row', alignItems: 'baseline', marginBottom: 2 },
        subject: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.text },
        when: { fontSize: 11, color: colors.textSecondary, marginLeft: 8 },
        swipe: { justifyContent: 'center', width: 88, alignItems: 'center' },
        emptyWrap: { paddingHorizontal: 28, paddingTop: 48, alignItems: 'center' },
        emptyTitle: { fontSize: 22, fontWeight: '700', color: colors.text, textAlign: 'center' },
        emptySub: { fontSize: 15, color: colors.textSecondary, textAlign: 'center', marginTop: 8, lineHeight: 22 },
        provider: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          width: '100%',
          marginTop: 12,
          backgroundColor: colors.surface,
          borderRadius: 14,
          padding: 16,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
        },
        providerTxt: { fontSize: 16, fontWeight: '600', color: colors.text },
      }),
    [colors]
  );

  const openThread = (t: EmailThread) => {
    if (selectMode) {
      toggleSelect(t.id);
      return;
    }
    router.push({
      pathname: '/email-sync/thread/[id]',
      params: { id: String(t.id), workspaceId: String(workspaceId || ''), filter },
    } as any);
  };

  const renderItem = ({ item }: { item: EmailThread }) => {
    const on = selected.includes(item.id);
    return (
      <Swipeable
        ref={(ref) => {
          if (ref) swipeRefs.current.set(item.id, ref);
          else swipeRefs.current.delete(item.id);
        }}
        enabled={!selectMode && filter !== 'drafts'}
        overshootRight={false}
        overshootLeft={false}
        renderRightActions={() => (
          <TouchableOpacity
            style={[styles.swipe, { backgroundColor: filter === 'dismissed' ? '#007AFF' : '#8E8E93' }]}
            onPress={async () => {
              swipeRefs.current.get(item.id)?.close();
              try {
                if (filter === 'dismissed') await undismissMailboxThread(item.id);
                else await dismissMailboxThread(item.id);
                await load();
              } catch (e) {
                Alert.alert('Inbox', emailApiError(e, 'Action failed'));
              }
            }}
          >
            <Ionicons name={filter === 'dismissed' ? 'arrow-undo' : 'close-circle'} size={22} color="#fff" />
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12, marginTop: 4 }}>
              {filter === 'dismissed' ? 'Restore' : 'Dismiss'}
            </Text>
          </TouchableOpacity>
        )}
        renderLeftActions={
          filter === 'dismissed'
            ? undefined
            : () => (
                <TouchableOpacity
                  style={[styles.swipe, { backgroundColor: '#F59E0B' }]}
                  onPress={() => {
                    swipeRefs.current.get(item.id)?.close();
                    confirmCloseMailboxThread(item.id, load);
                  }}
                >
                  <Ionicons name="archive" size={22} color="#fff" />
                  <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12, marginTop: 4 }}>Close</Text>
                </TouchableOpacity>
              )
        }
      >
        <TouchableOpacity
          style={[styles.row, on && { backgroundColor: colors.isDark ? '#1e3a5f33' : '#E8F1FF' }]}
          onPress={() => openThread(item)}
          onLongPress={() => {
            if (filter === 'dismissed') return;
            setSelectMode(true);
            setSelected([item.id]);
          }}
          activeOpacity={0.7}
        >
          {selectMode ? (
            <View style={[styles.check, on && { backgroundColor: '#007AFF' }]}>
              {on ? <Ionicons name="checkmark" size={14} color="#fff" /> : null}
            </View>
          ) : (
            <View style={[styles.statusDot, { backgroundColor: threadStatusDotColor(item) }]} />
          )}
          <View style={styles.body}>
            <View style={styles.top}>
              <Text style={styles.subject} numberOfLines={1}>
                {item.draft_preview?.reply_mode === 'new' || item.provider_thread_id?.startsWith('compose-')
                  ? item.subject || 'New message'
                  : item.subject || '(no subject)'}
              </Text>
              <Text style={styles.when}>
                {formatEmailWhen(filter === 'dismissed' ? item.dismissed_at || item.last_message_at : item.last_message_at)}
              </Text>
            </View>
            {filter === 'drafts' && (item.draft_preview?.to?.length || item.draft_preview?.reply_mode === 'new') ? (
              <Text style={{ fontSize: 12, color: colors.textSecondary }} numberOfLines={1}>
                {item.draft_preview?.reply_mode === 'new' ? 'New message' : 'Reply draft'}
                {item.draft_preview?.to?.length ? ` · ${item.draft_preview.to.join(', ')}` : ''}
              </Text>
            ) : null}
            <AttachmentNamesRow attachments={item.attachments} names={item.attachment_names} />
          </View>
        </TouchableOpacity>
      </Swipeable>
    );
  };

  const emptyInbox = hasMailbox === false;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        {selectMode ? (
          <FeedbackTouchable onPress={exitSelect} accessibilityLabel="Cancel" style={styles.iconBtn}>
            <Ionicons name="close" size={28} color={colors.text} />
          </FeedbackTouchable>
        ) : (
          <AppBackButton />
        )}
        <AppHeaderTitle>{selectMode ? `${selected.length} selected` : 'Email Sync'}</AppHeaderTitle>
        {selectMode && filter !== 'dismissed' ? (
          <FeedbackTouchable
            style={styles.iconBtn}
            onPress={async () => {
              if (!selected.length) return;
              try {
                await dismissMailboxThreads(selected);
                exitSelect();
                await load();
              } catch (e) {
                Alert.alert('Dismiss', emailApiError(e, 'Could not dismiss'));
              }
            }}
          >
            <Ionicons name="close-circle-outline" size={24} color={colors.text} />
          </FeedbackTouchable>
        ) : tab === 'replies' && hasMailbox && !selectMode ? (
          <FeedbackTouchable
            style={styles.iconBtn}
            onPress={() => void startCompose()}
            disabled={!canSend || composing}
            accessibilityLabel="Compose"
          >
            <Ionicons name="create-outline" size={24} color={canSend ? colors.text : colors.textSecondary} />
          </FeedbackTouchable>
        ) : (
          <View style={{ width: 44 }} />
        )}
      </View>
      {!selectMode ? <EmailSyncTopTabs active={tab} pendingCount={pending} onChange={selectTab} /> : null}

      {workspaceId && (visited.setup || tab === 'setup') ? (
        <View style={{ flex: 1, display: tab === 'setup' ? 'flex' : 'none', backgroundColor: colors.background }}>
          <EmailSetupPane workspaceId={workspaceId} onPending={setPending} />
        </View>
      ) : null}

      {workspaceId && (visited.imports || tab === 'imports') ? (
        <View style={{ flex: 1, display: tab === 'imports' ? 'flex' : 'none', backgroundColor: colors.background }}>
          <EmailImportsPane workspaceId={workspaceId} onPending={setPending} />
        </View>
      ) : null}

      <View style={{ flex: 1, display: tab === 'replies' ? 'flex' : 'none', backgroundColor: colors.background }}>
      {undo && tab === 'replies' ? (
        <View style={{ marginHorizontal: 16, marginBottom: 8, padding: 10, borderRadius: 10, backgroundColor: colors.isDark ? '#3b2f1a' : '#FEF3C7', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ color: colors.isDark ? '#FDE68A' : '#92400E', fontSize: 13, flex: 1 }}>
            Sending in {formatRemainingCountdown(undoLeft, undo.maxSecs)}
          </Text>
          <TouchableOpacity
            onPress={async () => {
              try {
                await undoMailboxSend(undo.pendingId);
                emailSyncClearUndo();
                await load();
              } catch {
                emailSyncClearUndo();
                Alert.alert('Undo', 'Too late — already sending or sent.');
              }
            }}
          >
            <Text style={{ color: '#007AFF', fontWeight: '700' }}>Undo</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {hasMailbox ? (
        <View style={styles.pills}>
          {FILTERS.map((f) => {
            const on = filter === f.id;
            const label = f.id === 'pending' && pending > 0 ? `${f.label} ${pending}` : f.label;
            return (
              <TouchableOpacity
                key={f.id}
                style={[styles.pill, on && styles.pillOn]}
                onPress={() => {
                  exitSelect();
                  setFilter(f.id);
                }}
              >
                <Text style={[styles.pillTxt, on && styles.pillTxtOn]}>{label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}

      {selectMode && filter !== 'dismissed' ? (
        <View style={styles.selectBar}>
          <Text style={{ color: colors.textSecondary, flex: 1, fontSize: 13 }}>Long-press to select · swipe to dismiss one</Text>
          <TouchableOpacity
            onPress={async () => {
              if (!selected.length) return;
              await dismissMailboxThreads(selected);
              exitSelect();
              await load();
            }}
          >
            <Text style={{ color: '#007AFF', fontWeight: '700' }}>Dismiss</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {loading && hasMailbox === null ? (
        <ActivityIndicator style={{ marginTop: 40 }} color="#007AFF" />
      ) : emptyInbox ? (
        <View style={styles.emptyWrap}>
          <Ionicons name="mail-open-outline" size={48} color={colors.textSecondary} />
          <Text style={[styles.emptyTitle, { marginTop: 16 }]}>Reply from your phone</Text>
          <Text style={styles.emptySub}>
            Connect Gmail or Outlook. We’ll surface mail that needs a reply — swipe to finish it.
          </Text>
          <TouchableOpacity style={styles.provider} onPress={() => connect('gmail')} disabled={connecting}>
            <GoogleLogo size={22} />
            <Text style={styles.providerTxt}>{connecting ? 'Connecting…' : 'Continue with Google'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.provider} onPress={() => connect('outlook')} disabled={connecting}>
            <MicrosoftLogo size={22} />
            <Text style={styles.providerTxt}>Continue with Microsoft</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => selectTab('setup')} style={{ marginTop: 20 }}>
            <Text style={{ color: '#007AFF', fontWeight: '600' }}>Use a forwarding alias instead</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={threads}
          keyExtractor={(t) => String(t.id)}
          renderItem={renderItem}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ItemSeparatorComponent={() => (
            <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: 34 }} />
          )}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyTitle}>
                {filter === 'pending'
                  ? 'You’re caught up'
                  : filter === 'dismissed'
                    ? 'Nothing dismissed'
                    : filter === 'drafts'
                      ? 'No unsent drafts'
                      : 'Nothing to review'}
              </Text>
              <Text style={styles.emptySub}>
                {filter === 'pending'
                  ? 'Pull down to sync. Swipe left to dismiss, right to close. Long-press to multi-select.'
                  : filter === 'drafts'
                    ? 'Compose a new email, or drafts from Clients and AI replies appear here until you send or discard them.'
                    : 'Pull down to sync.'}
              </Text>
              {filter === 'drafts' ? (
                <TouchableOpacity
                  onPress={() => void startCompose()}
                  disabled={!canSend || composing}
                  style={{ marginTop: 16, backgroundColor: '#2563EB', borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10 }}
                >
                  <Text style={{ color: '#fff', fontWeight: '700' }}>{composing ? 'Opening…' : 'Compose'}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          }
        />
      )}
      </View>
    </SafeAreaView>
  );
}

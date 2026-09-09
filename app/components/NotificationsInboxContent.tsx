import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useScrollRestoresHeaderProps } from '../../contexts/HeaderVisibilityContext';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiClient } from '../../services/api';
import { resolveSignatureRoute } from '../../utils/signatureRouteResolver';
import { useAuth } from '../context/auth';
import { getNotificationScreen, parseNotificationPath, getEmailReplyComposeScreen } from '../services/pushNotifications';
import { formatUtcIsoForDevice } from '../../utils/calendarTime';
import { AnimatedHeaderContainer } from './AnimatedHeaderContainer';
import AppHeaderTitle from '../../components/AppHeaderTitle';

export interface AppNotification {
  id: number;
  title: string;
  message: string;
  type: string;
  read: boolean;
  created_at: string;
  metadata?: {
    action_type?: string;
    navigation_path?: string;
    has_actions?: boolean;
    share_id?: number;
    file_id?: number;
    file_name?: string;
    sender_name?: string;
    invitation_id?: number;
    inviter_name?: string;
    role?: string;
    video_call_id?: number;
    join_request_id?: number;
    room_name?: string;
    [key: string]: any;
  };
}

export type NotificationsInboxVariant = 'screen' | 'modal';

export interface NotificationsInboxContentProps {
  variant: NotificationsInboxVariant;
  /** Close button / secondary dismiss (modal only) */
  onDismiss?: () => void;
  /** Home badge / parent refresh after list changes */
  onListMutated?: () => void;
}

export function NotificationsInboxContent({
  variant,
  onDismiss,
  onListMutated,
}: NotificationsInboxContentProps) {
  const router = useRouter();
  const { user } = useAuth();
  const colors = useThemeColors();
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [markingId, setMarkingId] = useState<number | null>(null);
  type NotificationActionState = 'accepting' | 'rejecting' | 'accepted' | 'rejected';
  const [actionState, setActionState] = useState<Record<number, NotificationActionState>>({});
  const inboxHeaderScrollRestore = useScrollRestoresHeaderProps();

  const loadNotifications = useCallback(async () => {
    if (!user) {
      setNotifications([]);
      setUnreadCount(0);
      setLoading(false);
      setRefreshing(false);
      return;
    }
    try {
      const res = await apiClient.getNotifications();
      if (res?.success && res?.data) {
        const list = res.data.notifications ?? [];
        const withoutChat = list.filter((n: AppNotification) => n.type !== 'chat_message');
        const count = withoutChat.filter((n: AppNotification) => !n.read).length;
        setNotifications(withoutChat);
        setUnreadCount(count);
      } else {
        setNotifications([]);
        setUnreadCount(0);
      }
    } catch {
      setNotifications([]);
      setUnreadCount(0);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user]);

  useEffect(() => {
    loadNotifications();
  }, [loadNotifications]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadNotifications();
  }, [loadNotifications]);

  const markAsRead = useCallback(
    async (id: number) => {
      setMarkingId(id);
      try {
        await apiClient.markNotificationRead(id);
        setNotifications((prev) =>
          prev.map((n) => (n.id === id ? { ...n, read: true } : n))
        );
        setUnreadCount((c) => Math.max(0, c - 1));
        onListMutated?.();
      } finally {
        setMarkingId(null);
      }
    },
    [onListMutated]
  );

  const markAllAsRead = useCallback(async () => {
    if (unreadCount === 0) return;
    try {
      await apiClient.markAllNotificationsRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      setUnreadCount(0);
      onListMutated?.();
    } catch {
      // ignore
    }
  }, [unreadCount, onListMutated]);

  const clearAll = useCallback(async () => {
    if (notifications.length === 0) return;
    try {
      await apiClient.clearAllNotifications();
      setNotifications([]);
      setUnreadCount(0);
      onListMutated?.();
    } catch {
      // ignore
    }
  }, [notifications.length, onListMutated]);

  const isEmailReplyNotification = (n: AppNotification) => {
    const meta = n.metadata;
    return (
      (n.type === 'inbound_email' || meta?.action_type === 'email_reply') &&
      Boolean(meta?.has_actions) &&
      meta?.action_type === 'email_reply' &&
      (meta?.thread_id != null || meta?.threadId != null || Boolean(meta?.screen))
    );
  };

  const resolveNotificationPath = useCallback((n: AppNotification) => {
    const meta = n.metadata || {};
    // Prefer mobile `screen` / type resolver — web `navigation_path` is not valid in Expo.
    if (n.type === 'inbound_email' || meta.action_type === 'email_reply') {
      return getNotificationScreen({ type: n.type || 'inbound_email', ...meta });
    }
    if (meta.navigation_path) {
      const p = String(meta.navigation_path);
      return p.startsWith('/') ? p : `/${p}`;
    }
    return getNotificationScreen({ type: n.type, ...meta });
  }, []);

  const navigateFromNotification = useCallback(
    (n: AppNotification) => {
      if (!n.read) markAsRead(n.id);
      let path = resolveNotificationPath(n);
      if (path.startsWith('/calendar/event/')) {
        path = path.replace('/calendar/event/', '/calendar/');
      }
      if (path === '/notifications') return;
      if (variant === 'modal') onDismiss?.();
      try {
        if (path.includes('signatures') || n.type.startsWith('signature_')) {
          router.push(
            resolveSignatureRoute({
              navigation_path: path,
              envelopeId: n.metadata?.envelope_id as string | undefined,
              public_id: n.metadata?.public_id as string | undefined,
              token: n.metadata?.token as string | undefined,
              type: n.metadata?.action as string | undefined,
            }) as any,
          );
          return;
        }
        const { pathname, params } = parseNotificationPath(path);
        if (params && Object.keys(params).length > 0) {
          router.push({ pathname, params } as any);
        } else {
          router.push(pathname as any);
        }
      } catch {
        router.push('/notifications' as any);
      }
    },
    [markAsRead, resolveNotificationPath, router, variant, onDismiss]
  );

  const handleNotificationPress = useCallback(
    (n: AppNotification) => {
      // Invites / join requests use their own buttons; email Reply uses the Reply button (or row tap).
      if (n.metadata?.has_actions && !isEmailReplyNotification(n)) return;
      navigateFromNotification(n);
    },
    [navigateFromNotification]
  );

  const handleEmailReply = useCallback(
    (n: AppNotification) => {
      if (!n.read) markAsRead(n.id);
      let path = getEmailReplyComposeScreen({ type: n.type || 'inbound_email', ...(n.metadata || {}) });
      if (path.startsWith('/calendar/event/')) {
        path = path.replace('/calendar/event/', '/calendar/');
      }
      if (variant === 'modal') onDismiss?.();
      try {
        if (path.includes('signatures') || n.type.startsWith('signature_')) {
          router.push(
            resolveSignatureRoute({
              navigation_path: path,
              envelopeId: n.metadata?.envelope_id as string | undefined,
              public_id: n.metadata?.public_id as string | undefined,
              token: n.metadata?.token as string | undefined,
              type: n.metadata?.action as string | undefined,
            }) as any,
          );
          return;
        }
        const { pathname, params } = parseNotificationPath(path);
        if (params && Object.keys(params).length > 0) {
          router.push({ pathname, params } as any);
        } else {
          router.push(pathname as any);
        }
      } catch {
        router.push('/notifications' as any);
      }
    },
    [markAsRead, onDismiss, router, variant]
  );

  const finalizeSuccessfulAction = useCallback(
    (notificationId: number, outcome: 'accepted' | 'rejected', afterRemove?: () => void) => {
      setActionState((prev) => ({ ...prev, [notificationId]: outcome }));
      setNotifications((prev) =>
        prev.map((n2) =>
          n2.id === notificationId
            ? {
                ...n2,
                read: true,
                metadata: {
                  ...(n2.metadata || {}),
                  has_actions: false,
                  action_status: outcome,
                },
              }
            : n2
        )
      );
      setUnreadCount((c) => Math.max(0, c - 1));
      onListMutated?.();
      setTimeout(() => {
        setNotifications((prev) => prev.filter((n2) => n2.id !== notificationId));
        setActionState((prev) => {
          const next = { ...prev };
          delete next[notificationId];
          return next;
        });
        afterRemove?.();
      }, 800);
    },
    [onListMutated]
  );

  const handleAcceptFileInvite = useCallback(
    async (n: AppNotification) => {
      const shareId = n.metadata?.share_id;
      if (shareId == null || actionState[n.id]) return;
      setActionState((prev) => ({ ...prev, [n.id]: 'accepting' }));
      try {
        await apiClient.acceptFileShare(shareId);
        try {
          await apiClient.markNotificationRead(n.id);
        } catch {
          // Best-effort: home badge will refresh on next dashboard load
        }
        finalizeSuccessfulAction(n.id, 'accepted', () => {
          if (variant === 'modal') onDismiss?.();
          router.navigate('/(tabs)/documents');
        });
      } catch (err: any) {
        setActionState((prev) => {
          const next = { ...prev };
          delete next[n.id];
          return next;
        });
        alert(err?.message || 'Failed to accept invite');
      }
    },
    [actionState, router, variant, onDismiss, finalizeSuccessfulAction]
  );

  const handleRejectFileInvite = useCallback(
    async (n: AppNotification) => {
      const shareId = n.metadata?.share_id;
      if (shareId == null || actionState[n.id]) return;
      setActionState((prev) => ({ ...prev, [n.id]: 'rejecting' }));
      try {
        await apiClient.rejectFileShare(shareId);
        try {
          await apiClient.markNotificationRead(n.id);
        } catch {
          // Best-effort
        }
        finalizeSuccessfulAction(n.id, 'rejected');
      } catch (err: any) {
        setActionState((prev) => {
          const next = { ...prev };
          delete next[n.id];
          return next;
        });
        alert(err?.message || 'Failed to reject invite');
      }
    },
    [actionState, finalizeSuccessfulAction]
  );

  const isDraftOrFileInvite = (n: AppNotification) => {
    const isInvite =
      n.type === 'draft_invite' ||
      n.type === 'file_invite' ||
      n.type === 'file_received' ||
      n.type === 'file_share' ||
      n.metadata?.action_type === 'draft_invite' ||
      n.metadata?.action_type === 'file_invite' ||
      n.metadata?.action_type === 'file_share';
    if (!isInvite || n.metadata?.share_id == null) return false;
    const status = n.metadata?.action_status;
    if (status === 'accepted' || status === 'rejected') return false;
    // Hide after accept/reject clears has_actions; keep showing for actionable invites.
    return Boolean(n.metadata?.has_actions);
  };

  const isWorkspaceInvitation = (n: AppNotification) => {
    const isInvite =
      n.type === 'workspace_invite' ||
      n.type === 'workspace_invitation' ||
      n.metadata?.action_type === 'workspace_invite' ||
      n.metadata?.action_type === 'workspace_invitation';
    if (!isInvite || n.metadata?.invitation_id == null) return false;
    const status = n.metadata?.action_status;
    if (status === 'accepted' || status === 'rejected') return false;
    return Boolean(n.metadata?.has_actions);
  };

  const isJoinRequest = (n: AppNotification) => {
    const isJoin =
      (n.type === 'join_request' || n.metadata?.action_type === 'join_request') &&
      n.metadata?.video_call_id != null &&
      n.metadata?.join_request_id != null;
    if (!isJoin) return false;
    const status = n.metadata?.action_status;
    if (status === 'accepted' || status === 'rejected') return false;
    return Boolean(n.metadata?.has_actions);
  };

  const handleAcceptWorkspaceInvitation = useCallback(
    async (n: AppNotification) => {
      const invitationId = n.metadata?.invitation_id;
      if (invitationId == null || actionState[n.id]) return;
      setActionState((prev) => ({ ...prev, [n.id]: 'accepting' }));
      try {
        await apiClient.acceptWorkspaceInvitation(invitationId);
        try {
          await apiClient.markNotificationRead(n.id);
        } catch {
          // Best-effort
        }
        finalizeSuccessfulAction(n.id, 'accepted');
      } catch (err: any) {
        setActionState((prev) => {
          const next = { ...prev };
          delete next[n.id];
          return next;
        });
        alert(err?.message || 'Failed to accept workspace invitation');
      }
    },
    [actionState, finalizeSuccessfulAction]
  );

  const handleRejectWorkspaceInvitation = useCallback(
    async (n: AppNotification) => {
      const invitationId = n.metadata?.invitation_id;
      if (invitationId == null || actionState[n.id]) return;
      setActionState((prev) => ({ ...prev, [n.id]: 'rejecting' }));
      try {
        await apiClient.rejectWorkspaceInvitation(invitationId);
        try {
          await apiClient.markNotificationRead(n.id);
        } catch {
          // Best-effort
        }
        finalizeSuccessfulAction(n.id, 'rejected');
      } catch (err: any) {
        setActionState((prev) => {
          const next = { ...prev };
          delete next[n.id];
          return next;
        });
        alert(err?.message || 'Failed to reject workspace invitation');
      }
    },
    [actionState, finalizeSuccessfulAction]
  );

  const handleAcceptJoinRequest = useCallback(
    async (n: AppNotification) => {
      const videoCallId = n.metadata?.video_call_id;
      const joinRequestId = n.metadata?.join_request_id;
      if (videoCallId == null || joinRequestId == null || actionState[n.id]) return;
      setActionState((prev) => ({ ...prev, [n.id]: 'accepting' }));
      try {
        await apiClient.approveJoinRequest(Number(videoCallId), Number(joinRequestId));
        try {
          await apiClient.markNotificationRead(n.id);
        } catch {
          // Best-effort
        }
        finalizeSuccessfulAction(n.id, 'accepted');
      } catch (err: any) {
        setActionState((prev) => {
          const next = { ...prev };
          delete next[n.id];
          return next;
        });
        alert(err?.message || 'Failed to approve join request');
      }
    },
    [actionState, finalizeSuccessfulAction]
  );

  const handleRejectJoinRequest = useCallback(
    async (n: AppNotification) => {
      const videoCallId = n.metadata?.video_call_id;
      const joinRequestId = n.metadata?.join_request_id;
      if (videoCallId == null || joinRequestId == null || actionState[n.id]) return;
      setActionState((prev) => ({ ...prev, [n.id]: 'rejecting' }));
      try {
        await apiClient.rejectJoinRequest(Number(videoCallId), Number(joinRequestId));
        try {
          await apiClient.markNotificationRead(n.id);
        } catch {
          // Best-effort
        }
        finalizeSuccessfulAction(n.id, 'rejected');
      } catch (err: any) {
        setActionState((prev) => {
          const next = { ...prev };
          delete next[n.id];
          return next;
        });
        alert(err?.message || 'Failed to reject join request');
      }
    },
    [actionState, finalizeSuccessfulAction]
  );

  const dynamicStyles = StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: variant === 'modal' ? 12 : 16,
      paddingVertical: variant === 'modal' ? 10 : 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      // Modal sheet wrapper uses `colors.card`; match it so the header is not a different plane than the rest of the popup.
      backgroundColor: variant === 'modal' ? colors.card : colors.headerBackground,
    },
    headerTitle: {
      fontSize: variant === 'modal' ? 17 : 18,
      fontWeight: '600',
      color: colors.text,
      flex: 1,
      textAlign: 'center',
      marginHorizontal: 8,
    },
    markAll: { color: '#007AFF', fontSize: variant === 'modal' ? 14 : 16 },
    empty: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingVertical: variant === 'modal' ? 36 : 48,
      paddingHorizontal: 16,
    },
    emptyText: { fontSize: 16, color: colors.textSecondary, textAlign: 'center' },
    row: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      padding: variant === 'modal' ? 12 : 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      backgroundColor: variant === 'modal' ? colors.card : colors.background,
    },
    // Full screen: unread uses elevated card. Modal: same card base, surface tint for unread so rows stay aligned with the sheet.
    rowUnread: {
      backgroundColor: variant === 'modal' ? colors.surface : colors.card,
    },
    iconWrap: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.border,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 12,
    },
    body: { flex: 1 },
    title: { fontSize: 16, fontWeight: '600', color: colors.text, marginBottom: 4 },
    message: { fontSize: 14, color: colors.textSecondary },
    time: { fontSize: 12, color: colors.textSecondary, marginTop: 6 },
  });

  const headerLeft = (
    <TouchableOpacity
      onPress={() => (variant === 'modal' ? onDismiss?.() : router.back())}
      style={{ padding: 8 }}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
    >
      <Ionicons
        name={variant === 'modal' ? 'close' : 'arrow-back'}
        size={24}
        color={colors.text}
      />
    </TouchableOpacity>
  );

  const headerActions = (
    <View style={{ flexDirection: 'row', gap: variant === 'modal' ? 10 : 16, alignItems: 'center' }}>
      {notifications.length > 0 && (
        <TouchableOpacity onPress={clearAll}>
          <Text style={[dynamicStyles.markAll, { color: '#FF3B30' }]}>Clear all</Text>
        </TouchableOpacity>
      )}
      {unreadCount > 0 && (
        <TouchableOpacity onPress={markAllAsRead}>
          <Text style={dynamicStyles.markAll}>Mark all read</Text>
        </TouchableOpacity>
      )}
      {notifications.length === 0 && unreadCount === 0 && <View style={{ width: variant === 'modal' ? 24 : 80 }} />}
    </View>
  );

  const headerRow = (
    <View style={dynamicStyles.header}>
      {headerLeft}
      {variant === 'screen' ? (
        <AppHeaderTitle>Notifications</AppHeaderTitle>
      ) : (
        <AppHeaderTitle fill={false} style={{ flex: 1 }}>Notifications</AppHeaderTitle>
      )}
      {headerActions}
    </View>
  );

  const listBody =
    loading ? (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    ) : (
      <ScrollView
        style={variant === 'modal' ? styles.listModal : styles.list}
        contentContainerStyle={notifications.length === 0 ? styles.emptyContainer : undefined}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        onScrollEndDrag={inboxHeaderScrollRestore.onScrollEndDrag}
        onMomentumScrollEnd={inboxHeaderScrollRestore.onMomentumScrollEnd}
      >
        {notifications.length === 0 ? (
          <View style={dynamicStyles.empty}>
            <Ionicons name="notifications-off-outline" size={48} color={colors.textSecondary} />
            <Text style={[dynamicStyles.emptyText, { marginTop: 12 }]}>No notifications yet.</Text>
          </View>
        ) : (
          notifications.map((n) => (
            <TouchableOpacity
              key={n.id}
              style={[dynamicStyles.row, !n.read && dynamicStyles.rowUnread]}
              onPress={() => handleNotificationPress(n)}
              activeOpacity={0.7}
            >
              <View style={dynamicStyles.iconWrap}>
                <Ionicons
                  name={
                    n.type === 'success'
                      ? 'checkmark-circle'
                      : n.type === 'warning'
                        ? 'warning'
                        : n.type === 'error'
                          ? 'alert-circle'
                          : n.type === 'join_request'
                            ? 'people'
                            : n.type === 'inbound_email'
                              ? 'mail-outline'
                              : 'notifications'
                  }
                  size={22}
                  color={n.read ? colors.textSecondary : '#007AFF'}
                />
              </View>
              <View style={dynamicStyles.body}>
                <Text style={dynamicStyles.title} numberOfLines={1}>
                  {n.title}
                </Text>
                <Text style={dynamicStyles.message} numberOfLines={2}>
                  {n.message}
                </Text>
                <Text style={dynamicStyles.time}>
                  {n.created_at
                    ? formatUtcIsoForDevice(n.created_at, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : ''}
                </Text>
                {(() => {
                  const state = actionState[n.id];
                  if (state === 'accepting' || state === 'rejecting') {
                    return (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
                        <ActivityIndicator size="small" color="#007AFF" />
                        <Text style={[dynamicStyles.time, { marginTop: 0 }]}>
                          {state === 'accepting' ? 'Accepting…' : 'Rejecting…'}
                        </Text>
                      </View>
                    );
                  }
                  if (state === 'accepted' || state === 'rejected') {
                    return (
                      <Text
                        style={[
                          dynamicStyles.time,
                          {
                            marginTop: 4,
                            color: state === 'accepted' ? '#34C759' : '#FF3B30',
                            fontWeight: '600',
                          },
                        ]}
                      >
                        {state === 'accepted' ? '✓ Accepted' : '✗ Rejected'}
                      </Text>
                    );
                  }
                  if (isDraftOrFileInvite(n)) {
                    return (
                      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                        <TouchableOpacity
                          onPress={() => handleAcceptFileInvite(n)}
                          style={[styles.actionBtn, { backgroundColor: '#34C759' }]}
                        >
                          <Ionicons name="checkmark" size={18} color="#fff" />
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => handleRejectFileInvite(n)}
                          style={[styles.actionBtn, { backgroundColor: '#FF3B30' }]}
                        >
                          <Ionicons name="close" size={18} color="#fff" />
                        </TouchableOpacity>
                      </View>
                    );
                  }
                  if (isWorkspaceInvitation(n)) {
                    return (
                      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                        <TouchableOpacity
                          onPress={() => handleAcceptWorkspaceInvitation(n)}
                          style={[styles.actionBtn, { backgroundColor: '#34C759' }]}
                        >
                          <Ionicons name="checkmark" size={18} color="#fff" />
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => handleRejectWorkspaceInvitation(n)}
                          style={[styles.actionBtn, { backgroundColor: '#FF3B30' }]}
                        >
                          <Ionicons name="close" size={18} color="#fff" />
                        </TouchableOpacity>
                      </View>
                    );
                  }
                  if (isJoinRequest(n)) {
                    return (
                      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                        <TouchableOpacity
                          onPress={() => handleAcceptJoinRequest(n)}
                          style={[styles.actionBtn, { backgroundColor: '#34C759' }]}
                          accessibilityLabel="Accept join request"
                        >
                          <Ionicons name="checkmark" size={18} color="#fff" />
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => handleRejectJoinRequest(n)}
                          style={[styles.actionBtn, { backgroundColor: '#FF3B30' }]}
                          accessibilityLabel="Reject join request"
                        >
                          <Ionicons name="close" size={18} color="#fff" />
                        </TouchableOpacity>
                      </View>
                    );
                  }
                  if (isEmailReplyNotification(n)) {
                    return (
                      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                        <TouchableOpacity
                          onPress={(e) => {
                            // Nested inside row TouchableOpacity — stop bubbling on RN where supported.
                            (e as any)?.stopPropagation?.();
                            handleEmailReply(n);
                          }}
                          style={styles.replyBtn}
                          accessibilityLabel="Reply to email"
                        >
                          <Text style={styles.replyBtnText}>Reply</Text>
                        </TouchableOpacity>
                      </View>
                    );
                  }
                  return null;
                })()}
              </View>
              {!n.read && (
                <View style={styles.unreadDot}>
                  <View style={[styles.unreadDotInner, { backgroundColor: '#007AFF' }]} />
                </View>
              )}
              {markingId === n.id && (
                <ActivityIndicator size="small" color="#007AFF" style={{ marginLeft: 8 }} />
              )}
            </TouchableOpacity>
          ))
        )}
      </ScrollView>
    );

  if (variant === 'screen') {
    return (
      <>
        <AnimatedHeaderContainer>{headerRow}</AnimatedHeaderContainer>
        {listBody}
      </>
    );
  }

  return <View style={styles.modalRoot}>{headerRow}{listBody}</View>;
}

const styles = StyleSheet.create({
  modalRoot: { flex: 1 },
  list: { flex: 1 },
  listModal: { flexGrow: 1, flexShrink: 1, minHeight: 200 },
  emptyContainer: { flexGrow: 1, minHeight: 200 },
  centered: {
    minHeight: 120,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 24,
  },
  actionBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  replyBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#111827',
    justifyContent: 'center',
    alignItems: 'center',
  },
  replyBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  unreadDot: {
    width: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadDotInner: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});

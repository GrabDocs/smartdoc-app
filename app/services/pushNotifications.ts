import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { apiClient } from '../../services/api';
import { resolveAppDeepLinkPath } from '../../utils/resolveAppDeepLinkPath';

/** iOS category + action identifiers for meeting join-request lock-screen buttons. */
export const JOIN_REQUEST_NOTIFICATION_CATEGORY = 'join_request';
export const JOIN_REQUEST_ACTION_ACCEPT = 'ACCEPT_JOIN_REQUEST';
export const JOIN_REQUEST_ACTION_REJECT = 'REJECT_JOIN_REQUEST';

/** iOS/Android category for single-email reply lock-screen button. */
export const EMAIL_REPLY_NOTIFICATION_CATEGORY = 'email_reply';
export const EMAIL_REPLY_ACTION_REPLY = 'REPLY_TO_EMAIL';

export function isJoinRequestNotificationAction(actionIdentifier: string): boolean {
  return (
    actionIdentifier === JOIN_REQUEST_ACTION_ACCEPT ||
    actionIdentifier === JOIN_REQUEST_ACTION_REJECT
  );
}

export function isEmailReplyNotificationAction(actionIdentifier: string): boolean {
  return actionIdentifier === EMAIL_REPLY_ACTION_REPLY;
}

/** Approve/reject a join request from a push notification action button. */
export async function executeJoinRequestNotificationAction(
  actionIdentifier: string,
  data: Record<string, any>,
): Promise<'accepted' | 'rejected'> {
  const videoCallId = data?.video_call_id ?? data?.room_id;
  const joinRequestId = data?.join_request_id;
  if (videoCallId == null || joinRequestId == null) {
    throw new Error('Missing join request details');
  }
  if (actionIdentifier === JOIN_REQUEST_ACTION_ACCEPT) {
    await apiClient.approveJoinRequest(Number(videoCallId), Number(joinRequestId));
    return 'accepted';
  }
  if (actionIdentifier === JOIN_REQUEST_ACTION_REJECT) {
    await apiClient.rejectJoinRequest(Number(videoCallId), Number(joinRequestId));
    return 'rejected';
  }
  throw new Error('Unknown join request action');
}

/** Resolve compose screen for email reply (lock screen action + in-app Reply button). */
export function getEmailReplyComposeScreen(data: Record<string, any>): string {
  const tid = data?.thread_id ?? data?.threadId;
  const ws = data?.workspace_id ?? data?.workspaceId;
  if (tid != null) {
    const q = new URLSearchParams({ threadId: String(tid), compose: '1' });
    if (ws != null) q.set('workspaceId', String(ws));
    return `/email-sync?${q.toString()}`;
  }
  return getNotificationScreen(data);
}

// Lazy-load expo-notifications so we never import it in Expo Go (SDK 53+ removed push from Expo Go).
// Importing it at top level triggers "expo-notifications was removed from Expo Go" error.
let NotificationsModule: typeof import('expo-notifications') | null = null;
async function getNotifications(): Promise<typeof import('expo-notifications') | null> {
  if (Constants.appOwnership === 'expo') return null; // Expo Go: push not supported
  if (!NotificationsModule) {
    NotificationsModule = await import('expo-notifications');
  }
  return NotificationsModule;
}

export interface PushNotificationData {
  title: string;
  body: string;
  data?: Record<string, any>;
  categoryId?: string;
  priority?: 'low' | 'normal' | 'high';
}

export interface NotificationChannel {
  id: string;
  name: string;
  description: string;
  importance: number;
  sound?: string;
  vibrationPattern?: number[];
}

class PushNotificationService {
  private pushToken: string | null = null;
  private initialized = false;

  // Configure notification behavior
  async configure() {
    if (this.initialized) return;
    const Notifications = await getNotifications();
    if (!Notifications) return;
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const data = notification.request.content.data as Record<string, unknown> | undefined;
        const type = typeof data?.type === 'string' ? data.type : '';
        // In-app banner handles these while foregrounded (same idea as chat_message).
        const suppressOsBanner =
          type === 'chat_message' ||
          type === 'workspace_meeting_started' ||
          type === 'chat_call_started' ||
          type === 'meeting_started';
        return {
          shouldShowAlert: !suppressOsBanner,
          shouldPlaySound: !suppressOsBanner,
          shouldSetBadge: !suppressOsBanner,
        };
      },
    });
    await this.registerNotificationCategories();
    this.initialized = true;
  }

  /** Register iOS/Android notification categories with inline action buttons. */
  private async registerNotificationCategories() {
    const Notifications = await getNotifications();
    if (!Notifications) return;
    await Notifications.setNotificationCategoryAsync(JOIN_REQUEST_NOTIFICATION_CATEGORY, [
      {
        identifier: JOIN_REQUEST_ACTION_ACCEPT,
        buttonTitle: 'Accept',
        options: { opensAppToForeground: true },
      },
      {
        identifier: JOIN_REQUEST_ACTION_REJECT,
        buttonTitle: 'Reject',
        options: { opensAppToForeground: true, isDestructive: true },
      },
    ]);
    await Notifications.setNotificationCategoryAsync(EMAIL_REPLY_NOTIFICATION_CATEGORY, [
      {
        identifier: EMAIL_REPLY_ACTION_REPLY,
        buttonTitle: 'Reply',
        options: { opensAppToForeground: true },
      },
    ]);
  }

  // Register for push notifications
  async registerForPushNotifications(): Promise<string | null> {
    const Notifications = await getNotifications();
    if (!Notifications) return null;
    if (!Device.isDevice) {
      console.log('Must use physical device for Push Notifications');
      return null;
    }

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      console.log('Failed to get push token for push notification!');
      return null;
    }

    try {
      const token = await Notifications.getExpoPushTokenAsync({
        projectId: Constants.expoConfig?.extra?.eas?.projectId,
      });

      this.pushToken = token.data;
      console.log('Push token:', this.pushToken);

      if (Platform.OS === 'android') {
        await this.createNotificationChannels();
      }

      return this.pushToken;
    } catch (error) {
      console.error('Error getting push token:', error);
      return null;
    }
  }

  // Create notification channels for Android
  private async createNotificationChannels() {
    const Notifications = await getNotifications();
    if (!Notifications) return;
    const channels: NotificationChannel[] = [
      {
        id: 'default',
        name: 'Default',
        description: 'Default notifications',
        importance: Notifications.AndroidImportance.HIGH,
      },
      {
        id: 'file_upload',
        name: 'File Uploads',
        description: 'Notifications about file upload status',
        importance: Notifications.AndroidImportance.HIGH,
      },
      {
        id: 'file_processing',
        name: 'File Processing',
        description: 'Notifications about file processing status',
        importance: Notifications.AndroidImportance.DEFAULT,
      },
      {
        id: 'form_responses',
        name: 'Form Responses',
        description: 'Notifications about new form responses',
        importance: Notifications.AndroidImportance.HIGH,
      },
      {
        id: 'team_chat',
        name: 'Team Chat',
        description: 'Notifications from team chat messages',
        importance: Notifications.AndroidImportance.HIGH,
      },
      {
        id: 'workspace_updates',
        name: 'Workspace Updates',
        description: 'Notifications about workspace changes',
        importance: Notifications.AndroidImportance.DEFAULT,
      },
      // Backend notification types (all 8)
      { id: 'file_request', name: 'File requests', description: 'Upload link requests', importance: Notifications.AndroidImportance.HIGH },
      { id: 'file_received', name: 'File received', description: 'Someone shared a file with you', importance: Notifications.AndroidImportance.HIGH },
      { id: 'draft_edited', name: 'Note edited', description: 'Collaborator started editing a note', importance: Notifications.AndroidImportance.HIGH },
      { id: 'calendar_invite', name: 'Calendar invite', description: 'Calendar event invitations', importance: Notifications.AndroidImportance.HIGH },
      { id: 'calendar_reminder', name: 'Calendar reminder', description: 'Upcoming calendar event reminders', importance: Notifications.AndroidImportance.HIGH },
      { id: 'file_share_viewed', name: 'File share viewed', description: 'Someone viewed your shared file', importance: Notifications.AndroidImportance.DEFAULT },
      { id: 'join_request', name: 'Join request', description: 'Meeting join requests', importance: Notifications.AndroidImportance.HIGH },
      { id: 'inbound_email', name: 'Email replies', description: 'Emails needing a reply', importance: Notifications.AndroidImportance.HIGH },
      { id: 'transcript_ready', name: 'Transcript ready', description: 'Meeting transcript is ready', importance: Notifications.AndroidImportance.DEFAULT },
    ];

    for (const channel of channels) {
      await Notifications.setNotificationChannelAsync(channel.id, {
        name: channel.name,
        description: channel.description,
        importance: channel.importance,
        sound: channel.sound,
        vibrationPattern: channel.vibrationPattern,
      });
    }
  }

  // Schedule a local notification
  async scheduleLocalNotification(notification: PushNotificationData, delay: number = 0) {
    const Notifications = await getNotifications();
    if (!Notifications) return null;
    try {
      const notificationId = await Notifications.scheduleNotificationAsync({
        content: {
          title: notification.title,
          body: notification.body,
          data: notification.data || {},
          categoryIdentifier: notification.categoryId,
          priority: await this.getPriorityValue(notification.priority),
        },
        trigger: delay > 0 ? { seconds: delay } : null,
      });

      return notificationId;
    } catch (error) {
      console.error('Error scheduling local notification:', error);
      return null;
    }
  }

  // Send push notification via backend
  async sendPushNotification(
    userIds: string[],
    notification: PushNotificationData,
    scheduleFor?: Date
  ) {
    try {
      // This would typically call your backend API
      // which would then send the push notification via Expo's push service
      const response = await fetch('/api/v1/mobile/push-notifications/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          user_ids: userIds,
          title: notification.title,
          body: notification.body,
          data: notification.data,
          channel_id: notification.categoryId || 'default',
          priority: notification.priority || 'normal',
          schedule_for: scheduleFor?.toISOString(),
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      return result;
    } catch (error) {
      console.error('Error sending push notification:', error);
      throw error;
    }
  }

  // Handle notification received while app is in foreground
  async addNotificationReceivedListener(handler: (notification: import('expo-notifications').Notification) => void) {
    const Notifications = await getNotifications();
    if (!Notifications) return { remove: () => {} };
    return Notifications.addNotificationReceivedListener(handler);
  }

  // Handle notification tapped by user
  async addNotificationResponseReceivedListener(
    handler: (response: import('expo-notifications').NotificationResponse) => void
  ) {
    const Notifications = await getNotifications();
    if (!Notifications) return { remove: () => {} };
    return Notifications.addNotificationResponseReceivedListener(handler);
  }

  // Get badge count
  async getBadgeCount(): Promise<number> {
    const Notifications = await getNotifications();
    if (!Notifications) return 0;
    try {
      return await Notifications.getBadgeCountAsync();
    } catch (error) {
      console.error('Error getting badge count:', error);
      return 0;
    }
  }

  // Set badge count
  async setBadgeCount(count: number) {
    const Notifications = await getNotifications();
    if (!Notifications) return;
    try {
      await Notifications.setBadgeCountAsync(count);
    } catch (error) {
      console.error('Error setting badge count:', error);
    }
  }

  // Clear all notifications
  async clearAllNotifications() {
    const Notifications = await getNotifications();
    if (!Notifications) return;
    try {
      await Notifications.dismissAllNotificationsAsync();
    } catch (error) {
      console.error('Error clearing notifications:', error);
    }
  }

  // Cancel scheduled notification
  async cancelNotification(notificationId: string) {
    const Notifications = await getNotifications();
    if (!Notifications) return;
    try {
      await Notifications.cancelScheduledNotificationAsync(notificationId);
    } catch (error) {
      console.error('Error canceling notification:', error);
    }
  }

  // Get permission status
  async getPermissionStatus() {
    const Notifications = await getNotifications();
    if (!Notifications) return 'undetermined';
    try {
      const { status } = await Notifications.getPermissionsAsync();
      return status;
    } catch (error) {
      console.error('Error getting permission status:', error);
      return 'undetermined';
    }
  }

  // Helper methods
  private async getPriorityValue(priority?: string): Promise<import('expo-notifications').AndroidNotificationPriority> {
    const Notifications = await getNotifications();
    if (!Notifications) return 0 as import('expo-notifications').AndroidNotificationPriority;
    switch (priority) {
      case 'low':
        return Notifications.AndroidNotificationPriority.LOW;
      case 'high':
        return Notifications.AndroidNotificationPriority.HIGH;
      default:
        return Notifications.AndroidNotificationPriority.DEFAULT;
    }
  }

  getPushToken(): string | null {
    return this.pushToken;
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}

// Notification templates for different types
export const NotificationTemplates = {
  fileUploaded: (fileName: string): PushNotificationData => ({
    title: 'File Uploaded',
    body: `${fileName} has been uploaded successfully`,
    categoryId: 'file_upload',
    priority: 'normal',
    data: { type: 'file_upload', fileName },
  }),

  fileProcessed: (fileName: string): PushNotificationData => ({
    title: 'File Processed',
    body: `${fileName} has been processed and is ready to view`,
    categoryId: 'file_processing',
    priority: 'normal',
    data: { type: 'file_processing', fileName },
  }),

  formResponse: (formName: string): PushNotificationData => ({
    title: 'New Form Response',
    body: `You received a new response for ${formName}`,
    categoryId: 'form_responses',
    priority: 'high',
    data: { type: 'form_response', formName },
  }),

  chatMessage: (senderName: string, message: string): PushNotificationData => ({
    title: `Message from ${senderName}`,
    body: message.length > 50 ? `${message.substring(0, 50)}...` : message,
    categoryId: 'team_chat',
    priority: 'high',
    data: { type: 'chat_message', senderName },
  }),

  workspaceInvite: (workspaceName: string, inviterName: string): PushNotificationData => ({
    title: 'Workspace Invitation',
    body: `${inviterName} invited you to join ${workspaceName}`,
    categoryId: 'workspace_updates',
    priority: 'high',
    data: { type: 'workspace_invite', workspaceName, inviterName },
  }),

  workspaceUpdate: (workspaceName: string, updateType: string): PushNotificationData => ({
    title: 'Workspace Update',
    body: `${workspaceName} has been ${updateType}`,
    categoryId: 'workspace_updates',
    priority: 'normal',
    data: { type: 'workspace_update', workspaceName, updateType },
  }),

  uploadLinkExpiring: (linkName: string, hoursLeft: number): PushNotificationData => ({
    title: 'Upload Link Expiring',
    body: `${linkName} will expire in ${hoursLeft} hour${hoursLeft !== 1 ? 's' : ''}`,
    categoryId: 'default',
    priority: 'normal',
    data: { type: 'upload_link_expiring', linkName, hoursLeft },
  }),

  storageLimit: (percentUsed: number): PushNotificationData => ({
    title: 'Storage Limit Warning',
    body: `You've used ${percentUsed}% of your storage quota`,
    categoryId: 'default',
    priority: 'normal',
    data: { type: 'storage_limit', percentUsed },
  }),
};

// Export singleton instance
export const pushNotificationService = new PushNotificationService();

// Helper function to initialize push notifications
export async function initializePushNotifications(): Promise<string | null> {
  await pushNotificationService.configure();
  return await pushNotificationService.registerForPushNotifications();
}

/** Backend notification types that can trigger push + in-app notifications */
export const NOTIFICATION_TYPES = [
  'file_request',
  'chat_message',
  'file_received',
  'draft_edited',
  'draft_invite',
  'file_invite',
  'calendar_invite',
  'calendar_reminder',
  'file_share_viewed',
  'join_request',
  'join_request_approved',
  'transcript_ready',
  'intake_file_received',
  'inbound_email',
  'awaiting_reply_received',
  'workspace_meeting_started',
  'chat_call_started',
  'meeting_started',
  'upload',
  'upload_link_expiring',
  'agentic',
  'info',
  'success',
  'warning',
  'workspace_invite',
  'workspace_update',
  'storage_limit',
  'meeting_minimized',
] as const;

export const REACH_MEETING_STARTED_TYPES = [
  'workspace_meeting_started',
  'chat_call_started',
  'meeting_started',
] as const;

export function isReachMeetingStartedNotificationType(type: unknown): boolean {
  return (
    type === 'workspace_meeting_started' ||
    type === 'chat_call_started' ||
    type === 'meeting_started'
  );
}

/** Resolve mobile join path from push/inbox metadata (web uses `/meeting/{id}`). */
export function getReachMeetingJoinPath(data: Record<string, any> | null | undefined): string | null {
  if (!data) return null;
  const mid = data.meeting_id ?? data.meetingId;
  if (mid != null && String(mid).trim()) {
    return `/join-meeting?meeting_id=${encodeURIComponent(String(mid).trim())}`;
  }
  const nav = data.navigation_path ?? data.screen;
  if (typeof nav === 'string') {
    const m = nav.match(/\/meeting\/([^/?#]+)/);
    if (m?.[1]) {
      return `/join-meeting?meeting_id=${encodeURIComponent(m[1])}`;
    }
  }
  return null;
}

/**
 * Web billing, pricing, and payment links are a website session.
 * On the phone they open in-app Billing, where a plan is chosen before checkout.
 */
export function toInAppBillingPath(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  let pathname = trimmed;
  let tab: string | null = null;
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const url = new URL(trimmed);
      const host = url.hostname.replace(/^www\./, '');
      if (host !== 'grabdocs.com' && host !== 'app.grabdocs.com') return null;
      pathname = url.pathname;
      tab = url.searchParams.get('tab');
    } else {
      const q = trimmed.indexOf('?');
      pathname = q >= 0 ? trimmed.slice(0, q) : trimmed;
      if (q >= 0) tab = new URLSearchParams(trimmed.slice(q + 1)).get('tab');
    }
  } catch {
    return null;
  }
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  if (pathname === '/settings' && tab === 'billing') return '/billing';
  if (pathname === '/pricing') return '/billing';
  if (pathname === '/payment') return '/billing';
  return null;
}

const APP_HOME_FALLBACK = '/(tabs)';

function finalizeNotificationPath(path: string): string {
  return resolveAppDeepLinkPath(path);
}

function pathFromScreenOrNav(data: Record<string, any>): string | null {
  const raw =
    (typeof data?.screen === 'string' && data.screen.trim()) ||
    (typeof data?.navigation_path === 'string' && data.navigation_path.trim()) ||
    '';
  if (!raw) return null;
  const billing = toInAppBillingPath(raw);
  if (billing) return billing;
  return finalizeNotificationPath(raw.startsWith('/') || /^https?:\/\//i.test(raw) || /^grabdocs:\/\//i.test(raw) ? raw : `/${raw}`);
}

function isActionableInboxInvite(data: Record<string, any>): boolean {
  const type = data?.type;
  const action = data?.action_type;
  if (data?.has_actions === false) return false;
  if (type === 'join_request' || action === 'join_request') return true;
  if (
    type === 'workspace_invite' ||
    type === 'workspace_invitation' ||
    action === 'workspace_invite' ||
    action === 'workspace_invitation'
  ) {
    return true;
  }
  if (type === 'draft_invite' || type === 'file_invite' || action === 'draft_invite' || action === 'file_invite') {
    return true;
  }
  if ((type === 'file_received' || action === 'file_share') && data?.has_actions && data?.share_id != null) {
    return true;
  }
  if (type === 'info' && (action === 'workspace_invitation' || action === 'workspace_invite')) {
    return true;
  }
  // secure_message_invite: no inbox Accept buttons — open user-chat (pending invite prompt).
  return false;
}

function signaturePathFromData(data: Record<string, any>): string | null {
  if (data?.token) {
    return finalizeNotificationPath(`/signatures/sign/token/${encodeURIComponent(String(data.token))}`);
  }
  const nav = data?.navigation_path != null ? String(data.navigation_path) : '';
  if (nav.includes('signatures')) {
    return finalizeNotificationPath(nav.startsWith('/') ? nav : `/${nav}`);
  }
  if (data?.envelope_id != null || data?.public_id != null) {
    const id = data.public_id ?? data.envelope_id;
    return finalizeNotificationPath(
      data?.action === 'sign' ? `/signatures/sign/${id}` : `/signatures/${id}`,
    );
  }
  if (data?.action_type === 'signature_envelope') return '/signatures';
  return null;
}

/**
 * Resolve app path for push/data payload (type + optional metadata).
 * Used when user taps a push or an in-app notification so we open the right screen.
 * Type-specific targets win over coarse backend `screen` defaults; web paths are rewritten.
 */
export function getNotificationScreen(data: Record<string, any>): string {
  const type = data?.type;
  const action = data?.action_type;

  // Accept/Reject rows must open the inbox (not documents / home).
  if (isActionableInboxInvite(data)) {
    return '/notifications';
  }

  // Reach meeting started — always join, even if push default screen is /notifications.
  if (
    isReachMeetingStartedNotificationType(type) ||
    isReachMeetingStartedNotificationType(action)
  ) {
    return getReachMeetingJoinPath(data) || '/quick-reach/meeting-call';
  }

  switch (type) {
    case 'file_request':
    case 'upload_link_expiring':
      return '/upload-links';
    case 'chat_message':
      return data?.chat_id != null ? `/user-chat?chatId=${data.chat_id}` : '/(tabs)/chats';
    case 'file_received':
    case 'file_share_viewed':
    case 'file_upload':
    case 'file_processing':
    case 'form_response':
    case 'upload':
      return '/(tabs)/documents';
    case 'draft_edited':
      return data?.file_id != null ? `/drafts/edit/${data.file_id}` : '/(tabs)/documents';
    case 'calendar_invite':
    case 'calendar_reminder': {
      const eid = data?.event_id ?? data?.calendar_event_id ?? data?.eventId;
      if (eid != null) return `/calendar/${eid}`;
      const fromNav = pathFromScreenOrNav(data);
      return fromNav && fromNav.startsWith('/calendar') ? fromNav : '/calendar';
    }
    case 'join_request':
      return '/notifications';
    case 'join_request_approved':
      return data?.meeting_id != null
        ? `/join-meeting?meeting_id=${encodeURIComponent(String(data.meeting_id))}`
        : APP_HOME_FALLBACK;
    case 'workspace_meeting_started':
    case 'chat_call_started':
    case 'meeting_started':
      return getReachMeetingJoinPath(data) || '/quick-reach/meeting-call';
    case 'transcript_ready':
      return data?.video_call_id != null
        ? `/quick-reach/meeting-details?roomId=${data.video_call_id}&meetingId=${data.video_call_id}&open_recap=1&initialTab=transcript`
        : '/quick-reach/meeting-call';
    case 'workspace_invite':
    case 'workspace_invitation':
    case 'draft_invite':
    case 'file_invite':
      return '/notifications';
    case 'workspace_update':
      return '/workspaces';
    case 'intake_file_received':
      return data?.intake_id != null ? `/intake/${data.intake_id}` : '/intake';
    case 'awaiting_reply_received':
    case 'inbound_email': {
      const tid = data?.thread_id ?? data?.threadId;
      const ws = data?.workspace_id ?? data?.workspaceId;
      if (tid != null) {
        const q = new URLSearchParams({ threadId: String(tid) });
        if (type === 'inbound_email' || data?.needs_reply) q.set('compose', '1');
        if (ws != null) q.set('workspaceId', String(ws));
        return `/email-sync?${q.toString()}`;
      }
      if (ws != null) return `/email-sync?workspaceId=${ws}`;
      const fromNav = pathFromScreenOrNav(data);
      return fromNav && fromNav.startsWith('/email-sync') ? fromNav : '/email-sync';
    }
    case 'signature_request':
    case 'signature_invite':
    case 'signature_reminder':
    case 'signature_completed': {
      return signaturePathFromData(data) || '/signatures';
    }
    case 'meeting_minimized': {
      if (data?.meetingId) {
        const params = new URLSearchParams({ meetingId: String(data.meetingId) });
        if (data?.title) params.set('title', String(data.title));
        if (data?.userName) params.set('userName', String(data.userName));
        return `/quick-reach/hms-meeting-interface?${params.toString()}`;
      }
      return '/quick-reach/hms-meeting-interface';
    }
    case 'agentic':
      return APP_HOME_FALLBACK;
    case 'storage_limit':
      return '/billing';
    case 'info':
    case 'success':
    case 'warning': {
      if (action === 'signature_envelope') {
        return signaturePathFromData(data) || '/signatures';
      }
      if (action === 'secure_message_invite') {
        return data?.chat_id != null ? `/user-chat?chatId=${data.chat_id}` : '/user-chat';
      }
      if (action === 'secure_message_invite_delivery_failed' && data?.chat_id != null) {
        return `/user-chat?chatId=${data.chat_id}`;
      }
      if (data?.workspace_id != null && (action === 'workspace_invitation' || type === 'success')) {
        return '/workspaces';
      }
      const fromNav = pathFromScreenOrNav(data);
      if (fromNav && fromNav !== APP_HOME_FALLBACK) return fromNav;
      return APP_HOME_FALLBACK;
    }
    default: {
      const fromNav = pathFromScreenOrNav(data);
      if (fromNav && fromNav !== APP_HOME_FALLBACK) return fromNav;
      return APP_HOME_FALLBACK;
    }
  }
}

/**
 * Parse a path string (optionally with ?key=value) into pathname + params for Expo Router.
 * Expo Router expects router.push({ pathname, params }) for params; string with ? can fail and show error page.
 */
export function parseNotificationPath(path: string): { pathname: string; params?: Record<string, string> } {
  const i = path.indexOf('?');
  if (i < 0) return { pathname: path };
  const pathname = path.slice(0, i).trim() || path;
  const search = path.slice(i + 1).trim();
  if (!search) return { pathname };
  const params: Record<string, string> = {};
  for (const part of search.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    try {
      const key = decodeURIComponent(part.slice(0, eq).trim());
      const value = decodeURIComponent(part.slice(eq + 1));
      if (key) params[key] = value;
    } catch {
      // skip malformed segment
    }
  }
  return Object.keys(params).length ? { pathname, params } : { pathname };
}

// Helper function to handle navigation from notifications (for navigator-based usage)
export function handleNotificationNavigation(
  data: Record<string, any>,
  navigation: any
) {
  const path = getNotificationScreen(data);
  if (path === '/notifications') {
    navigation.navigate('notifications' as any);
    return;
  }
  if (path.startsWith('/(tabs)/')) {
    const screen = path.replace('/(tabs)/', '');
    navigation.navigate('(tabs)', { screen });
    return;
  }
  const { pathname, params } = parseNotificationPath(path);
  if (params && Object.keys(params).length > 0) {
    navigation.navigate(pathname as any, params);
    return;
  }
  navigation.navigate(pathname as any);
}

export default pushNotificationService; 
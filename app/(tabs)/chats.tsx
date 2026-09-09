// Polyfill for URL in React Native (required for socket.io)
import 'react-native-url-polyfill/auto';

import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useChatGDSheetHostParams } from '../../contexts/ChatGDSheetContext';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
    AccessibilityInfo,
    ActivityIndicator,
    Alert,
    Animated,
    Dimensions,
    FlatList,
    Keyboard,
    KeyboardAvoidingView,
    LayoutAnimation,
    Linking,
    Modal,
    Platform,
    Pressable,
    RefreshControl,
    ScrollView,
    Share,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    UIManager,
    View
} from 'react-native';
import {
    GestureHandlerRootView,
    RectButton,
    Swipeable,
    TouchableOpacity as GHTouchableOpacity,
} from 'react-native-gesture-handler';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Toast from 'react-native-toast-message';
import { io, Socket } from 'socket.io-client';
import AssistantMessageBody from '../../components/AssistantMessageBody';
import ChartImageModal from '../../components/ChartImageModal';
import ChatConnectivityBanner from '../../components/ChatConnectivityBanner';
import InAppWebViewModal, { shouldUseExternalLinking } from '../../components/InAppWebViewModal';
import MinimizableBottomSheet from '../../components/MinimizableBottomSheet';
import GeneralFileViewerModal from '../../components/GeneralFileViewerModal';
import SermonViewerModal from '../../components/SermonViewerModal';
import { API_BASE_URL, STORAGE_KEYS } from '../../constants/Config';
import { useScrollRestoresHeaderProps } from '../../contexts/HeaderVisibilityContext';
import { useLimitError } from '../../contexts/LimitErrorContext';
import { useMinimizableSheet } from '../../hooks/useMinimizableSheet';
import { useChatConnectivity } from '../../hooks/useChatConnectivity';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiService as api } from '../../services/api';
import { errorLogger } from '../../services/errorLogger';
import { useChatStore } from '../../stores/chatStore';
import type { ChatHistory } from '../../types';
import { parseGrabDocsFileViewUrl } from '../../utils/chatFileLinks';
import { isSermonFile } from '../../utils/isSermonFile';
import { localizeUtcDatesInAssistantText } from '../../utils/chatUtcDisplay';
import { truncateAskClientName, truncateChatHeaderTitle } from '../../utils/chatTitleDisplay';
import { removeFileExtension } from '../../utils/fileUtils';
import {
  CHAT_COMPOSER_MAX_HEIGHT,
  CHAT_COMPOSER_MIN_HEIGHT,
} from '../../utils/chatComposerMetrics';
import ChatComposerInput from '../../components/ChatComposerInput';
import { getChatNetworkErrorMessage, isNetworkError, isRateLimitError } from '../../utils/networkErrors';
import { extractLimitErrorData, getErrorResponseData } from '../../utils/limitErrorUtils';
import { floatingDialogSurfaceStyle, modalScrimOverlayStyle } from '../../utils/dialogSurfaceStyles';
import { screenCache } from '../../utils/screenCache';
import { persistentBottomNavInset } from '../../utils/persistentBottomNavInset';
import {
  chatContextsStorageKey,
  chatListScreenKey,
  favoriteChatsStorageKey,
} from '../../services/userScopedCache';
import { secureStorage } from '../../utils/storage';
import {
    WORKSPACE_MEMBERS_CACHE_MS,
    workspaceMembersCacheKey,
    type WorkspaceMembersCachePayload,
} from '../../utils/workspaceScreenCache';
import { AnimatedHeaderContainer } from '../components/AnimatedHeaderContainer';
import { ChatMessageFooter } from '../components/ChatMessageFooter';
import ProcessingMessageDisplay from '../components/ProcessingMessageDisplay';
import { TapToToggleHeaderView } from '../components/TapToToggleHeaderView';
import { useAuth } from '../context/auth';

import AppBackButton from '../../components/AppBackButton';
import AppHeaderTitle from '../../components/AppHeaderTitle';
import ClientsButton from '../../components/clients/ClientsButton';
import {
  getClientsForItem,
  setItemClients,
} from '../../services/clientsApi';

const DEFAULT_ASK_CHIPS = ["What's missing?", 'Have they signed?', 'When was last contact?'];

function normalizeAskChip(text: string): string {
  return text.trim().toLowerCase().replace(/[?.!]+$/g, '');
}

/** Drop chips that duplicate the latest user ask (and empty strings). */
function filterAskSuggestionChips(
  chips: string[],
  recentUserTexts: Array<string | null | undefined> = [],
): string[] {
  const asked = new Set(
    recentUserTexts
      .map((t) => (typeof t === 'string' ? normalizeAskChip(t) : ''))
      .filter(Boolean),
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of chips) {
    const chip = typeof raw === 'string' ? raw.trim() : '';
    if (!chip) continue;
    const key = normalizeAskChip(chip);
    if (!key || asked.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(chip);
  }
  return out;
}

/** Header height must fit icon buttons (padding + 30px icon); 64 clipped hit targets. */
const CHAT_CONVERSATION_HEADER_HEIGHT = 72;
const HEADER_ACTION_HIT_SLOP = { top: 12, bottom: 12, left: 10, right: 10 };

/**
 * Isolated from typewriter `setMessages` re-renders so Chat History stays tappable
 * while a response is streaming.
 */
const ChatConversationHeader = React.memo(function ChatConversationHeader({
  title,
  subtitle,
  shareDisabled,
  onBack,
  onOpenHistory,
  onShare,
  onNewChat,
  headerStyle,
  backButtonStyle,
  headerInfoStyle,
  subtitleStyle,
  actionButtonStyle,
}: {
  title: string;
  subtitle: string;
  shareDisabled: boolean;
  onBack: () => void;
  onOpenHistory: () => void;
  onShare: () => void;
  onNewChat: () => void;
  headerStyle: object;
  backButtonStyle: object;
  headerInfoStyle: object;
  subtitleStyle: object;
  actionButtonStyle: object;
}) {
  return (
    <AnimatedHeaderContainer height={CHAT_CONVERSATION_HEADER_HEIGHT}>
      <View style={headerStyle} collapsable={false}>
        <AppBackButton onPress={onBack} />

        <View style={headerInfoStyle} pointerEvents="none">
          <AppHeaderTitle fill={false} shrink={false}>
            {truncateChatHeaderTitle(title)}
          </AppHeaderTitle>
          <Text style={subtitleStyle}>{subtitle}</Text>
        </View>

        <View style={{ flexDirection: 'row', gap: 8, zIndex: 2 }} collapsable={false}>
          <GHTouchableOpacity
            style={actionButtonStyle}
            onPress={onOpenHistory}
            accessibilityLabel="Chat history"
            accessibilityRole="button"
            hitSlop={HEADER_ACTION_HIT_SLOP}
          >
            <Ionicons name="time-outline" size={30} color="#007AFF" />
          </GHTouchableOpacity>
          <GHTouchableOpacity
            style={actionButtonStyle}
            onPress={onShare}
            disabled={shareDisabled}
            hitSlop={HEADER_ACTION_HIT_SLOP}
          >
            <Ionicons
              name="share-outline"
              size={30}
              color={shareDisabled ? '#999' : '#007AFF'}
            />
          </GHTouchableOpacity>
          <GHTouchableOpacity
            style={actionButtonStyle}
            onPress={onNewChat}
            accessibilityLabel="New chat"
            accessibilityRole="button"
            hitSlop={HEADER_ACTION_HIT_SLOP}
          >
            <Ionicons name="add" size={30} color="#007AFF" />
          </GHTouchableOpacity>
        </View>
      </View>
    </AnimatedHeaderContainer>
  );
});

/** Default ChatGD composer hint; overridden by entry route (calendar) or chat context (file / bookmark). */
const CHATGD_DEFAULT_INPUT_PLACEHOLDER = 'Ask questions from your documents';

/** Android EditText draws a default underline; without this it shows a line above/below the field inside rounded shells. */
const ANDROID_TEXT_INPUT_PROPS =
  Platform.OS === 'android' ? { underlineColorAndroid: 'transparent' as const } : {};

interface ChatParticipant {
  id: number;
  username: string;
  email: string;
}

interface Chat {
  id: number;
  title: string;
  type: 'ai_assistant' | 'user_direct' | 'workspace' | 'document_focused' | 'bookmark_focused';
  /** Backend source: 'llm' = ChatHistory, 'user' = UserChat. Used for favorite API (unified ID). */
  source?: 'llm' | 'user';
  participants: ChatParticipant[];
  last_message: string;
  updated_at: string;
  created_at: string;
  unread_count?: number;
  /** For user/workspace chats: id of the sender of the last message. Used to show unread badge only for receiver. */
  last_message_sender_id?: number | null;
  workspace?: Workspace;
  document_context?: Document;
  bookmark_collection?: string;
  bookmark_context?: Bookmark;
}

interface ChatMessage {
  id: number;
  content: string;
  sender: ChatParticipant | null;
  is_own_message: boolean;
  created_at: string;
  /** Sender user id (for user/workspace chats). Used at render to determine left/right so alignment is correct even before profile loads. */
  sender_id?: number | null;
  /** When true, message is preview/streaming placeholder - show in grey to indicate not final */
  is_preview?: boolean;
  /** Sources/citations used for this response (assistant messages) */
  citations?: Array<{
    source_type?: string;
    source_name?: string;
    filename?: string;
    excerpt?: string;
    chunk_content?: string;
    snippet?: string;
    document_id?: number | string;
    source_id?: string | number;
    paragraph?: string;
    paragraph_start?: number;
    paragraph_end?: number;
    relevance_score?: number;
  }> | null;
  /** Chart image file id from backend (same as web chart_file_id) */
  chartFileId?: number;
  chartTitle?: string;
  document_context?: {
    id: number;
    name: string;
    type: string;
  };
  /** Document-chat preview pipeline: show status row + dots (parity with web SSE). */
  refining_answer_pending?: boolean;
  main_search_pending?: boolean;
}

/** 1→2→3 visible dots (~400ms); uses Views so Android always draws (period+fontWeight can vanish). */
function RefiningStatusDots({ color }: { color: string }) {
  const [dotCount, setDotCount] = useState(1);
  useEffect(() => {
    const t = setInterval(() => setDotCount((d) => (d % 3) + 1), 400);
    return () => clearInterval(t);
  }, []);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 6 }}>
      {[0, 1, 2].map((i) => (
        <View
          key={i}
          style={{
            width: 5,
            height: 5,
            borderRadius: 2.5,
            marginHorizontal: 3,
            backgroundColor: color,
            opacity: i < dotCount ? 0.55 : 0.2,
          }}
        />
      ))}
    </View>
  );
}

/** Normalize SSE bodies so CRLF/trailing whitespace alone don't trigger a needless typewriter rewind on `complete`. */
function normalizeStreamingTextForCompare(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
}

/** True if what we've already typed matches the same substring of the authoritative answer (cursor can stay put). */
function canPreserveDisplayedPrefixOnComplete(displayedChars: number, oldBuffer: string, finalResponse: string): boolean {
  if (displayedChars <= 0) return true;
  const max = Math.min(displayedChars, oldBuffer.length, finalResponse.length);
  if (max <= 0) return false;
  return oldBuffer.slice(0, max) === finalResponse.slice(0, max);
}

interface Workspace {
  id: number;
  name: string;
  description?: string;
  slug: string;
  owner_id: number;
  is_personal: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  member_count: number;
  user_role: 'owner' | 'admin' | 'member' | 'viewer';
  can_manage: boolean;
  can_invite: boolean;
  can_edit: boolean;
}

interface Document {
  id: number;
  name: string;
  type: string;
  category?: string;
  size?: string;
}

interface Bookmark {
  id: number;
  name: string;
  description?: string;
  file_count: number;
  documents: Document[];
}

interface ChatsResponse {
  success: boolean;
  chats: Chat[];
  count: number;
}

interface MessagesResponse {
  success: boolean;
  messages: ChatMessage[];
  count: number;
}

// Create default "Start New" chat entry outside component to avoid recreation
const DEFAULT_CHAT_ASSISTANT: Chat = {
  id: -1,
  title: 'Start New',
  type: 'ai_assistant',
  participants: [{ id: 1, username: 'ChatGD Assistant', email: 'ai@grabdocs.com' }],
  last_message: 'Ask me anything about your documents',
  updated_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  unread_count: 0
};

// Storage keys are scoped per user via userScopedCache helpers.

// Composite key to prevent AI chat and user chat ID collision in storage
const getChatStorageKey = (chat: { type: string; id: number }) =>
  (chat.type === 'user_direct' || chat.type === 'workspace' ? 'user_' : 'ai_') + chat.id;

/**
 * Parse chat activity timestamps for sorting.
 * Backend often returns naive UTC ISO (no Z); JS would treat those as local and scramble order.
 */
function parseChatActivityTimestamp(raw: string | null | undefined): number {
  if (raw == null) return 0;
  const s = String(raw).trim();
  if (!s) return 0;
  const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const normalized = hasTz ? s : `${s}Z`;
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? t : 0;
}

/** True when local state has real message activity (not an AsyncStorage context stub). */
function chatHasLocalActivity(chat: Chat): boolean {
  const preview = String(chat.last_message || '').trim();
  return preview.length > 0 && preview !== 'No messages yet';
}

/** Map user-chat API row → list Chat; never invent "now" — that breaks sort vs ChatGD history. */
function mapUserChatListRow(chat: any): Chat {
  const activityAt = chat.last_message_at || chat.created_at || '';
  return {
    id: chat.id,
    title: chat.display_name || 'Untitled Chat',
    type: chat.type === 'direct' ? 'user_direct' as const : 'workspace' as const,
    source: 'user' as const,
    participants: chat.participants || [],
    last_message: chat.latest_message?.content || 'No messages yet',
    updated_at: activityAt,
    created_at: chat.created_at || activityAt,
    unread_count: chat.unread_count || 0,
    last_message_sender_id: chat.latest_message?.sender?.id ?? chat.latest_message?.sender_id ?? null,
    workspace: chat.workspace_id
      ? { id: chat.workspace_id, name: chat.display_name, slug: '' } as Workspace
      : undefined,
    ...(chat.last_message_at ? { last_message_at: chat.last_message_at } : {}),
  };
}

// Helper: Save document/bookmark/user/workspace chat contexts to AsyncStorage
const savePersistedChatContexts = async (
  userId: string | number | null | undefined,
  chats: Chat[],
) => {
  try {
    const storageKey = chatContextsStorageKey(userId);
    if (!storageKey) return;
    const contextsToSave: Record<string, {
      type: string;
      title: string;
      document_context?: Document;
      bookmark_context?: Bookmark;
      participants?: ChatParticipant[];
      workspace?: Workspace;
    }> = {};
    
    chats.forEach(chat => {
      // CRITICAL: Save contexts for chats that have context OR the correct type
      // This ensures chats with bookmark_context but wrong type still get saved
      const hasContext = chat.bookmark_context || chat.document_context || chat.workspace;
      const hasCorrectType = chat.type === 'document_focused' || 
                             chat.type === 'bookmark_focused' || 
                             chat.type === 'user_direct' || 
                             chat.type === 'workspace';
      
      if (hasContext || hasCorrectType) {
        // Determine the correct type based on context if type is wrong
        const correctType = chat.bookmark_context ? 'bookmark_focused' :
                           chat.document_context ? 'document_focused' :
                           chat.workspace ? 'workspace' :
                           chat.type === 'user_direct' ? 'user_direct' :
                           chat.type;
        
        contextsToSave[getChatStorageKey(chat)] = {
          type: correctType,
          title: chat.title,
          document_context: chat.document_context,
          bookmark_context: chat.bookmark_context,
          participants: chat.participants,
          workspace: chat.workspace
        };
        
      }
    });
    
    await AsyncStorage.setItem(storageKey, JSON.stringify(contextsToSave));
  } catch (error) {
    console.error('❌ Failed to save chat contexts:', error);
  }
};

// Helper: Load persisted chat contexts from AsyncStorage (uses composite key: ai_95, user_95)
const loadPersistedChatContexts = async (
  userId: string | number | null | undefined,
): Promise<Map<string, {
  type: string;
  title: string;
  document_context?: Document;
  bookmark_context?: Bookmark;
  participants?: ChatParticipant[];
  workspace?: Workspace;
}>> => {
  try {
    const storageKey = chatContextsStorageKey(userId);
    if (!storageKey) return new Map();
    const stored = await AsyncStorage.getItem(storageKey);
    if (!stored) return new Map();
    
    const parsed = JSON.parse(stored);
    const contextsMap = new Map<string, any>();
    Object.entries(parsed).forEach(([chatId, context]) => {
      // Support both legacy numeric keys and new composite keys
      const key = String(chatId).startsWith('ai_') || String(chatId).startsWith('user_') ? chatId : Number(chatId);
      contextsMap.set(String(key), context);
    });
    return contextsMap;
  } catch (error) {
    console.error('❌ Failed to load chat contexts:', error);
    return new Map();
  }
};

const CHATS_PAGE_SIZE = 10;

/** Preview line for ChatGD / LLM history rows; list API omits full conversation_data. */
function getAiHistoryListPreview(history: any): string {
  const messagesRaw = history?.messages ?? history?.conversation_data;
  let messages: any[] = [];
  if (Array.isArray(messagesRaw)) {
    messages = messagesRaw;
  } else if (typeof messagesRaw === 'string' && messagesRaw.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(messagesRaw);
      if (Array.isArray(parsed)) messages = parsed;
    } catch {
      /* ignore */
    }
  }
  const contentFrom = (m: any) => {
    if (!m) return '';
    if (typeof m === 'object') return String(m.content ?? m.message ?? '').trim();
    return String(m).trim();
  };
  if (messages.length > 0) {
    const lastUserMsg = [...messages].reverse().find(
      (m: any) => m && (m.role === 'user' || m.is_own_message)
    );
    const lastMsg = messages[messages.length - 1];
    const raw =
      (lastUserMsg && contentFrom(lastUserMsg)) || contentFrom(lastMsg) || '';
    if (raw) return raw.length > 60 ? `${raw.substring(0, 60).trim()}…` : raw;
  }
  const preview = String(history?.last_message_preview ?? '').trim();
  if (preview) return preview.length > 60 ? `${preview.substring(0, 60).trim()}…` : preview;
  const lm = history?.latest_message;
  const fromLm =
    typeof lm === 'string' ? lm.trim() : String(lm?.content ?? lm?.message ?? '').trim();
  if (fromLm) return fromLm.length > 60 ? `${fromLm.substring(0, 60).trim()}…` : fromLm;
  const mc = Number(history?.message_count ?? 0);
  if (mc > 0) return 'Open chat to view messages';
  return 'No messages yet';
}

export default function ChatsScreen() {
  const router = useRouter();
  const routeParams = useLocalSearchParams();
  const sheetHostParams = useChatGDSheetHostParams();
  const params = sheetHostParams ?? routeParams;
  const isSheet =
    sheetHostParams != null ||
    params.isSheet === '1' ||
    params.isSheet === 'true';
  const clearRouteParams = useCallback(() => {
    if (sheetHostParams != null) return;
    try {
      router.setParams({});
    } catch {
      /* ignore if router not ready */
    }
  }, [sheetHostParams, router]);
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const { user: authUser } = useAuth();
  const authUserId = authUser?.id ?? null;
  const { showLimitError } = useLimitError();
  const scrollRestoresHeaderProps = useScrollRestoresHeaderProps();
  const {
    offlineBannerVisible,
    bannerText,
    sendDisabled: connectivitySendDisabled,
    confirmSend,
    recordNetworkFailure,
    clearNetworkFailures,
  } = useChatConnectivity();

  const [chats, setChats] = useState<Chat[]>([DEFAULT_CHAT_ASSISTANT]); // Initialize with ChatGD Assistant
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Pagination state for the chat list
  const [aiChatOffset, setAiChatOffset] = useState(0);
  const [userChatOffset, setUserChatOffset] = useState(0);
  const [hasMoreAiChats, setHasMoreAiChats] = useState(false);
  const [hasMoreUserChats, setHasMoreUserChats] = useState(false);
  const [isLoadingMoreChats, setIsLoadingMoreChats] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [isGoingBack, setIsGoingBack] = useState(false); // Track if user is going back to chat list

  /** True after navigating from Calendar → ChatGD (`chatSource=calendar`); cleared when leaving default assistant. */
  const [calendarEntryPlaceholder, setCalendarEntryPlaceholder] = useState(false);
  /** Optional composer hint from `?chatPlaceholder=` or `?inputPlaceholder=` (URL-encoded). */
  const [routeInputPlaceholder, setRouteInputPlaceholder] = useState<string | null>(null);
  /** My Clients scoped Ask — from `?client_id=` / `?client_name=` (captured before params clear). */
  const [askClient, setAskClient] = useState<{ id: number; name: string } | null>(null);
  const askClientRef = useRef<{ id: number; name: string } | null>(null);
  askClientRef.current = askClient;
  const [askSuggestionChips, setAskSuggestionChips] = useState<string[]>(DEFAULT_ASK_CHIPS);
  /** Latest user ask text while client-scoped — used to drop duplicate suggestion chips. */
  const lastAskUserMessageRef = useRef<string | null>(null);
  const visibleAskSuggestionChips = useMemo(() => {
    if (!askClient) return [] as string[];
    const recent = messages
      .filter((m) => m.is_own_message)
      .slice(-5)
      .map((m) => m.content);
    if (lastAskUserMessageRef.current) recent.push(lastAskUserMessageRef.current);
    return filterAskSuggestionChips(askSuggestionChips, recent);
  }, [askClient, askSuggestionChips, messages]);
  const linkedAskChatRef = useRef<string | null>(null);
  const linkAskClientToHistoryRef = useRef<(historyId: number) => void>(() => {});
  linkAskClientToHistoryRef.current = (historyId: number) => {
    const client = askClientRef.current;
    if (!client?.id || !historyId || historyId <= 0) return;
    const key = `${historyId}:${client.id}`;
    if (linkedAskChatRef.current === key) return;
    linkedAskChatRef.current = key;
    void (async () => {
      try {
        const existing = await getClientsForItem('chat_history', historyId);
        const ids = Array.from(new Set([...existing.map((c) => c.id), client.id]));
        await setItemClients({
          client_ids: ids,
          item_type: 'chat_history',
          item_id: historyId,
        });
      } catch {
        linkedAskChatRef.current = null;
      }
    })();
  };


  // True when the chat has no messages yet — used to center the input (ChatGPT-style empty state)
  const isEmptyChat = messages.length === 0 && !messagesLoading && !sendingMessage;
  const [userProfile, setUserProfile] = useState<any>(null); // User profile for determining is_own_message
  const userProfileRef = useRef<any>(null); // Ref to always have latest userProfile in WebSocket handlers
  // Current user id: auth is available immediately; profile may load later. Used so sent messages always show on the right.
  const currentUserIdRef = useRef<string | number | null>(null);
  currentUserIdRef.current = authUser?.id ?? userProfile?.data?.id ?? userProfile?.id ?? userProfileRef.current?.data?.id ?? userProfileRef.current?.id ?? null;
  const recentlySentMessageIdsRef = useRef<Set<number>>(new Set()); // Track recently sent message IDs to prevent duplicates
  const lastMessageSentTimeRef = useRef<number>(0); // Track when last message was sent to prevent reload
  const lastLoadTimeRef = useRef<number>(0); // Track last load time to prevent excessive reloads
  
  // Streaming state for fake character-by-character animation
  const [streamingMessageIndex, setStreamingMessageIndex] = useState<number | null>(null);
  const streamingMessageIndexRef = useRef<number | null>(null); // Ref to track streaming index immediately
  const streamingIntervalRef = useRef<number | null>(null);
  const contentBufferRef = useRef<string>('');
  const displayedCharsRef = useRef<number>(0);
  /**
   * Deferred "stop+dump" action waiting for typewriter to catch up.
   * Set by main_search_pending / result_superseded / preview_complete handlers
   * when displayedChars < contentBuffer.length, fired by the typewriter tick once
   * the cursor reaches the end of the buffer. Prevents the visible jump from a
   * mid-stream UI flip (e.g. instant dots) replacing partially-typed preview text.
   */
  const pendingFinalActionRef = useRef<(() => void) | null>(null);
  const isPreviewPhaseRef = useRef<boolean>(true);
  const isStreamingRef = useRef<boolean>(false);
  const isFakeStreamingRef = useRef<boolean>(false); // Track if we're in fake streaming mode
  const isStreamCompleteRef = useRef<boolean>(false); // Track if stream is complete (no more chunks will arrive)
  const citationsFromStreamRef = useRef<ChatMessage['citations']>(null); // Citations from stream complete event
  const chartFromStreamRef = useRef<{ chartFileId: number; chartTitle?: string } | null>(null);
  /** Backend assistant message_id from complete event (for retry_replace_message_id) */
  const assistantMessageIdFromStreamRef = useRef<number | null>(null);
  /** Same index as send/retry polling onChunk (last assistant row replaced on retry) */
  const pollingAssistantIndexRef = useRef<number>(0);
  /** Placeholder row id for current stream — updates always target this row so we never overwrite the user message */
  const streamingAssistantRowIdRef = useRef<number | null>(null);
  /** Last smart-chat filters (context + chat_history_id) — retry reuses these */
  const lastStreamFiltersRef = useRef<Record<string, any> | null>(null);
  const smartChatPollingChunkRef = useRef<(type: string, data: any) => void>(() => {});
  /** True after first AI send built smartChatOnChunk — retry/more sources need this (polling promise returns immediately). */
  const smartChatPollingChunkReadyRef = useRef(false);

  const [sermonModal, setSermonModal] = useState<{
    visible: boolean;
    fileId: number;
    paragraph: number;
    paragraphEnd?: number;
    title?: string;
    pdfUri?: string | null;
    defaultTab?: 'text' | 'pdf';
    expandNonce: number;
  }>({ visible: false, fileId: 0, paragraph: 1, defaultTab: 'text', expandNonce: 0 });
  const [generalFileModal, setGeneralFileModal] = useState<{
    visible: boolean;
    fileId: number;
    title?: string;
    pdfUri?: string | null;
    expandNonce: number;
  }>({ visible: false, fileId: 0, expandNonce: 0 });

  const openDocumentViewer = useCallback(
    async (
      fileId: number,
      paragraph: number = 0,
      title?: string,
      paragraphEnd?: number,
      pdfUri?: string | null,
      defaultTab: 'text' | 'pdf' = 'text',
    ) => {
      const sermon = await isSermonFile(fileId);
      if (sermon) {
        setSermonModal((s) => ({
          visible: true,
          fileId,
          paragraph,
          paragraphEnd,
          title,
          pdfUri: pdfUri ?? undefined,
          defaultTab,
          expandNonce: s.expandNonce + 1,
        }));
      } else {
        setGeneralFileModal((s) => ({
          visible: true,
          fileId,
          title,
          pdfUri: pdfUri ?? null,
          expandNonce: s.expandNonce + 1,
        }));
      }
    },
    [],
  );
  const [chartModal, setChartModal] = useState<{
    visible: boolean;
    chartFileId: number;
    title?: string;
  }>({ visible: false, chartFileId: 0 });
  const [webPopup, setWebPopup] = useState<{
    visible: boolean;
    url: string;
    title?: string;
    expandNonce: number;
  }>({
    visible: false,
    url: '',
    expandNonce: 0,
  });
  const lastStreamedMessageIndexRef = useRef<number | null>(null); // Track which message index was last streamed
  const lastStreamCompleteTimeRef = useRef<number>(0); // Track when streaming last completed
  
  // Message ID counter to ensure uniqueness
  const messageIdCounterRef = useRef<number>(0);
  const currentChatIdRef = useRef<number | null>(null); // Track current chat ID to handle chat_history_id updates
  const loadedChatIdRef = useRef<number | null>(null); // Track which chat's messages are currently loaded to prevent unnecessary reloads
  const selectedChatRef = useRef<Chat | null>(null); // Track selectedChat to preserve it across reloads
  /** Per-chat message cache: chatId → { messages, timestamp }. Cleared when a new message is sent. */
  const messageCacheRef = useRef<Map<number, { messages: ChatMessage[]; timestamp: number }>>(new Map());

  useEffect(() => {
    messageCacheRef.current.clear();
  }, [authUserId]);
  const MESSAGE_CACHE_MS = 2 * 60_000; // 2-minute TTL for cached messages
  /** Last time the full chat list was fetched. Used to debounce useFocusEffect reloads. */
  const chatListLastLoadRef = useRef<number>(0);
  const CHAT_LIST_DEBOUNCE_MS = 30_000; // Don't reload chat list more than once per 30 s
  const fileIdContextProcessedRef = useRef<Set<number>>(new Set()); // Track processed fileIds to prevent duplicate context setup
  const isSettingUpFileContextRef = useRef<boolean>(false); // Track if we're currently setting up file context to prevent unnecessary reloads
  const fileContextSetupStartTimeRef = useRef<number>(0); // Track when file context setup started
  const workspaceRequestRef = useRef<Promise<any> | null>(null); // Track in-flight workspace request to prevent duplicate calls
  const documentRequestRef = useRef<Promise<any> | null>(null); // Dedup concurrent loadDocuments calls
  const bookmarkRequestRef = useRef<Promise<any> | null>(null); // Dedup concurrent loadBookmarks calls
  const isPreservingContextRef = useRef<boolean>(false); // Track when we're preserving context to prevent loadChats from overwriting
  const contextPreservationTimeRef = useRef<number>(0); // Track when context was last preserved
  const pendingBookmarkFromParamsRef = useRef<Bookmark | null>(null); // Bookmark from nav params so loadChats can re-inject if it overwrites list
  const placeholderChatToPreserveRef = useRef<Chat | null>(null); // Placeholder -2 when going back, so loadChats can merge it (avoids stale closure)
  const fmAutosubmitHandledRef = useRef(false);
  const sendMessageRef = useRef<(overrideText?: string) => Promise<void>>(async () => {});
  // Keep selectedChatRef in sync with selectedChat state
  useEffect(() => {
    selectedChatRef.current = selectedChat;
  }, [selectedChat]);

  /** Positive chat_history_id for UI + retry/more-sources; ref can update before selectedChat leaves temp id -2. */
  const getPersistedChatHistoryId = (): number => {
    const fromState = selectedChat?.id != null ? Number(selectedChat.id) : NaN;
    if (Number.isFinite(fromState) && fromState > 0) return fromState;
    const fromRef = currentChatIdRef.current != null ? Number(currentChatIdRef.current) : NaN;
    if (Number.isFinite(fromRef) && fromRef > 0) return fromRef;
    return 0;
  };
  
  // Keyboard top (screenY) tracking for input positioning
  /** Keyboard top (screenY) when visible - used to position input just above keyboard */
  const [keyboardTop, setKeyboardTop] = useState<number | null>(null);
  const composerKeyboardLift = useMemo(() => {
    // In sheet mode the parent MinimizableBottomSheet already lifts content above the keyboard.
    if (isSheet || keyboardTop == null) return 0;
    return Math.max(0, Dimensions.get('window').height - keyboardTop - insets.bottom);
  }, [isSheet, keyboardTop, insets.bottom]);
  /** Keep composer above PersistentBottomNavigation when keyboard is closed. */
  const bottomNavInset = useMemo(
    () => (isSheet ? 0 : persistentBottomNavInset(insets.bottom)),
    [isSheet, insets.bottom]
  );
  const composerBottomInset = useMemo(() => {
    if (keyboardTop != null) return composerKeyboardLift;
    return bottomNavInset;
  }, [keyboardTop, composerKeyboardLift, bottomNavInset]);
  const inputContainerRef = useRef<View>(null);
  const [inputContainerY, setInputContainerY] = useState(0);
  const [inputContainerHeight, setInputContainerHeight] = useState(68);
  
  // Swipeable refs to manage open swipeables in chat list (only one open at a time)
  const chatSwipeableRefs = useRef<Map<number, Swipeable>>(new Map());
  // Separate ref map for swipeables inside the history modal (avoids conflicts with main list)
  const historySwipeableRefs = useRef<Map<number, Swipeable>>(new Map());
  const swipingChatId = useRef<number | null>(null);
  const [menuChatId, setMenuChatId] = useState<number | null>(null);
  const [favoriteChatIds, setFavoriteChatIds] = useState<Set<number>>(new Set());
  
  // Helper function to generate unique message IDs
  const generateUniqueMessageId = (): number => {
    // Combine timestamp, counter, and random to ensure uniqueness
    messageIdCounterRef.current += 1;
    return Date.now() * 1000 + messageIdCounterRef.current + Math.floor(Math.random() * 1000);
  };

  // Helper function to deduplicate messages by ID
  const deduplicateMessages = (messages: ChatMessage[]): ChatMessage[] => {
    const seen = new Map<number | string, ChatMessage>();
    const result: ChatMessage[] = [];
    
    messages.forEach((msg, index) => {
      const key = msg.id;
      // If we've seen this ID before, keep the first occurrence (or regenerate ID for duplicates)
      if (seen.has(key)) {
        // Generate a unique ID for duplicate messages
        const uniqueId = generateUniqueMessageId();
        result.push({ ...msg, id: uniqueId });
      } else {
        seen.set(key, msg);
        result.push(msg);
      }
    });
    
    return result;
  };
  
  // Enhanced chat functionality state
  const [showNewChatModal, setShowNewChatModal] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [users, setUsers] = useState<ChatParticipant[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [newChatType, setNewChatType] = useState<'ai_assistant' | 'user_direct' | 'workspace' | 'document_focused' | 'bookmark_focused'>('ai_assistant');
  const [selectedWorkspace, setSelectedWorkspace] = useState<Workspace | null>(null);
  const [selectedDocument, setSelectedDocument] = useState<Document | null>(null);
  const [selectedUser, setSelectedUser] = useState<ChatParticipant | null>(null);
  const [selectedBookmark, setSelectedBookmark] = useState<Bookmark | null>(null);
  
  // Search functionality
  const [searchQuery, setSearchQuery] = useState('');
  const [filteredChats, setFilteredChats] = useState<Chat[]>([DEFAULT_CHAT_ASSISTANT]); // Initialize with ChatGD Assistant
  const [filteredDocuments, setFilteredDocuments] = useState<Document[]>([]);
  const [filteredWorkspaces, setFilteredWorkspaces] = useState<Workspace[]>([]);
  const [filteredUsers, setFilteredUsers] = useState<ChatParticipant[]>([]);
  const [filteredBookmarks, setFilteredBookmarks] = useState<Bookmark[]>([]);
  
  // Modal search states (separate from main chat search)
  const [modalUserSearch, setModalUserSearch] = useState('');
  const [modalWorkspaceSearch, setModalWorkspaceSearch] = useState('');
  const [modalDocumentSearch, setModalDocumentSearch] = useState('');
  const [modalBookmarkSearch, setModalBookmarkSearch] = useState('');
  
  // Cleanup streaming on unmount
  useEffect(() => {
    return () => {
      // Cleanup streaming interval when component unmounts
      if (streamingIntervalRef.current) {
        clearInterval(streamingIntervalRef.current);
        streamingIntervalRef.current = null;
      }
    };
  }, []);
  

  
  // Quick chat type selector
  const [showQuickChatTypes, setShowQuickChatTypes] = useState(false);
  
  // Search type selector for AI Assistant
  const [showSearchTypeMenu, setShowSearchTypeMenu] = useState(false);
  const [selectedSearchType, setSelectedSearchType] = useState<'exact' | 'refined' | 'expanded'>('refined');

  // Chat history bottom sheet (shown from chat messages view)
  const historySheet = useMinimizableSheet();

  // Mention system state
  const [showMentionModal, setShowMentionModal] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionResults, setMentionResults] = useState<any[]>([]);
  const [selectedMention, setSelectedMention] = useState<any>(null);
  const [mentionStartIndex, setMentionStartIndex] = useState(-1);
  // Server-side search results for @ mentions (supplements the locally cached documents list)
  const [mentionFileSearchResults, setMentionFileSearchResults] = useState<Document[]>([]);
  // Total file count from the API — used to decide whether a server search is needed
  const [documentsTotal, setDocumentsTotal] = useState(0);
  // Debounce timer for @ mention server-side file search
  const mentionSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Sequence for mention search: only discard a response when a newer search was actually started.
  const mentionSearchSeqRef = useRef(0);
  // AbortController for the in-flight server search request
  const mentionAbortControllerRef = useRef<AbortController | null>(null);
  // True while a Tier 3 server search is in-flight (shown as a subtle indicator, not a blocking spinner)
  const [isMentionSearching, setIsMentionSearching] = useState(false);
  
  // Mention cursor tracking — keeps the raw input value and cursor position in sync
  // across the onChangeText → onSelectionChange event ordering gap in React Native.
  const newMessageRef = useRef('');
  const mentionCursorRef = useRef(0);

  // Animation and abort controller refs
  const bounceAnim = useRef(new Animated.Value(1)).current;
  const abortControllerRef = useRef<AbortController | null>(null);
  /** Set true in stopProcessing so late poll chunks cannot restart typewriter after cancel. */
  const chatRequestCancelledRef = useRef(false);
  
  const messagesRef = useRef<FlatList>(null);
  const scrollTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  /** Scroll to the very bottom of the message list using the underlying ScrollView.
   *  scrollToEnd() is far more reliable than scrollToLocation() for variable-height items. */
  const scrollToLastMessage = (animated = true) => {
    scrollTimersRef.current.forEach(t => clearTimeout(t));
    scrollTimersRef.current = [];

    const attempt = () => {
      const list = messagesRef.current;
      if (!list) return;
      // Access the underlying ScrollView's scrollToEnd – works regardless of item heights
      const scrollResponder = (list as any).getScrollResponder?.();
      if (scrollResponder?.scrollToEnd) {
        scrollResponder.scrollToEnd({ animated });
      }
    };

    // Deferred so it never runs synchronously inside onScrollToIndexFailed
    scrollTimersRef.current.push(setTimeout(attempt, 50));
    scrollTimersRef.current.push(setTimeout(attempt, 250));
    scrollTimersRef.current.push(setTimeout(attempt, 600));
  };

  /** Kept in a ref so scrollToLastMessage can always read the current value without stale closures */
  const messageSectionsRef = useRef<{ title: string; data: ChatMessage[] }[]>([]);

  // WebSocket for user chats (user_direct and workspace only)
  const socketRef = useRef<Socket | null>(null);
  const [isSocketConnected, setIsSocketConnected] = useState(false);
  const [typingUsers, setTypingUsers] = useState<{ [userId: number]: string }>({});
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  /** Chat IDs where the user explicitly removed the document/bookmark/workspace context. Persisted so we don't restore on reload. */
  const contextRemovedChatIdsRef = useRef<Set<number>>(new Set());

  // Load persisted "context explicitly removed" set on mount
  useEffect(() => {
    (async () => {
      try {
        const raw = await secureStorage.getItem(STORAGE_KEYS.CONTEXT_REMOVED_CHAT_IDS);
        if (raw) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) contextRemovedChatIdsRef.current = new Set(arr.map((n: any) => Number(n)));
        }
      } catch (_) {}
    })();
  }, []);

  // Animation states (removed bouncing balls)

  // Progress tracking state
  const [progressData, setProgressData] = useState<{
    progress: number;
    status: string;
    message: string;
    phase?: string;
    category?: string;
    subcategory?: string;
  } | null>(null);
  const [showProgress, setShowProgress] = useState(false);
  const progressEventSourceRef = useRef<EventSource | null>(null);

  // Handle document context from navigation
  useEffect(() => {
    if (params.documentId && params.documentName) {
      const documentContext: Document = {
        id: parseInt(params.documentId as string),
        name: params.documentName as string,
        type: params.documentType as string || 'other',
        category: params.documentCategory as string,
      };
      
      // Create a document-focused chat
      // Backend will create chat history when first message is sent
      const documentChat: Chat = {
        id: -2,
        title: `Document: ${truncateFilename(documentContext.name)}`,
        type: 'document_focused',
        participants: [{ id: 1, username: 'ChatGD Assistant', email: 'ai@grabdocs.com' }],
        last_message: `Ready to answer questions about ${documentContext.name}`,
        updated_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        unread_count: 0,
        document_context: documentContext
      };
      
      // Add the chat to the list and select it
      setChats(prev => {
        const chatAssistant = prev.find(chat => chat.id === -1); // Find the default ChatGD Assistant
        const otherChats = prev.filter(chat => chat.id !== -1); // All chats except default ChatGD Assistant
        
        let updatedChats: Chat[];
        if (chatAssistant) {
          // ChatGD Assistant exists, add new chat after it
          updatedChats = [chatAssistant, documentChat, ...otherChats];
        } else {
          // No ChatGD Assistant found, add new chat at beginning
          updatedChats = [documentChat, ...prev];
        }
        
        // Persist document context immediately
        savePersistedChatContexts(authUserId,updatedChats);
        return updatedChats;
      });
      setSelectedChat(documentChat);
      
      // Don't show welcome message - just show empty chat
      setMessages([]);
      loadedChatIdRef.current = documentChat.id; // Track that we've set empty messages for this chat
      
      // Clear the params to prevent re-triggering
      clearRouteParams();
    }
  }, [params.documentId, params.documentName, params.documentType, params.documentCategory]);

  // Run before native paint so we rarely flash the ChatGD history list before opening the composer.
  useLayoutEffect(() => {
    const phRaw = params.chatPlaceholder ?? params.inputPlaceholder;
    const ph = Array.isArray(phRaw) ? phRaw[0] : phRaw;
    if (typeof ph === 'string' && ph.trim()) {
      try {
        setRouteInputPlaceholder(decodeURIComponent(ph.trim()));
      } catch {
        setRouteInputPlaceholder(ph.trim());
      }
    }

    const csRaw = params.chatSource;
    const chatSource = Array.isArray(csRaw) ? csRaw[0] : csRaw;
    if (chatSource === 'calendar') setCalendarEntryPlaceholder(true);

    const cidRaw = params.client_id;
    const cidStr = Array.isArray(cidRaw) ? cidRaw[0] : cidRaw;
    const cidNum = cidStr != null ? Number(cidStr) : NaN;
    if (Number.isFinite(cidNum) && cidNum > 0) {
      const nameRaw = params.client_name;
      const nameStr = Array.isArray(nameRaw) ? nameRaw[0] : nameRaw;
      let name = typeof nameStr === 'string' ? nameStr : `Client #${cidNum}`;
      try {
        name = decodeURIComponent(name);
      } catch {
        /* keep */
      }
      setAskClient({ id: cidNum, name: name.trim() || `Client #${cidNum}` });
      setAskSuggestionChips(DEFAULT_ASK_CHIPS);
      lastAskUserMessageRef.current = null;
      linkedAskChatRef.current = null;
    }

    const v = params.openStartNew;
    const openStartNew =
      v === '1' ||
      v === 'true' ||
      (Array.isArray(v) && (v[0] === '1' || v[0] === 'true'));
    if (!openStartNew) return;
    const defaultChat = chats.find(c => c.id === -1) ?? DEFAULT_CHAT_ASSISTANT;
    setSelectedChat(defaultChat);
    selectedChatRef.current = defaultChat;
    setIsGoingBack(false);
    loadMessages(-1, true);
    // Do not call router.setParams here — useLayoutEffect runs before the root navigator is ready
    // after auth transitions; deferred clear in useEffect below.
  }, [params.openStartNew, params.chatSource, params.chatPlaceholder, params.inputPlaceholder, params.client_id, params.client_name]);

  // Clear openStartNew (and related) query params after mount — safe for Expo Router; avoids "navigate before Root Layout" crash.
  useEffect(() => {
    const v = params.openStartNew;
    const openStartNew =
      v === '1' ||
      v === 'true' ||
      (Array.isArray(v) && (v[0] === '1' || v[0] === 'true'));
    if (!openStartNew) return;
    const t = setTimeout(() => {
      try {
        clearRouteParams();
      } catch {
        /* ignore if router not ready */
      }
    }, 0);
    return () => clearTimeout(t);
  }, [params.openStartNew, router]);

  useEffect(() => {
    const hid =
      selectedChat?.id != null && Number(selectedChat.id) > 0
        ? Number(selectedChat.id)
        : currentChatIdRef.current != null && Number(currentChatIdRef.current) > 0
          ? Number(currentChatIdRef.current)
          : null;
    if (hid && askClient?.id) {
      linkAskClientToHistoryRef.current(hid);
    }
  }, [askClient?.id, selectedChat?.id]);

  useEffect(() => {
    if (selectedChat != null && selectedChat.id !== -1) {
      setCalendarEntryPlaceholder(false);
      setRouteInputPlaceholder(null);
    }
  }, [selectedChat?.id]);

  // Handle fileId parameter from documents screen (fileName passed from Files to keep display name)
  useEffect(() => {
    const handleFileIdContext = async () => {
      // Allow context to be set immediately even if loading is true
      // This ensures the context shows up instantly when navigating from Files screen
      if (!params.fileId) return;
      const fileIdNum = parseInt(String(params.fileId), 10);
      if (!Number.isFinite(fileIdNum)) {
        console.warn('⚠️ [CHATS] Invalid fileId param:', params.fileId);
        return;
      }
      
      // Prevent duplicate processing of the same fileId
      if (fileIdContextProcessedRef.current.has(fileIdNum)) {
        return;
      }
      
      // CRITICAL: Set flag to prevent useFocusEffect from reloading everything
      // This prevents all the API calls from happening when user just added a file context
      isSettingUpFileContextRef.current = true;
      fileContextSetupStartTimeRef.current = Date.now();
      const workspaceIdNum = params.workspaceId != null ? parseInt(String(params.workspaceId), 10) : undefined;
      let fileNameFromParams: string | null = null;
      if (typeof params.fileName === 'string' && params.fileName.trim() !== '') {
        try { fileNameFromParams = decodeURIComponent(String(params.fileName).trim()); } catch { fileNameFromParams = String(params.fileName).trim(); }
      }

      try {
        // Check if a document chat for this file already exists
        const existingDocumentChat = chats.find(chat =>
          chat.type === 'document_focused' && chat.document_context?.id === fileIdNum
        );
        if (existingDocumentChat) {
          setSelectedChat(existingDocumentChat);
          setSelectedMention({
            id: existingDocumentChat.document_context!.id,
            type: 'file',
            name: existingDocumentChat.document_context!.name,
            data: existingDocumentChat.document_context!
          });
          clearRouteParams();
          return;
        }

        // OPTIMIZATION: Create document context immediately with available data (fileName from params)
        // This allows the context to show instantly while API call enriches it in the background
        const displayName = fileNameFromParams || 'Document';
        const initialDocumentContext: Document = {
          id: fileIdNum,
          name: displayName,
          type: 'other', // Will be updated when API call completes
        };
        
        // Create a document-focused chat immediately
        const documentChat: Chat = {
          id: -2,
          title: `Document: ${truncateFilename(displayName)}`,
          type: 'document_focused',
          participants: [{ id: 1, username: 'ChatGD Assistant', email: 'ai@grabdocs.com' }],
          last_message: `Ready to answer questions about ${displayName}`,
          updated_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          unread_count: 0,
          document_context: initialDocumentContext
        };
        
        // Add the chat to the list and select it immediately
        setChats(prev => {
          const chatAssistant = prev.find(chat => chat.id === -1);
          const otherChats = prev.filter(chat => chat.id !== -1);
          
          let updatedChats: Chat[];
          if (chatAssistant) {
            updatedChats = [chatAssistant, documentChat, ...otherChats];
          } else {
            updatedChats = [documentChat, ...prev];
          }
          
          // Persist document context immediately
          savePersistedChatContexts(authUserId,updatedChats);
          return updatedChats;
        });
        
        setSelectedChat(documentChat);
        
        // Reset going back flag when setting up new chat from fileId
        setIsGoingBack(false);
        
        // Mark this fileId as processed BEFORE setting context to prevent duplicate processing
        fileIdContextProcessedRef.current.add(fileIdNum);
        
        // Set the document as the selected mention IMMEDIATELY - this shows the context right away
        // Set this synchronously in the same render cycle for instant display
        setSelectedMention({
          id: fileIdNum,
          type: 'file',
          name: displayName,
          data: initialDocumentContext
        });
        
        // Don't show welcome message - just show empty chat
        setMessages([]);
        loadedChatIdRef.current = documentChat.id;
        
        // Clear the params to prevent re-triggering (but context is already set)
        clearRouteParams();
        
        // Reset the flag after a short delay to allow context setup to complete
        // This prevents useFocusEffect from interfering during setup
        setTimeout(() => {
          isSettingUpFileContextRef.current = false;
        }, 1000);
        
        // Now fetch document details in the background to enrich the context (file_type, category, size)
        // This happens asynchronously and updates the context when complete
        api.getFileById(fileIdNum, Number.isFinite(workspaceIdNum) ? workspaceIdNum : undefined).then((response: any) => {
          if (response.success && response.file) {
            const documentData = response.file;
            // Prefer name from Files screen (params), then API, then fallback
            const enrichedName = fileNameFromParams || documentData.original_filename || documentData.filename || displayName;
            const enrichedDocumentContext: Document = {
              id: documentData.id,
              name: enrichedName,
              type: documentData.file_type || 'other',
              category: documentData.file_kind || documentData.category,
              size: documentData.file_size ? `${(documentData.file_size / 1024 / 1024).toFixed(2)} MB` : undefined,
            };
            
            // Update the chat with enriched context
            setChats(prev => prev.map(chat => 
              chat.id === documentChat.id && chat.document_context
                ? { 
                    ...chat, 
                    document_context: enrichedDocumentContext,
                    title: `Document: ${truncateFilename(enrichedName)}`,
                    last_message: `Ready to answer questions about ${enrichedName}`
                  }
                : chat
            ));
            
            // Update selected mention with enriched data
            setSelectedMention({
              id: enrichedDocumentContext.id,
              type: 'file',
              name: enrichedDocumentContext.name,
              data: enrichedDocumentContext
            });
            
            // Update persisted contexts
            setChats(prev => {
              savePersistedChatContexts(authUserId,prev);
              return prev;
            });
          }
        }).catch((error: any) => {
          // If API call fails, we already have the context set with fileName, so just log the error
          const errorMessage = error?.message || error?.response?.data?.message || error?.toString() || 'Unknown error';
          const statusCode = error?.response?.status;
          console.warn(`⚠️ [CHATS] Could not enrich document details for fileId ${fileIdNum}${statusCode ? ` (HTTP ${statusCode})` : ''}:`, errorMessage);
          // Context is already set with fileName, so no fallback needed
        });
        
        return; // Exit early since we've handled the immediate setup
      } catch (error: any) {
        // This catch block handles any synchronous errors
        const errorMessage = error?.message || error?.response?.data?.message || error?.toString() || 'Unknown error';
        const statusCode = error?.response?.status;
        console.warn(`⚠️ [CHATS] Error setting up document chat for fileId ${fileIdNum}${statusCode ? ` (HTTP ${statusCode})` : ''}:`, errorMessage);
        
        // Fallback: create chat with minimal context
        const fallbackName = fileNameFromParams || 'Document';
        const fallbackChat: Chat = {
          id: -2,
          title: `Document: ${truncateFilename(fallbackName)}`,
          type: 'document_focused',
          participants: [{ id: 1, username: 'ChatGD Assistant', email: 'ai@grabdocs.com' }],
          last_message: `Ready to answer questions about ${fallbackName}`,
          updated_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          unread_count: 0,
          document_context: { id: fileIdNum, name: fallbackName, type: 'other' }
        };
        
        setChats(prev => {
          const chatAssistant = prev.find(chat => chat.id === -1);
          const otherChats = prev.filter(chat => chat.id !== -1);
          
          if (chatAssistant) {
            return [chatAssistant, fallbackChat, ...otherChats];
          } else {
            return [fallbackChat, ...prev];
          }
        });
        setSelectedChat(fallbackChat);
        
        // Mark this fileId as processed
        fileIdContextProcessedRef.current.add(fileIdNum);
        
        setSelectedMention({
          id: fileIdNum,
          type: 'file',
          name: fallbackName,
          data: { id: fileIdNum, name: fallbackName, type: 'other' }
        });
        
        setMessages([]);
        loadedChatIdRef.current = fallbackChat.id;
        
        clearRouteParams();
        
        // Reset the flag after a short delay
        setTimeout(() => {
          isSettingUpFileContextRef.current = false;
        }, 1000);
        
        return;
      }
    };

    handleFileIdContext();
    // Removed 'loading' from dependencies to allow immediate context setup
    // Context should show instantly when fileId params are available
  }, [params.fileId, params.fileName, params.workspaceId]);

  // AI File Manager handoff: pre-fill and autosubmit (no FM imports — query string only).
  useEffect(() => {
    const rawQ = params.initialQuery ?? params.q;
    const rawAuto = params.autosubmit;
    if (!rawQ) return;
    const autosubmit =
      rawAuto === '1' ||
      rawAuto === 'true' ||
      (Array.isArray(rawAuto) && (rawAuto[0] === '1' || rawAuto[0] === 'true'));
    if (!autosubmit || fmAutosubmitHandledRef.current) return;

    const text = decodeURIComponent(String(Array.isArray(rawQ) ? rawQ[0] : rawQ)).trim();
    if (!text) return;

    fmAutosubmitHandledRef.current = true;
    setSelectedChat(DEFAULT_CHAT_ASSISTANT);
    selectedChatRef.current = DEFAULT_CHAT_ASSISTANT;
    setIsGoingBack(false);
    setNewMessage(text);
    loadMessages(-1, true);

    const t = setTimeout(() => {
      void sendMessageRef.current(text);
      try {
        clearRouteParams();
      } catch {
        /* ignore */
      }
    }, 200);
    return () => clearTimeout(t);
  }, [params.initialQuery, params.q, params.autosubmit, router]);

  // Handle bookmark context from navigation: set ref and load chats; loadChats will find existing or create -2 and load messages
  useEffect(() => {
    if (params.bookmark_id && params.bookmark_name) {
      const bookmarkContext: Bookmark = {
        id: parseInt(params.bookmark_id as string),
        name: params.bookmark_name as string,
        description: params.bookmark_description as string,
        file_count: parseInt(params.bookmark_file_count as string) || 0,
        documents: []
      };
      pendingBookmarkFromParamsRef.current = bookmarkContext;
      loadChats().then(() => { /* selection and loadMessages done inside loadChats */ });
      clearRouteParams();
    }
  }, [params.bookmark_id, params.bookmark_name, params.bookmark_description, params.bookmark_file_count]);

  // Handle workspace context from navigation
  useEffect(() => {
    if (params.workspaceId && params.workspaceName) {
      const workspaceId = parseInt(params.workspaceId as string);
      const workspaceName = params.workspaceName as string;
      
      // Start/find the real workspace chat via API
      const startWorkspaceChat = async () => {
        try {
          const response = await api.startUserChat({
            type: 'workspace',
            workspace_id: workspaceId
          });
          
          if (response.success && (response as any).chat) {
            const chatData = (response as any).chat;
            
            // Navigate to user-chat screen with the workspace chat
            router.push({
              pathname: '/user-chat',
              params: {
                chatId: chatData.id.toString(),
                chatType: 'workspace',
                workspaceId: workspaceId.toString(),
                workspaceName: workspaceName
              }
            });
          } else {
            console.error('Failed to start workspace chat:', response);
            Alert.alert('Error', 'Failed to start workspace chat. Please try again.');
          }
        } catch (error: any) {
          console.error('Error starting workspace chat:', error);
          Alert.alert('Error', error.message || 'Failed to start workspace chat. Please try again.');
        } finally {
          // Clear the params to prevent re-triggering
          clearRouteParams();
        }
      };
      
      startWorkspaceChat();
    }
  }, [params.workspaceId, params.workspaceName]);

  const startBounceAnimation = () => {
    // Keep only the button bounce animation
    Animated.loop(
      Animated.sequence([
        Animated.timing(bounceAnim, {
          toValue: 1.1,
          duration: 500,
          useNativeDriver: true,
        }),
        Animated.timing(bounceAnim, {
          toValue: 1,
          duration: 500,
          useNativeDriver: true,
        }),
      ])
    ).start();
  };

  const stopBounceAnimation = () => {
    // Stop button animation
    bounceAnim.stopAnimation();
    bounceAnim.setValue(1);
  };

  // Stop message processing
  const stopProcessing = () => {
    // Mark cancelled first so any in-flight chunk callbacks are ignored
    chatRequestCancelledRef.current = true;

    // Abort the HTTP request / polling job (signal listener cancels server job)
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    
    // Stop streaming if active
    if (streamingIntervalRef.current) {
      clearInterval(streamingIntervalRef.current);
      streamingIntervalRef.current = null;
    }
    
    // Reset streaming state
    isStreamingRef.current = false;
    isFakeStreamingRef.current = false;
    isStreamCompleteRef.current = false;
    contentBufferRef.current = '';
    displayedCharsRef.current = 0;
    pendingFinalActionRef.current = null;
    
    // Remove any incomplete assistant message
    if (streamingMessageIndex !== null) {
      setMessages(prev => {
        const newMessages = [...prev];
        const assistantMsg = newMessages[streamingMessageIndex];
        // Only remove if it's empty or very short (incomplete)
        if (assistantMsg && (!assistantMsg.content || assistantMsg.content.trim().length < 10)) {
          newMessages.splice(streamingMessageIndex, 1);
        }
        return newMessages;
      });
      streamingMessageIndexRef.current = null; // Clear ref immediately
      setStreamingMessageIndex(null); // Clear streaming message index to stop ProcessingMessageDisplay
    }
    
    streamingAssistantRowIdRef.current = null;

    // CRITICAL: Reset sendingMessage state AFTER clearing streamingMessageIndex
    // This ensures ProcessingMessageDisplay receives isProcessing={false} and stops
    setSendingMessage(false);
    stopBounceAnimation();
  };

  // Progress tracking functions - removed, only using bouncing dots
  // const startProgressTracking = (taskId: string) => { ... };
  // const stopProgressTracking = () => { ... };

  // Initialize WebSocket for user chats (must be defined before useFocusEffect)
  const initializeSocket = React.useCallback(async () => {
    try {
      const token = await secureStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
      if (!token) return;

      const socket = io(API_BASE_URL, {
        auth: { token },
        transports: ['polling', 'websocket'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: 5,
        timeout: 20000,
      });

      socket.on('connect', () => {
        setIsSocketConnected(true);
        setSelectedChat(currentChat => {
          if (currentChat && (currentChat.type === 'user_direct' || currentChat.type === 'workspace')) {
            socket.emit('join_chat_room', { chat_id: currentChat.id });
          }
          return currentChat;
        });
      });

      socket.on('disconnect', () => {
        setIsSocketConnected(false);
      });

      // Listen for new messages (only for user chats)
      socket.on('new_chat_message', (data: any) => {
        // Use state setter with function form to access latest selectedChat and messages
        setSelectedChat(currentChat => {
          if (currentChat && (currentChat.type === 'user_direct' || currentChat.type === 'workspace')) {
            if (data.chat_id === currentChat.id) {
              // Get current userProfile from ref to ensure we have the latest value (not closure-stale)
              // Handle both formats: { id: ... } or { data: { id: ... } }
              const currentUserProfile = userProfileRef.current;
              const userId = currentUserProfile?.data?.id || currentUserProfile?.id;
              const senderId = data.message.sender_id;
              const messageId = data.message.id;
              
              // Check if this is our own message
              const isOwnMessage = !!(userId && senderId && 
                (senderId === userId || 
                 String(senderId) === String(userId)));
              
              // Check for duplicates BEFORE processing - use setMessages to access current messages
              setMessages(prev => {
                // First check: Is this a recently sent message ID?
                if (recentlySentMessageIdsRef.current.has(messageId)) return prev;
                
                // Second check: exact ID match in current messages
                const existingById = prev.find(msg => msg.id === messageId);
                if (existingById) {
                  // Add to recently sent set to prevent future duplicates
                  recentlySentMessageIdsRef.current.add(messageId);
                  setTimeout(() => {
                    recentlySentMessageIdsRef.current.delete(messageId);
                  }, 10000);
                  return prev;
                }
                
                // Third check: content + timestamp - catches optimistic updates
                // Use larger time window (30 seconds) to account for timezone differences (EST vs UTC)
                const duplicateByContent = prev.find(msg => {
                  if (msg.content !== data.message.content) {
                    return false;
                  }
                  // Check if it's our own message (either flag is true or in recently sent set)
                  const isOwnMessage = msg.is_own_message === true || recentlySentMessageIdsRef.current.has(msg.id);
                  if (!isOwnMessage) {
                    return false;
                  }
                  // Normalize timestamps - ensure UTC parsing by appending Z if missing
                  const msgTimeStr = msg.created_at + (msg.created_at.includes('T') && !msg.created_at.match(/[Z+-]/) ? 'Z' : '');
                  const newMsgTimeStr = data.message.created_at + (data.message.created_at.includes('T') && !data.message.created_at.match(/[Z+-]/) ? 'Z' : '');
                  const msgTime = new Date(msgTimeStr).getTime();
                  const newMsgTime = new Date(newMsgTimeStr).getTime();
                  const timeDiff = Math.abs(msgTime - newMsgTime);
                  // Use 30 second window to account for EST/UTC differences and network delays
                  return timeDiff < 30000;
                });
                
                if (duplicateByContent) {
                  // Add to recently sent set to prevent future duplicates
                  recentlySentMessageIdsRef.current.add(messageId);
                  setTimeout(() => {
                    recentlySentMessageIdsRef.current.delete(messageId);
                  }, 10000);
                  return prev;
                }
                
                // Fourth check: If this is our own message, it was already added optimistically - skip it
                if (isOwnMessage) {
                  // Also add to recently sent set to prevent future duplicates
                  recentlySentMessageIdsRef.current.add(messageId);
                  setTimeout(() => {
                    recentlySentMessageIdsRef.current.delete(messageId);
                  }, 10000);
                  return prev;
                }
                
                // This is a new received message - add it
                const newMsg: ChatMessage = {
                  id: messageId,
                  content: data.message.content,
                  sender: data.message.sender,
                  is_own_message: false, // This is a received message, not our own
                  created_at: data.message.created_at,
                };
                
                // Update chat list when adding new message
                setChats(prevChats => {
                  const next = prevChats.map(chat =>
                    chat.id === data.chat_id
                      ? {
                          ...chat,
                          last_message: data.message.content.substring(0, 50),
                          updated_at: data.message.created_at || new Date().toISOString(),
                        }
                      : chat,
                  );
                  next.forEach((c) => {
                    if (c.id === data.chat_id) delete (c as any).last_message_at;
                  });
                  // Sort by activity so the chat rises when a message arrives while on the list
                  return [...next].sort((a, b) => {
                    if (a.id === -1) return -1;
                    if (b.id === -1) return 1;
                    const ta = Math.max(
                      parseChatActivityTimestamp((a as any).last_message_at),
                      parseChatActivityTimestamp(a.updated_at),
                      parseChatActivityTimestamp(a.created_at),
                    );
                    const tb = Math.max(
                      parseChatActivityTimestamp((b as any).last_message_at),
                      parseChatActivityTimestamp(b.updated_at),
                      parseChatActivityTimestamp(b.created_at),
                    );
                    return tb - ta;
                  });
                });
                
                return [...prev, newMsg];
              });
            }
          }
          return currentChat;
        });
      });

      // Listen for typing indicators
      socket.on('chat_typing', (data: any) => {
        if (!data || data.chat_id == null || data.user_id == null) return;
        
        // Use state setters with function form to access latest values
        setSelectedChat(currentChat => {
          if (currentChat && (currentChat.type === 'user_direct' || currentChat.type === 'workspace')) {
            const userId = userProfileRef.current?.data?.id || userProfileRef.current?.id;
            if (data.chat_id === currentChat.id && data.user_id !== userId) {
              if (data.is_typing) {
                // Try to get username from multiple sources (same as web)
                let displayName: string | null = null;
                
                // 1. Check participants first
                const participant = currentChat?.participants?.find((p: any) => 
                  p.id === data.user_id || p.user_id === data.user_id
                );
                
                if (participant) {
                  const user = (participant as any).user || participant;
                  if (user.firstName && user.lastName) {
                    displayName = `${user.firstName} ${user.lastName}`.trim();
                  } else if (user.username) {
                    displayName = user.username;
                  } else if (user.name) {
                    displayName = user.name;
                  }
                }
                
                // 2. Check messages for sender info (fallback) - use state setter to get latest
                if (!displayName) {
                  setMessages(currentMessages => {
                    if (currentMessages.length > 0) {
                      const reversed = [...currentMessages].reverse();
                      const matchedMsg = reversed.find((m) => 
                        m.sender && (m.sender.id === data.user_id || (m.sender as any).user_id === data.user_id)
                      );
                      if (matchedMsg && matchedMsg.sender) {
                        const sender = matchedMsg.sender as any;
                        if (sender.firstName && sender.lastName) {
                          displayName = `${sender.firstName} ${sender.lastName}`.trim();
                        } else if (sender.username) {
                          displayName = sender.username;
                        } else if (sender.name) {
                          displayName = sender.name;
                        }
                      }
                    }
                    return currentMessages;
                  });
                }
                
                // 3. Fallback to users list (already loaded for mentions) - use state setter to get latest
                if (!displayName) {
                  setUsers(currentUsers => {
                    const userFromList = currentUsers.find((u: any) => u.id === data.user_id) as any;
                    if (userFromList) {
                      if (userFromList.firstName && userFromList.lastName) {
                        displayName = `${userFromList.firstName} ${userFromList.lastName}`.trim();
                      } else if (userFromList.username) {
                        displayName = userFromList.username;
                      }
                    }
                    return currentUsers;
                  });
                }
                
                const username = displayName || 'Someone';
                setTypingUsers(prev => ({ ...prev, [data.user_id]: username }));
              } else {
                setTypingUsers(prev => {
                  const updated = { ...prev };
                  delete updated[data.user_id];
                  return updated;
                });
              }
            }
          }
          return currentChat;
        });
      });

      socket.on('error', (error: any) => {
        console.error('[CHATS] Socket error:', error);
      });

      socket.on('connect_error', (error: any) => {
        console.warn('[CHATS] Socket connection error:', error.message);
      });

      socketRef.current = socket;
    } catch (error) {
      console.warn('[CHATS] Failed to initialize socket:', error);
    }
  }, [userProfile]); // Removed selectedChat - handle room joining separately

      // Track keyboard for mention dropdown and so input sits just above keyboard
      useEffect(() => {
        const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
        const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
        const keyboardWillShowListener = Keyboard.addListener(showEvent, (e) => {
          setKeyboardTop(e.endCoordinates.screenY);
        });
        const keyboardWillHideListener = Keyboard.addListener(hideEvent, () => {
          setKeyboardTop(null);
        });

        return () => {
          keyboardWillShowListener.remove();
          keyboardWillHideListener.remove();
        };
      }, []);

      // Join/leave chat room when user chat is selected (only user_direct and workspace use socket rooms)
      useEffect(() => {
        const needsRoom = selectedChat && (selectedChat.type === 'user_direct' || selectedChat.type === 'workspace');
        if (needsRoom && socketRef.current && isSocketConnected) {
          socketRef.current.emit('join_chat_room', { chat_id: selectedChat.id });
          return () => {
            if (socketRef.current && isSocketConnected) {
              socketRef.current.emit('leave_chat_room', { chat_id: selectedChat.id });
            }
          };
        }
      }, [selectedChat, isSocketConnected]);

  // Initial data load is handled by useFocusEffect below — it fires on first mount AND
  // on every subsequent screen focus, so a separate mount-only useEffect would cause a
  // duplicate parallel network burst on every cold open (8 redundant requests).

  // Reload users when direct chat modal opens
  useEffect(() => {
    if (showNewChatModal && newChatType === 'user_direct') {
      loadUsers().catch(error => {
        console.error('❌ Failed to reload users for direct chat:', error);
      });
    }
  }, [showNewChatModal, newChatType]);

  // Refresh chat list when screen comes into focus
  // Add debounce to prevent excessive reloads when quickly switching screens
  const RELOAD_DEBOUNCE_MS = 1000; // Don't reload if less than 1 second since last load (reduced for better responsiveness)
  
  useFocusEffect(
    React.useCallback(() => {
      // CRITICAL: Skip reload if we're currently setting up file context
      // This prevents all the API calls from happening when user just added a file context
      // BUT: Only skip if it's been less than 2 seconds since we started setting up
      // This ensures that if user navigates away and back, it will refresh
      if (isSettingUpFileContextRef.current) {
        const timeSinceSetup = Date.now() - fileContextSetupStartTimeRef.current;
        if (timeSinceSetup < 2000) return;
        isSettingUpFileContextRef.current = false;
      }
      
      if (isPreservingContextRef.current) {
        const timeSincePreservation = Date.now() - contextPreservationTimeRef.current;
        if (timeSincePreservation < 2000) return;
        isPreservingContextRef.current = false;
      }
      
      // Debounce reloads to prevent excessive API calls when quickly switching screens
      // BUT: If it's been more than 5 seconds since last load, user likely navigated away and back
      // In that case, skip debounce and always refresh to get latest data
      // NOTE: This does NOT refresh every 5 seconds - it only checks when screen comes into focus
      const now = Date.now();
      const timeSinceLastLoad = now - lastLoadTimeRef.current;
      const shouldSkipDebounce = timeSinceLastLoad > 5000; // Skip debounce if more than 5 seconds (user navigated away)
      
      if (!shouldSkipDebounce && timeSinceLastLoad < RELOAD_DEBOUNCE_MS) return;
      
      lastLoadTimeRef.current = now;
      
      // Load user profile first (needed for determining is_own_message)
      const loadUserProfile = async () => {
        try {
          const response = await api.getUserProfile();
          if (response) {
            setUserProfile(response);
            userProfileRef.current = response; // Update ref as well
          }
        } catch (error: any) {
          // Handle timeout and connection errors gracefully
          if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
            console.warn('⚠️ User profile request timed out - will retry on next focus');
          } else if (error.message?.includes('Failed to fetch')) {
            console.warn('⚠️ User profile request failed - backend may be unavailable');
          } else {
            console.error('Failed to load user profile:', error);
          }
          // Don't set userProfile to null - keep existing value if available
        }
      };
      
      // Load favorites from storage (merge with current so server favorites from loadChats are not lost)
      const loadFavorites = async () => {
        try {
          const favKey = authUserId ? favoriteChatsStorageKey(authUserId) : null;
          if (!favKey) return;
          const stored = await AsyncStorage.getItem(favKey);
          if (stored) {
            const favoriteIds = JSON.parse(stored) as number[];
            setFavoriteChatIds(prev => {
              const next = new Set(prev);
              favoriteIds.forEach(id => next.add(id));
              return next;
            });
          }
        } catch (error) {
          console.error('Failed to load favorites:', error);
        }
      };
      
      // Initialize socket and load chats in parallel (user profile can load separately)
      initializeSocket();

      // Debounce the heavy chat-list reload: only refresh if 30s have elapsed since last load.
      // This prevents 6 parallel API calls every time the user taps the Chats tab.
      const focusNow = Date.now();
      const shouldReloadChatList = focusNow - chatListLastLoadRef.current > CHAT_LIST_DEBOUNCE_MS;
      if (shouldReloadChatList) chatListLastLoadRef.current = focusNow;

      Promise.all([
        loadUserProfile(),
        shouldReloadChatList ? loadChats() : Promise.resolve(),
        loadFavorites(),
        shouldReloadChatList ? loadWorkspaces() : Promise.resolve(),
        shouldReloadChatList ? loadDocuments() : Promise.resolve(),
        shouldReloadChatList ? loadBookmarks() : Promise.resolve(),
      ]).then(() => {
        const timeSinceLastMessage = Date.now() - lastMessageSentTimeRef.current;
        const shouldSkipReload = timeSinceLastMessage < 3000;
        const currentSelectedChat = selectedChatRef.current;
        const isTemporaryChat = currentSelectedChat && (currentSelectedChat.id === -2 || currentSelectedChat.id === -1);
        
        if (currentSelectedChat && currentSelectedChat.id && currentSelectedChat.id !== -1 && !isTemporaryChat && !shouldSkipReload) {
            // Use forceReload:false so the existing dedup logic in loadMessages handles
            // the "already loaded for this chat" case without firing a redundant request.
            loadMessages(currentSelectedChat.id, false).then(() => {
              // CRITICAL: Restore context after reloading messages to ensure it persists permanently
              // Find the updated chat from the chats list to get latest context
              setChats(prevChats => {
                const updatedChat = prevChats.find(c => c.id === currentSelectedChat.id);
                if (updatedChat) {
                  // Restore context using the helper function
                  restoreChatContext(updatedChat);
                } else {
                  // If chat not found in updated list, use current selected chat
                  restoreChatContext(currentSelectedChat);
                }
                return prevChats;
              });
            });
        }
      }).catch(error => {
        console.error('Error refreshing data on focus:', error);
      });
    }, [])
  );

  // Cleanup effect to abort any ongoing requests when component unmounts
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      stopBounceAnimation();
      // stopProgressTracking(); // Removed - only using bouncing dots now
    };
  }, []);

  // Track previous selectedChat to detect when returning from conversation
  const prevSelectedChatRef = useRef<Chat | null>(null);
  
  // Re-sort chats when favorites change
  useEffect(() => {
    setChats(prev => {
      const sorted = sortChatsByLastMessage(prev);
      // Also update filteredChats if not searching
      if (!searchQuery.trim()) {
        setFilteredChats(sorted);
      }
      return sorted;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [favoriteChatIds.size]);

  // Re-sort chats when returning from a conversation (selectedChat becomes null)
  useEffect(() => {
    // Only sort when transitioning from a chat to null (returning from conversation)
    // This ensures sorting happens when user returns to list, not when switching tabs
    if (prevSelectedChatRef.current !== null && selectedChat === null) {
      // User returned from conversation, re-sort the chats by last message timestamp
      setChats(prevChats => {
        if (prevChats.length === 0) return prevChats;
        return sortChatsByLastMessage(prevChats);
      });
    }
    // Update the ref for next comparison
    prevSelectedChatRef.current = selectedChat;
  }, [selectedChat]);

  // Filter data based on search query
  useEffect(() => {
    if (!searchQuery.trim()) {
      // Sort chats by last message timestamp (most recent first) but keep ChatGD Assistant at the top
      const finalChats = sortChatsByLastMessage(chats);
      
      setFilteredChats(finalChats);
      
      setFilteredDocuments(documents);
      setFilteredWorkspaces(workspaces);
      setFilteredUsers(users);
      setFilteredBookmarks(bookmarks);
    } else {
      const query = searchQuery.toLowerCase();
      const filteredChatsList = chats.filter(chat => {
        if (!chat || typeof chat !== 'object') return false;
        const title = String(chat.title || '').toLowerCase();
        const lastMessage = String(chat.last_message || '').toLowerCase();
        return title.includes(query) || lastMessage.includes(query);
      });
      
      // Sort filtered chats by last message timestamp (most recent first)
      const finalFilteredChats = sortChatsByLastMessage(filteredChatsList);
      
      setFilteredChats(finalFilteredChats);
      
      setFilteredDocuments(documents.filter(doc => 
        doc.name.toLowerCase().includes(query) ||
        (doc.category && doc.category.toLowerCase().includes(query))
      ));
      setFilteredWorkspaces(workspaces.filter(ws => 
        ws.name.toLowerCase().includes(query) ||
        (ws.description && ws.description.toLowerCase().includes(query))
      ));
      setFilteredUsers(users.filter(user => 
        user.username.toLowerCase().includes(query) ||
        user.email.toLowerCase().includes(query)
      ));
      setFilteredBookmarks(bookmarks.filter(bookmark => 
        bookmark.name.toLowerCase().includes(query) ||
        (bookmark.description && bookmark.description.toLowerCase().includes(query))
      ));
    }
  }, [searchQuery, chats, documents, workspaces, users, bookmarks]);
  
  // Filtered lists for new chat modal (separate from main search)
  // Never show the current user — chatting with yourself is not allowed.
  const modalFilteredUsers = useMemo(() => {
    const myId = currentUserIdRef.current;
    const withoutSelf =
      myId != null ? users.filter((user) => String(user.id) !== String(myId)) : users;

    if (!modalUserSearch.trim()) {
      return withoutSelf;
    }

    const query = modalUserSearch.toLowerCase();
    return withoutSelf.filter(
      (user) =>
        user.username.toLowerCase().includes(query) ||
        user.email.toLowerCase().includes(query)
    );
  }, [modalUserSearch, users, authUser?.id, userProfile]);
  
  const modalFilteredWorkspaces = useMemo(() => {
    if (!modalWorkspaceSearch.trim()) return workspaces;
    const query = modalWorkspaceSearch.toLowerCase();
    return workspaces.filter(ws => 
      ws.name.toLowerCase().includes(query) ||
      (ws.description && ws.description.toLowerCase().includes(query))
    );
  }, [modalWorkspaceSearch, workspaces]);
  
  const modalFilteredDocuments = useMemo(() => {
    if (!modalDocumentSearch.trim()) return documents;
    const query = modalDocumentSearch.toLowerCase();
    return documents.filter(doc => 
      doc.name.toLowerCase().includes(query) ||
      (doc.category && doc.category.toLowerCase().includes(query))
    );
  }, [modalDocumentSearch, documents]);
  
  const modalFilteredBookmarks = useMemo(() => {
    if (!modalBookmarkSearch.trim()) return bookmarks;
    const query = modalBookmarkSearch.toLowerCase();
    return bookmarks.filter(bookmark => 
      bookmark.name.toLowerCase().includes(query) ||
      (bookmark.description && bookmark.description.toLowerCase().includes(query))
    );
  }, [modalBookmarkSearch, bookmarks]);

  // 3-tier hybrid @ mention search:
  //   Tier 1 (empty query)  → local cache only, no server call
  //   Tier 2 (1-2 chars)   → local cache only, instant, no server call
  //   Tier 3 (≥3 chars)    → show local results immediately + background server search
  //                           (200ms debounce, AbortController cancels stale requests)
  useEffect(() => {
    // Cancel previous debounce
    if (mentionSearchTimerRef.current) {
      clearTimeout(mentionSearchTimerRef.current);
      mentionSearchTimerRef.current = null;
    }
    // Abort any in-flight server request
    if (mentionAbortControllerRef.current) {
      mentionAbortControllerRef.current.abort();
      mentionAbortControllerRef.current = null;
    }
    mentionSearchSeqRef.current += 1;

    const q = mentionQuery.trim();
    if (q.length >= 3) {
      // Tier 3: local results are shown immediately by the filter effect below;
      // server search runs silently in background after debounce
      setIsMentionSearching(true);
      mentionSearchTimerRef.current = setTimeout(() => {
        searchDocumentsForMention(q);
      }, 200);
    } else {
      // Tier 1 & 2: local only
      setIsMentionSearching(false);
      setMentionFileSearchResults([]);
    }
    return () => {
      if (mentionSearchTimerRef.current) {
        clearTimeout(mentionSearchTimerRef.current);
        mentionSearchTimerRef.current = null;
      }
    };
  }, [mentionQuery]); // intentionally excludes mentionFileSearchResults

  // Filter mention results based on query
  useEffect(() => {
    const query = mentionQuery.trim().toLowerCase();
    let results: any[] = [];

    // Server search results are already filtered by the backend — trust them completely.
    // Do NOT re-apply a client-side name filter: the metadata_only response may omit
    // original_filename, so doc.name could be a storage hash that doesn't contain the
    // query term, even though the server correctly found it.
    const serverResultIds = new Set<number>(mentionFileSearchResults.map(d => d.id));

    // Debug: Log data availability when mention query changes
    if (showMentionModal) {
      if (__DEV__) console.log('📋 @ Mention modal open, data availability:', {
        serverResults: mentionFileSearchResults.length,
        localCache: documents.length,
        users: users.length,
        workspaces: workspaces.length,
        bookmarks: bookmarks.length,
        query: query
      });
    }

    if (query) {
      // 1. All server search results shown as-is (server already applied the query)
      const serverDocResults = mentionFileSearchResults.map(doc => ({
        type: 'file',
        id: doc.id,
        name: doc.name,
        subtitle: doc.category || doc.type || 'Document',
        data: doc
      }));

      // 2. Locally-cached docs that also match — only add ones not already in server results
      const localDocResults = documents.filter(doc => {
        if (serverResultIds.has(doc.id)) return false; // already shown via server results
        const fileName = doc.name.toLowerCase();
        const category = (doc.category || '').toLowerCase();
        const type = (doc.type || '').toLowerCase();
        return fileName.includes(query) ||
               category.includes(query) ||
               type.includes(query) ||
               fileName.split(/[\s\-_.]/).some(word => word.startsWith(query)) ||
               fileName.split(/[\s\-_.]/).map(word => word.charAt(0)).join('').includes(query);
      }).map(doc => ({
        type: 'file',
        id: doc.id,
        name: doc.name,
        subtitle: doc.category || doc.type || 'Document',
        data: doc
      }));

      const documentResults = [...serverDocResults, ...localDocResults];

      // Filter users (exclude self — cannot start a direct chat with yourself)
      const myId = currentUserIdRef.current;
      const userResults = users.filter(user => 
        (myId == null || String(user.id) !== String(myId)) &&
        (user.username.toLowerCase().includes(query) ||
        user.email.toLowerCase().includes(query))
      ).map(user => ({
        type: 'user',
        id: user.id,
        name: user.username,
        subtitle: user.email,
        data: user
      }));

      // Filter workspaces
      const workspaceResults = workspaces.filter(ws => 
        ws.name.toLowerCase().includes(query) ||
        (ws.description && ws.description.toLowerCase().includes(query))
      ).map(ws => ({
        type: 'workspace',
        id: ws.id,
        name: ws.name,
        subtitle: `${ws.member_count} members`,
        data: ws
      }));

      // Filter bookmarks
      const bookmarkResults = bookmarks.filter(bookmark => 
        bookmark.name.toLowerCase().includes(query) ||
        (bookmark.description && bookmark.description.toLowerCase().includes(query))
      ).map(bookmark => ({
        type: 'bookmark',
        id: bookmark.id,
        name: bookmark.name,
        subtitle: `${bookmark.file_count} files`,
        data: bookmark
      }));

      // Combine all results, prioritize files first (most relevant for AI), then users, workspaces, bookmarks
      results = [...documentResults, ...userResults, ...workspaceResults, ...bookmarkResults];
    } else {
      // Tier 1: empty @ — show recently cached files + users + workspaces + bookmarks.
      // No server call; all from local cache for instant display.
      const recentDocuments = documents.slice(0, 5).map(doc => ({
        type: 'file',
        id: doc.id,
        name: doc.name,
        subtitle: doc.category || doc.type || 'Document',
        data: doc
      }));

      const myIdForMentions = currentUserIdRef.current;
      const recentUsers = (users || [])
        .filter((user) => myIdForMentions == null || String(user.id) !== String(myIdForMentions))
        .slice(0, 2)
        .map(user => ({
        type: 'user',
        id: user.id,
        name: user.username,
        subtitle: user.email,
        data: user
      }));

      const recentWorkspaces = (workspaces || []).slice(0, 2).map(ws => ({
        type: 'workspace',
        id: ws.id,
        name: ws.name,
        subtitle: `${ws.member_count} members`,
        data: ws
      }));

      const recentBookmarks = (bookmarks || []).slice(0, 2).map(bookmark => ({
        type: 'bookmark',
        id: bookmark.id,
        name: bookmark.name,
        subtitle: `${bookmark.file_count} files`,
        data: bookmark
      }));

      results = [...recentDocuments, ...recentUsers, ...recentWorkspaces, ...recentBookmarks];
    }

    setMentionResults(results);

    if (__DEV__ && showMentionModal) {
      if (results.length > 0) {
        console.log(`📋 @ Mention results: ${results.length} items`, {
          files: results.filter(r => r.type === 'file').length,
          users: results.filter(r => r.type === 'user').length,
          workspaces: results.filter(r => r.type === 'workspace').length,
          bookmarks: results.filter(r => r.type === 'bookmark').length,
        });
      } else {
        console.log('⚠️ @ Mention: no results', {
          serverResults: mentionFileSearchResults.length,
          localCache: documents.length,
          usersAvailable: users.length,
          query: query || '(empty)',
        });
      }
    }
  }, [mentionQuery, users, bookmarks, workspaces, documents, mentionFileSearchResults, showMentionModal]);

  // Helper: get "last activity" timestamp for ordering.
  // Use the newest of last_message_at / updated_at / created_at so a just-bumped
  // updated_at is never ignored because of a stale last_message_at field.
  const getLastMessageTimestamp = (chat: Chat): number => {
    try {
      return Math.max(
        parseChatActivityTimestamp((chat as any).last_message_at),
        parseChatActivityTimestamp(chat.updated_at),
        parseChatActivityTimestamp(chat.created_at),
      );
    } catch (error) {
      if (__DEV__) console.log('❌ Error getting last message timestamp:', error, 'for chat:', chat.id);
      return 0;
    }
  };

  /** Section label for date grouping in conversation: Today, Yesterday, or "Monday, 10 Feb" (with year if different). */
  const getDateSectionLabel = (timestamp: number): string => {
    const d = new Date(timestamp);
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    if (dayStart >= todayStart) return 'Today';
    if (dayStart >= yesterdayStart) return 'Yesterday';
    const dayName = d.toLocaleDateString('en-US', { weekday: 'long' });
    const dayMonth = d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
    if (d.getFullYear() !== now.getFullYear()) {
      return `${dayName}, ${dayMonth} ${d.getFullYear()}`;
    }
    return `${dayName}, ${dayMonth}`;
  };

  /** Messages grouped by date for conversation (oldest first: Monday, ..., Yesterday, Today). */
  const messageSections = useMemo(() => {
    const list = messages || [];
    const byLabel = new Map<string, ChatMessage[]>();
    for (const msg of list) {
      const ts = new Date(msg.created_at || 0).getTime();
      const label = getDateSectionLabel(ts);
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label)!.push(msg);
    }
    const sections: { title: string; data: ChatMessage[] }[] = [];
    const restLabels = Array.from(byLabel.keys()).filter(l => l !== 'Today' && l !== 'Yesterday');
    restLabels.sort((a, b) => {
      const dataA = byLabel.get(a)!;
      const dataB = byLabel.get(b)!;
      const maxTsA = Math.max(...dataA.map(m => new Date(m.created_at).getTime()));
      const maxTsB = Math.max(...dataB.map(m => new Date(m.created_at).getTime()));
      return maxTsA - maxTsB; // oldest first
    });
    restLabels.forEach(title => sections.push({ title, data: byLabel.get(title)! }));
    if (byLabel.has('Yesterday')) sections.push({ title: 'Yesterday', data: byLabel.get('Yesterday')! });
    if (byLabel.has('Today')) sections.push({ title: 'Today', data: byLabel.get('Today')! });
    messageSectionsRef.current = sections;
    return sections;
  }, [messages]);

  /** Flat list of header + message items with global indices — avoids SectionList index confusion that caused response text to appear in query bubbles */
  const flatMessageData = useMemo(() => {
    type FlatItem = { type: 'header'; title: string } | { type: 'message'; message: ChatMessage; globalIndex: number };
    const flat: FlatItem[] = [];
    const list = messages || [];
    if (list.length === 0) return flat;
    const byLabel = new Map<string, ChatMessage[]>();
    for (const msg of list) {
      const ts = new Date(msg.created_at || 0).getTime();
      const label = getDateSectionLabel(ts);
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label)!.push(msg);
    }
    const restLabels = Array.from(byLabel.keys()).filter(l => l !== 'Today' && l !== 'Yesterday');
    restLabels.sort((a, b) => {
      const dataA = byLabel.get(a)!;
      const dataB = byLabel.get(b)!;
      const maxTsA = Math.max(...dataA.map(m => new Date(m.created_at).getTime()));
      const maxTsB = Math.max(...dataB.map(m => new Date(m.created_at).getTime()));
      return maxTsA - maxTsB;
    });
    const orderedLabels = [...restLabels];
    if (byLabel.has('Yesterday')) orderedLabels.push('Yesterday');
    if (byLabel.has('Today')) orderedLabels.push('Today');
    let globalIndex = 0;
    for (const title of orderedLabels) {
      const data = byLabel.get(title)!;
      flat.push({ type: 'header', title });
      for (const msg of data) {
        flat.push({ type: 'message', message: msg, globalIndex });
        globalIndex++;
      }
    }
    return flat;
  }, [messages]);

  // Scroll to last message whenever flatMessageData changes (new messages loaded or added)
  useEffect(() => {
    if (flatMessageData.length === 0) return;
    scrollToLastMessage(false); // non-animated on initial load so it snaps instantly
  }, [flatMessageData]);

  // When keyboard opens, scroll so last message stays visible above the keyboard
  useEffect(() => {
    if (keyboardTop == null) return;
    const t = setTimeout(() => scrollToLastMessage(false), 150);
    return () => clearTimeout(t);
  }, [keyboardTop]);

  // Enable LayoutAnimation on Android for the empty-state ↔ conversation transition
  useEffect(() => {
    if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
      UIManager.setLayoutAnimationEnabledExperimental(true);
    }
  }, []);

  // Animate layout when the chat switches between empty-state and conversation (composer stays bottom-pinned)
  useEffect(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
  }, [isEmptyChat]);

  // Sort chat list: ChatGD Assistant (id === -1) always first; favorites right after; then all others by last activity (most recent first).
  const sortChatsByLastMessage = (chatsToSort: Chat[]): Chat[] => {
    const validChats = chatsToSort.filter(chat => chat && typeof chat === 'object');
    const chatAssistant = validChats.find(chat => chat.id === -1);
    const otherChats = validChats.filter(chat => chat.id !== -1);
    
    // Separate favorites and non-favorites
    const favoriteChats = otherChats.filter(chat => favoriteChatIds.has(chat.id));
    const nonFavoriteChats = otherChats.filter(chat => !favoriteChatIds.has(chat.id));
    
    // Sort favorites by last message timestamp
    const sortedFavorites = [...favoriteChats].sort((a, b) => getLastMessageTimestamp(b) - getLastMessageTimestamp(a));
    // Sort non-favorites by last message timestamp
    const sortedNonFavorites = [...nonFavoriteChats].sort((a, b) => getLastMessageTimestamp(b) - getLastMessageTimestamp(a));
    
    // Combine: ChatGD Assistant first, then favorites, then others
    const result: Chat[] = [];
    if (chatAssistant) {
      result.push(chatAssistant);
    } else {
      result.push(DEFAULT_CHAT_ASSISTANT);
    }
    result.push(...sortedFavorites);
    result.push(...sortedNonFavorites);
    
    return result;
  };

  /** Update a chat's preview/activity and re-sort so it moves to the correct position. */
  const bumpChatActivity = (
    prev: Chat[],
    chatId: number,
    patch: Partial<Pick<Chat, 'last_message' | 'updated_at' | 'last_message_sender_id' | 'title'>> & {
      type?: Chat['type'];
      bookmark_context?: Chat['bookmark_context'];
      document_context?: Chat['document_context'];
      workspace?: Chat['workspace'];
    },
  ): Chat[] => {
    const nowIso = new Date().toISOString();
    const next = prev.map((chat) => {
      if (chat.id !== chatId) return chat;
      const updated: Chat = {
        ...chat,
        ...patch,
        updated_at: patch.updated_at || nowIso,
      };
      // Drop stale last_message_at so sorting uses the fresh updated_at
      delete (updated as any).last_message_at;
      return updated;
    });
    const k = authUserId ? chatListScreenKey(authUserId) : null;
    if (k) screenCache.invalidate(k);
    return sortChatsByLastMessage(next);
  };

  const loadChats = async (limit: number = CHATS_PAGE_SIZE, offset: number = 0) => {
    try {
      setLoading(true);
      
      // Load persisted chat contexts from AsyncStorage FIRST (survives app restart)
      const persistedContexts = await loadPersistedChatContexts(authUserId);

      // Parallel network: AI histories + user chats + favorites (was sequential; slowest path dominated load time)
      const { fetchChatHistories } = useChatStore.getState();
      let userChats: Chat[] = [];
      let rawUserChats: any[] = [];
      let userChatHasMore = false;
      let serverFavoriteHistoryIds: number[] = [];
      let serverFavoriteChatIds: number[] = [];
      let aiPagination: { has_more: boolean; total: number } = { has_more: false, total: 0 };

      const CHAT_LIST_CACHE_KEY = authUserId ? chatListScreenKey(authUserId) : null;
      const CHAT_LIST_CACHE_MS = 30_000;
      interface ChatListCacheData {
        histories: any[];
        userChats: Chat[];
        rawUserChats: any[];
        serverFavoriteHistoryIds: number[];
        serverFavoriteChatIds: number[];
        aiPagination: { has_more: boolean; total: number };
        userChatHasMore: boolean;
      }

      // On first page loads, serve cached API data immediately to skip 3 network round-trips.
      // Context restoration from AsyncStorage still runs every time (it's local & fast).
      const cachedChatData = offset === 0 && CHAT_LIST_CACHE_KEY
        ? screenCache.get<ChatListCacheData>(CHAT_LIST_CACHE_KEY, CHAT_LIST_CACHE_MS)
        : null;

      if (cachedChatData) {
        // Populate chatStore with cached histories so the rest of the merge logic works unchanged
        useChatStore.setState({ histories: cachedChatData.histories });
        userChats = cachedChatData.userChats;
        rawUserChats = cachedChatData.rawUserChats;
        serverFavoriteHistoryIds = cachedChatData.serverFavoriteHistoryIds;
        serverFavoriteChatIds = cachedChatData.serverFavoriteChatIds;
        aiPagination = cachedChatData.aiPagination;
        userChatHasMore = cachedChatData.userChatHasMore;
      } else {
        await Promise.all([
          (async () => { aiPagination = await fetchChatHistories(limit, offset); })(),
          (async () => {
            try {
              const userChatsResponse = await api.getChats(limit, offset);
              if (userChatsResponse.success && (userChatsResponse as any).chats) {
                rawUserChats = (userChatsResponse as any).chats;
                userChatHasMore = (userChatsResponse as any).pagination?.has_more ?? false;
                userChats = rawUserChats.map(mapUserChatListRow);
              }
            } catch (userChatError) {
              if (__DEV__) console.warn('Failed to load user chats:', userChatError);
            }
          })(),
          (async () => {
            try {
              const favRes = await (api as any).getChatFavorites();
              if (favRes?.success && (favRes.favorite_history_ids || favRes.favorite_chat_ids)) {
                serverFavoriteHistoryIds = Array.isArray(favRes.favorite_history_ids) ? favRes.favorite_history_ids : [];
                serverFavoriteChatIds = Array.isArray(favRes.favorite_chat_ids) ? favRes.favorite_chat_ids : [];
              }
            } catch (_) { /* non-critical */ }
          })(),
        ]);

        // Cache the raw API results so subsequent tab-focuses skip these 3 requests
        const { histories: freshHistories } = useChatStore.getState();
        if (CHAT_LIST_CACHE_KEY) {
          screenCache.set<ChatListCacheData>(CHAT_LIST_CACHE_KEY, {
            histories: freshHistories || [],
            userChats,
            rawUserChats,
            serverFavoriteHistoryIds,
            serverFavoriteChatIds,
            aiPagination,
            userChatHasMore,
          });
        }
      }

      const { histories, error, clearError } = useChatStore.getState();
      if (error) {
        console.warn('AI chat history unavailable:', error, '- showing user chats and cached data');
        clearError();
      }

      // Merge server favorites (from web or mobile) so favorites sync across devices
      setFavoriteChatIds(prev => {
        const next = new Set(prev);
        serverFavoriteHistoryIds.forEach(id => next.add(Number(id)));
        serverFavoriteChatIds.forEach(id => next.add(Number(id)));
        (histories || []).forEach((h: any) => {
          if (h.is_favorite) next.add(Number(h.id));
        });
        rawUserChats.forEach((c: any) => {
          if (c.is_favorite) next.add(Number(c.id));
        });
        const favKey = authUserId ? favoriteChatsStorageKey(authUserId) : null;
        if (favKey) {
          void AsyncStorage.setItem(favKey, JSON.stringify(Array.from(next)));
        }
        return next;
      });
      
      // Convert chat histories to the expected format, excluding any existing "ChatGD Assistant" chats
      let convertedChats: Chat[] = [];
      
      try {
        if (Array.isArray(histories)) {
          convertedChats = histories
            .filter(history => history && history.id !== -1) // Only filter out the actual default chat (ID -1)
            .map(history => {
              try {
                const lastMessage = getAiHistoryListPreview(history);
                
                // Determine chat type based on selected context
                let chatType: 'ai_assistant' | 'document_focused' | 'bookmark_focused' | 'workspace' | 'user_direct' = 'ai_assistant';
                
                const historyData = history as any; // Type assertion for backend data
                
                // Debug: Log the first few chats to see what data we're getting
                if (history.id <= 5) {
                  if (__DEV__) console.log('🔍 Chat data for ID', history.id, ':', {
                    title: history.title,
                    selected_files: historyData.selected_files,
                    selected_bookmarks: historyData.selected_bookmarks,
                    selected_workspaces: historyData.selected_workspaces,
                    selected_users: historyData.selected_users
                  });
                }
                
                // Determine chat type: top-level selected_* first, then persistent_context (backend often stores only there), then title heuristic
                const persistentContext = historyData.persistent_context || historyData.persistentContext;
                if (historyData.selected_files && historyData.selected_files.length > 0) {
                  chatType = 'document_focused';
                } else if (historyData.selected_bookmarks && historyData.selected_bookmarks.length > 0) {
                  chatType = 'bookmark_focused';
                } else if (historyData.selected_workspaces && historyData.selected_workspaces.length > 0) {
                  chatType = 'workspace';
                } else if (historyData.selected_users && historyData.selected_users.length > 0) {
                  chatType = 'user_direct';
                } else if (persistentContext?.context_file_ids?.length > 0 || persistentContext?.selected_files?.length > 0) {
                  chatType = 'document_focused';
                } else if (persistentContext?.context_bookmark_ids?.length > 0 || persistentContext?.selected_bookmarks?.length > 0) {
                  chatType = 'bookmark_focused';
                } else {
                  // Fallback: infer from title
                  const title = String(history.title || '').toLowerCase();
                  if (title.includes('document') || title.includes('file') || title.includes('pdf') || title.includes('doc') || title.includes('chat about')) {
                    chatType = 'document_focused';
                  } else if (title.includes('bookmark') || title.includes('collection')) {
                    chatType = 'bookmark_focused';
                  } else if (title.includes('workspace') || title.includes('team')) {
                    chatType = 'workspace';
                  } else if (title.includes('user') || title.includes('direct') || title.includes('message')) {
                    chatType = 'user_direct';
                  }
                }
                
                // Debug: Log the determined chat type
                if (history.id <= 5) {
                }
                
                // Handle timestamp formatting for chat timestamps
                // Use last_message_at for chat listings (when last message was sent)
                // Use created_at for chat creation time
                let updatedAt = (history as any).last_message_at || history.updated_at || history.created_at || '';
                let createdAt = history.created_at || updatedAt || '';
                
                // Don't add timezone indicators - treat as local time
                // The backend timestamps are already in the correct format
                
                // For document_focused: title is "Document: {filename}" when we have file context; else use history.title
                // For user_direct: title is recipient name (backend Secure Messaging titles; fallback if missing)
                const resolveTitle = (): string => {
                  if (chatType === 'document_focused') {
                    const pc = historyData.persistent_context || historyData.persistentContext;
                    const ids = pc?.context_file_ids || pc?.selected_files || historyData.selected_files;
                    if (ids && ids.length > 0) {
                      const name = historyData.selected_file_names?.[0] || historyData.selected_file_name || `Document ${ids[0]}`;
                      return `Document: ${truncateFilename(name)}`;
                    }
                  }
                  if (chatType === 'user_direct') {
                    const t = history.title?.trim();
                    if (t) return t;
                    if (historyData.selected_user_names?.[0]) return historyData.selected_user_names[0];
                    return 'Secure message';
                  }
                  return String(history.title || 'Untitled Chat');
                };

                return {
                  id: Number(history.id) || Math.random(),
                  title: resolveTitle(),
                  type: chatType,
                  source: 'llm' as const,
                  participants: [{ id: 1, username: 'ChatGD Assistant', email: 'ai@grabdocs.com' }],
                  last_message: String(lastMessage || 'No messages yet'),
                  updated_at: String(updatedAt),
                  created_at: String(createdAt),
                  unread_count: 0,
                  ...((history as any).last_message_at
                    ? { last_message_at: String((history as any).last_message_at) }
                    : {}),
                  // Store context data for future use
                  // Priority: persistent_context (most up-to-date) > selected_files/selected_bookmarks (initial context)
                  document_context: (() => {
                    const persistentContext = historyData.persistent_context || historyData.persistentContext;
                    const contextFileIds = persistentContext?.context_file_ids || persistentContext?.selected_files || historyData.selected_files;
                    if (contextFileIds && contextFileIds.length > 0) {
                      return {
                        id: contextFileIds[0],
                        name: historyData.selected_file_names?.[0] || historyData.selected_file_name || `Document ${contextFileIds[0]}`,
                        type: 'other' as const
                      };
                    }
                    return undefined;
                  })(),
                  bookmark_context: (() => {
                    const persistentContext = historyData.persistent_context || historyData.persistentContext;
                    const contextBookmarkIds = persistentContext?.context_bookmark_ids || persistentContext?.selected_bookmarks || historyData.selected_bookmarks;
                    if (contextBookmarkIds && contextBookmarkIds.length > 0) {
                      const bookmarkId = contextBookmarkIds[0];
                      // Try to find bookmark in loaded bookmarks list first
                      const bookmarkInList = bookmarks.find(b => b.id === bookmarkId);
                      if (bookmarkInList) {
                        return bookmarkInList;
                      }
                      // Fallback to basic bookmark object
                      return {
                        id: bookmarkId,
                        name: historyData.selected_bookmark_names?.[0] || historyData.selected_bookmark_name || String(history.title || 'Bookmark'),
                        description: '',
                        file_count: 0,
                        documents: []
                      };
                    }
                    return undefined;
                  })()
                };
              } catch (itemError) {
                console.error('Error processing chat history item:', itemError);
                return null;
              }
            })
            .filter(Boolean) as Chat[]; // Remove null items
        }
      } catch (conversionError) {
        console.error('Error converting chat histories:', conversionError);
        convertedChats = [];
      }
      
      // Combine AI chats and user chats, removing duplicates by ID
      const allChatsCombined = [...convertedChats, ...userChats];
      
      // CRITICAL: Include temporary chats (id -2) from current chats list that have context
      // These are newly created bookmark/document chats that haven't been saved to backend yet
      // Exclude -2 when backend already has a chat with the same bookmark/document so list shows real chat with actual query text
      const backendChatsOnly = [...convertedChats, ...userChats];
      const currentChatsWithContext = chats.filter(chat => {
        if (chat.id !== -2 || (!chat.bookmark_context && !chat.document_context && !chat.workspace)) return false;
        const bookmarkId = chat.bookmark_context?.id;
        const docId = chat.document_context?.id;
        const backendHasMatch = bookmarkId
          ? backendChatsOnly.some(c => c.bookmark_context?.id === bookmarkId)
          : docId ? backendChatsOnly.some(c => c.document_context?.id === docId) : false;
        return !backendHasMatch; // only include -2 if backend doesn't have this chat yet
      });
      const placeholderFromRef = placeholderChatToPreserveRef.current;
      if (placeholderFromRef && placeholderFromRef.id === -2 && (placeholderFromRef.bookmark_context || placeholderFromRef.document_context)) {
        // Only add placeholder if backend doesn't have a matching chat (by bookmark/doc id)
        const bookmarkId = placeholderFromRef.bookmark_context?.id;
        const docId = placeholderFromRef.document_context?.id;
        const backendHasMatch = bookmarkId
          ? backendChatsOnly.some(c => c.bookmark_context?.id === bookmarkId)
          : docId
            ? backendChatsOnly.some(c => c.document_context?.id === docId)
            : false;
        if (!backendHasMatch && !currentChatsWithContext.some(c =>
          (bookmarkId && c.bookmark_context?.id === bookmarkId) || (docId && c.document_context?.id === docId)
        )) {
          currentChatsWithContext.push(placeholderFromRef);
        }
        placeholderChatToPreserveRef.current = null; // Clear after use
      }
      if (currentChatsWithContext.length > 0) {
        allChatsCombined.push(...currentChatsWithContext);
      }

      // CRITICAL: Re-inject bookmark from nav params if loadChats overwrote the list (focus ran with stale chats)
      // Check against backend-only list so we find existing bookmark chat and load its messages
      let injectedBookmarkChat: Chat | null = null;
      const pendingBookmark = pendingBookmarkFromParamsRef.current;
      const hadPendingBookmark = !!pendingBookmark;
      const pendingBookmarkId = pendingBookmark?.id ?? null;
      if (pendingBookmark) {
        const backendChatsOnly = [...convertedChats, ...userChats];
        const hasBookmarkChat = backendChatsOnly.some(
          c => c.bookmark_context?.id === pendingBookmark.id || (c as any).bookmark_context?.id === pendingBookmark.id
        );
        if (!hasBookmarkChat) {
          const bookmarkChat: Chat = {
            id: -2,
            title: `Chat about ${pendingBookmark.name}`,
            type: 'bookmark_focused',
            participants: [{ id: 1, username: 'ChatGD Assistant', email: 'ai@grabdocs.com' }],
            last_message: `Ready to answer questions about ${pendingBookmark.name}`,
            updated_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
            unread_count: 0,
            bookmark_context: pendingBookmark
          };
          const chatAssistantIdx = allChatsCombined.findIndex(chat => chat.id === -1);
          if (chatAssistantIdx >= 0) {
            allChatsCombined.splice(chatAssistantIdx + 1, 0, bookmarkChat);
          } else {
            allChatsCombined.unshift(bookmarkChat);
          }
          injectedBookmarkChat = bookmarkChat;
        }
        pendingBookmarkFromParamsRef.current = null; // Only inject once
      }

      // CRITICAL: Use composite key to prevent AI chat histories and user chats from colliding
      // They can have overlapping numeric IDs from different backends - e.g. AI chat 95 (bookmark) vs user chat 95
      const getChatKey = (c: Chat) => (c.type === 'user_direct' || c.type === 'workspace' ? 'user_' : 'ai_') + c.id;

      // CRITICAL: Preserve document_focused type and document_context from existing local state
      // Build map from: 1) Persisted AsyncStorage contexts, 2) Current in-memory state (uses composite keys)
      const existingChatsMap = new Map<string, Chat>();
      const parseIdFromKey = (k: string) => (String(k).startsWith('ai_') || String(k).startsWith('user_')) ? parseInt(String(k).replace(/^(ai_|user_)/, ''), 10) : Number(k);
      
      // First, add persisted contexts from AsyncStorage (survives app restart)
      persistedContexts.forEach((context: any, chatId: string) => {
        // CRITICAL: Load ALL persisted contexts, even if type isn't set correctly
        // The type might be wrong but context exists
        if (context.type === 'document_focused' || 
            context.type === 'bookmark_focused' || 
            context.type === 'user_direct' || 
            context.type === 'workspace' ||
            context.bookmark_context ||
            context.document_context ||
            context.workspace) {
          // Determine correct type based on context
          const correctType = context.bookmark_context ? 'bookmark_focused' :
                             context.document_context ? 'document_focused' :
                             context.workspace ? 'workspace' :
                             context.type === 'user_direct' ? 'user_direct' :
                             (context.type as any);
          
          // Create a minimal Chat object from persisted context
          const persistedKey = String(chatId);
          existingChatsMap.set(persistedKey, {
            id: parseIdFromKey(persistedKey),
            title: context.title,
            type: correctType,
            source: persistedKey.startsWith('user_') ? 'user' as const : 'llm' as const,
            participants: context.participants || [],
            last_message: '',
            // No fake "now" — stubs must not beat API last_message_at on reload
            updated_at: '',
            created_at: '',
            document_context: context.document_context,
            bookmark_context: context.bookmark_context,
            workspace: context.workspace
          });
          
        }
      });
      
      // Then, add/overwrite with current in-memory state (most recent)
      // CRITICAL: Include temporary chats (id -2) with context so they appear in the list
      // ALSO: Include ANY chat that has context, even if type isn't set correctly yet
      chats.forEach(chat => {
        if (chat.type === 'document_focused' || 
            chat.type === 'bookmark_focused' || 
            chat.type === 'user_direct' || 
            chat.type === 'workspace') {
          existingChatsMap.set(getChatKey(chat), chat);
        } else if (chat.id === -2 && (chat.bookmark_context || chat.document_context || chat.workspace)) {
          existingChatsMap.set(getChatKey(chat), chat);
        } else if (chat.bookmark_context || chat.document_context || chat.workspace) {
          // CRITICAL: Include chats that have context even if type isn't set correctly
          // This catches cases where context exists but type was lost
          const chatWithCorrectType: Chat = {
            ...chat,
            type: (chat.bookmark_context ? 'bookmark_focused' :
                  chat.document_context ? 'document_focused' :
                  chat.workspace ? 'workspace' :
                  chat.type) as 'ai_assistant' | 'user_direct' | 'workspace' | 'document_focused' | 'bookmark_focused'
          };
          existingChatsMap.set(getChatKey(chat), chatWithCorrectType);
        }
      });
      
      // CRITICAL: Also check AsyncStorage for any chats that might have been saved with real IDs
      persistedContexts.forEach((context: any, chatId: string) => {
        const key = String(chatId);
        if (!existingChatsMap.has(key) && (context.bookmark_context || context.document_context || context.workspace)) {
          const correctType = context.bookmark_context ? 'bookmark_focused' :
                             context.document_context ? 'document_focused' :
                             context.workspace ? 'workspace' :
                             (context.type as any);
          
          existingChatsMap.set(key, {
            id: parseIdFromKey(key),
            title: context.title,
            type: correctType,
            source: key.startsWith('user_') ? 'user' as const : 'llm' as const,
            participants: context.participants || [],
            last_message: '',
            updated_at: '',
            created_at: '',
            document_context: context.document_context,
            bookmark_context: context.bookmark_context,
            workspace: context.workspace
          });
          
        }
      });
      
      // CRITICAL: Build a map of bookmark contexts by bookmark ID to help match chats
      const bookmarkContextMap = new Map<number, { chatId: string; context: any }>();
      persistedContexts.forEach((context: any, chatId: string) => {
        if (context.bookmark_context?.id) {
          bookmarkContextMap.set(context.bookmark_context.id, { chatId: String(chatId), context });
        }
      });
      chats.forEach(chat => {
        if (chat.bookmark_context?.id && !bookmarkContextMap.has(chat.bookmark_context.id)) {
          bookmarkContextMap.set(chat.bookmark_context.id, { chatId: getChatKey(chat), context: { bookmark_context: chat.bookmark_context } });
        }
      });
      
      // Remove duplicates based on composite key, preserving local document/bookmark context
      const uniqueChatsMap = new Map<string, Chat>();
      allChatsCombined.forEach(chat => {
        const key = getChatKey(chat);
        if (!uniqueChatsMap.has(key)) {
          // Check if we have local context for this chat
          const localChat = existingChatsMap.get(key);
          if (localChat && (localChat.type === 'document_focused' || 
                            localChat.type === 'bookmark_focused' || 
                            localChat.type === 'user_direct' || 
                            localChat.type === 'workspace')) {
            // Preserve type and context from local state
            // Backend might not return persistent_context consistently
            uniqueChatsMap.set(key, {
              ...chat,
              type: localChat.type,
              title: localChat.title || chat.title, // Prefer local title, fallback to backend
              document_context: localChat.document_context || chat.document_context,
              bookmark_context: localChat.bookmark_context || chat.bookmark_context,
              participants: localChat.participants || chat.participants,
              workspace: localChat.workspace || chat.workspace,
              // User DMs/workspaces: API last_message_at is authoritative (never inflate from stubs).
              // AI context chats: keep fresher in-memory activity after a just-sent message.
              ...((localChat.type !== 'user_direct' && localChat.type !== 'workspace') &&
                chatHasLocalActivity(localChat) &&
                getLastMessageTimestamp(localChat) > getLastMessageTimestamp(chat)
                ? {
                    updated_at: localChat.updated_at,
                    last_message: localChat.last_message || chat.last_message,
                    last_message_sender_id:
                      localChat.last_message_sender_id ?? chat.last_message_sender_id,
                  }
                : {}),
            });
            if (
              localChat.type !== 'user_direct' &&
              localChat.type !== 'workspace' &&
              chatHasLocalActivity(localChat) &&
              getLastMessageTimestamp(localChat) > getLastMessageTimestamp(chat)
            ) {
              delete (uniqueChatsMap.get(key) as any).last_message_at;
            }
          } else {
            // CRITICAL: Always check persisted contexts and current state for EVERY chat
            // This ensures we don't lose context even if it's not in existingChatsMap yet
            let persistedContext = persistedContexts.get(getChatKey(chat)) ?? persistedContexts.get(String(chat.id));
            let currentStateChat = chats.find(c => c.id === chat.id);
            
            // CRITICAL: If we didn't find context for this chat ID, try multiple strategies:
            // 1. Check if there's a context saved for ID -2 (temporary ID)
            // 2. Check if backend has bookmark context in persistent_context that we can match
            // IMPORTANT: Exclude Chat Assistant (ID -1) from context matching
            if (!persistedContext && !currentStateChat && chat.id > 0 && chat.id !== -1 && !chat.bookmark_context && !chat.document_context) {
              // Strategy 1: Check for temporary ID -2
              const tempContext = persistedContexts.get('ai_-2') ?? persistedContexts.get('-2');
              if (tempContext && (tempContext.bookmark_context || tempContext.document_context)) {
                persistedContext = tempContext;
              } else {
                // Strategy 2: Check if backend has bookmark context in persistent_context
                const historyData = chat as any;
                const backendPersistentContext = historyData.persistent_context || historyData.persistentContext;
                if (backendPersistentContext?.context_bookmark_ids?.length > 0) {
                  const bookmarkId = backendPersistentContext.context_bookmark_ids[0];
                  const matchedContext = bookmarkContextMap.get(bookmarkId);
                  if (matchedContext) {
                    persistedContext = matchedContext.context;
                  }
                }
              }
            }
            
            // CRITICAL: Check persisted storage FIRST, then current state, then backend
            // Backend chat might not have context yet, but we saved it locally
            // IMPORTANT: Use || operator so we get the FIRST non-null value (persisted > state > backend)
            // CRITICAL: For Chat Assistant (ID -1), never use context - always clear it
            const bookmarkContext = chat.id === -1 ? undefined : (persistedContext?.bookmark_context || currentStateChat?.bookmark_context || chat.bookmark_context);
            const documentContext = chat.id === -1 ? undefined : (persistedContext?.document_context || currentStateChat?.document_context || chat.document_context);
            const workspaceContext = chat.id === -1 ? undefined : (persistedContext?.workspace || currentStateChat?.workspace || chat.workspace);
            
            const hasBookmarkContext = !!bookmarkContext;
            const hasDocumentContext = !!documentContext;
            const hasWorkspace = !!workspaceContext;
            
            // CRITICAL: Exclude Chat Assistant (ID -1) from all context type fixing
            // Chat Assistant should always stay as 'ai_assistant' type
            if (chat.id > 0 && chat.id !== -1) { // Don't process default chat (-1)
              // CRITICAL: If we have bookmark/document context from ANY source, preserve it and fix the type
              // Priority: persistedContext > currentStateChat > backend chat
              if (hasBookmarkContext) {
                uniqueChatsMap.set(key, {
                  ...chat,
                  type: 'bookmark_focused',
                  bookmark_context: bookmarkContext,
                  title: persistedContext?.title || currentStateChat?.title || chat.title || (bookmarkContext?.name ? `Chat about ${bookmarkContext.name}` : `Bookmark: ${bookmarkContext?.name || 'Collection'}`)
                });
              } else if (hasDocumentContext) {
                uniqueChatsMap.set(key, {
                  ...chat,
                  type: 'document_focused',
                  document_context: documentContext,
                  title: persistedContext?.title || currentStateChat?.title || chat.title || (documentContext?.name ? `Document: ${truncateFilename(documentContext.name)}` : chat.title)
                });
              } else if (hasWorkspace) {
                uniqueChatsMap.set(key, {
                  ...chat,
                  type: 'workspace',
                  workspace: workspaceContext,
                  title: persistedContext?.title || currentStateChat?.title || chat.title || (workspaceContext?.name ? workspaceContext.name : chat.title)
                });
              } else if (chat.type === 'ai_assistant' && (chat.document_context || chat.bookmark_context)) {
                // Fallback: If backend says 'ai_assistant' but has context, fix it
                // IMPORTANT: Exclude Chat Assistant (ID -1) - it should always stay ai_assistant
                if (chat.id === -1) {
                  uniqueChatsMap.set(key, {
                    ...chat,
                    document_context: undefined,
                    bookmark_context: undefined,
                    workspace: undefined,
                    type: 'ai_assistant' as const
                  });
                } else if (chat.document_context) {
                  uniqueChatsMap.set(key, {
                    ...chat,
                    type: 'document_focused',
                    title: chat.title || `Document: ${truncateFilename(chat.document_context.name)}`
                  });
                } else if (chat.bookmark_context) {
                  uniqueChatsMap.set(key, {
                    ...chat,
                    type: 'bookmark_focused',
                    title: chat.title || `Bookmark: ${chat.bookmark_context.name}`
                  });
                } else {
                  uniqueChatsMap.set(key, chat);
                }
              } else {
                uniqueChatsMap.set(key, chat);
              }
            } else {
              // For Chat Assistant (ID -1) or other special IDs, preserve as-is
              // But ensure Chat Assistant never has context
              if (chat.id === -1 && (chat.bookmark_context || chat.document_context || chat.workspace)) {
                uniqueChatsMap.set(key, {
                  ...chat,
                  document_context: undefined,
                  bookmark_context: undefined,
                  workspace: undefined,
                  type: 'ai_assistant'
                });
              } else {
                uniqueChatsMap.set(key, chat);
              }
            }
          }
        } else {
          // If duplicate found (same type + id), keep the one with more recent last message timestamp
          const existing = uniqueChatsMap.get(key)!;
          const existingTimestamp = getLastMessageTimestamp(existing);
          const newTimestamp = getLastMessageTimestamp(chat);
          if (newTimestamp > existingTimestamp) {
            // Check if we should preserve local context
            const localChat = existingChatsMap.get(key);
            if (localChat && (localChat.type === 'document_focused' || 
                              localChat.type === 'bookmark_focused' || 
                              localChat.type === 'user_direct' || 
                              localChat.type === 'workspace')) {
              uniqueChatsMap.set(key, {
                ...chat,
                type: localChat.type,
                title: localChat.title || chat.title,
                document_context: localChat.document_context || chat.document_context,
                bookmark_context: localChat.bookmark_context || chat.bookmark_context,
                participants: localChat.participants || chat.participants,
                workspace: localChat.workspace || chat.workspace
              });
            } else {
              // Check if backend chat type needs fixing
              // IMPORTANT: Exclude Chat Assistant (ID -1) from type fixing
              if (chat.id === -1 && (chat.bookmark_context || chat.document_context || chat.workspace)) {
                // Chat Assistant should never have context - clear it
                uniqueChatsMap.set(key, {
                  ...chat,
                  document_context: undefined,
                  bookmark_context: undefined,
                  workspace: undefined,
                  type: 'ai_assistant'
                });
              } else if (chat.type === 'ai_assistant' && chat.document_context && chat.id !== -1) {
                uniqueChatsMap.set(key, {
                  ...chat,
                  type: 'document_focused',
                  title: chat.title || `Document: ${truncateFilename(chat.document_context.name)}`
                });
              } else if (chat.type === 'ai_assistant' && chat.bookmark_context && chat.id !== -1) {
                uniqueChatsMap.set(key, {
                  ...chat,
                  type: 'bookmark_focused',
                  title: chat.title || `Bookmark: ${chat.bookmark_context.name}`
                });
              } else {
                uniqueChatsMap.set(key, chat);
              }
            }
          }
        }
      });
      
      // Sort all chats by last message timestamp (most recent first), but keep ChatGD Assistant at top
      // Prefer fresher in-memory activity (e.g. just sent a message) over stale API/cache timestamps
      const localByKey = new Map<string, Chat>();
      chats.forEach((c) => localByKey.set(getChatKey(c), c));

      const allChatsArray = Array.from(uniqueChatsMap.values()).map((chat) => {
        const local = localByKey.get(getChatKey(chat));
        if (!local) return chat;
        // User chats: trust API timestamps on reload (in-memory may carry stale inflated times).
        if (chat.type === 'user_direct' || chat.type === 'workspace') return chat;
        if (
          chatHasLocalActivity(local) &&
          getLastMessageTimestamp(local) > getLastMessageTimestamp(chat)
        ) {
          const merged: Chat = {
            ...chat,
            updated_at: local.updated_at,
            last_message: local.last_message || chat.last_message,
            last_message_sender_id:
              local.last_message_sender_id ?? chat.last_message_sender_id,
          };
          delete (merged as any).last_message_at;
          return merged;
        }
        return chat;
      });
      
      // CRITICAL: Ensure temporary chats (id -2) with context are included in the list
      // These are newly created bookmark/document chats that should appear even before backend saves them
      const temporaryChatsWithContext = chats.filter(chat => 
        chat.id === -2 && (chat.bookmark_context || chat.document_context || chat.workspace) &&
        !allChatsArray.find(c => c.id === -2 && 
          ((c.bookmark_context?.id === chat.bookmark_context?.id) ||
           (c.document_context?.id === chat.document_context?.id))
        )
      );
      if (temporaryChatsWithContext.length > 0) {
        allChatsArray.push(...temporaryChatsWithContext);
      }
      
      const allChats = sortChatsByLastMessage(allChatsArray);
      
      // CRITICAL: Final verification - ensure all chats with context have correct type
      // IMPORTANT: Exclude Chat Assistant (ID -1) from type fixing - it should always be ai_assistant
      const finalChats = allChats.map(chat => {
        // Chat Assistant should never have context - if it does, clear it
        if (chat.id === -1) {
          if (chat.bookmark_context || chat.document_context || chat.workspace) {
            return {
              ...chat,
              document_context: undefined,
              bookmark_context: undefined,
              workspace: undefined,
              type: 'ai_assistant' as const
            };
          }
          return chat;
        }
        
        // If chat has bookmark_context but wrong type, fix it
        if (chat.bookmark_context && chat.type !== 'bookmark_focused') {
          return {
            ...chat,
            type: 'bookmark_focused' as const
          };
        }
        // If chat has document_context but wrong type, fix it
        if (chat.document_context && chat.type !== 'document_focused') {
          return {
            ...chat,
            type: 'document_focused' as const
          };
        }
        // If chat has workspace but wrong type, fix it
        if (chat.workspace && chat.type !== 'workspace') {
          return {
            ...chat,
            type: 'workspace' as const
          };
        }
        return chat;
      });
      
      // When opening from bookmark: prefer existing backend chat (so we can load its messages); remove duplicate -2
      let chatsToSet = finalChats;
      let bookmarkChatToSelect: Chat | null = injectedBookmarkChat;
      if (hadPendingBookmark && pendingBookmarkId != null) {
        const matching = finalChats.filter(c => c.bookmark_context?.id === pendingBookmarkId || (c as any).bookmark_context?.id === pendingBookmarkId);
        const existingBackend = matching.find(c => c.id > 0);
        if (existingBackend) {
          bookmarkChatToSelect = existingBackend;
          // Remove duplicate -2 for this bookmark so we don't show two entries
          chatsToSet = finalChats.filter(c => !(c.id === -2 && (c.bookmark_context?.id === pendingBookmarkId || (c as any).bookmark_context?.id === pendingBookmarkId)));
        } else if (injectedBookmarkChat) {
          bookmarkChatToSelect = injectedBookmarkChat;
        }
      }

      // CRITICAL: Log bookmark chats to verify they're being preserved
      const bookmarkChats = chatsToSet.filter(c => c.type === 'bookmark_focused' || c.bookmark_context);
      setChats(chatsToSet);

      // If we opened from bookmark (nav params): select the bookmark chat and load its messages when it's an existing backend chat
      if (bookmarkChatToSelect) {
        setSelectedChat(bookmarkChatToSelect);
        selectedChatRef.current = bookmarkChatToSelect;
        if (bookmarkChatToSelect.id > 0) {
          loadMessages(bookmarkChatToSelect.id, true);
        } else {
          setMessages([]);
          loadedChatIdRef.current = bookmarkChatToSelect.id;
        }
      } else {
        // When returning to ChatGD tab: restore selected chat from fresh list so bookmark/document chats stay open
        const currentSelected = selectedChatRef.current;
        if (currentSelected && currentSelected.id != null && currentSelected.id !== -1) {
          const chatInNewList = chatsToSet.find(c => c.id === currentSelected.id && c.type === currentSelected.type);
          if (chatInNewList) {
            setSelectedChat(chatInNewList);
            selectedChatRef.current = chatInNewList;
            if (chatInNewList.id > 0) {
              loadMessages(chatInNewList.id, true);
            }
          }
        }
      }

      // CRITICAL: Persist document/bookmark chat contexts to AsyncStorage
      // This ensures contexts survive app restarts and reloads
      savePersistedChatContexts(authUserId,finalChats).catch(error => {
        console.error('❌ Failed to persist chat contexts after loadChats:', error);
      });

      // Store pagination state so the "Load More" button knows whether more data is available
      setHasMoreAiChats(aiPagination?.has_more ?? false);
      setAiChatOffset(limit); // next offset is the number of items we just loaded
      setHasMoreUserChats(userChatHasMore);
      setUserChatOffset(limit);

    } catch (error) {
      console.error('Failed to load chats:', error);
      // Fallback: just show default ChatGD Assistant
      setChats([DEFAULT_CHAT_ASSISTANT]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  /**
   * Append the next page of AI and/or user chats to the current list.
   * Triggered by the "Load More" button in the chat list footer.
   */
  const loadMoreChats = async () => {
    if (isLoadingMoreChats || (!hasMoreAiChats && !hasMoreUserChats)) return;
    setIsLoadingMoreChats(true);
    try {
      const { fetchChatHistories } = useChatStore.getState();
      let newAiOffset = aiChatOffset;
      let newUserOffset = userChatOffset;

      await Promise.all([
        // Load next page of AI/LLM chats
        hasMoreAiChats
          ? (async () => {
              const pagination = await fetchChatHistories(CHATS_PAGE_SIZE, aiChatOffset);
              setHasMoreAiChats(pagination?.has_more ?? false);
              newAiOffset = aiChatOffset + CHATS_PAGE_SIZE;
              setAiChatOffset(newAiOffset);
            })()
          : Promise.resolve(),

        // Load next page of user/direct chats
        hasMoreUserChats
          ? (async () => {
              try {
                const res = await api.getChats(CHATS_PAGE_SIZE, userChatOffset);
                if (res.success && (res as any).chats) {
                  const moreUserChats: Chat[] = ((res as any).chats as any[]).map(mapUserChatListRow);
                  setChats(prev => {
                    const existing = new Set(prev.map(c => `${c.type}-${c.id}`));
                    const deduped = moreUserChats.filter(c => !existing.has(`${c.type}-${c.id}`));
                    return sortChatsByLastMessage([...prev, ...deduped]);
                  });
                  setHasMoreUserChats((res as any).pagination?.has_more ?? false);
                  newUserOffset = userChatOffset + CHATS_PAGE_SIZE;
                  setUserChatOffset(newUserOffset);
                }
              } catch (err) {
                if (__DEV__) console.warn('loadMoreChats: user chats failed', err);
              }
            })()
          : Promise.resolve(),
      ]);

      // After fetchChatHistories appended new histories into the store, convert and append to UI
      if (hasMoreAiChats) {
        const { histories } = useChatStore.getState();
        // The store appended new rows; take the slice we just fetched
        const newHistories = histories.slice(aiChatOffset);
        try {
          const newAiChats: Chat[] = newHistories
            .filter(h => h && h.id !== -1)
            .map((history: any) => {
              const lastMessage = getAiHistoryListPreview(history);
              return {
                id: Number(history.id),
                title: String(history.title || 'Untitled Chat'),
                type: 'ai_assistant' as const,
                source: 'llm' as const,
                participants: [{ id: 1, username: 'ChatGD Assistant', email: 'ai@grabdocs.com' }],
                last_message: lastMessage,
                updated_at: String(history.last_message_at || history.updated_at || history.created_at || ''),
                created_at: String(history.created_at || history.updated_at || ''),
                unread_count: 0,
                ...(history.last_message_at ? { last_message_at: String(history.last_message_at) } : {}),
              } as Chat;
            });
          setChats(prev => {
            const getChatKey = (c: Chat) => (c.type === 'user_direct' || c.type === 'workspace' ? 'user_' : 'ai_') + c.id;
            const existing = new Set(prev.map(getChatKey));
            const deduped = newAiChats.filter(c => !existing.has(getChatKey(c)));
            return sortChatsByLastMessage([...prev, ...deduped]);
          });
        } catch (err) {
          if (__DEV__) console.warn('loadMoreChats: AI chat conversion failed', err);
        }
      }
    } catch (error) {
      console.error('loadMoreChats failed:', error);
    } finally {
      setIsLoadingMoreChats(false);
    }
  };

  const loadWorkspaces = async () => {
    // Request deduplication: reuse in-flight request if one exists
    if (workspaceRequestRef.current) {
      try {
        const response = await workspaceRequestRef.current;
        if (response && (response as any).success && (response as any).data) {
          const workspacesData = Array.isArray((response as any).data) 
            ? (response as any).data 
            : ((response as any).data.workspaces || []);
          setWorkspaces(workspacesData);
        }
      } catch (error) {
        // Error already handled by original request
      }
      return;
    }

    try {
      // Create request and store in ref for deduplication
      workspaceRequestRef.current = (api as any).getMobileWorkspaces();
      
      const response = await workspaceRequestRef.current;
      
      // Clear ref after request completes
      workspaceRequestRef.current = null;
      
      if (response && (response as any).success && (response as any).data) {
        // Handle both response structures: data.workspaces or data as array
        const workspacesData = Array.isArray((response as any).data) 
          ? (response as any).data 
          : ((response as any).data.workspaces || []);
        
        setWorkspaces(workspacesData);
      } else {
        console.warn('⚠️ Workspaces API unavailable');
        setWorkspaces([]);
      }
    } catch (error: any) {
      // Clear ref on error
      workspaceRequestRef.current = null;
      
      // Silently handle timeout - this is expected if backend is slow/unavailable
      // Timeout errors are already logged at API level, no need to log again here
      if (error?.message?.includes('timeout') || error?.message?.includes('exceeded')) {
        // Don't log timeout errors - they're handled gracefully
        setWorkspaces([]);
      } else {
        // Only log unexpected errors
        console.warn('⚠️ Failed to load workspaces:', error?.message);
        setWorkspaces([]);
      }
    }
  };

  const loadDocuments = async () => {
    // Reuse in-flight request to prevent duplicate parallel calls (e.g. mount + useFocusEffect)
    if (documentRequestRef.current) {
      try { await documentRequestRef.current; } catch { /* handled by original call */ }
      return;
    }
    try {
      // metadata_only=true tells the backend to skip file content/preview data.
      // perPage=200 ensures we cover the vast majority of user libraries without multiple round-trips.
      documentRequestRef.current = api.getDocuments(
        1,
        200,
        undefined,
        undefined,
        undefined,
        false,
        true,
        undefined,
        undefined,
        { folderId: null, folderAware: true, scope: 'global' }
      );
      const response = await documentRequestRef.current;
      // A timed-out response has success:true but timedOut:true — keep existing cache
      if ((response as any)?.timedOut) return;
      if (response && (response.success !== false)) {
        const files = response.files || response.data || [];
        const docs = Array.isArray(files) ? files.map((file: any) => ({
          id: file.id,
          name: removeFileExtension(file.original_filename || file.filename || file.name),
          type: file.file_type || file.type,
          category: file.file_kind || file.category,
          size: file.file_size || file.size
        })) : [];
        setDocuments(docs);
        // Track total so we know whether a server-side search is needed for larger libraries
        const total = response.pagination?.total ?? docs.length;
        setDocumentsTotal(total);
      } else {
        console.warn('⚠️ Documents API returned unsuccessful response');
        setDocuments([]);
        setDocumentsTotal(0);
      }
    } catch (error: any) {
      console.error('❌ Failed to load documents for @ mentions:', error?.message || error);
      setDocuments([]);
      setDocumentsTotal(0);
    } finally {
      documentRequestRef.current = null;
    }
  };

  // Tier 3 server-side file search for @ mentions.
  // Called (debounced 200ms) when query length >= 3.
  // Local results are already visible; this augments with files outside the 100-doc cache.
  // Uses AbortController so typing quickly cancels the previous request immediately.
  const searchDocumentsForMention = async (query: string) => {
    const mySeq = mentionSearchSeqRef.current;
    const controller = new AbortController();
    mentionAbortControllerRef.current = controller;
    try {
      // 8s timeout — fast enough to not frustrate but won't hang forever.
      // Local results are already showing so there's no blank-screen penalty on timeout.
      const response = await api.getDocuments(
        1,
        20,
        query,
        undefined,
        undefined,
        false,
        true,
        8000,
        controller.signal,
        { folderId: null, folderAware: true, scope: 'global' }
      );
      if (mentionSearchSeqRef.current !== mySeq || controller.signal.aborted) return;
      if ((response as any)?.timedOut) return;
      if (response && response.success !== false) {
        const files = response.files || response.data || [];
        const results: Document[] = Array.isArray(files) ? files.map((file: any) => ({
          id: file.id,
          name: removeFileExtension(file.original_filename || file.filename || file.name),
          type: file.file_type || file.type,
          category: file.file_kind || file.category,
          size: file.file_size || file.size
        })) : [];
        setMentionFileSearchResults(results);
      }
    } catch (err: any) {
      // Silently ignore aborts and timeouts — local results remain visible
    } finally {
      if (mentionSearchSeqRef.current === mySeq) setIsMentionSearching(false);
    }
  };

  const loadUsers = async () => {
    try {
      setUsersLoading(true);
      // Strategy 1: Try the workspace-users endpoint first (should get all users from all workspaces)
      let usersList: any[] = [];
      let usersLoaded = false;
      
      try {
        // Timeout handled in API (25s); on timeout returns empty list
        const response = await (api as any).getWorkspaceUsers();
        
        const r = response as any;
        if (response && r.success !== false) {
          // Backend returns { data: { users: [...] } } - handle that structure first
          if (r?.data?.users && Array.isArray(r.data.users)) {
            usersList = r.data.users;
          } else if (r?.users && Array.isArray(r.users)) {
            usersList = r.users;
          } else if (r?.data && Array.isArray(r.data)) {
            usersList = r.data;
          } else if (Array.isArray(response)) {
            usersList = response as any[];
          }
          
          if (usersList.length > 0) usersLoaded = true;
        }
      } catch (error: any) {
        console.warn('⚠️ Workspace users endpoint failed:', error?.message);
      }
      
      // Strategy 2: If primary endpoint failed or returned empty, fetch from each workspace
      if (!usersLoaded || usersList.length === 0) {
        try {
          // REUSE existing workspaces state instead of calling API again
          // This prevents duplicate API calls and timeouts
          let workspacesData: any[] = [];
          
          if (workspaces.length > 0) {
            workspacesData = workspaces;
          } else {
            const workspacePromise = workspaceRequestRef.current ?? (api as any).getMobileWorkspaces();
            const workspacesResponse = await workspacePromise;
            if (workspacesResponse && (workspacesResponse as any).success && (workspacesResponse as any).data) {
              workspacesData = Array.isArray((workspacesResponse as any).data)
                ? (workspacesResponse as any).data
                : ((workspacesResponse as any).data.workspaces || []);
            }
          }
          
          if (workspacesData.length > 0) {
            
            // Fetch members from each workspace in parallel
            const memberPromises = workspacesData.map(async (workspace: any) => {
              try {
                const ck = workspaceMembersCacheKey(authUserId, workspace.id);
                if (!ck) return [];
                const cached = screenCache.get<WorkspaceMembersCachePayload>(
                  ck,
                  WORKSPACE_MEMBERS_CACHE_MS
                );
                if (cached) {
                  return cached.members;
                }
                const membersResponse = await Promise.race([
                  (api as any).getWorkspaceMembers(workspace.id),
                  new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
                ]);
                
                if (membersResponse && (membersResponse as any).success && (membersResponse as any).data) {
                  const payload = (membersResponse as any).data;
                  const membersData = payload.members || (membersResponse as any).data || [];
                  const arr = Array.isArray(membersData) ? membersData : [];
                  const invitations = Array.isArray(payload.invitations) ? payload.invitations : [];
                  screenCache.set<WorkspaceMembersCachePayload>(ck, {
                    members: arr,
                    invitations,
                  });
                  return arr;
                }
                return [];
              } catch (error: any) {
                console.warn(`⚠️ Failed to load members from workspace ${workspace.id}:`, error?.message);
                return [];
              }
            });
            
            const allMembersArrays = await Promise.all(memberPromises);
            
            // Flatten and deduplicate users by ID
            const allMembers = allMembersArrays.flat();
            const uniqueUsersMap = new Map<number, any>();
            
            allMembers.forEach((member: any) => {
              // Handle different member formats (user object or direct user data)
              const user = member.user || member;
              if (user && user.id) {
                if (!uniqueUsersMap.has(user.id)) {
                  uniqueUsersMap.set(user.id, {
                    id: user.id,
                    username: user.username || user.name || user.email?.split('@')[0] || 'Unknown',
                    email: user.email || '',
                    ...user
                  });
                }
              }
            });
            
            usersList = Array.from(uniqueUsersMap.values());
            usersLoaded = true;
          }
        } catch (error: any) {
          console.warn('⚠️ Failed to load users from workspaces:', error?.message);
        }
      }
      
      // Strategy 3: Final fallback - try searchUsersForChat with empty query
      if (!usersLoaded || usersList.length === 0) {
        try {
          const fallbackResponse = await Promise.race([
            api.searchUsersForChat(''),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
          ]);
          const fr = fallbackResponse as any;
          // Handle different response formats from searchUsersForChat
          // Backend returns { success, users, workspaces } or possibly { success, data: { users } }
          let fallbackUsers: any[] = [];
          if (fr?.users && Array.isArray(fr.users)) {
            fallbackUsers = fr.users;
          } else if (fr?.data?.users && Array.isArray(fr.data.users)) {
            fallbackUsers = fr.data.users;
          } else if (fr?.data && Array.isArray(fr.data)) {
            fallbackUsers = fr.data;
          } else if (Array.isArray(fallbackResponse)) {
            fallbackUsers = fallbackResponse as any[];
          }
          
          if (fallbackUsers.length > 0) {
            usersList = fallbackUsers;
            usersLoaded = true;
          }
        } catch (fallbackError: any) {
          console.warn('⚠️ Final fallback also failed:', fallbackError?.message);
        }
      }
      
      // Set the final users list (never include the current user — cannot DM yourself)
      if (usersList.length > 0) {
        const myId = currentUserIdRef.current;
        const withoutSelf =
          myId != null
            ? usersList.filter((u: any) => u?.id != null && String(u.id) !== String(myId))
            : usersList;
        setUsers(withoutSelf);
      } else {
        console.warn('⚠️ No users found - you may not be part of any workspaces yet');
        setUsers([]);
      }
    } catch (error: any) {
      // Don't log full error stack for timeouts - just warn
      if (error?.message === 'timeout' || error?.message?.includes('timeout')) {
        console.warn('⚠️ Workspace users loading timed out - direct messaging unavailable');
      } else {
        console.warn('⚠️ Failed to load workspace users:', error?.message);
      }
      setUsers([]);
    } finally {
      setUsersLoading(false);
    }
  };

  const loadBookmarks = async () => {
    // Reuse in-flight request to prevent duplicate parallel calls (e.g. mount + useFocusEffect)
    if (bookmarkRequestRef.current) {
      try { await bookmarkRequestRef.current; } catch { /* handled by original call */ }
      return;
    }
    try {
      bookmarkRequestRef.current = (api as any).getBookmarks();
      const response = await bookmarkRequestRef.current;
      if (response.success && response.data) {
        const bookmarksData = Array.isArray(response.data)
          ? response.data
          : (response.data.bookmarks || []);
        setBookmarks(bookmarksData);
      } else {
        setBookmarks([]);
      }
    } catch (error: any) {
      if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
        console.warn('⚠️ Bookmarks request timed out - this is non-critical, continuing without bookmarks');
      } else {
        if (__DEV__) console.warn('Failed to load bookmarks:', error);
      }
      setBookmarks([]);
    } finally {
      bookmarkRequestRef.current = null;
    }
  };

  const loadMessages = async (chatId: number, forceReload: boolean = false) => {
    // CRITICAL: Prevent unnecessary reloads - only load if switching to a different chat or force reload is requested
    // ALSO: Don't reload if we're currently streaming or just finished streaming (preserve streamed content)
    // IMPORTANT: Always reload if messages.length === 0 (user navigated back to conversation)
    // ALSO: Don't reload if a message was just sent (within last 3 seconds) to prevent duplicates
    const timeSinceLastMessage = Date.now() - lastMessageSentTimeRef.current;
    const shouldSkipReloadDueToRecentSend = timeSinceLastMessage < 3000;
    
    const isCurrentlyStreaming = isStreamingRef.current || isStreamCompleteRef.current;
    if (!forceReload && loadedChatIdRef.current === chatId && messages.length > 0) {
      if (isCurrentlyStreaming) {
        return;
      }
      if (shouldSkipReloadDueToRecentSend) {
        return;
      }
      return;
    }
    
    // CRITICAL: If messages are empty but we think this chat is loaded, force reload
    // This handles the case when user navigates away and back - messages were cleared but loadedChatIdRef might still match
    // BUT: Don't force reload if a message was just sent (to prevent duplicates)
    if (!forceReload && loadedChatIdRef.current === chatId && messages.length === 0) {
      if (shouldSkipReloadDueToRecentSend) {
        return;
      }
      forceReload = true;
    }
    
    // If we're streaming and force reload is requested, wait a bit for streaming to complete
    if (forceReload && isCurrentlyStreaming) {
      // Wait for streaming to complete (max 5 seconds)
      let waitCount = 0;
      while ((isStreamingRef.current || isStreamCompleteRef.current) && waitCount < 50) {
        await new Promise(resolve => setTimeout(resolve, 100));
        waitCount++;
      }
    }
    
    // Show cached messages immediately (if available and not streaming) so the UI
    // is responsive when switching between chats while the network fetch runs.
    if (chatId > 0 && !isStreamingRef.current) {
      const cachedEntry = messageCacheRef.current.get(chatId);
      if (cachedEntry && Date.now() - cachedEntry.timestamp < MESSAGE_CACHE_MS) {
        setMessages(cachedEntry.messages);
        setMessagesLoading(false);
        loadedChatIdRef.current = chatId;
        // Continue below to refresh in background (don't return)
      }
    }

    // Bare ChatGD assistant (-1): no network; never flip messagesLoading on — avoids empty↔loading UI flicker.
    if (chatId === -1) {
      setMessages([]);
      loadedChatIdRef.current = chatId;
      setMessagesLoading(false);
      return;
    }

    setMessagesLoading(true);
    // Declared outside try — `catch` is a sibling block and cannot see bindings from inside `try`.
    let chatIdForApi = chatId;

    try {
      // Start New (-1 handled above — no duplicate branch)
      // FIRST: Check the chat type from the local chats array (or selectedChatRef when loaded via context)
      // When opening user/workspace chat via context, the chat may not be in chats yet - use selectedChatRef
      let resolvedChatId = chatId;
      const chat = chats.find(c => c.id === chatId);
      const selectedForId = selectedChatRef.current && Number(selectedChatRef.current.id) === Number(chatId)
        ? selectedChatRef.current
        : null;
      let effectiveChat = chat || selectedForId;

      // Plain ai_assistant placeholder (id=-2, no bookmark/document context): show empty chat immediately
      // Same treatment as id=-1; avoids a useless backend call that would briefly set messagesLoading=true
      if (chatId === -2 && !effectiveChat?.bookmark_context && !effectiveChat?.document_context) {
        setMessages([]);
        loadedChatIdRef.current = chatId;
        return;
      }
      
      // CRITICAL: Placeholder -2 never exists on backend; resolve to real chat from list (same bookmark/document)
      // After refresh we load messages for -2 → 404 and response clears. Resolve -2 to real id before calling API.
      if (chatId === -2 && (effectiveChat?.bookmark_context || effectiveChat?.document_context)) {
        const bookmarkId = effectiveChat.bookmark_context?.id;
        const documentId = effectiveChat.document_context?.id;
        let realChat = chats.find(c =>
          c.id > 0 && (
            (bookmarkId != null && c.bookmark_context?.id === bookmarkId) ||
            (documentId != null && c.document_context?.id === documentId)
          )
        );
        // If not in current list (e.g. user just sent message, list not refreshed yet), fetch histories and resolve
        if (!realChat) {
          const { fetchChatHistories } = useChatStore.getState();
          await fetchChatHistories(100, 0);
          const { histories } = useChatStore.getState();
          const rawHistory = histories?.find((h: any) => {
            const pc = h.persistent_context || h.persistentContext;
            const bookmarkIds = pc?.context_bookmark_ids || pc?.selected_bookmarks || h.selected_bookmarks;
            if (bookmarkId != null && Array.isArray(bookmarkIds) && bookmarkIds.includes(bookmarkId)) return true;
            // document: match by context_file_ids / selected_files
            const fileIds = pc?.context_file_ids || pc?.selected_files || h.selected_files;
            if (documentId != null && Array.isArray(fileIds) && fileIds.includes(documentId)) return true;
            return false;
          });
          if (rawHistory) {
            const realId = typeof rawHistory.id === 'string' ? parseInt(String(rawHistory.id), 10) : Number(rawHistory.id);
            if (!isNaN(realId) && realId > 0) {
              resolvedChatId = realId;
              const title = (rawHistory as any).title || effectiveChat?.title || 'Chat';
              const base = effectiveChat!;
              effectiveChat = {
                ...base,
                id: realId,
                title,
                participants: base.participants || [{ id: 1, username: 'ChatGD Assistant', email: 'ai@grabdocs.com' }],
                last_message: base.last_message || '',
                updated_at: base.updated_at || new Date().toISOString(),
                created_at: base.created_at || new Date().toISOString(),
              };
              setSelectedChat(prev => prev && prev.id === -2 ? { ...prev, id: realId, title } : prev);
              if (__DEV__) console.log('🔄 [loadMessages] Resolved placeholder -2 to real chat id from histories:', realId);
            }
          }
        } else {
          resolvedChatId = realChat.id;
          effectiveChat = realChat;
          setSelectedChat(prev => prev && prev.id === -2 ? { ...prev, ...realChat, id: realChat!.id } : prev);
          if (__DEV__) console.log('🔄 [loadMessages] Resolved placeholder -2 to real chat id:', realChat!.id);
        }
      }
      
      // Use resolved id for API calls (still use chatId for loadedChatIdRef when we started with -2)
      chatIdForApi = resolvedChatId;
      
      // Check if this chat exists in the chat store (AI assistant chats)
      // CRITICAL: All chats from /api/v1/mobile/chat/history are AI assistant chats
      // Compare IDs robustly to handle string/number mismatches; use resolved id (-2 → real id)
      const { histories, currentHistory } = useChatStore.getState();
      const chatExistsInStore = (histories && histories.length > 0 && histories.some(h => {
        const historyId = typeof h.id === 'string' ? parseInt(String(h.id), 10) : Number(h.id);
        const targetId = typeof chatIdForApi === 'string' ? parseInt(String(chatIdForApi), 10) : Number(chatIdForApi);
        return !isNaN(historyId) && !isNaN(targetId) && historyId === targetId;
      })) || 
      (currentHistory && (() => {
        const currentId = typeof currentHistory.id === 'string' ? parseInt(String(currentHistory.id), 10) : Number(currentHistory.id);
        const targetId = typeof chatIdForApi === 'string' ? parseInt(String(chatIdForApi), 10) : Number(chatIdForApi);
        return !isNaN(currentId) && !isNaN(targetId) && currentId === targetId;
      })());
      
      // Determine if this is an AI chat based on type or store presence
      // CRITICAL: Use effectiveChat (chat from list OR selectedChatRef) so user/workspace chats loaded via context still load messages
      const isAIChat = chatExistsInStore || 
                       (effectiveChat && (effectiveChat.type === 'ai_assistant' || effectiveChat.type === 'document_focused' || effectiveChat.type === 'bookmark_focused')) ||
                       (!effectiveChat); // If no chat found, assume AI chat (safer default)
      
      // Only use user-chat endpoint for actual user/workspace chats that are NOT AI chats
      // Use effectiveChat so when opening existing workspace/user chat (including via context), messages load
      if (!isAIChat && effectiveChat && (effectiveChat.type === 'user_direct' || effectiveChat.type === 'workspace')) {
          // Load user chat messages using web endpoint (same as web chat.tsx)
          try {
            const response = await api.getChatMessages(chatIdForApi);
            if (response.success && (response as any).messages) {
              // Web chat.tsx returns: { success: true, messages: ChatMessage[] }
              // Use auth user id first (available immediately); fallback to profile so sent messages are always on the right on first open
              const userId = currentUserIdRef.current ?? userProfileRef.current?.data?.id ?? userProfileRef.current?.id;
              const convertedMessages: ChatMessage[] = (response as any).messages.map((msg: any) => {
                const senderId = msg.sender_id != null ? msg.sender_id : null;
                const isOwn = !!(userId != null && senderId != null && (senderId === userId || String(senderId) === String(userId)));
                return {
                  id: msg.id,
                  content: msg.content || '',
                  sender: msg.sender || null,
                  is_own_message: isOwn,
                  sender_id: senderId,
                  created_at: msg.created_at || new Date().toISOString(),
                  document_context: msg.metadata?.attachments?.[0] ? {
                    id: msg.metadata.attachments[0].file_id,
                    name: msg.metadata.attachments[0].name,
                    type: msg.metadata.attachments[0].mimeType || 'other'
                  } : undefined
                };
              });
              
              // Deduplicate messages before setting to prevent duplicate key errors
              const deduplicatedMessages = deduplicateMessages(convertedMessages);
              
              // CRITICAL: If streaming is active or recently completed, DON'T merge - let streaming updates handle the UI
              // BUT: If messages are empty, we MUST load them (user navigated back to conversation)
              const isCurrentlyStreaming = isStreamingRef.current || isStreamCompleteRef.current;
              const recentlyCompleted = Date.now() - lastStreamCompleteTimeRef.current < 10000;
              const messagesAreEmpty = messages.length === 0;
              
              // CRITICAL: When switching chats or force reloading, REPLACE messages (don't merge)
              const isSwitchingChats = loadedChatIdRef.current !== null && loadedChatIdRef.current !== chatIdForApi;
              const shouldReplace = forceReload || isSwitchingChats || messagesAreEmpty;
              
              if ((isCurrentlyStreaming || recentlyCompleted) && !messagesAreEmpty && !shouldReplace) {
                loadedChatIdRef.current = chatIdForApi;
                return;
              }
              
              // If messages are empty, always load them (user navigated back)
              if (messagesAreEmpty) {
              }
              
              if (shouldReplace) {
                // Replace messages completely - this is a different chat or force reload
                // BUT: If messages were just sent, merge instead of replace to preserve optimistic updates
                const timeSinceLastMessage = Date.now() - lastMessageSentTimeRef.current;
                const shouldMergeInstead = timeSinceLastMessage < 3000 && messages.length > 0;
                
                if (shouldMergeInstead) {
                  setMessages(prev => {
                    const mergedMessages = [...prev];
                    const existingIds = new Set(prev.map(m => m.id));
                    deduplicatedMessages.forEach(backendMsg => {
                      if (!existingIds.has(backendMsg.id)) {
                        mergedMessages.push(backendMsg);
                      }
                    });
                    return deduplicatedMessages.length > mergedMessages.length ? deduplicatedMessages : mergedMessages;
                  });
                } else {
                  setMessages(deduplicatedMessages);
                }
              } else {
                // Same chat, merge messages (for updates while viewing the same chat)
                setMessages(prev => {
                  const mergedMessages = [...prev];
                  const existingIds = new Set(prev.map(m => m.id));
                  deduplicatedMessages.forEach(backendMsg => {
                    if (!existingIds.has(backendMsg.id)) {
                      mergedMessages.push(backendMsg);
                    } else {
                      const existingIndex = mergedMessages.findIndex(m => m.id === backendMsg.id);
                      if (existingIndex >= 0) {
                        const existingMsg = mergedMessages[existingIndex];
                        const isRecentlyStreamed = lastStreamedMessageIndexRef.current === existingIndex && 
                                                 Date.now() - lastStreamCompleteTimeRef.current < 10000;
                        const backendIsEmpty = !backendMsg.content || backendMsg.content.trim().length === 0;
                        const existingIsLonger = existingMsg.content.length > backendMsg.content.length;
                        
                        const contentToUse = (isRecentlyStreamed || backendIsEmpty || existingIsLonger)
                          ? existingMsg.content 
                          : backendMsg.content;
                        
                        mergedMessages[existingIndex] = { ...backendMsg, content: contentToUse };
                      }
                    }
                  });
                  mergedMessages.sort((a, b) => {
                    const timeA = new Date(a.created_at).getTime();
                    const timeB = new Date(b.created_at).getTime();
                    return timeA - timeB;
                  });
                  return mergedMessages;
                });
              }
              loadedChatIdRef.current = chatIdForApi; // Track that we've loaded this chat
            } else {
              setMessages([]);
              loadedChatIdRef.current = chatIdForApi; // Track even empty chats to prevent reloads
            }
          } catch (error: any) {
            console.error(`❌ Failed to load messages for chat ${chatId}:`, error.message || error);
            // If chat doesn't exist, clear messages and refresh chat list
            if (error.message?.includes('Chat not found') || error.message?.includes('404') || error.response?.status === 404) {
              console.warn(`⚠️ Chat ${chatId} not found in user-chat endpoint, trying chat store instead`);
              // If it's a 404, it might be an AI assistant chat that was misclassified
              // Try loading from chat store instead (use resolved id)
              try {
                const { fetchChatConversation } = useChatStore.getState();
                await fetchChatConversation(chatIdForApi);
                const { currentHistory: fallbackHistory } = useChatStore.getState();
                
                // CRITICAL: Verify that fallbackHistory matches the chatId we're loading (use resolved id)
                const fallbackHistoryId = fallbackHistory ? (typeof fallbackHistory.id === 'string' ? parseInt(String(fallbackHistory.id), 10) : Number(fallbackHistory.id)) : null;
                const fallbackTargetId = typeof chatIdForApi === 'string' ? parseInt(String(chatIdForApi), 10) : Number(chatIdForApi);
                const fallbackHistoryMatches = fallbackHistoryId !== null && !isNaN(fallbackHistoryId) && !isNaN(fallbackTargetId) && fallbackHistoryId === fallbackTargetId;
                
                if (fallbackHistory && fallbackHistory.messages.length > 0 && fallbackHistoryMatches) {
                  const refs = (fallbackHistory as any).references;
                  const convertedMessages: ChatMessage[] = fallbackHistory.messages.map((msg, index) => {
                    const backendMsg = msg as any;
                    let timestamp = backendMsg.created_at || backendMsg.timestamp;
                    // Use backend message ID if available, otherwise generate unique ID
                    const backendMessageId = backendMsg.message_id || backendMsg.id;
                    const messageId = backendMessageId ? backendMessageId : generateUniqueMessageId();
                    const key = backendMessageId != null ? String(backendMessageId) : null;
                    const citations =
                      backendMsg.role === 'assistant' && key && refs && refs[key]
                        ? (refs[key].citations ?? null)
                        : undefined;
                    const chartFileIdFb =
                      backendMsg.role === 'assistant' && backendMsg.chart_file_id != null
                        ? Number(backendMsg.chart_file_id)
                        : backendMsg.role === 'assistant' && key && refs?.[key]?.chart_file_id != null
                          ? Number(refs[key].chart_file_id)
                          : undefined;
                    const chartTitleFb =
                      backendMsg.chart_title || (key && refs?.[key]?.chart_title) || undefined;
                    return {
                      id: typeof messageId === 'number' ? messageId : generateUniqueMessageId(),
                      content: msg.content || '',
                      sender: msg.role === 'user' ? null : { id: 1, username: 'ChatGD Assistant', email: 'ai@grabdocs.com' },
                      is_own_message: msg.role === 'user',
                      created_at: timestamp || new Date().toISOString(),
                      citations: citations ?? undefined,
                      ...(chartFileIdFb != null && !isNaN(chartFileIdFb)
                        ? { chartFileId: chartFileIdFb, chartTitle: chartTitleFb }
                        : {}),
                    };
                  });
                  // Deduplicate messages before setting to prevent duplicate key errors
                  const deduplicatedMessages = deduplicateMessages(convertedMessages);
                  
                  // CRITICAL: If streaming is active or recently completed, DON'T merge - let streaming updates handle the UI
                  // BUT: If messages are empty, we MUST load them (user navigated back to conversation)
                  const isCurrentlyStreaming = isStreamingRef.current || isStreamCompleteRef.current;
                  const recentlyCompleted = Date.now() - lastStreamCompleteTimeRef.current < 10000;
                  const messagesAreEmpty = messages.length === 0;
                  
                  // CRITICAL: When switching chats or force reloading, REPLACE messages (don't merge)
                  const isSwitchingChats = loadedChatIdRef.current !== null && loadedChatIdRef.current !== chatIdForApi;
                  const shouldReplace = forceReload || isSwitchingChats || messagesAreEmpty;
                  
                  if ((isCurrentlyStreaming || recentlyCompleted) && !messagesAreEmpty && !shouldReplace) {
                    loadedChatIdRef.current = chatIdForApi;
                    return;
                  }
                  
                  // If messages are empty, always load them (user navigated back)
                  if (messagesAreEmpty) {
                  }
                  
                  if (shouldReplace) {
                    // Replace messages completely - this is a different chat or force reload
                    setMessages(deduplicatedMessages);
                  } else {
                    // Same chat, merge messages (for updates while viewing the same chat)
                    setMessages(prev => {
                      const mergedMessages = [...prev];
                      const existingIds = new Set(prev.map(m => m.id));
                      deduplicatedMessages.forEach(backendMsg => {
                        if (!existingIds.has(backendMsg.id)) {
                          mergedMessages.push(backendMsg);
                        } else {
                          const existingIndex = mergedMessages.findIndex(m => m.id === backendMsg.id);
                          if (existingIndex >= 0) {
                            const existingMsg = mergedMessages[existingIndex];
                            const contentToUse = existingMsg.content.length > backendMsg.content.length 
                              ? existingMsg.content 
                              : backendMsg.content;
                            mergedMessages[existingIndex] = { ...backendMsg, content: contentToUse };
                          }
                        }
                      });
                      mergedMessages.sort((a, b) => {
                        const timeA = new Date(a.created_at).getTime();
                        const timeB = new Date(b.created_at).getTime();
                        return timeA - timeB;
                      });
                      return mergedMessages;
                    });
                  }
                  loadedChatIdRef.current = chatIdForApi; // Track that we've loaded this chat
                } else {
                  setMessages([]);
                  loadedChatIdRef.current = chatIdForApi; // Track even empty chats to prevent reloads
                }
              } catch (storeError) {
                console.error(`❌ Failed to load from chat store for chat ${chatId}:`, storeError);
                setMessages([]);
                loadedChatIdRef.current = chatIdForApi; // Track even on error to prevent infinite retries
                // Refresh the chat list to remove stale chat IDs
                loadChats();
              }
            } else {
              setMessages([]);
              loadedChatIdRef.current = chatIdForApi; // Track even empty chats to prevent reloads
            }
          }
          return;
      }
      
      // If chat is an AI chat, or not found in local list, or exists in chat store, use chat store
      // AI assistant chats (ai_assistant, document_focused, bookmark_focused) are document queries, NOT user chats
      if (isAIChat) {
      } else if (!chat) {
        // Chat not found in local array - if it's not explicitly a user chat, try chat store first
        // This handles the case where chat history is loaded but chat list hasn't been updated yet
      } else {
      }
      
      // Use the chat store to load the specific conversation (for AI chats/document queries)
      // Use resolved id so we never call API with placeholder -2 (404)
      const { fetchChatConversation } = useChatStore.getState();
      await fetchChatConversation(chatIdForApi);
      
      // Get the current history from the store
      const { currentHistory: storeHistory } = useChatStore.getState();
      
      // CRITICAL: Verify that currentHistory matches the chatId we're loading
      // This prevents showing messages from a different chat (use resolved id)
      const historyId = storeHistory ? (typeof storeHistory.id === 'string' ? parseInt(String(storeHistory.id), 10) : Number(storeHistory.id)) : null;
      const targetId = typeof chatIdForApi === 'string' ? parseInt(String(chatIdForApi), 10) : Number(chatIdForApi);
      const historyMatches = historyId !== null && !isNaN(historyId) && !isNaN(targetId) && historyId === targetId;
      
      if (storeHistory && storeHistory.messages.length > 0 && historyMatches) {
        // Convert chat store messages to the expected format; merge references into assistant messages
        const refs = storeHistory.references as ChatHistory['references'];
        const convertedMessages: ChatMessage[] = storeHistory.messages.map((msg, index) => {
          // Use actual message timestamp from backend - the backend provides 'created_at' field
          // Use type assertion to access backend response fields
          const backendMsg = msg as any;
          let timestamp = backendMsg.created_at || backendMsg.timestamp;
          
          // Debug: Log the message timestamp
          if (__DEV__ && index < 3) {
            // console.log('🕐 Message timestamp debug:', {
            //   index,
            //   created_at: backendMsg.created_at,
            //   timestamp: backendMsg.timestamp,
            //   finalTimestamp: timestamp
            // });
          }
          
          // Use backend message ID if available, otherwise generate unique ID
          // Backend messages may have message_id field
          const backendMessageId = backendMsg.message_id || backendMsg.id;
          const messageId = backendMessageId ? backendMessageId : generateUniqueMessageId();
          const key = backendMessageId != null ? String(backendMessageId) : null;
          const refEntry = key && refs ? refs[key] : undefined;
          const citations =
            backendMsg.role === 'assistant' && refEntry
              ? (refEntry.citations ?? undefined)
              : undefined;
          const chartFileId =
            backendMsg.role === 'assistant' && backendMsg.chart_file_id != null
              ? Number(backendMsg.chart_file_id)
              : backendMsg.role === 'assistant' && refEntry?.chart_file_id != null
                ? Number(refEntry.chart_file_id)
                : undefined;
          const chartTitle =
            backendMsg.chart_title || refEntry?.chart_title || undefined;

          return {
            id: typeof messageId === 'number' ? messageId : generateUniqueMessageId(),
            content: msg.content || '',
            sender: msg.role === 'user' ? null : { id: 1, username: 'ChatGD Assistant', email: 'ai@grabdocs.com' },
            is_own_message: msg.role === 'user',
            created_at: timestamp || new Date().toISOString(),
            citations,
            ...(chartFileId != null && !isNaN(chartFileId)
              ? { chartFileId, chartTitle }
              : {}),
          };
        });
        
        // Deduplicate messages before setting to prevent duplicate key errors
        const deduplicatedMessages = deduplicateMessages(convertedMessages);
        
        // CRITICAL: If streaming is active or recently completed, DON'T merge - let streaming updates handle the UI
        // Only merge if streaming is NOT active to avoid overwriting streamed content
        // BUT: If messages are empty, we MUST load them (user navigated back to conversation)
        const isCurrentlyStreaming = isStreamingRef.current || isStreamCompleteRef.current;
        const recentlyCompleted = Date.now() - lastStreamCompleteTimeRef.current < 10000; // Within 10 seconds of completion
        const messagesAreEmpty = messages.length === 0;
        
        if ((isCurrentlyStreaming || recentlyCompleted) && !messagesAreEmpty) {
          console.log(`⏸️ [loadMessages] Streaming active or recently completed - skipping message update to preserve streamed content`);
          // Don't update messages while streaming or right after - streaming interval will handle updates
          loadedChatIdRef.current = chatIdForApi; // Still track that we've loaded this chat
          return;
        }
        
        // If messages are empty, always load them (user navigated back)
        if (messagesAreEmpty) {
          console.log(`🔄 [loadMessages] Messages empty - loading messages for chat ${chatId} (streaming check bypassed)`);
        }
        
        // CRITICAL: When switching chats or force reloading, REPLACE messages (don't merge)
        // This prevents messages from one chat appearing in another
        const isSwitchingChats = loadedChatIdRef.current !== null && loadedChatIdRef.current !== chatIdForApi;
        const shouldReplace = forceReload || isSwitchingChats || messages.length === 0;
        
        if (shouldReplace) {
          // Replace messages completely - this is a different chat or force reload
          console.log(`🔄 [loadMessages] Replacing messages for chat ${chatIdForApi} (forceReload: ${forceReload}, switching: ${isSwitchingChats}, empty: ${messages.length === 0})`);
          setMessages(deduplicatedMessages);
          // Cache the freshly loaded messages for instant display next time this chat is opened
          if (chatIdForApi > 0) {
            messageCacheRef.current.set(chatIdForApi, { messages: deduplicatedMessages, timestamp: Date.now() });
          }
        } else {
          // Same chat, merge messages (for updates while viewing the same chat)
          console.log(`🔄 [loadMessages] Merging messages for chat ${chatId} (same chat, incremental update)`);
          setMessages(prev => {
            // Merge: keep existing messages, add backend messages that aren't already present
            const mergedMessages = [...prev];
            const existingIds = new Set(prev.map(m => m.id));
            
            // Add backend messages that aren't already in the list
            deduplicatedMessages.forEach(backendMsg => {
              if (!existingIds.has(backendMsg.id)) {
                mergedMessages.push(backendMsg);
              } else {
                // Update existing message with backend data (but preserve content if it's longer - might be streamed)
                const existingIndex = mergedMessages.findIndex(m => m.id === backendMsg.id);
                if (existingIndex >= 0) {
                  const existingMsg = mergedMessages[existingIndex];
                  // CRITICAL: Preserve existing content if:
                  // 1. It's longer than backend content (likely streamed)
                  // 2. Backend content is empty or very short (backend hasn't saved yet)
                  // 3. This is the recently streamed message
                  const isRecentlyStreamed = lastStreamedMessageIndexRef.current === existingIndex && 
                                           Date.now() - lastStreamCompleteTimeRef.current < 10000;
                  const backendIsEmpty = !backendMsg.content || backendMsg.content.trim().length === 0;
                  const existingIsLonger = existingMsg.content.length > backendMsg.content.length;
                  
                  const contentToUse = (isRecentlyStreamed || backendIsEmpty || existingIsLonger)
                    ? existingMsg.content 
                    : backendMsg.content;
                  
                  mergedMessages[existingIndex] = {
                    ...backendMsg,
                    content: contentToUse
                  };
                }
              }
            });
            
            // Sort by created_at to maintain order
            mergedMessages.sort((a, b) => {
              const timeA = new Date(a.created_at).getTime();
              const timeB = new Date(b.created_at).getTime();
              return timeA - timeB;
            });
            
            return mergedMessages;
          });
        }
        loadedChatIdRef.current = chatIdForApi; // Track that we've loaded this chat
        // Ensure retry/more-sources have a base chat_history_id even when no message has been sent.
        if (!lastStreamFiltersRef.current?.chat_history_id && chatIdForApi > 0) {
          lastStreamFiltersRef.current = { ...(lastStreamFiltersRef.current || {}), chat_history_id: chatIdForApi };
        }
      } else {
        // History doesn't match chatId or is empty - clear messages to prevent showing wrong chat's messages
        if (!historyMatches) {
          console.warn(`⚠️ [loadMessages] History ID (${historyId}) doesn't match chatId (${targetId}) - clearing messages to prevent cross-chat contamination`);
        }
        // For empty chats, don't show any welcome message - just show empty chat
        setMessages([]);
        loadedChatIdRef.current = chatIdForApi; // Track even empty chats to prevent reloads
      }
    } catch (error: any) {
      console.error('Failed to load messages:', error);
      
      // If it's a 404, the chat may no longer exist. But only navigate away if the user
      // has no messages yet — if they're already reading a conversation, keep them there
      // and just mark it loaded so we don't retry endlessly (ref guards infinite retries).
      if (error.message?.includes('Chat not found') || error.message?.includes('404') || error.response?.status === 404) {
        if (messages.length > 0) {
          // User has messages loaded — preserve the conversation and swallow the error silently
          console.warn(`⚠️ Chat ${chatId} 404 during background refresh — keeping existing messages`);
          loadedChatIdRef.current = chatIdForApi;
        } else {
          // No messages loaded yet — this chat truly doesn't exist; go back to the list
          console.warn(`⚠️ Chat ${chatId} not found — deselecting and refreshing list`);
          loadedChatIdRef.current = chatIdForApi;
          setSelectedChat(null);
          selectedChatRef.current = null;
          loadChats();
        }
      } else {
        // Show error message for other errors - but preserve existing messages if any
        // Only replace if we don't have messages for this chat
        if (loadedChatIdRef.current !== chatIdForApi || messages.length === 0) {
          const errorMessage: ChatMessage = {
            id: generateUniqueMessageId(),
            content: 'Failed to load messages. Please try again.',
            sender: null,
            is_own_message: false,
            created_at: new Date().toISOString(),
          };
          setMessages([errorMessage]);
          loadedChatIdRef.current = chatIdForApi; // Track even on error
        }
      }
    } finally {
      setMessagesLoading(false);
    }
  };

  // Helper function to start/continue character streaming
  const startOrContinueStreaming = (assistantMsgIndex: number, isTransition: boolean = false) => {
    console.log('🎬 startOrContinueStreaming called, isStreaming:', isStreamingRef.current, 'contentBuffer length:', contentBufferRef.current.length, 'displayedChars:', displayedCharsRef.current, 'isFakeStreaming:', isFakeStreamingRef.current, 'isTransition:', isTransition);
    
    // CRITICAL: During transitions (preview→refinement, fake→preview), don't clear interval
    // Just update the buffer and let the existing interval seamlessly continue
    // This prevents idle gaps on screen
    if (isTransition && streamingIntervalRef.current) {
      console.log('🔄 Transition detected - keeping existing interval running, just updating buffer');
      // Clamp cursor to buffer length if the buffer was replaced with a shorter body.
      // Never reset to 0 here — that would replay already-shown content.
      if (displayedCharsRef.current > contentBufferRef.current.length) {
        displayedCharsRef.current = contentBufferRef.current.length;
      }
      return; // Don't restart interval, let it continue
    }
    
    // If already streaming with an interval and NOT a transition, clear it first to restart
    if (streamingIntervalRef.current) {
      clearInterval(streamingIntervalRef.current);
      streamingIntervalRef.current = null;
      console.log('🔄 Cleared existing streaming interval');
    }
    
    // Don't start if buffer is empty
    if (!contentBufferRef.current || contentBufferRef.current.length === 0) {
      console.log('⏸️ Content buffer is empty, skipping');
      return;
    }
    
    // Ensure displayedChars doesn't exceed buffer length (safety check)
    if (displayedCharsRef.current > contentBufferRef.current.length) {
      console.warn('⚠️ displayedChars exceeds buffer length, resetting:', displayedCharsRef.current, '>', contentBufferRef.current.length);
      displayedCharsRef.current = Math.min(displayedCharsRef.current, contentBufferRef.current.length);
    }
    
    // CRITICAL: When refinement starts, displayedChars might be 0 while buffer has content
    // Always start streaming if buffer has content, even if displayedChars is 0
    // This ensures refinement content starts displaying immediately
    if (displayedCharsRef.current >= contentBufferRef.current.length && !isFakeStreamingRef.current) {
      // All current content is displayed, but if we're in refinement phase and buffer might grow, keep interval running
      if (!isPreviewPhaseRef.current && !isStreamCompleteRef.current) {
        // Refinement phase - keep interval running to wait for more chunks
        console.log('⏸️ All current refinement content displayed, waiting for more chunks...');
        return;
      }
      console.log('⏸️ All content already displayed, skipping');
      return;
    }
    
    console.log('🚀 Starting new streaming interval...');
    isStreamingRef.current = true;
    
    streamingIntervalRef.current = setInterval(() => {
      // Check if we have more content to display
      if (displayedCharsRef.current >= contentBufferRef.current.length) {
        // Caught up: fire any deferred "stop+dump" action (Option A) before
        // checking stream-complete, so refining dots / preview_complete flips
        // wait for the typewriter instead of yanking text mid-stream.
        if (pendingFinalActionRef.current) {
          const action = pendingFinalActionRef.current;
          pendingFinalActionRef.current = null;
          action();
          return;
        }
        // All current content is displayed
        if (isStreamCompleteRef.current) {
          console.log('✅ All content displayed and stream complete - stopping streaming interval');
          stopStreaming(assistantMsgIndex, true);
          return;
        }
        // Keep interval running to wait for more chunks (they might arrive)
        return;
      }
      
      // MATCH WEB: 2-3 chars/tick normally; speed up to ~7 when a final action is
      // pending so the user doesn't wait too long for the dots/cutover.
      const perTick = pendingFinalActionRef.current ? 7 : 3;
      const charsToAdd = Math.min(perTick, contentBufferRef.current.length - displayedCharsRef.current);
      displayedCharsRef.current = displayedCharsRef.current + charsToAdd;
      
      // CRITICAL: Stop fake streaming AFTER we've incremented displayedCharsRef and are about to update the message
      // This ensures we're actively displaying content before stopping fake streaming (no blank gap)
      if (isFakeStreamingRef.current && contentBufferRef.current.length > 0) {
        console.log('🔄 Disabling fake streaming - real content is now displaying (', displayedCharsRef.current, '/', contentBufferRef.current.length, 'chars visible)');
        isFakeStreamingRef.current = false;
      }
      
      // MATCH WEB: Extract display text using substring (upload.tsx line 4408)
      const displayText = contentBufferRef.current.substring(0, displayedCharsRef.current);
      
      // Update UI — always target assistant row by id so preview/refinement never overwrite the user bubble
      setMessages(prev => {
        const newMessages = [...prev];
        const rowId = streamingAssistantRowIdRef.current;
        let i =
          rowId != null ? newMessages.findIndex(m => m.id === rowId) : -1;
        if (i < 0) i = assistantMsgIndex;
        // CRITICAL: Never overwrite a user message with response content — only update assistant messages
        const targetMsg = i >= 0 && i < newMessages.length ? newMessages[i] : null;
        const isUserMessage = targetMsg?.is_own_message === true;
        if (i >= 0 && i < newMessages.length && !isUserMessage) {
          newMessages[i] = {
            ...newMessages[i],
            content: displayText,
            is_preview: isPreviewPhaseRef.current,
            is_own_message: false,
            sender: { id: 1, username: 'ChatGD Assistant', email: 'ai@grabdocs.com' },
            refining_answer_pending: newMessages[i].refining_answer_pending,
            main_search_pending: newMessages[i].main_search_pending,
          };
          streamingMessageIndexRef.current = i;
        } else {
          const assistantMessage: ChatMessage = {
            id: rowId ?? generateUniqueMessageId(),
            content: displayText,
            sender: { id: 1, username: 'ChatGD Assistant', email: 'ai@grabdocs.com' },
            is_own_message: false,
            created_at: new Date().toISOString(),
            is_preview: isPreviewPhaseRef.current,
          };
          if (streamingAssistantRowIdRef.current == null) {
            streamingAssistantRowIdRef.current = assistantMessage.id;
          }
          newMessages.push(assistantMessage);
          streamingMessageIndexRef.current = newMessages.length - 1;
        }
        return newMessages;
      });
    }, 20) as unknown as number; // MATCH WEB: 20ms interval = 50fps (upload.tsx line 4441)
  };
  
  // Helper function to stop streaming and finalize
  const stopStreaming = (assistantMsgIndex: number, isFinal: boolean) => {
    if (streamingIntervalRef.current) {
      clearInterval(streamingIntervalRef.current);
      streamingIntervalRef.current = null;
    }
    isStreamingRef.current = false;
    
    // Keep isStreamCompleteRef set for a bit longer to prevent loadMessages from overwriting streamed content
    // Reset after a delay to allow any pending loadMessages calls to detect it
    if (isFinal) {
      lastStreamCompleteTimeRef.current = Date.now();
      lastStreamedMessageIndexRef.current = assistantMsgIndex;
      setTimeout(() => {
        isStreamCompleteRef.current = false; // Reset for next stream after delay
      }, 10000); // 10 second delay to protect streamed content (backend needs time to save)
    } else {
      isStreamCompleteRef.current = false; // Reset immediately if not final
    }
    
    if (isFinal) {
      console.log(`✅ Streaming complete - displayed ${displayedCharsRef.current}/${contentBufferRef.current.length} characters`);
      // Final update: always use full content buffer, never clear already-shown content (fix mobile response clearing)
      const finalContent = (contentBufferRef.current && contentBufferRef.current.length > 0)
        ? contentBufferRef.current
        : '';
      
      // Ensure displayedChars matches buffer length for final update
      displayedCharsRef.current = finalContent.length;
      
      console.log(`✅ Finalizing message with content length: ${finalContent.length}`);
      setMessages(prev => {
        const newMessages = [...prev];
        const rowId = streamingAssistantRowIdRef.current;
        let idx =
          rowId != null ? newMessages.findIndex(m => m.id === rowId) : -1;
        if (idx < 0) idx = assistantMsgIndex;
        // CRITICAL: Never overwrite a user message with response content — only update assistant messages
        const targetMsg = idx >= 0 && newMessages[idx] ? newMessages[idx] : null;
        const isUserMessage = targetMsg?.is_own_message === true;
        // Always use the full content buffer, never clear it
        const keepContent = finalContent || newMessages[idx]?.content || '';
        if (idx >= 0 && newMessages[idx] && !isUserMessage) {
          const mid = assistantMessageIdFromStreamRef.current;
          assistantMessageIdFromStreamRef.current = null;
          newMessages[idx] = {
            ...newMessages[idx],
            ...(typeof mid === 'number' && mid > 0 ? { id: mid } : {}),
            content: keepContent,
            is_preview: false,
            refining_answer_pending: false,
            main_search_pending: false,
            is_own_message: false,
            sender: { id: 1, username: 'ChatGD Assistant', email: 'ai@grabdocs.com' },
            citations: citationsFromStreamRef.current ?? undefined,
            ...(chartFromStreamRef.current
              ? {
                  chartFileId: chartFromStreamRef.current.chartFileId,
                  chartTitle: chartFromStreamRef.current.chartTitle,
                }
              : {}),
          };
          citationsFromStreamRef.current = null;
          chartFromStreamRef.current = null;
          console.log(`✅ Finalized assistant row ${idx} final content length ${keepContent.length}`);
          AccessibilityInfo.announceForAccessibilityWithOptions('Assistant response complete', { queue: true });
        } else {
          const mid = assistantMessageIdFromStreamRef.current;
          assistantMessageIdFromStreamRef.current = null;
          const assistantMessage: ChatMessage = {
            id: typeof mid === 'number' && mid > 0 ? mid : generateUniqueMessageId(),
            content: keepContent,
            sender: { id: 1, username: 'ChatGD Assistant', email: 'ai@grabdocs.com' },
            is_own_message: false,
            created_at: new Date().toISOString(),
            is_preview: false,
            refining_answer_pending: false,
            main_search_pending: false,
            citations: citationsFromStreamRef.current ?? undefined,
            ...(chartFromStreamRef.current
              ? {
                  chartFileId: chartFromStreamRef.current.chartFileId,
                  chartTitle: chartFromStreamRef.current.chartTitle,
                }
              : {}),
          };
          citationsFromStreamRef.current = null;
          chartFromStreamRef.current = null;
          newMessages.push(assistantMessage);
          console.log(`✅ Created new assistant message with final content: "${keepContent.substring(0, 50)}${keepContent.length > 50 ? '...' : ''}"`);
          AccessibilityInfo.announceForAccessibilityWithOptions('Assistant response complete', { queue: true });
        }
        return newMessages;
      });
    }
  };

  /** Backend message_id threshold: IDs >= this are placeholders from generateUniqueMessageId, not backend IDs */
  const BACKEND_MESSAGE_ID_MAX = 1e9;

  /** Same backend as web: retry + retry_replace_message_id on /api/v1/mobile/chat/smart/start → smart_chat */
  const handleRetryAssistant = async (assistantIndex: number, replaceMessageId: number) => {
    if (sendingMessage || !selectedChat) return;
    const chatId = getPersistedChatHistoryId();
    if (!Number.isFinite(chatId) || chatId <= 0) {
      Toast.show({ type: 'error', text1: 'Open a saved chat to retry a reply.' });
      return;
    }
    const base = lastStreamFiltersRef.current;
    if (!base?.chat_history_id && chatId <= 0) {
      Toast.show({ type: 'error', text1: 'Send a message first, then retry.' });
      return;
    }
    const chunk = smartChatPollingChunkRef.current;
    const validMessageId = typeof replaceMessageId === 'number' && replaceMessageId > 0 && replaceMessageId < BACKEND_MESSAGE_ID_MAX;
    if (!validMessageId) {
      Toast.show({
        type: 'error',
        text1: 'Could not determine the message to retry. Try reloading the chat.',
      });
      return;
    }
    // Backend validates message length; empty body → 400 "Message too short". Send same query again.
    const priorUser =
      assistantIndex > 0 ? messages[assistantIndex - 1] : null;
    const retryMessage = (priorUser?.content || '').trim();
    if (!retryMessage) {
      Toast.show({
        type: 'error',
        text1: 'Could not find your question to retry. Send a new message.',
      });
      return;
    }
    try {
      setSendingMessage(true);
      startBounceAnimation();
      chatRequestCancelledRef.current = false;
      abortControllerRef.current = new AbortController();
      if (streamingIntervalRef.current) {
        clearInterval(streamingIntervalRef.current);
        streamingIntervalRef.current = null;
      }
      contentBufferRef.current = '';
      displayedCharsRef.current = 0;
      pendingFinalActionRef.current = null;
      isPreviewPhaseRef.current = true;
      isStreamingRef.current = false;
      isStreamCompleteRef.current = false;
      citationsFromStreamRef.current = null;
      chartFromStreamRef.current = null;
      assistantMessageIdFromStreamRef.current = null;
      isFakeStreamingRef.current = true;
      pollingAssistantIndexRef.current = assistantIndex;
      streamingMessageIndexRef.current = assistantIndex;
      setStreamingMessageIndex(assistantIndex);
      setMessages((prev) => {
        const next = [...prev];
        if (next[assistantIndex]) {
          streamingAssistantRowIdRef.current = next[assistantIndex].id;
          next[assistantIndex] = {
            ...next[assistantIndex],
            content: '',
            citations: undefined,
            chartFileId: undefined,
            chartTitle: undefined,
            is_preview: true,
          };
        }
        return next;
      });
      const streamFilters = {
        ...base,
        chat_history_id: chatId > 0 ? chatId : (base!.chat_history_id != null ? Number(base!.chat_history_id) : chatId),
        retry: true,
        retry_replace_message_id: replaceMessageId,
      };
      // sendChatMessagePolling resolves immediately (poll loop is not awaited) — do NOT clear
      // sendingMessage in finally or fake streaming dies before any chunks arrive (same as send path).
      await (api as any).sendChatMessagePolling(
        retryMessage,
        streamFilters,
        abortControllerRef.current?.signal,
        chunk
      );
    } catch (e: any) {
      const limitData = extractLimitErrorData(getErrorResponseData(e));
      if (limitData) {
        showLimitError(limitData);
        setSendingMessage(false);
        stopBounceAnimation();
        return;
      }
      const status = e?.response?.status;
      if (status === 409) {
        Toast.show({
          type: 'error',
          text1: e?.response?.data?.message || 'Retry limit reached. Send a new message or rephrase.',
        });
      } else {
        Toast.show({ type: 'error', text1: e?.message || 'Retry failed' });
      }
      setMessages((prev) => {
        const next = [...prev];
        if (next[assistantIndex]) {
          next[assistantIndex] = {
            ...next[assistantIndex],
            content: next[assistantIndex].content || 'Retry failed.',
            is_preview: false,
          };
        }
        return next;
      });
      setSendingMessage(false);
      stopBounceAnimation();
    }
  };

  const ADDITIONAL_SOURCES_STUB = 'Additional sources (same topic).';

  /**
   * More sources — same smart/start + polling as web: additional_response_for_message_id.
   * Appends user stub + new assistant row; does not replace the tapped assistant.
   */
  const handleMoreSourcesAssistant = async (assistantIndex: number, sourceAssistantMessageId: number) => {
    if (sendingMessage || !selectedChat) return;
    const chatId = getPersistedChatHistoryId();
    if (!Number.isFinite(chatId) || chatId <= 0) {
      Toast.show({ type: 'error', text1: 'Open a saved chat to get more sources.' });
      return;
    }
    const base = lastStreamFiltersRef.current;
    if (!base?.chat_history_id && chatId <= 0) {
      Toast.show({ type: 'error', text1: 'Send a message first.' });
      return;
    }
    const chunk = smartChatPollingChunkRef.current;
    const validMessageId = typeof sourceAssistantMessageId === 'number' && sourceAssistantMessageId > 0 && sourceAssistantMessageId < BACKEND_MESSAGE_ID_MAX;
    if (!validMessageId) {
      Toast.show({
        type: 'error',
        text1: 'Could not determine the message to add sources for. Try reloading the chat.',
      });
      return;
    }
    const userStubId = generateUniqueMessageId();
    const assistantPlaceholderId = generateUniqueMessageId();
    const newAssistantIndex = assistantIndex + 2;

    try {
      setSendingMessage(true);
      startBounceAnimation();
      chatRequestCancelledRef.current = false;
      abortControllerRef.current = new AbortController();
      if (streamingIntervalRef.current) {
        clearInterval(streamingIntervalRef.current);
        streamingIntervalRef.current = null;
      }
      contentBufferRef.current = '';
      displayedCharsRef.current = 0;
      pendingFinalActionRef.current = null;
      isPreviewPhaseRef.current = true;
      isStreamingRef.current = false;
      isStreamCompleteRef.current = false;
      citationsFromStreamRef.current = null;
      chartFromStreamRef.current = null;
      assistantMessageIdFromStreamRef.current = null;
      isFakeStreamingRef.current = true;
      pollingAssistantIndexRef.current = newAssistantIndex;
      streamingAssistantRowIdRef.current = assistantPlaceholderId;

      setMessages((prev) => {
        const next = [...prev];
        const u: ChatMessage = {
          id: userStubId,
          content: ADDITIONAL_SOURCES_STUB,
          sender: null,
          is_own_message: true,
          created_at: new Date().toISOString(),
        };
        const a: ChatMessage = {
          id: assistantPlaceholderId,
          content: '',
          sender: { id: 1, username: 'ChatGD Assistant', email: 'ai@grabdocs.com' },
          is_own_message: false,
          created_at: new Date().toISOString(),
          is_preview: true,
        };
        next.splice(assistantIndex + 1, 0, u, a);
        return next;
      });

      setStreamingMessageIndex(newAssistantIndex);
      streamingMessageIndexRef.current = newAssistantIndex;

      const streamFilters = {
        ...base,
        chat_history_id: chatId > 0 ? chatId : (base!.chat_history_id != null ? Number(base!.chat_history_id) : chatId),
        message: ADDITIONAL_SOURCES_STUB,
        additional_response_for_message_id: sourceAssistantMessageId,
      };
      delete (streamFilters as any).retry;
      delete (streamFilters as any).retry_replace_message_id;

      // Polling promise resolves immediately; sendingMessage cleared on complete/error in chunk handler.
      await (api as any).sendChatMessagePolling(
        ADDITIONAL_SOURCES_STUB,
        streamFilters,
        abortControllerRef.current?.signal,
        chunk
      );
    } catch (e: any) {
      const limitData = extractLimitErrorData(getErrorResponseData(e));
      if (limitData) {
        showLimitError(limitData);
        setSendingMessage(false);
        stopBounceAnimation();
        return;
      }
      const status = e?.response?.status;
      const msg =
        e?.response?.data?.message ||
        (e?.response?.data?.error === 'additional_limit' ? e?.response?.data?.message : null) ||
        e?.message ||
        'More sources failed';
      if (status === 409 || e?.response?.data?.error === 'additional_limit') {
        Toast.show({ type: 'error', text1: msg });
      } else {
        Toast.show({ type: 'error', text1: msg });
      }
      setMessages((prev) => {
        const next = [...prev];
        const i = next.findIndex((m) => m.id === userStubId);
        if (i >= 0 && next[i + 1]?.id === assistantPlaceholderId) {
          next.splice(i, 2);
        } else {
          const j = next.findIndex((m) => m.id === assistantPlaceholderId);
          if (j >= 0) next.splice(j, 1);
          const k = next.findIndex((m) => m.id === userStubId);
          if (k >= 0) next.splice(k, 1);
        }
        return next;
      });
      setSendingMessage(false);
      stopBounceAnimation();
    }
  };

  /**
   * Defer a "stop+dump" UI flip until the typewriter has caught up to the buffer
   * (Option A: prevents jumpy partial preview → full preview → dots transitions).
   * If no typewriter is running, or it's already at the end, fires immediately.
   * Latest pending action wins — earlier deferred actions are discarded.
   */
  const runWhenTyped = (action: () => void) => {
    if (
      !streamingIntervalRef.current ||
      displayedCharsRef.current >= contentBufferRef.current.length
    ) {
      action();
    } else {
      pendingFinalActionRef.current = action;
    }
  };

  // ---------------------------------------------------------------------------
  // Smart-chat chunk handler — defined at component scope so retry/more-sources
  // can use it even when the user hasn't sent a new message this session.
  // All values are read from refs at call-time; selectedChat is accessed via
  // selectedChatRef so it is always current without a stale closure.
  // ---------------------------------------------------------------------------
  const smartChatOnChunk = (type: string, data: any) => {
      // User hit stop — ignore late chunks so generation cannot resume after cancel
      if (chatRequestCancelledRef.current || abortControllerRef.current?.signal.aborted) {
        return;
      }
      const assistantMessageIndex = pollingAssistantIndexRef.current;
      switch (type) {
        case 'chat_history_id': {
          // Early binding: backend emits this before the complete event so a fast
          // follow-up message can include the correct chat_history_id right away.
          const earlyId = data.chat_history_id ? Number(data.chat_history_id) : null;
          if (earlyId && earlyId > 0 && earlyId !== currentChatIdRef.current) {
            currentChatIdRef.current = earlyId;
            console.log('🔗 [MOBILE] Early chat_history_id bound from stream:', earlyId);
            linkAskClientToHistoryRef.current(earlyId);
          }
          break;
        }

        case 'status':
        case 'started':
        case 'understanding':
        case 'understood':
        case 'searching':
        case 'search_results':
        case 'refining':
        case 'synthesizing':
          break;

        case 'instant_preview': {
          const instantContent = data.content || data.response || '';
          if (!instantContent || instantContent.length === 0) {
            console.warn('⚠️ instant_preview received but content is empty');
            break;
          }
          contentBufferRef.current = instantContent;
          displayedCharsRef.current = 0;
          isPreviewPhaseRef.current = true;
          startOrContinueStreaming(assistantMessageIndex);
          break;
        }

        case 'fallback_response':
          console.log('📝 Received fallback response:', data.content);
          contentBufferRef.current = data.content || '';
          displayedCharsRef.current = 0;
          startOrContinueStreaming(assistantMessageIndex);
          setTimeout(() => {
            stopStreaming(assistantMessageIndex, true);
          }, (data.content?.length || 0) * 50 + 1000);
          break;

        case 'error': {
          recordNetworkFailure();
          const errorText =
            getChatNetworkErrorMessage(
              { message: data.message || data.error || data.content },
              { inline: true }
            );
          console.error('❌ Streaming error:', errorText);
          setMessages(prev => {
            const newMessages = [...prev];
            if (newMessages[assistantMessageIndex]) {
              newMessages[assistantMessageIndex] = {
                ...newMessages[assistantMessageIndex],
                content: errorText,
                is_own_message: false,
                sender: { id: 1, username: 'ChatGD Assistant', email: 'ai@grabdocs.com' },
                refining_answer_pending: false,
                main_search_pending: false,
              };
            }
            return newMessages;
          });
          setSendingMessage(false);
          stopBounceAnimation();
          break;
        }

        case 'chunk':
        case 'preview_chunk': {
          const previewChunkContent = data.content || data.response || '';
          const previewStarted = data.preview_started || false;
          const isPreviewPhase = data.is_preview_phase !== undefined ? data.is_preview_phase : true;
          const phaseTransitionDetected = isPreviewPhaseRef.current === true && isPreviewPhase === false;
          if (phaseTransitionDetected) {
            console.log('🔄 [FRONTEND] Phase transition detected in preview_chunk handler: preview -> refinement');
            break;
          }
          console.log('📦 Template preview chunk received:', {
            chunk_index: data.chunk_index,
            contentLength: previewChunkContent.length,
            preview: previewChunkContent.substring(0, 50),
            preview_started: previewStarted,
            is_preview_phase: isPreviewPhase
          });
          if (!previewChunkContent || previewChunkContent.length === 0) {
            console.log('⏳ Preview chunk has no content - keeping fake streaming active');
            break;
          }
          console.log('📦 Processing preview chunk - content length:', previewChunkContent.length, 'buffer will be:', contentBufferRef.current.length + previewChunkContent.length);
          if (data.preview_cursor_reset) {
            console.log('📦 Preview cursor resync from server — replacing buffer with full preview slice');
            contentBufferRef.current = previewChunkContent;
            displayedCharsRef.current = 0;
            isPreviewPhaseRef.current = isPreviewPhase;
            lastStreamedMessageIndexRef.current = assistantMessageIndex;
            lastStreamCompleteTimeRef.current = Date.now();
            startOrContinueStreaming(assistantMessageIndex);
            break;
          }
          if (data.chunk_index === 0 || contentBufferRef.current.length === 0 || contentBufferRef.current.includes('Searching for')) {
            console.log('📦 First preview chunk - replacing instant preview');
            contentBufferRef.current = previewChunkContent;
            displayedCharsRef.current = 0;
            isPreviewPhaseRef.current = isPreviewPhase;
            lastStreamedMessageIndexRef.current = assistantMessageIndex;
            lastStreamCompleteTimeRef.current = Date.now();
            console.log('📦 Starting preview streaming - buffer length:', contentBufferRef.current.length);
            startOrContinueStreaming(assistantMessageIndex);
          } else {
            contentBufferRef.current += previewChunkContent;
            console.log('📦 Appended preview chunk', data.chunk_index, '- buffer now:', contentBufferRef.current.length);
            lastStreamedMessageIndexRef.current = assistantMessageIndex;
            lastStreamCompleteTimeRef.current = Date.now();
            console.log('📦 Starting preview streaming - buffer length:', contentBufferRef.current.length);
            startOrContinueStreaming(assistantMessageIndex);
          }
          break;
        }

        case 'result_superseded':
        case 'main_search_pending': {
          console.info(
            type === 'result_superseded'
              ? '[SSE] result_superseded — analytics won; replacing preview with main answer'
              : '[SSE] main_search_pending — showing refining dots until main search + refinement'
          );
          const idx = pollingAssistantIndexRef.current;
          // Defer the "snap+show dots" flip until the typewriter has displayed
          // the full preview buffer; otherwise mid-stream we'd jump from e.g.
          // 200/1000 chars straight to "full text + Searching dots".
          runWhenTyped(() => {
            const bufLen = contentBufferRef.current.length;
            if (bufLen > 0 && displayedCharsRef.current < bufLen) {
              displayedCharsRef.current = bufLen;
            }
            setMessages((prev) => {
              const newMessages = [...prev];
              const rowId = streamingAssistantRowIdRef.current;
              let i = rowId != null ? newMessages.findIndex((m) => m.id === rowId) : -1;
              if (i < 0) i = idx;
              if (i >= 0 && newMessages[i] && !newMessages[i].is_own_message) {
                newMessages[i] = {
                  ...newMessages[i],
                  content:
                    bufLen > 0 ? contentBufferRef.current : newMessages[i].content,
                  refining_answer_pending: true,
                  main_search_pending: true,
                  is_preview: isPreviewPhaseRef.current,
                };
              }
              return newMessages;
            });
          });
          break;
        }

        case 'preview_complete':
          console.log('✅ Preview complete - phase transition detected');
          console.log('📊 Preview content length:', data.preview_length || contentBufferRef.current.length);
          // Defer the refining-indicator flip until the typewriter finishes the
          // preview text, so the dots never appear over still-typing characters.
          runWhenTyped(() => {
            setMessages((prev) => {
              const newMessages = [...prev];
              const rowId = streamingAssistantRowIdRef.current;
              let i = rowId != null ? newMessages.findIndex((m) => m.id === rowId) : -1;
              if (i < 0) i = pollingAssistantIndexRef.current;
              if (i >= 0 && newMessages[i] && !newMessages[i].is_own_message) {
                newMessages[i] = {
                  ...newMessages[i],
                  refining_answer_pending: true,
                  main_search_pending: false,
                  is_preview: isPreviewPhaseRef.current,
                };
              }
              return newMessages;
            });
          });
          break;

        case 'refinement_chunk': {
          const refinementChunkContent = data.content || data.response || '';
          if (!refinementChunkContent || refinementChunkContent.length === 0) {
            console.log('⏳ Refinement chunk has no content - skipping');
            break;
          }
          const isPreviewPhaseFromData = data.is_preview_phase !== undefined ? data.is_preview_phase : false;
          const phaseTransitionDetected = isPreviewPhaseRef.current === true && isPreviewPhaseFromData === false;
          const previewWasSkipped = isFakeStreamingRef.current && (
            isPreviewPhaseFromData === false ||
            contentBufferRef.current.length === 0
          );
          const isFirstRefinement =
            data.is_first_refinement ||
            data.refinement_cursor_reset ||
            phaseTransitionDetected ||
            previewWasSkipped ||
            (data.chunk_index === 0 && (isPreviewPhaseRef.current || isFakeStreamingRef.current));
          console.log('🔄 Refinement chunk received', {
            chunk_index: data.chunk_index,
            contentLength: refinementChunkContent.length,
            isFirstRefinement,
            current_phase: isPreviewPhaseRef.current ? 'preview' : 'refinement',
          });
          // Hard cursor reset only when genuinely transitioning from preview/fake → refinement.
          // When already in refinement, a backend `refinement_cursor_reset` means the full
          // authoritative answer is replacing a preliminary chunk — keep the cursor as-is.
          const isTrueFirstRefinement = isFirstRefinement && isPreviewPhaseRef.current;
          const isRefinementReplacement  = isFirstRefinement && !isPreviewPhaseRef.current;

          if (isTrueFirstRefinement) {
            // Discard any deferred main_search_pending / preview_complete /
            // result_superseded action queued by runWhenTyped — once we cut
            // over, those would otherwise re-flip the row to a stale preview
            // state (showing "Preparing final response" + RefiningStatusDots over refinement text)
            // when the typewriter eventually catches up to the new buffer.
            pendingFinalActionRef.current = null;
            if (previewWasSkipped) {
              console.log('🔄 First refinement chunk - backend skipped preview, transitioning directly from fake streaming');
            } else {
              console.log('🔄 First refinement chunk - IMMEDIATE cutover from preview');
            }
            contentBufferRef.current = refinementChunkContent;
            displayedCharsRef.current = 0;
            isPreviewPhaseRef.current = false;
            const initialCharsToShow = Math.min(30, refinementChunkContent.length);
            displayedCharsRef.current = initialCharsToShow;
            const initialDisplayText = refinementChunkContent.substring(0, initialCharsToShow);
            console.log('🔄 Reset complete - refinement buffer:', refinementChunkContent.length, 'chars, showing', initialCharsToShow, 'immediately');
            setMessages(prev => {
              const newMessages = [...prev];
              if (!newMessages[assistantMessageIndex]) {
                const assistantMessage: ChatMessage = {
                  id: generateUniqueMessageId(),
                  content: initialDisplayText,
                  sender: { id: 1, username: 'ChatGD Assistant', email: 'ai@grabdocs.com' },
                  is_own_message: false,
                  created_at: new Date().toISOString(),
                  refining_answer_pending: false,
                  main_search_pending: false,
                };
                newMessages.push(assistantMessage);
                console.log(`🔄 Created message ${assistantMessageIndex} for refinement with initial content`);
              } else {
                newMessages[assistantMessageIndex] = {
                  ...newMessages[assistantMessageIndex],
                  content: initialDisplayText,
                  refining_answer_pending: false,
                  main_search_pending: false,
                };
                console.log(`🔄 Updated message ${assistantMessageIndex} with initial refinement content`);
              }
              return newMessages;
            });
            lastStreamedMessageIndexRef.current = assistantMessageIndex;
            lastStreamCompleteTimeRef.current = Date.now();
            console.log('🔄 Ensuring refinement streaming continues - smooth transition from', previewWasSkipped ? 'fake streaming' : 'preview');
            startOrContinueStreaming(assistantMessageIndex, true);
          } else if (isRefinementReplacement) {
            // Full authoritative answer replacing a preliminary refinement chunk.
            // Keep the cursor exactly where it is so already-shown chars are never replayed.
            console.log('🔄 [REFINEMENT-REPLACE] Replacing buffer without cursor rewind', {
              chunk_index: data.chunk_index,
              prevDisplayedChars: displayedCharsRef.current,
              prevBufLen: contentBufferRef.current.length,
              newChunkLen: refinementChunkContent.length,
            });
            contentBufferRef.current = refinementChunkContent;
            // Clamp cursor if the new content is somehow shorter (edge case).
            displayedCharsRef.current = Math.min(displayedCharsRef.current, refinementChunkContent.length);
            lastStreamedMessageIndexRef.current = assistantMessageIndex;
            lastStreamCompleteTimeRef.current = Date.now();
            startOrContinueStreaming(assistantMessageIndex, true);
          } else {
            contentBufferRef.current += refinementChunkContent;
            console.log('🔄 Appended refinement chunk', data.chunk_index, '- buffer now:', contentBufferRef.current.length);
            startOrContinueStreaming(assistantMessageIndex, true);
          }
          break;
        }

        case 'complete': {
          clearNetworkFailures();
          console.log('✅ Stream complete');
          console.log('✅ Final content buffer:', contentBufferRef.current);
          console.log('✅ Complete event data:', {
            hasResponse: !!data.response,
            chat_history_id: data.chat_history_id,
            currentSelectedChatId: selectedChatRef.current?.id,
            isPreviewPhase: isPreviewPhaseRef.current,
            displayedChars: displayedCharsRef.current,
            bufferLength: contentBufferRef.current.length
          });
          const returnedChatId = data.chat_history_id ? Number(data.chat_history_id) : null;
          const currentChatId = selectedChatRef.current ? Number(selectedChatRef.current.id) : null;
          if (askClientRef.current?.id && Array.isArray(data.suggestions)) {
            const recentUser = [lastAskUserMessageRef.current];
            const incoming = data.suggestions.filter(
              (s: unknown) => typeof s === 'string' && s.trim(),
            ) as string[];
            const next = filterAskSuggestionChips(
              incoming.length ? incoming : DEFAULT_ASK_CHIPS,
              recentUser,
            );
            setAskSuggestionChips(
              next.length ? next : filterAskSuggestionChips(DEFAULT_ASK_CHIPS, recentUser),
            );
          }
          if (returnedChatId && returnedChatId !== -1) {
            currentChatIdRef.current = returnedChatId;
            linkAskClientToHistoryRef.current(returnedChatId);
            if (returnedChatId !== currentChatId) {
              console.log('🔄 Backend returned new chat_history_id:', returnedChatId, 'updating selectedChat from', currentChatId);
              loadedChatIdRef.current = returnedChatId;
              console.log('✅ Updated loadedChatIdRef to prevent message reload:', returnedChatId);
              setSelectedChat(prev => {
                if (prev) {
                  const updatedChat = { ...prev, id: returnedChatId };
                  console.log('🔄 Preserving chat context during ID update:', {
                    oldId: currentChatId, newId: returnedChatId,
                    type: updatedChat.type, title: updatedChat.title,
                    hasDocContext: !!updatedChat.document_context,
                    hasBookmarkContext: !!updatedChat.bookmark_context,
                    hasWorkspace: !!updatedChat.workspace
                  });
                  setChats(prevChats => {
                    const chatsWithoutOld = prevChats.filter(chat => chat.id !== currentChatId);
                    const updatedWithActivity: Chat = {
                      ...updatedChat,
                      updated_at: new Date().toISOString(),
                      last_message:
                        updatedChat.last_message ||
                        (contentBufferRef.current || '').substring(0, 50) ||
                        prevChats.find((c) => c.id === currentChatId)?.last_message ||
                        '',
                    };
                    delete (updatedWithActivity as any).last_message_at;
                    const merged = [...chatsWithoutOld.filter((c) => c.id !== returnedChatId), updatedWithActivity];
                    const sorted = sortChatsByLastMessage(merged);
                    console.log('🔄 [ID UPDATE] Updated chats list with new ID:', {
                      removedId: currentChatId, addedId: returnedChatId,
                      totalChats: sorted.length,
                      hasBookmarkContext: !!updatedChat.bookmark_context,
                      bookmarkName: updatedChat.bookmark_context?.name,
                      hasDocumentContext: !!updatedChat.document_context,
                      type: updatedChat.type
                    });
                    savePersistedChatContexts(authUserId,sorted).then(async () => {
                      if (currentChatId === -2) {
                        try {
                          const ctxKey = authUserId ? chatContextsStorageKey(authUserId) : null;
                          if (!ctxKey) return;
                          const stored = await AsyncStorage.getItem(ctxKey);
                          if (stored) {
                            const parsed = JSON.parse(stored);
                            if (parsed['-2']) {
                              delete parsed['-2'];
                              await AsyncStorage.setItem(ctxKey, JSON.stringify(parsed));
                              console.log('🗑️ Removed old temporary chat ID -2 from AsyncStorage, context transferred to', returnedChatId);
                            }
                          }
                        } catch (error) {
                          console.error('❌ Failed to remove old chat ID from AsyncStorage:', error);
                        }
                      }
                    });
                    return sorted;
                  });
                  return updatedChat;
                }
                return prev;
              });
            } else {
              console.log('✅ Chat history ID matches current chat:', returnedChatId);
            }
          } else {
            console.log('⚠️ No chat_history_id in response or it is -1');
            if (currentChatId) {
              currentChatIdRef.current = currentChatId;
            }
          }
          isStreamCompleteRef.current = true;
          citationsFromStreamRef.current = (data.citations && data.citations.length > 0) ? data.citations : null;
          const midComplete = (data as any).message_id ?? (data as any).metadata?.message_id;
          if (midComplete != null && !isNaN(Number(midComplete))) {
            assistantMessageIdFromStreamRef.current = Number(midComplete);
          }
          const cf = (data as any).chart_file_id;
          if (cf != null && !isNaN(Number(cf))) {
            chartFromStreamRef.current = {
              chartFileId: Number(cf),
              chartTitle: (data as any).chart_title || undefined,
            };
          } else {
            chartFromStreamRef.current = null;
          }
          if (data.response != null && String(data.response).length > 0) {
            const resp = String(data.response);
            const buf = contentBufferRef.current;
            const dc = displayedCharsRef.current;
            const wasRefinement = !isPreviewPhaseRef.current;
            const strictlySame = resp === buf;
            console.log('✅ Complete with final response', { length: resp.length });

            // Always persist canonical server body; refinement often sends `complete.response` equal to chunked
            // streaming but `!==` due to benign differences — never rewind the typewriter in those cases.
            contentBufferRef.current = resp;
            isPreviewPhaseRef.current = false;

            if (!wasRefinement) {
              console.log('⚠️ Complete with body during preview-flag phase — syncing buffer');
              if (displayedCharsRef.current < contentBufferRef.current.length) {
                startOrContinueStreaming(assistantMessageIndex);
              }
            } else {
              // Once refinement content is already on screen, never rewind to 0.
              // Clamp the cursor to the authoritative response length (in case resp is shorter),
              // then let the already-running interval continue seamlessly without clearing it.
              if (!strictlySame) {
                console.log('🔄 Complete: refinement — merged authoritative body without replaying prefix');
              } else {
                console.log('✅ Complete: content matches buffer — finalizing without restart');
              }
              displayedCharsRef.current = Math.min(dc, resp.length);
              if (displayedCharsRef.current < contentBufferRef.current.length) {
                // Pass isTransition=true so the running interval is kept alive instead of
                // being cleared+restarted (which caused the visible pause then jump).
                startOrContinueStreaming(assistantMessageIndex, true);
              } else {
                stopStreaming(assistantMessageIndex, true);
              }
            }
          } else {
            console.log('✅ Complete without response - buffer has', contentBufferRef.current.length, 'chars');
            isPreviewPhaseRef.current = false;
            if (contentBufferRef.current.length === 0) {
              console.log('⏳ Complete with empty buffer - keeping fake streaming until chunks arrive');
            } else if (displayedCharsRef.current >= contentBufferRef.current.length) {
              console.log('✅ All content already displayed - stopping streaming immediately');
              stopStreaming(assistantMessageIndex, true);
            }
          }
          setSendingMessage(false);
          stopBounceAnimation();
          break;
        }

        default:
          console.log('⚠️ [CHATS] Unknown/unhandled SSE event type:', type, {
            dataKeys: Object.keys(data || {}),
            hasContent: !!(data?.content || data?.response),
            preview: (data?.content || data?.response || '').substring(0, 100)
          });
          if (data?.content || data?.response) {
            const unknownContent = data.content || data.response || '';
            if (unknownContent.length > 0 && !isFakeStreamingRef.current) {
              console.log('📝 [CHATS] Unknown event has content, treating as preview chunk');
              contentBufferRef.current = unknownContent;
              displayedCharsRef.current = 0;
              isPreviewPhaseRef.current = true;
              startOrContinueStreaming(assistantMessageIndex);
            }
          }
      }
    };

  // Initialize the chunk handler and mark it ready immediately (before any message is sent),
  // so Retry / More Sources work when the user opens a saved chat from history.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    smartChatPollingChunkRef.current = smartChatOnChunk;
    smartChatPollingChunkReadyRef.current = true;
  }, []); // empty deps: refs are always current; selectedChat uses selectedChatRef

  const sendMessage = async (overrideText?: string) => {
    
    const messageText = (overrideText ?? newMessage).trim();
    if (!selectedChat || !messageText) {
      if (__DEV__) console.log('⚠️ [CHATS-WEB] Cannot send - missing chat or empty message:', {
        hasSelectedChat: !!selectedChat,
        hasMessage: !!messageText,
        messageLength: messageText.length
      });
      return;
    }

    const canProceed = await confirmSend();
    if (!canProceed) return;
    
    // Update ref with current chat ID at the start of sending
    currentChatIdRef.current = selectedChat.id !== -1 ? Number(selectedChat.id) : null;
    // Bust message cache immediately so re-opening this chat shows the latest
    if (currentChatIdRef.current) messageCacheRef.current.delete(currentChatIdRef.current);

    // Declare assistantMessageIndex outside try-catch so it's accessible in both
    let assistantMessageIndex = 0;

    try {
      setSendingMessage(true);
      startBounceAnimation();
      
      // Create abort controller for this request
      chatRequestCancelledRef.current = false;
      abortControllerRef.current = new AbortController();
      
      // Add user message immediately for better UX
      const userMessage: ChatMessage = {
        id: generateUniqueMessageId(),
        content: messageText,
        sender: null,
        is_own_message: true,
        created_at: new Date().toISOString(),
      };
      
      setNewMessage('');
      if (askClient) {
        lastAskUserMessageRef.current = messageText;
        setAskSuggestionChips((prev) => filterAskSuggestionChips(prev, [messageText]));
      }

      // CRITICAL: Stop any existing streaming and clear state completely
      if (streamingIntervalRef.current) {
        clearInterval(streamingIntervalRef.current);
        streamingIntervalRef.current = null;
      }
      
      // Reset streaming state completely to prevent leftover content
      contentBufferRef.current = '';
      displayedCharsRef.current = 0;
      pendingFinalActionRef.current = null;
      isPreviewPhaseRef.current = true;
      isStreamingRef.current = false;
      isStreamCompleteRef.current = false;
      citationsFromStreamRef.current = null;
      isFakeStreamingRef.current = false;
      lastStreamedMessageIndexRef.current = null;
      lastStreamCompleteTimeRef.current = 0;

      // For AI assistant chats, use streaming
      if (selectedChat.type === 'ai_assistant' || selectedChat.type === 'document_focused' || selectedChat.type === 'bookmark_focused') {
        // Initialize state for fake streaming from ProcessingMessageDisplay component
        // The ProcessingMessageDisplay will show looping messages until real content arrives
        // Ensure buffer is completely empty (double-check)
        contentBufferRef.current = '';
        displayedCharsRef.current = 0;
        isPreviewPhaseRef.current = true;
        isFakeStreamingRef.current = true; // Enable fake streaming display (ProcessingMessageDisplay)
        isStreamingRef.current = false;
        isStreamCompleteRef.current = false;
        lastStreamedMessageIndexRef.current = null;
        lastStreamCompleteTimeRef.current = 0;
        
         // Create placeholder assistant message - fake streaming from file will populate it
          const placeholderId = generateUniqueMessageId();
          streamingAssistantRowIdRef.current = placeholderId;
          const placeholderMessage: ChatMessage = {
            id: placeholderId,
            content: '', // Fake streaming from file will populate this
            sender: { id: 1, username: 'ChatGD Assistant', email: 'ai@grabdocs.com' },
            is_own_message: false,
            created_at: new Date().toISOString(),
            is_preview: true,
          };
        // CRITICAL: Set assistant index SYNCHRONOUSLY. Previously assistantMessageIndex was set inside
        // setMessages — that callback runs async, so pollingAssistantIndexRef stayed at messages.length
        // (the USER row). Streaming then wrote the first chars of the reply into the user bubble (right).
        assistantMessageIndex = messages.length + 1; // user at messages.length, assistant right after
        pollingAssistantIndexRef.current = assistantMessageIndex;
        streamingMessageIndexRef.current = assistantMessageIndex;
        setStreamingMessageIndex(assistantMessageIndex);
        console.log('📝 Placeholder at sync index', assistantMessageIndex, 'id', placeholderId);
        setMessages(prev => [...prev, userMessage, placeholderMessage]);
        AccessibilityInfo.announceForAccessibility('Message sent');
        // Fake streaming is now active - ProcessingMessageDisplay will show until preview arrives
        // Send the raw query as-is, without adding Document:/Question:/Context: prefixes
        // The backend will handle context via document_ids in streamFilters
        const chatContext = userMessage.content;
        
        // Log mention context for debugging but don't modify the query
        if (selectedMention) {
          console.log('📎 Persistent mention active:', selectedMention);
        }
        
        // Check if context was explicitly removed for this chat
        const ctxRemoved = selectedChat.id != null && selectedChat.id !== -1 && contextRemovedChatIdsRef.current.has(Number(selectedChat.id));
        // Use ref as fallback so we have latest chat (avoids stale closure when navigating from bookmark)
        const effectiveChat = selectedChatRef.current || selectedChat;
        
        // Build search filters based on context
        let searchFilters = {};
        
        if (selectedMention) {
          if (selectedMention.type === 'bookmark') {
            // Filter to only search within this bookmark's documents
            const bookmarkDocumentIds = selectedMention.data.documents?.map((doc: any) => doc.id) || [];
            searchFilters = {
              bookmark_id: selectedMention.id,
              document_ids: bookmarkDocumentIds,
              context_type: 'bookmark'
            };
          } else if (selectedMention.type === 'workspace') {
            searchFilters = {
              workspace_id: selectedMention.id,
              context_type: 'workspace'
            };
          } else if (selectedMention.type === 'file') {
            const id = Number(selectedMention.id);
            searchFilters = {
              context_file_ids: Number.isNaN(id) ? [] : [id],
              document_ids: Number.isNaN(id) ? [] : [id],
              context_type: 'document'
            };
          } else if (selectedMention.type === 'user') {
            searchFilters = {
              user_id: selectedMention.id,
              context_type: 'user'
            };
          }
        } else if (!ctxRemoved && (effectiveChat.type === 'bookmark_focused' && effectiveChat.bookmark_context)) {
          searchFilters = { bookmark_id: effectiveChat.bookmark_context.id, context_type: 'bookmark' };
        } else if (!ctxRemoved && (effectiveChat.type === 'document_focused' && effectiveChat.document_context)) {
          const id = Number(effectiveChat.document_context.id);
          searchFilters = Number.isNaN(id) ? {} : { 
            context_file_ids: [id],
            document_ids: [id],
            context_type: 'document' 
          };
        }
        
        // Build search filters for streaming with full context support (matching web implementation)
        let streamFilters: any = {};
        if (selectedMention) {
          const documentIds = selectedMention.type === 'bookmark' 
            ? selectedMention.data.documents?.map((doc: any) => doc.id) || []
            : selectedMention.type === 'file' 
            ? [selectedMention.id]
            : undefined;
            
          const fileIds = selectedMention.type === 'file' ? [Number(selectedMention.id)] : undefined;
          const bookmarkIds = selectedMention.type === 'bookmark' ? [Number(selectedMention.id)] : undefined;
          const workspaceIds = selectedMention.type === 'workspace' ? [Number(selectedMention.id)] : undefined;
          const userIds = selectedMention.type === 'user' ? [Number(selectedMention.id)] : undefined;
          
          streamFilters = {
            context_type: selectedMention.type,
            context_id: selectedMention.id,
            context_file_ids: fileIds,
            selected_files: fileIds, // match web
            document_ids: documentIds,
            // Include all context types for full web parity
            selected_bookmarks: bookmarkIds,
            context_bookmark_ids: bookmarkIds,
            selected_workspaces: workspaceIds,
            selected_users: userIds,
          };
        } else {
          // Use general chat endpoint for AI assistant with context filters and search type
          streamFilters = {
            search_type: selectedSearchType, // Add selected search type
            ...searchFilters // Include any context filters (bookmark, document, etc.)
          };
          
          // Also include context from selected chat (use effectiveChat so bookmark-from-nav is not lost)
          if (!ctxRemoved && effectiveChat) {
            if (effectiveChat.workspace?.id) {
              streamFilters.selected_workspaces = [Number(effectiveChat.workspace.id)];
              streamFilters.active_workspace_id = Number(effectiveChat.workspace.id);
            }
            if (effectiveChat.bookmark_context?.id) {
              streamFilters.selected_bookmarks = [Number(effectiveChat.bookmark_context.id)];
              streamFilters.context_bookmark_ids = [Number(effectiveChat.bookmark_context.id)];
            }
          }
          // CRITICAL: Ensure bookmark ID is sent when we have bookmark_id in searchFilters (e.g. bookmark_focused)
          // Backend only reads context_bookmark_ids/selected_bookmarks, not bookmark_id
          if (!streamFilters.context_bookmark_ids?.length && streamFilters.bookmark_id != null) {
            const bid = Number(streamFilters.bookmark_id);
            if (!Number.isNaN(bid)) {
              streamFilters.context_bookmark_ids = [bid];
              streamFilters.selected_bookmarks = [bid];
            }
          }
        }
        
        // Ensure context_file_ids and selected_files (numbers) when there is a file context — match web
        if (!streamFilters.context_file_ids) {
          if (selectedMention?.type === 'file') {
            const id = Number(selectedMention.id);
            if (!Number.isNaN(id)) {
              streamFilters.context_file_ids = [id];
              streamFilters.selected_files = [id];
            }
          } else if (!ctxRemoved && selectedChat?.document_context) {
            const id = Number(selectedChat.document_context.id);
            if (!Number.isNaN(id)) {
              streamFilters.context_file_ids = [id];
              streamFilters.selected_files = [id];
            }
          }
        } else {
          const ids = Array.isArray(streamFilters.context_file_ids)
            ? streamFilters.context_file_ids.map((x: any) => Number(x)).filter((n: number) => !Number.isNaN(n))
            : [];
          streamFilters.selected_files = ids.length ? ids : streamFilters.selected_files;
          streamFilters.context_file_ids = ids.length ? ids : streamFilters.context_file_ids;
        }
        if (streamFilters.context_file_ids && !streamFilters.document_ids) {
          streamFilters.document_ids = streamFilters.context_file_ids;
        }
        
        // CRITICAL: Add chat_history_id if this is an existing chat from backend.
        // Fall back to currentChatIdRef so a fast second message gets the ID that was
        // returned by the first response's complete event, even when selectedChat still
        // holds the temp placeholder (-2).
        const _persistedChatId = (() => {
          const fromState = selectedChat?.id != null ? Number(selectedChat.id) : NaN;
          if (Number.isFinite(fromState) && fromState > 0) return fromState;
          const fromRef = currentChatIdRef.current != null ? Number(currentChatIdRef.current) : NaN;
          return Number.isFinite(fromRef) && fromRef > 0 ? fromRef : null;
        })();
        if (_persistedChatId) {
          streamFilters.chat_history_id = _persistedChatId;
          console.log('📋 [MOBILE] Adding chat_history_id to filters:', _persistedChatId);
        } else {
          // New chat (placeholder ID -2) or default assistant (-1) - let backend create history
          console.log('📋 [MOBILE] Not sending chat_history_id - backend will create new chat history');
        }

        const scopedClient = askClientRef.current;
        if (scopedClient?.id) {
          streamFilters.client_id = scopedClient.id;
        }

        // FINAL FALLBACK: Ensure bookmark ID is sent when chat is bookmark_focused (backend reads context_bookmark_ids only)
        if (!streamFilters.context_bookmark_ids?.length && selectedChat?.bookmark_context?.id != null) {
          const bid = Number(selectedChat.bookmark_context.id);
          if (!Number.isNaN(bid)) {
            streamFilters.context_bookmark_ids = [bid];
            streamFilters.selected_bookmarks = [bid];
            console.log('📋 [MOBILE] Final fallback: set context_bookmark_ids from selectedChat:', bid);
          }
        }

        // Log what we're sending to match web behavior
        console.log('📤 [MOBILE] Sending chat request:', {
          message: chatContext.substring(0, 100),
          context_file_ids: streamFilters.context_file_ids,
          context_bookmark_ids: streamFilters.context_bookmark_ids,
          document_ids: streamFilters.document_ids,
          chat_history_id: streamFilters.chat_history_id,
          hasSelectedMention: !!selectedMention,
          selectedMentionType: selectedMention?.type,
          selectedChatType: selectedChat?.type,
          documentContextId: selectedChat?.document_context?.id,
          bookmarkContextId: selectedChat?.bookmark_context?.id
        });

        // Build conversation_history from on-screen turns (last ~10, skip empty/system).
        // The backend merges this with the DB-canonical history, which fixes the save-race
        // and makes follow-ups work even when chat_history_id is momentarily null.
        const _convHistory = messages
          .filter(m => m.content && m.content.trim().length > 0)
          .slice(-10)
          .map(m => ({
            role: m.is_own_message ? 'user' : 'assistant',
            content: m.content.trim(),
          }));
        if (_convHistory.length > 0) {
          streamFilters.conversation_history = _convHistory;
        }

        pollingAssistantIndexRef.current = assistantMessageIndex;
        lastStreamFiltersRef.current = { ...streamFilters };
        assistantMessageIdFromStreamRef.current = null;

        // Use chunked polling for AI chat (resilient alternative to streaming)
        // Polling works better on mobile networks and survives app backgrounding
        // smartChatOnChunk is defined at component scope (above sendMessage) so retry/more-sources
        // can use it even when the user opens a saved chat without sending a new message.
        // Re-assign here to ensure pollingAssistantIndexRef is set before the handler runs.
        smartChatPollingChunkRef.current = smartChatOnChunk;
        smartChatPollingChunkReadyRef.current = true;
;
        smartChatPollingChunkRef.current = smartChatOnChunk;
        smartChatPollingChunkReadyRef.current = true;
        await (api as any).sendChatMessagePolling(
          chatContext,
          streamFilters,
          abortControllerRef.current?.signal,
          smartChatOnChunk
        );

        // After streaming completes, update chat list
        // Use ref to get the latest chat ID (which might have been updated by the complete event handler)
        setTimeout(() => {
          const chatIdToUpdate = currentChatIdRef.current || selectedChatRef.current?.id;
          if (!chatIdToUpdate || chatIdToUpdate === -1) return;
          
          setChats(prev => {
            // Check if chat exists in list
            const existingChat = prev.find(chat => chat.id === chatIdToUpdate);
            if (existingChat) {
              // Update existing chat - CRITICAL: Preserve bookmark_context, document_context, workspace, and type
              // This ensures bookmark chats stay purple and document chats stay green after sending messages
              return bumpChatActivity(prev, chatIdToUpdate, {
                last_message: (contentBufferRef.current || '').substring(0, 50) + '...',
                updated_at: new Date().toISOString(),
                bookmark_context: existingChat.bookmark_context,
                document_context: existingChat.document_context,
                workspace: existingChat.workspace,
                type: existingChat.type,
              });
            } else {
              // Chat doesn't exist in list yet (might be a new chat)
              // CRITICAL: Don't reload chat list - it clears messages!
              // Instead, just add the chat to the list with the current content
              console.log('⚠️ Chat not found in list, but NOT reloading to preserve messages. Chat ID:', chatIdToUpdate);
              // The chat was already added to the list when ID was updated, so this shouldn't happen
              // But if it does, preserve messages by not calling loadChats()
              return prev;
            }
          });
        }, 600); // Wait a bit longer than the complete handler to ensure selectedChat is updated
      } else if (selectedChat.type === 'user_direct') {
        console.log('📤 [CHATS-WEB] ===== SENDING USER DIRECT MESSAGE =====');
        console.log('📤 [CHATS-WEB] Chat ID:', selectedChat.id);
        console.log('📤 [CHATS-WEB] Message text:', messageText);
        // Get user ID from ref to ensure we have latest value
        const userId = userProfileRef.current?.data?.id || userProfileRef.current?.id;
        console.log('📤 [CHATS-WEB] User ID:', userId);
        
        // Emit typing stopped (validate all required fields)
        if (socketRef.current && 
            userId && 
            selectedChat.id != null) {
          socketRef.current.emit('user_typing', { 
            chat_id: selectedChat.id,
            user_id: userId,
            is_typing: false
          });
        }
        
        // Reserve message ID immediately to prevent WebSocket duplicates
        // We'll use a temporary ID that will be replaced with the real ID from API response
        const tempMessageId = Date.now(); // Temporary ID to track this send operation
        console.log('📤 [CHATS-WEB] Calling API to send user direct message...');
        const response = await api.sendChatMessageToChat(messageText, selectedChat.id);
        console.log('📤 [CHATS-WEB] API response received:', {
          success: response.success,
          hasMessage: !!(response as any).message,
          messageId: (response as any).message?.id,
          messageContent: (response as any).message?.content,
          senderId: (response as any).message?.sender_id
        });
        
        if (response.success && (response as any).message) {
          // Web chat.tsx returns: { success: true, message: ChatMessage }
          const newMsg = (response as any).message;
          console.log('📤 [CHATS-WEB] Message sent successfully, adding to UI');
          
          // CRITICAL: Add message ID to recently sent set IMMEDIATELY to prevent WebSocket duplicates
          // This must happen before setMessages to ensure WebSocket handler sees it
          recentlySentMessageIdsRef.current.add(newMsg.id);
          lastMessageSentTimeRef.current = Date.now();
          
          // Add message only if it doesn't already exist (prevent duplicates from WebSocket)
          setMessages(prev => {
            // FIRST CHECK: Is this message ID in recently sent set?
            if (recentlySentMessageIdsRef.current.has(newMsg.id)) {
              // Double-check: verify message isn't already in the list
              const alreadyExists = prev.find(msg => msg.id === newMsg.id);
              if (alreadyExists) {
                console.log('📤 [CHATS-WEB] Duplicate detected - message already in list, skipping:', newMsg.id);
                return prev;
              }
              // If not in list but in ref, it means WebSocket already added it - skip
              console.log('📤 [CHATS-WEB] Duplicate detected - message ID in recently sent set, skipping:', newMsg.id);
              return prev;
            }
            
            // SECOND CHECK: Exact ID match in current messages
            const existingIndex = prev.findIndex(msg => msg.id === newMsg.id);
            if (existingIndex !== -1) {
              console.log('📤 [CHATS-WEB] Message already exists, updating if needed:', newMsg.id);
              // Update existing message to ensure is_own_message is correct
              const existingMsg = prev[existingIndex];
              if (existingMsg.is_own_message !== true) {
                console.log('🔄 [CHATS-WEB] Fixing message ownership flag:', newMsg.id);
                const updated = [...prev];
                updated[existingIndex] = { ...existingMsg, is_own_message: true };
                return updated;
              }
              // Add to recently sent set to prevent future duplicates
              recentlySentMessageIdsRef.current.add(newMsg.id);
              setTimeout(() => {
                recentlySentMessageIdsRef.current.delete(newMsg.id);
              }, 10000);
              return prev;
            }
            
            // THIRD CHECK: Content + timestamp match (for duplicates with different IDs)
            // Use larger time window (30 seconds) to account for timezone differences (EST vs UTC)
            const duplicateByContent = prev.find(msg => {
              if (msg.content !== newMsg.content) {
                return false;
              }
              // Check if it's our own message (either flag is true or in recently sent set)
              const isOwnMessage = msg.is_own_message === true || recentlySentMessageIdsRef.current.has(msg.id);
              if (!isOwnMessage) {
                return false;
              }
              // Normalize timestamps - ensure UTC parsing by appending Z if missing
              const msgTimeStr = msg.created_at + (msg.created_at.includes('T') && !msg.created_at.match(/[Z+-]/) ? 'Z' : '');
              const newMsgTimeStr = (newMsg.created_at || new Date().toISOString()) + ((newMsg.created_at || '').includes('T') && !(newMsg.created_at || '').match(/[Z+-]/) ? 'Z' : '');
              const msgTime = new Date(msgTimeStr).getTime();
              const newMsgTime = new Date(newMsgTimeStr).getTime();
              const timeDiff = Math.abs(msgTime - newMsgTime);
              // Use 30 second window to account for EST/UTC differences and network delays
              return timeDiff < 30000;
            });
            
            if (duplicateByContent) {
              const msgTimeStr = duplicateByContent.created_at + (duplicateByContent.created_at.includes('T') && !duplicateByContent.created_at.match(/[Z+-]/) ? 'Z' : '');
              const newMsgTimeStr = (newMsg.created_at || new Date().toISOString()) + ((newMsg.created_at || '').includes('T') && !(newMsg.created_at || '').match(/[Z+-]/) ? 'Z' : '');
              const timeDiff = Math.abs(new Date(msgTimeStr).getTime() - new Date(newMsgTimeStr).getTime());
              console.log('📤 [CHATS-WEB] Duplicate message detected by content+time, skipping:', newMsg.id, 'existing:', duplicateByContent.id, 'timeDiff:', timeDiff, 'ms');
              // Add to recently sent set to prevent future duplicates
              recentlySentMessageIdsRef.current.add(newMsg.id);
              setTimeout(() => {
                recentlySentMessageIdsRef.current.delete(newMsg.id);
              }, 10000);
              return prev;
            }
            
            console.log('📤 [CHATS-WEB] Adding optimistic message:', newMsg.id, 'is_own_message: true');
            // Message ID already added to ref above, just need to clear it after timeout
            // Clear it after 10 seconds to prevent memory leak
            setTimeout(() => {
              recentlySentMessageIdsRef.current.delete(newMsg.id);
            }, 10000);
            
            return [...prev, {
              id: newMsg.id,
              content: newMsg.content,
              sender: newMsg.sender,
              is_own_message: true,
              sender_id: (response as any).message?.sender_id ?? currentUserIdRef.current ?? undefined,
              created_at: newMsg.created_at || new Date().toISOString()
            }];
          });
          AccessibilityInfo.announceForAccessibility('Message sent');

          // Update chat list (set last_message_sender_id so unread badge stays hidden for sender)
          const userId = currentUserIdRef.current ?? userProfileRef.current?.data?.id ?? userProfileRef.current?.id;
          setChats(prev => bumpChatActivity(prev, selectedChat.id, {
            last_message: newMsg.content.substring(0, 50),
            updated_at: newMsg.created_at || new Date().toISOString(),
            last_message_sender_id: userId ?? undefined,
          }));
          console.log('📤 [CHATS-WEB] User direct message successfully added to UI and chat list updated');
          clearNetworkFailures();
        } else {
          console.warn('⚠️ [CHATS-WEB] User direct message API call succeeded but no message in response');
        }
      } else if (selectedChat.type === 'workspace') {
        console.log('📤 [CHATS-WEB] ===== SENDING WORKSPACE MESSAGE =====');
        console.log('📤 [CHATS-WEB] Chat ID:', selectedChat.id);
        console.log('📤 [CHATS-WEB] Message text:', messageText);
        // Get user ID from ref to ensure we have latest value
        const userId = userProfileRef.current?.data?.id || userProfileRef.current?.id;
        console.log('📤 [CHATS-WEB] User ID:', userId);
        
        // Emit typing stopped (validate all required fields)
        if (socketRef.current && 
            userId && 
            selectedChat.id != null) {
          socketRef.current.emit('user_typing', { 
            chat_id: selectedChat.id,
            user_id: userId,
            is_typing: false
          });
        }
        
        // Reserve message ID immediately to prevent WebSocket duplicates
        const tempMessageId = Date.now(); // Temporary ID to track this send operation
        console.log('📤 [CHATS-WEB] Calling API to send workspace message...');
        const response = await api.sendChatMessageToChat(messageText, selectedChat.id);
        console.log('📤 [CHATS-WEB] API response received:', {
          success: response.success,
          hasMessage: !!(response as any).message,
          messageId: (response as any).message?.id,
          messageContent: (response as any).message?.content,
          senderId: (response as any).message?.sender_id
        });
        
        if (response.success && (response as any).message) {
          // Web chat.tsx returns: { success: true, message: ChatMessage }
          const newMsg = (response as any).message;
          console.log('📤 [CHATS-WEB] Message sent successfully, adding to UI');
          
          // CRITICAL: Add message ID to recently sent set IMMEDIATELY to prevent WebSocket duplicates
          // This must happen before setMessages to ensure WebSocket handler sees it
          recentlySentMessageIdsRef.current.add(newMsg.id);
          lastMessageSentTimeRef.current = Date.now();
          
          // Add message only if it doesn't already exist (prevent duplicates from WebSocket)
          setMessages(prev => {
            // FIRST CHECK: Is this message ID in recently sent set?
            if (recentlySentMessageIdsRef.current.has(newMsg.id)) {
              // Double-check: verify message isn't already in the list
              const alreadyExists = prev.find(msg => msg.id === newMsg.id);
              if (alreadyExists) {
                console.log('📤 [CHATS-WEB] Duplicate detected - message already in list, skipping:', newMsg.id);
                return prev;
              }
              // If not in list but in ref, it means WebSocket already added it - skip
              console.log('📤 [CHATS-WEB] Duplicate detected - message ID in recently sent set, skipping:', newMsg.id);
              return prev;
            }
            
            // SECOND CHECK: Exact ID match in current messages
            const existingIndex = prev.findIndex(msg => msg.id === newMsg.id);
            if (existingIndex !== -1) {
              console.log('📤 [CHATS-WEB] Message already exists, updating if needed:', newMsg.id);
              // Update existing message to ensure is_own_message is correct
              const existingMsg = prev[existingIndex];
              if (existingMsg.is_own_message !== true) {
                console.log('🔄 [CHATS-WEB] Fixing message ownership flag:', newMsg.id);
                const updated = [...prev];
                updated[existingIndex] = { ...existingMsg, is_own_message: true };
                return updated;
              }
              // Add to recently sent set to prevent future duplicates
              recentlySentMessageIdsRef.current.add(newMsg.id);
              setTimeout(() => {
                recentlySentMessageIdsRef.current.delete(newMsg.id);
              }, 10000);
              return prev;
            }
            
            // THIRD CHECK: Content + timestamp match (for duplicates with different IDs)
            // Use larger time window (30 seconds) to account for timezone differences (EST vs UTC)
            const duplicateByContent = prev.find(msg => {
              if (msg.content !== newMsg.content) {
                return false;
              }
              // Check if it's our own message (either flag is true or in recently sent set)
              const isOwnMessage = msg.is_own_message === true || recentlySentMessageIdsRef.current.has(msg.id);
              if (!isOwnMessage) {
                return false;
              }
              // Normalize timestamps - ensure UTC parsing by appending Z if missing
              const msgTimeStr = msg.created_at + (msg.created_at.includes('T') && !msg.created_at.match(/[Z+-]/) ? 'Z' : '');
              const newMsgTimeStr = (newMsg.created_at || new Date().toISOString()) + ((newMsg.created_at || '').includes('T') && !(newMsg.created_at || '').match(/[Z+-]/) ? 'Z' : '');
              const msgTime = new Date(msgTimeStr).getTime();
              const newMsgTime = new Date(newMsgTimeStr).getTime();
              const timeDiff = Math.abs(msgTime - newMsgTime);
              // Use 30 second window to account for EST/UTC differences and network delays
              return timeDiff < 30000;
            });
            
            if (duplicateByContent) {
              const msgTimeStr = duplicateByContent.created_at + (duplicateByContent.created_at.includes('T') && !duplicateByContent.created_at.match(/[Z+-]/) ? 'Z' : '');
              const newMsgTimeStr = (newMsg.created_at || new Date().toISOString()) + ((newMsg.created_at || '').includes('T') && !(newMsg.created_at || '').match(/[Z+-]/) ? 'Z' : '');
              const timeDiff = Math.abs(new Date(msgTimeStr).getTime() - new Date(newMsgTimeStr).getTime());
              console.log('📤 [CHATS-WEB] Duplicate message detected by content+time, skipping:', newMsg.id, 'existing:', duplicateByContent.id, 'timeDiff:', timeDiff, 'ms');
              // Add to recently sent set to prevent future duplicates
              recentlySentMessageIdsRef.current.add(newMsg.id);
              setTimeout(() => {
                recentlySentMessageIdsRef.current.delete(newMsg.id);
              }, 10000);
              return prev;
            }
            
            console.log('📤 [CHATS-WEB] Adding optimistic message:', newMsg.id, 'is_own_message: true');
            // Message ID already added to ref above, just need to clear it after timeout
            // Clear it after 10 seconds to prevent memory leak
            setTimeout(() => {
              recentlySentMessageIdsRef.current.delete(newMsg.id);
            }, 10000);
            
            return [...prev, {
              id: newMsg.id,
              content: newMsg.content,
              sender: newMsg.sender,
              is_own_message: true,
              sender_id: (response as any).message?.sender_id ?? currentUserIdRef.current ?? undefined,
              created_at: newMsg.created_at || new Date().toISOString()
            }];
          });
          AccessibilityInfo.announceForAccessibility('Message sent');
          
          // Update chat list (set last_message_sender_id so unread badge stays hidden for sender)
          setChats(prev => bumpChatActivity(prev, selectedChat.id, {
            last_message: newMsg.content.substring(0, 50),
            updated_at: newMsg.created_at || new Date().toISOString(),
            last_message_sender_id: userId ?? undefined,
          }));
          console.log('📤 [CHATS-WEB] Workspace message successfully added to UI and chat list updated');
          clearNetworkFailures();
        } else {
          console.warn('⚠️ [CHATS-WEB] Workspace message API call succeeded but no message in response');
        }
      } else {
        // Fallback to general chat (non-streaming)
        const response = await (api as any).sendChatMessage(messageText, {}, abortControllerRef.current?.signal);
        
        if (response.success && (response.response || response.data?.response)) {
          const responseText = response.response || response.data?.response || 'No response received';
          
          setMessages(prev => {
            const newMessages = [...prev];
            newMessages[assistantMessageIndex] = {
              ...newMessages[assistantMessageIndex],
              content: responseText,
              is_own_message: false, // Explicitly set to false for assistant messages
              sender: { id: 1, username: 'ChatGD Assistant', email: 'ai@grabdocs.com' }
            };
            return newMessages;
          });
        }
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log('📤 [CHATS-WEB] Request was aborted');
        if (isFakeStreamingRef.current) {
          stopStreaming(assistantMessageIndex, false);
          isFakeStreamingRef.current = false;
        }
        setSendingMessage(false);
        stopBounceAnimation();
        return;
      }
      const limitData = extractLimitErrorData(getErrorResponseData(error));
      if (limitData) {
        if (isFakeStreamingRef.current) {
          stopStreaming(assistantMessageIndex, false);
          isFakeStreamingRef.current = false;
        }
        setSendingMessage(false);
        stopBounceAnimation();
        showLimitError(limitData);
        return;
      }
      console.error('❌ [CHATS-WEB] Failed to send message:', error);
      console.error('❌ [CHATS-WEB] Error details:', {
        message: error?.message,
        response: error?.response?.data,
        status: error?.response?.status,
        chatType: selectedChat?.type,
        chatId: selectedChat?.id,
        messageText: newMessage?.trim() || 'N/A',
        userId: userProfileRef.current?.data?.id || userProfileRef.current?.id
      });

      // Send to backend so we can see chat failures (e.g. Android prod) in error_logs
      const status = (error as any)?.response?.status;
      const detail = (error as any)?.response?.data;
      const summary = [error?.message, status != null ? `status=${status}` : '', detail ? JSON.stringify(detail).slice(0, 200) : ''].filter(Boolean).join(' | ');
      errorLogger.logError(new Error(summary), {
        severity: 'error',
        screenName: 'Chats',
        userAction: 'SendMessage',
        errorType: 'ChatSendFailed',
        userId: userProfileRef.current?.data?.id ?? userProfileRef.current?.id,
      });
      
      if (isNetworkError(error)) {
        recordNetworkFailure();
      }

      const chatType = selectedChat?.type;
      const isUserChat = chatType === 'user_direct' || chatType === 'workspace';
      const isAiChat =
        chatType === 'ai_assistant' ||
        chatType === 'document_focused' ||
        chatType === 'bookmark_focused';

      if (isUserChat) {
        setNewMessage(messageText);
        setSendingMessage(false);
        stopBounceAnimation();
        Toast.show({
          type: 'error',
          text1: "Couldn't send message",
          text2: getChatNetworkErrorMessage(error),
          visibilityTime: 4000,
        });
        return;
      }

      if (!isAiChat) {
        setSendingMessage(false);
        stopBounceAnimation();
        Toast.show({
          type: 'error',
          text1: "Couldn't send message",
          text2: getChatNetworkErrorMessage(error),
          visibilityTime: 4000,
        });
        return;
      }

      const fallbackResponse = getChatNetworkErrorMessage(error, { inline: true });

      if (isRateLimitError(error) && isFakeStreamingRef.current) {
        stopStreaming(assistantMessageIndex, false);
        isFakeStreamingRef.current = false;
      }
      
      // Replace fake streaming with error fallback content
      contentBufferRef.current = fallbackResponse;
      displayedCharsRef.current = 0;
      isPreviewPhaseRef.current = true;
      isStreamingRef.current = true;
      
      startOrContinueStreaming(assistantMessageIndex);
      
      setTimeout(() => {
        stopStreaming(assistantMessageIndex, true);
        setSendingMessage(false);
        stopBounceAnimation();
      }, fallbackResponse.length * 50 + 1000);
      
    } finally {
      console.log('📤 [CHATS-WEB] Send operation completed (success or error)');
      abortControllerRef.current = null;
      // Do NOT set setSendingMessage(false) here: with polling, the promise resolves immediately after the first poll is sent,
      // so that would hide fake streaming before any chunk arrives. It is cleared in 'complete' / 'error' handlers or in catch above.
    }
  };
  sendMessageRef.current = sendMessage;

  // Helper function to restore context for a chat (reusable)
  const restoreChatContext = (chat: Chat) => {
    // Check if user explicitly removed context for this chat
    // CRITICAL: Don't check for temporary chats (id -2) - they're newly created and context should always be restored
    const isTemporaryChat = chat.id === -2;
    const explicitlyRemoved = !isTemporaryChat && chat.id != null && chat.id !== -1 && contextRemovedChatIdsRef.current.has(Number(chat.id));
    if (explicitlyRemoved) {
      console.log('🚫 Context explicitly removed by user for chat:', chat.id);
      setSelectedMention(null);
      return;
    }
    
    // CRITICAL: Check chat object's context FIRST (most reliable - from chats list)
    // This ensures context is restored even if backend doesn't have it yet
    const bookmarkContext = chat.bookmark_context;
    const documentContext = chat.document_context;
    const workspaceContext = chat.workspace;
    
    if (bookmarkContext) {
      console.log('📖 [RESTORE] Restoring bookmark context from chat object:', {
        chatId: chat.id,
        bookmarkId: bookmarkContext.id,
        bookmarkName: bookmarkContext.name
      });
      setSelectedMention({ 
        type: 'bookmark', 
        id: bookmarkContext.id, 
        name: bookmarkContext.name, 
        data: bookmarkContext 
      });
      return;
    }
    
    if (documentContext) {
      console.log('📖 Restoring document context from chat object:', documentContext.name);
      setSelectedMention({ 
        type: 'file', 
        id: documentContext.id, 
        name: documentContext.name, 
        data: documentContext 
      });
      return;
    }
    
    if (workspaceContext) {
      console.log('📖 Restoring workspace context from chat object:', workspaceContext.name);
      setSelectedMention({ 
        type: 'workspace', 
        id: workspaceContext.id, 
        name: workspaceContext.name, 
        data: workspaceContext 
      });
      return;
    }
    
    // Fallback: try to restore from persistent_context (from backend - most up-to-date)
    // This code only runs if chat object doesn't have context
    const { currentHistory } = useChatStore.getState();
    const persistentContext = currentHistory?.persistent_context;
    
    // Verify currentHistory matches this chat
    const historyId = currentHistory ? (typeof currentHistory.id === 'string' ? parseInt(String(currentHistory.id), 10) : Number(currentHistory.id)) : null;
    const chatId = typeof chat.id === 'string' ? parseInt(String(chat.id), 10) : Number(chat.id);
    const historyMatches = historyId !== null && !isNaN(historyId) && !isNaN(chatId) && historyId === chatId;
    
    if (persistentContext && historyMatches) {
        // Restore context from persistent_context (backend stored context)
        if (persistentContext.context_file_ids && persistentContext.context_file_ids.length > 0) {
          const fileId = persistentContext.context_file_ids[0];
          // First, try to use file name from chat's document_context if available
          const existingFileContext = chat.document_context;
          if (existingFileContext && existingFileContext.id === fileId && existingFileContext.name && 
              !existingFileContext.name.startsWith('Document ') && existingFileContext.name !== 'Document') {
            // Use existing name from chat object (already loaded)
            setSelectedMention({ 
              type: 'file', 
              id: fileId, 
              name: existingFileContext.name, 
              data: existingFileContext 
            });
            return; // Context restored from persistent_context using cached name
          }
          
          // Try to find file in loaded documents list
          const fileInList = documents.find(d => d.id === fileId);
          if (fileInList) {
            setSelectedMention({ 
              type: 'file', 
              id: fileId, 
              name: fileInList.name, 
              data: { id: fileId, name: fileInList.name, type: 'other' } 
            });
            return; // Context restored from persistent_context using loaded documents
          }
          
          // Only fetch from API if name is not available locally
          api.getFileById(fileId).then((response: any) => {
            if (response.success && response.file) {
              const fileName = response.file.original_filename || response.file.filename || `Document ${fileId}`;
              setSelectedMention({ 
                type: 'file', 
                id: fileId, 
                name: fileName, 
                data: { id: fileId, name: fileName, type: 'other' } 
              });
            } else {
              setSelectedMention({ type: 'file', id: fileId, name: `Document ${fileId}`, data: { id: fileId, name: `Document ${fileId}`, type: 'other' } });
            }
          }).catch(() => {
            setSelectedMention({ type: 'file', id: fileId, name: `Document ${fileId}`, data: { id: fileId, name: `Document ${fileId}`, type: 'other' } });
          });
          return; // Context restored from persistent_context
        } else if (persistentContext.context_bookmark_ids && persistentContext.context_bookmark_ids.length > 0) {
          const bookmarkId = persistentContext.context_bookmark_ids[0];
          // Try to find bookmark in loaded bookmarks
          const bookmark = bookmarks.find(b => b.id === bookmarkId);
          if (bookmark) {
            setSelectedMention({ type: 'bookmark', id: bookmarkId, name: bookmark.name, data: bookmark });
          } else if (chat.bookmark_context && chat.bookmark_context.id === bookmarkId) {
            // Use bookmark context from chat object if available
            setSelectedMention({ type: 'bookmark', id: bookmarkId, name: chat.bookmark_context.name, data: chat.bookmark_context });
          } else {
            // Only fetch from API if bookmark not found locally
            api.getBookmarks().then((response: any) => {
              if (response.success && response.data) {
                const bookmarkData = Array.isArray(response.data) ? response.data : (response.data.bookmarks || []);
                const foundBookmark = bookmarkData.find((b: any) => b.id === bookmarkId);
                if (foundBookmark) {
                  setSelectedMention({ type: 'bookmark', id: bookmarkId, name: foundBookmark.name, data: foundBookmark });
                }
              }
            }).catch(() => {
              // If fetch fails, try to use chat's bookmark_context as fallback
            });
          }
          return; // Context restored from persistent_context
        }
      }
      
      // No context found anywhere - clear selectedMention
      // This prevents context from one chat showing up in another chat
      console.log('ℹ️ No context found for chat:', chat.id, '- clearing selectedMention');
      setSelectedMention(null);
  };

  // CRITICAL: Update chat object when bookmark/document context is selected
  // This ensures the chat type and context are preserved in the chats list
  useEffect(() => {
    if (!selectedChat || !selectedMention) return;
    
    // Only update if we have a bookmark or document context
    if (selectedMention.type === 'bookmark' && selectedMention.data) {
      const bookmarkData = selectedMention.data;
      // Check if chat already has this bookmark context
      if (selectedChat.bookmark_context?.id !== bookmarkData.id || selectedChat.type !== 'bookmark_focused') {
        console.log('🔄 [BOOKMARK] Updating chat with bookmark context:', {
          chatId: selectedChat.id,
          bookmarkName: bookmarkData.name,
          bookmarkId: bookmarkData.id,
          currentType: selectedChat.type,
          currentBookmarkId: selectedChat.bookmark_context?.id
        });
        
        const updatedChat = {
          ...selectedChat,
          type: 'bookmark_focused' as const,
          bookmark_context: bookmarkData,
          title: `Chat about ${bookmarkData.name}`
        };
        
        setSelectedChat(updatedChat);
        
        // Also update the chat in the chats list and persist IMMEDIATELY
        setChats(prev => {
          const updated = prev.map(chat => 
            chat.id === selectedChat.id ? updatedChat : chat
          );
          
          // CRITICAL: Save immediately to AsyncStorage
          console.log('💾 [BOOKMARK] Saving bookmark context to AsyncStorage for chat', selectedChat.id);
          savePersistedChatContexts(authUserId,updated).then(() => {
            console.log('✅ [BOOKMARK] Successfully saved bookmark context to AsyncStorage');
          }).catch(error => {
            console.error('❌ [BOOKMARK] Failed to save bookmark context:', error);
          });
          
          return updated;
        });
      } else {
        console.log('⏭️ [BOOKMARK] Chat already has bookmark context, skipping update');
      }
    } else if (selectedMention.type === 'file' && selectedMention.data) {
      const fileData = selectedMention.data;
      // Check if chat already has this document context
      if (selectedChat.document_context?.id !== fileData.id || selectedChat.type !== 'document_focused') {
        console.log('🔄 Updating chat with document context:', fileData.name);
        // Use a helper to truncate filename safely (defined later in component)
        const truncateName = (name: string, maxLength: number = 40) => {
          const nameWithoutExt = name.replace(/\.[^/.]+$/, '');
          return nameWithoutExt.length <= maxLength 
            ? nameWithoutExt 
            : nameWithoutExt.substring(0, maxLength - 3) + '...';
        };
        
        const updatedChat = {
          ...selectedChat,
          type: 'document_focused' as const,
          document_context: fileData,
          title: `Document: ${truncateName(fileData.name)}`
        };
        
        setSelectedChat(updatedChat);
        
        // Also update the chat in the chats list and persist
        setChats(prev => {
          const updated = prev.map(chat => 
            chat.id === selectedChat.id ? updatedChat : chat
          );
          savePersistedChatContexts(authUserId,updated);
          return updated;
        });
      }
    }
  }, [selectedMention, selectedChat?.id]); // Only depend on selectedMention and chat ID

  const selectChat = (chat: Chat) => {
    // Reset going back flag when selecting a chat
    setIsGoingBack(false);
    
    // CRITICAL: Only abort/reset when genuinely switching to a different chat.
    // Re-selecting the same chat ID (e.g. from a chat list refresh) must NOT abort an
    // in-flight send or reset sendingMessage — that was the root cause of polling jobs
    // being unexpectedly killed mid-stream.
    const previousChatId = selectedChat?.id;
    const newChatId = chat.id;
    if (previousChatId !== newChatId) {
      // Abort any ongoing requests when switching chats
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      
      // Stop streaming if active
      if (streamingIntervalRef.current) {
        clearInterval(streamingIntervalRef.current);
        streamingIntervalRef.current = null;
      }
      
      // Reset all streaming state when switching chats to ensure messages load correctly
      isStreamingRef.current = false;
      isStreamCompleteRef.current = false;
      lastStreamCompleteTimeRef.current = 0;
      lastStreamedMessageIndexRef.current = null;
      contentBufferRef.current = '';
      displayedCharsRef.current = 0;
      isPreviewPhaseRef.current = true;
      isFakeStreamingRef.current = false;
      streamingMessageIndexRef.current = null;
      setStreamingMessageIndex(null);
      
      setSendingMessage(false);
      stopBounceAnimation();
      
      // Clear messages immediately to prevent cross-chat contamination
      console.log(`🔄 Switching from chat ${previousChatId} to ${newChatId} - clearing messages and context`);
      setMessages([]);
      loadedChatIdRef.current = null;
      setSelectedMention(null);
    }
    
    // CRITICAL: Chat Assistant (ID -1) should NEVER have context
    // Always clear context and selectedMention when selecting Chat Assistant
    if (chat.id === -1) {
      console.log('🔵 [SELECT] Selecting Chat Assistant - clearing all context');
      setSelectedMention(null);
      // Ensure Chat Assistant has no context
      const chatAssistantClean: Chat = {
        ...chat,
        document_context: undefined,
        bookmark_context: undefined,
        workspace: undefined,
        type: 'ai_assistant',
        title: chat.title || 'Start New'
      };
      setSelectedChat(chatAssistantClean);
      
      // Also update in chats list to ensure it doesn't have context
      setChats(prev => {
        const updated = prev.map(c => 
          c.id === -1 ? chatAssistantClean : c
        );
        savePersistedChatContexts(authUserId,updated);
        return updated;
      });
      
      // Load messages for Chat Assistant
      loadMessages(-1, true).then(() => {
        console.log('🔵 [SELECT] Chat Assistant messages loaded');
      }).catch((error: any) => {
        console.error('❌ Error loading Chat Assistant messages:', error);
      });
      
      return; // Early return - don't process Chat Assistant like other chats
    }
    
    // CRITICAL: Ensure chat's document_context, bookmark_context, and type are preserved from chats list
    // This ensures document_focused chats maintain their green icon and context
    const chatWithContext = chats.find(c => c.id === chat.id);
    
    // CRITICAL: Always check if chat has context and preserve it, even if type is wrong
    let chatToSelect: Chat;
    if (chatWithContext && (chatWithContext.document_context || chatWithContext.bookmark_context || chatWithContext.workspace)) {
      // Chat has context in the list - use it
      chatToSelect = {
        ...chat,
        document_context: chatWithContext.document_context || chat.document_context,
        bookmark_context: chatWithContext.bookmark_context || chat.bookmark_context,
        workspace: chatWithContext.workspace || chat.workspace,
        // ALWAYS set type based on context, not what backend says
        type: chatWithContext.bookmark_context ? 'bookmark_focused' :
              chatWithContext.document_context ? 'document_focused' :
              chatWithContext.workspace ? 'workspace' :
              chatWithContext.type === 'bookmark_focused' || chatWithContext.type === 'document_focused' || chatWithContext.type === 'workspace' ? chatWithContext.type :
              chat.type === 'bookmark_focused' || chat.type === 'document_focused' || chat.type === 'workspace' ? chat.type :
              'ai_assistant' // Fallback only if no context
      };
      console.log(`🔍 Selecting chat ${chat.id} with context:`, {
        type: chatToSelect.type,
        hasBookmark: !!chatToSelect.bookmark_context,
        hasDocument: !!chatToSelect.document_context,
        title: chatToSelect.title
      });
    } else if (chat.bookmark_context || chat.document_context || chat.workspace) {
      // Chat object itself has context (from backend or elsewhere) - use it
      chatToSelect = {
        ...chat,
        type: chat.bookmark_context ? 'bookmark_focused' :
              chat.document_context ? 'document_focused' :
              chat.workspace ? 'workspace' :
              chat.type
      };
      console.log(`🔍 Selecting chat ${chat.id} with context from chat object:`, {
        type: chatToSelect.type,
        hasBookmark: !!chatToSelect.bookmark_context,
        hasDocument: !!chatToSelect.document_context
      });
    } else {
      // No context found - use chat as-is
      chatToSelect = chat;
    }
    
    // When selecting placeholder (-2) with bookmark: use real backend chat if it exists
    // Backend creates chat history on first message; user may have gone back before complete event updated the list
    if (chatToSelect.id === -2 && chatToSelect.bookmark_context?.id) {
      const bookmarkId = chatToSelect.bookmark_context.id;
      let realChat = chats.find(c =>
        c.id > 0 &&
        c.type !== 'user_direct' &&
        c.type !== 'workspace' &&
        (c.bookmark_context?.id === bookmarkId || (c as any).bookmark_context?.id === bookmarkId)
      );
      if (realChat) {
        chatToSelect = realChat;
        console.log('🔄 [SELECT] Using real backend chat for bookmark (placeholder -2 ->', realChat.id, ')');
      } else if (currentChatIdRef.current != null && currentChatIdRef.current > 0) {
        // Fallback: backend returned chat_history_id before user went back; list may not have refreshed yet
        chatToSelect = { ...chatToSelect, id: currentChatIdRef.current };
        console.log('🔄 [SELECT] Using chat_history_id from ref for bookmark (placeholder -2 ->', currentChatIdRef.current, ')');
      }
    }
    
    setSelectedChat(chatToSelect);
    // Set ref immediately so loadMessages can use it (state update is async; ref is sync)
    selectedChatRef.current = chatToSelect;
    
    // CRITICAL: Restore context IMMEDIATELY before loading messages
    // This ensures context is set even if loadMessages fails or takes time
    console.log('🔍 [SELECT] Restoring context immediately for chat:', {
      chatId: chatToSelect.id,
      type: chatToSelect.type,
      hasBookmark: !!chatToSelect.bookmark_context,
      bookmarkName: chatToSelect.bookmark_context?.name
    });
    restoreChatContext(chatToSelect);
    
    // Load messages first, then restore context again (persistent_context is loaded with messages)
    loadMessages(chatToSelect.id, true).then(() => { // Force reload when switching chats
      // Restore context again after messages load (in case backend has updated context)
      console.log('🔍 [SELECT] Restoring context after messages loaded');
      restoreChatContext(chatToSelect);
    }).catch((error: any) => {
      console.error('Failed to load messages and restore context:', error);
      // On error, still try to restore from local chat object
      restoreChatContext(chatToSelect);
    });
  };

  const goBackToChats = () => {
    // CRITICAL: Set going back flag FIRST to immediately switch to chat list view
    // This prevents showing chat messages view with null selectedChat (which shows "Chat" in header)
    setIsGoingBack(true);
    
    // Abort any ongoing requests when leaving chat
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    
    // Stop streaming if active
    if (streamingIntervalRef.current) {
      clearInterval(streamingIntervalRef.current);
      streamingIntervalRef.current = null;
    }
    
    // CRITICAL: Reset ALL streaming state when leaving chat
    // This ensures messages reload properly when returning
    isStreamingRef.current = false;
    isStreamCompleteRef.current = false;
    isFakeStreamingRef.current = false;
    lastStreamCompleteTimeRef.current = 0; // Reset completion time so streaming guard doesn't block reload
    lastStreamedMessageIndexRef.current = null;
    contentBufferRef.current = '';
    displayedCharsRef.current = 0;
    isPreviewPhaseRef.current = true;
    streamingMessageIndexRef.current = null;
    setStreamingMessageIndex(null);
    
    setSendingMessage(false);
    stopBounceAnimation();
    
    // CRITICAL: Preserve chat's document_context and type in the chats list before clearing selectedChat
    // This ensures the chat maintains its document_focused type and green icon when selected again
    // ALSO: If chat doesn't exist in list (temporary id -2), add it so it appears when going back
    // IMPORTANT: Chat Assistant (ID -1) should NEVER have context preserved
    if (selectedChat && selectedChat.id !== -1 && (selectedChat.document_context || selectedChat.bookmark_context || selectedChat.workspace)) {
      console.log('🔙 [GOBACK] Going back - preserving context for chat:', {
        chatId: selectedChat.id,
        type: selectedChat.type,
        hasBookmark: !!selectedChat.bookmark_context,
        hasDocument: !!selectedChat.document_context,
        bookmarkName: selectedChat.bookmark_context?.name
      });
      
      // CRITICAL: Set flag to prevent loadChats from overwriting context
      isPreservingContextRef.current = true;
      contextPreservationTimeRef.current = Date.now();
      
      // CRITICAL: Use functional update to ensure we have the latest state
      // Also save to AsyncStorage immediately to prevent race conditions with useFocusEffect
      setChats(prev => {
        const existingChat = prev.find(chat => chat.id === selectedChat.id);
        
        console.log('🔙 [GOBACK] Found existing chat in list:', {
          chatId: selectedChat.id,
          exists: !!existingChat,
          currentType: existingChat?.type,
          currentHasBookmark: !!existingChat?.bookmark_context
        });
        
        let updatedChats: Chat[];
        
        if (existingChat) {
          // Update existing chat - CRITICAL: Always preserve bookmark/document context from selectedChat
          updatedChats = prev.map(chat => {
            if (chat.id === selectedChat.id) {
              // ALWAYS use selectedChat's context and type - it's the most up-to-date
              const updatedChat = {
                ...chat,
                // Preserve context from selectedChat (most recent)
                document_context: selectedChat.document_context || chat.document_context,
                bookmark_context: selectedChat.bookmark_context || chat.bookmark_context,
                workspace: selectedChat.workspace || chat.workspace,
                // ALWAYS use selectedChat's type if it's a context chat, otherwise preserve existing
                type: selectedChat.bookmark_context ? 'bookmark_focused' :
                      selectedChat.document_context ? 'document_focused' :
                      selectedChat.workspace ? 'workspace' :
                      selectedChat.type === 'bookmark_focused' || selectedChat.type === 'document_focused' || selectedChat.type === 'workspace' ? selectedChat.type :
                      chat.type,
                // Preserve title from selectedChat if it's more descriptive
                title: selectedChat.title || chat.title
              };
              
              console.log(`💾 [GOBACK] Preserving context for chat ${chat.id} when going back:`, {
                oldType: chat.type,
                newType: updatedChat.type,
                hasBookmarkContext: !!updatedChat.bookmark_context,
                bookmarkName: updatedChat.bookmark_context?.name,
                hasDocumentContext: !!updatedChat.document_context,
                title: updatedChat.title
              });
              
              return updatedChat;
            }
            return chat;
          });
        } else {
          // Chat doesn't exist in list (temporary id -2 or new chat) - add it
          if (__DEV__) console.log(`📋 Adding chat ${selectedChat.id} to list (preserving context):`, {
            type: selectedChat.type,
            hasBookmarkContext: !!selectedChat.bookmark_context,
            hasDocumentContext: !!selectedChat.document_context
          });
          
          const chatAssistant = prev.find(chat => chat.id === -1);
          const otherChats = prev.filter(chat => chat.id !== -1);
          
          if (chatAssistant) {
            updatedChats = [chatAssistant, selectedChat, ...otherChats];
          } else {
            updatedChats = [selectedChat, ...prev];
          }
        }
        
        // CRITICAL: Save to AsyncStorage immediately and wait for it to complete
        // This prevents race conditions where useFocusEffect calls loadChats() before save completes
        console.log(`💾 Saving ${updatedChats.length} chats to AsyncStorage, including chat ${selectedChat.id} with bookmark context:`, {
          chatId: selectedChat.id,
          type: updatedChats.find(c => c.id === selectedChat.id)?.type,
          hasBookmark: !!updatedChats.find(c => c.id === selectedChat.id)?.bookmark_context
        });
        
        // CRITICAL: Save to AsyncStorage and keep flag set for 3 seconds
        savePersistedChatContexts(authUserId,updatedChats).then(() => {
          console.log('✅ Successfully saved chat contexts to AsyncStorage, including bookmark context for chat', selectedChat.id);
          // Keep flag set for 3 seconds to prevent loadChats from overwriting
          setTimeout(() => {
            isPreservingContextRef.current = false;
            console.log('🔓 Context preservation flag cleared');
          }, 3000);
        }).catch(error => {
          console.error('❌ Failed to save chat contexts when going back:', error);
          isPreservingContextRef.current = false;
        });
        
        return updatedChats;
      });
    }
    
    // Clear fileId params to ensure params are cleared (even if it doesn't update immediately)
    clearRouteParams();
    
    // CRITICAL: If Chat Assistant had context somehow, clear it before going back
    // This prevents Chat Assistant from inheriting context from previous chats
    if (selectedChat && selectedChat.id === -1 && (selectedChat.bookmark_context || selectedChat.document_context || selectedChat.workspace)) {
      console.log('⚠️ [GOBACK] Chat Assistant had context, clearing it before going back');
      setChats(prev => {
        const updated: Chat[] = prev.map(chat => 
          chat.id === -1 ? {
            ...chat,
            document_context: undefined,
            bookmark_context: undefined,
            workspace: undefined,
            type: 'ai_assistant' as const,
            title: 'Start New'
          } : chat
        );
        savePersistedChatContexts(authUserId,updated);
        return updated;
      });
    }
    
    setSelectedChat(null);
    setMessages([]);
    loadedChatIdRef.current = null; // Clear loaded chat ID when leaving chat
    
    // When leaving a placeholder bookmark/document chat (-2): refresh list to get real chat from backend
    // Backend creates chat history on first message but may not return chat_history_id in polling response
    // Store in ref so loadChats can merge it (avoids stale closure - loadChats would otherwise read old chats)
    if (selectedChat && selectedChat.id === -2 && (selectedChat.bookmark_context || selectedChat.document_context)) {
      placeholderChatToPreserveRef.current = selectedChat;
      setTimeout(() => {
        const k = authUserId ? chatListScreenKey(authUserId) : null;
        if (k) screenCache.invalidate(k);
        loadChats();
      }, 500);
    }
    
    // CRITICAL: Clear selectedMention if we're leaving Chat Assistant
    // This prevents context from persisting when switching to Chat Assistant
    if (selectedChat && selectedChat.id === -1) {
      console.log('🔵 [GOBACK] Clearing selectedMention when leaving Chat Assistant');
      setSelectedMention(null);
    }
    // For other chats, DO NOT clear selectedMention when going back - context should persist
    // The context will be restored when the chat is selected again via restoreChatContext
  };

  // Mention detection — mirrors the web DualChatInput logic:
  // • use only the text before the cursor so editing in the middle works correctly
  // • @ must be at position 0 or immediately preceded by whitespace (not mid-word)
  // • the query token must contain no spaces (space ends the mention)
  const detectMention = (text: string, cursorPosition: number) => {
    const textBeforeCursor = text.substring(0, cursorPosition);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');

    if (lastAtIndex === -1) {
      setShowMentionModal(false);
      setMentionQuery('');
      return;
    }

    // @ must be at the very start or preceded by whitespace
    const charBeforeAt = lastAtIndex === 0 ? ' ' : textBeforeCursor[lastAtIndex - 1];
    if (charBeforeAt !== ' ' && lastAtIndex !== 0) {
      setShowMentionModal(false);
      return;
    }

    const queryAfterAt = textBeforeCursor.substring(lastAtIndex + 1);

    // A space after @ means the mention token is done / cancelled
    if (queryAfterAt.includes(' ')) {
      setShowMentionModal(false);
      setMentionQuery('');
      return;
    }

    setMentionQuery(queryAfterAt);
    setShowMentionModal(true);

    // Reload users / workspaces / bookmarks if still empty — these are locally filtered
    // so they must be cached up-front.  Documents are NOT bulk-loaded here; they are
    // fetched on-demand via the debounced searchDocumentsForMention() call.
    const reloadTasks: Promise<void>[] = [];
    if (users.length === 0) reloadTasks.push(loadUsers());
    if (workspaces.length === 0) reloadTasks.push(loadWorkspaces());
    if (bookmarks.length === 0) reloadTasks.push(loadBookmarks());
    if (reloadTasks.length > 0) {
      Promise.all(reloadTasks).catch(error => {
        console.error('Error reloading mention data:', error);
      });
    }
  };

  // Mention functionality
  const handleMentionInput = (text: string) => {
    // Keep the ref in sync so onSelectionChange can read the latest text
    // even before React flushes the setNewMessage state update.
    newMessageRef.current = text;

    // When the user types a character the cursor ends up at text.length, which
    // is the correct cursor position for the common "type at the end" case.
    // onSelectionChange will re-run detectMention with the precise position
    // whenever the cursor is moved manually (e.g. tapping into the middle).
    detectMention(text, text.length);

    setNewMessage(text);
    
    // Emit typing event for user chats (user_direct and workspace only)
    // Validate all required fields exist before emitting to prevent server errors
    const userId = userProfileRef.current?.data?.id || userProfileRef.current?.id;
    if (selectedChat && 
        (selectedChat.type === 'user_direct' || selectedChat.type === 'workspace') && 
        socketRef.current && 
        userId && 
        selectedChat.id != null) {
      // Clear existing timeout
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      
      // Emit typing started
      socketRef.current.emit('user_typing', { 
        chat_id: selectedChat.id,
        user_id: userId,
        is_typing: true
      });
      
      // Auto-stop typing after 3 seconds of inactivity
      typingTimeoutRef.current = setTimeout(() => {
        const userIdForTyping = userProfileRef.current?.data?.id || userProfileRef.current?.id;
        if (socketRef.current && 
            selectedChat && 
            userIdForTyping && 
            selectedChat.id != null) {
          socketRef.current.emit('user_typing', { 
            chat_id: selectedChat.id,
            user_id: userIdForTyping,
            is_typing: false
          });
        }
      }, 3000);
    }
  };

  const selectMention = (item: any) => {
    // Set the selected mention (replace any previous one)
    setSelectedMention({
      type: item.type,
      id: item.id,
      name: item.name,
      data: item.data
    });
    
    // Clear the textbox since the mention is now shown in the chip above
    setNewMessage('');
    setShowMentionModal(false);
    setMentionQuery('');
  };

  const removeMention = () => {
    // User and workspace context are bound to the conversation and cannot be removed
    if (selectedMention?.type === 'user' || selectedMention?.type === 'workspace') {
      return;
    }
    // If this is the chat's built-in context (document/bookmark only; workspace is bound), mark as explicitly removed so we don't restore on reload
    const chatId = selectedChat?.id != null && selectedChat.id !== -1 ? Number(selectedChat.id) : null;
    const isBuiltInContext = selectedChat && selectedMention && (
      (selectedChat.document_context && selectedMention.type === 'file' && selectedMention.id === selectedChat.document_context.id) ||
      (selectedChat.bookmark_context && selectedMention.type === 'bookmark' && selectedMention.id === selectedChat.bookmark_context.id)
    );
    if (chatId != null && isBuiltInContext) {
      contextRemovedChatIdsRef.current.add(chatId);
      secureStorage.setItem(STORAGE_KEYS.CONTEXT_REMOVED_CHAT_IDS, JSON.stringify([...contextRemovedChatIdsRef.current]));
    }
    setSelectedMention(null);
    // Remove mention from message
    const atIndex = newMessage.lastIndexOf('@');
    if (atIndex !== -1) {
      const beforeMention = newMessage.slice(0, atIndex);
      const afterMention = newMessage.slice(atIndex).split(' ').slice(1).join(' ');
      setNewMessage(beforeMention + afterMention);
    }
  };

  const getMentionIcon = (type: string) => {
    switch (type) {
      case 'user': return 'person';
      case 'bookmark': return 'bookmark';
      case 'file': return 'document-text';
      case 'workspace': return 'business';
      default: return 'at-circle';
    }
  };

  const getMentionColor = (type: string) => {
    switch (type) {
      case 'user': return '#FF3B30'; // Match user_direct color from getChatTypeInfo
      case 'bookmark': return '#AF52DE'; // Match bookmark_focused color from getChatTypeInfo
      case 'file': return '#34C759'; // Match document_focused color from getChatTypeInfo
      case 'workspace': return '#FF9500'; // Match workspace color from getChatTypeInfo
      default: return '#666';
    }
  };

  const truncateFilename = (name: string, maxLength: number = 40) => {
    const nameWithoutExtension = removeFileExtension(name);
    if (nameWithoutExtension.length <= maxLength) {
      return nameWithoutExtension;
    }
    return nameWithoutExtension.substring(0, maxLength - 3) + '...';
  };

  const messageInputPlaceholder = useMemo(() => {
    const chat = selectedChat;
    if (!chat) return CHATGD_DEFAULT_INPUT_PLACEHOLDER;
    if (chat.type === 'document_focused') {
      const n = chat.document_context?.name?.trim();
      if (n)
        return `Ask questions about "${truncateFilename(n, 38)}"`;
      return 'Ask questions about this file';
    }
    if (chat.type === 'bookmark_focused') {
      const n = chat.bookmark_context?.name?.trim();
      if (n)
        return `Ask questions about bookmark "${truncateFilename(n, 34)}"`;
      return 'Ask questions about this bookmark';
    }
    if (chat.id === -1 && askClient) return `Ask about ${truncateAskClientName(askClient.name)}…`;
    if (chat.id === -1 && routeInputPlaceholder) return routeInputPlaceholder;
    if (chat.id === -1 && calendarEntryPlaceholder) return 'Ask about your calendar and events';
    return CHATGD_DEFAULT_INPUT_PLACEHOLDER;
  }, [selectedChat, calendarEntryPlaceholder, routeInputPlaceholder, askClient]);

  const createQuickChat = (type: 'ai_assistant' | 'user_direct' | 'workspace' | 'document_focused' | 'bookmark_focused') => {
    setShowQuickChatTypes(false);
    
    // Create new chat immediately for all types
    // Backend will create chat history when first message is sent
    const newChat: Chat = {
      id: -2,
      title: getChatTypeInfo(type).name,
      type: type,
      participants: [{ id: 1, username: 'ChatGD Assistant', email: 'ai@grabdocs.com' }],
      last_message: `New ${getChatTypeInfo(type).name.toLowerCase()} - ready to chat`,
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      unread_count: 0
    };
    
    // Add context based on type
    if (type === 'document_focused') {
      // For document focused, we'll need to select a document
      // For now, create a placeholder that can be updated when document is selected
      newChat.document_context = {
        id: 0,
        name: 'Select a document',
        type: 'document'
      };
    } else if (type === 'bookmark_focused') {
      // For bookmark focused, we'll need to select a bookmark
      newChat.bookmark_context = {
        id: 0,
        name: 'Select a bookmark collection',
        description: 'Choose a bookmark collection to focus on',
        file_count: 0,
        documents: []
      };
    } else if (type === 'workspace') {
      // For workspace, we'll need to select a workspace
      newChat.workspace = {
        id: 0,
        name: 'Select a workspace',
        description: 'Choose a workspace to chat in',
        slug: '',
        owner_id: 0,
        is_personal: false,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        member_count: 0,
        user_role: 'member',
        can_manage: false,
        can_invite: false,
        can_edit: false
      };
    }
    
    // Add the new chat to the list and select it
    // Ensure ChatGD Assistant always remains first
    // Check if a chat with the same ID already exists before adding
    setChats(prev => {
      const existingChat = prev.find(chat => chat.id === newChat.id);
      if (existingChat) {
        // Chat already exists, just select it instead of creating a duplicate
        console.log(`⚠️ Chat ${newChat.id} already exists, selecting existing chat instead of creating duplicate`);
        return prev;
      }
      
      const chatAssistant = prev.find(chat => chat.id === -1); // Find the default ChatGD Assistant
      const otherChats = prev.filter(chat => chat.id !== -1); // All chats except default ChatGD Assistant
      
      if (chatAssistant) {
        // ChatGD Assistant exists, add new chat after it
        return [chatAssistant, newChat, ...otherChats];
      } else {
        // No ChatGD Assistant found, add new chat at beginning
        return [newChat, ...prev];
      }
    });
    setSelectedChat(newChat);
    setMessages([]);
    loadedChatIdRef.current = null; // Reset loaded chat ID so loadMessages will load for new chat
    
    // Load welcome message for the new chat
    loadMessages(newChat.id);
  };

  const getChatTypeInfo = (type: string) => {
    switch (type) {
      case 'ai_assistant':
        return { 
          name: 'Quick Chat', 
          icon: 'chatbubbles' as const, 
          color: '#007AFF',
          description: 'Chat with Assistant about your documents'
        };
      case 'document_focused':
        return { 
          name: 'Document Chat', 
          icon: 'document-text' as const, 
          color: '#34C759',
          description: 'Focus on a specific document'
        };
      case 'workspace':
        return { 
          name: 'Workspace Chat', 
          icon: 'people' as const, 
          color: '#FF9500',
          description: 'Team messaging and collaboration'
        };
      case 'user_direct':
        return { 
          name: 'Direct Message', 
          icon: 'person' as const, 
          color: '#FF3B30',
          description: 'Private conversation with a user'
        };
      case 'bookmark_focused':
        return { 
          name: 'Bookmark Collection', 
          icon: 'bookmark' as const, 
          color: '#AF52DE',
          description: 'Chat about bookmarked files'
        };
      default:
        return { 
          name: 'Chat', 
          icon: 'chatbubble' as const, 
          color: '#007AFF',
          description: 'General chat'
        };
    }
  };

  const createNewChat = async () => {
    try {
      let newChat: Chat;
      
      switch (newChatType) {
        case 'ai_assistant':
          // Backend will create chat history when first message is sent
          // Use temporary placeholder ID (-2) to distinguish from default assistant (-1)
          newChat = {
            id: -2,
            title: 'ChatGD Assistant',
            type: 'ai_assistant',
            participants: [{ id: 1, username: 'ChatGD Assistant', email: 'ai@grabdocs.com' }],
            last_message: 'Ask me anything about your documents',
            updated_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
            unread_count: 0
          };
          break;
          
        case 'document_focused':
          if (!selectedDocument) {
            Alert.alert('Error', 'Please select a document to focus on');
            return;
          }
          // Backend will create chat history when first message is sent
          // Use temporary placeholder ID (-2) to distinguish from default assistant (-1)
          newChat = {
            id: -2,
            title: `Document: ${truncateFilename(selectedDocument.name)}`,
            type: 'document_focused',
            participants: [{ id: 1, username: 'ChatGD Assistant', email: 'ai@grabdocs.com' }],
            last_message: `Ready to answer questions about ${selectedDocument.name}`,
            updated_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
            unread_count: 0,
            document_context: selectedDocument
          };
          break;
          
        case 'workspace':
          if (!selectedWorkspace) {
            Alert.alert('Error', 'Please select a workspace');
            return;
          }
          
          // Create workspace chat using web endpoint (same as web chat.tsx)
          try {
            const response = await api.startUserChat({
              type: 'workspace',
              workspace_id: selectedWorkspace.id
            });
            
            if (response.success && (response as any).chat) {
              // Web chat.tsx returns: { success: true, chat: Chat, existing: boolean }
              newChat = {
                id: (response as any).chat.id,
                title: (response as any).chat.display_name || `${selectedWorkspace.name} Team Chat`,
                type: 'workspace',
                participants: (response as any).chat.participants || [],
                last_message: (response as any).chat.latest_message?.content || 'Start a team conversation',
                updated_at: (response as any).chat.last_message_at || new Date().toISOString(),
                created_at: (response as any).chat.created_at || new Date().toISOString(),
                unread_count: 0,
                workspace: selectedWorkspace
              };
            } else {
              Alert.alert('Error', 'Failed to create workspace chat');
              return;
            }
          } catch (error) {
            console.error('Failed to create workspace chat:', error);
            Alert.alert('Error', 'Failed to create workspace chat');
            return;
          }
          break;
          
        case 'user_direct':
          if (!selectedUser) {
            Alert.alert('Error', 'Please select a user to message');
            return;
          }
          {
            const myId = currentUserIdRef.current;
            if (myId != null && String(selectedUser.id) === String(myId)) {
              Alert.alert('Error', 'You cannot start a chat with yourself');
              return;
            }
          }
          
          // Create user direct chat using web endpoint (same as web chat.tsx)
          try {
            const response = await api.startUserChat({
              type: 'direct',
              user_id: selectedUser.id
            });
            
            if (response.success && (response as any).chat) {
              // Web chat.tsx returns: { success: true, chat: Chat, existing: boolean }
              newChat = {
                id: (response as any).chat.id,
                title: (response as any).chat.display_name || ((selectedUser as any).first_name || (selectedUser as any).last_name || selectedUser.username || 'User'),
                type: 'user_direct',
                participants: (response as any).chat.participants || [selectedUser],
                last_message: (response as any).chat.latest_message?.content || 'Start a conversation',
                updated_at: (response as any).chat.last_message_at || new Date().toISOString(),
                created_at: (response as any).chat.created_at || new Date().toISOString(),
                unread_count: 0
              };
            } else {
              Alert.alert('Error', 'Failed to create direct chat');
              return;
            }
          } catch (error) {
            console.error('Failed to create direct chat:', error);
            Alert.alert('Error', 'Failed to create direct chat');
            return;
          }
          break;
          
        case 'bookmark_focused':
          if (!selectedBookmark) {
            Alert.alert('Error', 'Please select a bookmark collection');
            return;
          }
          // Backend will create chat history when first message is sent
          // Use temporary placeholder ID (-2) to distinguish from default assistant (-1)
          newChat = {
            id: -2,
            title: `Chat about ${selectedBookmark.name}`,
            type: 'bookmark_focused',
            participants: [{ id: 1, username: 'ChatGD Assistant', email: 'ai@grabdocs.com' }],
            last_message: `Ready to answer questions about ${selectedBookmark.name} collection`,
            updated_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
            unread_count: 0,
            bookmark_context: selectedBookmark
          };
          break;
          
        default:
          return;
      }
      
      // Check if a chat with the same context already exists (for bookmark/document chats)
      // This prevents creating duplicate chats when user creates the same bookmark/document chat multiple times
      if (newChat.bookmark_context || newChat.document_context) {
        setChats(prev => {
          // Check if a chat with the same bookmark/document context already exists
          const existingContextChat = prev.find(chat => 
            (newChat.bookmark_context && chat.bookmark_context?.id === newChat.bookmark_context.id) ||
            (newChat.document_context && chat.document_context?.id === newChat.document_context.id)
          );
          
          if (existingContextChat) {
            // Chat with same context already exists, select it instead of creating duplicate
            console.log(`⚠️ Chat with same context already exists (${existingContextChat.id}), selecting existing chat`);
            setSelectedChat(existingContextChat);
            setShowNewChatModal(false);
            // Restore context for the existing chat
            restoreChatContext(existingContextChat);
            return prev;
          }
          
          // No existing chat with same context, add new chat
          const chatAssistant = prev.find(chat => chat.id === -1);
          const otherChats = prev.filter(chat => chat.id !== -1);
          
          let updatedChats: Chat[];
          if (chatAssistant) {
            updatedChats = [chatAssistant, newChat, ...otherChats];
          } else {
            updatedChats = [newChat, ...prev];
          }
          
          // Persist chat context immediately for user_direct, workspace, document, and bookmark chats
          savePersistedChatContexts(authUserId,updatedChats);
          return updatedChats;
        });
      } else {
        // For other chat types, check by ID
        setChats(prev => {
          const existingChat = prev.find(chat => chat.id === newChat.id);
          if (existingChat) {
            if (newChat.id === -2 && newChat.type === 'ai_assistant') {
              // Replace the stale placeholder with the fresh new chat so context is reset
              return prev.map(c => c.id === -2 ? newChat : c);
            }
            // Chat already exists, just select it instead of creating a duplicate
            console.log(`⚠️ Chat ${newChat.id} already exists, selecting existing chat instead of creating duplicate`);
            return prev;
          }
          const updatedChats = [newChat, ...prev];
          // Persist chat context immediately for user_direct, workspace, document, and bookmark chats
          savePersistedChatContexts(authUserId,updatedChats);
          return updatedChats;
        });
      }
      setShowNewChatModal(false);
      setSelectedChat(newChat);
      
      // Clear messages and reset loading so the new chat opens with a blank centered input
      setMessages([]);
      setMessagesLoading(false);
      loadedChatIdRef.current = null; // Reset so loadMessages can load fresh when needed
      
      // Set selectedMention based on the context type so it appears in the conversation window
      if (newChat.document_context) {
        setSelectedMention({
          type: 'file',
          id: newChat.document_context.id,
          name: newChat.document_context.name,
          data: newChat.document_context
        });
      } else if (newChat.bookmark_context) {
        setSelectedMention({
          type: 'bookmark',
          id: newChat.bookmark_context.id,
          name: newChat.bookmark_context.name,
          data: newChat.bookmark_context
        });
      } else if (newChat.workspace) {
        setSelectedMention({
          type: 'workspace',
          id: newChat.workspace.id,
          name: newChat.workspace.name,
          data: newChat.workspace
        });
      } else if (newChat.type === 'user_direct' && selectedUser) {
        setSelectedMention({
          type: 'user',
          id: selectedUser.id,
          name: selectedUser.username,
          data: selectedUser
        });
      } else {
        // Plain ai_assistant — clear any leftover mention so the input area is clean
        setSelectedMention(null);
      }
      
      // Reset selections and search states
      setSelectedDocument(null);
      setSelectedWorkspace(null);
      setSelectedUser(null);
      setSelectedBookmark(null);
      setNewChatType('ai_assistant');
      setModalUserSearch('');
      setModalWorkspaceSearch('');
      setModalDocumentSearch('');
      setModalBookmarkSearch('');
      
    } catch (error) {
      Alert.alert('Error', 'Failed to create new chat');
    }
  };

  const onRefresh = () => {
    setRefreshing(true);
    const k = authUserId ? chatListScreenKey(authUserId) : null;
    if (k) screenCache.invalidate(k);
    chatListLastLoadRef.current = 0; // Reset debounce so loadChats actually runs
    loadChats();
  };

  const onRefreshMessages = async () => {
    if (!selectedChat) return;
    setRefreshing(true);
    try {
      await loadMessages(selectedChat.id, true); // Force reload on manual refresh
    } finally {
      setRefreshing(false);
    }
  };

  const handleShareConversation = async () => {
    if (!selectedChat || messages.length === 0) return;
    const now = new Date();
    const dateTimeDisplay = now.toLocaleDateString() + ' ' + now.toLocaleTimeString();
    const separator = '─'.repeat(50);
    const lines = messages.map((msg, i) => {
      const label = (selectedChat?.type === 'ai_assistant' || selectedChat?.type === 'document_focused' || selectedChat?.type === 'bookmark_focused')
        ? (i % 2 === 0 ? 'You' : 'ChatGD')
        : (msg.is_own_message ? 'You' : (msg.sender?.username || 'User'));
      return `${label}:\n${(msg.content || '').trim()}`;
    });
    const convoText = lines.join('\n\n');
    const brandedText = `GrabDocs — ChatGD Conversation\n${dateTimeDisplay}\n${separator}\n\n${convoText}\n\n${separator}\nGenerated by GrabDocs`;
    try {
      await Share.share({
        message: brandedText,
        title: 'GrabDocs — ChatGD Conversation',
      });
    } catch {
      // User cancelled or share failed; ignore
    }
  };

  const formatMessageTime = (dateString: string) => {
    try {
      if (!dateString) {
        return '';
      }
      
      // Dates from backend are stored in UTC
      // Ensure we parse as UTC if no timezone indicator is present
      let date: Date;
      
      // Check if timestamp has timezone indicator
      const hasTimezone = dateString.endsWith('Z') || dateString.match(/[+-]\d{2}:\d{2}$/);
      
      if (!hasTimezone && dateString.includes('T')) {
        // Timestamp is in ISO format but missing timezone - treat as UTC
        // Parse the UTC components explicitly
        const isoString = dateString.endsWith('Z') ? dateString : dateString + 'Z';
        date = new Date(isoString);
      } else if (!hasTimezone) {
        // Not ISO format - try parsing as-is, but log warning
        date = new Date(dateString);
        if (__DEV__) {
          console.warn('⚠️ Timestamp without timezone indicator:', dateString);
        }
      } else {
        // Has timezone indicator - parse normally
        date = new Date(dateString);
      }
      
      if (isNaN(date.getTime())) {
        if (__DEV__) {
          console.log('❌ Failed to parse timestamp:', dateString);
        }
        return 'Invalid Date';
      }
      
      // Format using local time (JavaScript automatically converts UTC to local timezone)
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (error) {
      if (__DEV__) {
        console.log('❌ Error formatting message time:', error, 'for timestamp:', dateString);
      }
      return 'Invalid Date';
    }
  };

  const formatChatTime = (dateString: string) => {
    try {
      if (!dateString) {
        return 'Unknown';
      }
      
      // Dates from backend are stored in UTC
      // Ensure we parse as UTC if no timezone indicator is present
      let date: Date;
      
      // Check if timestamp has timezone indicator
      const hasTimezone = dateString.endsWith('Z') || dateString.match(/[+-]\d{2}:\d{2}$/);
      
      if (!hasTimezone && dateString.includes('T')) {
        // Timestamp is in ISO format but missing timezone - treat as UTC
        // Parse the UTC components explicitly
        const isoString = dateString.endsWith('Z') ? dateString : dateString + 'Z';
        date = new Date(isoString);
      } else if (!hasTimezone) {
        // Not ISO format - try parsing as-is, but log warning
        date = new Date(dateString);
        if (__DEV__) {
          console.warn('⚠️ Timestamp without timezone indicator:', dateString);
        }
      } else {
        // Has timezone indicator - parse normally
        date = new Date(dateString);
      }
      
      if (isNaN(date.getTime())) {
        if (__DEV__) {
          console.log('❌ Failed to parse chat timestamp:', dateString);
        }
        return 'Unknown';
      }
      
      // Format using local time (JavaScript automatically converts UTC to local timezone)
      return formatRelativeDate(date);
    } catch (error) {
      if (__DEV__) {
        console.log('❌ Error formatting chat time:', error, 'for timestamp:', dateString);
      }
      return 'Unknown';
    }
  };

  const formatRelativeDate = (date: Date) => {
    const now = new Date();
    
    // Calculate difference in minutes (both dates are in local timezone)
    const diffInMinutes = Math.floor((now.getTime() - date.getTime()) / (1000 * 60));
    
    // If the date is in the future (more than 1 minute), show the actual date
    // This handles edge cases where dates might be slightly in the future due to clock skew
    if (diffInMinutes < -1) {
      const currentYear = now.getFullYear();
      const dateYear = date.getFullYear();
      
      if (dateYear === currentYear) {
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      } else {
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      }
    }
    
    // Less than 1 minute
    if (diffInMinutes < 1) return 'Now';
    
    // Less than 1 hour
    if (diffInMinutes < 60) return `${diffInMinutes}m`;
    
    // Less than 24 hours
    if (diffInMinutes < 1440) return `${Math.floor(diffInMinutes / 60)}h`;
    
    // Check if it's yesterday
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
      return 'Yesterday';
    }
    
    // Check if it's within the last 7 days
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    if (date > weekAgo) {
      // Show day name (e.g., "Monday", "Tuesday")
      return date.toLocaleDateString('en-US', { weekday: 'short' });
    }
    
    // Older than a week - show date
    const currentYear = now.getFullYear();
    const dateYear = date.getFullYear();
    
    if (dateYear === currentYear) {
      // Same year - show month and day (e.g., "Aug 23")
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } else {
      // Different year - show month, day, and year (e.g., "Aug 23, 2024")
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
  };

  const renderChatItem = ({ item }: { item: Chat }) => {
    // Safety check for item
    if (!item) {
      return null;
    }

    // Debug: Log the first few chat items being rendered
    // if (item.id <= 5) {
    //   console.log('🎨 Rendering chat item:', {
    //     id: item.id,
    //     title: item.title,
    //     type: item.type
    //   });
    // }

    const getChatIcon = () => {
      // Priority 1: Check direct context properties FIRST (most reliable)
      // This ensures we get the right icon even if type wasn't set correctly
      if (item.bookmark_context) {
        return { name: 'bookmark' as const, color: '#AF52DE' };
      }
      if (item.document_context && item.document_context.id) {
        return { name: 'document-text' as const, color: '#34C759' };
      }
      if (item.workspace && item.workspace.id) {
        return { name: 'business' as const, color: '#FF9500' };
      }
      
      // Priority 2: Check chat type (fallback if no direct context)
      switch (item.type) {
        case 'document_focused':
          return { name: 'document-text' as const, color: '#34C759' };
        case 'bookmark_focused':
          return { name: 'bookmark' as const, color: '#AF52DE' };
        case 'workspace':
          return { name: 'business' as const, color: '#FF9500' };
        case 'user_direct':
          return { name: 'person' as const, color: '#FF3B30' };
        case 'ai_assistant':
          // Continue to check chatStore
          break;
        default:
          return { name: 'chatbubble' as const, color: '#007AFF' };
      }
      
      // Priority 3: Check persistent_context and top-level properties from chatStore
      // This handles cases where context exists but isn't set on the chat item
      if (item.id > 0) {
        try {
          const { histories } = useChatStore.getState();
          const chatHistory = histories?.find(h => {
            const historyId = typeof h.id === 'string' ? parseInt(String(h.id), 10) : Number(h.id);
            const targetId = typeof item.id === 'string' ? parseInt(String(item.id), 10) : Number(item.id);
            return !isNaN(historyId) && !isNaN(targetId) && historyId === targetId;
          });
          
          if (chatHistory) {
            const historyData = chatHistory as any;
            const persistentContext = historyData.persistent_context || historyData.persistentContext;
            
            // Check top-level properties first (these are set when chat is created)
            if (historyData.selected_bookmarks?.length > 0) {
              return { name: 'bookmark' as const, color: '#AF52DE' };
            }
            if (historyData.selected_files?.length > 0) {
              return { name: 'document-text' as const, color: '#34C759' };
            }
            if (historyData.selected_workspaces?.length > 0) {
              return { name: 'business' as const, color: '#FF9500' };
            }
            if (historyData.selected_users?.length > 0) {
              return { name: 'person' as const, color: '#FF3B30' };
            }
            
            // Then check persistent_context (this is updated as chat progresses)
            if (persistentContext) {
              // Check for bookmark context
              if (persistentContext.context_bookmark_ids?.length > 0 || persistentContext.selected_bookmarks?.length > 0) {
                return { name: 'bookmark' as const, color: '#AF52DE' };
              }
              // Check for document context
              if (persistentContext.context_file_ids?.length > 0 || persistentContext.selected_files?.length > 0) {
                return { name: 'document-text' as const, color: '#34C759' };
              }
              // Check for workspace context
              if (persistentContext.context_workspace_ids?.length > 0 || persistentContext.selected_workspaces?.length > 0) {
                return { name: 'business' as const, color: '#FF9500' };
              }
              // Check for user context
              if (persistentContext.context_user_ids?.length > 0 || persistentContext.selected_users?.length > 0) {
                return { name: 'person' as const, color: '#FF3B30' };
              }
            }
          }
        } catch (error) {
          // Silently fail if chatStore check fails
        }
      }
      
      // Priority 4: Final fallback - default ai_assistant icon
      return { name: 'chatbubbles' as const, color: '#007AFF' };
    };

    const { name: iconName, color } = getChatIcon();

    // Ensure all text values are properly stringified; cap list titles for mobile density
    const safeTitle = truncateChatHeaderTitle(item.title || 'Untitled Chat');
    const safeLastMessage = String(item.last_message || 'No messages');
    const safeUpdatedAt = String(item.updated_at || new Date().toISOString());
    const safeUnreadCount = Number(item.unread_count || 0);
    // Unread badge only for receiver: for user/workspace chats, hide when last message was sent by current user
    const currentUserId = userProfileRef.current?.data?.id ?? userProfileRef.current?.id;
    const isUserOrWorkspaceChat = item.type === 'user_direct' || item.type === 'workspace';
    const lastMessageIsFromMe = item.last_message_sender_id != null && currentUserId != null && item.last_message_sender_id === currentUserId;
    const showUnreadBadge = safeUnreadCount > 0 && (!isUserOrWorkspaceChat || !lastMessageIsFromMe);

    return (
      <Swipeable
        ref={(ref) => {
          if (ref) {
            chatSwipeableRefs.current.set(item.id, ref);
          } else {
            chatSwipeableRefs.current.delete(item.id);
          }
        }}
        renderRightActions={() => renderChatMenuAction(item.id)}
        onSwipeableWillOpen={() => {
          swipingChatId.current = item.id;
          // Close other swipeables when one opens
          chatSwipeableRefs.current.forEach((ref, id) => {
            if (id !== item.id && ref) {
              ref.close();
            }
          });
        }}
        onSwipeableClose={() => {
          // Reset swipe flag immediately when closing
          if (swipingChatId.current === item.id) {
            swipingChatId.current = null;
          }
        }}
        overshootRight={false}
        rightThreshold={40}
        friction={2}
        overshootFriction={8}
        containerStyle={{ backgroundColor: 'transparent' }}
      >
        <View style={{ backgroundColor: colors.card || '#fff', width: '100%' }}>
          <TouchableOpacity 
            style={dynamicStyles.chatItem}
            activeOpacity={0.7}
            onPress={() => {
              // Don't open chat if we just swiped this specific chat
              if (swipingChatId.current !== item.id) {
                selectChat(item);
              }
            }}
          >
          <View style={[dynamicStyles.chatAvatar, { backgroundColor: `${color}20` }]}>
            <Ionicons name={iconName} size={24} color={color} />
          </View>
          <View style={dynamicStyles.chatContent}>
            <View style={dynamicStyles.chatItemHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                <Text style={dynamicStyles.chatTitle} numberOfLines={1} ellipsizeMode="tail">
                  {safeTitle}
                </Text>
                {favoriteChatIds.has(item.id) && (
                  <Ionicons name="star" size={16} color="#FFD700" style={{ marginLeft: 6 }} />
                )}
              </View>
              <Text style={dynamicStyles.chatTime}>
                {formatChatTime(safeUpdatedAt)}
              </Text>
            </View>
            <View style={dynamicStyles.chatFooter}>
              <Text style={dynamicStyles.lastMessage} numberOfLines={2}>
                {safeLastMessage}
              </Text>
              {showUnreadBadge && (
                <View style={dynamicStyles.unreadBadge}>
                  <Text style={dynamicStyles.unreadText}>
                    {String(safeUnreadCount)}
                  </Text>
                </View>
              )}
            </View>
          </View>
          </TouchableOpacity>
        </View>
      </Swipeable>
    );
  };

  // Helper function to render message content with proper list formatting
  const renderMessageContent = (content: string, isOwnMessage: boolean, isPreview?: boolean) => {
    // Simple rendering - just display text as-is without complex parsing
    if (!content || content.trim().length === 0) {
      return null;
    }

    const displayContent =
      !isOwnMessage ? localizeUtcDatesInAssistantText(content) : content;

    return (
      <Text 
        style={[
          dynamicStyles.messageText,
          isOwnMessage ? dynamicStyles.ownMessageText : dynamicStyles.otherMessageText,
          isPreview && dynamicStyles.previewMessageText
        ]}
      >
        {displayContent}
      </Text>
    );
  };

  // Delete chat handler
  const handleDeleteChat = async (chatId: number) => {
    Alert.alert(
      'Delete Chat',
      'Are you sure you want to delete this chat?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              // Don't allow deleting the default ChatGD Assistant chat
              if (chatId === -1) {
                Alert.alert('Error', 'Cannot delete the Start New chat');
                return;
              }
              
              // Use chatStore to delete
              const success = await useChatStore.getState().deleteChatHistory(chatId);
              
              if (success) {
                const k = authUserId ? chatListScreenKey(authUserId) : null;
    if (k) screenCache.invalidate(k);
                // Remove from local chats list
                setChats(prev => prev.filter(chat => chat.id !== chatId));
                
                // If this was the selected chat, clear selection
                if (selectedChat?.id === chatId) {
                  setSelectedChat(null);
                  setMessages([]);
                }
                
                // Close any open swipeables
                chatSwipeableRefs.current.forEach(ref => {
                  if (ref) {
                    ref.close();
                  }
                });
              } else {
                Alert.alert('Error', 'Failed to delete chat');
              }
            } catch (error: any) {
              Alert.alert('Error', error.message || 'Failed to delete chat');
            }
          }
        }
      ]
    );
  };

  // Handle add/remove favorite (syncs with web via PUT /api/v1/mobile/chat/unified-history/<id>/favorite)
  const handleToggleFavorite = async (chatId: number) => {
    const chat = chats.find(c => c.id === chatId);
    // Use source to determine unified ID: 'user' = UserChat (user_<id>), 'llm' or missing = ChatHistory (llm_<id>)
    // Type alone is unreliable: LLM chats can have selected_users/workspaces and get typed as user_direct/workspace
    const unifiedId = chat?.source === 'user' ? `user_${chatId}` : `llm_${chatId}`;
    const isFavorite = favoriteChatIds.has(chatId);
    const nextFavorite = !isFavorite;

    try {
      // Skip API for special IDs; sync with backend for real chats
      if (chatId !== -1 && chatId !== -2) {
        await api.setUnifiedChatFavorite(unifiedId, nextFavorite);
      }

      const newFavorites = new Set(favoriteChatIds);
      if (nextFavorite) {
        newFavorites.add(chatId);
      } else {
        newFavorites.delete(chatId);
      }
      const favKey = authUserId ? favoriteChatsStorageKey(authUserId) : null;
      if (favKey) {
        await AsyncStorage.setItem(favKey, JSON.stringify(Array.from(newFavorites)));
      }
      setFavoriteChatIds(newFavorites);

      setMenuChatId(null);
      const swipeableRef = chatSwipeableRefs.current.get(chatId);
      if (swipeableRef) {
        swipeableRef.close();
      }
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to update favorite');
    }
  };

  // Render menu action for chat swipeable (main list - uses RectButton for gesture handler compatibility)
  const renderChatMenuAction = (chatId: number) => {
    return (
      <View style={dynamicStyles.menuActionContainer}>
        <RectButton
          style={dynamicStyles.menuActionButton}
          onPress={() => {
            setMenuChatId(chatId);
          }}
        >
          <Ionicons name="ellipsis-vertical" size={24} color="#fff" />
          <Text style={dynamicStyles.menuActionText}>More</Text>
        </RectButton>
      </View>
    );
  };

  // Render menu action for chat swipeable inside a Modal. Uses Pressable (better touch handling
  // in nested gesture contexts). Closes history modal first so the Favorite/Delete menu appears
  // on the main screen (avoids modal-on-modal touch/stacking issues).
  const renderHistoryMenuAction = (chatId: number) => {
    return (
      <View style={dynamicStyles.menuActionContainer}>
        <Pressable
          style={({ pressed }) => [dynamicStyles.menuActionButton, pressed && { opacity: 0.7 }]}
          onPress={() => {
            historySheet.close();
            historySwipeableRefs.current.get(chatId)?.close();
            requestAnimationFrame(() => {
              setMenuChatId(chatId);
            });
          }}
        >
          <Ionicons name="ellipsis-vertical" size={24} color="#fff" />
          <Text style={dynamicStyles.menuActionText}>More</Text>
        </Pressable>
      </View>
    );
  };

  const renderMessageItem = ({ item, globalIndex }: { item: ChatMessage; globalIndex: number }) => {
    // Determine if assistant responses should use bubbles based on chat type
    // User messages always have bubbles, but assistant responses don't need bubbles in document/bookmark chats
    const isDocumentOrBookmarkChat = selectedChat && (
      selectedChat.type === 'document_focused' || 
      selectedChat.type === 'bookmark_focused' ||
      selectedChat.type === 'ai_assistant'
    );
    // For user/workspace chats: derive from sender_id vs current user so alignment is correct even before profile loads
    const currentUserId = currentUserIdRef.current;
    // ChatGD / document / bookmark: only user queries on the right (sender null). Assistant rows always left.
    const isOwnMessage = isDocumentOrBookmarkChat
      ? Boolean(item.is_own_message && item.sender == null)
      : (currentUserId != null && item.sender_id != null)
        ? String(item.sender_id) === String(currentUserId)
        : item.is_own_message;

    // Build accessibility label for screen readers (WCAG 4.1.3)
    const preview = (item.content || '').trim().substring(0, 80);
    const msgLabel = isOwnMessage
      ? `Your message${preview ? `: ${preview}${preview.length >= 80 ? '…' : ''}` : ''}`
      : `Message from ${item.sender?.username || 'assistant'}${preview ? `: ${preview}${preview.length >= 80 ? '…' : ''}` : ''}`;
    const refiningStatusColor = colors.primary ?? '#007AFF';

    // User messages always have bubbles (right); others on left
    if (isOwnMessage) {
      return (
        <View
          style={[
            dynamicStyles.messageContainer,
            dynamicStyles.ownMessage
          ]}
          role="listitem"
          accessibilityLabel={msgLabel}
        >
          <View style={[
            dynamicStyles.messageBubble,
            dynamicStyles.ownBubble
          ]}>
            {renderMessageContent(item.content, true, item.is_preview)}
            <Text style={[
              dynamicStyles.messageTime,
              dynamicStyles.ownMessageTime
            ]}>
              {formatMessageTime(item.created_at)}
            </Text>
          </View>
        </View>
      );
    } else {
      // Other person's messages (left side): no bubbles for document/bookmark/ai_assistant, bubbles for user/workspace
      const hasContent = item.content && item.content.trim().length > 0;
      // Check if this is the message being streamed by finding its index in the messages array
      const currentMessageIndex = messages.findIndex(m => m.id === item.id);
      // Use ref for immediate check, fallback to state for re-renders
      const streamingIndex = streamingMessageIndexRef.current !== null ? streamingMessageIndexRef.current : streamingMessageIndex;
      const isStreamingThisMessage = streamingIndex !== null && currentMessageIndex === streamingIndex;
      // Fake streaming is active only if: sending is active, this is the streaming message, and fake streaming ref is true
      const isFakeStreamingActive = sendingMessage && isStreamingThisMessage && isFakeStreamingRef.current;
      // Real streaming is active if this message is being streamed and streaming ref is true
      const isRealStreamingActive = isStreamingThisMessage && isStreamingRef.current;
      // Hide time during fake or real streaming
      const isStreamingActive = isFakeStreamingActive || isRealStreamingActive;
      
      if (isDocumentOrBookmarkChat) {
        // No bubbles (ChatGPT style). Fake streaming runs IN THIS SAME SLOT (above the time), then preview/refinement replace it.
        // Footer (copy, thumbs, timestamp) shows only after streaming is done, below the response.
        // CRITICAL: Use globalIndex with messages array — SectionList's per-section index caused response text to appear in query bubbles
        const messagePairIndex = Math.floor(globalIndex / 2);
        const queryText = globalIndex > 0 ? messages[globalIndex - 1]?.content : undefined;
        const showFooter = hasContent && !isStreamingActive && !item.is_preview;
        const persistedHistoryId = getPersistedChatHistoryId();
        return (
          <View
            style={[
              dynamicStyles.messageContainerNoBubble,
              dynamicStyles.otherMessageNoBubble
            ]}
            role="listitem"
            accessibilityLabel={msgLabel}
          >
            <View style={{ flexDirection: 'column', width: '100%' }}>
              {(isFakeStreamingActive && !hasContent)
                ? (
                    <ProcessingMessageDisplay
                      isProcessing={true}
                      hasRealData={!!item.content}
                      processingType="general"
                      onComplete={() => {}}
                    />
                  )
                : hasContent ? (
                  <>
                    {!item.is_preview ? (
                      <AssistantMessageBody
                        content={item.content}
                        citations={item.citations}
                        isPreview={false}
                        chartFileId={item.chartFileId}
                        textColor={colors.text}
                        previewColor="#9ca3af"
                        onOpenSermon={(fileId, paragraph, title, paragraphEnd) =>
                          void openDocumentViewer(fileId, paragraph, title, paragraphEnd, undefined, 'text')
                        }
                        onOpenLink={(url) => {
                          const fileLink = parseGrabDocsFileViewUrl(url);
                          if (fileLink) {
                            void openDocumentViewer(
                              fileLink.fileId,
                              0,
                              'Document',
                              undefined,
                              fileLink.pdfUri ?? null,
                              'pdf',
                            );
                            return;
                          }
                          if (url.startsWith('/')) {
                            router.push(url as any);
                            return;
                          }
                          if (shouldUseExternalLinking(url)) {
                            Linking.openURL(url);
                            return;
                          }
                          const trimmed = url.trim();
                          if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
                            let linkTitle = 'Link';
                            try {
                              linkTitle = new URL(trimmed).hostname;
                            } catch {
                              /* keep default */
                            }
                            setWebPopup((w) => ({
                              visible: true,
                              url: trimmed,
                              title: linkTitle,
                              expandNonce: w.expandNonce + 1,
                            }));
                            return;
                          }
                          Linking.openURL(url);
                        }}
                      />
                    ) : (
                      renderMessageContent(item.content, false, true)
                    )}
                    {item.chartFileId && !item.is_preview ? (
                      <TouchableOpacity
                        onPress={() =>
                          setChartModal({
                            visible: true,
                            chartFileId: item.chartFileId!,
                            title: item.chartTitle || 'Chart',
                          })
                        }
                        style={{ marginTop: 8 }}
                      >
                        <Text style={{ color: '#007AFF', textDecorationLine: 'underline', fontSize: 16 }}>
                          View chart: {item.chartTitle || 'Chart'}
                        </Text>
                      </TouchableOpacity>
                    ) : null}
                    {item.refining_answer_pending &&
                    hasContent &&
                    item.is_preview !== false ? (
                      <View
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          marginTop: 10,
                          flexWrap: 'wrap',
                        }}
                        accessibilityRole="text"
                        accessibilityLabel={
                          item.main_search_pending
                            ? 'Preparing final response'
                            : 'Refining response'
                        }
                      >
                        <Text style={{ color: refiningStatusColor, fontSize: 15 }}>
                          {item.main_search_pending ? 'Preparing final response' : 'Refining response'}
                        </Text>
                        <RefiningStatusDots color={refiningStatusColor} />
                      </View>
                    ) : null}
                  </>
                ) : null}
              {showFooter && (
                <ChatMessageFooter
                  chatHistoryId={persistedHistoryId || undefined}
                  messagePairIndex={messagePairIndex}
                  queryText={queryText}
                  responseText={item.content}
                  createdAt={item.created_at}
                  citations={item.citations}
                  showActions={true}
                  showMoreSources={
                    persistedHistoryId > 0 &&
                    !item.is_own_message &&
                    !item.is_preview &&
                    typeof item.id === 'number' &&
                    item.id > 0 &&
                    item.id < BACKEND_MESSAGE_ID_MAX &&
                    Array.isArray(item.citations) &&
                    item.citations.length > 0 &&
                    (globalIndex === messages.length - 1 ||
                      (globalIndex === messages.length - 2 && messages[messages.length - 1]?.is_own_message))
                  }
                  onMoreSources={() => handleMoreSourcesAssistant(globalIndex, item.id as number)}
                  moreSourcesDisabled={sendingMessage}
                  showRetry={
                    persistedHistoryId > 0 &&
                    !item.is_own_message &&
                    typeof item.id === 'number' &&
                    item.id > 0 &&
                    item.id < BACKEND_MESSAGE_ID_MAX &&
                    (globalIndex === messages.length - 1 ||
                      (globalIndex === messages.length - 2 && messages[messages.length - 1]?.is_own_message))
                  }
                  onRetry={() => handleRetryAssistant(globalIndex, item.id)}
                  retryDisabled={sendingMessage}
                />
              )}
            </View>
          </View>
        );
      } else {
        // User/workspace: we never add an empty assistant message, but guard anyway.
        // Footer shows only after streaming is done, below the bubble. No copy/like/dislike/citation for user/workspace.
        if (!hasContent) return null;
        const messagePairIndex = Math.floor(globalIndex / 2);
        const queryText = globalIndex > 0 ? messages[globalIndex - 1]?.content : undefined;
        const showFooter = !isStreamingActive && !item.is_preview;
        return (
          <View
            style={[
              dynamicStyles.messageContainer,
              dynamicStyles.otherMessage
            ]}
            role="listitem"
            accessibilityLabel={msgLabel}
          >
            <View style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
              <View style={[
                dynamicStyles.messageBubble,
                dynamicStyles.otherBubble
              ]}>
                {renderMessageContent(item.content, false, item.is_preview)}
              </View>
              {showFooter && (
                <ChatMessageFooter
                  chatHistoryId={selectedChat?.id}
                  messagePairIndex={messagePairIndex}
                  queryText={queryText}
                  responseText={item.content}
                  createdAt={item.created_at}
                  citations={item.citations}
                  showActions={false}
                />
              )}
            </View>
          </View>
        );
      }
    }
  };

  const closeHistoryModal = useCallback(() => {
    historySheet.close();
    setMenuChatId(null);
  }, [historySheet.close]);

  const handleConversationHeaderBack = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (streamingIntervalRef.current) {
      clearInterval(streamingIntervalRef.current);
      streamingIntervalRef.current = null;
    }
    isStreamingRef.current = false;
    isStreamCompleteRef.current = false;
    router.back();
  }, [router]);

  const handleOpenChatHistory = useCallback(() => {
    // Always allow history while a response is in flight — do not gate on sendingMessage.
    historySheet.open();
  }, [historySheet.open]);

  const handleHeaderNewChat = useCallback(() => {
    setShowNewChatModal(true);
  }, []);

  const handleShareConversationRef = useRef(handleShareConversation);
  handleShareConversationRef.current = handleShareConversation;
  const handleHeaderShare = useCallback(() => {
    void handleShareConversationRef.current();
  }, []);

  const renderHistoryModal = () => (
    <MinimizableBottomSheet
      visible={historySheet.visible}
      expandNonce={historySheet.expandNonce}
      onClose={closeHistoryModal}
      title="Chat History"
      heightRatio={0.8}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
          {/* Search */}
          <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            margin: 12,
            paddingHorizontal: 10,
            backgroundColor: colors.surface,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: colors.border,
          }}>
            <Ionicons name="search" size={18} color="#666" style={{ marginRight: 6 }} />
            <TextInput
              {...ANDROID_TEXT_INPUT_PROPS}
              style={{ flex: 1, fontSize: 15, color: colors.text, paddingVertical: 8, backgroundColor: 'transparent' }}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search chats..."
              placeholderTextColor="#999"
              returnKeyType="search"
              onSubmitEditing={() => Keyboard.dismiss()}
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => setSearchQuery('')}>
                <Ionicons name="close-circle" size={18} color="#666" />
              </TouchableOpacity>
            )}
          </View>
          {/* Chat list */}
          {loading ? (
            <View style={{ paddingVertical: 40, alignItems: 'center' }}>
              <ActivityIndicator size="large" color="#007AFF" />
            </View>
          ) : (
            <FlatList
              data={filteredChats}
              keyExtractor={(item, index) => item ? `history-${item.type}-${item.id}-${index}` : `history-${index}`}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingBottom: 88 }}
              onEndReached={() => {
                if (!searchQuery.trim() && (hasMoreAiChats || hasMoreUserChats)) {
                  loadMoreChats();
                }
              }}
              onEndReachedThreshold={0.3}
              ListFooterComponent={
                isLoadingMoreChats ? (
                  <ActivityIndicator size="small" color="#007AFF" style={{ marginVertical: 12 }} />
                ) : null
              }
              renderItem={({ item }) => {
                if (!item) return null;
                const getChatIconForHistory = () => {
                  if (item.bookmark_context) return { name: 'bookmark' as const, color: '#AF52DE' };
                  if (item.document_context?.id) return { name: 'document-text' as const, color: '#34C759' };
                  if (item.workspace?.id) return { name: 'business' as const, color: '#FF9500' };
                  switch (item.type) {
                    case 'document_focused': return { name: 'document-text' as const, color: '#34C759' };
                    case 'bookmark_focused': return { name: 'bookmark' as const, color: '#AF52DE' };
                    case 'workspace': return { name: 'business' as const, color: '#FF9500' };
                    case 'user_direct': return { name: 'person' as const, color: '#FF3B30' };
                    default: return { name: 'chatbubbles' as const, color: '#007AFF' };
                  }
                };
                const { name: iconName, color } = getChatIconForHistory();
                const isActive = selectedChat?.id === item.id;
                // Skip swipe for virtual/placeholder chats (id < 0)
                const canSwipe = item.id > 0;
                const rowContent = (
                  <View style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    backgroundColor: isActive ? `${color}15` : colors.card,
                    borderLeftWidth: isActive ? 3 : 0,
                    borderLeftColor: isActive ? color : 'transparent',
                  }}>
                    <View style={{
                      width: 42,
                      height: 42,
                      borderRadius: 21,
                      backgroundColor: `${color}20`,
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginRight: 12,
                    }}>
                      <Ionicons name={iconName} size={22} color={color} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        <Text style={{ fontSize: 15, fontWeight: '500', color: colors.text, flex: 1 }} numberOfLines={1} ellipsizeMode="tail">
                          {truncateChatHeaderTitle(item.title || 'Untitled Chat')}
                        </Text>
                        {favoriteChatIds.has(item.id) && (
                          <Ionicons name="star" size={14} color="#FFD700" style={{ marginLeft: 4 }} />
                        )}
                      </View>
                      <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }} numberOfLines={1} ellipsizeMode="tail">
                        {String(item.last_message || 'No messages')}
                      </Text>
                    </View>
                    {isActive && (
                      <Ionicons name="checkmark-circle" size={20} color={color} style={{ marginLeft: 8 }} />
                    )}
                  </View>
                );
                if (!canSwipe) {
                  return (
                    <GHTouchableOpacity activeOpacity={0.7} onPress={() => { closeHistoryModal(); selectChat(item); }}>
                      {rowContent}
                    </GHTouchableOpacity>
                  );
                }
                return (
                  <Swipeable
                    ref={(ref) => {
                      if (ref) historySwipeableRefs.current.set(item.id, ref);
                      else historySwipeableRefs.current.delete(item.id);
                    }}
                    renderRightActions={() => renderHistoryMenuAction(item.id)}
                    onSwipeableWillOpen={() => {
                      swipingChatId.current = item.id;
                      // Close other open rows in the history list
                      historySwipeableRefs.current.forEach((ref, id) => {
                        if (id !== item.id && ref) ref.close();
                      });
                    }}
                    onSwipeableClose={() => {
                      if (swipingChatId.current === item.id) swipingChatId.current = null;
                    }}
                    overshootRight={false}
                    rightThreshold={40}
                    friction={2}
                    overshootFriction={8}
                    containerStyle={{ backgroundColor: 'transparent' }}
                  >
                    <GHTouchableOpacity
                      activeOpacity={0.7}
                      onPress={() => {
                        if (swipingChatId.current !== item.id) {
                          closeHistoryModal();
                          selectChat(item);
                        }
                      }}
                    >
                      {rowContent}
                    </GHTouchableOpacity>
                  </Swipeable>
                );
              }}
            />
          )}
      </KeyboardAvoidingView>
    </MinimizableBottomSheet>
  );

  const renderChatsList = () => {
    return (
    <SafeAreaView style={dynamicStyles.container} edges={isSheet ? [] : ['top']}>
      <TapToToggleHeaderView style={dynamicStyles.container}>
      {!isSheet && (
        <AnimatedHeaderContainer>
          <View style={dynamicStyles.header}>
            <AppBackButton />
            <AppHeaderTitle>ChatGD</AppHeaderTitle>
            <View style={{ flexDirection: 'row' }}>
              <TouchableOpacity
                style={dynamicStyles.newChatButton}
                onPress={onRefresh}
                disabled={refreshing}
                accessibilityLabel="Refresh chats"
                accessibilityRole="button"
              >
                <Ionicons
                  name="refresh"
                  size={30}
                  color={refreshing ? "#999" : "#007AFF"}
                />
              </TouchableOpacity>
              <TouchableOpacity
                style={dynamicStyles.newChatButton}
                onPress={() => setShowNewChatModal(true)}
                accessibilityLabel="New chat"
                accessibilityRole="button"
              >
                <Ionicons name="add" size={30} color="#007AFF" />
              </TouchableOpacity>
            </View>
          </View>
        </AnimatedHeaderContainer>
      )}

      {/* Search Box with Chat Types */}
      <View style={dynamicStyles.searchInputContainer}>
        <View style={dynamicStyles.searchInputContainer}>
          <Ionicons name="search" size={20} color="#666" style={dynamicStyles.searchIcon} />
          <TextInput
            {...ANDROID_TEXT_INPUT_PROPS}
            style={dynamicStyles.searchInput}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search chats..."
            placeholderTextColor="#999"
            returnKeyType="search"
            onSubmitEditing={() => Keyboard.dismiss()}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity
              onPress={() => setSearchQuery('')}
              style={dynamicStyles.searchIcon}
              accessibilityLabel="Clear search"
              accessibilityRole="button"
            >
              <Ionicons name="close-circle" size={20} color="#666" />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {loading ? (
        <View style={dynamicStyles.loadingContainer}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={dynamicStyles.loadingText}>Loading chats...</Text>
        </View>
      ) : (
        <FlatList
          data={filteredChats}
          renderItem={renderChatItem}
          keyExtractor={(item, index) => item ? `${item.type}-${item.id}-${index}` : `${index}-${Math.random()}`}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          style={dynamicStyles.chatsList}
          {...scrollRestoresHeaderProps}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ flexGrow: 1 }}
          onTouchStart={() => setShowQuickChatTypes(false)}
          onEndReached={() => {
            if (!searchQuery.trim() && (hasMoreAiChats || hasMoreUserChats)) {
              loadMoreChats();
            }
          }}
          onEndReachedThreshold={0.3}
          ListFooterComponent={
            isLoadingMoreChats ? (
              <ActivityIndicator
                size="small"
                color={colors.primary ?? '#007AFF'}
                style={{ marginVertical: 16 }}
              />
            ) : null
          }
        />
      )}
      </TapToToggleHeaderView>
    </SafeAreaView>
    );
  };

  const renderChatMessages = () => {
    const openStartRawHdr = params.openStartNew;
    const openingComposerFromDeepLink =
      openStartRawHdr === '1' ||
      openStartRawHdr === 'true' ||
      (Array.isArray(openStartRawHdr) && (openStartRawHdr[0] === '1' || openStartRawHdr[0] === 'true'));
    const headerChat =
      selectedChat ?? (openingComposerFromDeepLink ? DEFAULT_CHAT_ASSISTANT : undefined);

    return (
    <SafeAreaView style={dynamicStyles.container} edges={isSheet ? [] : ['top', 'bottom']}>
      <TapToToggleHeaderView style={dynamicStyles.container}>
      {/* Chat Header — hidden in sheet mode; sheet provides its own header.
          Memoized so typewriter setMessages re-renders do not drop Chat History taps. */}
      {!isSheet && (
        <ChatConversationHeader
          title={(() => {
            const hc = headerChat;
            if (hc?.document_context?.name) {
              return `Document: ${truncateFilename(hc.document_context.name)}`;
            }
            if (hc?.bookmark_context?.name) {
              return `Bookmark: ${hc.bookmark_context.name}`;
            }
            if (hc?.workspace?.name) {
              return hc.workspace.name;
            }
            if (hc?.type === 'ai_assistant' && hc?.id === -1) {
              return 'ChatGD';
            }
            return hc?.title || 'Chat';
          })()}
          subtitle={
            headerChat?.type === 'ai_assistant' ? 'Start New' :
            headerChat?.type === 'document_focused' ? 'Document Chat' :
            headerChat?.type === 'bookmark_focused' ? 'Bookmark Chat' :
            headerChat?.type === 'workspace' ? 'Workspace Chat' :
            headerChat?.type === 'user_direct' ? 'Direct Message' : 'Chat'
          }
          shareDisabled={!selectedChat || messages.length === 0}
          onBack={handleConversationHeaderBack}
          onOpenHistory={handleOpenChatHistory}
          onShare={handleHeaderShare}
          onNewChat={handleHeaderNewChat}
          headerStyle={dynamicStyles.chatHeader}
          backButtonStyle={dynamicStyles.backButton}
          headerInfoStyle={dynamicStyles.chatHeaderInfo}
          subtitleStyle={dynamicStyles.chatSubtitle}
          actionButtonStyle={dynamicStyles.searchTypeButton}
        />
      )}

      <View
        style={[
          dynamicStyles.chatContainer,
          {
            paddingBottom: composerBottomInset,
          },
        ]}
      >
        {isEmptyChat ? (
          <View style={dynamicStyles.emptyChatTopSpacer} />
        ) : null}
        {/* ── TOP AREA: messages or loading (hidden in empty state — 60/40 spacers position the input) ── */}
        {!isEmptyChat && (messagesLoading ? (
          <View style={dynamicStyles.loadingContainer}>
            <ActivityIndicator size="large" color="#007AFF" />
            <Text style={dynamicStyles.loadingText}>Loading messages...</Text>
          </View>
        ) : (
          <FlatList
              ref={messagesRef}
              data={flatMessageData}
              extraData={messages}
              {...scrollRestoresHeaderProps}
              accessibilityRole="list"
              accessibilityLabel="Chat messages"
              renderItem={({ item: flatItem }) =>
                flatItem.type === 'header' ? (
                  <View style={dynamicStyles.messageDateSectionHeader}>
                    <Text style={dynamicStyles.messageDateSectionHeaderText}>{flatItem.title}</Text>
                  </View>
                ) : (
                  renderMessageItem({ item: flatItem.message, globalIndex: flatItem.globalIndex })
                )
              }
              keyExtractor={(flatItem) =>
                flatItem.type === 'header' ? `header-${flatItem.title}` : `msg-${flatItem.message.id}`
              }
              style={dynamicStyles.messagesList}
              ListFooterComponent={
                // Typing Indicator for user chats
                selectedChat && (selectedChat.type === 'user_direct' || selectedChat.type === 'workspace') && Object.keys(typingUsers).length > 0 ? (
                  <View style={dynamicStyles.typingIndicator}>
                    <Text style={dynamicStyles.typingText}>
                      {Object.values(typingUsers).join(', ')} {Object.keys(typingUsers).length === 1 ? 'is' : 'are'} typing...
                    </Text>
                  </View>
                ) : null
              }
              contentContainerStyle={dynamicStyles.messagesContent}
              refreshControl={
                <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
              }
              showsVerticalScrollIndicator={false}
              onScrollToIndexFailed={() => {
                // Must NOT call scrollToLastMessage synchronously here – that would create an
                // infinite loop (scrollToLocation → onScrollToIndexFailed → scrollToLocation …).
                // Schedule a single deferred retry instead.
                setTimeout(() => scrollToLastMessage(false), 400);
              }}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
              onTouchStart={() => setShowQuickChatTypes(false)}
              scrollEnabled={true}
              nestedScrollEnabled={true}
              removeClippedSubviews={false}
          />
        ))}

        {/* Selected Mention Display */}
        {selectedMention && (
          <View style={dynamicStyles.mentionDisplay}>
            <View style={dynamicStyles.mentionChip}>
              <Ionicons 
                name={getMentionIcon(selectedMention.type) as keyof typeof Ionicons.glyphMap} 
                size={16} 
                color={getMentionColor(selectedMention.type)} 
              />
              <Text style={dynamicStyles.mentionText}>
                {selectedMention.type === 'file' ? truncateFilename(selectedMention.name) : selectedMention.name}
              </Text>
              {/* User and workspace context are bound to the conversation and cannot be removed */}
              {(selectedMention.type !== 'user' && selectedMention.type !== 'workspace') ? (
                <TouchableOpacity 
                  onPress={(e) => {
                    e.stopPropagation();
                    removeMention();
                  }} 
                  style={dynamicStyles.removeMentionButton}
                >
                  <Ionicons name="close" size={16} color="#666" />
                </TouchableOpacity>
              ) : null}
            </View>
          </View>
        )}

        {/* Chat Types Dropdown */}
        {showQuickChatTypes && selectedChat?.type === 'ai_assistant' && (
          <View style={dynamicStyles.quickChatTypesContainer}>
            {(['ai_assistant', 'workspace', 'user_direct', 'bookmark_focused'] as const).map((type, index, array) => {
              const typeInfo = getChatTypeInfo(type);
              const isLastItem = index === array.length - 1;
              return (
                <TouchableOpacity
                  key={`quick-chat-${type}`}
                  style={[
                    dynamicStyles.quickChatTypeItem,
                    isLastItem && { borderBottomWidth: 0 }
                  ]}
                  onPress={() => createQuickChat(type)}
                >
                  <View style={[dynamicStyles.quickChatTypeIcon, { backgroundColor: `${typeInfo.color}20` }]}>
                    <Ionicons name={typeInfo.icon} size={20} color={typeInfo.color} />
                  </View>
                  <View style={dynamicStyles.quickChatTypeContent}>
                    <Text style={dynamicStyles.quickChatTypeName}>{typeInfo.name}</Text>
                    <Text style={dynamicStyles.quickChatTypeDescription}>{typeInfo.description}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {/* Mention dropdown — absolutely positioned so it never steals focus from the TextInput.
            A Modal would hijack keyboard focus; this approach keeps the TextInput active while
            the dropdown floats above the keyboard using zIndex. */}
        {showMentionModal && (
          <View
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              // Sit just above the input bar. inputContainerHeight is measured live via onLayout
              // so it stays accurate as the TextInput grows (multiline) or shrinks.
              bottom: isSheet
                ? inputContainerHeight
                : keyboardTop != null
                  ? composerKeyboardLift + inputContainerHeight
                  : bottomNavInset + inputContainerHeight,
              // Cap height so the dropdown never fills more than 40% of the visible area
              // above the keyboard — keeps messages and the text input visible at all times.
              maxHeight: keyboardTop != null
                ? Math.min(220, Math.max(80, keyboardTop * 0.4))
                : 220,
              zIndex: 200,
              elevation: 20,
            }}
            pointerEvents="box-none"
          >
            <View style={dynamicStyles.mentionDropdown} pointerEvents="auto">
              {mentionResults.length > 0 ? (
                <>
                  <FlatList
                    data={mentionResults}
                    keyExtractor={(item, index) => `${item.type}-${item.id}-${index}`}
                    {...scrollRestoresHeaderProps}
                    renderItem={({ item }) => (
                      <TouchableOpacity
                        style={dynamicStyles.mentionDropdownItem}
                        onPress={() => selectMention(item)}
                        activeOpacity={0.7}
                      >
                        <View style={[dynamicStyles.mentionDropdownIcon, { backgroundColor: `${getMentionColor(item.type)}20` }]}>
                          <Ionicons 
                            name={getMentionIcon(item.type) as keyof typeof Ionicons.glyphMap} 
                            size={16} 
                            color={getMentionColor(item.type)} 
                          />
                        </View>
                        <View style={dynamicStyles.mentionDropdownContent}>
                          <Text style={dynamicStyles.mentionDropdownTitle}>
                            {item.type === 'file' ? truncateFilename(item.name) : item.name}
                          </Text>
                          <Text style={dynamicStyles.mentionDropdownSubtitle}>{item.subtitle}</Text>
                        </View>
                        <Text style={dynamicStyles.mentionDropdownType}>{item.type}</Text>
                      </TouchableOpacity>
                    )}
                    style={dynamicStyles.mentionDropdownList}
                    showsVerticalScrollIndicator={false}
                    keyboardShouldPersistTaps="always"
                    ListFooterComponent={isMentionSearching ? (
                      <View style={{ paddingVertical: 6, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 6 }}>
                        <ActivityIndicator size="small" color={colors.textSecondary || '#999'} />
                        <Text style={[dynamicStyles.mentionDropdownEmptyText, { fontSize: 11 }]}>Searching more...</Text>
                      </View>
                    ) : null}
                  />
                </>
              ) : isMentionSearching ? (
                <View style={dynamicStyles.mentionDropdownEmpty}>
                  <ActivityIndicator size="small" color={colors.primary || '#007AFF'} />
                </View>
              ) : (
                <View style={dynamicStyles.mentionDropdownEmpty}>
                  <Text style={dynamicStyles.mentionDropdownEmptyText}>
                    {mentionQuery.trim() ? 'No results found' : 'Type to search for files, people, or workspaces'}
                  </Text>
                </View>
              )}
            </View>
          </View>
        )}

        <ChatConnectivityBanner
          visible={offlineBannerVisible}
          text={bannerText}
          tintColor={colors.tint ?? colors.primary ?? '#007AFF'}
          textColor={colors.text}
          borderColor={colors.border}
          style={dynamicStyles.connectivityBanner}
          textStyle={dynamicStyles.connectivityBannerText}
        />

        {askClient ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              marginHorizontal: 12,
              marginBottom: 8,
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderRadius: 10,
              backgroundColor: 'rgba(13, 148, 136, 0.12)',
              gap: 8,
            }}
          >
            <Ionicons name="people-outline" size={16} color="#0D9488" />
            <Text style={{ flex: 1, color: colors.text, fontSize: 13 }} numberOfLines={1}>
              Asking about {truncateAskClientName(askClient.name)}
            </Text>
            <TouchableOpacity onPress={() => setAskClient(null)} hitSlop={8}>
              <Ionicons name="close" size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
        ) : null}

        {(() => {
          const hid =
            selectedChat?.id != null && Number(selectedChat.id) > 0
              ? Number(selectedChat.id)
              : currentChatIdRef.current != null && Number(currentChatIdRef.current) > 0
                ? Number(currentChatIdRef.current)
                : null;
          const itemType =
            selectedChat?.type === 'user_direct'
              ? 'user_chat'
              : selectedChat?.type === 'workspace'
                ? null
                : hid
                  ? 'chat_history'
                  : null;
          if (!itemType || !hid) return null;
          return (
            <View style={{ paddingHorizontal: 12, paddingBottom: 6, alignItems: 'flex-start' }}>
              <ClientsButton
                itemType={itemType}
                itemId={hid}
                compact
                allowCreate
              />
            </View>
          );
        })()}

        {askClient && visibleAskSuggestionChips.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            // Keep chip row intrinsic height — otherwise it stretches between the
            // message list and composer into tall empty bordered cards.
            style={{ flexGrow: 0, flexShrink: 0 }}
            contentContainerStyle={{
              paddingHorizontal: 12,
              paddingBottom: 8,
              gap: 8,
              alignItems: 'center',
              flexGrow: 0,
            }}
          >
            {visibleAskSuggestionChips.map((chip) => (
              <TouchableOpacity
                key={chip}
                onPress={() => setNewMessage(chip)}
                disabled={sendingMessage || connectivitySendDisabled}
                style={{
                  borderRadius: 16,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: '#0D9488',
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  backgroundColor: colors.card,
                  alignSelf: 'center',
                  flexShrink: 0,
                }}
              >
                <Text
                  style={{ color: '#0D9488', fontSize: 12, fontWeight: '600' }}
                  numberOfLines={1}
                >
                  {chip}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        ) : null}

        {/* ── INPUT BAR ── always rendered; styles differ in empty vs conversation state */}
        <View 
          ref={inputContainerRef}
          style={[
            dynamicStyles.inputContainer,
            isEmptyChat && dynamicStyles.inputContainerEmpty,
            {
              zIndex: 10,
            },
          ]}
          onLayout={(event) => {
            const { y, height } = event.nativeEvent.layout;
            setInputContainerY(y);
            setInputContainerHeight((prev) =>
              Math.abs(prev - height) < 2 ? prev : height
            );
          }}
        >
          <ChatComposerInput
            shellStyle={dynamicStyles.messageInputShell}
            inputStyle={dynamicStyles.messageInput}
            value={newMessage}
            onChangeText={handleMentionInput}
            editable={!connectivitySendDisabled}
            onSelectionChange={(e) => {
              const { start } = e.nativeEvent.selection;
              mentionCursorRef.current = start;
              detectMention(newMessageRef.current, start);
            }}
            placeholder={messageInputPlaceholder}
            placeholderTextColor={colors.textSecondary}
            returnKeyType="default"
            maxLength={1000}
          />
          <Animated.View
            style={[
              dynamicStyles.composerSendWrap,
              {
                transform: [{ scale: bounceAnim }],
              },
            ]}
          >
            <TouchableOpacity
              style={[
                dynamicStyles.sendButton,
                ((!newMessage.trim() && !sendingMessage) || connectivitySendDisabled) && { opacity: 0.5 }
              ]}
              onPress={sendingMessage ? stopProcessing : () => void sendMessage()}
              disabled={(!newMessage.trim() && !sendingMessage) || connectivitySendDisabled}
            >
              {sendingMessage ? (
                <Ionicons name="close" size={18} color="#fff" />
              ) : (
                <Ionicons name="arrow-up" size={18} color="#fff" />
              )}
            </TouchableOpacity>
          </Animated.View>
        </View>

        {isEmptyChat ? (
          <View style={dynamicStyles.emptyChatBottomSpacer} />
        ) : null}

      </View>
      </TapToToggleHeaderView>
    </SafeAreaView>
    );
  };
  const renderNewChatModal = () => (
    <Modal
      visible={showNewChatModal}
      animationType="slide"
      presentationStyle="fullScreen"
      statusBarTranslucent={false}
    >
      <View style={[dynamicStyles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={dynamicStyles.header}>
          <TouchableOpacity onPress={() => {
            setShowNewChatModal(false);
            // Reset search states on cancel
            setModalUserSearch('');
            setModalWorkspaceSearch('');
            setModalDocumentSearch('');
            setModalBookmarkSearch('');
          }}>
            <Text style={{ color: '#007AFF', fontSize: 16 }}>Cancel</Text>
          </TouchableOpacity>
          <AppHeaderTitle>New Chat</AppHeaderTitle>
          <TouchableOpacity onPress={createNewChat}>
            <Text style={{ color: '#007AFF', fontSize: 16, fontWeight: '600' }}>Create</Text>
          </TouchableOpacity>
        </View>

              <KeyboardAvoidingView 
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 60 : 20}
      >
          <ScrollView 
            style={{ flex: 1, padding: 16 }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
          >
          {/* Chat Type Selection */}
          <Text style={{ fontSize: 18, fontWeight: '600', marginBottom: 12, color: colors.text }}>Chat Type</Text>
          
          <TouchableOpacity 
            style={[dynamicStyles.optionItem, newChatType === 'ai_assistant' && dynamicStyles.selectedOption]}
            onPress={() => setNewChatType('ai_assistant')}
          >
            <Ionicons name="chatbubbles" size={24} color="#007AFF" />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={dynamicStyles.optionTitle}>Start New</Text>
              <Text style={dynamicStyles.optionSubtitle}>Chat with ChatGD about your documents and meeting transcripts</Text>
            </View>
            {newChatType === 'ai_assistant' && (
              <Ionicons name="checkmark" size={24} color="#007AFF" />
            )}
          </TouchableOpacity>

          <TouchableOpacity 
            style={[dynamicStyles.optionItem, newChatType === 'document_focused' && dynamicStyles.selectedOption]}
            onPress={() => setNewChatType('document_focused')}
          >
            <Ionicons name="document-text" size={24} color="#34C759" />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={dynamicStyles.optionTitle}>Document Focus</Text>
              <Text style={dynamicStyles.optionSubtitle}>Ask questions about a specific document</Text>
            </View>
            {newChatType === 'document_focused' && (
              <Ionicons name="checkmark" size={24} color="#34C759" />
            )}
          </TouchableOpacity>

          <TouchableOpacity 
            style={[dynamicStyles.optionItem, newChatType === 'workspace' && dynamicStyles.selectedOption]}
            onPress={() => setNewChatType('workspace')}
          >
            <Ionicons name="people" size={24} color="#FF9500" />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={dynamicStyles.optionTitle}>Workspace Chat</Text>
              <Text style={dynamicStyles.optionSubtitle}>Message all team members in a workspace</Text>
            </View>
            {newChatType === 'workspace' && (
              <Ionicons name="checkmark" size={24} color="#FF9500" />
            )}
          </TouchableOpacity>

          <TouchableOpacity 
            style={[dynamicStyles.optionItem, newChatType === 'user_direct' && dynamicStyles.selectedOption]}
            onPress={() => setNewChatType('user_direct')}
          >
            <Ionicons name="person" size={24} color="#FF3B30" />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={dynamicStyles.optionTitle}>Direct Message</Text>
              <Text style={dynamicStyles.optionSubtitle}>Send a private message to another user</Text>
            </View>
            {newChatType === 'user_direct' && (
              <Ionicons name="checkmark" size={24} color="#FF3B30" />
            )}
          </TouchableOpacity>

          <TouchableOpacity 
            style={[dynamicStyles.optionItem, newChatType === 'bookmark_focused' && dynamicStyles.selectedOption]}
            onPress={() => setNewChatType('bookmark_focused')}
          >
            <Ionicons name="bookmark" size={24} color="#AF52DE" />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={dynamicStyles.optionTitle}>Bookmark Collection</Text>
              <Text style={dynamicStyles.optionSubtitle}>Chat about a specific bookmark collection</Text>
            </View>
            {newChatType === 'bookmark_focused' && (
              <Ionicons name="checkmark" size={24} color="#AF52DE" />
            )}
          </TouchableOpacity>

          {/* Document Selection for Document-Focused Chat */}
          {newChatType === 'document_focused' && (
            <View style={{ marginTop: 24 }}>
              <Text style={{ fontSize: 18, fontWeight: '600', marginBottom: 12, color: colors.text }}>Select Document</Text>
              
              {/* Search for documents */}
              <View style={dynamicStyles.searchInputContainer}>
                <Ionicons name="search" size={16} color="#666" style={dynamicStyles.searchIcon} />
                <TextInput
                  {...ANDROID_TEXT_INPUT_PROPS}
                  style={[dynamicStyles.searchInput, { fontSize: 14 }]}
                  placeholder="Search documents..."
                  placeholderTextColor="#999"
                  value={modalDocumentSearch}
                  onChangeText={setModalDocumentSearch}
                />
              </View>
              
              <ScrollView style={{ maxHeight: 200, marginTop: 8 }}>
                {modalFilteredDocuments.map((doc) => (
                  <TouchableOpacity
                    key={doc.id}
                    style={[dynamicStyles.optionItem, selectedDocument?.id === doc.id && dynamicStyles.selectedOption]}
                    onPress={() => setSelectedDocument(doc)}
                  >
                    <Ionicons name="document" size={20} color="#666" />
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <Text style={dynamicStyles.optionTitle}>{doc.name}</Text>
                      <Text style={dynamicStyles.optionSubtitle}>{doc.type} • {doc.size}</Text>
                    </View>
                    {selectedDocument?.id === doc.id && (
                      <Ionicons name="checkmark" size={20} color="#34C759" />
                    )}
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}

          {/* Workspace Selection for Workspace Chat */}
          {newChatType === 'workspace' && (
            <View style={{ marginTop: 24 }}>
              <Text style={{ fontSize: 18, fontWeight: '600', marginBottom: 12, color: colors.text }}>Select Workspace</Text>
              
              {/* Search for workspaces */}
              <View style={dynamicStyles.searchInputContainer}>
                <Ionicons name="search" size={16} color="#666" style={dynamicStyles.searchIcon} />
                <TextInput
                  {...ANDROID_TEXT_INPUT_PROPS}
                  style={[dynamicStyles.searchInput, { fontSize: 14 }]}
                  placeholder="Search workspaces..."
                  placeholderTextColor="#999"
                  value={modalWorkspaceSearch}
                  onChangeText={setModalWorkspaceSearch}
                />
              </View>
              
              <View style={{ marginTop: 8 }}>
                {modalFilteredWorkspaces.map((workspace) => (
                  <TouchableOpacity
                    key={workspace.id}
                    style={[dynamicStyles.optionItem, selectedWorkspace?.id === workspace.id && dynamicStyles.selectedOption]}
                    onPress={() => setSelectedWorkspace(workspace)}
                  >
                    <Ionicons name="business" size={20} color="#FF9500" />
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <Text style={dynamicStyles.optionTitle}>{workspace.name}</Text>
                      <Text style={dynamicStyles.optionSubtitle}>{workspace.member_count} members</Text>
                    </View>
                    {selectedWorkspace?.id === workspace.id && (
                      <Ionicons name="checkmark" size={20} color="#FF9500" />
                    )}
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

          {/* User Selection for Direct Message */}
          {newChatType === 'user_direct' && (
            <View style={{ marginTop: 24 }}>
              <Text style={{ fontSize: 18, fontWeight: '600', marginBottom: 12, color: colors.text }}>Select User</Text>
              
              {/* Search for users */}
              <View style={dynamicStyles.searchInputContainer}>
                <Ionicons name="search" size={16} color="#666" style={dynamicStyles.searchIcon} />
                <TextInput
                  {...ANDROID_TEXT_INPUT_PROPS}
                  style={[dynamicStyles.searchInput, { fontSize: 14 }]}
                  placeholder="Search users..."
                  placeholderTextColor="#999"
                  value={modalUserSearch}
                  onChangeText={setModalUserSearch}
                />
              </View>
              
              <View style={{ marginTop: 8 }}>
                {usersLoading ? (
                  <View style={{ padding: 16, alignItems: 'center' }}>
                    <Text style={{ color: '#666', fontStyle: 'italic', textAlign: 'center' }}>
                      Loading users...
                    </Text>
                  </View>
                ) : modalFilteredUsers.length === 0 ? (
                  <View style={{ padding: 16, alignItems: 'center' }}>
                    <Ionicons name="people-outline" size={48} color="#ccc" style={{ marginBottom: 8 }} />
                    <Text style={{ color: '#666', fontStyle: 'italic', textAlign: 'center' }}>
                      {users.length === 0 
                        ? 'No workspace users found.\nMake sure you are part of a workspace to message other users.' 
                        : 'No users match your search'}
                    </Text>
                  </View>
                ) : (
                  modalFilteredUsers.map((user) => (
                    <TouchableOpacity
                      key={user.id}
                      style={[dynamicStyles.optionItem, selectedUser?.id === user.id && dynamicStyles.selectedOption]}
                      onPress={() => setSelectedUser(user)}
                    >
                      <Ionicons name="person-circle" size={20} color="#FF3B30" />
                      <View style={{ flex: 1, marginLeft: 12 }}>
                        <Text style={dynamicStyles.optionTitle}>{user.username}</Text>
                        <Text style={dynamicStyles.optionSubtitle}>{user.email}</Text>
                      </View>
                      {selectedUser?.id === user.id && (
                        <Ionicons name="checkmark" size={20} color="#FF3B30" />
                      )}
                    </TouchableOpacity>
                  ))
                )}
              </View>
            </View>
          )}

          {/* Bookmark Selection for Bookmark-Focused Chat */}
          {newChatType === 'bookmark_focused' && (
            <View style={{ marginTop: 24 }}>
              <Text style={{ fontSize: 18, fontWeight: '600', marginBottom: 12, color: colors.text }}>Select Bookmark Collection</Text>
              
              {/* Search for bookmarks */}
              <View style={dynamicStyles.searchInputContainer}>
                <Ionicons name="search" size={16} color="#666" style={dynamicStyles.searchIcon} />
                <TextInput
                  {...ANDROID_TEXT_INPUT_PROPS}
                  style={[dynamicStyles.searchInput, { fontSize: 14 }]}
                  placeholder="Search bookmarks..."
                  placeholderTextColor="#999"
                  value={modalBookmarkSearch}
                  onChangeText={setModalBookmarkSearch}
                />
              </View>
              
              <ScrollView style={{ maxHeight: 200, marginTop: 8 }}>
                {modalFilteredBookmarks.map((bookmark) => (
                  <TouchableOpacity
                    key={bookmark.id}
                    style={[dynamicStyles.optionItem, selectedBookmark?.id === bookmark.id && dynamicStyles.selectedOption]}
                    onPress={() => setSelectedBookmark(bookmark)}
                  >
                    <Ionicons name="bookmark" size={20} color="#AF52DE" />
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <Text style={dynamicStyles.optionTitle}>{bookmark.name}</Text>
                      <Text style={dynamicStyles.optionSubtitle}>{bookmark.file_count} files • {bookmark.description}</Text>
                    </View>
                    {selectedBookmark?.id === bookmark.id && (
                      <Ionicons name="checkmark" size={20} color="#AF52DE" />
                    )}
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}
        </ScrollView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );

  const handleSearchTypeSelect = (searchType: 'exact' | 'refined' | 'expanded') => {
    setSelectedSearchType(searchType);
    setShowSearchTypeMenu(false);
  };

  const handleSearchTypeMenuPress = () => {
    setShowSearchTypeMenu(!showSearchTypeMenu);
  };

  const dynamicStyles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
      paddingTop: 0,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      backgroundColor: colors.headerBackground,
    },
    headerTitle: {
      fontSize: 20,
      fontWeight: 'bold',
      color: colors.text,
    },
    newChatButton: {
      padding: 8,
      marginTop: 4,
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    loadingText: {
      marginTop: 6,
      color: colors.textSecondary,
    },
    chatsList: {
      flex: 1,
    },
    chatListSectionHeader: {
      paddingHorizontal: 16,
      paddingVertical: 10,
      paddingTop: 16,
      backgroundColor: colors.background,
    },
    chatListSectionHeaderText: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.textSecondary || '#666',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    messageDateSectionHeader: {
      paddingVertical: 12,
      paddingHorizontal: 16,
      alignItems: 'center',
      backgroundColor: colors.background,
    },
    messageDateSectionHeaderText: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.textSecondary || '#666',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    chatItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      backgroundColor: colors.card || '#fff',
    },
    chatAvatar: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: colors.surface,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 10,
    },
    chatContent: {
      flex: 1,
    },
    chatItemHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 3,
    },
    chatTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.text,
      flex: 1,
    },
    chatTime: {
      fontSize: 11,
      color: colors.textSecondary,
    },
    chatFooter: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    lastMessage: {
      fontSize: 14,
      color: colors.textSecondary,
      flex: 1,
    },
    unreadBadge: {
      backgroundColor: '#007AFF',
      borderRadius: 8,
      minWidth: 18,
      height: 18,
      justifyContent: 'center',
      alignItems: 'center',
      marginLeft: 6,
    },
    unreadText: {
      color: '#fff',
      fontSize: 11,
      fontWeight: 'bold',
    },
    chatHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      backgroundColor: colors.headerBackground,
      minHeight: CHAT_CONVERSATION_HEADER_HEIGHT,
      zIndex: 20,
      elevation: 4,
    },
    backButton: {
      padding: 8,
      marginTop: 4,
    },
    chatHeaderInfo: {
      flex: 1,
      justifyContent: 'center',
      minWidth: 0,
    },
    chatSubtitle: {
      fontSize: 11,
      color: colors.textSecondary,
      marginTop: 2,
    },
    searchTypeButton: {
      padding: 8,
      marginTop: 4,
    },
    chatContainer: {
      flex: 1,
      backgroundColor: colors.background,
      position: 'relative', // Ensure absolute positioned children are relative to this
    },
    messagesList: {
      flex: 1,
      zIndex: 0,
    },
    messagesContent: {
      paddingVertical: 2,
      paddingBottom: 16,
    },
    messageContainer: {
      paddingHorizontal: 16,
      paddingVertical: 1, // Minimal vertical padding
      width: '100%',
      flexDirection: 'row',
    },
    messageContainerNoBubble: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      maxWidth: '100%',
      flexShrink: 1,
      flexDirection: 'row',
    },
    ownMessage: {
      justifyContent: 'flex-end',
    },
    otherMessage: {
      justifyContent: 'flex-start',
    },
    ownMessageNoBubble: {
      justifyContent: 'flex-end',
      paddingLeft: 60,
    },
    otherMessageNoBubble: {
      justifyContent: 'flex-start',
      paddingRight: 60,
    },
    messageBubble: {
      maxWidth: '80%',
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 16,
      marginVertical: 0, // Minimal vertical margin
      overflow: 'hidden', // Keep hidden to prevent overflow, but allow text to wrap
      flexShrink: 1,
      // Removed alignSelf - let parent container control alignment
    },
    ownBubble: {
      backgroundColor: '#007AFF',
    },
    otherBubble: {
      backgroundColor: colors.surface,
    },
  messageText: {
    fontSize: 16, // WhatsApp standard size
    lineHeight: 24, // 1.5x line height for better readability
    flexWrap: 'wrap',
    flexShrink: 1,
    wordWrap: 'break-word',
    maxWidth: '100%',
    includeFontPadding: false, // Remove extra padding on Android
    textAlignVertical: 'top', // Align text to top for better multi-line display
  },
    ownMessageText: {
      color: '#fff',
    },
    otherMessageText: {
      color: colors.text,
    },
    previewMessageText: {
      color: '#9ca3af', // Lighter grey to indicate preview / not final response
    },
    messageTime: {
      fontSize: 11,
      marginTop: 1,
      alignSelf: 'flex-end',
    },
    ownMessageTime: {
      color: 'rgba(255, 255, 255, 0.7)',
    },
    otherMessageTime: {
      color: colors.textSecondary,
    },
    messageTimeNoBubble: {
      fontSize: 11,
      marginTop: 4,
      alignSelf: 'flex-start',
    },
    ownMessageTimeNoBubble: {
      color: colors.textSecondary,
    },
  otherMessageTimeNoBubble: {
    color: colors.textSecondary,
  },
  menuActionContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 80,
    height: '100%',
  },
  menuActionButton: {
    backgroundColor: '#666',
    justifyContent: 'center',
    alignItems: 'center',
    width: 80,
    height: '100%',
    paddingHorizontal: 12,
    flexDirection: 'row',
    gap: 4,
  },
  menuActionText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  chatMenuModal: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  chatMenuContent: {
    backgroundColor: colors.card || '#fff',
    borderRadius: 12,
    padding: 8,
    minWidth: 200,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  chatMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
  },
  chatMenuItemText: {
    fontSize: 16,
    color: colors.text || '#000',
    marginLeft: 12,
  },
  chatMenuItemDanger: {
    color: '#FF3B30',
  },
  deleteActionText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 4,
  },
  inputContainer: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      paddingHorizontal: 16,
      paddingVertical: 6,
      borderTopWidth: 0,
      backgroundColor: 'transparent',
      elevation: 0,
      zIndex: 10,
    },
    connectivityBanner: {
      marginHorizontal: 0,
    },
    connectivityBannerText: {
      color: colors.text,
    },
    // Overrides applied to inputContainer when chat is empty (centered state)
    inputContainerEmpty: {
      borderTopWidth: 0,
      borderRadius: 0,
      marginHorizontal: 0,
      shadowOpacity: 0,
      shadowRadius: 0,
      elevation: 0,
    },
    // 60% of empty-state vertical space above the composer
    emptyChatTopSpacer: {
      flex: 3,
    },
    // Flex spacer above the input — holds the welcome graphic and fills the upper half
    emptyChatWelcomeArea: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 32,
      paddingBottom: 16,
    },
    emptyChatTitle: {
      fontSize: 20,
      fontWeight: '600',
      color: colors.text,
      marginTop: 16,
      textAlign: 'center',
    },
    emptyChatSubtitle: {
      fontSize: 14,
      color: colors.textSecondary,
      marginTop: 8,
      textAlign: 'center',
      lineHeight: 20,
    },
    // 40% of empty-state vertical space below the composer
    emptyChatBottomSpacer: {
      flex: 2,
    },
    messageInputShell: {
      flex: 1,
      backgroundColor: colors.surface,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 8,
      paddingVertical: 3,
      overflow: 'hidden',
    },
    messageInput: {
      backgroundColor: 'transparent',
      borderRadius: 0,
      color: colors.text,
      textAlignVertical: 'top',
      includeFontPadding: false,
      ...(Platform.OS === 'android' ? { borderWidth: 0 } : {}),
    },
    composerSendWrap: {
      marginLeft: 6,
    },
    sendButton: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: '#007AFF',
      justifyContent: 'center',
      alignItems: 'center',
    },
    modalOverlay: modalScrimOverlayStyle(colors.isDark, {
      justifyContent: 'center',
      alignItems: 'center',
    }),
    searchTypeMenuContainer: {
      ...floatingDialogSurfaceStyle(colors, colors.isDark, { minWidth: 150 }),
      padding: 8,
    },
    searchTypeMenuItem: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 12,
      paddingHorizontal: 16,
      borderRadius: 8,
    },
    selectedSearchTypeItem: {
      backgroundColor: colors.surface,
    },
    searchTypeText: {
      fontSize: 16,
      color: colors.text,
      fontWeight: '500',
    },
    selectedSearchTypeText: {
      color: '#007AFF',
    },
    // Modal styles
    optionItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderRadius: 8,
      marginBottom: 4,
    },
    selectedOption: {
      backgroundColor: colors.surface,
    },
    optionTitle: {
      fontSize: 14,
      fontWeight: '500',
      color: colors.text,
      marginBottom: 2,
    },
    optionSubtitle: {
      fontSize: 12,
      color: colors.textSecondary,
    },
    searchInputContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: 8,
      paddingHorizontal: 12,
      marginBottom: 12,
    },
    searchInput: {
      flex: 1,
      paddingVertical: 8,
      fontSize: 14,
      color: colors.text,
      backgroundColor: 'transparent',
      ...(Platform.OS === 'android' ? { paddingVertical: 6 } : {}),
    },
    searchIcon: {
      marginRight: 8,
    },
    mentionDisplay: {
      marginBottom: 8,
    },
    mentionChip: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surface,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 16,
      alignSelf: 'flex-start',
    },
    mentionText: {
      fontSize: 12,
      color: colors.text,
      marginLeft: 6,
      marginRight: 6,
    },
    removeMentionButton: {
      padding: 2,
    },
    quickChatTypesContainer: {
      backgroundColor: colors.card,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      paddingVertical: 8,
    },
    quickChatTypeItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    quickChatTypeIcon: {
      marginRight: 12,
    },
    quickChatTypeContent: {
      flex: 1,
    },
    quickChatTypeName: {
      fontSize: 14,
      fontWeight: '500',
      color: colors.text,
    },
    quickChatTypeDescription: {
      fontSize: 12,
      color: colors.textSecondary,
      marginTop: 2,
    },
    mentionDropdown: {
      backgroundColor: colors.card || '#fff',
      borderTopWidth: 1,
      borderTopColor: colors.border || '#e0e0e0',
      borderRadius: 8,
      marginHorizontal: 8,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: -2 },
      shadowOpacity: 0.1,
      shadowRadius: 4,
      elevation: 10, // For Android
    },
    mentionDropdownList: {
      flex: 1,
    },
    mentionDropdownItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    mentionDropdownIcon: {
      marginRight: 12,
    },
    mentionDropdownContent: {
      flex: 1,
    },
    mentionDropdownTitle: {
      fontSize: 14,
      fontWeight: '500',
      color: colors.text,
    },
    mentionDropdownSubtitle: {
      fontSize: 12,
      color: colors.textSecondary,
    },
    mentionDropdownType: {
      fontSize: 10,
      color: colors.textSecondary,
      textTransform: 'uppercase',
    },
    mentionDropdownEmpty: {
      padding: 16,
      alignItems: 'center',
    },
    mentionDropdownEmptyText: {
      fontSize: 14,
      color: colors.textSecondary,
    },
    sendButtonNormal: {
      backgroundColor: '#007AFF',
    },
    sendButtonProcessing: {
      backgroundColor: '#999',
    },
    sendButtonDisabled: {
      backgroundColor: '#ccc',
    },
    typingIndicator: {
      paddingHorizontal: 16,
      paddingVertical: 4,
    },
    typingText: {
      fontSize: 13,
      fontStyle: 'italic',
      color: '#666',
    },
  }), [colors]);

  // Show chat list or individual chat based on selection
  // Render chat menu modal
  const renderChatMenuModal = () => {
    if (!menuChatId) return null;
    
    return (
      <Modal
        visible={menuChatId !== null}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setMenuChatId(null)}
      >
        <TouchableOpacity
          style={dynamicStyles.chatMenuModal}
          activeOpacity={1}
          onPress={() => setMenuChatId(null)}
        >
          <View style={dynamicStyles.chatMenuContent} onStartShouldSetResponder={() => true}>
            <TouchableOpacity
              style={dynamicStyles.chatMenuItem}
              onPress={() => {
                handleToggleFavorite(menuChatId);
              }}
              activeOpacity={0.7}
            >
              <Ionicons 
                name={favoriteChatIds.has(menuChatId) ? "star" : "star-outline"} 
                size={20} 
                color={favoriteChatIds.has(menuChatId) ? "#FFD700" : "#007AFF"} 
              />
              <Text style={dynamicStyles.chatMenuItemText}>
                {favoriteChatIds.has(menuChatId) ? "Remove from Favorite" : "Add to Favorite"}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={dynamicStyles.chatMenuItem}
              onPress={() => {
                setMenuChatId(null);
                chatSwipeableRefs.current.get(menuChatId)?.close();
                historySwipeableRefs.current.get(menuChatId)?.close();
                setTimeout(() => {
                  handleDeleteChat(menuChatId);
                }, 300);
              }}
              activeOpacity={0.7}
            >
              <Ionicons name="trash-outline" size={20} color="#FF3B30" />
              <Text style={[dynamicStyles.chatMenuItemText, dynamicStyles.chatMenuItemDanger]}>Delete</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    );
  };

  // If fileId param is present, show chat messages view immediately (will be set by useEffect).
  // openStartNew: show composer chrome immediately — avoids flashing the ChatGD history list before useLayoutEffect selects the assistant.
  const hasFileIdParam = !!params.fileId;
  const openStartRaw = params.openStartNew;
  const hasOpenStartNewParam =
    openStartRaw === '1' ||
    openStartRaw === 'true' ||
    (Array.isArray(openStartRaw) && (openStartRaw[0] === '1' || openStartRaw[0] === 'true'));
  const shouldShowChatMessages =
    !isGoingBack && (selectedChat || hasFileIdParam || hasOpenStartNewParam);
  
  return (
    <>
      {shouldShowChatMessages ? renderChatMessages() : renderChatsList()}
      {renderNewChatModal()}
      {renderHistoryModal()}
      {renderChatMenuModal()}
      <SermonViewerModal
        visible={sermonModal.visible}
        expandNonce={sermonModal.expandNonce}
        fileId={sermonModal.fileId}
        paragraph={sermonModal.paragraph}
        paragraphEnd={sermonModal.paragraphEnd}
        title={sermonModal.title}
        pdfUri={sermonModal.pdfUri}
        defaultTab={sermonModal.defaultTab}
        onClose={() => setSermonModal((s) => ({ ...s, visible: false }))}
      />
      <GeneralFileViewerModal
        visible={generalFileModal.visible}
        expandNonce={generalFileModal.expandNonce}
        fileId={generalFileModal.fileId}
        title={generalFileModal.title}
        pdfUri={generalFileModal.pdfUri}
        onClose={() => setGeneralFileModal((s) => ({ ...s, visible: false }))}
      />
      <ChartImageModal
        visible={chartModal.visible}
        chartFileId={chartModal.chartFileId}
        title={chartModal.title}
        onClose={() => setChartModal((c) => ({ ...c, visible: false }))}
      />
      <InAppWebViewModal
        visible={webPopup.visible}
        expandNonce={webPopup.expandNonce}
        url={webPopup.url}
        title={webPopup.title}
        onClose={() => setWebPopup((w) => ({ ...w, visible: false }))}
      />
      {/* Search Type Menu Modal */}
      <Modal
        visible={showSearchTypeMenu}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setShowSearchTypeMenu(false)}
      >
        <TouchableOpacity
          style={dynamicStyles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowSearchTypeMenu(false)}
        >
          <View style={dynamicStyles.searchTypeMenuContainer}>
            {(['exact', 'refined', 'expanded'] as const).map((type) => {
              const isSelected = selectedSearchType === type;
              
              return (
                <TouchableOpacity
                  key={type}
                  style={[dynamicStyles.searchTypeMenuItem, isSelected && dynamicStyles.selectedSearchTypeItem]}
                  onPress={() => handleSearchTypeSelect(type)}
                >
                  <Text style={[dynamicStyles.searchTypeText, isSelected && dynamicStyles.selectedSearchTypeText]}>
                    {type.charAt(0).toUpperCase() + type.slice(1)}
                  </Text>
                  {isSelected && (
                    <Ionicons name="checkmark" size={16} color="#007AFF" />
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    paddingTop: 0,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#000',
  },
  newChatButton: {
    padding: 8,
    marginTop: 4,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 6,
    color: '#666',
  },
  chatsList: {
    flex: 1,
  },
  chatListSectionHeader: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    paddingTop: 16,
    backgroundColor: '#f8f9fa',
  },
  chatListSectionHeaderText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#666',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  messageDateSectionHeader: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    backgroundColor: '#f8f9fa',
  },
  messageDateSectionHeaderText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#666',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  chatItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
    backgroundColor: '#fff',
  },
  chatAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#f0f8ff',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
  },
  chatContent: {
    flex: 1,
  },
  chatItemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 3,
  },
  chatTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#000',
    flex: 1,
  },
  chatTime: {
    fontSize: 11,
    color: '#666',
  },
  chatFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  lastMessage: {
    fontSize: 14,
    color: '#666',
    flex: 1,
  },
  unreadBadge: {
    backgroundColor: '#007AFF',
    borderRadius: 8,
    minWidth: 18,
    height: 18,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 6,
  },
  unreadText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: 'bold',
  },
  chatHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
    backgroundColor: '#fff',
    minHeight: 64,
  },
  backButton: {
    padding: 8,
    marginTop: 4,
  },
  chatHeaderInfo: {
    flex: 1,
    justifyContent: 'center',
    minWidth: 0,
  },
  chatHeaderTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#000',
  },
  chatSubtitle: {
    fontSize: 11,
    color: '#666',
    marginTop: 2,
  },
  searchTypeButton: {
    padding: 8,
    marginTop: 4,
  },
  chatContainer: {
    flex: 1,
    backgroundColor: '#f8f9fa',
    position: 'relative',
  },
  messagesList: {
    flex: 1,
    zIndex: 0,
  },
  messagesContent: {
    paddingVertical: 2,
    paddingBottom: 16,
  },
  messageContainer: {
    paddingHorizontal: 12,
    paddingVertical: 1, // Minimal vertical padding
    flexDirection: 'row',
  },
  ownMessage: {
    justifyContent: 'flex-end',
  },
  otherMessage: {
    justifyContent: 'flex-start',
  },
  messageBubble: {
    maxWidth: '80%',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
    marginVertical: 0, // Minimal vertical margin
    overflow: 'hidden', // Keep hidden to prevent overflow, but allow text to wrap
    flexShrink: 1, // Allow bubble to shrink if needed
    // Removed alignSelf - let parent container control alignment
  },
  ownBubble: {
    backgroundColor: '#007AFF',
  },
  otherBubble: {
    backgroundColor: '#f0f0f0',
  },
  messageText: {
    fontSize: 16, // WhatsApp standard size
    lineHeight: 24, // 1.5x line height for better readability
    flexWrap: 'wrap',
    flexShrink: 1,
    wordWrap: 'break-word',
    maxWidth: '100%', // Don't exceed bubble width
    includeFontPadding: false, // Remove extra padding on Android
    textAlignVertical: 'top', // Align text to top for better multi-line display
  },
  ownMessageText: {
    color: '#fff',
  },
  otherMessageText: {
    color: '#000',
  },
  previewMessageText: {
    color: '#9ca3af', // Lighter grey to indicate preview / not final response
  },
  messageTime: {
    fontSize: 11,
    marginTop: 1,
    alignSelf: 'flex-end',
  },
  ownMessageTime: {
    color: 'rgba(255, 255, 255, 0.7)',
  },
  otherMessageTime: {
    color: '#666',
  },
  messageTimeNoBubble: {
    fontSize: 11,
    marginTop: 4,
    alignSelf: 'flex-start',
  },
  ownMessageTimeNoBubble: {
    color: '#666',
  },
  otherMessageTimeNoBubble: {
    color: '#666',
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 16,
    paddingVertical: 8,
    paddingBottom: 4,
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
    backgroundColor: '#fff',
    zIndex: 10,
  },
  messageInput: {
    flex: 1,
    backgroundColor: '#f8f8f8',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    paddingTop: 10,
    fontSize: 16,
    color: '#000',
    marginRight: 8,
    minHeight: CHAT_COMPOSER_MIN_HEIGHT,
    maxHeight: 120,
    textAlignVertical: 'top',
    includeFontPadding: false,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendButtonNormal: {
    backgroundColor: '#007AFF',
  },
  sendButtonProcessing: {
    backgroundColor: '#FF3B30',
  },
  sendButtonDisabled: {
    backgroundColor: '#ccc',
  },
  sendButtonText: {
    color: '#fff',
    fontSize: 16,
  },
  newChatModal: {
    flex: 1,
    backgroundColor: '#fff',
  },
  newChatHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  newChatTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#000',
  },
  closeButton: {
    padding: 8,
  },
  newChatContent: {
    flex: 1,
    padding: 16,
  },
  chatTypeSection: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    marginBottom: 12,
  },
  chatTypeOptions: {
    gap: 8,
  },
  chatTypeOption: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f8f9fa',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  selectedChatTypeOption: {
    borderColor: '#007AFF',
    backgroundColor: '#f0f8ff',
  },
  chatTypeIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  chatTypeContent: {
    flex: 1,
  },
  chatTypeTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
    marginBottom: 2,
  },
  chatTypeDescription: {
    fontSize: 12,
    color: '#666',
  },
  searchInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f8f9fa',
    borderRadius: 8,
    paddingHorizontal: 12,
    marginBottom: 16,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    paddingVertical: 10,
    fontSize: 14,
    color: '#333',
  },
  optionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    marginBottom: 4,
  },
  selectedOption: {
    backgroundColor: '#f0f8ff',
  },
  optionTitle: {
    fontSize: 14,
    fontWeight: '500',
    color: '#333',
    marginBottom: 2,
  },
  optionSubtitle: {
    fontSize: 12,
    color: '#666',
  },
  createButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 16,
  },
  createButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  disabledButton: {
    backgroundColor: '#ccc',
  },
  disabledButtonText: {
    color: '#999',
  },
  // Mention styles
  mentionDisplay: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
  },
  mentionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f0f8ff',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#007AFF',
  },
  mentionText: {
    fontSize: 14,
    color: '#007AFF',
    marginLeft: 8,
    flex: 1,
  },
  removeMentionButton: {
    marginLeft: 8,
    padding: 2,
  },
  mentionDropdown: {
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    maxHeight: 120,
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  mentionDropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  mentionDropdownIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  mentionDropdownContent: {
    flex: 1,
  },
  mentionDropdownTitle: {
    fontSize: 14,
    fontWeight: '500',
    color: '#333',
  },
  mentionDropdownType: {
    fontSize: 12,
    color: '#666',
    fontWeight: '500',
  },
  mentionDropdownList: {
    maxHeight: 120,
  },
  mentionDropdownEmpty: {
    padding: 16,
    alignItems: 'center',
  },
  mentionDropdownEmptyText: {
    fontSize: 14,
    color: '#666',
    fontStyle: 'italic',
  },
  mentionDropdownName: {
    fontSize: 14,
    fontWeight: '500',
    color: '#333',
  },
  mentionDropdownSubtitle: {
    fontSize: 12,
    color: '#666',
    marginTop: 2,
  },
  quickChatTypesContainer: {
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  quickChatTypeItem: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  quickChatTypeIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  quickChatTypeContent: {
    flex: 1,
  },
  quickChatTypeName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
  },
  quickChatTypeDescription: {
    fontSize: 12,
    color: '#666',
  },
});
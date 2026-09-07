// Polyfill for URL in React Native (required for socket.io)
import 'react-native-url-polyfill/auto';

import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AccessibilityInfo,
    ActivityIndicator,
    Alert,
    Dimensions,
    FlatList,
    Keyboard,
    KeyboardAvoidingView,
    Modal,
    Platform,
    RefreshControl,
    SectionList,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Swipeable, RectButton } from 'react-native-gesture-handler';
import Toast from 'react-native-toast-message';
import { io, Socket } from 'socket.io-client';
import ChatConnectivityBanner from '../components/ChatConnectivityBanner';
import ClientsButton from '../components/clients/ClientsButton';
import { API_BASE_URL, STORAGE_KEYS } from '../constants/Config';
import { useLimitError } from '../contexts/LimitErrorContext';
import { useChatConnectivity } from '../hooks/useChatConnectivity';
import { userChatFavoritesStorageKey } from '../services/userScopedCache';
import { useThemeColors } from '../hooks/useThemeColors';
import { apiService as api } from '../services/api';
import { secureStorage } from '../utils/storage';
import { extractLimitErrorData, getErrorResponseData } from '../utils/limitErrorUtils';
import ChatComposerInput from '../components/ChatComposerInput';
import PhoneNumberInput from '../components/PhoneNumberInput';
import { getChatNetworkErrorMessage, isNetworkError } from '../utils/networkErrors';
import { isValidPhoneNumber } from '../utils/phoneUtils';
import { showInviteDeliveryToastMobile } from '../utils/inviteDeliveryFeedback';
import { useAuth } from './context/auth';

import AppBackButton, { APP_BACK_BUTTON_SLOT } from '../components/AppBackButton';
import AppHeaderTitle from '../components/AppHeaderTitle';

interface ChatParticipant {
  id: number;
  username: string;
  email: string;
}

interface Workspace {
  id: number;
  name: string;
  slug: string;
}

interface Chat {
  id: number;
  title: string;
  type: 'user_direct' | 'workspace' | 'direct';
  participants: ChatParticipant[];
  last_message: string;
  updated_at: string;
  created_at: string;
  unread_count?: number;
  workspace?: Workspace;
  invite_pending?: boolean;
  secure_message_invite_id?: number | null;
  invitee_label?: string | null;
  display_name?: string;
}

// Storage key helpers scoped per authenticated user
const ANDROID_TEXT_INPUT_PROPS =
  Platform.OS === 'android' ? { underlineColorAndroid: 'transparent' as const } : {};

interface ChatMessage {
  id: number;
  content: string;
  sender: ChatParticipant | null;
  is_own_message: boolean;
  created_at: string;
  /** Sender user id; used at render so sent messages always show on the right even before profile loads */
  sender_id?: number | null;
}

export default function UserChatScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const { user: authUser } = useAuth();
  const { showLimitError } = useLimitError();
  const {
    offlineBannerVisible,
    bannerText,
    sendDisabled: connectivitySendDisabled,
    confirmSend,
    recordNetworkFailure,
    clearNetworkFailures,
  } = useChatConnectivity();

  const persistFavoriteChats = useCallback(async (ids: Set<number>) => {
    const key = userChatFavoritesStorageKey(authUser?.id);
    if (!key) return;
    await AsyncStorage.setItem(key, JSON.stringify(Array.from(ids)));
  }, [authUser?.id]);

  const USER_CHAT_PAGE_SIZE = 20;

  const [chats, setChats] = useState<Chat[]>([]);
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Pagination for the chat list
  const [chatOffset, setChatOffset] = useState(0);
  const [hasMoreChats, setHasMoreChats] = useState(false);
  const [isLoadingMoreChats, setIsLoadingMoreChats] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [userProfile, setUserProfile] = useState<any>(null);
  const currentUserIdRef = useRef<string | number | null>(null);
  currentUserIdRef.current = authUser?.id ?? userProfile?.id ?? null;
  const [searchQuery, setSearchQuery] = useState('');
  const [users, setUsers] = useState<ChatParticipant[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [isNewChat, setIsNewChat] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [invitePhone, setInvitePhone] = useState('');
  const [inviteSmsConsent, setInviteSmsConsent] = useState(false);
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [showMentionResults, setShowMentionResults] = useState(false);
  const [mentionResults, setMentionResults] = useState<any[]>([]);
  const [selectedRecipient, setSelectedRecipient] = useState<{ type: 'user' | 'workspace'; data: any } | null>(null);
  const messageInputRef = useRef<TextInput>(null);
  
  // Keyboard tracking for Android
  const [keyboardTop, setKeyboardTop] = useState<number | null>(null);
  const inputContainerRef = useRef<View>(null);

  // Swipe and menu state
  const [favoriteChatIds, setFavoriteChatIds] = useState<Set<number>>(new Set());
  const [menuChatId, setMenuChatId] = useState<number | null>(null);
  const swipingChatId = useRef<number | null>(null);
  const chatSwipeableRefs = useRef<Map<number, Swipeable>>(new Map());

  // Socket connection
  const socketRef = useRef<Socket | null>(null);
  const messagesListRef = useRef<SectionList>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [otherUserOnline, setOtherUserOnline] = useState(false);
  const [typingUsers, setTypingUsers] = useState<{ [userId: number]: string }>({}); // userId -> username

  // Track keyboard so we can push input above it and scroll to last message when it opens
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const keyboardShowListener = Keyboard.addListener(showEvent, (e) => {
      setKeyboardTop(e.endCoordinates.screenY);
    });
    const keyboardHideListener = Keyboard.addListener(hideEvent, () => {
      setKeyboardTop(null);
    });
    return () => {
      keyboardShowListener.remove();
      keyboardHideListener.remove();
    };
  }, []);

  // Initialize socket connection
  useEffect(() => {
    initializeSocket();
    return () => {
      // Clean up typing timeout
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      // Disconnect socket
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, []);

  // Join user room when socket is connected and userProfile is available
  useEffect(() => {
    if (socketRef.current && isConnected && userProfile?.id) {
      socketRef.current.emit('join_user_room', { user_id: userProfile.id });
    }
  }, [isConnected, userProfile?.id]);

  // Join chat room when chat is selected
  useEffect(() => {
    if (selectedChat && socketRef.current && !isNewChat && isConnected) {
      // Leave previous room
      socketRef.current.emit('leave_chat_room', { chat_id: selectedChat.id });
      // Reset online status when leaving
      setOtherUserOnline(false);
      socketRef.current.emit('join_chat_room', { chat_id: selectedChat.id });
      // Request participant online status
      socketRef.current.emit('get_chat_participants_status', { chatId: selectedChat.id });
    } else {
      setOtherUserOnline(false);
    }
  }, [selectedChat, isNewChat, isConnected]);

  // Load users and workspaces for @ mention
  useEffect(() => {
    if (isNewChat) {
      loadMentionResults('');
    }
  }, [isNewChat]);

  // Handle @ mention in message input
  useEffect(() => {
    if (isNewChat && newMessage) {
      const lastAtIndex = newMessage.lastIndexOf('@');
      if (lastAtIndex !== -1) {
        const afterAt = newMessage.substring(lastAtIndex + 1);
        const spaceIndex = afterAt.indexOf(' ');
        if (spaceIndex === -1) {
          // Still typing after @
          const query = afterAt.toLowerCase();
          setMentionQuery(query);
          setShowMentionResults(true);
          loadMentionResults(query);
        } else {
          setShowMentionResults(false);
        }
      } else {
        setShowMentionResults(false);
      }
    } else {
      setShowMentionResults(false);
    }
  }, [newMessage, isNewChat]);

  const initializeSocket = async () => {
    try {
      const token = await secureStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
      if (!token) return;

      const socket = io(API_BASE_URL, {
        auth: { token },
        transports: ['polling', 'websocket'], // Allow polling fallback for development
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: 5,
        timeout: 20000,
        // Explicitly use default namespace to match backend
        path: '/socket.io/',
      });


      socket.on('connect', () => {
        setIsConnected(true);
        
        // Join user room first (required for receiving messages)
        // Use state setter to get latest userProfile
        setUserProfile(currentProfile => {
          if (currentProfile?.id) {
            socket.emit('join_user_room', { user_id: currentProfile.id });
          }
          return currentProfile;
        });
        
        // Use state setter to get latest selectedChat
        setSelectedChat(currentChat => {
          // Rejoin chat room if we have a selected chat
          if (currentChat && !isNewChat) {
            socket.emit('join_chat_room', { chat_id: currentChat.id });
          }
          return currentChat;
        });
      });

      socket.on('disconnect', () => {
        setIsConnected(false);
      });

      socket.on('new_chat_message', (data: any) => {
        // Always update chat list first
        setChats(prev => prev.map(chat => 
          chat.id === data.chat_id 
            ? { ...chat, last_message: data.message.content.substring(0, 50), updated_at: data.message.created_at }
            : chat
        ));
        
        // Use state setters with function form to access latest values
        setSelectedChat(currentChat => {
          setUserProfile(currentProfile => {
            // Only add to messages if this is the currently selected chat
            if (data.chat_id === currentChat?.id) {
              const senderId = data.message.sender_id != null ? data.message.sender_id : null;
              const userId = currentUserIdRef.current ?? currentProfile?.id;
              const isOwnMessage = !!(userId != null && senderId != null && (String(senderId) === String(userId) || Number(senderId) === Number(userId)));
              const newMsg: ChatMessage = {
                id: data.message.id,
                content: data.message.content,
                sender: data.message.sender,
                is_own_message: isOwnMessage,
                sender_id: senderId,
                created_at: data.message.created_at,
              };
              
              // Prevent duplicates and update existing messages with correct ownership
              setMessages(prev => {
                const existingIndex = prev.findIndex(msg => msg.id === newMsg.id);
                if (existingIndex !== -1) {
                  // Message exists - update it if ownership changed
                  const existing = prev[existingIndex];
                  if (existing.is_own_message !== newMsg.is_own_message) {
                    const updated = [...prev];
                    updated[existingIndex] = newMsg;
                    return updated;
                  }
                  return prev;
                }
                return [...prev, newMsg];
              });
              if (!isOwnMessage) {
                const senderName = newMsg.sender?.username || data.message.sender?.username || 'Someone';
                AccessibilityInfo.announceForAccessibilityWithOptions(`New message from ${senderName}`, { queue: true });
              }
              scrollToBottom();
              
              // If message is from another user, they're definitely online
              if (!isOwnMessage) {
                setOtherUserOnline(true);
              }
            }
            return currentProfile;
          });
          return currentChat;
        });
      });

      socket.on('chat_typing', (data: any) => {
        // Use state setter with function form to access latest selectedChat
        setSelectedChat(currentChat => {
          if (data.chat_id === currentChat?.id && data.user_id !== userProfile?.id) {
            // If user is typing, they're definitely online
            setOtherUserOnline(true);
            
            // Update typing users
            if (data.is_typing) {
              // Try to get username from multiple sources (same as web)
              let displayName: string | null = null;
              
              // 1. Check participants first
              const participant = currentChat?.participants?.find((p: any) => 
                p.id === data.user_id || p.user_id === data.user_id
              );
              
              if (participant) {
                const user = participant.user || participant;
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
          return currentChat;
        });
      });

      // Listen for user online/offline events
      socket.on('user_online', (data: any) => {
        if (selectedChat && data.chat_id === selectedChat.id && data.user_id !== userProfile?.id) {
          setOtherUserOnline(true);
        }
      });

      socket.on('user_offline', (data: any) => {
        if (selectedChat && data.chat_id === selectedChat.id && data.user_id !== userProfile?.id) {
          setOtherUserOnline(false);
        }
      });

      // Listen for participant online status when joining chat
      socket.on('chat_participants_status', (data: any) => {
        if (selectedChat && data.chat_id === selectedChat.id) {
          // Check if any other participant is online
          const hasOnlineParticipant = data.participants?.some((p: any) => 
            p.user_id !== userProfile?.id && p.is_online
          );
          setOtherUserOnline(hasOnlineParticipant || false);
        }
      });

      socket.on('error', (error: any) => {
        console.error('Socket error:', error);
        // Don't fail the app if socket fails - chat will still work without real-time updates
      });

      socket.on('connect_error', (error: any) => {
        console.warn('Socket connection error (chat will work without real-time updates):', error.message);
        // Gracefully handle connection errors - chat still works via polling
      });

      socketRef.current = socket;
      
    } catch (error) {
      console.warn('Failed to initialize socket (chat will work without real-time updates):', error);
      // Don't throw - allow chat to work without WebSocket
    }
  };

  const scrollToBottomTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const scrollToBottom = (animated = true) => {
    scrollToBottomTimersRef.current.forEach(t => clearTimeout(t));
    scrollToBottomTimersRef.current = [];
    const attempt = () => {
      const list = messagesListRef.current;
      if (!list) return;
      const scrollResponder = (list as any).getScrollResponder?.();
      if (scrollResponder?.scrollToEnd) {
        scrollResponder.scrollToEnd({ animated });
      }
    };
    scrollToBottomTimersRef.current.push(setTimeout(attempt, 50));
    scrollToBottomTimersRef.current.push(setTimeout(attempt, 250));
    scrollToBottomTimersRef.current.push(setTimeout(attempt, 600));
  };

  useEffect(() => {
    loadUserProfile();
    loadChats();
    loadWorkspaces();
    loadFavorites();
  }, [authUser?.id]);

  // Load favorites from storage
  const loadFavorites = async () => {
    try {
      const key = userChatFavoritesStorageKey(authUser?.id);
      if (!key) {
        setFavoriteChatIds(new Set());
        return;
      }
      const stored = await AsyncStorage.getItem(key);
      if (stored) {
        const favoriteIds = JSON.parse(stored);
        setFavoriteChatIds(new Set(favoriteIds));
      }
    } catch (error) {
      console.error('Failed to load favorites:', error);
    }
  };

  // Sort chats to show favorites first
  const sortedChats = useMemo(() => {
    const favoriteChats = chats.filter(chat => favoriteChatIds.has(chat.id));
    const otherChats = chats.filter(chat => !favoriteChatIds.has(chat.id));
    
    // Sort each group by updated_at (most recent first). Naive UTC ISO → treat as UTC.
    const activityTs = (raw?: string) => {
      if (!raw) return 0;
      const s = String(raw).trim();
      const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
      const t = Date.parse(hasTz ? s : `${s}Z`);
      return Number.isFinite(t) ? t : 0;
    };
    const sortByDate = (a: Chat, b: Chat) => activityTs(b.updated_at) - activityTs(a.updated_at);
    
    return [...favoriteChats.sort(sortByDate), ...otherChats.sort(sortByDate)];
  }, [chats, favoriteChatIds]);

  // Handle route params to open specific chat (e.g., from workspace screen)
  useEffect(() => {
    if (!params.chatId && !params.workspaceId) {
      return; // No params to handle
    }

    const handleRouteParams = async () => {
      // If chatId is provided, find and select it (or create minimal chat and load messages)
      if (params.chatId) {
        const chatId = parseInt(params.chatId as string);
        const chat = chats.find(c => c.id === chatId);
        
        if (chat) {
          setSelectedChat(chat);
          loadMessages(chatId);
          router.setParams({});
          return;
        }
        // Chat not in list (e.g. opened via context before list refreshed): still load existing conversation
        const chatType = (params.chatType === 'workspace' ? 'workspace' : 'user_direct') as 'user_direct' | 'workspace';
        const workspaceName = (params.workspaceName as string) || 'Chat';
        const minimalChat: Chat = {
          id: chatId,
          title: chatType === 'workspace' ? `#${workspaceName}` : 'Chat',
          type: chatType,
          participants: [],
          last_message: '',
          updated_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          unread_count: 0,
          workspace: params.workspaceId && params.workspaceName
            ? { id: parseInt(params.workspaceId as string), name: params.workspaceName as string, slug: '' }
            : undefined,
        };
        setSelectedChat(minimalChat);
        setIsNewChat(false);
        loadMessages(chatId);
        router.setParams({});
        return;
      }
      
      // If workspace params exist, start/find the workspace chat
      if (params.workspaceId && params.workspaceName) {
        const workspaceId = parseInt(params.workspaceId as string);
        const workspaceName = params.workspaceName as string;
        
        try {
          const response = await api.startUserChat({
            type: 'workspace',
            workspace_id: workspaceId
          });
          
          if (response.success && (response as any).chat) {
            const chatData = (response as any).chat;
            
            // Format title as #{workspace.name} like web version
            const title = chatData.display_name?.startsWith('#') 
              ? chatData.display_name 
              : `#${workspaceName}`;
            
            const newChat: Chat = {
              id: chatData.id,
              title: title,
              type: 'workspace' as const,
              participants: chatData.participants || [],
              last_message: chatData.latest_message?.content || 'No messages yet',
              updated_at: chatData.last_message_at || new Date().toISOString(),
              created_at: chatData.created_at || new Date().toISOString(),
              unread_count: chatData.unread_count || 0,
              workspace: chatData.workspace_id ? { 
                id: chatData.workspace_id, 
                name: workspaceName, 
                slug: chatData.workspace?.slug || '' 
              } : undefined,
            };
            
            // Add to chats list if not already there
            setChats(prev => {
              const exists = prev.find(c => c.id === newChat.id);
              if (exists) {
                return prev;
              }
              return [newChat, ...prev];
            });
            
            setSelectedChat(newChat);
            loadMessages(chatData.id);
          }
        } catch (error: any) {
          console.error('Error starting workspace chat:', error);
          Alert.alert('Error', error.message || 'Failed to start workspace chat');
        } finally {
          // Clear params
          router.setParams({});
        }
      }
    };

    // Run immediately: for chatId we can load messages even if chat isn't in list (minimal chat + loadMessages)
    handleRouteParams();
  }, [params.chatId, params.chatType, params.workspaceId, params.workspaceName, chats.length]);

  const loadUserProfile = async () => {
    try {
      const response = await api.getUserProfile();
      
      // Extract user data from response - could be response.data or response.data.data
      const userData = response.data || response;
      if (userData) {
        setUserProfile(userData);
      }
    } catch (error) {
      console.error('Failed to load user profile:', error);
    }
  };

  const rawChatToChat = (chat: any): Chat => {
    let title = chat.display_name || 'Untitled Chat';
    if (chat.type === 'workspace' && chat.workspace) {
      title = `#${chat.workspace.name}`;
    } else if (chat.type === 'workspace' && chat.display_name && !chat.display_name.startsWith('#')) {
      title = `#${chat.display_name}`;
    }
    return {
      id: chat.id,
      title,
      type: chat.type === 'direct' ? 'user_direct' as const : 'workspace' as const,
      participants: chat.participants || [],
      last_message: chat.latest_message?.content || 'No messages yet',
      updated_at: chat.last_message_at || new Date().toISOString(),
      created_at: chat.created_at || new Date().toISOString(),
      unread_count: chat.unread_count || 0,
      workspace: chat.workspace_id ? {
        id: chat.workspace_id,
        name: chat.workspace?.name || chat.display_name?.replace(/^#/, '') || 'Workspace',
        slug: chat.workspace?.slug || ''
      } : undefined,
      invite_pending: !!chat.invite_pending,
      secure_message_invite_id: chat.secure_message_invite_id ?? null,
      invitee_label: chat.invitee_label ?? null,
      display_name: chat.display_name,
    };
  };

  const loadChats = async () => {
    try {
      setLoading(true);
      const response = await api.getChats(USER_CHAT_PAGE_SIZE, 0);
      if (response.success && (response as any).chats) {
        const rawChats = (response as any).chats as any[];
        setChats(rawChats.map(rawChatToChat));
        setHasMoreChats((response as any).pagination?.has_more ?? false);
        setChatOffset(USER_CHAT_PAGE_SIZE);
        // Merge server favorites so web favorites show on mobile
        setFavoriteChatIds(prev => {
          const next = new Set(prev);
          rawChats.forEach((c: any) => {
            if (c.is_favorite) next.add(Number(c.id));
          });
          persistFavoriteChats(next);
          return next;
        });
      }
    } catch (error) {
      console.error('Failed to load chats:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const loadMoreChats = async () => {
    if (isLoadingMoreChats || !hasMoreChats) return;
    setIsLoadingMoreChats(true);
    try {
      const response = await api.getChats(USER_CHAT_PAGE_SIZE, chatOffset);
      if (response.success && (response as any).chats) {
        const rawChats = (response as any).chats as any[];
        const newChats = rawChats.map(rawChatToChat);
        setChats(prev => {
          const existing = new Set(prev.map(c => c.id));
          return [...prev, ...newChats.filter(c => !existing.has(c.id))];
        });
        setHasMoreChats((response as any).pagination?.has_more ?? false);
        setChatOffset(prev => prev + USER_CHAT_PAGE_SIZE);
        setFavoriteChatIds(prev => {
          const next = new Set(prev);
          rawChats.forEach((c: any) => {
            if (c.is_favorite) next.add(Number(c.id));
          });
          persistFavoriteChats(next);
          return next;
        });
      }
    } catch (error) {
      console.error('loadMoreChats failed:', error);
    } finally {
      setIsLoadingMoreChats(false);
    }
  };

  const loadMentionResults = async (query: string) => {
    try {
      const response = await api.searchUsersForChat(query);
      if (response.success) {
        const results: any[] = [];
        const myId = currentUserIdRef.current;
        // Add users (exclude self — cannot start a chat with yourself)
        if ((response as any).users) {
          (response as any).users.forEach((user: any) => {
            if (myId != null && String(user.id) === String(myId)) return;
            results.push({ type: 'user', data: user });
          });
        }
        // Add workspaces
        if ((response as any).workspaces) {
          (response as any).workspaces.forEach((workspace: any) => {
            results.push({ type: 'workspace', data: workspace });
          });
        }
        setMentionResults(results);
      }
    } catch (error) {
      console.error('Failed to load mention results:', error);
    }
  };

  const loadWorkspaces = async () => {
    try {
      const response = await (api as any).getMobileWorkspaces();
      if (response.success && response.data) {
        const workspacesData = Array.isArray(response.data) ? response.data : (response.data.workspaces || []);
        setWorkspaces(workspacesData);
      }
    } catch (error) {
      console.error('Failed to load workspaces:', error);
    }
  };

  const loadMessages = async (chatId: number) => {
    try {
      setMessagesLoading(true);
      
      // Ensure userProfile is loaded before determining message ownership
      if (!userProfile) {
        await loadUserProfile();
      }
      
      const response = await api.getChatMessages(chatId);
      if (response.success && (response as any).messages) {
        // Use auth user id first (available immediately) so sent messages are always on the right on first open
        const userId = currentUserIdRef.current ?? userProfile?.id;
        const convertedMessages: ChatMessage[] = (response as any).messages.map((msg: any) => {
          const senderId = msg.sender_id != null ? msg.sender_id : null;
          const isOwn = !!(userId != null && senderId != null && (Number(senderId) === Number(userId) || String(senderId) === String(userId)));
          return {
            id: msg.id,
            content: msg.content || '',
            sender: msg.sender || null,
            is_own_message: isOwn,
            sender_id: senderId,
            created_at: msg.created_at || new Date().toISOString(),
          };
        });
        setMessages(convertedMessages);
      } else {
        console.warn(`⚠️ No messages found for chat ${chatId}`);
        setMessages([]);
      }
    } catch (error: any) {
      console.error(`❌ Failed to load messages for chat ${chatId}:`, error.message || error);
      // If chat doesn't exist, clear messages, refresh chat list, and navigate back
      if (error.message?.includes('Chat not found') || 
          error.message?.includes('404') || 
          error.message?.includes('not found') ||
          error.response?.status === 404) {
        console.warn(`⚠️ Chat ${chatId} not found, refreshing chat list and clearing selection`);
        setMessages([]);
        setSelectedChat(null);
        setIsNewChat(false);
        // Refresh the chat list to remove stale chat IDs
        loadChats();
        // Show user-friendly message
        Alert.alert('Chat Not Found', 'This chat may have been deleted or you no longer have access to it.');
      } else {
        // Show error for other cases
        Alert.alert('Error', error.message || 'Failed to load messages. Please try again.');
      }
    } finally {
      setMessagesLoading(false);
    }
  };

  const handleChatPress = (chat: Chat) => {
    setSelectedChat(chat);
    setIsNewChat(false);
    setSelectedRecipient(null);
    loadMessages(chat.id);
  };

  const handleNewChat = () => {
    setIsNewChat(true);
    setSelectedChat(null);
    setMessages([]);
    setNewMessage('');
    setSelectedRecipient(null);
    setShowMentionResults(false);
    setTimeout(() => {
      messageInputRef.current?.focus();
    }, 100);
  };

  const handleInviteSubmit = async () => {
    const em = inviteEmail.trim();
    const ph = invitePhone.trim();
    if (!em && !ph) {
      Alert.alert('Invite', 'Enter an email or phone number');
      return;
    }
    if (ph && !isValidPhoneNumber(ph)) {
      Alert.alert('Invite', 'Enter a valid phone number');
      return;
    }
    if (ph && !inviteSmsConsent) {
      Alert.alert('Invite', 'Confirm you have permission to text this number');
      return;
    }
    setInviteSubmitting(true);
    try {
      const res = await api.inviteSecureMessage({
        email: em || undefined,
        phone: ph || undefined,
        smsConsent: ph ? inviteSmsConsent : false,
      });
      if (res.success) {
        showInviteDeliveryToastMobile(res as any, Toast);
        setShowInviteModal(false);
        setInviteEmail('');
        setInvitePhone('');
        setInviteSmsConsent(false);
        if ((res as any).chat) {
          setSelectedChat((res as any).chat);
          setIsNewChat(false);
        }
        loadChats();
      } else {
        Alert.alert('Invite', (res as any).error || 'Failed to send invite');
      }
    } catch (e: any) {
      Alert.alert('Invite', e?.message || 'Failed to send invite');
    } finally {
      setInviteSubmitting(false);
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.getSecureMessageInvitesPendingForMe();
        const list = (res as any)?.invitations || [];
        if (list.length > 0) {
          Alert.alert(
            'Secure Messaging invitation',
            `${list[0].inviter_display_name} invited you to securely message them.`,
            [
              { text: 'Later', style: 'cancel' },
              {
                text: 'Accept',
                onPress: async () => {
                  try {
                    const acc = await api.acceptSecureMessageInvite({ invitation_id: list[0].id });
                    if (acc.success && (acc as any).chat?.id) {
                      Toast.show({ type: 'success', text1: 'Invitation accepted' });
                      setSelectedChat((acc as any).chat);
                      loadChats();
                    }
                  } catch (err: any) {
                    Alert.alert('Error', err?.message || 'Could not accept');
                  }
                },
              },
            ],
          );
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);

  const handleSelectRecipient = (recipient: { type: 'user' | 'workspace'; data: any }) => {
    if (recipient.type === 'user') {
      const myId = currentUserIdRef.current;
      if (myId != null && String(recipient.data?.id) === String(myId)) {
        return;
      }
    }
    setSelectedRecipient(recipient);
    setShowMentionResults(false);
    // Remove @ mention from message
    const lastAtIndex = newMessage.lastIndexOf('@');
    if (lastAtIndex !== -1) {
      setNewMessage(newMessage.substring(0, lastAtIndex));
    }
  };

  const handleStartChat = async () => {
    if (!selectedRecipient) {
      Alert.alert('Error', 'Please select a user or workspace by typing @ and selecting from the list');
      return;
    }
    if (selectedRecipient.type === 'user') {
      const myId = currentUserIdRef.current;
      if (myId != null && String(selectedRecipient.data?.id) === String(myId)) {
        Alert.alert('Error', 'You cannot start a chat with yourself');
        return;
      }
    }

    try {
      const response = await api.startUserChat({
        type: selectedRecipient.type === 'user' ? 'direct' : 'workspace',
        user_id: selectedRecipient.type === 'user' ? selectedRecipient.data.id : undefined,
        workspace_id: selectedRecipient.type === 'workspace' ? selectedRecipient.data.id : undefined,
      });

      if (response.success && (response as any).chat) {
        const newChat: Chat = {
          id: (response as any).chat.id,
          title: (response as any).chat.display_name || (selectedRecipient.type === 'user' ? (selectedRecipient.data.first_name || selectedRecipient.data.username || 'User') : selectedRecipient.data.name || 'Workspace Chat'),
          type: selectedRecipient.type === 'user' ? 'user_direct' : 'workspace',
          participants: (response as any).chat.participants || [],
          last_message: 'Send a secure message',
          updated_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          unread_count: 0,
          workspace: selectedRecipient.type === 'workspace' ? selectedRecipient.data : undefined,
        };
        
        setChats(prev => [newChat, ...prev]);
        setIsNewChat(false);
        setSelectedChat(newChat);
        setSelectedRecipient(null);
        setNewMessage('');
        loadMessages(newChat.id);
      }
    } catch (error) {
      console.error('Failed to create chat:', error);
      Alert.alert('Error', 'Failed to create chat');
    }
  };

  const handleSendMessage = async () => {
    console.log('📤 [USER-CHAT] ===== handleSendMessage CALLED =====');
    console.log('📤 [USER-CHAT] isNewChat:', isNewChat);
    console.log('📤 [USER-CHAT] selectedRecipient:', selectedRecipient);
    console.log('📤 [USER-CHAT] selectedChat:', selectedChat);
    console.log('📤 [USER-CHAT] newMessage:', newMessage);

    if (selectedChat?.invite_pending) {
      Alert.alert('Invite pending', 'They must accept the invitation before you can send messages.');
      return;
    }
    
    // If in new chat mode and no recipient selected, try to start chat
    if (isNewChat && !selectedRecipient) {
      console.log('⚠️ [USER-CHAT] Cannot send - new chat but no recipient selected');
      Alert.alert('Select Recipient', 'Type @ and select a user or workspace to start the chat');
      return;
    }

    // If in new chat mode with recipient, start the chat first
    if (isNewChat && selectedRecipient) {
      console.log('📤 [USER-CHAT] Starting new chat first, then sending message');
      await handleStartChat();
      // After chat is created, send the message if there's one
      if (newMessage.trim()) {
        // Wait a bit for chat to be created, then send
        setTimeout(async () => {
          const chat = chats.find(c => 
            (selectedRecipient.type === 'user' && c.type === 'user_direct') ||
            (selectedRecipient.type === 'workspace' && c.type === 'workspace')
          );
          if (chat) {
            await sendMessageToChat(chat.id, newMessage.trim());
            setNewMessage('');
          }
        }, 500);
      }
      return;
    }

    // Normal message sending
    if (!selectedChat || !newMessage.trim()) {
      console.log('⚠️ [USER-CHAT] Cannot send - missing chat or empty message:', {
        hasSelectedChat: !!selectedChat,
        hasMessage: !!newMessage.trim(),
        messageLength: newMessage.trim().length
      });
      return;
    }
    console.log('📤 [USER-CHAT] Proceeding with normal message send');
    await sendMessageToChat(selectedChat.id, newMessage.trim());
  };

  const sendMessageToChat = async (chatId: number, messageText: string) => {
    const canProceed = await confirmSend();
    if (!canProceed) return;

    console.log('📤 [USER-CHAT] ===== SENDING MESSAGE =====');
    console.log('📤 [USER-CHAT] Chat ID:', chatId);
    console.log('📤 [USER-CHAT] Message text:', messageText);
    console.log('📤 [USER-CHAT] User ID:', userProfile?.id);
    console.log('📤 [USER-CHAT] User profile:', userProfile);
    
    setSendingMessage(true);

    // Emit typing stopped
    if (socketRef.current && userProfile?.id) {
      console.log('📤 [USER-CHAT] Emitting typing stopped event');
      socketRef.current.emit('user_typing', { 
        chat_id: chatId,
        user_id: userProfile.id,
        is_typing: false
      });
    }

    try {
      console.log('📤 [USER-CHAT] Calling API to send message...');
      const response = await api.sendChatMessageToChat(messageText, chatId);
      console.log('📤 [USER-CHAT] API response received:', {
        success: response.success,
        hasMessage: !!(response as any).message,
        messageId: (response as any).message?.id,
        messageContent: (response as any).message?.content,
        senderId: (response as any).message?.sender_id
      });
      
      if (response.success && (response as any).message) {
        const newMsg = (response as any).message;
        const userId = currentUserIdRef.current ?? userProfile?.id;
        const isOwnMessage = !!(userId != null && newMsg.sender_id != null && (Number(newMsg.sender_id) === Number(userId) || String(newMsg.sender_id) === String(userId)));
        const messageObj: ChatMessage = {
          id: newMsg.id,
          content: newMsg.content,
          sender: newMsg.sender,
          is_own_message: isOwnMessage,
          sender_id: newMsg.sender_id ?? (userId != null ? Number(userId) : undefined),
          created_at: newMsg.created_at || new Date().toISOString()
        };
        
        // Add message locally (socket will also broadcast it, but we prevent duplicates)
        setMessages(prev => {
          const messageExists = prev.some(msg => msg.id === messageObj.id);
          if (messageExists) {
            console.log('⚠️ Message already exists, skipping duplicate:', messageObj.id);
            return prev;
          }
          return [...prev, messageObj];
        });
        AccessibilityInfo.announceForAccessibility('Message sent');
        scrollToBottom();
        
        setChats(prev => prev.map(chat => 
          chat.id === chatId 
            ? { ...chat, last_message: newMsg.content.substring(0, 50), updated_at: newMsg.created_at || new Date().toISOString() }
            : chat
        ));
        clearNetworkFailures();
      }
      setNewMessage('');
      console.log('📤 [USER-CHAT] Message sent successfully, cleared input');
    } catch (error: any) {
      const limitData = extractLimitErrorData(getErrorResponseData(error));
      if (limitData) {
        showLimitError(limitData);
        return;
      }
      if (isNetworkError(error)) {
        recordNetworkFailure();
      }
      console.error('❌ [USER-CHAT] Failed to send message:', error);
      console.error('❌ [USER-CHAT] Error details:', {
        message: error?.message,
        response: error?.response?.data,
        status: error?.response?.status,
        chatId,
        messageText,
        userId: userProfile?.id
      });
      Toast.show({
        type: 'error',
        text1: "Couldn't send message",
        text2: getChatNetworkErrorMessage(error),
        visibilityTime: 4000,
      });
    } finally {
      setSendingMessage(false);
      console.log('📤 [USER-CHAT] Send operation completed (success or error)');
    }
  };

  const newMessageRef = useRef('');
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  const handleTyping = (text: string) => {
    newMessageRef.current = text;
    setNewMessage(text);
    
    // Emit typing event (only if in existing chat)
    if (selectedChat && !isNewChat && socketRef.current && userProfile?.id) {
      // Clear existing timeout
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      
      const chatId = selectedChat.id;
      const userId = userProfile.id;
      
      // Emit typing started
      socketRef.current.emit('user_typing', { 
        chat_id: chatId,
        user_id: userId,
        is_typing: true
      });
      
      // Auto-stop typing after 3 seconds of inactivity
      typingTimeoutRef.current = setTimeout(() => {
        if (socketRef.current && userProfile?.id) {
          socketRef.current.emit('user_typing', { 
            chat_id: chatId,
            user_id: userId,
            is_typing: false
          });
        }
      }, 3000);
    }
  };


  /** Parse backend timestamp (UTC); if no timezone, treat as UTC so display shows local time. */
  const parseBackendTime = (dateString: string): Date => {
    if (!dateString) return new Date(0);
    const hasTimezone = dateString.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(dateString);
    const iso = hasTimezone ? dateString : (dateString.includes('T') ? dateString + 'Z' : dateString);
    return new Date(iso);
  };

  const formatMessageTime = (dateString: string) => {
    try {
      const date = parseBackendTime(dateString);
      if (isNaN(date.getTime())) return '';
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (error) {
      return '';
    }
  };

  const formatChatTime = (dateString: string) => {
    try {
      const date = parseBackendTime(dateString);
      if (isNaN(date.getTime())) return 'Unknown';
      return formatRelativeDate(date);
    } catch (error) {
      return 'Unknown';
    }
  };

  const formatRelativeDate = (date: Date) => {
    const now = new Date();
    const diffInMinutes = Math.floor((now.getTime() - date.getTime()) / (1000 * 60));
    
    if (diffInMinutes < -1) {
      const currentYear = now.getFullYear();
      const dateYear = date.getFullYear();
      
      if (dateYear === currentYear) {
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      } else {
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      }
    }
    
    if (diffInMinutes < 1) return 'Now';
    if (diffInMinutes < 60) return `${diffInMinutes}m`;
    if (diffInMinutes < 1440) return `${Math.floor(diffInMinutes / 60)}h`;
    
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
      return 'Yesterday';
    }
    
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    if (date > weekAgo) {
      return date.toLocaleDateString('en-US', { weekday: 'short' });
    }
    
    const currentYear = now.getFullYear();
    const dateYear = date.getFullYear();
    
    if (dateYear === currentYear) {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } else {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
  };

  const filteredChats = useMemo(() => {
    const chatsToFilter = sortedChats;
    if (!searchQuery.trim()) return chatsToFilter;
    const query = searchQuery.toLowerCase();
    return chatsToFilter.filter(chat => 
      chat.title.toLowerCase().includes(query) || 
      chat.last_message.toLowerCase().includes(query)
    );
  }, [sortedChats, searchQuery]);

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
      const ts = parseBackendTime(msg.created_at || '').getTime();
      const label = getDateSectionLabel(ts);
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label)!.push(msg);
    }
    const sections: { title: string; data: ChatMessage[] }[] = [];
    const restLabels = Array.from(byLabel.keys()).filter(l => l !== 'Today' && l !== 'Yesterday');
    restLabels.sort((a, b) => {
      const dataA = byLabel.get(a)!;
      const dataB = byLabel.get(b)!;
      const maxTsA = Math.max(...dataA.map(m => parseBackendTime(m.created_at).getTime()));
      const maxTsB = Math.max(...dataB.map(m => parseBackendTime(m.created_at).getTime()));
      return maxTsA - maxTsB; // oldest first
    });
    restLabels.forEach(title => sections.push({ title, data: byLabel.get(title)! }));
    if (byLabel.has('Yesterday')) sections.push({ title: 'Yesterday', data: byLabel.get('Yesterday')! });
    if (byLabel.has('Today')) sections.push({ title: 'Today', data: byLabel.get('Today')! });
    return sections;
  }, [messages]);

  useEffect(() => {
    if (messageSections.length === 0) return;
    const last = messageSections[messageSections.length - 1];
    if (!last?.data.length) return;
    scrollToBottom(false);
  }, [messageSections]);

  // When keyboard opens, scroll so last message stays visible above the keyboard
  useEffect(() => {
    if (keyboardTop == null) return;
    const t = setTimeout(() => scrollToBottom(false), 150);
    return () => clearTimeout(t);
  }, [keyboardTop]);

  // Handle add/remove favorite (syncs with web via PUT unified-history/user_<id>/favorite)
  const handleToggleFavorite = async (chatId: number) => {
    const isFavorite = favoriteChatIds.has(chatId);
    const nextFavorite = !isFavorite;
    try {
      await api.setUnifiedChatFavorite(`user_${chatId}`, nextFavorite);

      const newFavorites = new Set(favoriteChatIds);
      if (nextFavorite) {
        newFavorites.add(chatId);
      } else {
        newFavorites.delete(chatId);
      }
      await persistFavoriteChats(newFavorites);
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
              // Try to delete via backend API
              try {
                const success = await api.deleteUserChat(chatId);
                
                if (success.success !== false) {
                  // Leave WebSocket room for the deleted chat
                  if (socketRef.current && selectedChat?.id === chatId) {
                    socketRef.current.emit('leave_chat_room', { chat_id: chatId });
                  }
                  
                  // Remove from local chats list
                  setChats(prev => prev.filter(chat => chat.id !== chatId));
                  
                  // Remove from favorites if it was favorited
                  if (favoriteChatIds.has(chatId)) {
                    const newFavorites = new Set(favoriteChatIds);
                    newFavorites.delete(chatId);
                    await persistFavoriteChats(newFavorites);
                    setFavoriteChatIds(newFavorites);
                  }
                  
                  // If this was the selected chat, clear selection and messages
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
                // If backend doesn't support deletion (405 Method Not Allowed), 
                // just remove from local list temporarily
                if (error.message?.includes('405') || error.response?.status === 405) {
                  // Remove from local chats list (will reappear on refresh)
                  setChats(prev => prev.filter(chat => chat.id !== chatId));
                  
                  // Remove from favorites if it was favorited
                  if (favoriteChatIds.has(chatId)) {
                    const newFavorites = new Set(favoriteChatIds);
                    newFavorites.delete(chatId);
                    await persistFavoriteChats(newFavorites);
                    setFavoriteChatIds(newFavorites);
                  }
                  
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
                  // Other errors - show error message
                  Alert.alert('Error', error.message || 'Failed to delete chat');
                }
              }
            } catch (error: any) {
              Alert.alert('Error', error.message || 'Failed to delete chat');
            }
          }
        }
      ]
    );
  };

  // Render menu action for chat swipeable
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
                // Close swipeable first
                const swipeableRef = chatSwipeableRefs.current.get(menuChatId);
                if (swipeableRef) {
                  swipeableRef.close();
                }
                // Then show delete confirmation
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

  const dynamicStyles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-start',
      gap: 4,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      minHeight: 56,
      backgroundColor: colors.headerBackground,
    },
    headerTitle: {
      fontSize: 20,
      fontWeight: 'bold',
      color: colors.text,
    },
    headerSubtitle: {
      fontSize: 12,
      color: colors.textSecondary,
      marginTop: 0,
    },
    backButton: {
      padding: 8,
      marginTop: 4,
    },
    newChatButton: {
      padding: 8,
      marginTop: 4,
    },
    searchContainer: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      backgroundColor: colors.card,
    },
    searchInputContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    searchIcon: {
      marginRight: 8,
    },
    searchInput: {
      flex: 1,
      fontSize: 14,
      color: colors.text,
      padding: 0,
      backgroundColor: 'transparent',
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
    },
    chatAvatar: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: colors.surface,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 12,
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
      fontSize: 16,
      fontWeight: '600',
      color: colors.text,
      flex: 1,
    },
    chatTime: {
      fontSize: 11,
      color: colors.textSecondary,
      marginLeft: 8,
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
    emptyContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 32,
    },
    emptyText: {
      fontSize: 16,
      color: colors.textSecondary,
      textAlign: 'center',
      marginTop: 16,
    },
    messagesList: {
      flex: 1,
    },
    messageItem: {
      paddingHorizontal: 16,
      paddingVertical: 1, // Minimal vertical padding
      width: '100%',
    },
    myMessage: {
      alignItems: 'flex-end',
      justifyContent: 'flex-end',
    },
    otherMessage: {
      alignItems: 'flex-start',
      justifyContent: 'flex-start',
    },
    senderName: {
      fontSize: 12,
      color: colors.textSecondary,
      marginBottom: 4,
      marginLeft: 0,
      paddingLeft: 4,
    },
    messageBubble: {
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 18,
      marginVertical: 0, // Minimal vertical margin
    },
    myMessageBubble: {
      backgroundColor: '#007AFF',
    },
    otherMessageBubble: {
      backgroundColor: colors.surface,
    },
    messageText: {
      fontSize: 16, // WhatsApp standard size
      lineHeight: 24, // 1.5x line height for better readability
      flexWrap: 'wrap',
      wordWrap: 'break-word',
      maxWidth: '100%',
      includeFontPadding: false, // Remove extra padding on Android
      textAlignVertical: 'top', // Align text to top for better multi-line display
    },
    myMessageText: {
      color: '#fff',
    },
    otherMessageText: {
      color: colors.text,
    },
    messageTime: {
      fontSize: 11,
      marginTop: 1,
      alignSelf: 'flex-end',
    },
    myMessageTime: {
      color: 'rgba(255, 255, 255, 0.7)',
    },
    otherMessageTime: {
      color: colors.textSecondary,
    },
    inputContainer: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      paddingHorizontal: 16,
      paddingVertical: 6,
      borderTopWidth: 0,
      backgroundColor: 'transparent',
    },
    connectivityBanner: {
      marginHorizontal: 0,
    },
    connectivityBannerText: {
      color: colors.text,
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
    modalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      justifyContent: 'center',
      alignItems: 'center',
    },
    modalContent: {
      backgroundColor: colors.card,
      borderRadius: 12,
      padding: 20,
      width: '80%',
      maxHeight: '80%',
    },
    modalTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: colors.text,
      marginBottom: 16,
    },
    optionItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      paddingHorizontal: 16,
      borderRadius: 8,
      marginBottom: 8,
      backgroundColor: colors.surface,
    },
    selectedOption: {
      backgroundColor: colors.primary + '20',
    },
    optionText: {
      fontSize: 14,
      color: colors.text,
      marginLeft: 12,
    },
    typingIndicator: {
      paddingHorizontal: 16,
      paddingVertical: 4,
    },
    typingText: {
      fontSize: 13,
      fontStyle: 'italic',
      color: colors.textSecondary,
    },
    createButton: {
      backgroundColor: '#007AFF',
      borderRadius: 8,
      paddingVertical: 12,
      alignItems: 'center',
      marginTop: 16,
    },
    createButtonText: {
      color: '#fff',
      fontSize: 16,
      fontWeight: '600',
    },
    mentionResultsContainer: {
      backgroundColor: colors.card,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      maxHeight: 200,
    },
    mentionItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    mentionAvatar: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.surface,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 12,
    },
    mentionName: {
      fontSize: 16,
      fontWeight: '600',
      color: colors.text,
      marginBottom: 2,
    },
    mentionEmail: {
      fontSize: 12,
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
  }), [colors, insets]);

  if (isNewChat || selectedChat) {
    return (
      <SafeAreaView style={dynamicStyles.container} edges={['top', 'bottom']}>
        <View style={dynamicStyles.header}>
          <AppBackButton onPress={() => {
            if (selectedChat || isNewChat) {
              // If in a chat, go back to chat list
              setSelectedChat(null);
              setIsNewChat(false);
              setSelectedRecipient(null);
              setNewMessage('');
            } else {
              // If on chat list, go back to previous screen
              router.back();
            }
          }} />
          {!isNewChat && selectedChat && selectedChat.participants !== undefined ? (
            <TouchableOpacity
              style={{ flex: 1, minWidth: 0, justifyItems: 'flex-start', justifyContent: 'center' }}
              onPress={() => {
                router.push({
                  pathname: '/user-chat/participants',
                  params: {
                    chatId: selectedChat.id.toString(),
                  },
                });
              }}
              activeOpacity={0.7}
            >
              <AppHeaderTitle fill={false}>
                {selectedChat?.title || ''}
              </AppHeaderTitle>
              <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'nowrap', gap: 8, marginTop: 2 }}>
                <Text style={dynamicStyles.headerSubtitle}>
                  {selectedChat.participants.length} participant{selectedChat.participants.length !== 1 ? 's' : ''}
                </Text>
                {isConnected && otherUserOnline && (
                  <Text style={{ fontSize: 10, color: colors.textSecondary }}>• Connected</Text>
                )}
                {(selectedChat.type === 'user_direct' || selectedChat.type === 'direct') ? (
                  <ClientsButton itemType="user_chat" itemId={selectedChat.id} compact allowCreate />
                ) : null}
              </View>
            </TouchableOpacity>
          ) : (
              <View style={{ flex: 1, minWidth: 0, alignItems: 'flex-start', justifyContent: 'center' }}>
              <AppHeaderTitle fill={false}>
                {isNewChat ? 'New Message' : selectedChat?.display_name || selectedChat?.title || ''}
              </AppHeaderTitle>
              {!isNewChat && selectedChat && (selectedChat.type === 'user_direct' || selectedChat.type === 'direct') ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                  <ClientsButton itemType="user_chat" itemId={selectedChat.id} compact allowCreate />
                </View>
              ) : null}
              {selectedChat?.invite_pending && (
                <Text style={{ fontSize: 11, color: '#B45309', marginTop: 2 }}>Invite pending · messaging disabled</Text>
              )}
              {isNewChat && selectedRecipient && (
                <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
                  {selectedRecipient.type === 'user' ? selectedRecipient.data.username : selectedRecipient.data.name}
                </Text>
              )}
            </View>
          )}
          {!isNewChat && selectedChat && (
            <TouchableOpacity 
              onPress={() => {
                setRefreshing(true);
                loadMessages(selectedChat.id).finally(() => setRefreshing(false));
              }}
              style={dynamicStyles.newChatButton}
              disabled={refreshing}
            >
              <Ionicons 
                name="refresh" 
                size={20} 
                color={refreshing ? "#999" : "#007AFF"} 
              />
            </TouchableOpacity>
          )}
          {isNewChat && <View style={{ width: APP_BACK_BUTTON_SLOT }} />}
        </View>

        {Platform.OS === 'ios' ? (
          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={undefined}
            keyboardVerticalOffset={0}
          >
            <View style={{ flex: 1 }}>
              {isNewChat ? (
                <View style={dynamicStyles.emptyContainer}>
                  <Ionicons name="chatbubbles-outline" size={64} color={colors.textSecondary} />
                  <Text style={dynamicStyles.emptyText}>
                    {selectedRecipient 
                      ? (selectedRecipient.type === 'user'
                          ? (selectedRecipient.data.first_name || selectedRecipient.data.username || 'User')
                          : selectedRecipient.data.name)
                      : 'Type @ to find teammates or workspaces to message privately'}
                  </Text>
                </View>
              ) : messagesLoading ? (
                <View style={dynamicStyles.emptyContainer}>
                  <ActivityIndicator size="large" color="#007AFF" />
                </View>
              ) : (
                <SectionList
                  ref={messagesListRef}
                  sections={messageSections}
                  accessibilityRole="list"
                  accessibilityLabel="Chat messages"
                  renderItem={({ item }) => {
                    const isOwnMessage = (currentUserIdRef.current != null && item.sender_id != null)
                      ? String(item.sender_id) === String(currentUserIdRef.current)
                      : item.is_own_message;
                    const preview = (item.content || '').trim().substring(0, 80);
                    const msgLabel = isOwnMessage
                      ? `Your message${preview ? `: ${preview}${preview.length >= 80 ? '…' : ''}` : ''}`
                      : `Message from ${item.sender?.username || 'unknown'}${preview ? `: ${preview}${preview.length >= 80 ? '…' : ''}` : ''}`;
                    return (
                    <View
                      style={[dynamicStyles.messageItem, isOwnMessage ? dynamicStyles.myMessage : dynamicStyles.otherMessage]}
                      accessibilityRole="listitem"
                      accessibilityLabel={msgLabel}
                    >
                      <View style={{ maxWidth: '75%' }}>
                        {!isOwnMessage && item.sender && (
                          <Text style={dynamicStyles.senderName}>{item.sender.username}</Text>
                        )}
                        <View style={[dynamicStyles.messageBubble, isOwnMessage ? dynamicStyles.myMessageBubble : dynamicStyles.otherMessageBubble]}>
                          <Text style={[dynamicStyles.messageText, isOwnMessage ? dynamicStyles.myMessageText : dynamicStyles.otherMessageText]}>
                            {item.content}
                          </Text>
                          <Text style={[dynamicStyles.messageTime, isOwnMessage ? dynamicStyles.myMessageTime : dynamicStyles.otherMessageTime]}>
                            {formatMessageTime(item.created_at)}
                          </Text>
                        </View>
                      </View>
                    </View>
                    );
                  }}
                  keyExtractor={(item) => item.id.toString()}
                  renderSectionHeader={({ section: { title } }) => (
                    <View style={dynamicStyles.messageDateSectionHeader}>
                      <Text style={dynamicStyles.messageDateSectionHeaderText}>{title}</Text>
                    </View>
                  )}
                  onScrollToIndexFailed={() => {
                    setTimeout(() => scrollToBottom(false), 400);
                  }}
                  stickySectionHeadersEnabled={false}
                  style={dynamicStyles.messagesList}
                  contentContainerStyle={{ paddingBottom: 16 }}
                  refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => selectedChat && loadMessages(selectedChat.id)} />}
                  onContentSizeChange={() => scrollToBottom(true)}
                  onLayout={() => scrollToBottom(false)}
                />
              )}
              
              {/* Typing Indicator */}
              {!isNewChat && Object.keys(typingUsers).length > 0 && (
                <View style={dynamicStyles.typingIndicator}>
                  <Text style={dynamicStyles.typingText}>
                    {Object.values(typingUsers).join(', ')} {Object.keys(typingUsers).length === 1 ? 'is' : 'are'} typing...
                  </Text>
                </View>
              )}
            </View>

            {/* Mention Results - Show above input */}
            {showMentionResults && mentionResults.length > 0 && (
              <View style={dynamicStyles.mentionResultsContainer}>
                <FlatList
                  data={mentionResults}
                  keyExtractor={(item, index) => `${item.type}-${item.data.id}-${index}`}
                  renderItem={({ item }) => (
                    <TouchableOpacity
                      style={dynamicStyles.mentionItem}
                      onPress={() => handleSelectRecipient(item)}
                    >
                      <View style={dynamicStyles.mentionAvatar}>
                        <Ionicons
                          name={item.type === 'workspace' ? 'people' : 'person'}
                          size={20}
                          color="#007AFF"
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={dynamicStyles.mentionName}>
                          {item.type === 'user' ? item.data.username : item.data.name}
                        </Text>
                        {item.type === 'user' && item.data.email && (
                          <Text style={dynamicStyles.mentionEmail}>{item.data.email}</Text>
                        )}
                      </View>
                    </TouchableOpacity>
                  )}
                  style={{ maxHeight: 200 }}
                />
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

            <View 
              ref={inputContainerRef}
              style={[
                dynamicStyles.inputContainer,
                { zIndex: 10 },
                keyboardTop != null && {
                  marginBottom: Math.max(0, Dimensions.get('window').height - insets.bottom - keyboardTop),
                },
              ]}
            >
              <ChatComposerInput
                ref={messageInputRef}
                shellStyle={dynamicStyles.messageInputShell}
                inputStyle={dynamicStyles.messageInput}
                placeholder={isNewChat ? "Type @ to search for a user or workspace..." : "Type a message..."}
                placeholderTextColor={colors.textSecondary}
                value={newMessage}
                onChangeText={handleTyping}
                editable={!connectivitySendDisabled}
                returnKeyType="default"
                maxLength={4000}
              />
              <View style={dynamicStyles.composerSendWrap}>
                <TouchableOpacity 
                  style={[dynamicStyles.sendButton, ((!newMessage.trim() && !selectedRecipient) || sendingMessage || connectivitySendDisabled) && { opacity: 0.5 }]} 
                  onPress={handleSendMessage} 
                  disabled={sendingMessage || connectivitySendDisabled || (!newMessage.trim() && !selectedRecipient)}
                >
                  {sendingMessage ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Ionicons name="arrow-up" size={18} color="#fff" />
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        ) : (
          <>
            <View style={{ flex: 1 }}>
              {isNewChat ? (
                <View style={dynamicStyles.emptyContainer}>
                  <Ionicons name="chatbubbles-outline" size={64} color={colors.textSecondary} />
                  <Text style={dynamicStyles.emptyText}>
                    {selectedRecipient 
                      ? (selectedRecipient.type === 'user'
                          ? (selectedRecipient.data.first_name || selectedRecipient.data.username || 'User')
                          : selectedRecipient.data.name)
                      : 'Type @ to find teammates or workspaces to message privately'}
                  </Text>
                </View>
              ) : messagesLoading ? (
                <View style={dynamicStyles.emptyContainer}>
                  <ActivityIndicator size="large" color="#007AFF" />
                </View>
              ) : (
                <SectionList
                  ref={messagesListRef}
                  sections={messageSections}
                  accessibilityRole="list"
                  accessibilityLabel="Chat messages"
                  renderItem={({ item }) => {
                    const isOwnMessage = (currentUserIdRef.current != null && item.sender_id != null)
                      ? String(item.sender_id) === String(currentUserIdRef.current)
                      : item.is_own_message;
                    const preview = (item.content || '').trim().substring(0, 80);
                    const msgLabel = isOwnMessage
                      ? `Your message${preview ? `: ${preview}${preview.length >= 80 ? '…' : ''}` : ''}`
                      : `Message from ${item.sender?.username || 'unknown'}${preview ? `: ${preview}${preview.length >= 80 ? '…' : ''}` : ''}`;
                    return (
                    <View
                      style={[dynamicStyles.messageItem, isOwnMessage ? dynamicStyles.myMessage : dynamicStyles.otherMessage]}
                      accessibilityRole="listitem"
                      accessibilityLabel={msgLabel}
                    >
                      <View style={{ maxWidth: '75%' }}>
                        {!isOwnMessage && item.sender && (
                          <Text style={dynamicStyles.senderName}>{item.sender.username}</Text>
                        )}
                        <View style={[dynamicStyles.messageBubble, isOwnMessage ? dynamicStyles.myMessageBubble : dynamicStyles.otherMessageBubble]}>
                          <Text style={[dynamicStyles.messageText, isOwnMessage ? dynamicStyles.myMessageText : dynamicStyles.otherMessageText]}>
                            {item.content}
                          </Text>
                          <Text style={[dynamicStyles.messageTime, isOwnMessage ? dynamicStyles.myMessageTime : dynamicStyles.otherMessageTime]}>
                            {formatMessageTime(item.created_at)}
                          </Text>
                        </View>
                      </View>
                    </View>
                    );
                  }}
                  keyExtractor={(item) => item.id.toString()}
                  renderSectionHeader={({ section: { title } }) => (
                    <View style={dynamicStyles.messageDateSectionHeader}>
                      <Text style={dynamicStyles.messageDateSectionHeaderText}>{title}</Text>
                    </View>
                  )}
                  onScrollToIndexFailed={() => {
                    setTimeout(() => scrollToBottom(false), 400);
                  }}
                  stickySectionHeadersEnabled={false}
                  style={dynamicStyles.messagesList}
                  contentContainerStyle={{ paddingBottom: 16 }}
                  refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => selectedChat && loadMessages(selectedChat.id)} />}
                  onContentSizeChange={() => scrollToBottom(true)}
                  onLayout={() => scrollToBottom(false)}
                />
              )}
              
              {/* Typing Indicator */}
              {!isNewChat && Object.keys(typingUsers).length > 0 && (
                <View style={dynamicStyles.typingIndicator}>
                  <Text style={dynamicStyles.typingText}>
                    {Object.values(typingUsers).join(', ')} {Object.keys(typingUsers).length === 1 ? 'is' : 'are'} typing...
                  </Text>
                </View>
              )}
            </View>

            {/* Mention Results - Show above input */}
            {showMentionResults && mentionResults.length > 0 && (
              <View style={dynamicStyles.mentionResultsContainer}>
                <FlatList
                  data={mentionResults}
                  keyExtractor={(item, index) => `${item.type}-${item.data.id}-${index}`}
                  renderItem={({ item }) => (
                    <TouchableOpacity
                      style={dynamicStyles.mentionItem}
                      onPress={() => handleSelectRecipient(item)}
                    >
                      <View style={dynamicStyles.mentionAvatar}>
                        <Ionicons
                          name={item.type === 'workspace' ? 'people' : 'person'}
                          size={20}
                          color="#007AFF"
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={dynamicStyles.mentionName}>
                          {item.type === 'user' ? item.data.username : item.data.name}
                        </Text>
                        {item.type === 'user' && item.data.email && (
                          <Text style={dynamicStyles.mentionEmail}>{item.data.email}</Text>
                        )}
                      </View>
                    </TouchableOpacity>
                  )}
                  style={{ maxHeight: 200 }}
                />
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

            <View 
              ref={inputContainerRef}
              style={[
                dynamicStyles.inputContainer,
                { zIndex: 10 },
                Platform.OS === 'android' && keyboardTop != null && {
                  marginBottom: Math.max(0, Dimensions.get('window').height - insets.bottom - keyboardTop),
                },
              ]}
            >
              <ChatComposerInput
                ref={messageInputRef}
                shellStyle={dynamicStyles.messageInputShell}
                inputStyle={dynamicStyles.messageInput}
                placeholder={isNewChat ? "Type @ to search for a user or workspace..." : "Type a message..."}
                placeholderTextColor={colors.textSecondary}
                value={newMessage}
                onChangeText={handleTyping}
                editable={!connectivitySendDisabled}
                returnKeyType="default"
                maxLength={4000}
              />
              <View style={dynamicStyles.composerSendWrap}>
                <TouchableOpacity 
                  style={[dynamicStyles.sendButton, ((!newMessage.trim() && !selectedRecipient) || sendingMessage || connectivitySendDisabled) && { opacity: 0.5 }]} 
                  onPress={handleSendMessage} 
                  disabled={sendingMessage || connectivitySendDisabled || (!newMessage.trim() && !selectedRecipient)}
                >
                  {sendingMessage ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Ionicons name="arrow-up" size={18} color="#fff" />
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </>
        )}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={dynamicStyles.container} edges={['top']}>
      <View style={dynamicStyles.header}>
        <AppBackButton onPress={() => {
          // Navigate back to home
          router.back();
        }} />
        <AppHeaderTitle>Messages</AppHeaderTitle>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TouchableOpacity 
            onPress={() => {
              setRefreshing(true);
              loadChats();
            }}
            style={dynamicStyles.newChatButton}
            disabled={refreshing}
          >
            <Ionicons 
              name="refresh" 
              size={26} 
              color={refreshing ? "#999" : "#007AFF"} 
            />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setShowInviteModal(true)} style={dynamicStyles.newChatButton}>
            <Ionicons name="person-add-outline" size={24} color="#007AFF" />
          </TouchableOpacity>
          <TouchableOpacity onPress={handleNewChat} style={dynamicStyles.newChatButton}>
            <Ionicons name="add" size={26} color="#007AFF" />
          </TouchableOpacity>
        </View>
      </View>

      <View style={dynamicStyles.searchContainer}>
        <View style={dynamicStyles.searchInputContainer}>
          <Ionicons name="search" size={20} color={colors.textSecondary} style={dynamicStyles.searchIcon} />
          <TextInput
            {...ANDROID_TEXT_INPUT_PROPS}
            style={dynamicStyles.searchInput}
            placeholder="Search conversations..."
            placeholderTextColor={colors.textSecondary}
            value={searchQuery}
            onChangeText={setSearchQuery}
            returnKeyType="search"
            onSubmitEditing={() => Keyboard.dismiss()}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')} style={dynamicStyles.searchIcon}>
              <Ionicons name="close-circle" size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {loading ? (
        <View style={dynamicStyles.emptyContainer}>
          <ActivityIndicator size="large" color="#007AFF" />
        </View>
      ) : filteredChats.length === 0 ? (
        <View style={dynamicStyles.emptyContainer}>
          <Ionicons name="chatbubbles-outline" size={64} color={colors.textSecondary} />
          <Text style={dynamicStyles.emptyText}>
            {searchQuery ? 'No conversations found' : 'No conversations yet\nStart a new chat to get started'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={filteredChats}
          renderItem={({ item }) => (
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
                      handleChatPress(item);
                    }
                  }}
                >
                  <View style={dynamicStyles.chatAvatar}>
                    <Ionicons 
                      name={item.type === 'workspace' ? 'people' : 'person'} 
                      size={24} 
                      color="#007AFF" 
                    />
                  </View>
                  <View style={dynamicStyles.chatContent}>
                    <View style={dynamicStyles.chatItemHeader}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                        <Text style={dynamicStyles.chatTitle} numberOfLines={1}>
                          {item.display_name || item.title}
                        </Text>
                        {item.invite_pending && (
                          <Text style={{ marginLeft: 6, fontSize: 10, color: '#B45309' }}>Pending</Text>
                        )}
                        {favoriteChatIds.has(item.id) && (
                          <Ionicons name="star" size={16} color="#FFD700" style={{ marginLeft: 6 }} />
                        )}
                      </View>
                      <Text style={dynamicStyles.chatTime}>{formatChatTime(item.updated_at)}</Text>
                    </View>
                    <View style={dynamicStyles.chatFooter}>
                      <Text style={dynamicStyles.lastMessage} numberOfLines={2}>{item.last_message}</Text>
                    </View>
                  </View>
                </TouchableOpacity>
              </View>
            </Swipeable>
          )}
          keyExtractor={(item) => item.id.toString()}
          style={dynamicStyles.chatsList}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={loadChats} />}
          onEndReached={() => {
            if (!searchQuery.trim() && hasMoreChats) {
              loadMoreChats();
            }
          }}
          onEndReachedThreshold={0.3}
          ListFooterComponent={
            isLoadingMoreChats ? (
              <ActivityIndicator
                size="small"
                color={colors.primary}
                style={{ marginVertical: 16 }}
              />
            ) : null
          }
        />
      )}

      {renderChatMenuModal()}

      <Modal visible={showInviteModal} animationType="slide" transparent onRequestClose={() => setShowInviteModal(false)}>
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' }}>
          <View style={{ backgroundColor: colors.background, padding: 20, borderTopLeftRadius: 16, borderTopRightRadius: 16, gap: 12 }}>
            <Text style={{ fontSize: 18, fontWeight: '600', color: colors.text }}>Invite to Secure Messaging</Text>
            <Text style={{ fontSize: 13, color: colors.textSecondary }}>
              Invite by email or SMS. Message content is never included.
            </Text>
            <TextInput
              {...ANDROID_TEXT_INPUT_PROPS}
              style={{ borderWidth: 1, borderColor: colors.textSecondary, borderRadius: 8, padding: 12, color: colors.text }}
              placeholder="Email"
              placeholderTextColor={colors.textSecondary}
              value={inviteEmail}
              onChangeText={setInviteEmail}
              keyboardType="email-address"
              autoCapitalize="none"
            />
            <PhoneNumberInput
              value={invitePhone}
              onChange={setInvitePhone}
              placeholder="Phone number"
            />
            {!!invitePhone.trim() && (
              <TouchableOpacity
                onPress={() => setInviteSmsConsent((v) => !v)}
                style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}
              >
                <Ionicons
                  name={inviteSmsConsent ? 'checkbox' : 'square-outline'}
                  size={22}
                  color="#007AFF"
                />
                <Text style={{ flex: 1, fontSize: 12, color: colors.textSecondary }}>
                  I have permission to contact this number by SMS for a GrabDocs invite.
                </Text>
              </TouchableOpacity>
            )}
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 12, marginTop: 8 }}>
              <TouchableOpacity onPress={() => setShowInviteModal(false)}>
                <Text style={{ color: colors.textSecondary, fontSize: 16 }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={handleInviteSubmit} disabled={inviteSubmitting}>
                <Text style={{ color: '#007AFF', fontSize: 16, fontWeight: '600' }}>
                  {inviteSubmitting ? 'Sending…' : 'Send invite'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

    </SafeAreaView>
  );
}


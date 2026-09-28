import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { Image as ExpoImage } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    BackHandler,
    Keyboard,
    KeyboardAvoidingView,
    Modal,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    useWindowDimensions,
    View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import ActionMenuModal, { type ActionMenuItem } from '../../../components/ActionMenuModal';
import AdaptiveListPickerModal from '../../../components/AdaptiveListPickerModal';
import ClientContextStrip from '../../../components/clients/ClientContextStrip';
import ClientsButton from '../../../components/clients/ClientsButton';
import DocumentViewer from '../../../components/DocumentViewer';
import { FeedbackTouchable } from '../../../components/FeedbackTouchable';
import { useThemeColors } from '../../../hooks/useThemeColors';
import { getClientsForItem, setItemClients } from '../../../services/clientsApi';
import {
    addDraftAttachmentFile,
    addDraftAttachmentFileId,
    analyzeMailboxThread,
    deleteDraftAttachment,
    deleteMailboxDraft,
    dismissMailboxThread,
    downloadMessageAttachment,
    emailApiError,
    generateMailboxDraft,
    getMailboxSettings,
    getMailboxThread,
    isOpenableMailboxThread,
    listMailboxThreads,
    mailboxCapabilities,
    markMailboxThreadAwaiting,
    stopMailboxThreadAwaiting,
    nextPendingMailboxThread,
    patchMailboxDraft,
    patchMailboxSettings,
    reconcileMailboxSend,
    researchAndGenerateMailboxDraft,
    sendMailboxDraft,
    undismissMailboxThread,
    undoMailboxSend,
    type EmailDraft,
    type EmailMessage,
    type EmailThread,
    type MailboxSettings,
    type ReplyFromInfo,
    type ThreadAnalysis,
    type ThreadAttention,
} from '../../../services/emailSyncApi';
import { AttachmentNamesRow, type AttachPreview } from '../_components/AttachmentNamesRow';
import { formatEmailWhen } from '../_components/emailFormat';
import { EmailHtmlBody } from '../_components/EmailHtmlBody';
import {
    canReplyAll,
    DEFAULT_REPLY_TONE,
    prepopulateResearchQuestion,
    REPLY_TONES,
    requestIcon,
    restoreTone,
    type ReplyTone,
} from '../_components/emailReplyShared';
import { GrabDocsAttachPicker } from '../_components/GrabDocsAttachPicker';

import AppBackButton from '../../../components/AppBackButton';
import AppHeaderTitle from '../../../components/AppHeaderTitle';
import { truncateAppHeaderTitle } from '../../../utils/chatTitleDisplay';
import { formatRemainingCountdown } from '../../../utils/timeFormatting';
import { emailSyncClearUndo, emailSyncSetUndo, useEmailSyncUndo } from '../_components/emailSyncCache';

function getFileTypeFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'heic', 'heif'];
  const docExts = ['doc', 'docx'];
  const xlsExts = ['xls', 'xlsx', 'csv'];
  const pptExts = ['ppt', 'pptx'];
  const textExts = ['txt', 'md', 'rtf'];
  if (ext === 'pdf') return 'application/pdf';
  if (imageExts.includes(ext)) return 'image';
  if (docExts.includes(ext)) return 'application/msword';
  if (xlsExts.includes(ext)) return 'application/vnd.ms-excel';
  if (pptExts.includes(ext)) return 'application/vnd.ms-powerpoint';
  if (textExts.includes(ext)) return 'text/plain';
  return '';
}

function isImageMimeOrName(mime: string, name: string) {
  if ((mime || '').startsWith('image/')) return true;
  return /\.(jpg|jpeg|png|gif|bmp|webp|heic|heif)$/i.test(name || '');
}

function isPdfMimeOrName(mime: string, name: string) {
  if ((mime || '').includes('pdf')) return true;
  return /\.pdf$/i.test(name || '');
}

function splitAddrs(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

export default function EmailThreadScreen() {
  const { id, workspaceId, filter, compose, client_id: clientIdParam, to: toParam } = useLocalSearchParams<{
    id: string;
    workspaceId?: string;
    filter?: string;
    compose?: string;
    client_id?: string;
    to?: string;
  }>();
  const threadId = Number(id);
  const wantCompose = compose === '1' || compose === 'true';
  const attention = (filter === 'dismissed' || filter === 'candidates' || filter === 'pending' || filter === 'awaiting' || filter === 'drafts' || filter === 'sent' || filter === 'closed'
    ? filter
    : 'pending') as ThreadAttention;
  const dismissed = attention === 'dismissed';
  const router = useRouter();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const ws = workspaceId ? Number(workspaceId) : undefined;

  const [thread, setThread] = useState<EmailThread | null>(null);
  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [draft, setDraft] = useState<EmailDraft | null>(null);
  const [replyFrom, setReplyFrom] = useState<ReplyFromInfo | null>(null);
  const [pendingSend, setPendingSend] = useState<{
    id: number;
    status?: string;
    error_message?: string;
  } | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sendReady, setSendReady] = useState(true);
  const [composing, setComposing] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  /** Keyboard top (screenY) — Android needs a manual lift; iOS uses KeyboardAvoidingView. */
  const [keyboardTop, setKeyboardTop] = useState<number | null>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [busy, setBusy] = useState(false);
  const [body, setBody] = useState('');
  const [expectsReply, setExpectsReply] = useState(false);
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState('');
  const [headersOpen, setHeadersOpen] = useState(false);
  const [attachMenu, setAttachMenu] = useState(false);
  const [toneMenu, setToneMenu] = useState(false);
  const [gdOpen, setGdOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [fullscreenMessage, setFullscreenMessage] = useState<EmailMessage | null>(null);
  const [composeFullscreen, setComposeFullscreen] = useState(false);
  const [threadCollapsedForCompose, setThreadCollapsedForCompose] = useState(false);
  const [grabdocsResearchOn, setGrabdocsResearchOn] = useState(false);
  const [replyTone, setReplyTone] = useState<ReplyTone>(DEFAULT_REPLY_TONE);
  const [replyAll, setReplyAll] = useState(false);
  const [customInstructions, setCustomInstructions] = useState('');
  const [analysis, setAnalysis] = useState<ThreadAnalysis | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [researchQuestion, setResearchQuestion] = useState('');
  const [researchAiSuggested, setResearchAiSuggested] = useState(false);
  const [researchNote, setResearchNote] = useState('');
  const [researchPhase, setResearchPhase] = useState<'idle' | 'searching' | 'writing' | 'ready'>('idle');
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [generatingMessage, setGeneratingMessage] = useState<string | null>(null);
  const [suggestedReply, setSuggestedReply] = useState(false);
  const [viewerFileId, setViewerFileId] = useState<number | null>(null);
  const [viewerFileName, setViewerFileName] = useState('');
  const [directPreview, setDirectPreview] = useState<{
    uri: string;
    name: string;
    mime: string;
  } | null>(null);
  const [attOpening, setAttOpening] = useState(false);
  const lastTapRef = useRef(0);
  const composeScrollRef = useRef<ScrollView>(null);
  const autoComposeRef = useRef(false);
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generateInFlightRef = useRef(false);
  const generateGenRef = useRef(0);
  const researchStageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSuggestCancelledRef = useRef(false);
  const userHasTypedRef = useRef(false);
  const composingRef = useRef(false);
  const analyzedForRef = useRef<number | null>(null);
  const draftRef = useRef<EmailDraft | null>(null);
  const threadRef = useRef<EmailThread | null>(null);
  composingRef.current = composing;
  draftRef.current = draft;
  threadRef.current = thread;
  const { undo, remainingSec: undoLeft } = useEmailSyncUndo();
  const isNewCompose =
    draft?.reply_mode === 'new' || !!thread?.provider_thread_id?.startsWith('compose-');

  useEffect(() => {
    return () => {
      if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
      if (researchStageTimerRef.current) clearTimeout(researchStageTimerRef.current);
    };
  }, []);

  useEffect(() => {
    setFullscreenMessage(null);
    setComposeFullscreen(false);
  }, [threadId]);

  useEffect(() => {
    if (!composeFullscreen && !fullscreenMessage) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (fullscreenMessage) {
        setFullscreenMessage(null);
        return true;
      }
      if (composeFullscreen) {
        setComposeFullscreen(false);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [composeFullscreen, fullscreenMessage]);

  useEffect(() => {
    if (!Number.isFinite(threadId) || threadId <= 0) return;
    const raw = Array.isArray(clientIdParam) ? clientIdParam[0] : clientIdParam;
    const clientId = typeof raw === 'string' && /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
    if (!clientId || !Number.isFinite(clientId)) return;
    void (async () => {
      try {
        const existing = await getClientsForItem('email_thread', threadId);
        if (existing.some((c) => c.id === clientId)) return;
        await setItemClients({
          client_ids: [...existing.map((c) => c.id), clientId],
          item_type: 'email_thread',
          item_id: threadId,
        });
      } catch {
        /* non-fatal */
      }
    })();
  }, [clientIdParam, threadId]);

  useEffect(() => {
    if (replyFrom?.forward_without_send_as || isNewCompose) setHeadersOpen(true);
  }, [threadId, replyFrom?.forward_without_send_as, isNewCompose]);

  const applyDraft = (d: EmailDraft | null, openComposer = true) => {
    setDraft(d);
    if (!d) return;
    setTo((d.to || []).join(', '));
    setCc((d.cc || []).join(', '));
    setSubject(d.subject || '');
    setBody(d.body_text || '');
    setExpectsReply(!!d.expects_reply);
    if (d.tone) setReplyTone(restoreTone(d.tone));
    setReplyAll(d.reply_mode === 'reply_all');
    if (openComposer) setComposing(true);
  };

  const load = useCallback(
    async (before?: number) => {
      const data = await getMailboxThread(threadId, before ? { before } : undefined);
      setThread(data.thread);
      setHasMore(!!data.has_more);
      setMessages((m) => (before ? [...data.messages, ...m] : data.messages || []));
      setPendingSend(
        data.pending_send?.id
          ? {
              id: data.pending_send.id,
              status: data.pending_send.status,
              error_message: data.pending_send.error_message,
            }
          : null
      );
      if (data.reply_from) setReplyFrom(data.reply_from);
      if (!before && data.draft) applyDraft(data.draft, true);
    },
    [threadId]
  );

  useEffect(() => {
    let alive = true;
    if (!isOpenableMailboxThread({ id: threadId })) {
      router.back();
      return () => {
        alive = false;
      };
    }
    (async () => {
      setLoading(true);
      setAnalysis(null);
      setResearchQuestion('');
      setResearchAiSuggested(false);
      setResearchNote('');
      setResearchPhase('idle');
      setCustomInstructions('');
      setSuggestedReply(false);
      setReplyTone(DEFAULT_REPLY_TONE);
      setReplyAll(false);
      autoSuggestCancelledRef.current = false;
      userHasTypedRef.current = false;
      generateInFlightRef.current = false;
      generateGenRef.current += 1;
      setGeneratingMessage(null);
      analyzedForRef.current = null;
      try {
        await load();
        if (ws) {
          const [caps, settings] = await Promise.all([
            mailboxCapabilities(ws),
            getMailboxSettings(ws).catch((): MailboxSettings => ({})),
          ]);
          const send = (caps.connections || []).some((c) => c.send_enabled);
          if (alive) {
            setSendReady(caps.connections?.length ? send : true);
            setGrabdocsResearchOn(settings.grabdocs_research_enabled === true);
            setWorkspaceOpen(settings.workspace_search_expanded === true);
          }
        }
      } catch (e: any) {
        if (e?.response?.status === 404) {
          if (alive) router.back();
        } else {
          Alert.alert('Mail', emailApiError(e, 'Could not load'));
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [load, ws, threadId]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, (e) => {
      setKeyboardOpen(true);
      setKeyboardTop(e.endCoordinates.screenY);
      setKeyboardHeight(e.endCoordinates.height);
      requestAnimationFrame(() => composeScrollRef.current?.scrollToEnd({ animated: true }));
    });
    const hide = Keyboard.addListener(hideEvent, () => {
      setKeyboardOpen(false);
      setKeyboardTop(null);
      setKeyboardHeight(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // Edge-to-edge Android often overlays the keyboard instead of resizing; lift the compose panel.
  // Prefer reported keyboard height; fall back to screenY. Do not subtract insets.bottom — that
  // leaves the Generate row partly under the keyboard.
  const androidKeyboardLift = useMemo(() => {
    if (Platform.OS !== 'android' || keyboardTop == null) return 0;
    const fromHeight = keyboardHeight > 0 ? keyboardHeight : 0;
    const fromScreenY = Math.max(0, windowHeight - keyboardTop);
    return Math.max(fromHeight, fromScreenY) + 20;
  }, [keyboardTop, keyboardHeight, windowHeight]);

  // Android 3-button nav is ~48dp and edge-to-edge often reports 0.
  // iPhone home indicator is insets.bottom (~34); floor so attachments stay above it.
  const systemBottomPad =
    Platform.OS === 'android' ? Math.max(insets.bottom, 48) : Math.max(insets.bottom, 16);
  const restAboveNav = keyboardOpen || androidKeyboardLift > 0 ? 0 : systemBottomPad;

  const persistDraft = async () => {
    if (!draft) return;
    await patchMailboxDraft(draft.id, {
      to: splitAddrs(to),
      cc: splitAddrs(cc),
      subject,
      body_text: body,
      expects_reply: expectsReply,
    });
  };

  const generate = async (opts?: { source?: string }) => {
    if (generateInFlightRef.current) return;
    const replyMode = replyAll ? 'reply_all' : 'reply';
    const gen = ++generateGenRef.current;
    setGeneratingMessage('Drafting reply…');
    generateInFlightRef.current = true;
    setBusy(true);
    try {
      if (draft && composing) {
        try {
          await persistDraft();
        } catch {
          /* still generate */
        }
      }
      const payload: Record<string, unknown> = {
        reply_mode: replyMode,
        tone: replyTone,
      };
      if (customInstructions.trim()) payload.custom_instructions = customInstructions.trim();
      if (opts?.source) payload.source = opts.source;
      const currentDraft = draftRef.current;
      if (currentDraft) payload.body_text = body || currentDraft.body_text || '';
      const data = await generateMailboxDraft(threadId, payload as any);
      if (generateGenRef.current !== gen) return;
      if (data.reply_from) setReplyFrom(data.reply_from);
      if (data.thread) setThread(data.thread);
      applyDraft(data.draft);
      setSuggestedReply(opts?.source === 'auto_suggest');
    } catch (e: any) {
      const status = e?.response?.status;
      const code = e?.response?.data?.code;
      const msg = emailApiError(e, 'Could not generate draft');
      if (status === 429 || code === 'monthly_token_limit_exceeded') {
        Alert.alert('AI credit limit', msg);
      } else {
        Alert.alert('Draft', msg);
      }
    } finally {
      generateInFlightRef.current = false;
      setBusy(false);
      if (generateGenRef.current === gen) setGeneratingMessage(null);
    }
  };

  const runAnalyze = async (opts: { hasDraft: boolean; attention?: string; openForCompose?: boolean }) => {
    if (dismissed) return;
    if (threadRef.current?.provider_thread_id?.startsWith('compose-') || draftRef.current?.reply_mode === 'new') return;
    setAnalysisLoading(true);
    try {
      const res = await analyzeMailboxThread(threadId);
      const next = res.analysis;
      setAnalysis(next);
      const prep = prepopulateResearchQuestion(next);
      setResearchQuestion(prep.text);
      setResearchAiSuggested(prep.aiSuggested);
      setResearchNote('');
      const eligible = !!next?.auto_suggest_eligible;
      if (
        eligible
        && (composingRef.current || opts.openForCompose)
        && !opts.hasDraft
        && !draftRef.current
        && !userHasTypedRef.current
        && !generateInFlightRef.current
        && !autoSuggestCancelledRef.current
        && opts.attention === 'needs_reply'
      ) {
        await generate({ source: 'auto_suggest' });
      }
    } catch {
      setAnalysis(null);
    } finally {
      setAnalysisLoading(false);
    }
  };

  const researchAndGenerate = async () => {
    const q = researchQuestion.trim();
    if (!q || generateInFlightRef.current) return;
    const gen = ++generateGenRef.current;
    setGeneratingMessage('Researching workspace…');
    setResearchPhase('searching');
    generateInFlightRef.current = true;
    setBusy(true);
    if (researchStageTimerRef.current) clearTimeout(researchStageTimerRef.current);
    researchStageTimerRef.current = setTimeout(() => {
      if (generateGenRef.current !== gen) return;
      setResearchPhase('writing');
    }, 5000);
    try {
      if (draft && composing) {
        try {
          await persistDraft();
        } catch {
          /* continue */
        }
      }
      const payload: Record<string, unknown> = {
        research_text: q,
        tone: replyTone,
        reply_mode: replyAll ? 'reply_all' : 'reply',
      };
      if (customInstructions.trim()) payload.custom_instructions = customInstructions.trim();
      const currentDraft = draftRef.current;
      if (currentDraft) payload.body_text = body || currentDraft.body_text || '';
      const res = await researchAndGenerateMailboxDraft(threadId, payload as any);
      if (generateGenRef.current !== gen) return;
      if (res.reply_from) setReplyFrom(res.reply_from);
      if (res.thread) setThread(res.thread);
      applyDraft(res.draft);
      setSuggestedReply(true);
      setResearchNote(res.research_note || '');
      setResearchPhase('ready');
    } catch (e: any) {
      Alert.alert('Research', emailApiError(e, 'Could not research and generate'));
      if (generateGenRef.current === gen) setResearchPhase('idle');
    } finally {
      if (researchStageTimerRef.current) {
        clearTimeout(researchStageTimerRef.current);
        researchStageTimerRef.current = null;
      }
      generateInFlightRef.current = false;
      setBusy(false);
      if (generateGenRef.current === gen) setGeneratingMessage(null);
    }
  };

  useEffect(() => {
    if (loading || dismissed || isNewCompose) return;
    if (analyzedForRef.current === threadId) return;
    analyzedForRef.current = threadId;
    void runAnalyze({
      hasDraft: !!draftRef.current,
      attention: threadRef.current?.attention_status,
      openForCompose: wantCompose,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, dismissed, threadId, isNewCompose]);

  // View-only (Dismissed / View email): expand the latest message so the body uses more of the screen.
  useEffect(() => {
    if (!dismissed || !messages.length) return;
    const last = messages[messages.length - 1];
    if (last?.id) setExpandedId(last.id);
  }, [dismissed, messages]);

  useEffect(() => {
    if (!wantCompose || loading || dismissed) return;
    if (!autoComposeRef.current) {
      autoComposeRef.current = true;
      setComposing(true);
    }
    if (draft) setComposing(true);
  }, [wantCompose, loading, draft, dismissed]);

  useEffect(() => {
    const raw = Array.isArray(toParam) ? toParam[0] : toParam;
    if (typeof raw === 'string' && raw.trim() && !to) {
      setTo(raw.trim());
    }
  }, [toParam, to]);

  const goNextPending = async () => {
    if (!ws) {
      router.back();
      return;
    }
    try {
      if (isNewCompose || attention === 'drafts') {
        const list = await listMailboxThreads(ws, 'drafts');
        const next = list.find((t) => t.id !== threadId);
        if (next?.id) {
          router.replace({
            pathname: '/email-sync/thread/[id]',
            params: { id: String(next.id), workspaceId: String(ws), filter: 'drafts', compose: '1' },
          } as any);
          return;
        }
        router.back();
        return;
      }
      const next = await nextPendingMailboxThread(ws, threadId);
      if (next?.id) {
        router.replace({
          pathname: '/email-sync/thread/[id]',
          params: { id: String(next.id), workspaceId: String(ws), filter: 'pending' },
        } as any);
      } else {
        router.back();
      }
    } catch {
      router.back();
    }
  };

  const send = async (advance: boolean) => {
    if (!draft) return;
    if ((draft.reply_mode === 'new' || isNewCompose) && splitAddrs(to).length === 0) {
      Alert.alert('Recipient required', 'Add at least one recipient.');
      return;
    }
    setBusy(true);
    try {
      try {
        await persistDraft();
      } catch {
        /* send payload still carries edits */
      }
      const res = await sendMailboxDraft(draft.id, {
        to: splitAddrs(to),
        cc: splitAddrs(cc),
        subject,
        body_text: body,
        expects_reply: expectsReply,
      });
      if (res.pending_send?.id) setPendingSend({ id: res.pending_send.id });
      const secsRaw = Number(res.undo_seconds ?? 20);
      const secs = Number.isFinite(secsRaw) && secsRaw > 0 ? secsRaw : 20;
      if (res.pending_send?.id) {
        emailSyncSetUndo({
          pendingId: res.pending_send.id,
          untilMs: Date.now() + secs * 1000,
          maxSecs: secs,
          threadId,
        });
      }
      setComposing(false);
      setComposeFullscreen(false);
      setDraft(null);
      if (advanceTimerRef.current) {
        clearTimeout(advanceTimerRef.current);
        advanceTimerRef.current = null;
      }
      if (advance) {
        void goNextPending();
      }
    } catch (e: any) {
      const status = e?.response?.status;
      if (status === 409) {
        emailSyncClearUndo();
        Alert.alert('Sent', 'This reply already went out.');
        if (advance) void goNextPending();
      } else if (status === 403) {
        Alert.alert('Can’t send', 'Reconnect this mailbox in Mailbox settings.');
      } else {
        Alert.alert('Send failed', emailApiError(e, 'Try again'));
      }
    } finally {
      setBusy(false);
    }
  };

  const styles = useMemo(
    () =>
      StyleSheet.create({
        safe: { flex: 1, backgroundColor: colors.headerBackground },
        header: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 4, paddingBottom: 4, backgroundColor: colors.headerBackground },
        headerBody: { flex: 1, minWidth: 0, marginHorizontal: 4, paddingTop: 8 },
        h1: { fontSize: 17, fontWeight: '700', color: colors.text },
        iconBtn: { padding: 10 },
        bubble: {
          marginHorizontal: 16,
          marginBottom: 12,
          padding: 12,
          borderRadius: 16,
          backgroundColor: colors.isDark ? '#1C1E22' : '#FFFFFF',
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.isDark ? '#3F3F46' : '#D1D5DB',
        },
        outbound: {
          backgroundColor: colors.isDark ? '#1e3a5f' : '#EFF6FF',
          borderColor: colors.isDark ? '#2563eb66' : '#BFDBFE',
        },
        bubbleHead: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6 },
        bubbleHeadText: { flex: 1, minWidth: 0 },
        expandBtn: { padding: 4, marginLeft: 8, marginTop: -2 },
        bubbleHeadActions: { flexDirection: 'row', alignItems: 'center' },
        composeSizeBar: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'flex-end',
          paddingHorizontal: 12,
          paddingTop: 8,
          paddingBottom: 0,
        },
        focusDim: {
          ...StyleSheet.absoluteFillObject,
          backgroundColor: colors.isDark ? 'rgba(0,0,0,0.55)' : 'rgba(17,24,39,0.45)',
          zIndex: 4,
        },
        bubbleDimmed: { opacity: 0.28 },
        bubbleFocused: {
          zIndex: 5,
          borderColor: colors.isDark ? '#52525B' : '#9CA3AF',
        },
        from: { fontWeight: '700', color: colors.text, fontSize: 15 },
        meta: { fontSize: 13, color: colors.textSecondary },
        banner: {
          marginHorizontal: 16,
          marginBottom: 8,
          padding: 10,
          borderRadius: 10,
          backgroundColor: colors.isDark ? '#3b2f1a' : '#FEF3C7',
        },
        bannerTxt: { color: colors.isDark ? '#FDE68A' : '#92400E', fontSize: 13, lineHeight: 18 },
        composePanel: {
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          backgroundColor: colors.background,
          flexGrow: 0,
        },
        composer: {
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          backgroundColor: colors.background,
          paddingHorizontal: 12,
          paddingTop: 8,
        },
        headerField: {
          flexDirection: 'row',
          alignItems: 'center',
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
          paddingVertical: 6,
        },
        fromBlock: {
          flexDirection: 'row',
          alignItems: 'flex-start',
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
          paddingVertical: 8,
        },
        composeHeaderSection: {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
          marginBottom: 8,
        },
        composeHeaderToggle: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingVertical: 6,
        },
        composeHeaderFields: {
          paddingBottom: 8,
          gap: 0,
        },
        label: { width: 36, fontSize: 13, color: colors.textSecondary },
        fieldInput: { flex: 1, color: colors.text, fontSize: 15, paddingVertical: 4 },
        input: {
          minHeight: 140,
          borderRadius: 18,
          backgroundColor: colors.surface,
          paddingHorizontal: 14,
          paddingVertical: 12,
          color: colors.text,
          fontSize: 16,
          marginTop: 8,
          textAlignVertical: 'top',
        },
        inputCollapsed: { maxHeight: 200 },
        tools: { flexDirection: 'row', alignItems: 'center', marginTop: 0, gap: 0, flexWrap: 'nowrap' },
        toolBtn: { padding: 6, flexShrink: 0 },
        composeFooter: {
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          backgroundColor: colors.background,
          paddingHorizontal: 4,
          paddingTop: 0,
        },
        sectionPeek: {
          paddingHorizontal: 16,
          paddingVertical: 10,
          backgroundColor: colors.headerBackground,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        },
        sectionPeekText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
        chip: {
          paddingHorizontal: 10,
          paddingVertical: 6,
          borderRadius: 14,
          backgroundColor: colors.surface,
          marginRight: 6,
          marginTop: 4,
        },
        sendRow: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          flexShrink: 1,
        },
        sendNext: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          backgroundColor: '#2563EB',
          borderRadius: 8,
          paddingHorizontal: 8,
          paddingVertical: 6,
          flexShrink: 1,
        },
        sendNextTxt: { color: '#fff', fontWeight: '600', fontSize: 12, flexShrink: 1 },
        sendOnly: { paddingHorizontal: 6, paddingVertical: 6, flexShrink: 0 },
        sendOnlyTxt: { color: colors.text, fontSize: 12, fontWeight: '500' },
        replyBar: {
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          padding: 12,
          flexDirection: 'row',
          gap: 8,
          backgroundColor: colors.background,
        },
        replyBtn: {
          flex: 1,
          backgroundColor: '#007AFF',
          borderRadius: 14,
          paddingVertical: 14,
          alignItems: 'center',
        },
        replySecondary: {
          backgroundColor: colors.surface,
          borderRadius: 14,
          paddingVertical: 14,
          paddingHorizontal: 16,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
        },
        insight: {
          padding: 10,
          borderRadius: 12,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          backgroundColor: colors.surface,
        },
        workspaceHeader: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingVertical: 4,
        },
        actions: {
          paddingHorizontal: 12,
          paddingTop: 10,
          paddingBottom: 8,
          backgroundColor: colors.background,
          gap: 8,
        },
        actionRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'nowrap' },
        toneSelect: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 4,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          borderRadius: 10,
          paddingHorizontal: 10,
          paddingVertical: 10,
          backgroundColor: colors.surface,
          minWidth: 112,
          maxWidth: 132,
        },
        toneOption: {
          paddingVertical: 14,
          paddingHorizontal: 16,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        },
        toneOptionSelected: { color: '#007AFF', fontWeight: '600' },
        customInput: {
          width: '100%',
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          borderRadius: 10,
          paddingHorizontal: 12,
          paddingVertical: 10,
          color: colors.text,
          fontSize: 15,
          backgroundColor: colors.surface,
        },
        researchInput: {
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          borderRadius: 10,
          paddingHorizontal: 10,
          paddingVertical: 8,
          color: colors.text,
          fontSize: 13,
          minHeight: 72,
          textAlignVertical: 'top',
          backgroundColor: colors.isDark ? '#111' : '#fff',
        },
        secondaryBtn: {
          alignSelf: 'flex-start',
          borderWidth: 1.5,
          borderColor: colors.isDark ? '#9CA3AF' : '#6B7280',
          borderRadius: 10,
          paddingHorizontal: 14,
          paddingVertical: 10,
          backgroundColor: colors.surface,
        },
        secondaryBtnText: {
          color: colors.text,
          fontSize: 13,
          fontWeight: '600',
        },
        generateBtn: {
          backgroundColor: colors.isDark ? '#f4f4f5' : '#111827',
          borderRadius: 10,
          paddingHorizontal: 14,
          paddingVertical: 10,
          minWidth: 96,
          alignItems: 'center',
        },
        generateBtnText: {
          color: colors.isDark ? '#111' : '#fff',
          fontWeight: '700',
          fontSize: 14,
          textAlign: 'center',
        },
        undo: {
          position: 'absolute',
          left: 16,
          right: 16,
          backgroundColor: '#1c1c1e',
          borderRadius: 12,
          padding: 14,
          flexDirection: 'row',
          alignItems: 'center',
        },
      }),
    [colors]
  );

  const toggleWorkspaceOpen = () => {
    const next = !workspaceOpen;
    setWorkspaceOpen(next);
    if (ws) {
      void patchMailboxSettings({ workspace_id: ws, workspace_search_expanded: next }).catch(() => {});
    }
  };

  const toneLabel = REPLY_TONES.find((t) => t.value === replyTone)?.label || 'Professional';
  const drafting = !!generatingMessage;
  const workspaceGenerating = researchPhase === 'searching' || researchPhase === 'writing';
  const showReplyAll = canReplyAll(messages);
  const researchStatusLine = researchPhase === 'searching'
    ? 'Researching workspace…'
    : researchPhase === 'writing'
      ? 'Writing your reply…'
      : researchPhase === 'ready'
        ? 'Draft ready'
        : null;

  const attachItems: ActionMenuItem[] = [
    {
      id: 'device',
      label: 'From this device',
      icon: 'phone-portrait-outline',
      onPress: async () => {
        setAttachMenu(false);
        if (!draft) return;
        const pick = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
        if (pick.canceled || !pick.assets?.[0]) return;
        const f = pick.assets[0];
        await addDraftAttachmentFile(draft.id, { uri: f.uri, name: f.name, type: f.mimeType });
        await load();
        setComposing(true);
      },
    },
    {
      id: 'gd',
      label: 'From GrabDocs',
      icon: 'folder-outline',
      onPress: () => {
        setAttachMenu(false);
        setGdOpen(true);
      },
    },
  ];

  const toggleExpanded = (messageId: number) => {
    setExpandedId((cur) => (cur === messageId ? null : messageId));
  };

  const threadReading = !!expandedId || !!fullscreenMessage;

  useEffect(() => {
    if (!threadReading) return;
    Keyboard.dismiss();
    setComposeFullscreen(false);
    setThreadCollapsedForCompose(false);
  }, [threadReading]);

  useEffect(() => {
    if (threadReading) return;
    if (composeFullscreen || (composing && keyboardOpen)) {
      setThreadCollapsedForCompose(true);
      return;
    }
    setThreadCollapsedForCompose(false);
  }, [composeFullscreen, composing, keyboardOpen, threadReading]);

  const onMessagePress = (messageId: number) => {
    const now = Date.now();
    if (now - lastTapRef.current < 320) {
      toggleExpanded(messageId);
      lastTapRef.current = 0;
      return;
    }
    lastTapRef.current = now;
  };

  const openAttachment = async (att: AttachPreview) => {
    const name = (att.filename || '').trim() || 'Attachment';
    if (att.file_id) {
      setDirectPreview(null);
      setViewerFileId(att.file_id);
      setViewerFileName(name);
      return;
    }
    if (att.id != null && att.id > 0) {
      setAttOpening(true);
      try {
        const downloaded = await downloadMessageAttachment(att.id, name);
        setViewerFileId(null);
        setDirectPreview({
          uri: downloaded.uri,
          name: downloaded.filename || name,
          mime: downloaded.mime,
        });
      } catch {
        Alert.alert('Attachment', 'Could not open attachment');
      } finally {
        setAttOpening(false);
      }
      return;
    }
    Alert.alert('Attachment', 'Still importing…');
  };

  const maximizeFocus = !!expandedId && !fullscreenMessage && !composeFullscreen;

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ActivityIndicator style={{ marginTop: 40 }} color="#007AFF" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? -16 : 0}
      >
        {fullscreenMessage ? (
          <View style={styles.header}>
            <View style={styles.headerBody}>
              <Text style={styles.from} numberOfLines={2}>
                {fullscreenMessage.direction === 'outbound'
                  ? 'You'
                  : fullscreenMessage.from_address || 'Them'}
              </Text>
              <Text style={styles.meta}>{formatEmailWhen(fullscreenMessage.provider_received_at)}</Text>
            </View>
            <FeedbackTouchable
              style={styles.iconBtn}
              onPress={() => setFullscreenMessage(null)}
              accessibilityLabel="Exit full screen"
            >
              <Ionicons name="contract-outline" size={22} color={colors.text} />
            </FeedbackTouchable>
          </View>
        ) : composeFullscreen ? (
          <View style={styles.header}>
            <View style={styles.headerBody}>
              <AppHeaderTitle fill={false} size={18} shrink={false} style={{ flexShrink: 1 }}>
                {isNewCompose ? 'New message' : 'Compose'}
              </AppHeaderTitle>
            </View>
            <FeedbackTouchable
              style={styles.iconBtn}
              onPress={() => setComposeFullscreen(false)}
              accessibilityLabel="Exit full screen"
            >
              <Ionicons name="contract-outline" size={22} color={colors.text} />
            </FeedbackTouchable>
          </View>
        ) : (
          <View style={styles.header}>
            <AppBackButton />
            <View style={styles.headerBody}>
              <AppHeaderTitle fill={false} size={18} shrink={false} style={{ flexShrink: 1 }}>
                {isNewCompose
                  ? 'New message'
                  : truncateAppHeaderTitle(thread?.subject || 'Conversation')}
              </AppHeaderTitle>
              {Number.isFinite(threadId) && threadId > 0 ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2, minWidth: 0 }}>
                  <ClientsButton itemType="email_thread" itemId={threadId} compact allowCreate />
                </View>
              ) : null}
            </View>
            {!dismissed && !isNewCompose && thread ? (
              <FeedbackTouchable
                style={styles.iconBtn}
                accessibilityLabel={
                  thread.attention_status === 'awaiting_reply' ? 'Stop awaiting' : 'Mark awaiting reply'
                }
                onPress={async () => {
                  try {
                    if (thread.attention_status === 'awaiting_reply') await stopMailboxThreadAwaiting(threadId);
                    else await markMailboxThreadAwaiting(threadId);
                    await load();
                  } catch (e) {
                    Alert.alert('Awaiting', emailApiError(e, 'Could not update awaiting'));
                  }
                }}
              >
                <Ionicons
                  name={thread.attention_status === 'awaiting_reply' ? 'pause-circle-outline' : 'time-outline'}
                  size={22}
                  color={colors.text}
                />
              </FeedbackTouchable>
            ) : null}
            <FeedbackTouchable
              style={styles.iconBtn}
              onPress={async () => {
                if (dismissed) await undismissMailboxThread(threadId);
                else await dismissMailboxThread(threadId);
                router.back();
              }}
              accessibilityLabel={dismissed ? 'Restore' : 'Dismiss'}
            >
              <Ionicons name={dismissed ? 'arrow-undo' : 'close-circle-outline'} size={22} color={colors.text} />
            </FeedbackTouchable>
            {!dismissed && !isNewCompose && (
              <FeedbackTouchable
                style={styles.iconBtn}
                onPress={() => {
                  void goNextPending();
                }}
                accessibilityLabel="Skip to next thread"
              >
                <Ionicons name="play-skip-forward-outline" size={22} color={colors.text} />
              </FeedbackTouchable>
            )}
          </View>
        )}

        {!fullscreenMessage && !composeFullscreen && Number.isFinite(threadId) && threadId > 0 ? (
          <View style={{ paddingHorizontal: 12, paddingTop: 4 }}>
            <ClientContextStrip itemType="email_thread" itemId={threadId} />
            {maximizeFocus ? (
              <Pressable
                style={styles.focusDim}
                onPress={() => setExpandedId(null)}
                accessibilityLabel="Collapse message"
              />
            ) : null}
          </View>
        ) : null}

        {fullscreenMessage ? (
          <View style={{ flex: 1, minHeight: 0, backgroundColor: colors.isDark ? colors.background : '#F3F4F6' }}>
            <View style={{ flex: 1, paddingHorizontal: 12, paddingTop: 8, minHeight: 0 }}>
              <EmailHtmlBody
                html={fullscreenMessage.body_html}
                text={fullscreenMessage.body_text}
                fill
              />
            </View>
            <View
              style={{
                flexShrink: 0,
                paddingHorizontal: 12,
                paddingTop: 10,
                paddingBottom: 12,
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: colors.border,
                backgroundColor: colors.background,
              }}
            >
              <AttachmentNamesRow
                attachments={fullscreenMessage.attachments}
                onOpen={openAttachment}
                maxVisible={8}
              />
            </View>
          </View>
        ) : threadCollapsedForCompose && !expandedId ? (
          <TouchableOpacity
            style={styles.sectionPeek}
            onPress={() => {
              setComposeFullscreen(false);
              setThreadCollapsedForCompose(false);
              Keyboard.dismiss();
            }}
            accessibilityRole="button"
            accessibilityLabel="Show conversation"
          >
            <Text style={styles.sectionPeekText} numberOfLines={1}>
              {truncateAppHeaderTitle(thread?.subject || 'Conversation')}
            </Text>
          </TouchableOpacity>
        ) : (
        <View style={{ flex: 1, minHeight: 0 }}>
        <ScrollView
          style={{
            flex: 1,
            backgroundColor: maximizeFocus
              ? colors.isDark
                ? '#09090B'
                : '#9CA3AF'
              : colors.isDark
                ? colors.background
                : '#F3F4F6',
          }}
          contentContainerStyle={{
            flexGrow: 1,
            paddingTop: 8,
            paddingBottom: expandedId ? 28 : 16,
          }}
          keyboardShouldPersistTaps="handled"
          pinchGestureEnabled={false}
        >
          {!sendReady && (
            <TouchableOpacity
              onPress={() => router.push('/email-sync/mailbox' as any)}
              style={styles.banner}
            >
              <Text style={styles.bannerTxt}>This mailbox can read but not send. Tap to reconnect.</Text>
            </TouchableOpacity>
          )}

          {pendingSend && (pendingSend.status === 'reconcile_needed' || pendingSend.status === 'failed') && (
            <View style={styles.banner}>
              <Text style={styles.bannerTxt}>
                {pendingSend.status === 'failed' ? 'Send failed.' : 'Send could not be confirmed.'}
                {pendingSend.error_message ? ` ${pendingSend.error_message}` : ''}
              </Text>
              <TouchableOpacity
                onPress={async () => {
                  try {
                    await reconcileMailboxSend(pendingSend.id);
                    await load();
                  } catch (e) {
                    Alert.alert('Reconcile', emailApiError(e, 'Failed'));
                  }
                }}
                style={{ marginTop: 8 }}
              >
                <Text style={{ color: '#007AFF', fontWeight: '700' }}>Check send status</Text>
              </TouchableOpacity>
            </View>
          )}

          {hasMore && messages[0] ? (
            <TouchableOpacity onPress={() => load(messages[0].id)} style={{ alignSelf: 'center', padding: 8 }}>
              <Text style={{ color: '#007AFF', fontWeight: '600' }}>Earlier messages</Text>
            </TouchableOpacity>
          ) : null}

          {messages.map((m) => {
            const out = m.direction === 'outbound';
            const expanded = expandedId === m.id;
            return (
              <Pressable
                key={m.id}
                onPress={() => onMessagePress(m.id)}
                style={[
                  styles.bubble,
                  out && styles.outbound,
                  expanded && { paddingBottom: 16 },
                  maximizeFocus && expanded && styles.bubbleFocused,
                  maximizeFocus && !expanded && styles.bubbleDimmed,
                ]}
              >
                <View style={styles.bubbleHead}>
                  <View style={styles.bubbleHeadText}>
                    <Text style={styles.from}>{out ? 'You' : m.from_address || 'Them'}</Text>
                    <Text style={styles.meta}>{formatEmailWhen(m.provider_received_at)}</Text>
                  </View>
                  <View style={styles.bubbleHeadActions}>
                    <TouchableOpacity
                      onPress={() => toggleExpanded(m.id)}
                      style={styles.expandBtn}
                      hitSlop={8}
                      accessibilityLabel={expanded ? 'Collapse message' : 'Expand message'}
                    >
                      <Ionicons
                        name={expanded ? 'contract-outline' : 'expand-outline'}
                        size={20}
                        color={colors.textSecondary}
                      />
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => {
                        setComposeFullscreen(false);
                        setFullscreenMessage(m);
                      }}
                      style={styles.expandBtn}
                      hitSlop={8}
                      accessibilityLabel="Full screen"
                    >
                      <Ionicons name="scan-outline" size={20} color={colors.textSecondary} />
                    </TouchableOpacity>
                  </View>
                </View>
                <EmailHtmlBody
                  html={m.body_html}
                  text={m.body_text}
                  expanded={expanded}
                  tall={dismissed}
                  reserveBottom={(m.attachments || []).length ? 56 : 0}
                />
                <View style={{ flexShrink: 0 }}>
                  <AttachmentNamesRow
                    attachments={m.attachments}
                    onOpen={openAttachment}
                    style={{ marginTop: 8 }}
                  />
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
        </View>
        )}

        {!dismissed && !fullscreenMessage ? (
          <View
            style={[
              composeFullscreen
                ? { flex: 1, minHeight: 0, ...(androidKeyboardLift > 0 ? { marginBottom: androidKeyboardLift } : null) }
                : expandedId
                  ? { flexGrow: 0, flexShrink: 0 }
                : {
                    flexGrow: 0,
                    flexShrink: 0,
                    maxHeight: Math.round(
                      androidKeyboardLift > 0
                        ? Math.min(windowHeight * 0.42, Math.max(180, windowHeight - androidKeyboardLift - 120))
                        : keyboardOpen
                          ? windowHeight * 0.38
                          : windowHeight * 0.58
                    ),
                    ...(androidKeyboardLift > 0 ? { marginBottom: androidKeyboardLift } : null),
                  },
            ]}
          >
          {!expandedId ? (
          <ScrollView
            ref={composeScrollRef}
            style={[styles.composePanel, composeFullscreen ? { flex: 1 } : { flexGrow: 0 }]}
            contentContainerStyle={{
              paddingBottom: 8,
              gap: 0,
            }}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
            showsVerticalScrollIndicator
          >
            {!composeFullscreen ? (
              <View style={styles.composeSizeBar}>
                <TouchableOpacity
                  onPress={() => {
                    setFullscreenMessage(null);
                    setComposeFullscreen(true);
                  }}
                  hitSlop={8}
                  accessibilityLabel="Full screen"
                  accessibilityRole="button"
                >
                  <Ionicons name="scan-outline" size={22} color={colors.text} />
                </TouchableOpacity>
              </View>
            ) : null}
            <View style={styles.actions}>
              {!isNewCompose ? (
              <>
              {(analysis || analysisLoading || grabdocsResearchOn) ? (
                <View style={styles.insight}>
                  {grabdocsResearchOn ? (
                    <View style={{ marginBottom: analysis || analysisLoading ? 10 : 0 }}>
                      <TouchableOpacity
                        style={styles.workspaceHeader}
                        onPress={toggleWorkspaceOpen}
                        accessibilityRole="button"
                        accessibilityState={{ expanded: workspaceOpen }}
                      >
                        <Ionicons
                          name={workspaceOpen ? 'chevron-down' : 'chevron-forward'}
                          size={16}
                          color={colors.textSecondary}
                        />
                        <Text style={{ fontSize: 13, fontWeight: '600', color: colors.textSecondary, flex: 1 }}>
                          Workspace search
                        </Text>
                        {workspaceOpen && researchAiSuggested ? (
                          <Text style={{ fontSize: 10, color: colors.textSecondary }}>AI suggested</Text>
                        ) : null}
                      </TouchableOpacity>
                      {workspaceOpen ? (
                        <View style={{ marginTop: 8, gap: 8 }}>
                          <TextInput
                            style={styles.researchInput}
                            value={researchQuestion}
                            onChangeText={(v) => {
                              setResearchQuestion(v);
                              setResearchAiSuggested(false);
                            }}
                            placeholder="What should GrabDocs look up?"
                            placeholderTextColor={colors.textSecondary}
                            multiline
                            editable={!workspaceGenerating && !drafting && !busy}
                          />
                          {researchStatusLine ? (
                            <Text style={{ fontSize: 12, color: colors.textSecondary }}>{researchStatusLine}</Text>
                          ) : null}
                          <TouchableOpacity
                            style={[
                              styles.secondaryBtn,
                              (!researchQuestion.trim() || drafting || workspaceGenerating || busy) && { opacity: 0.45 },
                            ]}
                            disabled={!researchQuestion.trim() || drafting || workspaceGenerating || busy}
                            onPress={() => void researchAndGenerate()}
                            accessibilityRole="button"
                            accessibilityLabel="Generate from Workspace"
                          >
                            <Text style={styles.secondaryBtnText}>Generate from Workspace</Text>
                          </TouchableOpacity>
                          {researchNote ? (
                            <Text style={{ fontSize: 12, color: colors.textSecondary }}>{researchNote}</Text>
                          ) : null}
                        </View>
                      ) : null}
                    </View>
                  ) : null}
                  {analysisLoading && !analysis ? (
                    <Text style={{ fontSize: 12, color: colors.textSecondary }}>Understanding this email…</Text>
                  ) : null}
                  {analysis?.intent_summary ? (
                    <Text style={{ fontSize: 12, color: colors.text, marginBottom: 4 }}>
                      <Text style={{ fontWeight: '700' }}>AI detected: </Text>
                      {analysis.intent_summary}
                    </Text>
                  ) : null}
                  {(analysis?.requests || []).map((r, i) => (
                    <Text key={`${r.label}-${i}`} style={{ fontSize: 12, color: colors.text, marginTop: 2 }}>
                      {requestIcon(r.type)} {r.label}
                    </Text>
                  ))}
                  {analysis?.thread_summary ? (
                    <TouchableOpacity onPress={() => setShowSummary((s) => !s)} style={{ marginTop: 6 }}>
                      <Text style={{ fontSize: 11, color: colors.textSecondary, textDecorationLine: 'underline' }}>
                        {showSummary ? 'Hide summary' : 'Summary'}
                      </Text>
                      {showSummary ? (
                        <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 4 }}>{analysis.thread_summary}</Text>
                      ) : null}
                    </TouchableOpacity>
                  ) : null}
                </View>
              ) : null}
              <TextInput
                style={styles.customInput}
                value={customInstructions}
                onChangeText={setCustomInstructions}
                placeholder="Tell AI anything to include…"
                placeholderTextColor={colors.textSecondary}
                editable={!drafting && !busy}
              />
              <View style={styles.actionRow}>
                <TouchableOpacity
                  style={[styles.toneSelect, (drafting || busy) && { opacity: 0.5 }]}
                  onPress={() => setToneMenu(true)}
                  disabled={drafting || busy}
                  accessibilityRole="button"
                  accessibilityLabel={`Tone, ${toneLabel}`}
                >
                  <Text style={{ color: colors.text, fontSize: 14, flexShrink: 1 }} numberOfLines={1}>
                    {toneLabel}
                  </Text>
                  <Ionicons name="chevron-down" size={14} color={colors.textSecondary} />
                </TouchableOpacity>
                {showReplyAll ? (
                  <TouchableOpacity
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 }}
                    onPress={() => !drafting && !busy && setReplyAll((v) => !v)}
                    disabled={drafting || busy}
                  >
                    <Ionicons
                      name={replyAll ? 'checkbox' : 'square-outline'}
                      size={18}
                      color={replyAll ? '#007AFF' : colors.textSecondary}
                    />
                    <Text style={{ fontSize: 13, color: colors.text }} numberOfLines={1}>Reply all</Text>
                  </TouchableOpacity>
                ) : null}
                <View style={{ flex: 1, minWidth: 4 }} />
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  {drafting ? (
                    <ActivityIndicator size="small" color="#007AFF" accessibilityLabel="Drafting reply" />
                  ) : null}
                  <TouchableOpacity
                    style={[styles.generateBtn, { opacity: drafting || busy ? 0.5 : 1 }]}
                    onPress={() => void generate()}
                    disabled={drafting || busy || !sendReady}
                    accessibilityLabel={drafting ? 'Drafting reply' : 'Generate'}
                  >
                    <Text style={styles.generateBtnText}>{drafting ? 'Drafting' : 'Generate'}</Text>
                  </TouchableOpacity>
                </View>
              </View>
              </>
              ) : null}
            </View>

            {composing && draft ? (
              <View style={styles.composer}>
                {suggestedReply ? (
                  <Text style={{ fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>
                    AI prepared a suggested reply — review before sending.
                  </Text>
                ) : null}
                <View style={styles.composeHeaderSection}>
                  <TouchableOpacity
                    onPress={() => setHeadersOpen((v) => !v)}
                    style={styles.composeHeaderToggle}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: headersOpen }}
                  >
                    <Ionicons
                      name="chevron-down"
                      size={16}
                      color={colors.textSecondary}
                      style={{ transform: [{ rotate: headersOpen ? '0deg' : '-90deg' }] }}
                    />
                    {headersOpen ? (
                      <Text style={{ fontSize: 12, color: colors.textSecondary }}>Hide From, To, Cc, Subject</Text>
                    ) : (
                      <Text style={{ fontSize: 14, color: colors.text, flex: 1 }} numberOfLines={1}>
                        {replyFrom?.from_address || 'Connected mailbox'}
                        {subject ? ` · ${subject}` : ''}
                      </Text>
                    )}
                  </TouchableOpacity>
                  {headersOpen ? (
                    <View style={styles.composeHeaderFields}>
                      <View style={styles.fromBlock}>
                        <Text style={styles.label}>From</Text>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={[styles.fieldInput, { paddingVertical: 0 }]} numberOfLines={2}>
                            {replyFrom?.from_address || 'Connected mailbox'}
                          </Text>
                          {replyFrom?.using_send_as_alias && replyFrom.mailbox_address ? (
                            <Text style={{ color: colors.textSecondary, fontSize: 11, marginTop: 2 }}>
                              Via {replyFrom.mailbox_address}
                            </Text>
                          ) : null}
                          {replyFrom?.forward_without_send_as && replyFrom.customer_addressed ? (
                            <Text style={[styles.bannerTxt, { marginTop: 4, fontSize: 11 }]}>
                              Customer wrote to {replyFrom.customer_addressed}. Send-as isn’t set for that address, so this sends from{' '}
                              {replyFrom.from_address}.
                            </Text>
                          ) : null}
                        </View>
                      </View>
                      <View style={styles.headerField}>
                        <Text style={styles.label}>To</Text>
                        <TextInput
                          style={styles.fieldInput}
                          value={to}
                          onChangeText={setTo}
                          autoCapitalize="none"
                          keyboardType="email-address"
                          editable={!drafting && !busy}
                          onEndEditing={() => void persistDraft().catch(() => {})}
                        />
                      </View>
                      <View style={styles.headerField}>
                        <Text style={styles.label}>Cc</Text>
                        <TextInput
                          style={styles.fieldInput}
                          value={cc}
                          onChangeText={setCc}
                          autoCapitalize="none"
                          keyboardType="email-address"
                          editable={!drafting && !busy}
                          onEndEditing={() => void persistDraft().catch(() => {})}
                        />
                      </View>
                      <View style={styles.headerField}>
                        <Text style={styles.label}>Subj</Text>
                        <TextInput
                          style={styles.fieldInput}
                          value={subject}
                          onChangeText={setSubject}
                          editable={!drafting && !busy}
                          onEndEditing={() => void persistDraft().catch(() => {})}
                        />
                      </View>
                    </View>
                  ) : null}
                </View>
                <View style={{ position: 'relative' }}>
                  {drafting && !workspaceGenerating ? (
                    <View
                      style={{
                        ...StyleSheet.absoluteFillObject,
                        zIndex: 2,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: colors.isDark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.85)',
                        borderRadius: 12,
                      }}
                    >
                      <ActivityIndicator color="#007AFF" />
                      <Text style={{ marginTop: 6, fontSize: 13, color: colors.textSecondary }}>Drafting</Text>
                    </View>
                  ) : null}
                  <TextInput
                    style={[
                      styles.input,
                      composeFullscreen ? { minHeight: 160 } : styles.inputCollapsed,
                      drafting ? { opacity: 0.45 } : null,
                    ]}
                    value={body}
                    onChangeText={(v) => {
                      setSuggestedReply(false);
                      userHasTypedRef.current = true;
                      autoSuggestCancelledRef.current = true;
                      setBody(v);
                    }}
                    placeholder={isNewCompose ? 'Write your message…' : 'Reply'}
                    placeholderTextColor={colors.textSecondary}
                    multiline
                    textAlignVertical="top"
                    editable={!drafting && !busy}
                    onEndEditing={() => void persistDraft().catch(() => {})}
                  />
                </View>
                {(draft.attachments || []).length > 0 && (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 6 }}>
                    {(draft.attachments || []).map((a) => (
                      <TouchableOpacity
                        key={a.id}
                        style={styles.chip}
                        onPress={() => {
                          const name = a.filename || 'Attachment';
                          const buttons: { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }[] = [
                            { text: 'Cancel', style: 'cancel' },
                          ];
                          if (a.file_id) {
                            buttons.push({
                              text: 'Open',
                              onPress: () => {
                                setDirectPreview(null);
                                setViewerFileId(a.file_id!);
                                setViewerFileName(name);
                              },
                            });
                          }
                          buttons.push({
                            text: 'Remove',
                            style: 'destructive',
                            onPress: async () => {
                              await deleteDraftAttachment(draft.id, a.id);
                              await load();
                              setComposing(true);
                            },
                          });
                          Alert.alert(name, undefined, buttons);
                        }}
                      >
                        <Text style={{ color: colors.text, fontSize: 12 }} numberOfLines={1}>
                          {a.filename || `File ${a.id}`} ×
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>
            ) : null}
          </ScrollView>
          ) : null}
          {expandedId ? (
            <TouchableOpacity
              style={[styles.composeFooter, { paddingVertical: 10, alignItems: 'center' }]}
              onPress={() => setExpandedId(null)}
              accessibilityRole="button"
              accessibilityLabel="Restore compose"
            >
              <Text style={{ fontSize: 13, fontWeight: '600', color: colors.textSecondary }}>Compose</Text>
            </TouchableOpacity>
          ) : composing && draft ? (
            <View style={[styles.composeFooter, { paddingBottom: keyboardOpen ? 0 : 4 }]}>
              <View style={styles.tools}>
                <TouchableOpacity
                  onPress={() => {
                    setFullscreenMessage(null);
                    setComposeFullscreen((v) => !v);
                  }}
                  style={styles.toolBtn}
                  accessibilityLabel={composeFullscreen ? 'Exit full screen' : 'Full screen'}
                  accessibilityRole="button"
                >
                  <Ionicons
                    name={composeFullscreen ? 'contract-outline' : 'scan-outline'}
                    size={22}
                    color={colors.text}
                  />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setAttachMenu(true)} style={styles.toolBtn} disabled={drafting || busy}>
                  <Ionicons name="attach" size={22} color={colors.text} />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={async () => {
                    try {
                      await deleteMailboxDraft(draft.id);
                      setDraft(null);
                      setComposing(false);
                      setComposeFullscreen(false);
                      setSuggestedReply(false);
                      if (isNewCompose) router.back();
                    } catch (e: any) {
                      if (e?.response?.status === 409) Alert.alert('Discard', 'Undo the pending send first.');
                      else Alert.alert('Discard', emailApiError(e, 'Failed'));
                    }
                  }}
                  style={styles.toolBtn}
                  disabled={drafting || busy}
                >
                  <Ionicons name="trash-outline" size={20} color={colors.textSecondary} />
                </TouchableOpacity>
                <View style={{ flex: 1, minWidth: 4 }} />
                <View style={styles.sendRow}>
                  <TouchableOpacity
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 }}
                    onPress={() => {
                      const next = !expectsReply;
                      setExpectsReply(next);
                      if (draft) void patchMailboxDraft(draft.id, { expects_reply: next }).catch(() => {});
                    }}
                    disabled={drafting || busy}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: expectsReply }}
                    accessibilityLabel="Await reply"
                  >
                    <Ionicons
                      name={expectsReply ? 'checkbox' : 'square-outline'}
                      size={18}
                      color={expectsReply ? '#007AFF' : colors.textSecondary}
                    />
                    <Text style={{ fontSize: 12, color: colors.text }} numberOfLines={1}>
                      Await reply
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.sendNext, (busy || !sendReady || drafting || (isNewCompose && !splitAddrs(to).length)) && { opacity: 0.5 }]}
                    onPress={() => send(true)}
                    disabled={busy || !sendReady || drafting || (isNewCompose && !splitAddrs(to).length)}
                    accessibilityLabel="Send and next"
                  >
                    <Ionicons name="paper-plane" size={14} color="#fff" />
                    <Text style={styles.sendNextTxt} numberOfLines={1}>
                      {busy ? 'Sending…' : 'Send & Next'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.sendOnly, (busy || !sendReady || drafting || (isNewCompose && !splitAddrs(to).length)) && { opacity: 0.5 }]}
                    onPress={() => send(false)}
                    disabled={busy || !sendReady || drafting || (isNewCompose && !splitAddrs(to).length)}
                  >
                    <Text style={styles.sendOnlyTxt}>Send</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          ) : null}
          {maximizeFocus ? (
            <Pressable
              style={styles.focusDim}
              onPress={() => setExpandedId(null)}
              accessibilityLabel="Collapse message"
            />
          ) : null}
          </View>
        ) : null}

        {undo && undoLeft > 0 ? (
          <View style={[styles.undo, { bottom: Math.max(systemBottomPad, 12) + 72 }]}>
            <Text style={{ color: '#fff', flex: 1 }}>
              Sending in {formatRemainingCountdown(undoLeft, undo.maxSecs)}
            </Text>
            <TouchableOpacity
              onPress={async () => {
                try {
                  if (advanceTimerRef.current) {
                    clearTimeout(advanceTimerRef.current);
                    advanceTimerRef.current = null;
                  }
                  await undoMailboxSend(undo.pendingId);
                  emailSyncClearUndo();
                  await load();
                  setComposing(true);
                } catch {
                  emailSyncClearUndo();
                  Alert.alert('Undo', 'Too late — already sending or sent.');
                }
              }}
            >
              <Text style={{ color: '#7dd3fc', fontWeight: '700' }}>Undo</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        {restAboveNav > 0 ? (
          <View style={{ height: restAboveNav, backgroundColor: colors.background }} />
        ) : null}
      </KeyboardAvoidingView>

      <AdaptiveListPickerModal
        visible={toneMenu}
        onClose={() => setToneMenu(false)}
        title="Tone"
        itemCount={REPLY_TONES.length}
      >
        {REPLY_TONES.map((t) => (
          <TouchableOpacity
            key={t.value}
            style={styles.toneOption}
            onPress={() => {
              setReplyTone(t.value);
              setToneMenu(false);
            }}
          >
            <Text
              style={[
                { color: colors.text, fontSize: 16 },
                replyTone === t.value && styles.toneOptionSelected,
              ]}
            >
              {t.label}
            </Text>
          </TouchableOpacity>
        ))}
      </AdaptiveListPickerModal>
      <ActionMenuModal visible={attachMenu} title="Attach" items={attachItems} onClose={() => setAttachMenu(false)} />

      <GrabDocsAttachPicker
        visible={gdOpen}
        workspaceId={ws}
        onClose={() => setGdOpen(false)}
        onAddFiles={async (files) => {
          if (!draft || !files.length) return;
          try {
            for (const file of files) {
              await addDraftAttachmentFileId(draft.id, file.id);
            }
            setGdOpen(false);
            await load();
            setComposing(true);
          } catch (e) {
            Alert.alert('Attach', emailApiError(e, 'Could not attach'));
          }
        }}
      />

      {viewerFileId != null ? (
        <DocumentViewer
          fileId={String(viewerFileId)}
          fileName={viewerFileName}
          fileType={getFileTypeFromFilename(viewerFileName)}
          workspaceId={ws}
          onClose={() => {
            setViewerFileId(null);
            setViewerFileName('');
          }}
        />
      ) : null}

      <Modal
        visible={!!directPreview}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setDirectPreview(null)}
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['top', 'bottom']}>
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingBottom: 8 }}>
            <FeedbackTouchable onPress={() => setDirectPreview(null)} style={{ padding: 10 }}>
              <Ionicons name="close" size={28} color={colors.text} />
            </FeedbackTouchable>
            <Text style={{ flex: 1, fontSize: 17, fontWeight: '700', color: colors.text }} numberOfLines={1}>
              {directPreview?.name || 'Attachment'}
            </Text>
          </View>
          {directPreview && isImageMimeOrName(directPreview.mime, directPreview.name) ? (
            <ExpoImage
              source={{ uri: directPreview.uri }}
              style={{ flex: 1, margin: 12, borderRadius: 8 }}
              contentFit="contain"
            />
          ) : directPreview && isPdfMimeOrName(directPreview.mime, directPreview.name) ? (
            <WebView
              source={{ uri: directPreview.uri }}
              style={{ flex: 1 }}
              originWhitelist={['*']}
              allowFileAccess
              allowUniversalAccessFromFileURLs
            />
          ) : (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
              <Ionicons name="document-outline" size={48} color={colors.textSecondary} />
              <Text style={{ color: colors.textSecondary, marginTop: 12, textAlign: 'center' }}>
                Preview isn’t available for this file type.
              </Text>
            </View>
          )}
        </SafeAreaView>
      </Modal>

      {attOpening ? (
        <View
          pointerEvents="none"
          style={{
            ...StyleSheet.absoluteFillObject,
            backgroundColor: 'rgba(0,0,0,0.25)',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <ActivityIndicator size="large" color="#007AFF" />
        </View>
      ) : null}
    </SafeAreaView>
  );
}

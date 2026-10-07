import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import Toast from 'react-native-toast-message';
import { STORAGE_KEYS } from '../constants/Config';
import { notifyLimitError } from '../contexts/LimitErrorContext';
import { extractLimitErrorData, limitErrorFromCaught } from '../utils/limitErrorUtils';
import { apiService } from '../services/api';
import type {
    AiFmConfig,
    AiFmPlanPayload,
    ChatTurn,
    FmPhase,
    GateType,
    HistoryRow,
    PendingPlanState,
    PlanResponse,
    ScheduledRow,
} from '../types/aiFileManager';
import { buildPlanFromHistoryRow } from '../utils/formatPlanPreview';
import {
    buildGateQueue,
    formatPlanPreview,
    isCompletedHistoryStatus,
    isPendingHistoryStatus,
    parseAiFmTelemetry,
} from '../utils/aiFileManagerUtils';

const HISTORY_LIMIT = 50;

export interface UseAiFileManagerOptions {
  workspaceId: number | null | undefined;
  currentFolderId?: number | null;
  visible: boolean;
  onExecuted?: () => void | Promise<void>;
  onHandoffToChat?: (query: string) => void;
}

export interface GateDraft {
  scopeConfirmed?: boolean;
  folderScopeConfirmed?: boolean;
  suggestedFolderId?: number | null;
  renameBatchConfirmed?: boolean;
  renamePickFileId?: number;
  forceScheduleOverride?: boolean;
}

function reportPlanLimit(payload: unknown): boolean {
  const data = extractLimitErrorData(payload) || limitErrorFromCaught(payload);
  if (!data) return false;
  notifyLimitError(data);
  return true;
}

function generateSessionId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function ensureSessionId(): Promise<string> {
  let id = await AsyncStorage.getItem(STORAGE_KEYS.AI_FM_SESSION);
  if (!id) {
    id = generateSessionId();
    await AsyncStorage.setItem(STORAGE_KEYS.AI_FM_SESSION, id);
  }
  return id;
}

export function useAiFileManager(options: UseAiFileManagerOptions) {
  const { workspaceId, currentFolderId, visible, onExecuted, onHandoffToChat } = options;

  const [phase, setPhase] = useState<FmPhase>('idle');
  const [thread, setThread] = useState<ChatTurn[]>([]);
  const [gateQueue, setGateQueue] = useState<GateType[]>([]);
  const [activeGate, setActiveGate] = useState<GateType | null>(null);
  const [pendingPlan, setPendingPlan] = useState<PendingPlanState | null>(null);
  const [lastPlanResponse, setLastPlanResponse] = useState<PlanResponse | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledRow[]>([]);
  const [config, setConfig] = useState<AiFmConfig | null>(null);
  const [sessionId, setSessionId] = useState<string>('');
  const [gateDraft, setGateDraft] = useState<GateDraft>({});
  const [lastUserMessage, setLastUserMessage] = useState('');
  const [error, setError] = useState<string | null>(null);

  const latestClientRequestIdRef = useRef(0);
  const planningRef = useRef(false);
  const executingRef = useRef(false);
  const sessionIdRef = useRef('');

  const clearEphemeralFmState = useCallback(() => {
    setPendingPlan(null);
    setGateQueue([]);
    setActiveGate(null);
    setLastPlanResponse(null);
    setGateDraft({});
    if (phase !== 'unknown') {
      setPhase('idle');
    }
  }, [phase]);

  const startNewCommand = useCallback(() => {
    setThread([]);
    setLastUserMessage('');
    setError(null);
    clearEphemeralFmState();
  }, [clearEphemeralFmState]);

  const refreshHistory = useCallback(async (): Promise<HistoryRow[]> => {
    try {
      const rows = await apiService.getAiFileManagerHistory(HISTORY_LIMIT);
      setHistory(rows);
      return rows;
    } catch (e: any) {
      const msg = e?.response?.data?.message || e?.message || 'Failed to load history';
      setError(msg);
      return [];
    }
  }, []);

  const refreshScheduled = useCallback(async () => {
    try {
      const rows = await apiService.getAiFileManagerScheduled();
      setScheduled(rows);
    } catch (e: any) {
      const msg = e?.response?.data?.message || e?.message || 'Failed to load scheduled jobs';
      setError(msg);
    }
  }, []);

  const onSheetOpen = useCallback(async () => {
    setError(null);
    try {
      if (!config) {
        const cfg = await apiService.getAiFileManagerConfig();
        setConfig(cfg);
      }
    } catch {
      /* config optional for first paint */
    }
    await refreshHistory();
    await refreshScheduled();
  }, [config, refreshHistory, refreshScheduled]);

  const onSheetClose = useCallback(() => {
    clearEphemeralFmState();
  }, [clearEphemeralFmState]);

  useEffect(() => {
    void ensureSessionId().then((id) => {
      setSessionId(id);
      sessionIdRef.current = id;
    });
  }, []);

  useEffect(() => {
    if (visible) {
      void onSheetOpen();
    }
  }, [visible, onSheetOpen]);

  const applyPlanResponse = useCallback(
    (res: PlanResponse, requestId: number, userMessage: string) => {
      if (requestId !== latestClientRequestIdRef.current) return;

      setLastPlanResponse(res);

      if (res.not_file_op) {
        clearEphemeralFmState();
        onHandoffToChat?.(userMessage);
        return;
      }

      const preview = formatPlanPreview(res.plan);
      setThread((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: preview,
          planPreview: preview,
          planFileLinks: res.plan?.file_links,
        },
      ]);

      const queue = buildGateQueue(res);
      setGateQueue(queue);

      if (queue.length > 0) {
        setActiveGate(queue[0]);
        setPhase('gate');
        setPendingPlan(null);
        return;
      }

      if (res.execution_token && res.plan_hash) {
        const planOps = Array.isArray(res.plan?.operations) ? res.plan.operations : [];
        if (planOps.length > 0) {
          setPendingPlan({
            executionToken: res.execution_token,
            planHash: res.plan_hash,
            historyId: res.history_id,
            plan: res.plan,
            requiresHighRiskConfirm: !!res.requires_high_risk_confirm,
            lastUserMessage: userMessage,
          });
          setActiveGate(null);
          setPhase('pending');
        } else {
          setPendingPlan(null);
          setActiveGate(null);
          setPhase('idle');
        }
        return;
      }

      if (res.undo_intent) {
        setPhase('idle');
        return;
      }

      setPhase('idle');
    },
    [clearEphemeralFmState, onHandoffToChat]
  );

  const sendPlan = useCallback(
    async (message: string, gateOverrides?: GateDraft) => {
      if (planningRef.current) return;
      const ws = workspaceId;
      if (ws == null) {
        Toast.show({ type: 'error', text1: 'No workspace', text2: 'Cannot run AI File Manager without a workspace.' });
        return;
      }

      const trimmed = message.trim();
      if (!trimmed) return;

      planningRef.current = true;
      setPhase('planning');
      setError(null);
      setPendingPlan(null);
      setLastUserMessage(trimmed);
      setThread((prev) => [...prev, { role: 'user', content: trimmed }]);

      const requestId = ++latestClientRequestIdRef.current;
      const sid = sessionIdRef.current || (await ensureSessionId());
      sessionIdRef.current = sid;
      setSessionId(sid);

      const draft = { ...gateDraft, ...gateOverrides };
      setGateDraft(draft);

      const historyTurns = thread.slice(-8).map((t) => ({ role: t.role, content: t.content }));

      try {
        const res = await apiService.postAiFileManagerPlan({
          message: trimmed,
          workspace_id: ws,
          current_folder_id: currentFolderId ?? null,
          session_id: sid,
          history: historyTurns,
          scope_confirmed: draft.scopeConfirmed,
          folder_scope_confirmed: draft.folderScopeConfirmed,
          suggested_folder_id: draft.suggestedFolderId,
          rename_batch_confirmed: draft.renameBatchConfirmed,
          rename_pick_file_id: draft.renamePickFileId,
          force_schedule_override: draft.forceScheduleOverride,
        });

        if (requestId !== latestClientRequestIdRef.current) return;

        if (res.success === false) {
          if (reportPlanLimit(res)) {
            setPhase('idle');
            return;
          }
          const msg = res.message || 'Plan failed';
          setError(msg);
          setThread((prev) => [...prev, { role: 'assistant', content: msg }]);
          setPhase('idle');
          return;
        }

        applyPlanResponse(res, requestId, trimmed);
      } catch (e: any) {
        if (requestId !== latestClientRequestIdRef.current) return;
        if (reportPlanLimit(e)) {
          setPhase('idle');
          return;
        }
        const msg = e?.response?.data?.message || e?.message || 'Plan request failed';
        setError(msg);
        Toast.show({ type: 'error', text1: 'Plan failed', text2: msg });
        setPhase('idle');
      } finally {
        planningRef.current = false;
      }
    },
    [workspaceId, currentFolderId, gateDraft, thread, applyPlanResponse]
  );

  const resolveActiveGate = useCallback(
    async (overrides: GateDraft) => {
      const msg = lastUserMessage;
      if (!msg) return;
      await sendPlan(msg, overrides);
    },
    [lastUserMessage, sendPlan]
  );

  const confirmScope = useCallback(() => {
    void resolveActiveGate({ scopeConfirmed: true });
  }, [resolveActiveGate]);

  const confirmFolderScope = useCallback(
    (currentFolderOnly: boolean, suggestedFolderId?: number | null) => {
      void resolveActiveGate({
        folderScopeConfirmed: true,
        suggestedFolderId: currentFolderOnly ? (currentFolderId ?? null) : suggestedFolderId,
      });
    },
    [resolveActiveGate, currentFolderId]
  );

  const confirmRenameBatch = useCallback(() => {
    void resolveActiveGate({ renameBatchConfirmed: true });
  }, [resolveActiveGate]);

  const pickRenameTarget = useCallback(
    (fileId: number) => {
      void resolveActiveGate({ renamePickFileId: fileId });
    },
    [resolveActiveGate]
  );

  const runNowAnyway = useCallback(() => {
    void resolveActiveGate({ forceScheduleOverride: true });
  }, [resolveActiveGate]);

  const approveExecute = useCallback(
    async (highRiskConfirm?: string) => {
      if (executingRef.current || !pendingPlan) return;
      const ws = workspaceId;
      if (ws == null) return;

      executingRef.current = true;
      setPhase('executing');
      setError(null);

      try {
        const sid = sessionIdRef.current || (await ensureSessionId());
        const res = await apiService.postAiFileManagerExecute({
          execution_token: pendingPlan.executionToken,
          plan_hash: pendingPlan.planHash,
          workspace_id: ws,
          session_id: sid,
          high_risk_confirm: highRiskConfirm,
        });

        if (res.success === false && !res.idempotent) {
          if (reportPlanLimit(res)) {
            setPhase('pending');
            return;
          }
          const msg = res.message || 'Execute failed';
          setError(msg);
          Toast.show({ type: 'error', text1: 'Execute failed', text2: msg });
          setPhase('pending');
          return;
        }

        const summary =
          res.result?.summary ||
          (res.idempotent ? 'Already applied (idempotent).' : 'Plan executed successfully.');
        setThread((prev) => [...prev, { role: 'assistant', content: summary }]);
        clearEphemeralFmState();
        setPhase('idle');
        await onExecuted?.();
        await refreshHistory();
      } catch (e: any) {
        if (reportPlanLimit(e)) {
          setPhase('pending');
          return;
        }
        const msg = e?.response?.data?.message || e?.message || 'Execute failed';
        if (e?.code === 'ECONNABORTED' || e?.message?.includes('timeout') || !e?.response) {
          setPhase('unknown');
          setError('Execution status unclear. Refresh history to continue.');
        } else {
          setError(msg);
          Toast.show({ type: 'error', text1: 'Execute failed', text2: msg });
          setPhase('pending');
        }
      } finally {
        executingRef.current = false;
      }
    },
    [pendingPlan, workspaceId, clearEphemeralFmState, onExecuted, refreshHistory]
  );

  const submitSchedule = useCallback(
    async (nextRunAt: string) => {
      const ws = workspaceId;
      if (ws == null || !lastPlanResponse) return;
      try {
        await apiService.postAiFileManagerSchedule({
          workspace_id: ws,
          query: lastUserMessage,
          next_run_at: nextRunAt,
          approved_file_count: lastPlanResponse.plan?.resolved_count,
          resolver_query: lastUserMessage,
        });
        Toast.show({ type: 'success', text1: 'Scheduled', text2: 'Large batch queued.' });
        await refreshScheduled();
        setGateDraft((d) => ({ ...d, forceScheduleOverride: undefined }));
      } catch (e: any) {
        Toast.show({
          type: 'error',
          text1: 'Schedule failed',
          text2: e?.response?.data?.message || e?.message,
        });
      }
    },
    [workspaceId, lastPlanResponse, lastUserMessage, refreshScheduled]
  );

  const abandonHistory = useCallback(
    async (historyId: number) => {
      try {
        await apiService.abandonAiFileManagerHistory(historyId);
        if (pendingPlan?.historyId === historyId) clearEphemeralFmState();
        await refreshHistory();
        Toast.show({ type: 'info', text1: 'Plan abandoned' });
      } catch (e: any) {
        Toast.show({ type: 'error', text1: 'Abandon failed', text2: e?.response?.data?.message });
      }
    },
    [pendingPlan, clearEphemeralFmState, refreshHistory]
  );

  const deleteHistoryRow = useCallback(
    async (historyId: number) => {
      try {
        await apiService.deleteAiFileManagerHistory(historyId);
        await refreshHistory();
      } catch (e: any) {
        Toast.show({ type: 'error', text1: 'Delete failed', text2: e?.response?.data?.message });
      }
    },
    [refreshHistory]
  );

  const undoHistory = useCallback(
    async (historyId: number) => {
      if (executingRef.current) return;
      executingRef.current = true;
      setPhase('undoing');
      try {
        await apiService.undoAiFileManagerHistory(historyId);
        Toast.show({ type: 'success', text1: 'Undone' });
        await onExecuted?.();
        await refreshHistory();
        setPhase('idle');
      } catch (e: any) {
        Toast.show({ type: 'error', text1: 'Undo failed', text2: e?.response?.data?.message });
        setPhase('idle');
      } finally {
        executingRef.current = false;
      }
    },
    [onExecuted, refreshHistory]
  );

  const resumeFromHistory = useCallback(
    (row: HistoryRow) => {
      if (!isPendingHistoryStatus(row.status)) {
        Toast.show({ type: 'info', text1: 'Cannot resume', text2: 'This plan is no longer pending.' });
        return;
      }
      if (!row.execution_token || !row.plan_hash) {
        Toast.show({ type: 'info', text1: 'Cannot resume', text2: 'No pending tokens on this row.' });
        return;
      }
      const ops = Array.isArray(row.operations) ? row.operations : [];
      if (ops.length === 0) {
        Toast.show({ type: 'info', text1: 'Cannot resume', text2: 'No operations on this plan.' });
        return;
      }
      if (
        row.workspace_id != null &&
        workspaceId != null &&
        Number(row.workspace_id) !== Number(workspaceId)
      ) {
        Toast.show({
          type: 'info',
          text1: 'Wrong workspace',
          text2: 'Switch to the workspace this plan was created in, then try again.',
        });
        return;
      }

      const queryText = (row.query || '').trim();
      const tel = parseAiFmTelemetry(row.telemetry);
      const restoredPlan = buildPlanFromHistoryRow({
        rephrased_plan: row.rephrased_plan,
        operations: row.operations,
        intent_confidence: row.intent_confidence,
        resolver_confidence: row.resolver_confidence,
        telemetry: tel,
      }) as AiFmPlanPayload;
      const preview = formatPlanPreview(restoredPlan);

      setGateQueue([]);
      setActiveGate(null);
      setGateDraft({});
      setLastPlanResponse(null);
      setError(null);

      setThread([
        ...(queryText ? [{ role: 'user' as const, content: queryText }] : []),
        {
          role: 'assistant' as const,
          content: preview,
          planPreview: preview,
          planFileLinks: restoredPlan.file_links,
        },
      ]);

      if (queryText) setLastUserMessage(queryText);
      setPendingPlan({
        executionToken: row.execution_token,
        planHash: row.plan_hash,
        historyId: row.id,
        plan: restoredPlan,
        requiresHighRiskConfirm: Boolean(tel.requires_high_risk_confirm),
        lastUserMessage: queryText || row.query,
      });
      setPhase('pending');
      Toast.show({
        type: 'info',
        text1: 'Plan restored',
        text2: 'Review the command view, then Run or Cancel plan.',
      });
    },
    [workspaceId]
  );

  const resolveUnknownFromHistory = useCallback(async () => {
    await refreshHistory();
    setPhase('idle');
    setError(null);
  }, [refreshHistory]);

  const pauseScheduled = useCallback(
    async (id: number) => {
      await apiService.patchAiFileManagerScheduled(id, 'paused');
      await refreshScheduled();
    },
    [refreshScheduled]
  );

  const resumeScheduled = useCallback(
    async (id: number) => {
      await apiService.patchAiFileManagerScheduled(id, 'active');
      await refreshScheduled();
    },
    [refreshScheduled]
  );

  const cancelScheduled = useCallback(
    async (id: number) => {
      await apiService.deleteAiFileManagerScheduled(id);
      await refreshScheduled();
    },
    [refreshScheduled]
  );

  return {
    phase,
    thread,
    gateQueue,
    activeGate: activeGate ?? gateQueue[0] ?? null,
    pendingPlan,
    lastPlanResponse,
    history,
    scheduled,
    config,
    sessionId,
    error,
    sendPlan,
    confirmScope,
    confirmFolderScope,
    confirmRenameBatch,
    pickRenameTarget,
    runNowAnyway,
    approveExecute,
    submitSchedule,
    abandonHistory,
    deleteHistoryRow,
    undoHistory,
    resumeFromHistory,
    refreshHistory,
    refreshScheduled,
    pauseScheduled,
    resumeScheduled,
    cancelScheduled,
    onSheetOpen,
    onSheetClose,
    clearEphemeralFmState,
    startNewCommand,
    resolveUnknownFromHistory,
    isCompletedHistoryStatus,
    isPendingHistoryStatus,
  };
}

export type UseAiFileManagerReturn = ReturnType<typeof useAiFileManager>;

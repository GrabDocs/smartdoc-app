import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useThemeColors } from '../../hooks/useThemeColors';
import { apiClient } from '../../services/api';

export type JoinRequestItem = {
  id: number;
  participant_name?: string | null;
  participant_email?: string | null;
  requested_at?: string | null;
  user?: {
    username?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
  } | null;
};

type Props = {
  visible: boolean;
  videoCallId: number | null;
  onClose: () => void;
  /** When true, poll every 5s while open (in-call host panel). */
  pollWhileVisible?: boolean;
  onCountChange?: (pendingCount: number) => void;
};

function displayName(req: JoinRequestItem): string {
  const u = req.user;
  if (u) {
    const full = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
    if (full) return full;
    if (u.username) return u.username;
    if (u.email) return u.email;
  }
  if (req.participant_name?.trim()) return req.participant_name.trim();
  if (req.participant_email?.trim()) return req.participant_email.trim();
  return 'Guest';
}

function subtitle(req: JoinRequestItem): string | null {
  const email = req.user?.email || req.participant_email;
  const name = displayName(req);
  if (email && email !== name) return email;
  return null;
}

export default function JoinRequestsManageModal({
  visible,
  videoCallId,
  onClose,
  pollWhileVisible = false,
  onCountChange,
}: Props) {
  const colors = useThemeColors();
  const [loading, setLoading] = useState(false);
  const [actingId, setActingId] = useState<number | null>(null);
  const [requests, setRequests] = useState<JoinRequestItem[]>([]);
  const [bulkActing, setBulkActing] = useState(false);
  const onCountChangeRef = useRef(onCountChange);
  onCountChangeRef.current = onCountChange;

  const load = useCallback(async () => {
    if (videoCallId == null) return;
    try {
      setLoading(true);
      const res = await apiClient.getJoinRequests(videoCallId);
      const list = Array.isArray(res?.join_requests) ? res.join_requests : [];
      setRequests(list as JoinRequestItem[]);
      onCountChangeRef.current?.(list.length);
    } catch (err: any) {
      // 403 = not a manager; keep empty
      setRequests([]);
      onCountChangeRef.current?.(0);
      if (visible) {
        const msg = err?.message || '';
        if (!/unauthorized|forbidden/i.test(msg)) {
          // Quiet on poll; only alert when user opened the modal intentionally
        }
      }
    } finally {
      setLoading(false);
    }
  }, [videoCallId, visible]);

  useEffect(() => {
    if (!visible || videoCallId == null) return;
    load();
  }, [visible, videoCallId, load]);

  useEffect(() => {
    if (!pollWhileVisible || !visible || videoCallId == null) return;
    const id = setInterval(() => {
      load();
    }, 5000);
    return () => clearInterval(id);
  }, [pollWhileVisible, visible, videoCallId, load]);

  const approve = async (joinRequestId: number) => {
    if (videoCallId == null) return;
    try {
      setActingId(joinRequestId);
      await apiClient.approveJoinRequest(videoCallId, joinRequestId);
      setRequests((prev) => prev.filter((r) => r.id !== joinRequestId));
      onCountChangeRef.current?.(Math.max(0, requests.length - 1));
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to approve join request');
    } finally {
      setActingId(null);
      load();
    }
  };

  const reject = async (joinRequestId: number) => {
    if (videoCallId == null) return;
    try {
      setActingId(joinRequestId);
      await apiClient.rejectJoinRequest(videoCallId, joinRequestId);
      setRequests((prev) => prev.filter((r) => r.id !== joinRequestId));
      onCountChangeRef.current?.(Math.max(0, requests.length - 1));
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to reject join request');
    } finally {
      setActingId(null);
      load();
    }
  };

  const approveAll = async () => {
    if (videoCallId == null || !requests.length) return;
    setBulkActing(true);
    try {
      for (const req of requests) {
        await apiClient.approveJoinRequest(videoCallId, req.id);
      }
      setRequests([]);
      onCountChangeRef.current?.(0);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to approve all');
      load();
    } finally {
      setBulkActing(false);
    }
  };

  const rejectAll = async () => {
    if (videoCallId == null || !requests.length) return;
    setBulkActing(true);
    try {
      for (const req of requests) {
        await apiClient.rejectJoinRequest(videoCallId, req.id);
      }
      setRequests([]);
      onCountChangeRef.current?.(0);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to reject all');
      load();
    } finally {
      setBulkActing(false);
    }
  };

  const styles = useMemo(
    () =>
      StyleSheet.create({
        overlay: {
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.45)',
          justifyContent: 'flex-end',
        },
        sheet: {
          backgroundColor: colors.card,
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          maxHeight: '75%',
          paddingBottom: 24,
        },
        header: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 16,
          paddingVertical: 14,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        },
        title: {
          fontSize: 17,
          fontWeight: '600',
          color: colors.text,
        },
        row: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingVertical: 14,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
          gap: 10,
        },
        nameCol: { flex: 1, minWidth: 0 },
        name: { fontSize: 16, fontWeight: '500', color: colors.text },
        email: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
        btn: {
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: 8,
        },
        approveBtn: { backgroundColor: '#34C759' },
        rejectBtn: { backgroundColor: '#FF3B30' },
        btnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
        empty: {
          padding: 28,
          alignItems: 'center',
        },
        emptyText: { color: colors.textSecondary, fontSize: 15 },
        bulkRow: {
          flexDirection: 'row',
          gap: 10,
          paddingHorizontal: 16,
          paddingTop: 12,
        },
        bulkBtn: {
          flex: 1,
          paddingVertical: 10,
          borderRadius: 8,
          alignItems: 'center',
        },
      }),
    [colors]
  );

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity style={styles.sheet} activeOpacity={1} onPress={(e) => e.stopPropagation()}>
          <View style={styles.header}>
            <Text style={styles.title}>Join request approvals</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {loading && requests.length === 0 ? (
            <View style={styles.empty}>
              <ActivityIndicator color="#007AFF" />
            </View>
          ) : requests.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No pending join requests</Text>
            </View>
          ) : (
            <>
              <ScrollView>
                {requests.map((req) => (
                  <View key={req.id} style={styles.row}>
                    <View style={styles.nameCol}>
                      <Text style={styles.name} numberOfLines={1}>
                        {displayName(req)}
                      </Text>
                      {subtitle(req) ? (
                        <Text style={styles.email} numberOfLines={1}>
                          {subtitle(req)}
                        </Text>
                      ) : null}
                    </View>
                    {actingId === req.id ? (
                      <ActivityIndicator size="small" color="#007AFF" />
                    ) : (
                      <>
                        <TouchableOpacity
                          style={[styles.btn, styles.approveBtn]}
                          onPress={() => approve(req.id)}
                          disabled={bulkActing}
                        >
                          <Text style={styles.btnText}>Accept</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.btn, styles.rejectBtn]}
                          onPress={() => reject(req.id)}
                          disabled={bulkActing}
                        >
                          <Text style={styles.btnText}>Reject</Text>
                        </TouchableOpacity>
                      </>
                    )}
                  </View>
                ))}
              </ScrollView>
              {requests.length > 1 ? (
                <View style={styles.bulkRow}>
                  <TouchableOpacity
                    style={[styles.bulkBtn, styles.approveBtn]}
                    onPress={approveAll}
                    disabled={bulkActing}
                  >
                    <Text style={styles.btnText}>{bulkActing ? '…' : 'Accept all'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.bulkBtn, styles.rejectBtn]}
                    onPress={rejectAll}
                    disabled={bulkActing}
                  >
                    <Text style={styles.btnText}>{bulkActing ? '…' : 'Reject all'}</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </>
          )}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

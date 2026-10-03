import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useThemeColors } from '../../hooks/useThemeColors';
import { shareErrorMessage, type ShareAccessAdapter, type ShareAccessSnapshot, type ShareRecipient } from './types';

type Props = {
  visible: boolean;
  adapter: ShareAccessAdapter | null;
  onClose: () => void;
};

/**
 * Renders only the sections this adapter implements.
 * getShareUrl does not imply people, general access, or email.
 */
export default function ShareAccessSheet({ visible, adapter, onClose }: Props) {
  const colors = useThemeColors();
  const [snapshot, setSnapshot] = useState<ShareAccessSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [manage, setManage] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ShareRecipient[]>([]);
  const [emailDraft, setEmailDraft] = useState('');
  const pendingRef = useRef<string | null>(null);
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;

  const reload = useCallback(async (afterMutation: boolean) => {
    const current = adapterRef.current;
    if (!current) return;
    try {
      const next = await current.getState();
      setSnapshot(next);
      setLoadError(null);
      setRefreshError(null);
    } catch (error) {
      const message = shareErrorMessage(error, "Couldn't refresh access");
      if (afterMutation) {
        setRefreshError("Couldn't refresh access");
        setActionError(message === "Couldn't refresh access" ? null : message);
      } else {
        setSnapshot(null);
        setLoadError(message);
      }
    }
  }, []);

  useEffect(() => {
    if (!visible || !adapter) return;
    let alive = true;
    setManage(false);
    setSnapshot(null);
    setLoadError(null);
    setRefreshError(null);
    setActionError(null);
    setQuery('');
    setResults([]);
    setLoading(true);
    adapter
      .getState()
      .then((next) => {
        if (!alive) return;
        setSnapshot(next);
      })
      .catch((error) => {
        if (!alive) return;
        setLoadError(shareErrorMessage(error, 'Could not load access'));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [visible]);

  const run = async (key: string, work: () => Promise<void>, reloadAfter = true) => {
    if (pendingRef.current) return;
    pendingRef.current = key;
    setPending(key);
    setActionError(null);
    try {
      await work();
      if (reloadAfter) await reload(true);
    } catch (error) {
      setActionError(shareErrorMessage(error, 'Could not update access'));
    } finally {
      pendingRef.current = null;
      setPending(null);
    }
  };

  const showPeople = !!snapshot?.people && (!!adapter?.addPeople || !!adapter?.updatePersonRole || !!adapter?.removePerson || snapshot.people.length > 0);
  const showAdd = !!adapter?.addPeople && !!adapter?.searchPeople;
  const showChoices = !!snapshot?.choices?.length && !!adapter?.setChoice;
  const showLink = !!adapter?.getShareUrl && !!snapshot?.shareUrl;
  const showEmail = !!adapter?.sendLinkEmail && !!snapshot?.shareUrl;

  const copyLink = () => {
    const current = adapterRef.current;
    if (!current?.getShareUrl || pendingRef.current) return;
    void run(
      'copy',
      async () => {
        const url = await current.getShareUrl!();
        if (!url) throw new Error('No share link yet.');
        await Clipboard.setStringAsync(url);
      },
      false
    );
  };

  /** Send link hands the URL to the OS share sheet. It does not change access. */
  const sendLink = () => {
    const current = adapterRef.current;
    if (!current?.getShareUrl || pendingRef.current) return;
    void run(
      'send',
      async () => {
        const url = await current.getShareUrl!();
        if (!url) throw new Error('No share link yet.');
        try {
          await Share.share({ message: url, url });
        } catch (error) {
          const message = shareErrorMessage(error, '');
          if (/did not share|cancel|dismiss/i.test(message)) return;
          throw error;
        }
      },
      false
    );
  };

  const styles = StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
    sheet: {
      maxHeight: '92%',
      backgroundColor: colors.background,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      paddingBottom: 24,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 8,
      paddingTop: 12,
      paddingBottom: 8,
    },
    title: { flex: 1, fontSize: 18, fontWeight: '700', color: colors.text },
    body: { paddingHorizontal: 16, paddingBottom: 12 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    name: { fontSize: 16, color: colors.text, fontWeight: '600' },
    detail: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
    input: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      color: colors.text,
      fontSize: 16,
      paddingVertical: 10,
    },
    button: { paddingVertical: 12 },
    buttonText: { color: colors.tint, fontSize: 16, fontWeight: '600' },
    error: { color: '#F87171', fontSize: 14, marginBottom: 8 },
    note: { color: colors.textSecondary, fontSize: 13, marginBottom: 8 },
  });

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            {manage ? (
              <TouchableOpacity onPress={() => setManage(false)} accessibilityLabel="Back" style={{ padding: 8 }}>
                <Ionicons name="chevron-back" size={22} color={colors.text} />
              </TouchableOpacity>
            ) : (
              <TouchableOpacity onPress={onClose} accessibilityLabel="Close" style={{ padding: 8 }}>
                <Ionicons name="close" size={22} color={colors.text} />
              </TouchableOpacity>
            )}
            <Text style={styles.title}>{manage ? 'Manage access' : 'Share'}</Text>
          </View>
          {loading ? (
            <ActivityIndicator style={{ margin: 24 }} color={colors.tint} />
          ) : loadError ? (
            <View style={styles.body}>
              <Text style={styles.error}>{loadError}</Text>
              <TouchableOpacity
                onPress={() => {
                  setLoading(true);
                  setLoadError(null);
                  void reload(false).finally(() => setLoading(false));
                }}
                style={styles.button}
              >
                <Text style={styles.buttonText}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
              {snapshot?.title ? <Text style={styles.note}>{snapshot.title}</Text> : null}
              {refreshError ? (
                <View>
                  <Text style={styles.error}>{refreshError}</Text>
                  <TouchableOpacity onPress={() => void reload(false)} style={styles.button}>
                    <Text style={styles.buttonText}>Retry</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
              {actionError ? <Text style={styles.error}>{actionError}</Text> : null}
              {snapshot?.readOnlyNote ? <Text style={styles.note}>{snapshot.readOnlyNote}</Text> : null}
              {!manage && showAdd ? (
                <View>
                  <TextInput
                    value={query}
                    onChangeText={(value) => {
                      setQuery(value);
                      const search = adapter?.searchPeople;
                      if (!search || value.trim().length < 2) {
                        setResults([]);
                        return;
                      }
                      void search(value)
                        .then(setResults)
                        .catch(() => setResults([]));
                    }}
                    placeholder="Add people"
                    placeholderTextColor={colors.textSecondary}
                    style={styles.input}
                    autoCapitalize="none"
                    editable={!pending}
                  />
                  {results.map((person) => (
                    <TouchableOpacity
                      key={`${person.userId || person.email}`}
                      style={styles.row}
                      disabled={!!pending}
                      onPress={() =>
                        void run('add', async () => {
                          await adapter!.addPeople!([person], adapter?.personRoles?.()[0]?.id);
                          setQuery('');
                          setResults([]);
                        })
                      }
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={styles.name}>{person.label}</Text>
                        {person.detail ? <Text style={styles.detail}>{person.detail}</Text> : null}
                      </View>
                      <Text style={styles.buttonText}>Add</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : null}
              {!manage && (showChoices || showPeople) ? (
                <TouchableOpacity style={styles.row} onPress={() => setManage(true)}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name}>Manage access</Text>
                    <Text style={styles.detail}>Who can use this</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
                </TouchableOpacity>
              ) : null}
              {(manage ? snapshot?.people : snapshot?.people?.slice(0, 3))?.map((person) => (
                <View key={person.id} style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name}>{person.name}</Text>
                    {person.detail ? <Text style={styles.detail}>{person.detail}</Text> : null}
                  </View>
                  {manage && person.canChangeRole && adapter?.updatePersonRole ? (
                    <TouchableOpacity
                      disabled={!!pending}
                      onPress={() => {
                        const roles = adapter.personRoles?.() || [];
                        Alert.alert(
                          person.name,
                          undefined,
                          [
                            ...roles.map((role) => ({
                              text: role.label,
                              onPress: () => void run(`role-${person.id}`, () => adapter.updatePersonRole!(person.id, role.id)),
                            })),
                            { text: 'Cancel', style: 'cancel' as const },
                          ]
                        );
                      }}
                    >
                      <Text style={styles.buttonText}>{person.roleLabel}</Text>
                    </TouchableOpacity>
                  ) : (
                    <Text style={styles.detail}>{person.roleLabel}</Text>
                  )}
                  {manage && person.canRemove && adapter?.removePerson ? (
                    <TouchableOpacity
                      disabled={!!pending}
                      onPress={() =>
                        Alert.alert('Remove access', `Remove ${person.name}?`, [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Remove',
                            style: 'destructive',
                            onPress: () => void run(`remove-${person.id}`, () => adapter.removePerson!(person.id)),
                          },
                        ])
                      }
                      style={{ marginLeft: 12 }}
                    >
                      <Ionicons name="close" size={18} color={colors.textSecondary} />
                    </TouchableOpacity>
                  ) : null}
                </View>
              ))}
              {manage && showChoices
                ? snapshot!.choices!.map((choice) => (
                    <View key={choice.id} style={{ paddingVertical: 12 }}>
                      <Text style={styles.name}>{choice.label}</Text>
                      {choice.detail ? <Text style={styles.detail}>{choice.detail}</Text> : null}
                      {choice.options.map((option) => {
                        const selected = option.id === choice.value;
                        return (
                          <TouchableOpacity
                            key={option.id}
                            disabled={!!pending || selected}
                            style={styles.row}
                            onPress={() => {
                              const apply = () => void run(`${choice.id}-${option.id}`, () => adapter.setChoice!(choice.id, option.id));
                              if (option.confirm) {
                                Alert.alert(choice.label, option.confirm, [
                                  { text: 'Cancel', style: 'cancel' },
                                  { text: 'Continue', style: 'destructive', onPress: apply },
                                ]);
                              } else {
                                apply();
                              }
                            }}
                          >
                            <Ionicons
                              name={selected ? 'checkmark-circle' : 'ellipse-outline'}
                              size={18}
                              color={selected ? colors.tint : colors.textSecondary}
                              style={{ marginRight: 10 }}
                            />
                            <View style={{ flex: 1 }}>
                              <Text style={styles.name}>{option.label}</Text>
                              {option.detail ? <Text style={styles.detail}>{option.detail}</Text> : null}
                            </View>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  ))
                : null}
              {showLink ? (
                <View style={{ flexDirection: 'row', gap: 16 }}>
                  <TouchableOpacity onPress={() => void copyLink()} disabled={!!pending} style={styles.button}>
                    <Text style={styles.buttonText}>{pending === 'copy' ? 'Copied' : 'Copy link'}</Text>
                  </TouchableOpacity>
                  {Platform.OS !== 'web' ? (
                    <TouchableOpacity onPress={() => void sendLink()} disabled={!!pending} style={styles.button}>
                      <Text style={styles.buttonText}>Send link</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              ) : null}
              {showEmail ? (
                <View>
                  <TextInput
                    value={emailDraft}
                    onChangeText={setEmailDraft}
                    placeholder="Email the link"
                    placeholderTextColor={colors.textSecondary}
                    style={styles.input}
                    autoCapitalize="none"
                    editable={!pending}
                  />
                  <TouchableOpacity
                    style={styles.button}
                    disabled={!!pending}
                    onPress={() =>
                      void run('email', async () => {
                        const emails = emailDraft
                          .split(/[,\s]+/)
                          .map((item) => item.trim())
                          .filter((item) => item.includes('@'));
                        if (!emails.length) throw new Error('Enter at least one email address.');
                        await adapter!.sendLinkEmail!(emails);
                        setEmailDraft('');
                      })
                    }
                  >
                    <Text style={styles.buttonText}>Email link</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
              {pending ? <ActivityIndicator color={colors.tint} style={{ marginTop: 8 }} /> : null}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

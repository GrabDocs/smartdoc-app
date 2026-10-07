import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Modal,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
  type KeyboardEvent,
} from 'react-native';
import { useThemeColors } from '../../hooks/useThemeColors';
import { shareErrorMessage, type ShareAccessAdapter, type ShareAccessSnapshot, type ShareRecipient } from './types';

type Props = {
  visible: boolean;
  adapter: ShareAccessAdapter | null;
  onClose: () => void;
  /** Shown at the bottom when one link covers more than one file. */
  listedFiles?: { id: number; name: string }[];
};

function parseShareEmails(raw: string): string[] {
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const part of raw.split(/[,;\s]+/)) {
    const email = part.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    emails.push(email);
  }
  return emails;
}

/**
 * Renders only the sections this adapter implements.
 * getShareUrl does not imply people, general access, or email.
 */
export default function ShareAccessSheet({ visible, adapter, onClose, listedFiles }: Props) {
  const colors = useThemeColors();
  const { height: windowHeight } = useWindowDimensions();
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
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const [keyboardLift, setKeyboardLift] = useState(0);
  const pendingRef = useRef<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const sheetRef = useRef<View>(null);
  const emailFocusedRef = useRef(false);
  const keyboardLiftRef = useRef(0);
  const copyNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    setEmailDraft('');
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

  useEffect(() => {
    if (!visible) {
      keyboardLiftRef.current = 0;
      setKeyboardLift(0);
      return;
    }
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const liftSheet = (event: KeyboardEvent) => {
      const height = event.endCoordinates?.height ?? 0;
      const screenY = event.endCoordinates?.screenY;
      const node = sheetRef.current;
      const apply = (overlap: number) => {
        keyboardLiftRef.current = overlap;
        setKeyboardLift(overlap);
        if (emailFocusedRef.current) {
          setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
        }
      };
      if (!node || typeof screenY !== 'number') {
        apply(height);
        return;
      }
      node.measureInWindow((_x, y, _w, h) => {
        const restingBottom = y + h + keyboardLiftRef.current;
        const overlap = h > 0 && screenY > 0 ? Math.max(0, Math.round(restingBottom - screenY)) : height;
        apply(overlap);
      });
    };
    const showSub = Keyboard.addListener(showEvent, liftSheet);
    const hideSub = Keyboard.addListener(hideEvent, () => {
      keyboardLiftRef.current = 0;
      setKeyboardLift(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [visible]);

  useEffect(() => {
    if (visible) return;
    if (copyNoteTimer.current) clearTimeout(copyNoteTimer.current);
    setCopyNote(null);
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

  const showCopyNote = (message: string) => {
    if (copyNoteTimer.current) clearTimeout(copyNoteTimer.current);
    setCopyNote(message);
    copyNoteTimer.current = setTimeout(() => setCopyNote(null), 1600);
  };

  const copyLink = async () => {
    const current = adapterRef.current;
    if (!current?.getShareUrl) return;
    try {
      const url = snapshot?.shareUrl || (await current.getShareUrl());
      if (!url) throw new Error('No share link yet.');
      await Clipboard.setStringAsync(url);
      showCopyNote('Link copied');
    } catch (error) {
      showCopyNote(shareErrorMessage(error, 'Could not copy link'));
    }
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
    emailInput: {
      marginTop: 8,
      minHeight: 72,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      color: colors.text,
      fontSize: 16,
    },
    emailHint: { marginTop: 6 },
    emailButtonWrap: { paddingHorizontal: 16, paddingBottom: 4 },
    fileList: {
      borderTopWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 4,
    },
    fileListScroll: { maxHeight: 140 },
    emailButton: {
      marginTop: 4,
      backgroundColor: colors.tint,
      borderRadius: 10,
      paddingVertical: 14,
      alignItems: 'center',
    },
    emailButtonDisabled: { opacity: 0.5 },
    emailButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
    optionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
    optionButton: {
      flexGrow: 1,
      flexBasis: '28%',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 10,
      paddingHorizontal: 8,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
    },
    optionButtonSelected: { backgroundColor: colors.tint, borderColor: colors.tint },
    optionButtonText: { fontSize: 15, fontWeight: '600', color: colors.text, textAlign: 'center' },
    optionButtonTextSelected: { color: '#fff' },
    error: { color: '#F87171', fontSize: 14, marginBottom: 8 },
    note: { color: colors.textSecondary, fontSize: 13, marginBottom: 8 },
    copyNote: {
      position: 'absolute',
      top: 56,
      alignSelf: 'center',
      zIndex: 2,
      backgroundColor: colors.text,
      borderRadius: 999,
      paddingVertical: 8,
      paddingHorizontal: 14,
    },
    copyNoteText: { color: colors.background, fontSize: 14, fontWeight: '600' },
  });

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View
          ref={sheetRef}
          style={[
            styles.sheet,
            keyboardLift > 0 && {
              marginBottom: keyboardLift,
              maxHeight: Math.max(280, windowHeight - keyboardLift - 8),
              paddingBottom: 12,
            },
          ]}
        >
          <View style={styles.header}>
            {manage ? (
              <TouchableOpacity onPress={() => setManage(false)} accessibilityLabel="Back" style={{ padding: 8 }}>
                <Ionicons name="chevron-back" size={22} color={colors.text} />
              </TouchableOpacity>
            ) : null}
            <Text style={styles.title}>{manage ? 'Manage access' : 'Share'}</Text>
            <TouchableOpacity onPress={onClose} accessibilityLabel="Close" style={{ padding: 8 }}>
              <Ionicons name="close" size={22} color={colors.text} />
            </TouchableOpacity>
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
            <ScrollView
              ref={scrollRef}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.body}
              style={{ flexShrink: 1 }}
            >
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
                      {choice.id === 'link-role' ? (
                        <View style={styles.optionRow}>
                          {choice.options.map((option) => {
                            const selected = option.id === choice.value;
                            return (
                              <TouchableOpacity
                                key={option.id}
                                disabled={!!pending || selected}
                                style={[styles.optionButton, selected && styles.optionButtonSelected]}
                                onPress={() =>
                                  void run(`${choice.id}-${option.id}`, () => adapter.setChoice!(choice.id, option.id))
                                }
                              >
                                <Text style={[styles.optionButtonText, selected && styles.optionButtonTextSelected]}>
                                  {option.label}
                                </Text>
                              </TouchableOpacity>
                            );
                          })}
                        </View>
                      ) : (
                        choice.options.map((option) => {
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
                        })
                      )}
                    </View>
                  ))
                : null}
              {showLink ? (
                <View style={{ flexDirection: 'row', gap: 16 }}>
                  <TouchableOpacity onPress={() => void copyLink()} style={styles.button}>
                    <Text style={styles.buttonText}>Copy link</Text>
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
                  <Text style={styles.name}>Email the link</Text>
                  <TextInput
                    value={emailDraft}
                    onChangeText={(value) => {
                      setEmailDraft(value);
                      if (emailFocusedRef.current && keyboardLiftRef.current > 0) {
                        setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 30);
                      }
                    }}
                    placeholder="name@email.com, another@email.com"
                    placeholderTextColor={colors.textSecondary}
                    style={styles.emailInput}
                    autoCapitalize="none"
                    autoCorrect={false}
                    multiline
                    textAlignVertical="top"
                    blurOnSubmit={false}
                    editable={!pending}
                    onFocus={() => {
                      emailFocusedRef.current = true;
                      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
                    }}
                    onBlur={() => {
                      emailFocusedRef.current = false;
                    }}
                  />
                  <Text style={[styles.detail, styles.emailHint]}>
                    Separate multiple addresses with commas or new lines.
                  </Text>
                </View>
              ) : null}
              {pending ? <ActivityIndicator color={colors.tint} style={{ marginTop: 8 }} /> : null}
            </ScrollView>
          )}
          {!loading && !loadError && showEmail ? (
            <View style={styles.emailButtonWrap}>
              <TouchableOpacity
                style={[styles.emailButton, (!!pending || !emailDraft.trim()) && styles.emailButtonDisabled]}
                disabled={!!pending || !emailDraft.trim()}
                onPress={() =>
                  void run('email', async () => {
                    const emails = parseShareEmails(emailDraft);
                    if (!emails.length) throw new Error('Enter at least one email address.');
                    await adapter!.sendLinkEmail!(emails);
                    setEmailDraft('');
                  })
                }
              >
                <Text style={styles.emailButtonText}>{pending === 'email' ? 'Sending…' : 'Email link'}</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          {listedFiles && listedFiles.length > 1 ? (
            <View style={[styles.fileList, { borderTopColor: colors.border }]}>
              <Text style={styles.detail}>{listedFiles.length} files</Text>
              <ScrollView style={styles.fileListScroll} nestedScrollEnabled>
                {listedFiles.map((file) => (
                  <Text key={file.id} style={styles.name} numberOfLines={1}>
                    {file.name}
                  </Text>
                ))}
              </ScrollView>
            </View>
          ) : null}
          {copyNote ? (
            <View pointerEvents="none" style={styles.copyNote}>
              <Text style={styles.copyNoteText}>{copyNote}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import { useNavigation, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AppBackButton from '../components/AppBackButton';
import AppHeaderTitle from '../components/AppHeaderTitle';
import { useThemeColors } from '../hooks/useThemeColors';
import { calendarImportIcsEvent } from '../services/calendarApi';
import { apiService } from '../services/api';
import { uploadDocumentForFillable, uploadIncomingDocuments } from '../services/uploadWithGlobalProgress';
import { markIncomingAskWait } from '../utils/incomingAskWait';
import {
  canSignOrFill,
  clearIncomingImport,
  peekIncomingImport,
  type IncomingFile,
  type IncomingImportPayload,
} from '../utils/incomingImport';
import { parseIcsEvents, type ParsedIcsEvent } from '../utils/parseIcs';
import { hubFillEditorRoute, hubPrepareEditorRoute } from '../utils/signatureRouteResolver';
import { useAuth } from './context/auth';

type WorkspaceChoice = { id: number; name: string };

const autoSavedImportIds = new Set<number>();

export default function IncomingImportScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const dismissing = useRef(false);
  const colors = useThemeColors();
  const { user, loading: authLoading } = useAuth();
  const [payload, setPayload] = useState<IncomingImportPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceChoice[]>([]);
  const [workspacesReady, setWorkspacesReady] = useState(false);
  const [workspaceId, setWorkspaceId] = useState<number | null>(null);
  const [events, setEvents] = useState<ParsedIcsEvent[]>([]);

  const documents = payload?.files.filter((file) => file.kind === 'document') ?? [];
  const calendars = payload?.files.filter((file) => file.kind === 'calendar') ?? [];
  const singleDocument = documents.length === 1 && calendars.length === 0 ? documents[0] : null;
  const calendarOnly = calendars.length > 0 && documents.length === 0;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await peekIncomingImport();
      if (cancelled) return;
      setPayload(stored);
      if (stored && stored.files.some((file) => file.kind === 'calendar')) {
        const parsed: ParsedIcsEvent[] = [];
        for (const file of stored.files) {
          if (file.kind !== 'calendar') continue;
          const raw = await FileSystem.readAsStringAsync(file.uri);
          parsed.push(...parseIcsEvents(raw));
        }
        if (!cancelled) setEvents(parsed);
      }
      setLoading(false);
    })().catch(() => setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setWorkspacesReady(false);
    apiService.getMobileWorkspaces(50, 0).then((response) => {
      if (cancelled) return;
      const rows = Array.isArray(response.data) ? response.data : (response.data?.workspaces || []);
      const choices = (rows as Array<{ id?: number; name?: string }>)
        .filter((row) => typeof row.id === 'number')
        .map((row) => ({ id: row.id as number, name: row.name || `Workspace ${row.id}` }));
      setWorkspaces(choices);
      if (choices.length === 1) setWorkspaceId(choices[0].id);
    }).catch(() => {}).finally(() => {
      if (!cancelled) setWorkspacesReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const styles = useMemo(() => StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.background },
    header: { flexDirection: 'row', alignItems: 'center', padding: 12, backgroundColor: colors.headerBackground },
    body: { padding: 20, gap: 12 },
    title: { fontSize: 20, fontWeight: '700', color: colors.text },
    sub: { fontSize: 14, color: colors.textSecondary, lineHeight: 20 },
    option: {
      borderWidth: 1,
      borderColor: colors.border ?? '#E5E7EB',
      borderRadius: 14,
      padding: 16,
      backgroundColor: colors.card,
    },
    optionTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
    optionDesc: { fontSize: 13, color: colors.textSecondary, marginTop: 4 },
    chip: {
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border ?? '#E5E7EB',
      paddingHorizontal: 12,
      paddingVertical: 8,
      marginRight: 8,
      marginBottom: 8,
    },
    chipOn: { borderColor: colors.primary, backgroundColor: `${colors.primary}18` },
  }), [colors]);

  const leave = async () => {
    dismissing.current = true;
    await clearIncomingImport();
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)' as any);
  };

  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (event) => {
      if (!user || dismissing.current) return;
      const type = event.data.action.type;
      if (type !== 'GO_BACK' && type !== 'POP') return;
      event.preventDefault();
      dismissing.current = true;
      void clearIncomingImport().finally(() => {
        navigation.dispatch(event.data.action);
      });
    });
    return unsubscribe;
  }, [navigation, user]);

  const chosenWorkspace = workspaces.length > 1 ? workspaceId ?? undefined : workspaces[0]?.id;

  const requireWorkspace = () => {
    if (workspaces.length > 1 && !chosenWorkspace) {
      Alert.alert('Choose a workspace', 'Pick where this should be saved.');
      return false;
    }
    return true;
  };

  const run = async (label: string, task: () => Promise<void>) => {
    if (!requireWorkspace()) return;
    setBusy(label);
    try {
      await task();
      await clearIncomingImport();
    } catch (error: any) {
      Alert.alert('Could not finish', error?.message || 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  };

  const saveDocuments = (files: IncomingFile[]) => run('Saving…', async () => {
    await uploadIncomingDocuments(files, chosenWorkspace);
    router.replace('/(tabs)/documents' as any);
  });

  const saveEvents = async (rows: ParsedIcsEvent[]) => {
    for (const event of rows) {
      await calendarImportIcsEvent({
        title: event.title,
        description: event.description,
        location: event.location || undefined,
        meeting_url: event.meetingUrl,
        start_time: event.startIso,
        end_time: event.endIso,
        timezone: event.timezone,
        all_day: event.allDay,
        external_ical_uid: event.uid,
        workspace_id: chosenWorkspace,
      });
    }
  };

  useEffect(() => {
    if (!user || !workspacesReady || loading || !payload) return;
    if (calendars.length > 0 || documents.length <= 1) return;
    if (workspaces.length > 1) return;
    if (autoSavedImportIds.has(payload.createdAt)) return;
    autoSavedImportIds.add(payload.createdAt);
    saveDocuments(documents);
  }, [user, workspacesReady, loading, payload, calendars.length, documents.length, workspaces.length]);

  if (loading || authLoading || (user && !workspacesReady)) {
    return (
      <SafeAreaView style={styles.safe}>
        <ActivityIndicator style={{ marginTop: 48 }} color={colors.primary} />
      </SafeAreaView>
    );
  }

  if (!user) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.header}>
          <AppBackButton />
          <AppHeaderTitle>GrabDocs</AppHeaderTitle>
        </View>
        <View style={styles.body}>
          <Text style={styles.title}>Sign in to continue</Text>
          <Text style={styles.sub}>The file is kept on this phone until you sign in.</Text>
          <TouchableOpacity style={styles.option} onPress={() => router.push('/(auth)/sign-in' as any)}>
            <Text style={styles.optionTitle}>Sign in</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (!payload?.files.length) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.header}>
          <AppBackButton onPress={() => { void leave(); }} />
          <AppHeaderTitle>GrabDocs</AppHeaderTitle>
        </View>
        <View style={styles.body}>
          <Text style={styles.sub}>Nothing to import.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <AppBackButton onPress={() => { void leave(); }} />
        <AppHeaderTitle>{calendarOnly ? 'Save events' : 'Open in GrabDocs'}</AppHeaderTitle>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        {busy ? (
          <View style={{ alignItems: 'center', paddingVertical: 24 }}>
            <ActivityIndicator color={colors.primary} />
            <Text style={[styles.sub, { marginTop: 12 }]}>{busy}</Text>
          </View>
        ) : null}

        {!busy && workspaces.length > 1 ? (
          <View>
            <Text style={styles.optionTitle}>Workspace</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 8 }}>
              {workspaces.map((workspace) => (
                <TouchableOpacity
                  key={workspace.id}
                  style={[styles.chip, workspaceId === workspace.id && styles.chipOn]}
                  onPress={() => setWorkspaceId(workspace.id)}
                >
                  <Text style={{ color: colors.text }}>{workspace.name}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ) : null}

        {!busy && calendarOnly ? (
          <>
            <Text style={styles.sub}>
              {events.length === 0
                ? 'This calendar file has no events.'
                : `${events.length} event${events.length === 1 ? '' : 's'} will be saved to your GrabDocs calendar. Saving the same invite again updates that event.`}
            </Text>
            {events.map((event, index) => (
              <View key={`${event.uid}-${index}`} style={styles.option}>
                <Text style={styles.optionTitle}>{event.title}</Text>
                <Text style={styles.optionDesc}>{new Date(event.startIso).toLocaleString()}</Text>
              </View>
            ))}
            {events.length > 0 ? (
              <TouchableOpacity
                style={styles.option}
                onPress={() => run('Saving events…', async () => {
                  await saveEvents(events);
                  router.replace('/calendar' as any);
                })}
              >
                <Text style={styles.optionTitle}>Save to calendar</Text>
              </TouchableOpacity>
            ) : null}
          </>
        ) : null}

        {!busy && documents.length > 0 && calendars.length > 0 ? (
          <>
            <Text style={styles.sub}>
              {documents.length} document{documents.length === 1 ? '' : 's'}
              {events.length > 0
                ? ` and ${events.length} event${events.length === 1 ? '' : 's'}`
                : ''} will be saved.
            </Text>
            {events.map((event, index) => (
              <View key={`${event.uid}-${index}`} style={styles.option}>
                <Text style={styles.optionTitle}>{event.title}</Text>
                <Text style={styles.optionDesc}>{new Date(event.startIso).toLocaleString()}</Text>
              </View>
            ))}
            <TouchableOpacity
              style={styles.option}
              onPress={() => run('Saving…', async () => {
                if (events.length > 0) await saveEvents(events);
                if (documents.length > 0) await uploadIncomingDocuments(documents, chosenWorkspace);
                router.replace((events.length > 0 ? '/calendar' : '/(tabs)/documents') as any);
              })}
            >
              <Text style={styles.optionTitle}>Save</Text>
            </TouchableOpacity>
          </>
        ) : null}

        {!busy && calendars.length === 0 && documents.length > 1 ? (
          <>
            <Text style={styles.sub}>{documents.length} documents will be saved.</Text>
            <TouchableOpacity style={styles.option} onPress={() => saveDocuments(documents)}>
              <Text style={styles.optionTitle}>Save to documents</Text>
            </TouchableOpacity>
          </>
        ) : null}

        {!busy && singleDocument ? (
          <>
            <Text style={styles.title}>{singleDocument.name}</Text>
            <TouchableOpacity style={styles.option} onPress={() => saveDocuments([singleDocument])}>
              <Text style={styles.optionTitle}>Save to documents</Text>
              <Text style={styles.optionDesc}>Store it, then classify and process it.</Text>
            </TouchableOpacity>
            {canSignOrFill(singleDocument) ? (
              <>
                <TouchableOpacity
                  style={styles.option}
                  onPress={() => run('Uploading…', async () => {
                    const result = await uploadDocumentForFillable(singleDocument, { workspaceId: chosenWorkspace });
                    router.replace(hubPrepareEditorRoute(result.templateId) as any);
                  })}
                >
                  <Text style={styles.optionTitle}>Prepare for Signature</Text>
                  <Text style={styles.optionDesc}>Place fields and send it to others to sign.</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.option}
                  onPress={() => run('Uploading…', async () => {
                    const result = await uploadDocumentForFillable(singleDocument, { workspaceId: chosenWorkspace });
                    router.replace(hubFillEditorRoute(result.templateId) as any);
                  })}
                >
                  <Text style={styles.optionTitle}>Fill a document</Text>
                  <Text style={styles.optionDesc}>Complete this document yourself.</Text>
                </TouchableOpacity>
              </>
            ) : null}
            <TouchableOpacity
              style={styles.option}
              onPress={() => run('Uploading this document…', async () => {
                const ids = await uploadIncomingDocuments([singleDocument], chosenWorkspace);
                const fileId = ids[0];
                if (!fileId) throw new Error('Upload finished but the document is not ready yet.');
                await markIncomingAskWait(fileId);
                router.replace({
                  pathname: '/(tabs)/chats',
                  params: {
                    documentId: String(fileId),
                    documentName: singleDocument.name,
                    incomingAsk: '1',
                  },
                } as any);
              })}
            >
              <Text style={styles.optionTitle}>Ask about this document</Text>
              <Text style={styles.optionDesc}>Saves the document, then you can ask about it.</Text>
            </TouchableOpacity>
          </>
        ) : null}

        {!busy && !calendarOnly && !singleDocument && documents.length === 0 ? (
          <Text style={styles.sub}>GrabDocs can open PDF, Word, Excel, PowerPoint, and calendar files.</Text>
        ) : null}

        <TouchableOpacity onPress={() => { void leave(); }} style={{ paddingVertical: 8 }}>
          <Text style={{ color: colors.textSecondary }}>
            <Ionicons name="close" size={14} /> Close
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

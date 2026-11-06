import { useRouter, useSegments } from 'expo-router';
import * as Linking from 'expo-linking';
import { useShareIntentContext } from 'expo-share-intent';
import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { copyIncomingFile, displayNameFromIncomingUrl, peekIncomingImport, saveIncomingImport } from '../../utils/incomingImport';
import { useAuth } from '../../app/context/auth';

const REJECTED_COPY = 'GrabDocs opens PDF, Word, Excel, PowerPoint, and calendar files.';

/**
 * Copies a shared or opened document into app storage and opens the import screen.
 * Share-sheet files come from expo-share-intent. Open With arrives as a file or content URL.
 */
export default function IncomingShareBridge() {
  const router = useRouter();
  const segments = useSegments();
  const { user, loading } = useAuth();
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const handledShare = useRef<string>('');
  const handledOpen = useRef<string>('');
  const routedPendingAt = useRef<number>(0);

  useEffect(() => {
    if (!hasShareIntent || !shareIntent.files?.length) return;
    const key = shareIntent.files.map((file) => file.path).join('|');
    if (!key || handledShare.current === key) return;
    handledShare.current = key;
    void (async () => {
      const copied = [];
      for (const file of shareIntent.files || []) {
        if (!file.path) continue;
        const saved = await copyIncomingFile(file.path, file.fileName || 'document', file.mimeType);
        if (saved) copied.push(saved);
      }
      resetShareIntent(true);
      if (!copied.length) {
        Alert.alert('Not a document', REJECTED_COPY);
        return;
      }
      const payload = await saveIncomingImport(copied);
      if (!loading && user) {
        routedPendingAt.current = payload.createdAt;
        router.push('/incoming-import' as any);
      }
    })().catch(() => {
      handledShare.current = '';
    });
  }, [hasShareIntent, shareIntent, resetShareIntent, loading, user, router]);

  useEffect(() => {
    const take = async (url: string | null) => {
      if (!url || url.includes('dataUrl=')) return;
      const lower = url.toLowerCase();
      if (!lower.startsWith('file://') && !lower.startsWith('content://')) return;
      if (handledOpen.current === url) return;
      handledOpen.current = url;
      const saved = await copyIncomingFile(url, displayNameFromIncomingUrl(url));
      if (!saved) {
        Alert.alert('Not a document', REJECTED_COPY);
        return;
      }
      const payload = await saveIncomingImport([saved]);
      if (!loading && user) {
        routedPendingAt.current = payload.createdAt;
        router.push('/incoming-import' as any);
      }
    };
    void Linking.getInitialURL().then(take).catch(() => {});
    const sub = Linking.addEventListener('url', ({ url }) => {
      void take(url);
    });
    return () => sub.remove();
  }, [loading, user, router]);

  useEffect(() => {
    if (loading || !user) return;
    if (segments.some((part) => String(part) === 'incoming-import')) return;
    void peekIncomingImport().then((pending) => {
      if (!pending?.files.length) return;
      if (routedPendingAt.current === pending.createdAt) return;
      routedPendingAt.current = pending.createdAt;
      router.push('/incoming-import' as any);
    });
  }, [loading, user, segments, router]);

  return null;
}

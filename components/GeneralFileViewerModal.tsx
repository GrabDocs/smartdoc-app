import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { API_BASE_URL, STORAGE_KEYS } from '../constants/Config';
import { fetchSermonMeta } from '../utils/isSermonFile';
import { secureStorage } from '../utils/storage';
import MinimizableBottomSheet from './MinimizableBottomSheet';
import ExplainDocumentButton from './assist/ExplainDocumentButton';
import { useVisibleApps } from '../contexts/VisibleAppsContext';

export interface GeneralFileViewerModalProps {
  visible: boolean;
  fileId: number;
  title?: string;
  onClose: () => void;
  /** Signed or direct view URL from chat links; no Bearer header when set. */
  pdfUri?: string | null;
  /** Bump on every open so a minimized sheet expands again. */
  expandNonce?: number;
}

function resolveDisplayTitle(title: string | undefined, filename?: string | null): string {
  const t = (title || '').trim();
  if (!t || /^open(\s+document)?$/i.test(t)) {
    return filename || 'Document';
  }
  return t;
}

export default function GeneralFileViewerModal({
  visible,
  fileId,
  title,
  onClose,
  pdfUri = null,
  expandNonce = 0,
}: GeneralFileViewerModalProps) {
  const { height: windowHeight } = useWindowDimensions();
  const sheetHeight = Math.round(windowHeight * 0.88);
  const webMinHeight = Math.max(320, Math.round(windowHeight * 0.55));
  const { isHomeAppVisible } = useVisibleApps();
  const assistExplainEnabled = isHomeAppVisible('assist');

  const [authToken, setAuthToken] = useState<string | null>(null);
  const [displayTitle, setDisplayTitle] = useState(title || 'Document');
  const [pdfError, setPdfError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || !fileId) return;
    let cancelled = false;

    secureStorage.getItem(STORAGE_KEYS.AUTH_TOKEN).then(setAuthToken);
    setDisplayTitle(title || 'Document');
    setPdfError(null);

    void fetchSermonMeta(fileId).then((meta) => {
      if (cancelled) return;
      const filename = meta?.original_filename || meta?.header_label || null;
      setDisplayTitle(resolveDisplayTitle(title, filename));
    });

    return () => {
      cancelled = true;
    };
  }, [visible, fileId, title]);

  const pdfSource = pdfUri
    ? { uri: pdfUri }
    : {
        uri: `${API_BASE_URL}/api/v1/web/files/${fileId}/view`,
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      };

  return (
    <MinimizableBottomSheet
      visible={visible}
      onClose={onClose}
      expandNonce={expandNonce}
      sheetHeight={sheetHeight}
      title={displayTitle}
      headerRight={
        assistExplainEnabled && fileId ? (
          <ExplainDocumentButton fileId={fileId} enabled />
        ) : undefined
      }
    >
      <View style={[styles.body, { minHeight: webMinHeight }]}>
        {pdfError ? (
          <View style={styles.centered}>
            <Text style={styles.error}>{pdfError}</Text>
          </View>
        ) : (
          <WebView
            key={pdfUri || `id-${fileId}`}
            source={pdfSource}
            style={[styles.web, { minHeight: webMinHeight }]}
            originWhitelist={['*']}
            scalesPageToFit
            startInLoadingState
            renderLoading={() => (
              <View style={styles.loadingOverlay}>
                <ActivityIndicator size="large" color="#007AFF" />
              </View>
            )}
            onLoadStart={() => setPdfError(null)}
            onError={() => setPdfError('Could not load PDF.')}
            onHttpError={() => setPdfError('Could not load PDF.')}
          />
        )}
      </View>
    </MinimizableBottomSheet>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    width: '100%',
    backgroundColor: '#fff',
    position: 'relative',
  },
  web: {
    flex: 1,
    width: '100%',
    backgroundColor: '#fff',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  centered: { flex: 1, padding: 24, justifyContent: 'center', alignItems: 'center' },
  error: { color: '#c00', textAlign: 'center', fontSize: 15 },
});

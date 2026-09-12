import { WebView } from 'react-native-webview';
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

/** Match web `.email-body-html`: always light “paper” so HTML emails keep contrast. */
const PAPER_TEXT = '#111827';
const PAPER_BG = '#ffffff';
const PAPER_LINK = '#2563eb';

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function EmailHtmlBody({
  html,
  text,
  textColor: _textColor,
  background: _background,
  isDark: _isDark,
  expanded,
}: {
  html?: string | null;
  text?: string | null;
  /** @deprecated Ignored — HTML bodies always use light paper (same as web). */
  textColor?: string;
  /** @deprecated Ignored — HTML bodies always use light paper (same as web). */
  background?: string;
  /** @deprecated Ignored — HTML bodies always use light paper (same as web). */
  isDark?: boolean;
  expanded?: boolean;
}) {
  const sourceHtml = useMemo(() => {
    const inner = (html || '').trim()
      ? html
      : `<pre style="white-space:pre-wrap;font-family:system-ui;color:${PAPER_TEXT}">${escapeHtml(text || '')}</pre>`;
    // Do not strip inline colors/backgrounds — HTML emails are authored for a light canvas.
    const themeCss = `html,body{color:${PAPER_TEXT};background:${PAPER_BG};color-scheme:light}
a{color:${PAPER_LINK}}`;
    return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light only" />
<style>
body{margin:0;padding:8px;font:15px/1.55 -apple-system,sans-serif;}
img{max-width:100%;height:auto}
${themeCss}
</style></head><body>${inner}</body></html>`;
  }, [html, text]);

  if (!(html || '').trim() && !(text || '').trim()) {
    return <Text style={{ color: PAPER_TEXT, opacity: 0.6, padding: 8 }}>(empty)</Text>;
  }

  return (
    <View style={[styles.wrap, expanded ? styles.wrapExpanded : styles.wrapCollapsed]}>
      <WebView
        originWhitelist={['*']}
        source={{ html: sourceHtml }}
        javaScriptEnabled={false}
        scrollEnabled
        nestedScrollEnabled
        style={[styles.web, { backgroundColor: PAPER_BG }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: PAPER_BG,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#E5E7EB',
  },
  wrapCollapsed: { minHeight: 88, maxHeight: 200 },
  wrapExpanded: { minHeight: 220, maxHeight: 480 },
  web: { flex: 1 },
});

import { WebView } from 'react-native-webview';
import React, { useMemo, useState } from 'react';
import { Dimensions, Platform, StyleSheet, Text, View } from 'react-native';

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

/** Emails are display-only. Drop scripts/handlers before enabling JS for fit-to-width. */
function stripUnsafeHtml(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

/** After layout, shrink any remaining overflow so the full width fits; height can still scroll. */
const FIT_WIDTH_JS = `
(function(){
  function fitWidth(){
    var root = document.documentElement;
    var body = document.body;
    if (!body) return;
    body.style.transform = '';
    body.style.width = '';
    var view = window.innerWidth || root.clientWidth;
    var wide = Math.max(root.scrollWidth, body.scrollWidth, root.offsetWidth);
    if (wide > view + 2) {
      var s = view / wide;
      body.style.transformOrigin = 'top left';
      body.style.transform = 'scale(' + s + ')';
      body.style.width = (100 / s) + '%';
      var layoutH = Math.max(body.scrollHeight, root.scrollHeight);
      body.style.marginBottom = '-' + Math.max(0, Math.round(layoutH * (1 - s))) + 'px';
    }
  }
  fitWidth();
  if (document.readyState === 'complete') fitWidth();
  else window.addEventListener('load', fitWidth);
  var imgs = document.getElementsByTagName('img');
  for (var i = 0; i < imgs.length; i++) {
    imgs[i].addEventListener('load', fitWidth);
    imgs[i].addEventListener('error', fitWidth);
  }
  true;
})();
`;

export function EmailHtmlBody({
  html,
  text,
  textColor: _textColor,
  background: _background,
  isDark: _isDark,
  expanded,
  tall,
  fill,
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
  /** View-only / dismissed: use more of the screen for the email body. */
  tall?: boolean;
  /** Fill the parent (fullscreen reader). Ignores expanded/tall height caps. */
  fill?: boolean;
}) {
  const [boxW, setBoxW] = useState(0);
  const sourceHtml = useMemo(() => {
    const raw = (html || '').trim();
    const inner = raw
      ? stripUnsafeHtml(raw)
      : `<pre style="white-space:pre-wrap;font-family:system-ui;color:${PAPER_TEXT}">${escapeHtml(text || '')}</pre>`;
    const maxW = boxW > 0 ? `${Math.floor(boxW)}px` : '100%';
    const themeCss = `html,body{color:${PAPER_TEXT};background:${PAPER_BG};color-scheme:light}
a{color:${PAPER_LINK}}`;
    return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<meta name="color-scheme" content="light only" />
<style>
html,body{margin:0;max-width:100%!important;width:100%!important;overflow-x:hidden!important;word-wrap:break-word!important;overflow-wrap:anywhere!important;box-sizing:border-box!important}
body{padding:8px;font:15px/1.55 -apple-system,sans-serif;}
*,*::before,*::after{box-sizing:border-box!important}
img,video,svg,canvas{max-width:100%!important;height:auto!important}
table{max-width:100%!important}
table,td,th,div,p,section,article,pre{min-width:0!important}
td,th{word-wrap:break-word!important;overflow-wrap:anywhere!important}
pre,code{white-space:pre-wrap!important;word-break:break-word!important;max-width:100%!important}
${themeCss}
</style></head><body style="max-width:${maxW}">${inner}</body></html>`;
  }, [html, text, boxW]);

  const winH = Dimensions.get('window').height;
  const minH = tall ? (expanded ? 280 : 200) : expanded ? 220 : 88;
  const maxH = tall
    ? Math.round(winH * (expanded ? 0.72 : 0.58))
    : expanded
      ? 480
      : 200;

  if (!(html || '').trim() && !(text || '').trim()) {
    return <Text style={{ color: PAPER_TEXT, opacity: 0.6, padding: 8 }}>(empty)</Text>;
  }

  return (
    <View
      style={[styles.wrap, fill ? styles.fill : { minHeight: minH, maxHeight: maxH }]}
      onLayout={(e) => {
        const w = Math.round(e.nativeEvent.layout.width);
        if (w > 0 && w !== boxW) setBoxW(w);
      }}
    >
      <WebView
        originWhitelist={['*']}
        source={{ html: sourceHtml }}
        javaScriptEnabled
        injectedJavaScript={FIT_WIDTH_JS}
        scalesPageToFit={Platform.OS === 'android'}
        setBuiltInZoomControls={false}
        setDisplayZoomControls={false}
        showsHorizontalScrollIndicator={false}
        scrollEnabled
        nestedScrollEnabled
        style={[styles.web, { backgroundColor: PAPER_BG }, boxW > 0 ? { width: boxW } : null]}
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
  fill: {
    flex: 1,
    minHeight: 0,
    borderRadius: 0,
    borderWidth: 0,
  },
  web: { flex: 1 },
});

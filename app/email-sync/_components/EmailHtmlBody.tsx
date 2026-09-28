import { WebView } from 'react-native-webview';
import React, { useMemo, useState } from 'react';
import { Dimensions, StyleSheet, Text, View } from 'react-native';

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

/** Layout at natural width, then scale the whole email so every column stays on screen. */
function fitWidthScript(viewWidth: number) {
  return `
(function(){
  var VIEW = ${viewWidth > 0 ? viewWidth : 0};
  function fitWidth(){
    var el = document.getElementById('gd-fit');
    var body = document.body;
    if (!el || !body) return;
    el.style.transform = 'none';
    body.style.height = '';
    var view = VIEW || window.innerWidth || document.documentElement.clientWidth;
    var wide = Math.max(el.scrollWidth, el.offsetWidth, el.getBoundingClientRect().width);
    var s = wide > view + 1 ? (view / wide) : 1;
    el.style.transformOrigin = 'top left';
    el.style.transform = 'scale(' + s + ')';
    var h = el.offsetHeight * s;
    body.style.height = Math.ceil(h + 16) + 'px';
  }
  fitWidth();
  window.addEventListener('load', fitWidth);
  var imgs = document.getElementsByTagName('img');
  for (var i = 0; i < imgs.length; i++) {
    imgs[i].addEventListener('load', fitWidth);
    imgs[i].addEventListener('error', fitWidth);
  }
  true;
})();`;
}

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
  const fitJs = useMemo(() => fitWidthScript(boxW), [boxW]);
  const sourceHtml = useMemo(() => {
    const raw = (html || '').trim();
    const inner = raw
      ? stripUnsafeHtml(raw)
      : `<pre style="white-space:pre-wrap;font-family:system-ui;color:${PAPER_TEXT}">${escapeHtml(text || '')}</pre>`;
    return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no" />
<meta name="color-scheme" content="light only" />
<style>
html,body{margin:0;padding:0;background:${PAPER_BG};color:${PAPER_TEXT};color-scheme:light;overflow-x:hidden}
body{padding:8px 0 8px 8px;font:15px/1.55 -apple-system,sans-serif;}
a{color:${PAPER_LINK}}
#gd-fit{display:inline-block;width:max-content;max-width:none;vertical-align:top}
</style></head><body>
<div id="gd-fit">${inner}</div>
<script>${fitJs}</script>
</body></html>`;
  }, [html, text, fitJs]);

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
        injectedJavaScript={fitJs}
        scalesPageToFit={false}
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

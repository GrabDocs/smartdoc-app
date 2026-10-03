import { WebView } from 'react-native-webview';
import React, { useMemo, useState } from 'react';
import { Dimensions, StyleSheet, Text, View } from 'react-native';
import { useThemeColors } from '../../../hooks/useThemeColors';

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

/**
 * Reflow to the view width first so type stays readable.
 * Only scale fixed-width HTML (e.g. 600px tables) if it still overflows,
 * and never below minScale so expanded/fullscreen text stays usable.
 */
function fitWidthScript(viewWidth: number, minScale: number) {
  return `
(function(){
  var VIEW = ${viewWidth > 0 ? viewWidth : 0};
  var MIN = ${minScale};
  function fitWidth(){
    var el = document.getElementById('gd-fit');
    var body = document.body;
    if (!el || !body) return;
    el.style.transform = 'none';
    el.style.width = '100%';
    el.style.maxWidth = '100%';
    el.style.display = 'block';
    body.style.height = '';
    var view = VIEW || window.innerWidth || document.documentElement.clientWidth;
    var wide = Math.max(el.scrollWidth, body.scrollWidth, document.documentElement.scrollWidth);
    if (wide <= view + 2) {
      body.style.height = Math.ceil(el.offsetHeight + 16) + 'px';
      return;
    }
    el.style.width = 'max-content';
    el.style.maxWidth = 'none';
    el.style.display = 'inline-block';
    wide = Math.max(el.scrollWidth, el.offsetWidth, el.getBoundingClientRect().width);
    var s = wide > view + 1 ? (view / wide) : 1;
    if (s < MIN) s = MIN;
    el.style.transformOrigin = 'top left';
    el.style.transform = 'scale(' + s + ')';
    body.style.height = Math.ceil(el.offsetHeight * s + 16) + 'px';
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
  isDark: isDarkProp,
  expanded,
  tall,
  fill,
  plain,
  reserveBottom = 0,
}: {
  html?: string | null;
  text?: string | null;
  /** @deprecated Prefer the app theme. */
  textColor?: string;
  /** @deprecated Prefer the app theme. */
  background?: string;
  /** @deprecated Prefer the app theme. */
  isDark?: boolean;
  expanded?: boolean;
  /** View-only / dismissed: use more of the screen for the email body. */
  tall?: boolean;
  /** Fill the parent (fullscreen reader). Ignores expanded/tall height caps. */
  fill?: boolean;
  /** Thread list: no rounded border. A divider separates messages. */
  plain?: boolean;
  /** Leave room below the body (attachment chips) when maximized. */
  reserveBottom?: number;
}) {
  const colors = useThemeColors();
  const isDark = isDarkProp ?? colors.isDark;
  const fg = _textColor || colors.text;
  const bg = _background || colors.background;
  const link = isDark ? '#93C5FD' : '#2563EB';
  const [boxW, setBoxW] = useState(0);
  const readable = !!(expanded || fill || tall);
  const minScale = fill ? 0.92 : expanded || tall ? 0.88 : 0.8;
  const fontPx = readable ? 18 : 16;
  const fitJs = useMemo(() => fitWidthScript(boxW, minScale), [boxW, minScale]);
  const sourceHtml = useMemo(() => {
    const raw = (html || '').trim();
    const inner = raw
      ? stripUnsafeHtml(raw)
      : `<pre style="white-space:pre-wrap;font-family:system-ui;color:${fg};font-size:${fontPx}px;line-height:1.5">${escapeHtml(text || '')}</pre>`;
    return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=0.6, maximum-scale=5, user-scalable=yes" />
<meta name="color-scheme" content="${isDark ? 'dark' : 'light'}" />
<style>
html,body{margin:0;padding:0;background:${bg};color:${fg};color-scheme:${isDark ? 'dark' : 'light'};overflow:auto;-webkit-text-size-adjust:100%;text-size-adjust:100%;touch-action:pan-x pan-y pinch-zoom}
body{padding:10px 10px 12px;font:${fontPx}px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
#gd-fit,#gd-fit *{color:${fg}!important;background-color:transparent!important;background-image:none!important}
#gd-fit a,#gd-fit a *{color:${link}!important;background-color:transparent!important}
img,video,svg,canvas{max-width:100%!important;height:auto!important;background:transparent!important}
table{max-width:100%!important}
td,th,p,div,li,span,a{word-wrap:break-word;overflow-wrap:anywhere}
pre,code{white-space:pre-wrap!important;word-break:break-word!important}
#gd-fit{display:block;width:100%;max-width:100%;vertical-align:top}
</style></head><body>
<div id="gd-fit">${inner}</div>
<script>${fitJs}</script>
</body></html>`;
  }, [html, text, fitJs, fontPx, fg, bg, link, isDark]);

  const winH = Dimensions.get('window').height;
  const minH = tall ? (expanded ? 280 : 200) : expanded ? 260 : 120;
  const rawMax = tall
    ? Math.round(winH * (expanded ? 0.72 : 0.55))
    : expanded
      ? Math.round(winH * 0.62)
      : 240;
  const maxH = Math.max(minH, rawMax - Math.max(0, reserveBottom));

  if (!(html || '').trim() && !(text || '').trim()) {
    return <Text style={{ color: fg, opacity: 0.6, padding: 8, fontSize: 16 }}>(empty)</Text>;
  }

  return (
    <View
      style={[
        styles.wrap,
        { backgroundColor: bg, borderColor: isDark ? '#3F3F46' : '#E5E7EB' },
        fill ? styles.fill : { minHeight: minH, maxHeight: maxH },
        plain ? styles.plain : null,
      ]}
      onLayout={(e) => {
        const w = Math.round(e.nativeEvent.layout.width);
        if (w > 0 && w !== boxW) setBoxW(w);
      }}
    >
      <WebView
        originWhitelist={['*']}
        source={{ html: sourceHtml, baseUrl: 'https://localhost/' }}
        javaScriptEnabled
        injectedJavaScript={fitJs}
        scalesPageToFit={false}
        setBuiltInZoomControls
        setDisplayZoomControls={false}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator
        scrollEnabled
        nestedScrollEnabled
        bounces
        textZoom={readable ? 115 : 105}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        style={[styles.web, { backgroundColor: bg }, boxW > 0 ? { width: boxW } : null]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  fill: {
    flex: 1,
    minHeight: 0,
    borderRadius: 0,
    borderWidth: 0,
  },
  plain: {
    borderRadius: 0,
    borderWidth: 0,
  },
  web: { flex: 1 },
});

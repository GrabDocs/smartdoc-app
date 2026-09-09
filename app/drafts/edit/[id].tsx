import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    AppState,
    Dimensions,
    Keyboard,
    KeyboardAvoidingView,
    LayoutChangeEvent,
    Modal,
    NativeScrollEvent,
    NativeSyntheticEvent,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    TouchableWithoutFeedback,
    View
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import 'react-native-url-polyfill/auto';
import { WebView } from 'react-native-webview';
import { io, Socket } from 'socket.io-client';
import { API_BASE_URL, STORAGE_KEYS } from '../../../constants/Config';
import {
    shouldRestoreHeaderAfterScrollToEdge,
    useHeaderVisibility,
} from '../../../contexts/HeaderVisibilityContext';
import { useTheme } from '../../../contexts/ThemeContext';
import { useOpenChatGD } from '../../../contexts/ChatGDSheetContext';
import { useDraftsSplitOptional } from '../../../contexts/DraftsSplitContext';
import { useThemeColors } from '../../../hooks/useThemeColors';
import { apiClient } from '../../../services/api';
import { toAlertMessage } from '../../../utils/alertUtils';
import {
  anchoredPopoverCardStyle,
  anchoredPopoverOverlayStyle,
  floatingDialogSurfaceStyle,
  modalScrimOverlayStyle,
} from '../../../utils/dialogSurfaceStyles';
import { sanitizeDisplayFilename } from '../../../utils/displayFilename';
import ClientsButton from '../../../components/clients/ClientsButton';
import { draftsCache, isNetworkError } from '../../../utils/draftsCache';
import { syncSingleLocalDraft } from '../../../utils/draftsOfflineSync';
import { saveLastOpenedDraft } from '../../../utils/lastOpenedDraft';
import { secureStorage } from '../../../utils/storage';
import { FeedbackTouchable } from '../../../components/FeedbackTouchable';
import { AnimatedHeaderContainer } from '../../components/AnimatedHeaderContainer';
import { TapToToggleHeaderView } from '../../components/TapToToggleHeaderView';
import { useAuth } from '../../context/auth';

import AppBackButton from '../../../components/AppBackButton';

function stripHtmlToText(html: string): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

function textToSimpleHtml(text: string): string {
  if (!text) return EMPTY_DRAFT_HTML;
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const lines = escaped.split(/\n/);
  if (lines.length === 0) return EMPTY_DRAFT_HTML;
  const [first, ...rest] = lines;
  const titleHtml = first ? `<h1>${first}</h1>` : '<h1></h1>';
  const bodyParas = rest.filter(Boolean);
  const bodyHtml = bodyParas.length > 0
    ? bodyParas.map(p => `<p>${p}</p>`).join('')
    : '<p><br></p>';
  return titleHtml + bodyHtml;
}

function stripExtension(name?: string): string {
  if (!name) return 'Untitled Note';
  return sanitizeDisplayFilename(name).replace(/\.[^./\\]+$/, '');
}

function isDefaultUntitledName(name?: string): boolean {
  const base = stripExtension(name || '').trim();
  return !base || base === 'Untitled Note';
}

const EMPTY_DRAFT_HTML = '<h1></h1><p><br></p>';

function isDraftHtmlEmpty(html: string): boolean {
  if (!html) return true;
  const compact = html.replace(/\s/g, '').toLowerCase();
  if (compact === '<h1></h1><p><br></p>' || compact === '<h1><br></h1><p><br></p>' || compact === '<p><br></p>' || compact === '<p></p>') {
    return true;
  }
  return !stripHtmlToText(html).trim();
}

function extractTitleFromDraftHtml(html: string): string {
  const match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!match) return '';
  return stripHtmlToText(match[1]).trim();
}

function isDraftBodyEmpty(html: string): boolean {
  const bodyHtml = html.replace(/<h1[^>]*>[\s\S]*?<\/h1>/i, '');
  return !stripHtmlToText(bodyHtml).trim();
}

/** Ensure notes use an H1 title block plus body; migrate legacy single-paragraph drafts. */
function ensureDraftHtmlStructure(html: string): string {
  const trimmed = (html || '').trim();
  if (!trimmed || isDraftHtmlEmpty(trimmed)) return EMPTY_DRAFT_HTML;
  if (/<h1[\s>]/i.test(trimmed)) return trimmed;

  const firstBlock = trimmed.match(/^<(p|div)[^>]*>([\s\S]*?)<\/\1>([\s\S]*)$/i);
  if (firstBlock) {
    const rest = (firstBlock[3] || '').trim();
    return `<h1 data-placeholder="Title">${firstBlock[2]}</h1>${rest || '<p><br></p>'}`;
  }
  return `<h1 data-placeholder="Title"></h1>${trimmed}`;
}

/** Allowed font sizes (px) for the rich-text toolbar — applied as inline `font-size` on a wrapping span. */
const DRAFT_FONT_SIZES_PX = [12, 14, 16, 18, 20, 24, 28, 32] as const;

const LOCAL_SAVE_TOAST_MS = 1000;
const LOCAL_SAVE_TOAST_COOLDOWN_MS = 60000;

const DRAFT_EDITOR_SCRIPT = `
    (function(){
      var el=document.getElementById('content');
      var BLOCK_TAGS=['P','DIV','H1','H2','H3','H4','LI'];

      function send(){
        if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(el.innerHTML);
      }
      function sendTitle(){
        var h1=el.querySelector('h1');
        var t=h1?(h1.textContent||'').replace(/\\u00a0/g,' ').trim():'';
        if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage('__TITLE__:'+t);
      }
      function sendUndoState(){
        if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage('__UNDO_STATE__:'+JSON.stringify({canUndo:document.queryCommandEnabled('undo'),canRedo:document.queryCommandEnabled('redo')}));
      }
      function sync(){
        send();
        sendTitle();
        sendUndoState();
      }

      function getBlock(range){
        var node=range.startContainer;
        var block=node.nodeType===3?node.parentNode:node;
        while(block&&block!==el&&!BLOCK_TAGS.includes(block.nodeName)){
          block=block.parentNode;
        }
        return block&&block!==el?block:null;
      }

      function lastDescendant(node){
        while(node&&node.lastChild) node=node.lastChild;
        return node;
      }

      function isBlockEmpty(block){
        return !(block.textContent||'').replace(/\\u00a0/g,' ').trim();
      }

      function isAtBlockStart(range, block){
        var r=range.cloneRange();
        r.collapse(true);
        var test=r.cloneRange();
        test.selectNodeContents(block);
        test.setEnd(r.startContainer, r.startOffset);
        return !(test.toString()||'').length;
      }

      function placeCursorAtEnd(block){
        block=block||el;
        var range=document.createRange();
        var target=lastDescendant(block)||block;
        if(target.nodeType===3){
          range.setStart(target, target.textContent.length);
        }else{
          range.selectNodeContents(block);
          range.collapse(false);
        }
        var sel=window.getSelection();
        if(!sel) return;
        sel.removeAllRanges();
        sel.addRange(range);
      }

      function placeCursorAtStart(block){
        block=block||el;
        var range=document.createRange();
        var first=block.firstChild;
        if(first&&first.nodeType===3){
          range.setStart(first,0);
        }else if(first&&first.nodeName==='BR'){
          range.setStartBefore(first);
        }else{
          range.selectNodeContents(block);
          range.collapse(true);
        }
        var sel=window.getSelection();
        if(!sel) return;
        sel.removeAllRanges();
        sel.addRange(range);
      }

      function getBodyBlock(){
        var h1=el.querySelector('h1');
        var node=h1?h1.nextSibling:null;
        while(node){
          if(node.nodeType===1&&(node.nodeName==='P'||node.nodeName==='DIV')) return node;
          node=node.nextSibling;
        }
        var p=document.createElement('p');
        p.innerHTML='<br>';
        if(h1&&h1.nextSibling) el.insertBefore(p,h1.nextSibling);
        else el.appendChild(p);
        return p;
      }

      function isInTitle(range){
        var node=range.startContainer;
        if(node.nodeType===3) node=node.parentNode;
        while(node&&node!==el){
          if(node.nodeName==='H1') return true;
          node=node.parentNode;
        }
        return false;
      }

      var titleEnterLock=false;

      function focusBodyBlock(body){
        body=body||getBodyBlock();
        if(isBlockEmpty(body)) body.innerHTML='<br>';
        el.focus();
        var range=document.createRange();
        var sel=window.getSelection();
        if(body.firstChild&&body.firstChild.nodeType===3){
          range.setStart(body.firstChild,0);
          range.collapse(true);
        }else if(body.firstChild&&body.firstChild.nodeName==='BR'){
          range.setStart(body,0);
          range.collapse(true);
        }else{
          range.selectNodeContents(body);
          range.collapse(true);
        }
        if(sel){
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }

      function moveToBodyFromTitle(){
        if(titleEnterLock) return;
        titleEnterLock=true;
        var h1=el.querySelector('h1');
        if(h1){
          var junk=h1.querySelectorAll('br,div,p,ul,ol');
          for(var j=0;j<junk.length;j++) junk[j].remove();
        }
        var body=getBodyBlock();
        focusBodyBlock(body);
        sync();
        setTimeout(function(){ titleEnterLock=false; }, 80);
      }

      function repairTitleAfterEnter(){
        var h1=el.querySelector('h1');
        if(!h1) return false;
        var br=h1.querySelector('br');
        var nested=h1.querySelectorAll('div,p,ul,ol');
        if(!br&&(!nested||!nested.length)) return false;
        if(br) br.remove();
        for(var k=0;k<nested.length;k++) nested[k].remove();
        moveToBodyFromTitle();
        return true;
      }

      function handleTitleEnter(e){
        var sel=window.getSelection();
        if(!sel||sel.rangeCount===0) return false;
        if(!isInTitle(sel.getRangeAt(0))) return false;
        if(e&&e.preventDefault) e.preventDefault();
        if(e&&e.stopImmediatePropagation) e.stopImmediatePropagation();
        moveToBodyFromTitle();
        return true;
      }

      function onEnterKey(e){
        if(e.key!=='Enter'&&e.keyCode!==13&&e.which!==13) return;
        var sel=window.getSelection();
        if(!sel||sel.rangeCount===0) return;
        var range=sel.getRangeAt(0);
        if(!range.collapsed) return;
        if(isInTitle(range)){
          handleTitleEnter(e);
          return;
        }
      }

      function getPreviousBodyBlock(block){
        var node=block.previousSibling;
        while(node){
          if(node.nodeType===1){
            if(node.nodeName==='H1') return null;
            if(node.nodeName==='P'||node.nodeName==='DIV') return node;
          }
          node=node.previousSibling;
        }
        return null;
      }

      function isFirstBodyBlock(block){
        var h1=el.querySelector('h1');
        if(!h1||!block||block===h1) return false;
        var node=h1.nextSibling;
        while(node){
          if(node.nodeType===1&&(node.nodeName==='P'||node.nodeName==='DIV')) return node===block;
          node=node.nextSibling;
        }
        return false;
      }

      function getLinePrefixAtCursor(range){
        var r=range.cloneRange();
        r.collapse(true);
        var prefix='';
        var node=r.startContainer;
        var offset=r.startOffset;
        while(node&&el.contains(node)){
          if(node.nodeType===1&&BLOCK_TAGS.includes(node.nodeName)&&offset===0){
            break;
          }
          if(node.nodeType===3){
            var chunk=node.textContent.substring(0,offset);
            prefix=chunk+prefix;
            offset=0;
            var prev=node.previousSibling;
            if(prev){
              if(prev.nodeName==='BR') break;
              node=lastDescendant(prev)||prev;
              continue;
            }
          }else if(node.nodeType===1){
            if(offset>0){
              var child=node.childNodes[offset-1];
              if(child&&child.nodeName==='BR') break;
              if(child&&child.nodeType===1&&BLOCK_TAGS.includes(child.nodeName)) break;
              node=lastDescendant(child)||child;
              continue;
            }
            var prevEl=node.previousSibling;
            if(prevEl){
              if(prevEl.nodeName==='BR') break;
              if(prevEl.nodeType===1&&BLOCK_TAGS.includes(prevEl.nodeName)) break;
              node=lastDescendant(prevEl)||prevEl;
              continue;
            }
          }
          if(node.parentNode&&node.parentNode!==el){
            var parent=node.parentNode;
            if(BLOCK_TAGS.includes(parent.nodeName)) break;
            offset=Array.prototype.indexOf.call(parent.childNodes, node);
            node=parent;
            continue;
          }
          break;
        }
        return prefix.replace(/\\u00a0/g,' ').trimEnd();
      }

      function normalizeListItemAfterConvert(){
        var sel=window.getSelection();
        if(!sel||sel.rangeCount===0) return;
        var li=getBlock(sel.getRangeAt(0));
        if(!li||li.nodeName!=='LI'){
          var node=sel.anchorNode;
          while(node&&node!==el){
            if(node.nodeType===1&&node.nodeName==='LI'){ li=node; break; }
            node=node.parentNode;
          }
        }
        if(!li||li.nodeName!=='LI') return;
        // WebKit often leaves caret after a leftover <br> from empty <p><br></p>,
        // which makes the next keystrokes land on a second line under the bullet.
        while(li.firstChild&&li.firstChild.nodeName==='BR'&&li.childNodes.length>1){
          li.removeChild(li.firstChild);
        }
        if(isBlockEmpty(li)) li.innerHTML='<br>';
        placeCursorAtStart(li);
      }

      function deleteCharsBeforeCursor(range, count){
        for(var i=0;i<count;i++){
          if(!range.collapsed) break;
          var node=range.startContainer;
          var offset=range.startOffset;
          if(node.nodeType===3&&offset>0){
            range.setStart(node, offset-1);
            range.deleteContents();
            continue;
          }
          var prev=node.nodeType===3?node.previousSibling:(offset>0?node.childNodes[offset-1]:node.previousSibling);
          if(prev&&prev.nodeName==='BR'){
            prev.parentNode.removeChild(prev);
            continue;
          }
          if(prev){
            var tail=lastDescendant(prev);
            if(tail&&tail.nodeType===3&&tail.textContent.length){
              tail.textContent=tail.textContent.slice(0,-1);
              range.setStart(tail, tail.textContent.length);
              range.collapse(true);
              continue;
            }
          }
          break;
        }
      }

      el.innerHTML='<h1><\\/h1><p><br><\\/p>';

      setTimeout(function(){
        el.addEventListener('input',function(){
          if(repairTitleAfterEnter()) return;
          sync();
        });
        el.addEventListener('blur',sync);
        el.addEventListener('paste',function(){ setTimeout(function(){
          if(repairTitleAfterEnter()) return;
          sync();
        },0); });
      },0);

      el.addEventListener('beforeinput',function(e){
        if(e.inputType!=='insertParagraph'&&e.inputType!=='insertLineBreak') return;
        handleTitleEnter(e);
      },true);

      el.addEventListener('keydown',onEnterKey,true);
      el.addEventListener('keyup',onEnterKey,true);

      el.addEventListener('keydown',function(e){
        var sel=window.getSelection();
        if(!sel||sel.rangeCount===0) return;
        var range=sel.getRangeAt(0);
        if(!range.collapsed && e.key!=='Backspace') return;
        if(e.key==='Enter'||e.keyCode===13||e.which===13){
          if(isInTitle(range)) return;
        }
        var block=getBlock(range);
        if(!block) return;

        if(e.key==='Backspace'){
          if(block.nodeName==='LI'&&isAtBlockStart(range, block)){
            e.preventDefault();
            if(isBlockEmpty(block)){
              document.execCommand('outdent',false,null);
            }else{
              document.execCommand('insertParagraph',false,null);
            }
            sync();
            return;
          }
          if((block.nodeName==='P'||block.nodeName==='DIV')&&isAtBlockStart(range, block)){
            var h1=el.querySelector('h1');
            if(h1&&block!==h1){
              if(isFirstBodyBlock(block)){
                if(isBlockEmpty(block)){
                  e.preventDefault();
                  block.innerHTML='<br>';
                  placeCursorAtEnd(h1);
                  sync();
                  return;
                }
                e.preventDefault();
                placeCursorAtEnd(h1);
                return;
              }
              if(isBlockEmpty(block)){
                e.preventDefault();
                var prevBody=getPreviousBodyBlock(block);
                block.remove();
                if(prevBody) placeCursorAtEnd(prevBody);
                sync();
                return;
              }
              return;
            }
          }
          if(block.nodeName==='H1'&&isAtBlockStart(range, block)&&isBlockEmpty(block)){
            e.preventDefault();
            return;
          }
        }

        if(e.key==='Enter'||e.key===' '||e.keyCode===32||e.keyCode===13||e.which===13){
          var linePrefix=getLinePrefixAtCursor(range);
          var isBulletTrigger=(e.key==='Enter'||e.keyCode===13||e.which===13)&&(linePrefix==='-'||linePrefix==='*')||(e.key===' '||e.keyCode===32)&&(linePrefix==='-'||linePrefix==='*');
          var isOrderedTrigger=(e.key===' '||e.keyCode===32)&&/^[1][\\.)]$/.test(linePrefix);
          if(isBulletTrigger||isOrderedTrigger){
            e.preventDefault();
            deleteCharsBeforeCursor(range, linePrefix.length);
            if(isBulletTrigger){
              document.execCommand('insertUnorderedList',false,null);
            }else{
              document.execCommand('insertOrderedList',false,null);
            }
            normalizeListItemAfterConvert();
            sync();
            return;
          }
        }

        if(e.key==='Enter'||e.keyCode===13||e.which===13){
          if(block.nodeName==='LI') return;
          if(block.nodeName==='P'||block.nodeName==='DIV'){
            e.preventDefault();
            document.execCommand('insertParagraph',false,null);
            sync();
            return;
          }
        }
      });

      var lastTap=0;
      el.addEventListener('touchend',function(e){
        var now=Date.now();
        if(now-lastTap<300){
          if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage('__DOUBLE_TAP__');
          e.preventDefault();
        }
        lastTap=now;
      });

      function resetTopScroll(){
        try{
          window.scrollTo(0,0);
          document.documentElement.scrollTop=0;
          document.body.scrollTop=0;
        }catch(e0){}
      }
      resetTopScroll();
      setTimeout(resetTopScroll,50);
    })();
  `;

/** Base editor HTML with empty content; real content is injected in onLoadEnd to avoid escaping/timing issues. */
function getRichEditorBaseHtml(bgColor: string, textColor: string, isDarkMode: boolean): string {
  const safeBg = bgColor.replace(/[^a-zA-Z0-9#(),.% ]/g, '');
  const safeText = textColor.replace(/[^a-zA-Z0-9#(),.% ]/g, '');
  const darkModeBlackTextFix = isDarkMode
    ? `
    #content [style*="color:#000"],
    #content [style*="color: #000"],
    #content [style*="color:#000000"],
    #content [style*="color: #000000"],
    #content [style*="color:rgb(0,0,0)"],
    #content [style*="color: rgb(0,0,0)"],
    #content [style*="color: rgb(0, 0, 0)"],
    #content font[color="black"],
    #content font[color="#000"],
    #content font[color="#000000"]{
      color:${safeText} !important;
    }`
    : '';
  return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/><style>
    *{box-sizing:border-box}
    html{margin:0;padding:0}
    body{margin:0;padding:0 16px 16px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:1.5;background:${safeBg};color:${safeText};min-height:100vh;-webkit-user-select:auto;user-select:auto;-webkit-overflow-scrolling:touch}
    #content{outline:0;min-height:200px;padding-top:0}
    #content h1{font-size:26px;font-weight:700;margin:0 0 6px 0;padding:0;line-height:1.25}
    #content h1:empty:before{content:attr(data-placeholder);color:gray;font-weight:700}
    #content p{margin:0 0 4px 0;font-size:16px;font-weight:400;line-height:1.5}
    #content>div{margin:0 0 4px 0;font-size:16px;font-weight:400;line-height:1.5}
    #content ul,#content ol{margin:4px 0;padding-left:20px}
    #content ul ul,#content ol ol,#content ul ol,#content ol ul{margin:2px 0;padding-left:16px}
    #content li{margin:2px 0;padding-left:0}
    #content blockquote{margin:8px 0;padding:4px 0 4px 16px;border-left:3px solid ${safeText}40;color:${safeText}99}
    #content [style*="margin-left"]{display:block}
    table{border-collapse:collapse;width:100%;margin:8px 0}
    td,th{border:1px solid ${safeText}40;padding:8px}
    ${darkModeBlackTextFix}
  </style></head><body><div id="content" contenteditable="true"><h1 data-placeholder="Title"></h1><p><br></p></div>
  <script>${DRAFT_EDITOR_SCRIPT}</script></body></html>`;
}

/** Blur editor + clear selection so the system keyboard hides; blur listener may postMessage, else we post here. */
const DRAFT_WEBVIEW_BLUR_FOR_SAVE_JS = `(function(){
  var el=document.getElementById('content');
  if(!el){
    if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage('${EMPTY_DRAFT_HTML}');
    return;
  }
  var html=el.innerHTML;
  var ae=document.activeElement;
  var hadFocus=ae && (ae===el || el.contains(ae));
  el.blur();
  try{
    var s=window.getSelection();
    if(s&&s.removeAllRanges) s.removeAllRanges();
  }catch(e0){}
  if(!hadFocus && window.ReactNativeWebView) window.ReactNativeWebView.postMessage(html);
})();true;`;

export default function DraftEditScreen() {
  const { id, share } = useLocalSearchParams<{ id: string; share?: string }>();
  const router = useRouter();
  const openChatGD = useOpenChatGD();
  const { user } = useAuth();
  const userId = user?.id;
  const split = useDraftsSplitOptional();
  const isSplitMode = split?.isSplit ?? false;
  const colors = useThemeColors();
  const isDarkMode = colors.isDark;
  const { isDark, setTheme } = useTheme();
  const draftId = id ? parseInt(id, 10) : NaN;
  const { toggleHeader, toggleEnabled, showHeader } = useHeaderVisibility();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [creatingNote, setCreatingNote] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [filename, setFilename] = useState('Untitled Note');
  const [contentText, setContentText] = useState('');
  const [contentHtml, setContentHtml] = useState('');
  const [initialEditorHtml, setInitialEditorHtml] = useState<string | null>(null);
  const [presenceEditors, setPresenceEditors] = useState<Map<number, string>>(new Map());
  const [showShareModal, setShowShareModal] = useState(false);
  const [showSendLinkModal, setShowSendLinkModal] = useState(false);
  const [showEditorsModal, setShowEditorsModal] = useState(false);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [shareLinkExpiresInDays, setShareLinkExpiresInDays] = useState<number | undefined>(undefined);
  const [linkLoading, setLinkLoading] = useState(false);
  const [shareRole, setShareRole] = useState<'viewer' | 'member' | 'admin'>('viewer');
  const [shareExpirationDays, setShareExpirationDays] = useState('');
  const [shareEmails, setShareEmails] = useState('');
  const [shareMessage, setShareMessage] = useState('');
  const [sendingEmail, setSendingEmail] = useState(false);
  const [externalShares, setExternalShares] = useState<Array<{
    id: number;
    share_type: string;
    role: string;
    is_active: boolean;
    expires_at: string | null;
    revoked_at: string | null;
    created_at: string;
    token?: string;
  }>>([]);
  const [loadingShares, setLoadingShares] = useState(false);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [showColorPicker, setShowColorPicker] = useState<'fore' | 'back' | null>(null);
  const [showFontSizePicker, setShowFontSizePicker] = useState(false);
  const [localSaveToastVisible, setLocalSaveToastVisible] = useState(false);
  const localSaveToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLocalSaveToastAtRef = useRef(0);
  const localSaveToastDismissedRef = useRef(false);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'local' | 'error' | null>(null);
  const initialFilenameRef = useRef<string | null>(null);
  const filenameManuallyEditedRef = useRef(false);
  const skipFilenameManualMarkRef = useRef(false);
  const currentFilenameRef = useRef<string>('Untitled Note');
  const renameTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftLoadedRef = useRef(false);
  /** True when this draft was opened as a fresh empty note (no content, default title). */
  const wasCreatedEmptyRef = useRef(false);
  currentFilenameRef.current = filename;

  useEffect(() => {
    if (share === '1') setShowShareModal(true);
  }, [share]);

  const dismissLocalSaveToast = useCallback(() => {
    localSaveToastDismissedRef.current = true;
    setLocalSaveToastVisible(false);
    if (localSaveToastTimerRef.current) {
      clearTimeout(localSaveToastTimerRef.current);
      localSaveToastTimerRef.current = null;
    }
  }, []);

  const showLocalSaveToastIfDue = useCallback(() => {
    if (localSaveToastDismissedRef.current) return;
    const now = Date.now();
    if (now - lastLocalSaveToastAtRef.current < LOCAL_SAVE_TOAST_COOLDOWN_MS) return;
    lastLocalSaveToastAtRef.current = now;
    setLocalSaveToastVisible(true);
    if (localSaveToastTimerRef.current) clearTimeout(localSaveToastTimerRef.current);
    localSaveToastTimerRef.current = setTimeout(() => {
      localSaveToastTimerRef.current = null;
      setLocalSaveToastVisible(false);
    }, LOCAL_SAVE_TOAST_MS);
  }, []);

  useEffect(() => {
    if (saveStatus !== 'local') return;
    showLocalSaveToastIfDue();
  }, [saveStatus, showLocalSaveToastIfDue]);

  useEffect(() => {
    return () => {
      if (localSaveToastTimerRef.current) clearTimeout(localSaveToastTimerRef.current);
    };
  }, []);

  // Load external shares when modals open
  useEffect(() => {
    if ((showShareModal || showSendLinkModal) && draftId && !isNaN(draftId)) {
      loadExternalShares();
    }
  }, [showShareModal, showSendLinkModal, draftId]);

  const loadExternalShares = useCallback(async () => {
    if (!draftId || isNaN(draftId)) return;
    setLoadingShares(true);
    try {
      const res = await apiClient.getFileExternalShares(draftId);
      if ((res as any)?.success) {
        setExternalShares((res as any).shares || []);
      }
    } catch (e: any) {
      // Only pass strings to console - passing objects can cause "cannot be cast to String" native crash
      const msg = e?.message ?? (typeof e?.response?.data?.message === 'string' ? e.response.data.message : null) ?? 'Unknown error';
      console.error('Failed to load external shares:', msg);
    } finally {
      setLoadingShares(false);
    }
  }, [draftId, userId]);

  const handleRevokeShare = useCallback(async (shareId: number) => {
    if (!draftId || isNaN(draftId)) return;
    Alert.alert(
      'Revoke Share Link',
      'Are you sure you want to revoke this share link? It will no longer be accessible.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: async () => {
            try {
              const res = await apiClient.revokeFileShare(draftId, shareId);
              if ((res as any)?.success) {
                Alert.alert('Success', 'Share link revoked');
                loadExternalShares();
                // Clear shareLink if the revoked share matches the current one
                if (shareLink) {
                  const share = externalShares.find(s => s.id === shareId);
                  if (share?.token && shareLink.includes(share.token)) {
                    setShareLink(null);
                  }
                }
              } else {
                Alert.alert('Error', toAlertMessage((res as any)?.message, 'Failed to revoke share link'));
              }
            } catch (e: any) {
              Alert.alert('Error', toAlertMessage(e?.message ?? e?.response?.data?.message, 'Failed to revoke share link'));
            }
          },
        },
      ]
    );
  }, [draftId, shareLink, externalShares, loadExternalShares]);

  const handleDeleteShare = useCallback(async (shareId: number) => {
    if (!draftId || isNaN(draftId)) return;
    Alert.alert(
      'Delete Share Link',
      'Are you sure you want to permanently delete this revoked share link? This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              const res = await apiClient.deleteFileShare(draftId, shareId);
              if ((res as any)?.success) {
                Alert.alert('Success', 'Share link deleted');
                loadExternalShares();
              } else {
                Alert.alert('Error', toAlertMessage((res as any)?.message, 'Failed to delete share link'));
              }
            } catch (e: any) {
              Alert.alert('Error', toAlertMessage(e?.message ?? e?.response?.data?.message, 'Failed to delete share link'));
            }
          },
        },
      ]
    );
  }, [draftId, loadExternalShares]);

  // Reset share link state when modals close
  useEffect(() => {
    if (!showShareModal && !showSendLinkModal) {
      // Don't reset shareLink here - keep it so user can reopen send modal
    }
  }, [showShareModal, showSendLinkModal]);

  const socketRef = useRef<Socket | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasUnsavedRef = useRef(false);
  const contentTextRef = useRef('');
  const editorRef = useRef<TextInput>(null);
  const filenameInputRef = useRef<TextInput>(null);
  const webViewRef = useRef<WebView>(null);
  const webViewScrollHeaderRestoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const webViewScrollLastEventRef = useRef<NativeScrollEvent | null>(null);
  const contentHtmlRef = useRef('');
  const saveRequestedRef = useRef(false);
  const ignoreFirstEmptyMessageRef = useRef(false);
  const contentToInjectRef = useRef<string>('');
  const selectionRef = useRef({ start: 0, end: 0 });
  const formatSelectionRef = useRef({ start: 0, end: 0 });
  const lastKnownVersionRef = useRef<number | null>(null);
  const lastKnownUpdatedAtRef = useRef<string | null>(null);
  const refetchDraftContentRef = useRef<((version: number, updatedAt: string) => Promise<void>) | null>(null);
  hasUnsavedRef.current = hasUnsavedChanges;
  contentTextRef.current = contentText;
  contentHtmlRef.current = contentHtml;
  if (selection.start !== 0 || selection.end !== 0) selectionRef.current = selection;

  // Keyboard: show toolbar above keyboard when it opens
  useEffect(() => {
    const showSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (e) => setKeyboardHeight(e.endCoordinates.height)
    );
    const hideSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKeyboardHeight(0)
    );
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (webViewScrollHeaderRestoreTimerRef.current) {
        clearTimeout(webViewScrollHeaderRestoreTimerRef.current);
      }
    };
  }, []);

  // Load draft content — cache-first for instant offline access
  useEffect(() => {
    if (!draftId || isNaN(draftId) || !userId) return;
    draftLoadedRef.current = false;
    let cancelled = false;
    const markDraftOpened = (openedId: number) => {
      if (split) {
        split.notifyDraftOpened(openedId);
      } else {
        void saveLastOpenedDraft(userId, openedId);
      }
    };
    (async () => {
      try {
        setLoading(true);

        // 1. Load from local cache immediately (no network needed)
        const cached = await draftsCache.getDraftContent(userId, draftId);
        if (cached && !cancelled) {
          const cachedHtml = ensureDraftHtmlStructure(cached.content_html || EMPTY_DRAFT_HTML);
          const cachedName = cached.filename || 'Untitled Note';
          setFilename(stripExtension(cachedName));
          initialFilenameRef.current = stripExtension(cachedName);
          filenameManuallyEditedRef.current = !isDefaultUntitledName(cachedName);
          const titleInContent = extractTitleFromDraftHtml(cachedHtml);
          if (titleInContent && isDefaultUntitledName(cachedName)) {
            setFilename(titleInContent);
            currentFilenameRef.current = titleInContent;
          }
          setContentText(stripHtmlToText(cachedHtml));
          setContentHtml(cachedHtml);
          setInitialEditorHtml(cachedHtml);
          contentToInjectRef.current = cachedHtml;
          if (cached.version != null) lastKnownVersionRef.current = Number(cached.version);
          if (cached.updated_at != null) lastKnownUpdatedAtRef.current = String(cached.updated_at);
          ignoreFirstEmptyMessageRef.current = !isDraftHtmlEmpty(cachedHtml);
          draftLoadedRef.current = true;
          markDraftOpened(draftId);
          setLoading(false);
        }

        // Local-only drafts (negative IDs) never fetch from API.
        if (draftsCache.isLocalDraftId(draftId)) {
          if (!cached) {
            const emptyHtml = EMPTY_DRAFT_HTML;
            setFilename('Untitled Note');
            initialFilenameRef.current = 'Untitled Note';
            filenameManuallyEditedRef.current = false;
            setContentText('');
            setContentHtml(emptyHtml);
            setInitialEditorHtml(emptyHtml);
            contentToInjectRef.current = emptyHtml;
            draftLoadedRef.current = true;
            markDraftOpened(draftId);
            wasCreatedEmptyRef.current = true;
          } else {
            const cachedTitle = (cached.filename || 'Untitled Note').trim();
            const localCachedHtml = ensureDraftHtmlStructure(cached.content_html || EMPTY_DRAFT_HTML);
            wasCreatedEmptyRef.current = isDraftHtmlEmpty(localCachedHtml) && cachedTitle === 'Untitled Note';
          }
          void syncSingleLocalDraft(userId, draftId).then((serverId) => {
            if (serverId && !cancelled) router.replace(`/drafts/edit/${serverId}`);
          });
          return;
        }

        // 2. Fetch from API to get latest version
        const res = await apiClient.getDraftContent(draftId);
        if (cancelled) return;
        if ((res as any)?.success) {
          const data = (res as any).data ?? res;
          const html = (res as any).content_html ?? data?.content_html ?? '';
          const name = (res as any).filename ?? data?.filename ?? 'Untitled Note';
          const ver = (res as any).version ?? data?.version;
          const updatedAt = (res as any).updated_at ?? data?.updated_at;
          const safeHtml = ensureDraftHtmlStructure(html || EMPTY_DRAFT_HTML);

          // Only update UI if server has newer content than cache
          const serverVersion = ver != null ? Number(ver) : null;
          const cacheVersion = cached?.version != null ? Number(cached.version) : null;
          const serverIsNewer = serverVersion == null || cacheVersion == null || serverVersion > cacheVersion;

          if (serverIsNewer || !cached) {
            const displayName = stripExtension(name);
            setFilename(displayName);
            initialFilenameRef.current = displayName;
            filenameManuallyEditedRef.current = !isDefaultUntitledName(name);
            const titleInContent = extractTitleFromDraftHtml(safeHtml);
            if (titleInContent && isDefaultUntitledName(name)) {
              setFilename(titleInContent);
              currentFilenameRef.current = titleInContent;
            }
            draftLoadedRef.current = true;
            markDraftOpened(draftId);
            setContentText(stripHtmlToText(safeHtml));
            setContentHtml(safeHtml);
            setInitialEditorHtml(safeHtml);
            contentToInjectRef.current = safeHtml;
            if (ver != null) lastKnownVersionRef.current = Number(ver);
            if (updatedAt != null) lastKnownUpdatedAtRef.current = String(updatedAt);
            ignoreFirstEmptyMessageRef.current = !isDraftHtmlEmpty(safeHtml);
            wasCreatedEmptyRef.current = isDraftHtmlEmpty(safeHtml) && (name === 'Untitled Note' || !name);
            // Inject updated content into WebView if already rendered
            if (cached) {
              const script = `(function(){ var el=document.getElementById('content'); if(el){ el.innerHTML=${JSON.stringify(safeHtml)}; var h1=el.querySelector('h1'); if(h1&&window.ReactNativeWebView){ var t=(h1.textContent||'').replace(/\\u00a0/g,' ').trim(); if(t) window.ReactNativeWebView.postMessage('__TITLE__:'+t); } } })(); true;`;
              webViewRef.current?.injectJavaScript(script);
            }
          }

          // Persist to cache
          await draftsCache.saveDraftContent(userId, draftId, {
            filename: name,
            content_html: html,
            version: ver != null ? Number(ver) : undefined,
            updated_at: updatedAt != null ? String(updatedAt) : undefined,
          });

          await flushPendingOpsForDraft();
        } else if (!cached) {
          Alert.alert('Error', 'Failed to load note', [{ text: 'OK', onPress: () => router.back() }]);
        }
      } catch (e: any) {
        if (cancelled) return;
        if (isNetworkError(e)) {
          if (!draftLoadedRef.current) {
            // No cache and no network — go back
            Alert.alert('Offline', 'This note is not available offline yet. Open it while online first to cache it locally.', [
              { text: 'OK', onPress: () => router.back() },
            ]);
          }
          // If we loaded from cache, stay on screen — already showing cached content
        } else {
          if (!draftLoadedRef.current) {
            Alert.alert('Error', toAlertMessage(e?.message ?? e?.response?.data?.message, 'Failed to load note'), [
              { text: 'OK', onPress: () => router.back() },
            ]);
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [draftId, userId, router, split]);

  // Socket.IO: connect, join document room, presence
  useEffect(() => {
    if (!draftId || isNaN(draftId) || draftsCache.isLocalDraftId(draftId) || !user?.id) return;
    let socket: Socket | null = null;
    const currentUserId = parseInt(String(user.id), 10);
    if (isNaN(currentUserId)) return;

    const displayName = user.name || user.email || 'Someone';

    (async () => {
      try {
        const token = await secureStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
        if (!token) return;

        socket = io(API_BASE_URL, {
          auth: { token },
          transports: ['polling', 'websocket'],
          reconnection: true,
          reconnectionDelay: 1000,
          reconnectionAttempts: 5,
          timeout: 20000,
        });

        socket.on('connect', () => {
          socket?.emit('join_document_room', {
            doc_type: 'file',
            doc_id: draftId,
            user_id: currentUserId,
            display_name: displayName,
          });
          // Network just came back — flush any locally queued save immediately
          flushPendingOpsForDraft();
        });

        socket.on('doc_presence_list', (data: { members?: Array<{ user_id: number; display_name: string }> }) => {
          const members = data.members || [];
          setPresenceEditors(prev => {
            const next = new Map(prev);
            members.forEach(m => {
              if (m.user_id !== currentUserId) next.set(m.user_id, m.display_name || 'Someone');
            });
            return next;
          });
        });

        socket.on('doc_presence', (data: { user_id: number; display_name: string; joined: boolean }) => {
          if (data.user_id === currentUserId) return;
          setPresenceEditors(prev => {
            const next = new Map(prev);
            if (data.joined) next.set(data.user_id, data.display_name || 'Someone');
            else next.delete(data.user_id);
            return next;
          });
        });

        socket.on(
          'draft_saved',
          (data: { draft_id: number; version: number; updated_at: string; saved_by_user_id?: number | null }) => {
            if (data.draft_id !== draftId) return;
            if (data.version <= (lastKnownVersionRef.current ?? 0)) return;
            const saver = data.saved_by_user_id;
            if (saver != null && saver === currentUserId) {
              lastKnownVersionRef.current = data.version;
              lastKnownUpdatedAtRef.current = data.updated_at;
              return;
            }
            if (hasUnsavedRef.current) {
              Alert.alert(
                'Note updated elsewhere',
                'This note was updated on another device. Reload?',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Reload', onPress: () => refetchDraftContentRef.current?.(data.version, data.updated_at) },
                ]
              );
              return;
            }
            refetchDraftContentRef.current?.(data.version, data.updated_at);
          }
        );

        socketRef.current = socket;
      } catch (e: any) {
        console.warn('Draft socket init failed:', typeof e?.message === 'string' ? e.message : 'Unknown error');
      }
    })();

    return () => {
      if (socket) {
        socket.off('draft_saved');
        if (socket.connected) {
          socket.emit('leave_document_room', {
            doc_type: 'file',
            doc_id: draftId,
            user_id: currentUserId,
            display_name: displayName,
          });
          socket.disconnect();
        }
      }
      socketRef.current = null;
    };
  }, [draftId, user?.id, user?.name, user?.email]);

  const normalizeHtml = useCallback((html: string): string => {
    if (!html) return EMPTY_DRAFT_HTML;
    // Preserve all formatting tags exactly as generated by document.execCommand
    // Only do minimal normalization for consistency
    let normalized = html;
    
    // Normalize <b> to <strong> for consistency (strong is better semantic HTML and works better with CSS)
    normalized = normalized.replace(/<b\b([^>]*)>/gi, '<strong$1>');
    normalized = normalized.replace(/<\/b>/gi, '</strong>');
    
    // Normalize <i> to <em> for consistency (em is better semantic HTML)
    normalized = normalized.replace(/<i\b([^>]*)>/gi, '<em$1>');
    normalized = normalized.replace(/<\/i>/gi, '</em>');
    
    // Debug: log HTML being saved (remove in production if needed)
    if (__DEV__) {
      console.log('Saving HTML:', normalized.substring(0, 200));
    }
    
    return normalized;
  }, []);

  const handleSave = useCallback(async (textOrHtml?: string, isHtml = false) => {
    if (!draftId || isNaN(draftId) || !userId) return;
    let html = isHtml ? (textOrHtml ?? contentHtmlRef.current) : textToSimpleHtml(textOrHtml ?? contentTextRef.current);
    if (isHtml) {
      html = normalizeHtml(html);
    }
    const plainText = stripHtmlToText(html);

    // Always persist locally first so content is never lost
    await draftsCache.saveDraftContent(userId, draftId, {
      filename: currentFilenameRef.current || 'Untitled Note',
      content_html: html,
      version: lastKnownVersionRef.current ?? undefined,
      updated_at: lastKnownUpdatedAtRef.current ?? undefined,
    });

    setSaving(true);
    setSaveStatus('saving');
    try {
      if (draftsCache.isLocalDraftId(draftId)) {
        await draftsCache.updatePendingCreate(userId, draftId, {
          html,
          plainText,
          filename: currentFilenameRef.current || 'Untitled Note',
        });
        const serverId = await syncSingleLocalDraft(userId, draftId);
        if (serverId) {
          router.replace(`/drafts/edit/${serverId}`);
          setSaveStatus('saved');
          setHasUnsavedChanges(false);
          return;
        }
        setSaveStatus('local');
        setHasUnsavedChanges(false);
        return;
      }
      // Debug: verify HTML contains formatting tags
      if (__DEV__) {
        const hasBold = /<(strong|b)>/i.test(html);
        const hasItalic = /<(em|i)>/i.test(html);
        const hasLinks = /<a\s+href/i.test(html);
        const hasLists = /<(ul|ol|li)>/i.test(html);
        console.log('Formatting check:', { hasBold, hasItalic, hasLinks, hasLists });
      }
      const res = await apiClient.saveDraft(draftId, html, plainText);
      setHasUnsavedChanges(false);
      setSaveStatus('saved');
      // Remove from pending queue on successful save
      await draftsCache.removePendingSave(userId, draftId);
      const file = (res as any)?.file ?? (res as any)?.data?.file;
      if (file?.version != null) lastKnownVersionRef.current = Number(file.version);
      if (file?.updated_at != null) lastKnownUpdatedAtRef.current = String(file.updated_at);
      // Update cache with server-confirmed version info
      await draftsCache.saveDraftContent(userId, draftId, {
        filename: currentFilenameRef.current || 'Untitled Note',
        content_html: html,
        version: lastKnownVersionRef.current ?? undefined,
        updated_at: lastKnownUpdatedAtRef.current ?? undefined,
      });
    } catch (e: any) {
      if (e?.message?.includes('409') || (e?.response?.status === 409)) {
        setSaveStatus('error');
        Alert.alert('Someone else is editing', 'Your changes were not saved. Someone else is editing this note.');
      } else if (isNetworkError(e)) {
        // Queue for later sync — content already saved locally above
        setSaveStatus('local');
        await draftsCache.addPendingSave(userId, {
          id: draftId,
          html,
          plainText,
          filename: currentFilenameRef.current || 'Untitled Note',
        });
        setHasUnsavedChanges(false);
      } else {
        setSaveStatus('error');
        Alert.alert('Error', toAlertMessage(e?.message ?? e?.response?.data?.message, 'Failed to save note'));
      }
    } finally {
      setSaving(false);
    }
  }, [draftId, userId, normalizeHtml, router]);

  /** Upload a local-only draft when back online; returns new server id or null. */
  const trySyncLocalDraft = useCallback(async (): Promise<number | null> => {
    if (!draftId || isNaN(draftId) || !userId || !draftsCache.isLocalDraftId(draftId)) return null;
    const html = normalizeHtml(contentHtmlRef.current || contentHtml);
    const plainText = stripHtmlToText(html);
    const filename = currentFilenameRef.current || 'Untitled Note';
    await draftsCache.saveDraftContent(userId, draftId, {
      filename,
      content_html: html,
      version: lastKnownVersionRef.current ?? undefined,
      updated_at: lastKnownUpdatedAtRef.current ?? undefined,
    });
    await draftsCache.updatePendingCreate(userId, draftId, { html, plainText, filename });
    return syncSingleLocalDraft(userId, draftId);
  }, [draftId, userId, contentHtml, normalizeHtml]);

  const refetchDraftContent = useCallback(async (version: number, updatedAt: string) => {
    if (!draftId || isNaN(draftId)) return;
    if (draftsCache.isLocalDraftId(draftId)) return;
    try {
      const res = await apiClient.getDraftContent(draftId);
      if (!(res as any)?.success) return;
      const data = (res as any).data ?? res;
      const html = (res as any).content_html ?? data?.content_html ?? '';
      const safeHtml = ensureDraftHtmlStructure(html || EMPTY_DRAFT_HTML);
      setContentHtml(safeHtml);
      setContentText(stripHtmlToText(safeHtml));
      contentHtmlRef.current = safeHtml;
      contentTextRef.current = stripHtmlToText(safeHtml);
      setInitialEditorHtml(safeHtml);
      contentToInjectRef.current = safeHtml;
      lastKnownVersionRef.current = version;
      lastKnownUpdatedAtRef.current = updatedAt;
      setHasUnsavedChanges(false);
      const script = `(function(){ var el=document.getElementById('content'); if(el) el.innerHTML=${JSON.stringify(safeHtml)}; })(); true;`;
      webViewRef.current?.injectJavaScript(script);
    } catch (_) {
      // ignore refetch errors
    }
  }, [draftId, userId]);

  useEffect(() => {
    refetchDraftContentRef.current = refetchDraftContent;
    return () => { refetchDraftContentRef.current = null; };
  }, [refetchDraftContent]);

  /** Flush pending save/rename for this draft to the server. Safe to call speculatively. */
  const flushPendingOpsForDraft = useCallback(async () => {
    if (!draftId || isNaN(draftId) || !userId) return;
    if (draftsCache.isLocalDraftId(draftId)) return;
    const pending = await draftsCache.getPendingSaves(userId);
    const item = pending.find(p => p.id === draftId);
    if (item) {
      try {
        await apiClient.saveDraft(draftId, item.html, item.plainText);
        await draftsCache.removePendingSave(userId, draftId);
        setSaveStatus('saved');
        setHasUnsavedChanges(false);
        if (item.filename) {
          await draftsCache.saveDraftContent(userId, draftId, {
            filename: item.filename,
            content_html: item.html,
          });
        }
      } catch {
        return;
      }
    }

    const pendingRenames = await draftsCache.getPendingRenames(userId);
    const rename = pendingRenames.find(r => r.id === draftId);
    if (!rename) return;
    try {
      await apiClient.renameFile(draftId, rename.filename);
      await draftsCache.removePendingRename(userId, draftId);
      setSaveStatus('saved');
    } catch {
      // Still offline — leave in queue
    }
  }, [draftId, userId]);

  // Sync pending operations when app comes to foreground; also pull latest content from server
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') return;
      if (draftsCache.isLocalDraftId(draftId)) {
        void trySyncLocalDraft().then((serverId) => {
          if (serverId) router.replace(`/drafts/edit/${serverId}`);
        });
        return;
      }
      flushPendingOpsForDraft();
      // Pull latest content from server if there are no local unsaved changes
      if (!hasUnsavedRef.current) {
        refetchDraftContentRef.current?.(
          lastKnownVersionRef.current ?? 0,
          lastKnownUpdatedAtRef.current ?? ''
        );
      }
    });
    return () => sub.remove();
  }, [draftId, flushPendingOpsForDraft, router, trySyncLocalDraft]);

  const handleContentChange = useCallback((text: string) => {
    setContentText(text);
    setHasUnsavedChanges(true);
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      saveTimeoutRef.current = null;
      handleSave(text);
    }, 2000);
  }, [handleSave]);

  const syncFilenameFromTitle = useCallback((title: string) => {
    if (filenameManuallyEditedRef.current) return;
    const name = title.trim() || 'Untitled Note';
    const current = stripExtension(currentFilenameRef.current || '').trim();
    if (name === current) return;
    if (name === 'Untitled Note' && isDefaultUntitledName(currentFilenameRef.current)) return;

    skipFilenameManualMarkRef.current = true;
    setFilename(name);
    currentFilenameRef.current = name;
    if (userId && draftId && !isNaN(draftId)) {
      void draftsCache.updateCachedFilename(userId, draftId, name);
    }
    setTimeout(() => {
      skipFilenameManualMarkRef.current = false;
    }, 0);
  }, [draftId, userId]);

  const handleWebViewMessage = useCallback((event: { nativeEvent: { data: string } }) => {
    const rawHtml = event.nativeEvent.data || '';
    
    // Handle double-tap toggle header
    if (rawHtml === '__DOUBLE_TAP__') {
      if (toggleEnabled) {
        toggleHeader();
      }
      return;
    }

    // Handle undo/redo availability update
    if (rawHtml.startsWith('__UNDO_STATE__:')) {
      try {
        const state = JSON.parse(rawHtml.slice('__UNDO_STATE__:'.length));
        setCanUndo(!!state.canUndo);
        setCanRedo(!!state.canRedo);
      } catch {}
      return;
    }

    if (rawHtml.startsWith('__TITLE__:')) {
      syncFilenameFromTitle(rawHtml.slice('__TITLE__:'.length));
      return;
    }
    
    const isEmpty = isDraftHtmlEmpty(rawHtml);
    if (isEmpty && ignoreFirstEmptyMessageRef.current) {
      ignoreFirstEmptyMessageRef.current = false;
      return;
    }
    const html = normalizeHtml(rawHtml);
    setContentHtml(html);
    contentHtmlRef.current = html;
    setContentText(stripHtmlToText(html));
    contentTextRef.current = stripHtmlToText(html);
    syncFilenameFromTitle(extractTitleFromDraftHtml(html));
    if (saveRequestedRef.current) {
      saveRequestedRef.current = false;
      handleSave(html, true);
      return;
    }
    setHasUnsavedChanges(true);
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      saveTimeoutRef.current = null;
      handleSave(html, true);
    }, 2000);
  }, [handleSave, normalizeHtml, syncFilenameFromTitle, toggleHeader, toggleEnabled]);

  const handleWebViewLoadEnd = useCallback(() => {
    const html = contentToInjectRef.current || EMPTY_DRAFT_HTML;
    const script = `(function(){
      var el=document.getElementById('content');
      if(!el) return;
      el.innerHTML=${JSON.stringify(html)};
      var h1=el.querySelector('h1');
      if(h1&&!h1.getAttribute('data-placeholder')) h1.setAttribute('data-placeholder','Title');
      var hasBody=false;
      var n=h1?h1.nextSibling:null;
      while(n){
        if(n.nodeType===1&&(n.nodeName==='P'||n.nodeName==='DIV')){ hasBody=true; break; }
        n=n.nextSibling;
      }
      if(h1&&!hasBody){
        var p=document.createElement('p');
        p.innerHTML='<br>';
        if(h1.nextSibling) el.insertBefore(p,h1.nextSibling);
        else el.appendChild(p);
      }
      if(h1&&window.ReactNativeWebView){
        var t=(h1.textContent||'').replace(/\\u00a0/g,' ').trim();
        if(t) window.ReactNativeWebView.postMessage('__TITLE__:'+t);
      }
      try{
        window.scrollTo(0,0);
        document.documentElement.scrollTop=0;
        document.body.scrollTop=0;
      }catch(e1){}
    })(); true;`;
    webViewRef.current?.injectJavaScript(script);
  }, []);

  /** WebView has no onScrollEndDrag — debounce scroll and restore header only when idle at a scroll extreme. */
  const handleWebViewScrollRestoreHeader = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!toggleEnabled) return;
      webViewScrollLastEventRef.current = e.nativeEvent;
      if (webViewScrollHeaderRestoreTimerRef.current) {
        clearTimeout(webViewScrollHeaderRestoreTimerRef.current);
      }
      webViewScrollHeaderRestoreTimerRef.current = setTimeout(() => {
        webViewScrollHeaderRestoreTimerRef.current = null;
        const ne = webViewScrollLastEventRef.current;
        if (ne && shouldRestoreHeaderAfterScrollToEdge(ne)) {
          showHeader();
        }
      }, 120);
    },
    [showHeader, toggleEnabled]
  );

  const handleSelectionChange = useCallback((e: any) => {
    const { start, end } = e.nativeEvent.selection;
    setSelection({ start, end });
    formatSelectionRef.current = { start, end };
    if (start !== 0 || end !== 0) selectionRef.current = { start, end };
  }, []);

  const captureSelectionForFormat = useCallback(() => {
    formatSelectionRef.current = { ...selectionRef.current };
  }, []);

  const execCommandAndSync = useCallback((command: string, value?: string) => {
    const cmd = value !== undefined
      ? `document.execCommand('${command}', false, ${JSON.stringify(value)});`
      : `document.execCommand('${command}', false);`;
    webViewRef.current?.injectJavaScript(
      `(function(){ var el=document.getElementById('content'); if(el){ el.focus(); ${cmd} if(window.ReactNativeWebView){ window.ReactNativeWebView.postMessage(el.innerHTML); window.ReactNativeWebView.postMessage('__UNDO_STATE__:'+JSON.stringify({canUndo:document.queryCommandEnabled('undo'),canRedo:document.queryCommandEnabled('redo')})); } } })(); true;`
    );
  }, []);

  const setForeColor = useCallback((color: string) => {
    // Use TipTap-compatible format: <span style="color: #hex">text</span>
    const script = `(function(){
      var el=document.getElementById('content');
      if(!el) return;
      el.focus();
      var sel=window.getSelection();
      if(!sel||sel.rangeCount===0) return;
      var range=sel.getRangeAt(0);
      if(range.collapsed) return;
      var span=document.createElement('span');
      span.style.color='${color}';
      try{range.surroundContents(span);}catch(e){
        var contents=range.extractContents();
        span.appendChild(contents);
        range.insertNode(span);
      }
      if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(el.innerHTML);
    })(); true;`;
    webViewRef.current?.injectJavaScript(script);
    setShowColorPicker(null);
  }, []);

  const setBackColor = useCallback((color: string) => {
    // Use TipTap-compatible format: <mark style="background-color: #hex">text</mark>
    const script = `(function(){
      var el=document.getElementById('content');
      if(!el) return;
      el.focus();
      var sel=window.getSelection();
      if(!sel||sel.rangeCount===0) return;
      var range=sel.getRangeAt(0);
      if(range.collapsed) return;
      var mark=document.createElement('mark');
      mark.style.backgroundColor='${color}';
      try{range.surroundContents(mark);}catch(e){
        var contents=range.extractContents();
        mark.appendChild(contents);
        range.insertNode(mark);
      }
      if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(el.innerHTML);
    })(); true;`;
    webViewRef.current?.injectJavaScript(script);
    setShowColorPicker(null);
  }, []);

  const applySelectionFontSize = useCallback((sizePx: (typeof DRAFT_FONT_SIZES_PX)[number]) => {
    const script = `(function(){
      var el=document.getElementById('content');
      if(!el) return;
      el.focus();
      var sel=window.getSelection();
      if(!sel||sel.rangeCount===0) return;
      var range=sel.getRangeAt(0);
      if(range.collapsed) return;
      var span=document.createElement('span');
      span.style.fontSize='${sizePx}px';
      try{range.surroundContents(span);}catch(e){
        var contents=range.extractContents();
        span.appendChild(contents);
        range.insertNode(span);
      }
      if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(el.innerHTML);
    })(); true;`;
    webViewRef.current?.injectJavaScript(script);
    setShowFontSizePicker(false);
  }, []);

  const insertTable = useCallback(() => {
    const script = `(function(){
      var el=document.getElementById('content');
      if(!el) return;
      el.focus();
      var table='<table border="1" style="border-collapse:collapse;width:100%;"><tr><td style="padding:8px;">&nbsp;</td><td style="padding:8px;">&nbsp;</td></tr><tr><td style="padding:8px;">&nbsp;</td><td style="padding:8px;">&nbsp;</td></tr></table>';
      document.execCommand('insertHTML',false,table);
      if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(el.innerHTML);
    })(); true;`;
    webViewRef.current?.injectJavaScript(script);
  }, []);

  const toggleLink = useCallback(() => {
    const script = `(function(){
      var el=document.getElementById('content');
      if(!el) return;
      el.focus();
      var sel=window.getSelection();
      if(!sel||sel.rangeCount===0) return;
      var range=sel.getRangeAt(0);
      var inLink=false;
      var node=range.commonAncestorContainer;
      while(node&&node!==el){
        if(node.nodeType===1&&node.nodeName&&node.nodeName.toUpperCase()==='A'){
          inLink=true;
          break;
        }
        node=node.parentNode;
      }
      if(inLink){
        document.execCommand('unlink',false);
      }else{
        if(range.collapsed){
          document.execCommand('createLink',false,'https://');
        }else{
          document.execCommand('createLink',false,'https://');
        }
      }
      if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(el.innerHTML);
    })(); true;`;
    webViewRef.current?.injectJavaScript(script);
  }, []);

  const applyFormat = useCallback((prefix: string, suffix: string) => {
    const { start, end } = formatSelectionRef.current;
    const text = contentTextRef.current;
    const len = text.length;
    const safeStart = Math.min(Math.max(0, start), len);
    const safeEnd = Math.min(Math.max(safeStart, end), len);
    const before = text.slice(0, safeStart);
    const selected = text.slice(safeStart, safeEnd);
    const after = text.slice(safeEnd);
    const newText = before + prefix + selected + suffix + after;
    const newCursor = Math.min(safeStart + prefix.length + selected.length + suffix.length, newText.length);
    setContentText(newText);
    contentTextRef.current = newText;
    setSelection({ start: newCursor, end: newCursor });
    formatSelectionRef.current = { start: newCursor, end: newCursor };
    setHasUnsavedChanges(true);
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      saveTimeoutRef.current = null;
      handleSave(newText);
    }, 2000);
    requestAnimationFrame(() => {
      editorRef.current?.focus();
      setSelection({ start: newCursor, end: newCursor });
    });
  }, [handleSave]);

  const insertAtCursor = useCallback((insert: string) => {
    const { start, end } = formatSelectionRef.current;
    const text = contentTextRef.current;
    const len = text.length;
    const safeStart = Math.min(Math.max(0, start), len);
    const safeEnd = Math.min(Math.max(safeStart, end), len);
    const before = text.slice(0, safeStart);
    const after = text.slice(safeEnd);
    const newText = before + insert + after;
    const newCursor = Math.min(safeStart + insert.length, newText.length);
    setContentText(newText);
    contentTextRef.current = newText;
    setSelection({ start: newCursor, end: newCursor });
    formatSelectionRef.current = { start: newCursor, end: newCursor };
    setHasUnsavedChanges(true);
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      saveTimeoutRef.current = null;
      handleSave(newText);
    }, 2000);
    requestAnimationFrame(() => {
      editorRef.current?.focus();
      setSelection({ start: newCursor, end: newCursor });
    });
  }, [handleSave]);

  /** Persist current filename to server if it changed. Call on blur, Back, and Save. */
  const persistFilenameIfChanged = useCallback(async (): Promise<void> => {
    const name = (currentFilenameRef.current || '').trim() || 'Untitled Note';
    const initial = stripExtension(initialFilenameRef.current ?? '').trim() || 'Untitled Note';
    if (stripExtension(name).trim() === initial) return;
    if (!draftId || isNaN(draftId) || !userId) return;
    // Always update local cache immediately
    await draftsCache.updateCachedFilename(userId, draftId, name);
    initialFilenameRef.current = name;
    if (draftsCache.isLocalDraftId(draftId)) {
      await draftsCache.updatePendingCreate(userId, draftId, { filename: name });
      return;
    }
    try {
      await apiClient.renameFile(draftId, name);
    } catch (e: any) {
      if (!isNetworkError(e)) throw e;
      await draftsCache.addPendingRename(userId, { id: draftId, filename: name });
      setSaveStatus('local');
    }
  }, [draftId, userId]);

  const reportRenamePersistError = useCallback((e: any) => {
    if (isNetworkError(e)) return;
    Alert.alert('Rename failed', toAlertMessage(e?.message ?? e?.response?.data?.message, 'Could not rename note'));
  }, []);

  const handleRenameBlur = useCallback(async () => {
    try {
      await persistFilenameIfChanged();
    } catch (e: any) {
      reportRenamePersistError(e);
    }
  }, [persistFilenameIfChanged, reportRenamePersistError]);

  const handleAskChatGD = useCallback(() => {
    setEditorMenuVisible(false);
    if (!draftId || isNaN(draftId)) return;
    if (draftsCache.isLocalDraftId(draftId)) {
      Alert.alert(
        'Note not synced yet',
        'Save this note while online before asking ChatGD about it.',
      );
      return;
    }
    openChatGD({
      fileId: String(draftId),
      fileName: (filename || 'Untitled Note').trim(),
      chatPlaceholder: 'Ask about this note',
    });
  }, [draftId, filename, openChatGD]);

  const handleNewNote = useCallback(async () => {
    if (creatingNote || !userId || !split) return;
    setCreatingNote(true);
    try {
      const list = (await draftsCache.getDraftsList(userId)) || [];
      await split.createAndOpenNewDraft(list);
    } finally {
      setCreatingNote(false);
    }
  }, [creatingNote, userId, split]);

  const handleBack = useCallback(async () => {
    if (!userId) { router.back(); return; }

    // If the note was opened empty and the user never added content or changed
    // the title, discard it entirely rather than leaving an empty shell.
    if (wasCreatedEmptyRef.current) {
      const titleFromEditor = extractTitleFromDraftHtml(contentHtmlRef.current);
      const currentTitle = (currentFilenameRef.current || '').trim();
      const stillEmpty = isDraftBodyEmpty(contentHtmlRef.current) && !titleFromEditor;
      const stillUntitled = !currentTitle || currentTitle === 'Untitled Note';

      if (stillEmpty && stillUntitled) {
        try {
          if (draftsCache.isLocalDraftId(draftId)) {
            await draftsCache.removePendingCreate(userId, draftId);
            await draftsCache.removePendingSave(userId, draftId);
            await draftsCache.removePendingRename(userId, draftId);
            await draftsCache.removeFromDraftsList(userId, draftId);
            await draftsCache.deleteDraftContent(userId, draftId);
          } else if (!isNaN(draftId)) {
            await apiClient.deleteDraft(draftId);
            await draftsCache.removePendingSave(userId, draftId);
            await draftsCache.removePendingRename(userId, draftId);
            await draftsCache.removeFromDraftsList(userId, draftId);
            await draftsCache.deleteDraftContent(userId, draftId);
          }
        } catch (_) {
          // Best-effort — still navigate back
        }
        router.back();
        return;
      }
    }

    try {
      await persistFilenameIfChanged();
    } catch (_) {
      // Allow leaving even if rename failed; user already has name in field
    }
    if (hasUnsavedRef.current) {
      Alert.alert('Unsaved changes', 'Leave without saving?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Leave', style: 'destructive', onPress: () => router.back() },
      ]);
    } else {
      router.back();
    }
  }, [router, persistFilenameIfChanged, userId, draftId]);

  // Debounced immediate save of filename when user types (persist after 600ms idle). Only run after draft has loaded so we don't trigger a rename on open (e.g. shared file permission error).
  useEffect(() => {
    if (!draftId || isNaN(draftId) || !draftLoadedRef.current) return;
    if (renameTimeoutRef.current) clearTimeout(renameTimeoutRef.current);
    const name = (filename || '').trim() || 'Untitled Note';
    const initial = stripExtension(initialFilenameRef.current ?? '').trim() || 'Untitled Note';
    if (stripExtension(name).trim() === initial) return;
    const timeoutId = setTimeout(() => {
      renameTimeoutRef.current = null;
      persistFilenameIfChanged().catch(reportRenamePersistError);
    }, 600);
    renameTimeoutRef.current = timeoutId;
    return () => {
      clearTimeout(timeoutId);
      if (renameTimeoutRef.current === timeoutId) renameTimeoutRef.current = null;
    };
  }, [draftId, filename, persistFilenameIfChanged, reportRenamePersistError]);

  const others = Array.from(presenceEditors.entries()).map(([uid, name]) => ({ id: uid, name }));
  const othersLabel = others.length === 0
    ? ''
    : others.length === 1
      ? `${others[0].name} is editing`
      : others.length === 2
        ? `${others[0].name} and ${others[1].name} are editing`
        : `${others.length} people are editing`;

  const editorMoreButtonRef = useRef<View>(null);
  const [editorMenuVisible, setEditorMenuVisible] = useState(false);
  const [editorMenuAnchor, setEditorMenuAnchor] = useState({ top: 0, right: 0 });

  const handleEditorMoreOptions = useCallback(() => {
    editorMoreButtonRef.current?.measureInWindow((x, y, width, height) => {
      const screenWidth = Dimensions.get('window').width;
      setEditorMenuAnchor({ top: y + height + 6, right: screenWidth - x - width });
      setEditorMenuVisible(true);
    });
  }, []);

  const handleCreateShareLink = useCallback(async () => {
    if (!draftId || isNaN(draftId)) return;
    setLinkLoading(true);
    try {
      const expiresInDays = shareExpirationDays.trim() ? parseInt(shareExpirationDays.trim(), 10) : undefined;
      const effectiveExpiry = expiresInDays && !isNaN(expiresInDays) ? expiresInDays : undefined;
      const res = await apiClient.createFileShareLink(draftId, {
        role: shareRole,
        expires_in_days: effectiveExpiry,
      });
      const link = (res as any)?.link ?? null;
      setShareLink(link);
      setShareLinkExpiresInDays(effectiveExpiry);
      if (link) {
        // Reload shares to show the new link
        await loadExternalShares();
        // Close create modal and open send modal
        setShowShareModal(false);
        setShowSendLinkModal(true);
      } else {
        Alert.alert('Error', toAlertMessage((res as any)?.message, 'Failed to create link'));
      }
    } catch (e: any) {
      Alert.alert('Error', toAlertMessage(e?.message ?? e?.response?.data?.message, 'Failed to create link'));
    } finally {
      setLinkLoading(false);
    }
  }, [draftId, shareRole, shareExpirationDays]);

  const handleCopyLink = useCallback(async (link?: string) => {
    const linkToCopy = link || shareLink;
    if (linkToCopy) {
      await Clipboard.setStringAsync(linkToCopy);
      Alert.alert('Copied', 'Link copied to clipboard');
    }
  }, [shareLink]);

  const handleShareLink = useCallback((link: string) => {
    setShareLink(link);
    setShowShareModal(false);
    setShowSendLinkModal(true);
  }, []);

  const handleSendInviteEmail = useCallback(async () => {
    if (!shareLink || !draftId) {
      Alert.alert('Create link first', 'Create a share link before sending by email.');
      return;
    }
    const emails = shareEmails.split(/[,\n]/).map(e => e.trim()).filter(e => e && e.includes('@'));
    if (emails.length === 0) {
      Alert.alert('Error', 'Enter at least one valid email address.');
      return;
    }
    setSendingEmail(true);
    try {
      await apiClient.sendFileShareLinkEmail(draftId, {
        share_link: shareLink,
        emails,
        message: shareMessage || undefined,
      });
      Alert.alert('Sent', `Invitation sent to ${emails.length} recipient(s).`);
      setShareEmails('');
      setShareMessage('');
      setShowSendLinkModal(false);
    } catch (e: any) {
      Alert.alert('Error', toAlertMessage(e?.message ?? e?.response?.data?.message, 'Failed to send email'));
    } finally {
      setSendingEmail(false);
    }
  }, [draftId, shareLink, shareEmails, shareMessage]);

  const displayFilename = stripExtension(filename);
  const roleOptions: { value: 'viewer' | 'member' | 'admin'; label: string }[] = [
    { value: 'viewer', label: 'Viewer' },
    { value: 'member', label: 'Member' },
    { value: 'admin', label: 'Admin' },
  ];

  const [headerBlockHeight, setHeaderBlockHeight] = useState(56);
  const onHeaderBlockLayout = useCallback((e: LayoutChangeEvent) => {
    const h = Math.ceil(e.nativeEvent.layout.height);
    if (h > 0) setHeaderBlockHeight(h);
  }, []);

  const webViewSource = useMemo(
    () => ({ html: getRichEditorBaseHtml(colors.background || '#fff', colors.text || '#000', isDarkMode) }),
    [colors.background, colors.text, isDarkMode]
  );

  const dynamicStyles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.headerBackground },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 8,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      backgroundColor: colors.headerBackground,
    },
    backBtn: { paddingHorizontal: 6, paddingVertical: 8 },
    titleWrap: { flex: 1, minWidth: 0, paddingHorizontal: 4 },
    title: { fontSize: 24, fontWeight: '700', color: colors.text, letterSpacing: -0.3 },
    titleInput: {
      fontSize: 24,
      fontWeight: '700',
      color: colors.text,
      letterSpacing: -0.3,
      padding: 0,
      margin: 0,
    },
    headerActions: { flexDirection: 'row', alignItems: 'center' },
    headerBtn: { paddingHorizontal: 6, paddingVertical: 8 },
    offlineBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: '#FF9500',
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 10,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.15,
      shadowRadius: 4,
      elevation: 4,
    },
    offlineBannerText: {
      fontSize: 13,
      color: '#fff',
      fontWeight: '600',
      marginLeft: 8,
      flex: 1,
    },
    presenceBar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 6,
      backgroundColor: colors.border + '40',
    },
    presenceText: { fontSize: 12, color: colors.textSecondary, marginLeft: 6 },
    toolbar: {
      minHeight: 48,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      backgroundColor: colors.card,
    },
    keyboardToolbar: {
      position: 'absolute',
      left: 6,
      right: 6,
      paddingVertical: 4,
      paddingHorizontal: 6,
      backgroundColor: colors.card,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: -3 },
      shadowOpacity: isDarkMode ? 0.4 : 0.12,
      shadowRadius: 8,
      elevation: 8,
    },
    toolbarScroll: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 0, minHeight: 44 },
    toolBtn: {
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 48,
      height: 44,
      borderRadius: 9,
      marginRight: 2,
      backgroundColor: colors.background,
      paddingHorizontal: 6,
    },
    toolBtnDivider: {
      width: StyleSheet.hairlineWidth,
      height: 28,
      backgroundColor: colors.border,
      marginHorizontal: 4,
    },
    editorWrap: { flex: 1, paddingTop: 0, paddingBottom: 0, paddingHorizontal: 0 },
    localSaveToast: {
      position: 'absolute',
      top: 8,
      left: 12,
      right: 12,
      zIndex: 10,
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: '#FF9500',
      paddingLeft: 12,
      paddingRight: 4,
      paddingVertical: 8,
      borderRadius: 10,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.15,
      shadowRadius: 4,
      elevation: 4,
    },
    localSaveToastCloseBtn: {
      padding: 8,
      marginLeft: 4,
    },
    editor: {
      flex: 1,
      fontSize: 16,
      color: colors.text,
      textAlignVertical: 'top',
      minHeight: 200,
    },
    modalOverlay: modalScrimOverlayStyle(isDarkMode, {
      justifyContent: 'center',
      alignItems: 'center',
      padding: 20,
    }),
    modalBox: {
      ...floatingDialogSurfaceStyle(colors, isDarkMode),
      borderRadius: 12,
      padding: 0,
      minWidth: 280,
      maxWidth: 400,
      maxHeight: '90%',
      alignSelf: 'center',
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
    },
    modalBoxCompact: {
      ...floatingDialogSurfaceStyle(colors, isDarkMode),
      borderRadius: 12,
      padding: 0,
      minWidth: 320,
      maxWidth: 480,
      maxHeight: '80%',
      alignSelf: 'center',
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
    },
    modalBody: {
      padding: 12,
      paddingBottom: 0,
      flexGrow: 0,
    },
    modalBodyScroll: {
      padding: 20,
      paddingBottom: 16,
      flexGrow: 0,
    },
    modalBodySendLink: {
      paddingHorizontal: 12,
      paddingTop: 6,
      paddingBottom: 12,
      flexGrow: 0,
    },
    modalHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 10,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    modalTitleRow: { flexDirection: 'row', alignItems: 'center', flex: 1 },
    modalTitle: { fontSize: 18, fontWeight: '600', color: colors.text, marginLeft: 8 },
    modalCloseBtn: { padding: 8, margin: -8 },
    modalFileName: { fontSize: 14, color: colors.textSecondary, marginBottom: 16 },
    modalLabel: { fontSize: 14, fontWeight: '600', color: colors.text, marginBottom: 6 },
    modalLabelHint: { fontSize: 12, color: colors.textSecondary, marginBottom: 4 },
    modalRoleRow: { flexDirection: 'row', marginBottom: 12 },
    modalRoleOption: {
      flex: 1,
      marginRight: 8,
      paddingVertical: 10,
      paddingHorizontal: 8,
      borderRadius: 8,
      borderWidth: 1,
      alignItems: 'center',
    },
    modalRoleOptionActive: { borderColor: '#007AFF', backgroundColor: '#007AFF20' },
    modalRoleOptionInactive: { borderColor: colors.border, backgroundColor: colors.background },
    modalBtn: {
      backgroundColor: '#007AFF',
      paddingVertical: 10,
      paddingHorizontal: 16,
      borderRadius: 10,
      alignItems: 'center',
      marginBottom: 0,
    },
    modalBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
    modalBtnSecondary: {
      backgroundColor: 'transparent',
      borderWidth: 1,
      borderColor: colors.border,
      paddingVertical: 10,
      paddingHorizontal: 16,
      borderRadius: 10,
      alignItems: 'center',
      marginBottom: 0,
    },
    modalBtnSecondaryText: { color: colors.text, fontSize: 16, fontWeight: '600' },
    modalBtnGreen: { backgroundColor: '#34C759' },
    modalInput: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      padding: 10,
      fontSize: 14,
      color: colors.text,
      backgroundColor: colors.background,
      minHeight: 40,
      marginBottom: 10,
    },
    modalLinkRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
    modalLinkInput: {
      flex: 1,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      padding: 10,
      fontSize: 13,
      color: colors.text,
      backgroundColor: colors.background,
    },
    modalCopyBtn: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, backgroundColor: '#007AFF' },
    modalCopyBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
    modalSection: { marginBottom: 20 },
    modalSectionSendLink: { marginBottom: 12 },
    modalSectionTitle: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
    modalSectionTitleSendLink: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
    modalSectionTitleText: { fontSize: 15, fontWeight: '600', color: colors.text, marginLeft: 6 },
    shareLinksContainer: { marginBottom: 10, paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
    shareLinksTitle: { fontSize: 14, fontWeight: '600', color: colors.text, marginBottom: 12, flexDirection: 'row', alignItems: 'center' },
    shareLinkItem: {
      flexDirection: 'column',
      paddingVertical: 6,
      paddingHorizontal: 0,
      marginBottom: 6,
    },
    shareLinkInfo: { flex: 1, minWidth: 0, marginBottom: 8 },
    shareLinkType: { fontSize: 13, fontWeight: '600', color: colors.text },
    shareLinkDetails: { fontSize: 11, color: colors.textSecondary, marginTop: 4 },
    shareLinkActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    shareLinkRevokeBtn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 6, backgroundColor: '#FF3B30' },
    shareLinkRevokeBtnText: { color: '#fff', fontSize: 12, fontWeight: '600' },
    shareLinkDeleteBtn: { padding: 6, borderRadius: 6, backgroundColor: '#FF3B30' },
    popoverOverlay: anchoredPopoverOverlayStyle(isDarkMode),
    popoverCard: anchoredPopoverCardStyle(colors, isDarkMode),
    popoverItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 13,
      paddingHorizontal: 16,
    },
    popoverItemBorder: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    popoverItemIcon: { marginRight: 12 },
    popoverItemText: { fontSize: 16, color: colors.text, flex: 1 },
    popoverItemTextDestructive: { fontSize: 16, color: '#FF3B30', flex: 1 },
  }), [colors, isDarkMode]);

  if (loading) {
    return (
      <SafeAreaView
        style={[dynamicStyles.container, { justifyContent: 'center', alignItems: 'center' }]}
        edges={isSplitMode ? [] : ['top']}
      >
        <ActivityIndicator size="large" color={colors.primary || '#007AFF'} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={dynamicStyles.container} edges={isSplitMode ? [] : ['top']}>
      <TapToToggleHeaderView style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={0}>
        <AnimatedHeaderContainer height={headerBlockHeight}>
          <View onLayout={onHeaderBlockLayout}>
          <View style={dynamicStyles.header}>
            {!isSplitMode && (
              <AppBackButton onPress={handleBack} />
            )}
            <View style={[dynamicStyles.titleWrap, isSplitMode && { paddingLeft: 12 }]}>
              <TextInput
                ref={filenameInputRef}
                style={dynamicStyles.titleInput}
                value={filename}
                onChangeText={(text) => {
                  if (!skipFilenameManualMarkRef.current) {
                    filenameManuallyEditedRef.current = true;
                  }
                  setFilename(text);
                }}
                onBlur={handleRenameBlur}
                placeholder="Untitled Note"
                placeholderTextColor={colors.textSecondary}
                selectTextOnFocus
                returnKeyType="done"
                blurOnSubmit
                underlineColorAndroid="transparent"
              />
            </View>
            <View style={dynamicStyles.headerActions}>
              {saving ? (
                <ActivityIndicator size="small" color={colors.textSecondary} style={{ marginRight: 4, padding: 10 }} />
              ) : saveStatus === 'saved' ? (
                <Ionicons name="checkmark-circle" size={30} color="#34C759" style={{ marginRight: 2, padding: 8 }} />
              ) : null}
              {draftId && !isNaN(draftId) && !draftsCache.isLocalDraftId(draftId) ? (
                <View style={{ marginRight: 8, justifyContent: 'center' }}>
                  <ClientsButton itemType="file" itemId={draftId} compact />
                </View>
              ) : null}
              {isSplitMode && (
                <TouchableOpacity
                  style={dynamicStyles.headerBtn}
                  onPress={handleNewNote}
                  disabled={creatingNote}
                  accessibilityLabel="New note"
                  accessibilityRole="button"
                >
                  {creatingNote ? (
                    <ActivityIndicator size="small" color={colors.primary || '#007AFF'} />
                  ) : (
                    <Ionicons name="create-outline" size={30} color={colors.primary || '#007AFF'} />
                  )}
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={dynamicStyles.headerBtn}
                onPress={() => { if (shareLink) setShowSendLinkModal(true); else setShowShareModal(true); }}
              >
                <Ionicons name="share-outline" size={30} color={colors.primary || '#007AFF'} />
              </TouchableOpacity>
              <TouchableOpacity ref={editorMoreButtonRef} style={dynamicStyles.headerBtn} onPress={handleEditorMoreOptions}>
                <Ionicons name="ellipsis-horizontal-circle" size={30} color={colors.primary || '#007AFF'} />
              </TouchableOpacity>
            </View>
          </View>
          {othersLabel ? (
            <TouchableOpacity
              style={dynamicStyles.presenceBar}
              onPress={() => setShowEditorsModal(true)}
              activeOpacity={0.7}
            >
              <Ionicons name="people-outline" size={16} color={colors.textSecondary} />
              <Text style={dynamicStyles.presenceText}>{othersLabel}</Text>
              <Ionicons name="chevron-forward" size={14} color={colors.textSecondary} style={{ marginLeft: 4 }} />
            </TouchableOpacity>
          ) : null}
          </View>
        </AnimatedHeaderContainer>

        <View style={dynamicStyles.editorWrap}>
          {localSaveToastVisible ? (
            <View style={dynamicStyles.localSaveToast}>
              <Ionicons name="cloud-offline-outline" size={16} color="#fff" />
              <Text style={dynamicStyles.offlineBannerText}>Saved locally — will sync when online</Text>
              <TouchableOpacity
                style={dynamicStyles.localSaveToastCloseBtn}
                onPress={dismissLocalSaveToast}
                accessibilityLabel="Dismiss saved locally notice"
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="close" size={18} color="#fff" />
              </TouchableOpacity>
            </View>
          ) : null}
          {initialEditorHtml !== null ? (
            <WebView
              key={`draft-${draftId}`}
              ref={webViewRef}
              originWhitelist={['*']}
              source={webViewSource}
              onLoadEnd={handleWebViewLoadEnd}
              onMessage={handleWebViewMessage}
              onScroll={toggleEnabled ? handleWebViewScrollRestoreHeader : undefined}
              scrollEventThrottle={toggleEnabled ? 16 : undefined}
              style={[dynamicStyles.editor, { backgroundColor: colors.background, minHeight: 200 }]}
              scrollEnabled={true}
              keyboardDisplayRequiresUserAction={false}
              nestedScrollEnabled
              hideKeyboardAccessoryView={true}
              {...(Platform.OS === 'ios'
                ? {
                    automaticallyAdjustContentInsets: false,
                    contentInsetAdjustmentBehavior: 'never' as const,
                  }
                : {})}
            />
          ) : (
            <View style={[dynamicStyles.editor, { backgroundColor: colors.background, minHeight: 200, justifyContent: 'center', alignItems: 'center' }]}>
              <ActivityIndicator size="small" color={colors.primary} />
            </View>
          )}
        </View>
      </KeyboardAvoidingView>

      {keyboardHeight > 0 ? (
        <View style={[dynamicStyles.keyboardToolbar, { bottom: keyboardHeight }]}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={dynamicStyles.toolbarScroll}
            keyboardShouldPersistTaps="always"
          >
            {/* Undo / Redo */}
            {canUndo && (
            <TouchableOpacity style={dynamicStyles.toolBtn} onPress={() => execCommandAndSync('undo')} accessibilityLabel="Undo">
              <Ionicons name="arrow-undo-outline" size={24} color={colors.text} />
            </TouchableOpacity>
            )}
            {canRedo && (
            <TouchableOpacity style={dynamicStyles.toolBtn} onPress={() => execCommandAndSync('redo')} accessibilityLabel="Redo">
              <Ionicons name="arrow-redo-outline" size={24} color={colors.text} />
            </TouchableOpacity>
            )}

            <View style={dynamicStyles.toolBtnDivider} />

            {/* Bold / Italic / Underline */}
            <TouchableOpacity style={dynamicStyles.toolBtn} onPress={() => execCommandAndSync('bold')} accessibilityLabel="Bold">
              <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text, letterSpacing: -0.5 }}>B</Text>
            </TouchableOpacity>
            <TouchableOpacity style={dynamicStyles.toolBtn} onPress={() => execCommandAndSync('italic')} accessibilityLabel="Italic">
              <Text style={{ fontSize: 20, fontStyle: 'italic', fontWeight: '700', color: colors.text }}>I</Text>
            </TouchableOpacity>
            <TouchableOpacity style={dynamicStyles.toolBtn} onPress={() => execCommandAndSync('underline')} accessibilityLabel="Underline">
              <Text style={{ fontSize: 20, fontWeight: '700', color: colors.text, textDecorationLine: 'underline' }}>U</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={dynamicStyles.toolBtn}
              onPress={() => { setShowColorPicker(null); setShowFontSizePicker(true); }}
              accessibilityLabel="Font size"
            >
              <Text style={{ fontSize: 19, fontWeight: '700', color: colors.text }}>Aa</Text>
            </TouchableOpacity>

            <View style={dynamicStyles.toolBtnDivider} />

            {/* Lists */}
            <TouchableOpacity style={dynamicStyles.toolBtn} onPress={() => execCommandAndSync('insertUnorderedList')} accessibilityLabel="Bullet list">
              <Ionicons name="list-outline" size={24} color={colors.text} />
            </TouchableOpacity>
            <TouchableOpacity style={dynamicStyles.toolBtn} onPress={() => execCommandAndSync('insertOrderedList')} accessibilityLabel="Numbered list">
              <Ionicons name="reorder-four-outline" size={24} color={colors.text} />
            </TouchableOpacity>
            <TouchableOpacity style={dynamicStyles.toolBtn} onPress={() => execCommandAndSync('indent')} accessibilityLabel="Indent">
              <Ionicons name="chevron-forward-outline" size={24} color={colors.text} />
            </TouchableOpacity>
            <TouchableOpacity style={dynamicStyles.toolBtn} onPress={() => execCommandAndSync('outdent')} accessibilityLabel="Outdent">
              <Ionicons name="chevron-back-outline" size={24} color={colors.text} />
            </TouchableOpacity>

            <View style={dynamicStyles.toolBtnDivider} />

            {/* Link / Color / Table */}
            <TouchableOpacity style={dynamicStyles.toolBtn} onPress={toggleLink} accessibilityLabel="Link">
              <Ionicons name="link-outline" size={24} color={colors.text} />
            </TouchableOpacity>
            <TouchableOpacity style={dynamicStyles.toolBtn} onPress={() => setShowColorPicker('fore')} accessibilityLabel="Text color">
              <Ionicons name="color-palette-outline" size={24} color={colors.text} />
            </TouchableOpacity>
            <TouchableOpacity style={dynamicStyles.toolBtn} onPress={() => setShowColorPicker('back')} accessibilityLabel="Highlight">
              <Ionicons name="color-fill-outline" size={24} color={colors.text} />
            </TouchableOpacity>
            <TouchableOpacity style={dynamicStyles.toolBtn} onPress={insertTable} accessibilityLabel="Insert table">
              <Ionicons name="grid-outline" size={24} color={colors.text} />
            </TouchableOpacity>
          </ScrollView>
        </View>
      ) : null}

      {/* Color Picker Modal */}
      <Modal visible={showColorPicker !== null} transparent animationType="fade">
        <TouchableOpacity
          activeOpacity={1}
          style={dynamicStyles.modalOverlay}
          onPress={() => setShowColorPicker(null)}
        >
          <TouchableOpacity activeOpacity={1} onPress={e => e.stopPropagation()} style={[dynamicStyles.modalBoxCompact, { minWidth: 200, maxWidth: 260 }]}>
            <View style={[dynamicStyles.modalHeader, { paddingTop: 8, paddingBottom: 6, paddingHorizontal: 12 }]}>
              <Text style={[dynamicStyles.modalTitle, { fontSize: 14, marginLeft: 4 }]}>
                {showColorPicker === 'fore' ? 'Text Color' : 'Background Color'}
              </Text>
              <TouchableOpacity
                style={dynamicStyles.modalCloseBtn}
                onPress={() => setShowColorPicker(null)}
              >
                <Ionicons name="close" size={18} color={colors.text} />
              </TouchableOpacity>
            </View>
            <View style={{ padding: 8, paddingBottom: 12 }}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6, width: 180 }}>
                {['#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF', '#808080', '#800000', '#008000', '#000080', '#808000', '#800080', '#008080'].map((color) => (
                  <TouchableOpacity
                    key={color}
                    onPress={() => showColorPicker === 'fore' ? setForeColor(color) : setBackColor(color)}
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 15,
                      backgroundColor: color,
                      borderWidth: 1,
                      borderColor: colors.border,
                    }}
                  />
                ))}
              </View>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal visible={showFontSizePicker} transparent animationType="fade">
        <TouchableOpacity
          activeOpacity={1}
          style={dynamicStyles.modalOverlay}
          onPress={() => setShowFontSizePicker(false)}
        >
          <TouchableOpacity activeOpacity={1} onPress={e => e.stopPropagation()} style={[dynamicStyles.modalBoxCompact, { minWidth: 200, maxWidth: 280 }]}>
            <View style={[dynamicStyles.modalHeader, { paddingTop: 8, paddingBottom: 6, paddingHorizontal: 12 }]}>
              <Text style={[dynamicStyles.modalTitle, { fontSize: 14, marginLeft: 4 }]}>Font size</Text>
              <TouchableOpacity style={dynamicStyles.modalCloseBtn} onPress={() => setShowFontSizePicker(false)}>
                <Ionicons name="close" size={18} color={colors.text} />
              </TouchableOpacity>
            </View>
            <View style={{ paddingHorizontal: 8, paddingBottom: 12 }}>
              {DRAFT_FONT_SIZES_PX.map((px) => (
                <TouchableOpacity
                  key={px}
                  onPress={() => applySelectionFontSize(px)}
                  style={{
                    paddingVertical: 10,
                    paddingHorizontal: 12,
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: colors.border,
                  }}
                >
                  <Text style={{ fontSize: px, color: colors.text }}>
                    {px}px{px === 16 ? ' — default' : ''}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
      </TapToToggleHeaderView>

      {/* Currently editing – list of other editors */}
      <Modal visible={showEditorsModal} transparent animationType="fade">
        <TouchableOpacity
          activeOpacity={1}
          style={dynamicStyles.modalOverlay}
          onPress={() => setShowEditorsModal(false)}
        >
          <TouchableOpacity activeOpacity={1} onPress={e => e.stopPropagation()} style={[dynamicStyles.modalBox, { minWidth: 280, maxWidth: 360 }]}>
            <View style={[dynamicStyles.modalHeader, { paddingBottom: 12 }]}>
              <View style={dynamicStyles.modalTitleRow}>
                <Ionicons name="people-outline" size={22} color={colors.text} />
                <Text style={dynamicStyles.modalTitle}>Currently editing</Text>
              </View>
              <TouchableOpacity style={dynamicStyles.modalCloseBtn} onPress={() => setShowEditorsModal(false)}>
                <Ionicons name="close" size={22} color={colors.text} />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 280 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16 }}>
              {others.map(({ id: uid, name }) => (
                <View key={uid} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
                  <Ionicons name="person-outline" size={18} color={colors.textSecondary} style={{ marginRight: 10 }} />
                  <Text style={{ fontSize: 16, color: colors.text }}>{name || 'Someone'}</Text>
                </View>
              ))}
            </ScrollView>
            <View style={{ padding: 16, paddingTop: 0 }}>
              <TouchableOpacity style={[dynamicStyles.modalBtn, { marginBottom: 0 }]} onPress={() => setShowEditorsModal(false)}>
                <Text style={dynamicStyles.modalBtnText}>Close</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Create Link Modal */}
      <Modal visible={showShareModal} transparent animationType="fade">
        <KeyboardAvoidingView 
          style={{ flex: 1 }} 
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
        >
          <TouchableOpacity
            activeOpacity={1}
            style={dynamicStyles.modalOverlay}
            onPress={() => {
              setShowShareModal(false);
            }}
          >
            <TouchableOpacity activeOpacity={1} onPress={e => e.stopPropagation()} style={[dynamicStyles.modalBox, { minWidth: 320, maxWidth: 480 }]}>
            <View style={[dynamicStyles.modalHeader, { paddingBottom: 12 }]}>
              <View style={dynamicStyles.modalTitleRow}>
                <Ionicons name="link-outline" size={22} color="#007AFF" />
                <Text style={dynamicStyles.modalTitle}>Create Share Link</Text>
              </View>
              <TouchableOpacity
                style={dynamicStyles.modalCloseBtn}
                onPress={() => { setShowShareModal(false); }}
              >
                <Ionicons name="close" size={24} color={colors.text} />
              </TouchableOpacity>
            </View>

            <ScrollView 
              style={{ maxHeight: Dimensions.get('window').height * 0.65, flexGrow: 0 }}
              contentContainerStyle={[dynamicStyles.modalBody, { padding: 16, paddingBottom: 20 }]}
              showsVerticalScrollIndicator={true}
              keyboardShouldPersistTaps="handled"
              bounces={false}
            >
              <Text style={[dynamicStyles.modalFileName, { marginBottom: 16 }]} numberOfLines={1}>{displayFilename}</Text>

              <Text style={[dynamicStyles.modalLabel, { marginBottom: 8 }]}>Access Role</Text>
              <View style={[dynamicStyles.modalRoleRow, { marginBottom: 16 }]}>
                {roleOptions.map(opt => (
                  <TouchableOpacity
                    key={opt.value}
                    style={[
                      dynamicStyles.modalRoleOption,
                      shareRole === opt.value ? dynamicStyles.modalRoleOptionActive : dynamicStyles.modalRoleOptionInactive,
                      { paddingVertical: 8, paddingHorizontal: 10 },
                    ]}
                    onPress={() => setShareRole(opt.value)}
                  >
                    <Text
                      style={{
                        fontSize: 12,
                        fontWeight: '600',
                        color: shareRole === opt.value ? '#007AFF' : colors.text,
                      }}
                      numberOfLines={1}
                    >
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={[dynamicStyles.modalLabel, { marginBottom: 4 }]}>Expiration (days)</Text>
              <Text style={[dynamicStyles.modalLabelHint, { marginBottom: 8 }]}>Leave empty for no expiration</Text>
              <TextInput
                style={[dynamicStyles.modalInput, { marginBottom: 20 }]}
                placeholder=""
                placeholderTextColor={colors.textSecondary}
                value={shareExpirationDays}
                onChangeText={setShareExpirationDays}
                keyboardType="number-pad"
              />
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12 }}>
                <TouchableOpacity
                  style={[dynamicStyles.modalBtnSecondary, { marginBottom: 0, paddingVertical: 10, paddingHorizontal: 16 }]}
                  onPress={() => { setShowShareModal(false); }}
                >
                  <Text style={dynamicStyles.modalBtnSecondaryText}>Cancel</Text>
                </TouchableOpacity>
                <FeedbackTouchable
                  style={[dynamicStyles.modalBtn, { marginBottom: 0, marginLeft: 12, minWidth: 100, paddingVertical: 10, paddingHorizontal: 16 }]}
                  onPress={handleCreateShareLink}
                  disabled={linkLoading}
                  loading={linkLoading}
                  spinnerColor="#fff"
                >
                  <Text style={dynamicStyles.modalBtnText}>Create Link</Text>
                </FeedbackTouchable>
              </View>

              {/* Existing Share Links */}
              {externalShares.length > 0 && (
                <View style={[dynamicStyles.shareLinksContainer, { marginTop: 20, marginBottom: 8, paddingBottom: 8 }]}>
                  {loadingShares ? (
                    <ActivityIndicator size="small" color={colors.primary || '#007AFF'} />
                  ) : (
                    <View>
                      {externalShares.map((share) => {
                        const isRevoked = share.revoked_at || !share.is_active;
                        const shareLinkUrl = share.share_type === 'link' && share.token
                          ? `${API_BASE_URL}/share/link?token=${share.token}`
                          : null;
                        return (
                          <View key={share.id} style={[dynamicStyles.shareLinkItem, { paddingVertical: 4, marginBottom: 4 }]}>
                            <View style={dynamicStyles.shareLinkInfo}>
                              {shareLinkUrl && !isRevoked && (
                                <Text style={[dynamicStyles.shareLinkDetails, { fontSize: 12, marginTop: 0 }]} numberOfLines={1}>
                                  {shareLinkUrl}
                                </Text>
                              )}
                              {isRevoked && shareLinkUrl && (
                                <Text style={[dynamicStyles.shareLinkDetails, { fontSize: 12, marginTop: 0, color: colors.textSecondary }]} numberOfLines={1}>
                                  {shareLinkUrl}
                                </Text>
                              )}
                              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
                                <View style={{ flex: 1 }}>
                                  {share.expires_at && (
                                    <Text style={dynamicStyles.shareLinkDetails}>
                                      Expires: {new Date(share.expires_at).toLocaleDateString()}
                                    </Text>
                                  )}
                                  {isRevoked && (
                                    <Text style={{ fontSize: 11, color: '#FF3B30', marginTop: share.expires_at ? 2 : 0 }}>(revoked)</Text>
                                  )}
                                </View>
                                {!isRevoked && shareLinkUrl && (
                                  <View style={dynamicStyles.shareLinkActions}>
                                    <TouchableOpacity
                                      style={[dynamicStyles.modalCopyBtn, { paddingVertical: 6, paddingHorizontal: 10 }]}
                                      onPress={() => handleShareLink(shareLinkUrl)}
                                    >
                                      <Ionicons name="share-outline" size={16} color="#fff" />
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                      style={[dynamicStyles.modalCopyBtn, { paddingVertical: 6, paddingHorizontal: 10 }]}
                                      onPress={() => handleCopyLink(shareLinkUrl)}
                                    >
                                      <Ionicons name="copy-outline" size={16} color="#fff" />
                                    </TouchableOpacity>
                                    <FeedbackTouchable
                                      style={[dynamicStyles.shareLinkRevokeBtn, { paddingVertical: 6, paddingHorizontal: 10 }]}
                                      onPress={() => handleRevokeShare(share.id)}
                                      spinnerColor="#fff"
                                      replaceWithSpinner={false}
                                    >
                                      <Ionicons name="ban-outline" size={16} color="#fff" />
                                    </FeedbackTouchable>
                                    <FeedbackTouchable
                                      style={[dynamicStyles.shareLinkDeleteBtn, { padding: 6 }]}
                                      onPress={() => handleDeleteShare(share.id)}
                                      spinnerColor="#fff"
                                      replaceWithSpinner={false}
                                    >
                                      <Ionicons name="trash-outline" size={16} color="#fff" />
                                    </FeedbackTouchable>
                                  </View>
                                )}
                                {isRevoked && (
                                  <FeedbackTouchable
                                    style={[dynamicStyles.shareLinkDeleteBtn, { padding: 6 }]}
                                    onPress={() => handleDeleteShare(share.id)}
                                    spinnerColor="#fff"
                                    replaceWithSpinner={false}
                                  >
                                    <Ionicons name="trash-outline" size={16} color="#fff" />
                                  </FeedbackTouchable>
                                )}
                              </View>
                            </View>
                          </View>
                        );
                      })}
                    </View>
                  )}
                </View>
              )}
            </ScrollView>
          </TouchableOpacity>
        </TouchableOpacity>
        </KeyboardAvoidingView>
      </Modal>

      {/* Send Link Modal - Shows link and email form */}
      <Modal visible={showSendLinkModal} transparent animationType="fade">
        <KeyboardAvoidingView 
          style={{ flex: 1 }} 
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
        >
          <TouchableOpacity
            activeOpacity={1}
            style={dynamicStyles.modalOverlay}
            onPress={() => {
              setShowSendLinkModal(false);
            }}
          >
            <TouchableOpacity activeOpacity={1} onPress={e => e.stopPropagation()} style={[dynamicStyles.modalBox, { minWidth: 320, maxWidth: 480 }]}>
            <View style={[dynamicStyles.modalHeader, { paddingBottom: 6 }]}>
              <View style={dynamicStyles.modalTitleRow}>
                <Ionicons name="mail-outline" size={22} color="#007AFF" />
                <Text style={dynamicStyles.modalTitle}>Send Share Link</Text>
              </View>
              <TouchableOpacity
                style={dynamicStyles.modalCloseBtn}
                onPress={() => { setShowSendLinkModal(false); }}
              >
                <Ionicons name="close" size={24} color={colors.text} />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={dynamicStyles.modalBodySendLink} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={true} bounces={false}>
              <Text style={[dynamicStyles.modalFileName, { marginBottom: 10 }]} numberOfLines={1}>{displayFilename}</Text>

              {shareLink ? (
                <>
                  <View style={dynamicStyles.modalSectionSendLink}>
                    <View style={dynamicStyles.modalLinkRow}>
                      <TextInput
                        style={dynamicStyles.modalLinkInput}
                        value={shareLink}
                        editable={false}
                        selectTextOnFocus
                      />
                      <TouchableOpacity style={[dynamicStyles.modalCopyBtn, { marginLeft: 8 }]} onPress={handleCopyLink}>
                        <Text style={dynamicStyles.modalCopyBtnText}>Copy</Text>
                      </TouchableOpacity>
                    </View>
                  </View>

                  <View style={[dynamicStyles.modalSectionSendLink, { marginBottom: 0 }]}>
                    <View style={dynamicStyles.modalSectionTitleSendLink}>
                      <Ionicons name="mail-outline" size={18} color={colors.text} />
                      <Text style={dynamicStyles.modalSectionTitleText}>Send via Email</Text>
                    </View>
                    <TextInput
                      style={[dynamicStyles.modalInput, { minHeight: 60, marginBottom: 8 }]}
                      placeholder="Email Addresses (comma or newline separated)"
                      placeholderTextColor={colors.textSecondary}
                      value={shareEmails}
                      onChangeText={setShareEmails}
                      multiline
                    />
                    <TextInput
                      style={[dynamicStyles.modalInput, { minHeight: 50, marginBottom: 10 }]}
                      placeholder="Add a personal message..."
                      placeholderTextColor={colors.textSecondary}
                      value={shareMessage}
                      onChangeText={setShareMessage}
                      multiline
                    />
                    <FeedbackTouchable
                      style={[dynamicStyles.modalBtn, dynamicStyles.modalBtnGreen, { marginBottom: 0 }]}
                      onPress={handleSendInviteEmail}
                      disabled={sendingEmail}
                      loading={sendingEmail}
                      spinnerColor="#fff"
                    >
                      <Text style={dynamicStyles.modalBtnText}>Send Email</Text>
                    </FeedbackTouchable>
                  </View>
                </>
              ) : (
                <View style={{ paddingVertical: 20 }}>
                  <Text style={[dynamicStyles.modalLabelHint, { textAlign: 'center' }]}>
                    No share link available. Create a link first.
                  </Text>
                  <TouchableOpacity
                    style={[dynamicStyles.modalBtn, { marginTop: 16 }]}
                    onPress={() => {
                      setShowSendLinkModal(false);
                      setShowShareModal(true);
                    }}
                  >
                    <Text style={dynamicStyles.modalBtnText}>Create Link</Text>
                  </TouchableOpacity>
                </View>
              )}
            </ScrollView>
          </TouchableOpacity>
        </TouchableOpacity>
        </KeyboardAvoidingView>
      </Modal>

      {/* Editor ... popover */}
      <Modal visible={editorMenuVisible} transparent animationType="fade" onRequestClose={() => setEditorMenuVisible(false)}>
        <TouchableWithoutFeedback onPress={() => setEditorMenuVisible(false)}>
          <View style={dynamicStyles.popoverOverlay}>
            <View style={[dynamicStyles.popoverCard, { top: editorMenuAnchor.top, right: editorMenuAnchor.right }]}>
              <TouchableOpacity
                style={[dynamicStyles.popoverItem, dynamicStyles.popoverItemBorder]}
                onPress={() => {
                  setEditorMenuVisible(false);
                  if (shareLink) setShowSendLinkModal(true);
                  else setShowShareModal(true);
                }}
              >
                <Ionicons name="share-outline" size={20} color={colors.text} style={dynamicStyles.popoverItemIcon} />
                <Text style={dynamicStyles.popoverItemText}>Share / Invite</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[dynamicStyles.popoverItem, dynamicStyles.popoverItemBorder]}
                onPress={() => {
                  setEditorMenuVisible(false);
                  setShowShareModal(true);
                }}
              >
                <Ionicons name="link-outline" size={20} color={colors.text} style={dynamicStyles.popoverItemIcon} />
                <Text style={dynamicStyles.popoverItemText}>Manage Links</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[dynamicStyles.popoverItem, dynamicStyles.popoverItemBorder]}
                onPress={() => {
                  setEditorMenuVisible(false);
                  setTheme(isDark ? 'light' : 'dark');
                }}
              >
                <Ionicons
                  name={isDark ? 'sunny-outline' : 'moon-outline'}
                  size={20}
                  color={colors.text}
                  style={dynamicStyles.popoverItemIcon}
                />
                <Text style={dynamicStyles.popoverItemText}>
                  {isDark ? 'Light Background' : 'Dark Background'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[dynamicStyles.popoverItem, dynamicStyles.popoverItemBorder]}
                onPress={handleAskChatGD}
              >
                <Ionicons name="chatbubbles-outline" size={20} color={colors.text} style={dynamicStyles.popoverItemIcon} />
                <Text style={dynamicStyles.popoverItemText}>Ask ChatGD</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[dynamicStyles.popoverItem, others.length > 0 ? dynamicStyles.popoverItemBorder : undefined]}
                onPress={() => {
                  setEditorMenuVisible(false);
                  Alert.alert(
                    'Move to Trash?',
                    'You can restore this note within 30 days from Deleted Notes.',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Move to Trash',
                        style: 'destructive',
                        onPress: async () => {
                          if (!userId) return;
                          const snapshot = split?.getListSnapshot() ?? [];
                          try {
                            if (draftsCache.isLocalDraftId(draftId)) {
                              await draftsCache.removePendingCreate(userId, draftId);
                              await draftsCache.removePendingSave(userId, draftId);
                              await draftsCache.removePendingRename(userId, draftId);
                              await draftsCache.removeFromDraftsList(userId, draftId);
                              await draftsCache.deleteDraftContent(userId, draftId);
                            } else if (!isNaN(draftId)) {
                              await apiClient.deleteDraft(draftId);
                              await draftsCache.removePendingSave(userId, draftId);
                              await draftsCache.removePendingRename(userId, draftId);
                              await draftsCache.removeFromDraftsList(userId, draftId);
                              await draftsCache.deleteDraftContent(userId, draftId);
                            }
                            split?.refreshList();
                            if (isSplitMode) {
                              split?.handleDeleteNavigation(draftId, { snapshot });
                            } else {
                              router.back();
                            }
                          } catch (e: any) {
                            Alert.alert('Error', toAlertMessage(e?.message ?? e?.response?.data?.message, 'Could not delete note'));
                          }
                        },
                      },
                    ]
                  );
                }}
              >
                <Ionicons name="trash-outline" size={20} color="#FF3B30" style={dynamicStyles.popoverItemIcon} />
                <Text style={dynamicStyles.popoverItemTextDestructive}>Delete Note</Text>
              </TouchableOpacity>
              {others.length > 0 && (
                <TouchableOpacity
                  style={dynamicStyles.popoverItem}
                  onPress={() => { setEditorMenuVisible(false); setShowEditorsModal(true); }}
                >
                  <Ionicons name="people-outline" size={20} color={colors.text} style={dynamicStyles.popoverItemIcon} />
                  <Text style={dynamicStyles.popoverItemText}>Currently Editing ({others.length})</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </SafeAreaView>
  );
}

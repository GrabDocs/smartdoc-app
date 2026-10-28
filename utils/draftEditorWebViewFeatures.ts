/**
 * Extra editor commands injected into the mobile note WebView (inside DRAFT_EDITOR_SCRIPT's IIFE,
 * which provides `el`, `getBlock`, `isInTitle`, and `sync`). Exposed as window.gd* functions.
 *
 * Find highlights use the CSS Custom Highlight API, so they never enter el.innerHTML (never saved).
 */
export const DRAFT_EDITOR_FEATURES_JS = `
      var GD_LEAF_SEL='p,div,h1,h2,h3,h4,li,td,th,blockquote';
      var GD_HL=!!(window.CSS&&CSS.highlights&&typeof window.Highlight==='function');

      function gdPost(s){ if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(s); }

      function gdCurrentRange(){
        var sel=window.getSelection();
        if(!sel||sel.rangeCount===0) return null;
        var r=sel.getRangeAt(0);
        return el.contains(r.commonAncestorContainer)?r:null;
      }

      function gdLeafBlocks(range){
        var all=el.querySelectorAll(GD_LEAF_SEL), out=[];
        for(var i=0;i<all.length;i++){
          var b=all[i];
          if(b.querySelector(GD_LEAF_SEL)) continue;
          if(range.intersectsNode(b)) out.push(b);
        }
        return out;
      }

      function gdUnwrap(n){
        var p=n.parentNode;
        if(!p) return;
        while(n.firstChild) p.insertBefore(n.firstChild,n);
        p.removeChild(n);
      }

      function gdWrapRange(r,prop,value){
        var frag=r.extractContents();
        var nested=frag.querySelectorAll('span,font');
        for(var j=0;j<nested.length;j++){
          var n=nested[j];
          if(n.nodeName==='SPAN'){
            n.style[prop]='';
            if(!n.getAttribute('style')) n.removeAttribute('style');
            if(!n.attributes.length) gdUnwrap(n);
          }else if(prop==='fontFamily'&&n.hasAttribute('face')){
            n.removeAttribute('face');
          }else if(prop==='fontSize'&&n.hasAttribute('size')){
            n.removeAttribute('size');
          }
        }
        if(!value){
          var marker=document.createTextNode('');
          r.insertNode(marker);
          marker.parentNode.insertBefore(frag,marker);
          marker.parentNode.removeChild(marker);
          return null;
        }
        var span=document.createElement('span');
        span.style[prop]=value;
        span.appendChild(frag);
        r.insertNode(span);
        return span;
      }

      function gdSubRanges(range){
        var subs=[];
        if(range.collapsed){
          var b=getBlock(range);
          if(!b) return subs;
          var whole=document.createRange();
          whole.selectNodeContents(b);
          subs.push(whole);
          return subs;
        }
        var blocks=gdLeafBlocks(range);
        if(!blocks.length){ subs.push(range.cloneRange()); return subs; }
        for(var i=0;i<blocks.length;i++){
          var s=document.createRange();
          s.selectNodeContents(blocks[i]);
          if(range.compareBoundaryPoints(Range.START_TO_START,s)>0) s.setStart(range.startContainer,range.startOffset);
          if(range.compareBoundaryPoints(Range.END_TO_END,s)<0) s.setEnd(range.endContainer,range.endOffset);
          if(!s.collapsed) subs.push(s);
        }
        return subs;
      }

      window.gdApplyInlineStyle=function(prop,value){
        var range=gdCurrentRange();
        if(!range) return;
        var subs=gdSubRanges(range);
        var first=null,last=null;
        for(var i=subs.length-1;i>=0;i--){
          var span=gdWrapRange(subs[i],prop,value);
          if(span){ if(!last) last=span; first=span; }
        }
        if(first&&last){
          var sel=window.getSelection();
          var nr=document.createRange();
          nr.setStartBefore(first);
          nr.setEndAfter(last);
          sel.removeAllRanges();
          sel.addRange(nr);
        }
        sync();
        gdFindRefresh();
      };

      window.gdApplyLineHeight=function(value){
        var range=gdCurrentRange();
        if(!range) return;
        var blocks;
        if(range.collapsed){ var b=getBlock(range); blocks=b?[b]:[]; }
        else blocks=gdLeafBlocks(range);
        for(var i=0;i<blocks.length;i++){
          blocks[i].style.lineHeight=value||'';
          if(!blocks[i].getAttribute('style')) blocks[i].removeAttribute('style');
        }
        sync();
      };

      window.gdFormatBlock=function(tag){
        var range=gdCurrentRange();
        if(!range) return;
        var end=range.cloneRange();
        end.collapse(false);
        if(isInTitle(range)||isInTitle(end)) return;
        el.focus();
        document.execCommand('formatBlock',false,'<'+tag+'>');
        sync();
      };

      var gdFind={q:'',ranges:[],idx:0};

      function gdCollectMatches(q){
        var out=[];
        if(!q||!q.replace(/\\s/g,'').length) return out;
        var needle=q.toLowerCase();
        var walker=document.createTreeWalker(el, NodeFilter.SHOW_TEXT|NodeFilter.SHOW_ELEMENT, null);
        var cur={text:'',nodes:[],offs:[]};
        var groups=[cur];
        var n;
        while((n=walker.nextNode())){
          if(n.nodeType===1){
            if(n.nodeName==='BR'||n.nodeName==='UL'||n.nodeName==='OL'||n.nodeName==='TABLE'||n.nodeName==='TR'||n.matches(GD_LEAF_SEL)){
              cur={text:'',nodes:[],offs:[]};
              groups.push(cur);
            }
            continue;
          }
          cur.nodes.push(n);
          cur.offs.push(cur.text.length);
          cur.text+=n.data;
        }
        function locate(g,charIdx){
          for(var k=g.nodes.length-1;k>=0;k--){ if(g.offs[k]<=charIdx) return k; }
          return 0;
        }
        for(var gi=0;gi<groups.length;gi++){
          var g=groups[gi];
          if(!g.nodes.length) continue;
          var hay=g.text.toLowerCase();
          var start=0;
          while(start<=hay.length-needle.length){
            var idx=hay.indexOf(needle,start);
            if(idx<0) break;
            var a=locate(g,idx), b=locate(g,idx+needle.length-1);
            var r=document.createRange();
            r.setStart(g.nodes[a], idx-g.offs[a]);
            r.setEnd(g.nodes[b], idx+needle.length-g.offs[b]);
            out.push(r);
            start=idx+needle.length;
          }
        }
        return out;
      }

      function gdPaint(){
        if(!GD_HL) return;
        if(!gdFind.ranges.length){
          CSS.highlights.delete('gd-find');
          CSS.highlights.delete('gd-find-active');
          return;
        }
        var others=new Highlight(), active=new Highlight();
        for(var i=0;i<gdFind.ranges.length;i++){
          if(i===gdFind.idx) active.add(gdFind.ranges[i]); else others.add(gdFind.ranges[i]);
        }
        CSS.highlights.set('gd-find', others);
        CSS.highlights.set('gd-find-active', active);
      }

      function gdReport(){
        var count=gdFind.ranges.length;
        gdPost('__FIND__:'+JSON.stringify({count:count,index:count?gdFind.idx:-1}));
      }

      function gdScrollToActive(){
        var r=gdFind.ranges[gdFind.idx];
        if(!r) return;
        var rect=r.getBoundingClientRect();
        if(rect.top>=80&&rect.bottom<=window.innerHeight-80) return;
        window.scrollTo({top:Math.max(0,window.scrollY+rect.top-window.innerHeight/3),behavior:'smooth'});
      }

      function gdFindRefresh(){
        if(!gdFind.q) return;
        gdFind.ranges=gdCollectMatches(gdFind.q);
        if(gdFind.idx>=gdFind.ranges.length) gdFind.idx=Math.max(0,gdFind.ranges.length-1);
        gdPaint();
        gdReport();
      }
      window.gdFindRefresh=gdFindRefresh;

      window.gdFindSet=function(q){
        gdFind.q=q||'';
        gdFind.idx=0;
        gdFind.ranges=gdCollectMatches(gdFind.q);
        gdPaint();
        gdReport();
        gdScrollToActive();
      };

      window.gdFindStep=function(d){
        var len=gdFind.ranges.length;
        if(!len) return;
        gdFind.idx=(gdFind.idx+d+len)%len;
        gdPaint();
        gdReport();
        gdScrollToActive();
      };

      function gdReplaceRange(r,rep){
        r.deleteContents();
        if(rep) r.insertNode(document.createTextNode(rep));
      }

      window.gdFindReplace=function(rep){
        var r=gdFind.ranges[gdFind.idx];
        if(!r) return;
        gdReplaceRange(r,rep);
        sync();
        gdFindRefresh();
        gdScrollToActive();
      };

      window.gdFindReplaceAll=function(rep){
        var list=gdFind.ranges.slice();
        if(!list.length) return;
        for(var i=list.length-1;i>=0;i--) gdReplaceRange(list[i],rep);
        sync();
        gdFind.idx=0;
        gdFindRefresh();
      };

      window.gdFindClear=function(){
        gdFind={q:'',ranges:[],idx:0};
        gdPaint();
      };

      window.gdOutline=function(){
        var hs=el.querySelectorAll('h1,h2,h3'), items=[];
        for(var i=0;i<hs.length;i++){
          items.push({level:Number(hs[i].nodeName.charAt(1)),text:(hs[i].textContent||'').replace(/\\u00a0/g,' ').trim(),index:i});
        }
        gdPost('__OUTLINE__:'+JSON.stringify(items));
      };

      window.gdScrollToHeading=function(i){
        var h=el.querySelectorAll('h1,h2,h3')[i];
        if(!h) return;
        window.scrollTo({top:Math.max(0,h.getBoundingClientRect().top+window.scrollY-16),behavior:'smooth'});
      };
`;

/** CSS for headings, find highlights, and the tablet "page" look. */
export function draftEditorFeaturesCss(pageBg: string, isDarkMode: boolean): string {
  const gutter = isDarkMode ? '#0b0b0d' : '#e9ebef';
  return `
    #content h2{font-size:17px;font-weight:600;margin:12px 0 4px;padding:0;line-height:22px}
    #content h3{font-size:16px;font-weight:600;margin:10px 0 4px;padding:0;line-height:22px}
    ::highlight(gd-find){background-color:#fde68a;color:#111}
    ::highlight(gd-find-active){background-color:#fb923c;color:#111}
    @media (min-width:700px){
      body{background:${gutter};padding:24px 16px 48px 16px}
      #content{max-width:816px;margin:0 auto;background:${pageBg};padding:72px;min-height:1056px;border-radius:2px;box-shadow:0 1px 4px rgba(0,0,0,.15),0 2px 10px rgba(0,0,0,.08)}
    }`;
}

/** Build an injectable call to one of the window.gd* functions. */
export function gdCall(fn: string, ...args: (string | number)[]): string {
  const argList = args.map((a) => JSON.stringify(a)).join(',');
  return `(function(){ if(typeof window.${fn}==='function') window.${fn}(${argList}); })(); true;`;
}

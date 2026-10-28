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

      var gdSavedRange=null;
      var gdExpandedRange=null;

      function gdRangeInEditor(r){
        if(!r) return false;
        var n=r.commonAncestorContainer;
        return n===el||el.contains(n);
      }

      function gdLiveRange(){
        var sel=window.getSelection();
        if(!sel||sel.rangeCount===0) return null;
        var r=sel.getRangeAt(0);
        return gdRangeInEditor(r)?r:null;
      }

      function gdCaptureRange(){
        var r=gdLiveRange();
        if(!r) return;
        gdSavedRange=r.cloneRange();
        if(!r.collapsed) gdExpandedRange=r.cloneRange();
      }

      function gdClearExpandedIfCaret(){
        setTimeout(function(){
          if(document.activeElement!==el) return;
          var r=gdLiveRange();
          if(r&&r.collapsed) gdExpandedRange=null;
        },0);
      }

      function gdCurrentRange(){
        return gdReadyRange(false);
      }

      /** Restore the last in-editor selection (keeps highlights after toolbar/modal blur). */
      function gdReadyRange(focusEditor){
        if(focusEditor!==false){
          try{ el.focus(); }catch(e0){}
        }
        var live=gdLiveRange();
        var pick=null;
        if(live&&!live.collapsed) pick=live;
        else if(gdExpandedRange&&gdRangeInEditor(gdExpandedRange)&&!gdExpandedRange.collapsed) pick=gdExpandedRange;
        else pick=live||(gdSavedRange&&gdRangeInEditor(gdSavedRange)?gdSavedRange:null);
        if(!pick) return null;
        try{
          var sel=window.getSelection();
          var use=pick.cloneRange();
          sel.removeAllRanges();
          sel.addRange(use);
          gdSavedRange=use.cloneRange();
          if(!use.collapsed) gdExpandedRange=use.cloneRange();
          return use;
        }catch(e1){
          return live;
        }
      }

      window.gdSaveRange=gdCaptureRange;
      document.addEventListener('selectionchange', gdCaptureRange);
      el.addEventListener('keyup', gdClearExpandedIfCaret);
      el.addEventListener('click', gdClearExpandedIfCaret);

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

      function gdBlocksFromRange(range){
        if(!range) return [];
        if(range.collapsed){
          var b=getBlock(range);
          return b?[b]:[];
        }
        return gdLeafBlocks(range);
      }

      function gdEnsureTitle(){
        var first=el.firstElementChild;
        if(first&&first.nodeName==='H1') return;
        var h1=document.createElement('h1');
        h1.setAttribute('data-placeholder','Title');
        el.insertBefore(h1, el.firstChild);
      }

      function gdLiftLi(li){
        var list=li.parentNode;
        if(!list||!list.parentNode) return null;
        var p=document.createElement('p');
        while(li.firstChild) p.appendChild(li.firstChild);
        if(!(p.textContent||'').replace(/\\u00a0/g,' ').trim() && !p.querySelector('br,img')) p.innerHTML='<br>';
        var after=null;
        if(li.nextSibling){
          after=document.createElement(list.nodeName.toLowerCase());
          while(li.nextSibling) after.appendChild(li.nextSibling);
        }
        list.parentNode.insertBefore(p, list.nextSibling);
        if(after&&after.firstChild) list.parentNode.insertBefore(after, p.nextSibling);
        li.remove();
        if(!list.querySelector('li')) list.remove();
        return p;
      }

      function gdReplaceBlock(block, tagName){
        if(!block||block===el) return null;
        if(block.nodeName==='TD'||block.nodeName==='TH') return block;
        if(block.nodeName==='LI'){
          block=gdLiftLi(block);
          if(!block) return null;
        }
        var wasTitle=block.nodeName==='H1';
        if(block.nodeName===tagName){
          if(wasTitle) gdEnsureTitle();
          return block;
        }
        var next=document.createElement(tagName.toLowerCase());
        while(block.firstChild) next.appendChild(block.firstChild);
        if(block.getAttribute('style')) next.setAttribute('style', block.getAttribute('style'));
        if(!(next.textContent||'').replace(/\\u00a0/g,' ').trim() && !next.querySelector('br,img')) next.innerHTML='<br>';
        if(block.parentNode) block.parentNode.replaceChild(next, block);
        if(wasTitle) gdEnsureTitle();
        return next;
      }

      window.gdApplyInlineStyle=function(prop,value){
        var range=gdReadyRange();
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
          gdCaptureRange();
        }
        sync();
        gdFindRefresh();
      };

      window.gdApplyLineHeight=function(value){
        var range=gdReadyRange();
        if(!range) return;
        var blocks=gdBlocksFromRange(range);
        for(var i=0;i<blocks.length;i++){
          blocks[i].style.lineHeight=value||'';
          if(!blocks[i].getAttribute('style')) blocks[i].removeAttribute('style');
        }
        sync();
      };

      window.gdFormatBlock=function(tag){
        var range=gdReadyRange();
        if(!range) return;
        var tagName=String(tag||'P').toUpperCase();
        if(tagName!=='P'&&tagName!=='H2'&&tagName!=='H3'&&tagName!=='H4'&&tagName!=='DIV') tagName='P';
        var blocks=gdBlocksFromRange(range);
        for(var i=0;i<blocks.length;i++) gdReplaceBlock(blocks[i], tagName);
        gdEnsureTitle();
        sync();
        gdFindRefresh();
      };

      function gdWrapBlocksAsList(blocks, ordered){
        if(!blocks.length) return;
        var list=document.createElement(ordered?'ol':'ul');
        var first=blocks[0];
        if(!first.parentNode) return;
        var insertAt=first;
        var insertParent=first.parentNode;
        if(first.nodeName==='LI'&&insertParent.parentNode){
          insertAt=insertParent;
          insertParent=insertParent.parentNode;
        }
        insertParent.insertBefore(list, insertAt);
        for(var i=0;i<blocks.length;i++){
          var block=blocks[i];
          if(!block||block===el) continue;
          var li;
          if(block.nodeName==='LI'){
            list.appendChild(block);
            continue;
          }
          li=document.createElement('li');
          while(block.firstChild) li.appendChild(block.firstChild);
          if(!(li.textContent||'').replace(/\\u00a0/g,' ').trim() && !li.querySelector('br,img')) li.innerHTML='<br>';
          list.appendChild(li);
          block.remove();
        }
        if(!list.firstChild) list.remove();
        var lists=el.querySelectorAll('ul,ol');
        for(var n=0;n<lists.length;n++){
          if(!lists[n].querySelector('li')) lists[n].remove();
        }
      }

      window.gdToggleList=function(ordered){
        var range=gdReadyRange();
        if(!range) return;
        var blocks=gdBlocksFromRange(range).filter(Boolean);
        if(!blocks.length) return;
        var target=ordered?'OL':'UL';
        var allTarget=true;
        for(var i=0;i<blocks.length;i++){
          if(blocks[i].nodeName!=='LI'||!blocks[i].parentNode||blocks[i].parentNode.nodeName!==target){ allTarget=false; break; }
        }
        if(allTarget){
          for(var j=blocks.length-1;j>=0;j--) gdLiftLi(blocks[j]);
        }else{
          var prepared=[];
          for(var k=0;k<blocks.length;k++){
            var blk=blocks[k];
            if(blk.nodeName==='H1'){
              blk=gdReplaceBlock(blk,'P');
              if(!blk) continue;
            }
            if(!blk||blk.nodeName==='TD'||blk.nodeName==='TH') continue;
            prepared.push(blk);
          }
          gdWrapBlocksAsList(prepared, !!ordered);
        }
        gdEnsureTitle();
        sync();
        gdFindRefresh();
      };

      window.gdChangeIndent=function(dir){
        var range=gdReadyRange();
        if(!range) return;
        var blocks=gdBlocksFromRange(range);
        var hasLi=false;
        for(var i=0;i<blocks.length;i++){
          var block=blocks[i];
          if(!block||block.nodeName==='H1'||block.nodeName==='TD'||block.nodeName==='TH') continue;
          if(block.nodeName==='LI'){ hasLi=true; continue; }
          var cur=parseInt(block.style.marginLeft||'0',10)||0;
          var next=Math.max(0, cur+(dir>0?40:-40));
          block.style.marginLeft=next?next+'px':'';
          if(!block.getAttribute('style')) block.removeAttribute('style');
        }
        if(hasLi) document.execCommand(dir>0?'indent':'outdent');
        sync();
      };

      window.gdExec=function(command,value){
        if(command==='insertUnorderedList'){ window.gdToggleList(false); return; }
        if(command==='insertOrderedList'){ window.gdToggleList(true); return; }
        if(command==='indent'){ window.gdChangeIndent(1); return; }
        if(command==='outdent'){ window.gdChangeIndent(-1); return; }
        var needsSel=command!=='undo'&&command!=='redo';
        if(needsSel) gdReadyRange();
        else try{ el.focus(); }catch(e2){}
        if(value===undefined||value===null||value==='') document.execCommand(command,false);
        else document.execCommand(command,false,String(value));
        gdCaptureRange();
        sync();
        gdFindRefresh();
      };

      window.gdApplyForeColor=function(color){
        window.gdApplyInlineStyle('color', color||'');
      };

      window.gdApplyBackColor=function(color){
        var range=gdReadyRange();
        if(!range||range.collapsed) return;
        var subs=gdSubRanges(range);
        var first=null,last=null;
        for(var i=subs.length-1;i>=0;i--){
          var frag=subs[i].extractContents();
          var nested=frag.querySelectorAll('mark');
          for(var j=0;j<nested.length;j++){
            nested[j].style.backgroundColor='';
            if(!nested[j].getAttribute('style')) nested[j].removeAttribute('style');
            if(!nested[j].attributes.length) gdUnwrap(nested[j]);
          }
          if(!color){
            subs[i].insertNode(frag);
            continue;
          }
          var mark=document.createElement('mark');
          mark.style.backgroundColor=color;
          mark.appendChild(frag);
          subs[i].insertNode(mark);
          if(!last) last=mark;
          first=mark;
        }
        if(first&&last){
          var sel=window.getSelection();
          var nr=document.createRange();
          nr.setStartBefore(first);
          nr.setEndAfter(last);
          sel.removeAllRanges();
          sel.addRange(nr);
          gdCaptureRange();
        }
        sync();
        gdFindRefresh();
      };

      window.gdToggleLink=function(){
        var range=gdReadyRange();
        if(!range) return;
        var node=range.commonAncestorContainer;
        if(node.nodeType===3) node=node.parentNode;
        var inLink=false;
        while(node&&node!==el){
          if(node.nodeType===1&&node.nodeName==='A'){ inLink=true; break; }
          node=node.parentNode;
        }
        if(inLink) document.execCommand('unlink',false);
        else document.execCommand('createLink',false,'https://');
        gdCaptureRange();
        sync();
      };

      window.gdInsertTable=function(){
        gdReadyRange();
        var table='<table border="1" style="border-collapse:collapse;width:100%;"><tr><td style="padding:8px;">&nbsp;</td><td style="padding:8px;">&nbsp;</td></tr><tr><td style="padding:8px;">&nbsp;</td><td style="padding:8px;">&nbsp;</td></tr></table>';
        document.execCommand('insertHTML',false,table);
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

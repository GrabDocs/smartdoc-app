import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DRAFT_EDITOR_FEATURES_JS, gdCall } from './draftEditorWebViewFeatures.ts';

describe('draftEditorWebViewFeatures', () => {
  it('injects a syntactically valid command script', () => {
    assert.doesNotThrow(() => new Function(DRAFT_EDITOR_FEATURES_JS));
  });

  it('exposes toolbar commands used by the mobile editor', () => {
    for (const fn of [
      'gdFormatBlock',
      'gdApplyInlineStyle',
      'gdApplyLineHeight',
      'gdApplyForeColor',
      'gdApplyBackColor',
      'gdToggleList',
      'gdChangeIndent',
      'gdExec',
      'gdToggleLink',
      'gdInsertTable',
      'gdSaveRange',
      'gdHandlePaste',
    ]) {
      assert.match(DRAFT_EDITOR_FEATURES_JS, new RegExp(`window\\.${fn}\\s*=`));
    }
  });

  it('keeps a highlighted range after the editor blurs', () => {
    assert.match(DRAFT_EDITOR_FEATURES_JS, /gdExpandedRange/);
    assert.match(DRAFT_EDITOR_FEATURES_JS, /n===el\|\|el\.contains\(n\)/);
    assert.match(DRAFT_EDITOR_FEATURES_JS, /function gdReadyRange/);
  });

  it('can convert the title heading to body text', () => {
    assert.match(DRAFT_EDITOR_FEATURES_JS, /function gdReplaceBlock/);
    assert.match(DRAFT_EDITOR_FEATURES_JS, /function gdDemoteHeadings/);
    assert.match(DRAFT_EDITOR_FEATURES_JS, /window\.gdHandlePaste\s*=/);
    assert.doesNotMatch(DRAFT_EDITOR_FEATURES_JS, /function gdEnsureTitle/);
    assert.doesNotMatch(DRAFT_EDITOR_FEATURES_JS, /if\(isInTitle\(range\)\|\|isInTitle\(end\)\) return;/);
    assert.doesNotMatch(DRAFT_EDITOR_FEATURES_JS, /if\(block\.nodeName==='H1'\|\|block\.nodeName==='LI'/);
  });

  it('builds an injectable window call', () => {
    assert.equal(
      gdCall('gdFormatBlock', 'P'),
      '(function(){ if(typeof window.gdFormatBlock===\'function\') window.gdFormatBlock("P"); })(); true;'
    );
  });
});

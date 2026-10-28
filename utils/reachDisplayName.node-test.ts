import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decodeFormEncodedDisplayName,
  getHmsDisplayUserName,
  sanitizeReachDisplayName,
} from './reachDisplayName.ts';

describe('decodeFormEncodedDisplayName', () => {
  it('turns URLSearchParams spaces back into spaces', () => {
    assert.equal(decodeFormEncodedDisplayName('GrabDocs+Francis'), 'GrabDocs Francis');
  });

  it('leaves names that already have spaces alone', () => {
    assert.equal(decodeFormEncodedDisplayName('GrabDocs Francis'), 'GrabDocs Francis');
  });
});

describe('sanitizeReachDisplayName', () => {
  it('decodes form-encoded plus before trim/collapse', () => {
    assert.equal(sanitizeReachDisplayName('GrabDocs+Francis'), 'GrabDocs Francis');
    assert.equal(sanitizeReachDisplayName('  Jane++Doe  '), 'Jane Doe');
  });
});

describe('getHmsDisplayUserName', () => {
  it('does not pass a plus-encoded name into HMS', () => {
    assert.equal(
      getHmsDisplayUserName('GrabDocs+Francis', { firstName: 'Ignored', lastName: 'Name' }),
      'GrabDocs Francis'
    );
  });

  it('falls back to first+last when the param is empty', () => {
    assert.equal(
      getHmsDisplayUserName('', { firstName: 'GrabDocs', lastName: 'Francis' }),
      'GrabDocs Francis'
    );
  });
});

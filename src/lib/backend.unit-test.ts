import { expect } from 'expect';
import { describe, it } from 'node:test';
import { getProofSystemBackend, setProofSystemBackend } from './backend.js';

describe('proof-system backend selector', () => {
  it('is independent from the low-level bindings backend', () => {
    setProofSystemBackend('rust');
    expect(getProofSystemBackend()).toBe('rust');
    setProofSystemBackend('compare');
    expect(getProofSystemBackend()).toBe('compare');
    setProofSystemBackend('jsoo');
  });

  it('rejects unknown implementations', () => {
    expect(() => setProofSystemBackend('other' as any)).toThrow(
      "Must be 'jsoo', 'rust', or 'compare'"
    );
  });
});

import { describe, it, expect } from 'vitest';
import { EmbeddingComposer } from '../../src/embeddings/composer.js';
import { EMBEDDING_FAMILIES, TOTAL_EMBEDDING_DIM } from '../../src/gnn/types.js';

function randomVector(dim: number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    v[i] = Math.random() * 2 - 1;
  }
  return v;
}

describe('EmbeddingComposer', () => {
  it('should compose family embeddings into correct total dimension', () => {
    const composer = new EmbeddingComposer();

    const familyEmbeddings = new Map<string, Float32Array>();
    for (const family of EMBEDDING_FAMILIES) {
      familyEmbeddings.set(family.name, randomVector(family.dimension));
    }

    const composed = composer.compose(familyEmbeddings);
    expect(composed.length).toBe(TOTAL_EMBEDDING_DIM);
    expect(composed.length).toBe(512);
  });

  it('should decompose back to original families', () => {
    const composer = new EmbeddingComposer();

    const familyEmbeddings = new Map<string, Float32Array>();
    for (const family of EMBEDDING_FAMILIES) {
      familyEmbeddings.set(family.name, randomVector(family.dimension));
    }

    const composed = composer.compose(familyEmbeddings);
    const decomposed = composer.decompose(composed);

    expect(decomposed.size).toBe(EMBEDDING_FAMILIES.length);

    for (const family of EMBEDDING_FAMILIES) {
      const original = familyEmbeddings.get(family.name)!;
      const recovered = decomposed.get(family.name)!;
      expect(recovered.length).toBe(family.dimension);

      for (let i = 0; i < family.dimension; i++) {
        expect(recovered[i]).toBeCloseTo(original[i], 5);
      }
    }
  });

  it('should throw on wrong family dimension during compose', () => {
    const composer = new EmbeddingComposer();
    const familyEmbeddings = new Map<string, Float32Array>();
    familyEmbeddings.set('book_state', randomVector(64)); // Wrong: should be 128

    expect(() => composer.compose(familyEmbeddings)).toThrow(/dimension/);
  });

  it('should throw on wrong total dimension during decompose', () => {
    const composer = new EmbeddingComposer();
    expect(() => composer.decompose(new Float32Array(100))).toThrow(/dimension/);
  });

  it('should fill zeros for missing families during compose', () => {
    const composer = new EmbeddingComposer();
    const partial = new Map<string, Float32Array>();
    partial.set('book_state', randomVector(128));

    const composed = composer.compose(partial);
    expect(composed.length).toBe(512);

    // book_state section should have values
    let hasNonZero = false;
    for (let i = 0; i < 128; i++) {
      if (composed[i] !== 0) hasNonZero = true;
    }
    expect(hasNonZero).toBe(true);

    // queue_state section (offset 128, dim 64) should be zeros
    for (let i = 128; i < 192; i++) {
      expect(composed[i]).toBe(0);
    }
  });

  it('should report correct total dimension', () => {
    const composer = new EmbeddingComposer();
    expect(composer.getTotalDim()).toBe(512);
  });

  it('should provide family layout information', () => {
    const composer = new EmbeddingComposer();

    const bookLayout = composer.getFamilyLayout('book_state');
    expect(bookLayout).toBeDefined();
    expect(bookLayout!.start).toBe(0);
    expect(bookLayout!.dim).toBe(128);

    const queueLayout = composer.getFamilyLayout('queue_state');
    expect(queueLayout).toBeDefined();
    expect(queueLayout!.start).toBe(128);
    expect(queueLayout!.dim).toBe(64);
  });

  it('should list all family names in order', () => {
    const composer = new EmbeddingComposer();
    const names = composer.getFamilyNames();
    expect(names).toEqual([
      'book_state',
      'queue_state',
      'event_stream',
      'cross_symbol_regime',
      'strategy_context',
      'risk_context',
    ]);
  });

  it('should support custom family configurations', () => {
    const custom = [
      { name: 'a', dimension: 32, updateFrequency: 'tick' as const },
      { name: 'b', dimension: 16, updateFrequency: 'event' as const },
    ];
    const composer = new EmbeddingComposer(custom);
    expect(composer.getTotalDim()).toBe(48);

    const embeddings = new Map<string, Float32Array>();
    embeddings.set('a', randomVector(32));
    embeddings.set('b', randomVector(16));

    const composed = composer.compose(embeddings);
    expect(composed.length).toBe(48);

    const decomposed = composer.decompose(composed);
    expect(decomposed.size).toBe(2);
  });
});

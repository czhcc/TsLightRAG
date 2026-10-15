import { IdSchema } from '@tslightrag/contracts';
import { z } from 'zod';
import { JsonSchema } from './kv.js';

export const VectorSpaceSchema = z.strictObject({
  id: IdSchema, dimensions: z.number().int().min(1).max(65_536), normalization: z.literal('l2'),
});
export type VectorSpace = z.infer<typeof VectorSpaceSchema>;
export const VectorRowSchema = z.strictObject({
  id: IdSchema, values: z.array(z.number().finite()).min(1).max(65_536),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/), metadata: z.record(z.string(), JsonSchema),
});
export const VectorFileSchema = z.strictObject({ space: VectorSpaceSchema.nullable(), rows: z.array(VectorRowSchema) });
export type VectorRow = z.infer<typeof VectorRowSchema>;

function unit(values: ArrayLike<number>, dimensions: number) {
  if (values.length !== dimensions) throw new Error('Vector dimension mismatch');
  let norm = 0;
  for (const value of Array.from(values)) {
    if (!Number.isFinite(value)) throw new Error('Vector values must be finite');
    norm = Math.hypot(norm, value);
  }
  if (!norm || !Number.isFinite(norm)) throw new Error('Vector norm must be finite and nonzero');
  return Float32Array.from(values, (value) => value / norm);
}

export class MemoryVectors {
  private readonly rows = new Map<string, Omit<VectorRow, 'values'> & { values: Float32Array }>();
  private readonly vectorSpace: VectorSpace | null;
  constructor(space: VectorSpace | null = null) {
    this.vectorSpace = space === null ? null : VectorSpaceSchema.parse(space);
  }
  get space() { return structuredClone(this.vectorSpace); }
  get size() { return this.rows.size; }
  set(input: VectorRow, spaceId: string) {
    const row = VectorRowSchema.parse(input);
    if (!this.vectorSpace || this.vectorSpace.id !== spaceId) throw new Error('Embedding space mismatch');
    this.rows.set(row.id, { ...structuredClone(row), values: unit(row.values, this.vectorSpace.dimensions) });
  }
  get(id: string) {
    const row = this.rows.get(id);
    return row ? { ...structuredClone(row), values: new Float32Array(row.values) } : undefined;
  }
  delete(id: string) { return this.rows.delete(id); }
  search(values: ArrayLike<number>, options: { spaceId: string; topK: number; threshold?: number }) {
    if (!this.vectorSpace || this.vectorSpace.id !== options.spaceId) throw new Error('Embedding space mismatch');
    if (!Number.isSafeInteger(options.topK) || options.topK < 0) throw new Error('Invalid topK');
    const threshold = options.threshold ?? -1;
    if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1) throw new Error('Invalid cosine threshold');
    const query = unit(values, this.vectorSpace.dimensions);
    const results: { id: string; score: number }[] = [];
    for (const row of this.rows.values()) {
      let score = 0;
      for (let i = 0; i < query.length; i++) score += (query[i] ?? 0) * (row.values[i] ?? 0);
      score = Math.max(-1, Math.min(1, score));
      if (score >= threshold) results.push({ id: row.id, score });
    }
    return results.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, options.topK);
  }
  serialize(): z.infer<typeof VectorFileSchema> {
    return { space: this.space, rows: [...this.rows.values()].map((row) => ({ ...structuredClone(row), values: [...row.values] })) };
  }
  static restore(input: unknown) {
    const file = VectorFileSchema.parse(input);
    if (!file.space && file.rows.length) throw new Error('Vectors without a declared space');
    const result = new MemoryVectors(file.space);
    for (const row of file.rows) {
      if (result.rows.has(row.id)) throw new Error('Duplicate vector ID');
      if (row.values.length !== file.space?.dimensions) throw new Error('Vector dimension mismatch');
      const norm = Math.hypot(...row.values);
      if (!Number.isFinite(norm) || Math.abs(norm - 1) > 0.00001) throw new Error('Persisted vector is not normalized');
      // Preserve the stored float32 values; repeated reloads must not renormalize/drift.
      const values = Float32Array.from(row.values);
      if ([...values].some((value, index) => value !== row.values[index])) throw new Error('Invalid persisted float32 value');
      result.rows.set(row.id, { ...structuredClone(row), values });
    }
    return result;
  }
}

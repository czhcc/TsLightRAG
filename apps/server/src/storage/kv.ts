import { IdSchema } from '@tslightrag/contracts';
import { z } from 'zod';

export const JsonSchema = z.json();
export type JsonValue = z.infer<typeof JsonSchema>;
export type Row<T> = [string, T];

/** No caller owns a live reference into a namespace. */
export class MemoryKV<T = JsonValue> {
  private readonly rows = new Map<string, T>();
  constructor(private readonly validate: (value: unknown) => T = (value) => JsonSchema.parse(value) as T) {}
  get size() { return this.rows.size; }
  get(id: string): T | undefined {
    const value = this.rows.get(id);
    return value === undefined ? undefined : structuredClone(value);
  }
  has(id: string) { return this.rows.has(id); }
  set(id: string, value: T) {
    IdSchema.parse(id);
    this.rows.set(id, structuredClone(this.validate(value)));
  }
  clear() { this.rows.clear(); }
  delete(id: string) { return this.rows.delete(id); }
  entries(): Row<T>[] { return [...this.rows].map(([id, value]) => [id, structuredClone(value)]); }
  static restore<T>(rows: Row<T>[], validate: (value: unknown) => T) {
    const result = new MemoryKV(validate);
    for (const [id, value] of rows) {
      if (result.has(id)) throw new Error('Duplicate KV key');
      result.set(id, value);
    }
    return result;
  }
}

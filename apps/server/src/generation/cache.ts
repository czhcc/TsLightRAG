import type { z } from 'zod';
/** Process-local, schema-checked LRU. Keys are caller-scoped SHA256 identities, never credentials in logs. */
export class BoundedCache<T> {
  private readonly rows = new Map<string, { value:T; bytes:number; expires:number }>();
  private bytes = 0;
  constructor(private readonly schema:z.ZodType<T>,private readonly limits:{entries:number;bytes:number;ttlMs:number},private readonly now=Date.now){}
  get size(){return this.rows.size;}
  clear(){this.rows.clear();this.bytes=0;}
  private remove(key:string){const row=this.rows.get(key);if(row){this.bytes-=row.bytes;this.rows.delete(key);}}
  get(key:string):T|undefined {
    const row=this.rows.get(key);if(!row)return;
    if(row.expires<=this.now()){this.remove(key);return;}
    this.rows.delete(key);this.rows.set(key,row);return structuredClone(row.value);
  }
  set(key:string,value:unknown){
    const parsed=this.schema.safeParse(value);if(!parsed.success)return false;
    const bytes=Buffer.byteLength(JSON.stringify(parsed.data),'utf8')+Buffer.byteLength(key);
    if(bytes>this.limits.bytes||this.limits.entries<1)return false;
    for(const [id,row]of this.rows)if(row.expires<=this.now())this.remove(id);
    this.remove(key);
    while(this.rows.size>=this.limits.entries||this.bytes+bytes>this.limits.bytes)this.remove(this.rows.keys().next().value!);
    this.rows.set(key,{value:structuredClone(parsed.data),bytes,expires:this.now()+this.limits.ttlMs});this.bytes+=bytes;return true;
  }
}

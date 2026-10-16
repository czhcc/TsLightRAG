import type { ServerResponse } from 'node:http';
import { StreamEventSchema } from '@tslightrag/contracts';
import type { StreamEvent } from '@tslightrag/contracts';
import { ModelError } from '../models/errors.js';

/** One writer owns framing and backpressure. Only the generation coordinator chooses a terminal. */
export class NdjsonWriter {
  private ended=false;
  constructor(private readonly response:ServerResponse,private readonly signal:AbortSignal){}
  async send(event:StreamEvent){
    if(this.ended)return;
    if(this.response.destroyed||this.response.writableEnded)throw new ModelError('MODEL_CANCELLED','连接已关闭',499);
    const line=JSON.stringify(StreamEventSchema.parse(event))+'\n';
    if(['done','error','cancelled'].includes(event.type)){
      this.ended=true;
      await new Promise<void>((resolve,reject)=>{
        const cleanup=()=>{this.response.off('close',closed);this.response.off('error',failed);};
        const closed=()=>{cleanup();if(this.response.writableFinished)resolve();else reject(new ModelError('MODEL_CANCELLED','连接已关闭',499));};
        const failed=(error:Error)=>{cleanup();reject(error);};
        this.response.once('close',closed);this.response.once('error',failed);
        this.response.end(line,()=>{cleanup();resolve();});
      });return;
    }
    if(this.signal.aborted)throw new ModelError('MODEL_CANCELLED','查询已取消',499);
    if(!this.response.write(line))await new Promise<void>((resolve,reject)=>{
      const cleanup=()=>{this.response.off('drain',drain);this.response.off('close',closed);this.response.off('error',closed);this.signal.removeEventListener('abort',closed);};
      const drain=()=>{cleanup();resolve();};
      const closed=()=>{cleanup();reject(new ModelError('MODEL_CANCELLED','查询已取消',499));};
      this.response.once('drain',drain);this.response.once('close',closed);this.response.once('error',closed);this.signal.addEventListener('abort',closed,{once:true});
      if(this.signal.aborted)closed();
    });
  }
}

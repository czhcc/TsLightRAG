import { StreamEventSchema } from '@tslightrag/contracts';
import type { StreamEvent } from '@tslightrag/contracts';
/** Incremental framing; EOF is never a substitute for a done/error/cancelled record. */
export async function readNdjson(response:Response,onEvent:(event:StreamEvent)=>void|Promise<void>){
  if(!response.body)throw new Error('回答响应缺少数据流');
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let pending='',phase=0,total=0;
  const line=async(raw:string)=>{
    if(!raw.trim())return;
    const event=StreamEventSchema.parse(JSON.parse(raw));
    if(phase===3)throw new Error('回答流包含重复终态或终态后的数据');
    if(event.type==='meta'){if(phase!==0)throw new Error('回答流元数据顺序错误');phase=1;}
    else if(event.type==='references'){if(phase!==1)throw new Error('回答流引用顺序错误');phase=2;}
    else if(event.type==='delta'){if(phase!==2)throw new Error('回答流文本顺序错误');}
    else {if(event.type==='done'&&phase!==2)throw new Error('回答流缺少引用阶段');phase=3;}
    await onEvent(event);
  };
  try{
    for(;;){const {value,done}=await reader.read();if(done)break;total+=value.length;if(total>64*1024*1024)throw new Error('回答流超过大小限制');pending+=decoder.decode(value,{stream:true});
      let end:number;while((end=pending.indexOf('\n'))>=0){await line(pending.slice(0,end));pending=pending.slice(end+1);}if(pending.length>32*1024*1024)throw new Error('回答流单条记录超过大小限制');
    }
    pending+=decoder.decode();if(pending.trim())throw new Error('回答流最后一条记录不完整');if(phase!==3)throw new Error('回答流意外中断，未确认完成');
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}

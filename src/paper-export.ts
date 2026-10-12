import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { mkdtemp, open, rm, stat, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaperState } from './paper.js';
import type { PaperStore } from './paper-store.js';
export interface ExportWorkerInput {
  state:PaperState; snapshotAt:string; directory:string; workDirectory:string; zipPath:string;
  research:{name:string;fd:number;size:number}[]; secrets:string[];
}
export interface ExportJob {
  id:string;status:'BUILDING'|'READY'|'FAILED';snapshotAt:string;processedFiles:number;totalFiles:number;
  filename:string;bytes?:number;error?:string;memory?:NodeJS.MemoryUsage;
}
/** One bounded worker per service. Jobs are temporary, never written into account storage. */
export class PaperExport {
  private job:ExportJob|undefined;
  private worker:Worker|undefined;
  private directory:string|undefined;
  private zipPath:string|undefined;
  private handles:FileHandle[]=[];
  private expires:ReturnType<typeof setTimeout>|undefined;
  private starting=false;
  private closed=false;
  private downloads=0;
  constructor(private readonly store:PaperStore,private readonly research:()=>Promise<{name:string;handle:FileHandle;size:number}[]>){}
  status(id:string){return this.job?.id===id?{...this.job}:null;}
  download(id:string){return this.job?.id===id && this.job.status==='READY' && this.zipPath?{path:this.zipPath,filename:this.job.filename,bytes:this.job.bytes}:null;}
  async openDownload(id:string){
    const download=this.download(id);if(!download)return null;
    this.downloads++;
    try{const handle=await open(download.path,constants.O_RDONLY|constants.O_NOFOLLOW);return {...download,handle,close:async()=>{await handle.close();this.downloads--;}};}
    catch(error){this.downloads--;throw error;}
  }
  async start():Promise<ExportJob>{
    if(this.closed)throw Error('Export service closed');
    if(this.starting || this.job?.status==='BUILDING' || this.downloads)throw Error('An export is already being prepared or downloaded');
    this.starting=true;
    try {
      await this.cleanup();
      const state=await this.store.exportSnapshot();
      if(state.config.PAPER_STRATEGY_VERSION!==5)throw Error('V5 account required');
      const snapshotAt=new Date().toISOString();
      const files=await this.research();this.handles=files.map(f=>f.handle);
      const directory=await mkdtemp(join(tmpdir(),'gptheist-v5-export-'));this.directory=directory;
      this.zipPath=join(directory,'export.zip');
      this.job={id:randomUUID(),status:'BUILDING',snapshotAt,processedFiles:0,totalFiles:0,filename:`gptheist-v5-export-${snapshotAt.slice(0,10)}.zip`};
      const secrets=Object.entries(process.env).filter(([key,value])=>/TOKEN|SECRET|PASSWORD|PRIVATE|API.?KEY|CREDENTIAL|AUTH|RPC_URL|DATABASE_URL/i.test(key) && value && (value.length>=8 || key==='PAPER_EXPORT_TOKEN')).map(([,value])=>value!);
      const worker=new Worker(new URL('./paper-export-worker.js',import.meta.url),{
        execArgv:[],
        workerData:{state,snapshotAt,directory:this.store.directory,workDirectory:directory,zipPath:this.zipPath,
          research:files.map(f=>({name:f.name,fd:f.handle.fd,size:f.size})),secrets} satisfies ExportWorkerInput,
        resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16,stackSizeMb:4}
      });this.worker=worker;
      worker.on('message',(message:{type:string;processedFiles?:number;totalFiles?:number;memory?:NodeJS.MemoryUsage})=>{
        if(!this.job || this.worker!==worker)return;
        if(message.type==='progress'){this.job.processedFiles=message.processedFiles??this.job.processedFiles;this.job.totalFiles=message.totalFiles??this.job.totalFiles;}
        if(message.type==='failed')this.fail();
        if(message.type==='ready')void (async()=>{
          try {const info=await stat(this.zipPath!);if(this.worker===worker && this.job?.status==='BUILDING'){this.job.bytes=info.size;this.job.status='READY';if(message.memory)this.job.memory=message.memory;}}
          catch{if(this.worker===worker)this.fail();}
        })();
      });
      worker.once('error',()=>{if(this.worker===worker)this.fail();});
      worker.once('exit',code=>{if(this.worker!==worker)return;void this.closeHandles();if(code!==0 || this.job?.status==='BUILDING'){
        // A ready message can precede the asynchronous final stat by a tick.
        if(code!==0)this.fail();
      }});
      this.expires=setTimeout(()=>{void this.cleanup();},60*60_000);this.expires.unref();
      return {...this.job};
    } catch(error) {await this.cleanup();throw error;}
    finally{this.starting=false;}
  }
  private fail(){
    if(!this.job || this.job.status==='FAILED')return;
    this.job.status='FAILED';this.job.error='Export could not be completed. Saved data was not changed.';
    const worker=this.worker,directory=this.directory,handles=this.handles;
    this.worker=undefined;this.directory=undefined;this.zipPath=undefined;this.handles=[];
    // Release a failed partial ZIP promptly without touching a later job's resources.
    void (async()=>{if(worker)await worker.terminate();await Promise.all(handles.map(h=>h.close().catch(()=>undefined)));if(directory)await rm(directory,{recursive:true,force:true}).catch(()=>undefined);})();
  }
  private async closeHandles(){const handles=this.handles;this.handles=[];await Promise.all(handles.map(h=>h.close().catch(()=>undefined)));}
  private async cleanup(){
    if(this.expires)clearTimeout(this.expires);this.expires=undefined;
    const worker=this.worker;this.worker=undefined;if(worker)await worker.terminate();
    await this.closeHandles();const directory=this.directory;this.directory=undefined;this.zipPath=undefined;this.job=undefined;
    if(directory)await rm(directory,{recursive:true,force:true});
  }
  async close(){this.closed=true;await this.cleanup();}
}

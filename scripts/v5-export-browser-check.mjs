// Optional browser check against an isolated temporary V5 account.
// Install Playwright separately for development; it is not a Railway dependency.
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??'playwright');
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {PaperStore} from '../dist/src/paper-store.js';import {startDeskServer,stopDeskServer} from '../dist/src/server.js';import {fixture} from '../dist/tests/paper-fixtures.js';
const directory=await mkdtemp(join(tmpdir(),'v5-browser-test-'));let store=await PaperStore.open(directory);await store.update(s=>{s.config.PAPER_STRATEGY_VERSION=5;});await store.close();
const old=process.env.PAPER_EXPORT_TOKEN;process.env.PAPER_EXPORT_TOKEN='browser-test-access-password';const f=fixture();
const server=await startDeskServer({host:'127.0.0.1',port:0,paperDirectory:directory,rpc:f.rpc,paperUsdFetch:async()=>new Response(JSON.stringify({bid:'2000',ask:'2000',time:new Date().toISOString()}))});
const browser=await chromium.launch({...(process.env.PLAYWRIGHT_CHROMIUM_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox']});
try{
 const context=await browser.newContext({acceptDownloads:true}),page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 const port=server.address().port;await page.goto(`http://127.0.0.1:${port}/paper`);await page.locator('#export-login').waitFor({state:'visible'});
 await page.locator('#export-password').fill(process.env.PAPER_EXPORT_TOKEN);await page.getByRole('button',{name:'Unlock',exact:true}).click();
 await page.locator('#export-login').waitFor({state:'hidden'});await page.locator('#export-v5').waitFor({state:'visible'});
 const event=page.waitForEvent('download');await page.locator('#export-v5').click();const download=await event;
 const failure=await download.failure();if(failure)throw Error(failure);const path=await download.path();const data=await readFile(path);
 if(data.readUInt32LE(0)!==0x04034b50)throw Error('ZIP signature missing');
 if(errors.length)throw Error(errors.join('; '));
 const cookies=await context.cookies();const cookie=cookies.find(c=>c.name==='gptheist_v5_session');if(!cookie?.httpOnly)throw Error('HttpOnly session missing');
 await page.reload();await page.waitForFunction(()=>document.querySelector('#connection').textContent!=='● CONNECTING');if(await page.locator('#export-login').isVisible())throw Error('Session did not survive page reload');
 const report={syntheticBrowserCheck:true,browser:'Chromium headless',buttonLabel:'📥 Export V5 Data',oneTimeUnlockPassed:true,downloadPassed:true,filename:download.suggestedFilename(),bytes:data.length,zipSignaturePassed:true,httpOnlyCookie:true,reloadSessionPassed:true,pageErrors:errors};
 await writeFile(process.argv[2]??'reports/v5-export-browser.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await browser.close();await stopDeskServer(server);if(old===undefined)delete process.env.PAPER_EXPORT_TOKEN;else process.env.PAPER_EXPORT_TOKEN=old;await rm(directory,{recursive:true,force:true});}

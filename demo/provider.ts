/** Synthetic local provider: no upstream connections, no real accounting writes. */
import { createServer } from 'node:http';
const receipts=new Map<string,string>();
if(process.env.LEDGERCATCH_DEMO!=='true')throw new Error('Demo provider requires designated demo environment');
createServer(async(req,res)=>{
 res.setHeader('Content-Type','application/json');
 if(req.method==='GET'&&req.url==='/health'){res.end('{"ok":true,"synthetic":true}');return;}
 if(req.method!=='POST'||req.url!=='/expenses'){res.writeHead(404);res.end('{}');return;}
 let text='';for await(const chunk of req){text+=chunk;if(text.length>32768){res.writeHead(413);res.end('{}');return;}}
 const key=req.headers['idempotency-key'];if(typeof key!=='string'){res.writeHead(400);res.end('{}');return;}
 if(receipts.has(key)&&receipts.get(key)!==text){res.writeHead(409);res.end('{}');return;}
 receipts.set(key,text);res.end(JSON.stringify({id:`demo-${Buffer.from(key).toString('hex').slice(0,60)}`}));
}).listen(59090,'127.0.0.1');

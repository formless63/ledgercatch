/** Bounded synthetic fixture importer. Never resets a database or touches other users. */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';

const url=new URL(process.env.DATABASE_URL ?? '');
if(process.env.LEDGERCATCH_DEMO!=='true'||url.hostname!=='127.0.0.1'||url.port!=='55432'||url.pathname!=='/ledgercatch_demo'||url.username!=='demo'||process.env.STORAGE_BUCKET!=='ledgercatch-demo'||process.env.STORAGE_ENDPOINT!=='http://127.0.0.1:59000')throw new Error('Refusing seed outside the designated isolated demo');
const {db}=await import('../src/db');
const {user}=await import('../src/db/schema');
const s=await import('../src/features/ledger/schema');
const money=await import('../src/features/money/schema');
const life=await import('../src/features/lifecycle/schema');
const {entityShares}=await import('../src/features/sharing/schema');
const {budgets}=await import('../src/features/automation/schema');
const {upsertParsedOrder,recomputeAllocations}=await import('../src/features/ledger/orders.server');
const {storeDocument}=await import('../src/features/ledger/documents.server');
const {exampleDefinition}=await import('../src/features/connectors/custom-http');
const ownerId='demo-owner';const fixed=new Date('2026-10-01T12:00:00Z');
function id(n:number){return `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;}
const existing=await db.select({id:user.id}).from(user);
if(existing.some(u=>!['demo-owner','demo-other','demo-bookkeeper'].includes(u.id)))throw new Error('Refusing to seed a database containing non-demo users');
for(const [id,name,email] of [['demo-owner','Alex Morgan (synthetic)','demo@example.test'],['demo-other','Taylor River (synthetic)','other@example.test'],['demo-bookkeeper','Casey Books (synthetic)','bookkeeper@example.test']])await db.insert(user).values({id,name,email,emailVerified:true,createdAt:fixed,updatedAt:fixed}).onConflictDoNothing();
for(const [n,name,kind,color] of [[1,'Personal','personal','indigo'],[2,'Juniper Studio','business','sky'],[3,'Northstar Workshop','business','amber']] as const)await db.insert(s.entities).values({id:id(n),ownerId,name,shortName:name.split(' ')[0],kind,color,isDefault:n===1,sort:n,createdAt:fixed,updatedAt:fixed}).onConflictDoNothing();
for(const [n,name] of [[10,'Equipment'],[11,'Office supplies'],[12,'Materials']] as const)await db.insert(s.categories).values({id:id(n),ownerId,name,createdAt:fixed}).onConflictDoNothing();
await db.insert(s.paymentMethods).values({id:id(20),ownerId,label:'Demo personal card',brand:'visa',last4:'4242',payingEntityId:id(1),createdAt:fixed}).onConflictDoNothing();
await db.insert(s.rules).values({id:id(30),ownerId,name:'Workshop materials',conditions:[{field:'merchant',op:'contains',value:'Components'}],actions:{entityId:id(3),categoryId:id(12)},createdAt:fixed,updatedAt:fixed}).onConflictDoNothing();
const rows:Array<{id:string;total:number;entity:string;date:string}>=[];
const stores=['amazon','aliexpress','ebay','digikey','mouser','alibaba'] as const;
const titles=['USB-C docking station','Studio notebooks','Bench power supply','Precision screwdriver kit','Workshop components','Shipping labels'];
for(let n=0;n<24;n++){
 const captureId=id(100+n);const source=stores[n%6];const date=`2026-${String(7+Math.floor(n/8)).padStart(2,'0')}-${String(3+(n%8)*3).padStart(2,'0')}`;const total=2500+n*375;
 await db.insert(s.captures).values({id:captureId,ownerId,source,kind:'api_json',trigger:'manual',pageUrl:'https://shop.example.test/orders',pageTitle:'Synthetic demo purchase',capturedAt:new Date(date+'T12:00:00Z'),capturedLocalDate:date,receivedAt:fixed,contentHash:createHash('sha256').update('demo-'+n).digest('hex'),bodyJson:{synthetic:true},status:'parsed',parserVersion:1}).onConflictDoNothing();
 const order=await db.transaction(async tx=>{
  const result=await upsertParsedOrder(tx,ownerId,source,{externalOrderId:`DEMO-${String(n+1).padStart(4,'0')}`,merchantName:n%2?'Example Supplies':'Example Components',orderDate:date,currency:'USD',totalMinor:total,status:n%5===0?'shipped':'delivered',items:n===8?[{title:"Bench power supply",quantity:1,unitPriceMinor:total-1500,totalMinor:total-1500},{title:"Personal tool kit",quantity:1,unitPriceMinor:1500,totalMinor:1500}]:[{title:titles[n%6],quantity:1,unitPriceMinor:total,totalMinor:total}]},captureId);
  await tx.update(s.orders).set({entityId:n<6?null:id(n%2?2:3),categoryId:id(10+n%3),paymentMethodId:id(20),reviewState:n<6?'inbox':'filed',reimbursableOverride:null,notes:'Synthetic demonstration purchase. No real customer data.',firstSeenAt:fixed,lastCapturedAt:fixed,filedAt:n<6?null:fixed,updatedAt:fixed}).where(and(eq(s.orders.id,result.orderId),eq(s.orders.ownerId,ownerId)));
  if(n===8)await tx.update(s.orderItems).set({entityId:id(1)}).where(and(eq(s.orderItems.orderId,result.orderId),eq(s.orderItems.position,1)));
  await recomputeAllocations(tx,result.orderId);return result;
 });
 rows.push({id:order.orderId,total,entity:id(n%2?2:3),date});
 if(n%5===0)await db.insert(s.shipments).values({id:id(300+n),orderId:order.orderId,carrier:'demo',trackingNumber:`DEMO-TRACK-${n}`,status:'In transit',updatedAt:fixed}).onConflictDoNothing();
 if(n%3!==0){
  const text=`SYNTHETIC DEMO INVOICE ${n+1} — Example Supplies — ${date} — USD ${(total/100).toFixed(2)}`;
  const stream=`BT /F1 12 Tf 40 760 Td (${text.replace(/[^\x20-\x7e]/g,' ')}) Tj ET`;
  const objs=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let pdf='%PDF-1.4\n';const offsets=[0];objs.forEach((o,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${o}\nendobj\n`;});const xref=Buffer.byteLength(pdf);pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(o=>`${String(o).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  await storeDocument({ownerId,orderId:order.orderId,bytes:Buffer.from(pdf),fileName:`demo-invoice-${n+1}.pdf`,contentType:'application/pdf',kind:'invoice',source});
 }
}
const claimRows=rows.slice(7,10).filter(r=>r.entity===id(2));
await db.insert(s.claims).values({id:id(40),ownerId,payerEntityId:id(1),owingEntityId:id(2),status:'submitted',currency:'USD',totalMinor:claimRows.reduce((sum,r)=>sum+r.total,0),reference:'DEMO-CLAIM-001',notes:'Synthetic September expenses',createdAt:fixed,submittedAt:fixed}).onConflictDoNothing();
for(const row of claimRows)await db.update(s.allocations).set({claimId:id(40),reimbursementStatus:'submitted'}).where(and(eq(s.allocations.orderId,row.id),eq(s.allocations.entityId,id(2))));
await db.insert(life.refunds).values({id:id(50),ownerId,orderId:rows[10].id,amountMinor:1250,currency:'USD',reason:'Synthetic partial return',status:'refunded',refundedAt:'2026-09-22',createdAt:fixed,updatedAt:fixed}).onConflictDoNothing();
await db.insert(life.assets).values({id:id(51),ownerId,orderId:rows[8].id,entityId:rows[8].entity,name:'Demo bench power supply',serial:'DEMO-SERIAL-001',purchaseDate:rows[8].date,warrantyMonths:24,warrantyExpiresAt:'2028-08-03',location:'Workshop',createdAt:fixed,updatedAt:fixed}).onConflictDoNothing();
await db.insert(money.statementImports).values({id:id(60),ownerId,fileName:'synthetic-statement.csv',format:'csv',paymentMethodId:id(20),sha256:'demo-statement',rowCount:5,insertedCount:5,createdAt:fixed}).onConflictDoNothing();
for(let n=0;n<5;n++){
 const row=rows[6+n];await db.insert(money.statementTransactions).values({id:id(61+n),ownerId,importId:id(60),paymentMethodId:id(20),postedDate:row.date,description:'SYNTHETIC EXAMPLE SUPPLIES',merchantKey:'example',amountMinor:row.total,currency:'USD',status:n<3?'suggested':'unmatched',raw:{synthetic:'true'},hash:`demo-statement-${n}`,createdAt:fixed,updatedAt:fixed}).onConflictDoNothing();
 if(n<3)await db.insert(money.transactionMatches).values({id:id(70+n),ownerId,transactionId:id(61+n),orderId:row.id,score:0.95,reasons:['Exact amount','Matching purchase date'],status:'suggested',createdAt:fixed}).onConflictDoNothing();
}
await db.insert(budgets).values({id:id(80),ownerId,entityId:id(3),period:'month',amountMinor:50000,currency:'USD',createdAt:fixed,updatedAt:fixed}).onConflictDoNothing();
await db.insert(entityShares).values({id:id(81),ownerId,entityId:id(2),granteeEmail:'bookkeeper@example.test',acceptedUserId:'demo-bookkeeper',acceptedAt:fixed,createdAt:fixed}).onConflictDoNothing();
await db.insert(s.connections).values({id:id(90),ownerId,entityId:id(3),provider:'custom_http',name:'Synthetic local provider',enabled:false,config:{baseUrl:'http://127.0.0.1:59090',auth:'none',definition:JSON.stringify(exampleDefinition)},createdAt:fixed,updatedAt:fixed}).onConflictDoNothing();
const result=await db.execute(sql`select count(*)::int as orders, sum(total_minor)::text as total from orders where owner_id=${ownerId}`);
writeFileSync('.demo/fixture.json',JSON.stringify({synthetic:true,ownerEmail:'demo@example.test',orderId:rows[7].id,orders:24,totalMinor:rows.reduce((sum,r)=>sum+r.total,0),database:result.rows},null,2));
console.log('Synthetic demo seeded: 24 orders; total 163500 USD minor units. Sign in through Mailpit as demo@example.test.');
await db.$client.end();

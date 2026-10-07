import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();
const app=express();
const PORT=Number(process.env.PORT||3000);
const DB=path.join(process.cwd(),'data.json');
const statuses=['NEW','PENDING_CONFIRMATION','CONFIRMED','NO_ANSWER','CALL_BACK','CANCELLED','READY_TO_SHIP','SENT_TO_COURIER','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED','REFUSED','RETURNED'];
const labels={NEW:'جديد',PENDING_CONFIRMATION:'يحتاج تأكيد',CONFIRMED:'مؤكد',NO_ANSWER:'لم يرد',CALL_BACK:'معاودة الاتصال',CANCELLED:'ملغى',READY_TO_SHIP:'جاهز للشحن',SENT_TO_COURIER:'أرسل للتوصيل',IN_TRANSIT:'قيد التوصيل',OUT_FOR_DELIVERY:'خرج للتوصيل',DELIVERED:'تم التسليم',REFUSED:'مرفوض',RETURNED:'مرتجع'};
function load(){if(!fs.existsSync(DB)) save({orders:[],users:[{id:'u1',name:'Sara',email:'agent@example.com',role:'ORDER_AGENT'},{id:'u2',name:'Administrateur',email:'admin@example.com',role:'SUPER_ADMIN'}],couriers:[{id:'c1',name:'Ecom Delivery',type:'ECOM_DELIVERY',enabled:true,priority:10},{id:'c2',name:'Yalidine',type:'YALIDINE',enabled:true,priority:20}],events:[],whatsapp:[]}); return JSON.parse(fs.readFileSync(DB,'utf8'));}
function save(x){fs.writeFileSync(DB,JSON.stringify(x,null,2));}
let db=load();
if(!db.orders.length){
 const now=new Date().toISOString();
 db.orders=[
 {id:'o1',orderNumber:'#10025',customerName:'أحمد بن محمد',phone:'0550000000',wilaya:'سطيف',commune:'سطيف',address:'حي الهضاب',total:10700,status:'PENDING_CONFIRMATION',assignedAgentId:'u1',courierId:'c1',items:[{title:'عطر + ساعة',quantity:1,price:10700}],createdAt:now,updatedAt:now},
 {id:'o2',orderNumber:'#10024',customerName:'محمد علي',phone:'0660000000',wilaya:'الجزائر',commune:'الدار البيضاء',total:7200,status:'NO_ANSWER',assignedAgentId:'u1',items:[{title:'هدية',quantity:1,price:7200}],createdAt:now,updatedAt:now},
 {id:'o3',orderNumber:'#10023',customerName:'أمينة',phone:'0770000000',wilaya:'وهران',commune:'وهران',total:4500,status:'IN_TRANSIT',courierId:'c1',trackingNumber:'ECO123456',items:[{title:'إكسسوارات',quantity:1,price:4500}],createdAt:now,updatedAt:now},
 {id:'o4',orderNumber:'#10022',customerName:'سارة',phone:'0790000000',wilaya:'باتنة',commune:'باتنة',total:8900,status:'DELIVERED',courierId:'c2',items:[{title:'هدية',quantity:1,price:8900}],createdAt:now,updatedAt:now}
 ];
 db.events=db.orders.map(o=>({id:crypto.randomUUID(),orderId:o.id,type:'CREATED',message:'تم إنشاء الطلب',at:now}));save(db);
}
app.use('/api/webhooks/shopify',express.raw({type:'application/json'}));
app.use(express.json()); app.use(express.static('public'));
function event(orderId,message,type='STATUS'){db.events.push({id:crypto.randomUUID(),orderId,message,type,at:new Date().toISOString()});}
function find(id){return db.orders.find(o=>o.id===id);}
function courier(id){return db.couriers.find(c=>c.id===id);}
function verifyShopify(raw,h){const secret=process.env.SHOPIFY_WEBHOOK_SECRET;if(!secret||!h)return false;const dig=crypto.createHmac('sha256',secret).update(raw).digest('base64');try{return crypto.timingSafeEqual(Buffer.from(dig),Buffer.from(h));}catch{return false;}}
async function sendWhatsApp(order,template,vars=[]){const token=process.env.WHATSAPP_ACCESS_TOKEN,phoneId=process.env.WHATSAPP_PHONE_NUMBER_ID;if(!token||!phoneId)return {success:false,error:'WhatsApp Cloud API غير مهيأ'};const v=process.env.WHATSAPP_API_VERSION||'v23.0';const url=`${process.env.WHATSAPP_GRAPH_URL||'https://graph.facebook.com'}/${v}/${phoneId}/messages`;const r=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to:order.phone.replace(/\D/g,''),type:'template',template:{name:template,language:{code:'ar'},components:vars.length?[{type:'body',parameters:vars.map(text=>({type:'text',text}))}]:undefined}})});const raw=await r.json().catch(()=>({}));return {success:r.ok,raw,error:r.ok?undefined:(raw?.error?.message||`HTTP ${r.status}`)};}
async function ecomCreate(order,c){const key=process.env.ECOM_API_KEY,token=process.env.ECOM_API_TOKEN;if(!key||!token)return {success:false,error:'Ecom Delivery API غير مهيأ: أضف ECOM_API_KEY و ECOM_API_TOKEN'};const base=c.apiBaseUrl||process.env.ECOM_API_BASE_URL||'https://ecom-dz.com/api_v2';const endpoint=process.env.ECOM_CREATE_SHIPMENT_PATH||'/shipments';const r=await fetch(base+endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':key,'X-API-Token':token},body:JSON.stringify({reference:order.orderNumber,customer:order.customerName,phone:order.phone,wilaya:order.wilaya,commune:order.commune,address:order.address,amount:order.total,notes:order.notes||''})});const raw=await r.json().catch(()=>({}));if(!r.ok)return {success:false,error:`Ecom HTTP ${r.status}`,raw};const tracking=raw.trackingNumber||raw.tracking_number||raw.tracking||raw.data?.trackingNumber||raw.data?.tracking_number;return {success:true,trackingNumber:tracking,raw};}
function dashboard(){const total=db.orders.length;const count=s=>db.orders.filter(o=>o.status===s).length;const confirmed=count('CONFIRMED');return {total,pending:db.orders.filter(o=>['NEW','PENDING_CONFIRMATION'].includes(o.status)).length,confirmed,noAnswer:count('NO_ANSWER'),callbacks:count('CALL_BACK'),delivered:count('DELIVERED'),returned:count('RETURNED'),inTransit:db.orders.filter(o=>['SENT_TO_COURIER','IN_TRANSIT','OUT_FOR_DELIVERY'].includes(o.status)).length,confirmationRate:total?Math.round(confirmed/total*100):0,revenue:db.orders.filter(o=>o.status!=='CANCELLED').reduce((a,o)=>a+o.total,0)};}
app.get('/api/dashboard',(req,res)=>res.json(dashboard()));
app.get('/api/orders',(req,res)=>{let list=[...db.orders].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));const {status,q}=req.query;if(status)list=list.filter(o=>o.status===status);if(q)list=list.filter(o=>(o.orderNumber+o.customerName+o.phone+(o.trackingNumber||'')).toLowerCase().includes(String(q).toLowerCase()));res.json(list.map(o=>({...o,courier:courier(o.courierId),agent:db.users.find(u=>u.id===o.assignedAgentId)})));});
app.get('/api/orders/:id',(req,res)=>{const o=find(req.params.id);if(!o)return res.status(404).json({error:'غير موجود'});res.json({...o,courier:courier(o.courierId),agent:db.users.find(u=>u.id===o.assignedAgentId),events:db.events.filter(e=>e.orderId===o.id).sort((a,b)=>b.at.localeCompare(a.at))});});
app.post('/api/orders/:id/status',async(req,res)=>{const o=find(req.params.id);if(!o)return res.status(404).json({error:'غير موجود'});const s=req.body.status;if(!statuses.includes(s))return res.status(400).json({error:'حالة غير صحيحة'});o.status=s;o.updatedAt=new Date().toISOString();if(s==='CONFIRMED')o.confirmedAt=o.updatedAt;if(s==='DELIVERED')o.deliveredAt=o.updatedAt;event(o.id,`تغيرت الحالة إلى ${labels[s]}`);if(s==='CONFIRMED'){const tpl=process.env.WHATSAPP_TEMPLATE_CONFIRMED;if(tpl){const r=await sendWhatsApp(o,tpl,[o.customerName,o.orderNumber,`${o.total.toLocaleString('fr-DZ')} DA`]);db.whatsapp.push({id:crypto.randomUUID(),orderId:o.id,template:tpl,status:r.success?'SENT':'FAILED',error:r.error||null,at:new Date().toISOString()});}}save(db);res.json(o);});
app.post('/api/orders/:id/ship',async(req,res)=>{const o=find(req.params.id);if(!o)return res.status(404).json({error:'غير موجود'});const c=courier(req.body.courierId||o.courierId)||db.couriers.find(x=>x.enabled);if(!c)return res.status(400).json({error:'لم يتم اختيار شركة توصيل'});if(c.type!=='ECOM_DELIVERY')return res.status(501).json({error:'هذا الـadapter غير مفعّل بعد. البنية جاهزة لإضافته.'});const r=await ecomCreate(o,c);if(!r.success)return res.status(502).json(r);o.courierId=c.id;o.trackingNumber=r.trackingNumber||`PENDING-${Date.now()}`;o.status='SENT_TO_COURIER';o.shippedAt=new Date().toISOString();o.updatedAt=o.shippedAt;event(o.id,`تم إرسال الطلب إلى ${c.name} — ${o.trackingNumber}`,'SHIPMENT');save(db);res.json(o);});
app.get('/api/couriers',(req,res)=>res.json(db.couriers));
app.post('/api/couriers',(req,res)=>{const c={id:crypto.randomUUID(),name:req.body.name,type:req.body.type,enabled:true,priority:Number(req.body.priority||100)};db.couriers.push(c);save(db);res.json(c);});
app.get('/api/users',(req,res)=>res.json(db.users));
app.post('/api/webhooks/shopify',(req,res)=>{const raw=req.body;const h=req.headers['x-shopify-hmac-sha256'];if(!verifyShopify(raw,h))return res.status(401).send('Invalid webhook');let p;try{p=JSON.parse(raw.toString('utf8'));}catch{return res.status(400).send('Bad JSON');}if(db.orders.some(o=>String(o.shopifyOrderId)===String(p.id)))return res.json({ok:true,duplicate:true});const s=p.shipping_address||p.billing_address||{};const cust=p.customer||{};const name=`${cust.first_name||''} ${cust.last_name||''}`.trim()||p.email||'عميل';const o={id:crypto.randomUUID(),shopifyOrderId:String(p.id),orderNumber:p.name||`SHOP-${p.id}`,customerName:name,phone:p.phone||s.phone||cust.phone||'',wilaya:s.province||s.province_code||'',wilayaCode:s.province_code||'',commune:s.city||'',address:[s.address1,s.address2].filter(Boolean).join('، '),notes:p.note||'',total:Number(p.total_price||0),status:'PENDING_CONFIRMATION',items:(p.line_items||[]).map(i=>({title:i.title||i.name||'Produit',quantity:Number(i.quantity||1),price:Number(i.price||0)})),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};db.orders.push(o);event(o.id,'وصل الطلب من Shopify','SHOPIFY');save(db);res.json({ok:true,orderId:o.id});});
app.get('/api/export.csv',(req,res)=>{const rows=[['order','customer','phone','wilaya','total','status','courier','tracking']];db.orders.forEach(o=>rows.push([o.orderNumber,o.customerName,o.phone,o.wilaya,o.total,labels[o.status],courier(o.courierId)?.name||'',o.trackingNumber||'']));res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="orders.csv"');res.send('\uFEFF'+rows.map(r=>r.map(x=>'"'+String(x).replaceAll('"','""')+'"').join(',')).join('\n'));});
app.listen(PORT,()=>console.log(`DZ OrderHub running on http://localhost:${PORT}`));
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

// عرض ملفات الموقع
app.use(express.static(path.join(__dirname)));

// الصفحة الرئيسية
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`DZ OrderHub running on port ${PORT}`);
});

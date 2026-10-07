# DZ OrderHub

نسخة MVP جاهزة للتشغيل: لوحة طلبات عربية RTL، طابور تأكيد للموظفين، حالات الطلب، Timeline، Shopify webhook، Ecom Delivery adapter، WhatsApp Cloud API adapter، CSV، وإدارة أولية للشركات والمستخدمين.

## تشغيل Windows

1. ثبّت Node.js 20+.
2. انسخ `.env.example` إلى `.env`.
3. افتح CMD داخل المجلد:

```bash
npm install
npm start
```

4. افتح http://localhost:3000

## Shopify

Webhook endpoint:
`POST /api/webhooks/shopify`

ضع `SHOPIFY_WEBHOOK_SECRET`، وسيتم التحقق من `X-Shopify-Hmac-SHA256`. بعد نشر البرنامج على HTTPS، وجّه `orders/create` إليه.

## Ecom Delivery

المشروع يستخدم `X-API-Key` و`X-API-Token` ويجعل مسار إنشاء الشحنة configurable عبر `ECOM_CREATE_SHIPMENT_PATH`. لا يتم تخمين endpoint الخاص بإنشاء الشحنة؛ ضعه وفق API المتاح لحساب Ecom Delivery لديك.

## WhatsApp

ضع بيانات Meta WhatsApp Cloud API في `.env` وقوالب معتمدة. عند تأكيد الطلب سيحاول النظام إرسال template تلقائيًا.

## مهم للإنتاج

هذه نسخة MVP حقيقية قابلة للتشغيل وليست مجرد mockup. قبل استخدامها على متجر حقيقي يجب إضافة Authentication/JWT، PostgreSQL، Redis queue، تشفير أسرار الشركات، rate limiting، retries/idempotency، webhooks الخاصة بكل شركة توصيل، إدارة كاملة للـ58 ولاية والبلديات، وواجهة إعداد كاملة للتكاملات.

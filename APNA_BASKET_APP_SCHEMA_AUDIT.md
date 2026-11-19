# Apna Basket App Schema Audit — 19 Nov 2026

Scope: read-only review of `VishwendraSir/Home-page/Apna_Basket.html` on `main` (blob SHA `4439741545e96c39086dd4b965d20add105a48cd`) against the proposed Firestore Rules in this branch. No app file, live database, production Rules, or deployment was changed.

## Confirmed app collections and fields

- `products/{String(product.id)}`: browser app reads products; Admin writes full product documents; product records include `id,name,cat,price,stock,active` and optional display fields.
- `settings/main`: Admin writes the entire `settings` object; customer sessions also subscribe to this document. It includes operational and potentially sensitive values such as WhatsApp number, UPI ID, delivery configuration, coupon code and discount.
- `orders/{order.id}`: customer writes `id,userId,name,phone,address,pincode,status,subtotalPaise,deliveryFeePaise,discountPaise,totalPaise,items,payment,date,note` and optional `couponCode`. Item entries are `{productId,name,quantity}`.
- Admin browser code reads all orders, then calls client-SDK transactions to update order status and product stock. Delivery/admin status changes also call client-side `updateDoc`.

## Blocking incompatibilities with proposed Rules

1. **Settings read mismatch:** app customer listener reads `settings/main`; proposed Rules allow `settings/*` only to Owner. Customer cloud sync will fail until app reads a deliberately safe `publicSettings/main` document and private settings are separated. Do not make the existing full settings document public: it may expose UPI, WhatsApp and coupon/config data.
2. **Approval/stock workflow blocked by design:** proposed Rules deny every client order update and block direct product stock changes. Current app performs approval, rejection, status updates and stock decrement in the browser. These actions will fail under the proposed Rules until a trusted Admin SDK backend (Cloud Functions/Cloud Run) is implemented and app calls it.
3. **Pricing trust boundary:** app builds item prices and totals from browser catalogue/local state. Rules validate arithmetic consistency but do not verify each item price against the authoritative product record or validate all stock/fee/coupon policies. Approval transaction code exists in the browser and is not a trusted server. Server-side recalculation and idempotent stock reservation are required.
4. **Order tracking:** customer tracking reads `orders/{id}` by document ID and proposed owner-filtered get is compatible when the same authenticated UID created the order. WhatsApp-only/local orders are not in Firestore and cannot appear on other devices.
5. **Admin PIN:** the first-use PIN and later PIN are stored in browser `localStorage`; this is a UI lock, not an authorization boundary. Keep Firestore UID/custom-claim checks and never treat this PIN as secure admin authentication.
6. **New role collections:** app file currently has no Seller, Rider, Wholesaler, Support, `sellerProducts`, `suborders`, `riderTasks`, `b2bOrders` or `supportTickets` workflows. Those Rules are future scaffolding, not tested integration.

## Required before deployment

- Design public/private settings schema and update app listeners/writers together.
- Implement trusted backend endpoints with verified Owner/Admin authorization, product-price recomputation, delivery fee/coupon policy validation, transactional stock decrement, duplicate-approval protection, payment verification and idempotent state transitions.
- Add role onboarding/approval and real UI/query flows for Seller/Rider/Wholesaler/Support.
- Run end-to-end tests against the actual app build and Firestore Emulator, including customer list/get queries and all role query filters.
- Review data migration/backfill and rollback plan.

## Query-isolation test update

This branch extends tests 10–13 to seed records owned by other sellers/riders/wholesalers/staff and to assert that filtered list queries succeed while unfiltered collection queries fail. The CI run must pass before treating these additional tests as verified.

**Status:** audit findings only. Do not merge PR, deploy Rules, migrate data, or change production until explicitly approved.

# Apna Basket Trusted Backend Security Design
Date: 19 November 2026
Status: Design only. No backend code, production Rules, database, live app, or deployment changed.

## Verified starting point
Reviewed the current V13 Apna_Basket.html on Home-page/main and the proposed Rules on security/emulator-18-rules.
- WhatsApp/local checkout is the default and does not create a trusted cloud order.
- Firebase cloud order creation is optional; firebaseCreateOrder currently writes the client-provided order document.
- Admin approval currently runs in browser code through approveCloudOrder and a Firestore transaction. This is not a trusted server boundary, even if the UI checks the Admin UID.
- Admin browser code can update order status and writes settings/main. Customer listeners also read settings/main.
- The security repo currently has Emulator config and Rules tests, but no Functions backend implementation.

## Recommended architecture
Use Firebase Cloud Functions 2nd gen with Firebase Admin SDK for the first trusted order backend. This keeps privileged credentials server-side and close to the existing Firestore project. Cloudflare Worker can continue serving the separate AI Tutor endpoint; do not reuse it for order administration and never put service-account credentials in browser code, GitHub Pages, localStorage, or public Worker variables.

Admin SDK bypasses Firestore Rules, so every backend function must independently verify the Firebase ID token, caller UID/role, request schema, state transition and ownership.

## Identity and authorization
- Owner/Admin: require the exact Owner UID already configured in the proposed Rules, or a server-issued owner claim plus explicit server-side allowlist check. Ignore request-body fields such as role, uid, isAdmin or PIN.
- Customer cloud orders: require Firebase Authentication and derive owner UID from verified auth context. A phone number is contact data, not authentication.
- Guest/WhatsApp orders: keep outside trusted cloud order management until a verified phone OTP flow is designed. Do not trust client-generated IDs or phone numbers as proof of identity.
- Seller/Rider/Wholesaler/Support: phase 2 only. Roles must be granted by trusted Admin SDK code after approval; clients must never set their own claims.

## Proposed callable function contract (not deployed)
| Function | Caller | Purpose |
|---|---|---|
| quoteCustomerOrder | Authenticated customer | Server-side quote for subtotal, delivery, coupon and total; no stock reservation |
| createCustomerOrder | Authenticated customer | Validate product IDs/quantities against Firestore and create Pending order |
| approveOrder | Owner only | Recalculate order and atomically decrement stock + transition Pending to Accepted |
| rejectOrder | Owner only | Pending to Rejected with reason; no stock change |
| setOrderStatus | Owner only initially | Enforce explicit legal state transitions and write audit event |
| validateCoupon | Authenticated customer | Check eligibility and return quote; does not redeem |
| confirmPayment | Verified payment webhook/server only | Mark paid only after signature, amount and order match |

Do not create a generic updateAnyOrderField endpoint. Each function must accept a narrow schema and whitelist allowed fields.

## Server-side price and order validation
Client sends product IDs, quantities, delivery details, optional coupon code, payment method and an idempotency key. Server loads product documents and checks existence, active status, positive safe-integer quantities, stock, authoritative price, delivery area, delivery fee, minimum order, coupon validity/eligibility/usage limits, discount cap and final total. Recompute every amount server-side; ignore client-supplied prices and totals. Use integer paise (prefer pricePaise) throughout, not floating-point rupees.

## Atomic approval and duplicate protection
Within one Firestore transaction: read the order and require Pending; check idempotency marker; read all unique product documents before writing; recompute prices and charges; verify active status and stock; decrement stock and transition order to Accepted in the same transaction; write an append-only audit event with actor UID, action, order ID, timestamp and request ID; persist the idempotency result. Concurrent or repeated approvals must never decrement stock twice. Rejection checks Pending and writes Rejected plus reason/audit without changing stock.

## Order state machine
Allowed initial transitions: Pending → Accepted; Pending → Rejected; Accepted → Preparing; Preparing → Ready; Ready → OutForDelivery; OutForDelivery → Delivered. Cancellation, refund and restock require separately designed transactions. Payment status is separate (Pending, AwaitingVerification, Paid, Failed, Refunded). UPI intent launch is not proof of payment. Online payment requires a signed provider webhook and exact amount/order match; clients cannot set Paid.

## Settings separation
Current V13 reads/writes settings/main, which combines public shop information with operational or sensitive values such as UPI, coupons and delivery configuration. Before customer cloud settings are enabled, create an allowlisted publicSettings/main (only customer-safe shop display/status/contact/delivery notice fields), keep privateSettings/main Owner-only, and move coupon definitions to coupons documents with server-only redemption counters. Update app listeners/writers and Rules together. Do not make the existing settings/main public.

## Abuse controls and observability
- Enable Firebase App Check after client compatibility testing; it does not replace authorization.
- Validate request sizes, strings, phone/PIN formats, quantities and enums.
- Rate-limit by UID/IP where practical; use idempotency for create, approve and payment events.
- Keep structured logs without full addresses, phone numbers, tokens or payment secrets.
- Deny client writes to audit records; alert on repeated auth failures, stock conflicts and webhook failures.

## Required tests
Authentication: unauthenticated denied; customer denied from admin functions; forged role/isAdmin ignored; wrong Owner UID denied; non-owner roles denied.
Pricing: unknown/inactive products, tampered totals, invalid quantities, expired coupons and out-of-area PINs rejected.
Concurrency: simultaneous approvals cannot oversell; duplicate approvals cannot decrement twice; duplicate create requests return one order; retries are stable; invalid state transitions denied.
Payments/audit: invalid webhook signature and amount mismatch denied; duplicate webhook idempotent; client cannot mark Paid; every transition creates an audit record.

## Phased implementation
Phase A: add Functions 2nd-gen TypeScript project and emulator config on this feature branch; implement shared validators, Owner authorization helper, quote and create-order functions with tests.
Phase B: implement approve/reject/status transactions and audit trail; test concurrency and retries.
Phase C: replace browser-side approval/status writes and direct customer order writes with callable functions; split public/private settings and update listeners. Keep WhatsApp-only orders explicitly manual/non-cloud until OTP guest identity exists.
Phase D: add payment provider integration after provider selection and secure webhook configuration; run full Emulator and app E2E tests; prepare migration/rollback plan.

## Safety boundary
This is a proposal, not deployment approval. Do not merge PR #1, deploy Rules/Functions, alter production Firestore, migrate settings/orders, or change the live GitHub Pages app without explicit approval.
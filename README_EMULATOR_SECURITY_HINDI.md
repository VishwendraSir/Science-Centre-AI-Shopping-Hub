# Apna Basket — 18-rule Emulator Security Test Pack

This branch is isolated from production. These rules are a proposed security baseline, NOT deployed.

## Run
1. Install Node.js 20+.
2. Run `npm install`.
3. Run `npm run test:rules`.

## Important assumptions / blockers
- Owner UID is fixed in Rules: `oGx22qVkoeOboM1bNAgIdKTqXY12`.
- Seller, Rider, Wholesaler and Support roles must be Firebase custom claims set only by trusted Admin SDK code. A client profile role is never trusted.
- New collections have explicit ownership fields: sellerProducts.sellerUid, suborders.sellerUid, riderTasks.assignedRiderUid, b2bOrders.wholesalerUid, supportTickets.customerUid/assignedStaffUid.
- Public config must move to publicSettings/main; secrets/configuration go to privateSettings/main. Legacy settings/main becomes Owner-only until a controlled migration is approved.
- Order approval, stock decrement, payment status and coupon redemption must be implemented in trusted backend transactions with idempotency. Firestore Rules cannot validate every item in an arbitrary cart list or safely perform stock accounting.
- The Rules coupon check expects coupons/{couponCode} with active:boolean and expiresAt:timestamp. Existing UI currently stores couponCode/couponPercent in settings/main, so a backend/schema adapter is required before this flow can work end-to-end.
- Tests must seed docs with rules disabled. The test suite below validates authorization boundaries only; it does not claim backend transaction/payment integration is tested.

## Deployment gate
Do NOT deploy these rules or migrate production data until all emulator tests pass, the actual app schema is reconciled, backend functions are tested, and the owner explicitly approves deployment.

import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { createHash, randomUUID } from "node:crypto";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";
import { parseCart, requireOwner, SecurityValidationError } from "./security";

function asHttpsError(error: unknown): never {
  if (error instanceof SecurityValidationError) throw new HttpsError(error.code as any, error.message);
  throw error;
}
initializeApp();
const db = getFirestore();
setGlobalOptions({ region: "asia-south1", maxInstances: 5 });

function productPricePaise(data: FirebaseFirestore.DocumentData): number {
  if (Number.isSafeInteger(data.pricePaise) && data.pricePaise > 0) return data.pricePaise;
  if (typeof data.price === "number" && Number.isFinite(data.price) && data.price > 0) {
    const paise = Math.round(data.price * 100);
    if (Number.isSafeInteger(paise) && paise > 0) return paise;
  }
  throw new HttpsError("failed-precondition", "Product की server-side कीमत उपलब्ध नहीं है।");
}
function cleanText(value: unknown, field: string, max: number, min = 1): string {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) {
    throw new HttpsError("invalid-argument", field + " गलत है।");
  }
  return value.trim();
}
function safeMoney(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new HttpsError("failed-precondition", field + " configuration गलत है।");
  return value;
}

async function buildQuote(itemsInput: unknown, pincodeInput: unknown) {
  let cart;
  try { cart = parseCart(itemsInput); } catch (error) { asHttpsError(error); }
  const pincode = cleanText(pincodeInput, "PIN code", 6, 6);
  if (!/^[0-9]{6}$/.test(pincode)) throw new HttpsError("invalid-argument", "6 अंकों का PIN code जरूरी है।");
  const configSnap = await db.doc("privateSettings/main").get();
  if (!configSnap.exists) throw new HttpsError("failed-precondition", "Backend configuration अभी तैयार नहीं है।");
  const config = configSnap.data()!;
  if (!Array.isArray(config.serviceablePincodes) || !config.serviceablePincodes.includes(pincode)) {
    throw new HttpsError("failed-precondition", "यह PIN code delivery service में उपलब्ध नहीं है।");
  }
  const deliveryFeePaise = safeMoney(config.deliveryFeePaise, "Delivery fee");
  const minimumOrderPaise = safeMoney(config.minimumOrderPaise, "Minimum order");
  const productSnaps = await Promise.all(cart.map(line => db.doc(`products/${line.productId}`).get()));
  let subtotalPaise = 0;
  const items = cart.map((line, index) => {
    const snap = productSnaps[index];
    if (!snap.exists) throw new HttpsError("not-found", `Product ${line.productId} उपलब्ध नहीं है।`);
    const product = snap.data()!;
    if (product.active !== true) throw new HttpsError("failed-precondition", "Cart में कोई product अभी उपलब्ध नहीं है।");
    const unitPricePaise = productPricePaise(product);
    const lineTotalPaise = unitPricePaise * line.quantity;
    if (!Number.isSafeInteger(lineTotalPaise)) throw new HttpsError("invalid-argument", "Order amount सीमा से अधिक है।");
    subtotalPaise += lineTotalPaise;
    if (!Number.isSafeInteger(subtotalPaise)) throw new HttpsError("invalid-argument", "Order amount सीमा से अधिक है।");
    return { productId: line.productId, name: String(product.name ?? "Product").slice(0, 120), quantity: line.quantity, unitPricePaise, lineTotalPaise };
  });
  if (subtotalPaise < minimumOrderPaise) throw new HttpsError("failed-precondition", "Minimum order amount पूरा नहीं हुआ।");
  const totalPaise = subtotalPaise + deliveryFeePaise;
  if (!Number.isSafeInteger(totalPaise)) throw new HttpsError("invalid-argument", "Order total सीमा से अधिक है।");
  return { items, pincode, subtotalPaise, deliveryFeePaise, discountPaise: 0, totalPaise };
}

export const quoteCustomerOrder = onCall({ enforceAppCheck: false }, async request => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "कृपया पहले Customer Login करें।");
  const quote = await buildQuote(request.data?.items, request.data?.pincode);
  return { userId: uid, ...quote, currency: "INR", quotedAt: Timestamp.now() };
});

export const createCustomerOrder = onCall({ enforceAppCheck: false }, async request => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "कृपया पहले Customer Login करें।");
  const name = cleanText(request.data?.name, "नाम", 100);
  const phone = cleanText(request.data?.phone, "मोबाइल नंबर", 20);
  if (!/^[0-9+() -]{10,20}$/.test(phone)) throw new HttpsError("invalid-argument", "मोबाइल नंबर गलत है।");
  const address = cleanText(request.data?.address, "पता", 500);
  const payment = request.data?.payment;
  if (!["UPI", "Cash on Delivery"].includes(payment)) throw new HttpsError("invalid-argument", "Payment method गलत है।");
  const note = typeof request.data?.note === "string" ? request.data.note.slice(0, 300) : "";
  const idempotencyKey = cleanText(request.data?.idempotencyKey, "Idempotency key", 80);
  if (!/^[A-Za-z0-9_-]{12,80}$/.test(idempotencyKey)) throw new HttpsError("invalid-argument", "Idempotency key गलत है।");
  let normalizedCart: ReturnType<typeof parseCart>;
  try { normalizedCart = parseCart(request.data?.items); } catch (error) { asHttpsError(error); }
  const pincode = cleanText(request.data?.pincode, "PIN code", 6, 6);
  // Fingerprint the customer's normalized intent, not a mutable product price or availability snapshot.
  const fingerprintPayload = {
    uid, name, phone, address, payment, note, pincode,
    items: normalizedCart!.slice().sort((a, b) => a.productId.localeCompare(b.productId))
  };
  const requestFingerprint = createHash("sha256").update(JSON.stringify(fingerprintPayload)).digest("hex");
  const idemRef = db.doc(`orderRequests/${uid}_${idempotencyKey}`);
  const priorSnapshot = await idemRef.get();
  if (priorSnapshot.exists) {
    const priorData = priorSnapshot.data()!;
    if (priorData.requestFingerprint !== requestFingerprint) {
      throw new HttpsError("already-exists", "यह Idempotency key किसी दूसरे Order request के लिए उपयोग हो चुकी है। नया key बनाकर दोबारा प्रयास करें।");
    }
    return { orderId: priorData.orderId, reused: true };
  }
  const quote = await buildQuote(normalizedCart, pincode);
  const orderRef = db.collection("orders").doc();
  return db.runTransaction(async tx => {
    const prior = await tx.get(idemRef);
    if (prior.exists) {
      const priorData = prior.data()!;
      if (priorData.requestFingerprint !== requestFingerprint) {
        throw new HttpsError("already-exists", "यह Idempotency key किसी दूसरे Order request के लिए उपयोग हो चुकी है। नया key बनाकर दोबारा प्रयास करें।");
      }
      return { orderId: priorData.orderId, reused: true };
    }
    tx.create(orderRef, {
      id: orderRef.id, userId: uid, name, phone, address, pincode: quote.pincode,
      status: "Pending", subtotalPaise: quote.subtotalPaise, deliveryFeePaise: quote.deliveryFeePaise,
      discountPaise: 0, totalPaise: quote.totalPaise, items: quote.items.map(({ productId, name: productName, quantity, unitPricePaise, lineTotalPaise }) => ({ productId, name: productName, quantity, unitPricePaise, lineTotalPaise })),
      payment,
      paymentStatus: payment === "UPI" ? "Unverified" : "PendingCollection",
      paymentVerified: false,
      date: Timestamp.now(), note, createdBy: uid
    });
    tx.create(idemRef, { orderId: orderRef.id, requestFingerprint, createdAt: Timestamp.now() });
    return { orderId: orderRef.id, reused: false };
  });
});

export const approveOrder = onCall({ enforceAppCheck: false }, async request => {
  let ownerUid: string;
  try { ownerUid = requireOwner(request); } catch (error) { asHttpsError(error); }
  const orderId = cleanText(request.data?.orderId, "Order ID", 120);
  const orderRef = db.doc(`orders/${orderId}`);
  return db.runTransaction(async tx => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw new HttpsError("not-found", "Order नहीं मिला।");
    const order = orderSnap.data()!;
    if (order.status !== "Pending") throw new HttpsError("failed-precondition", "केवल Pending Order approve हो सकता है।");
    if (order.payment === "UPI" && !(order.paymentVerified === true && order.paymentStatus === "Verified")) {
      throw new HttpsError("failed-precondition", "Trusted payment provider से UPI payment verify होने तक Order approve नहीं हो सकता।");
    }
    let approvedItems;
    try { approvedItems = parseCart(order.items); }
    catch { throw new HttpsError("failed-precondition", "Order items गलत हैं; approval रोक दिया गया।"); }
    if (!Array.isArray(order.items) || order.items.length !== approvedItems.length
      || new Set(order.items.map((line: any) => line?.productId)).size !== order.items.length) {
      throw new HttpsError("failed-precondition", "Order में duplicate या inconsistent items हैं; approval रोक दिया गया।");
    }
    const refs = approvedItems.map((item: { productId: string; quantity: number }) => db.doc(`products/${item.productId}`));
    const snaps = await Promise.all(refs.map((ref: FirebaseFirestore.DocumentReference) => tx.get(ref)));
    const decrements: Array<{ref: FirebaseFirestore.DocumentReference; stock: number}> = [];
    let recomputedSubtotalPaise = 0;
    for (let i = 0; i < approvedItems.length; i++) {
      const item = approvedItems[i], snap = snaps[i];
      if (!snap.exists || snap.data()!.active !== true) throw new HttpsError("failed-precondition", "Order का कोई product उपलब्ध नहीं है।");
      const product = snap.data()!;
      const stock = product.stock;
      const unitPricePaise = productPricePaise(product);
      const storedItem = order.items.find((line: any) => line.productId === item.productId);
      if (!storedItem || !Number.isSafeInteger(storedItem.unitPricePaise) || !Number.isSafeInteger(storedItem.lineTotalPaise)
        || storedItem.unitPricePaise !== unitPricePaise
        || storedItem.lineTotalPaise !== unitPricePaise * item.quantity
        || storedItem.quantity !== item.quantity) {
        throw new HttpsError("failed-precondition", "Product की कीमत बदल गई है या Order price snapshot गलत है; दोबारा Quote बनाएं।");
      }
      recomputedSubtotalPaise += storedItem.lineTotalPaise;
      if (!Number.isSafeInteger(recomputedSubtotalPaise)) throw new HttpsError("failed-precondition", "Order subtotal गलत है।");
      if (!Number.isSafeInteger(stock) || stock < item.quantity) throw new HttpsError("failed-precondition", "पर्याप्त stock उपलब्ध नहीं है।");
      decrements.push({ ref: refs[i], stock: stock - item.quantity });
    }
    const deliveryFeePaise = order.deliveryFeePaise;
    const discountPaise = order.discountPaise;
    const totalPaise = order.totalPaise;
    if (!Number.isSafeInteger(order.subtotalPaise) || order.subtotalPaise !== recomputedSubtotalPaise
      || !Number.isSafeInteger(deliveryFeePaise) || deliveryFeePaise < 0
      || discountPaise !== 0
      || !Number.isSafeInteger(totalPaise)
      || totalPaise !== recomputedSubtotalPaise + deliveryFeePaise - discountPaise
      || !Number.isSafeInteger(totalPaise) || totalPaise < 0) {
      throw new HttpsError("failed-precondition", "Order का कुल मूल्य snapshot गलत है; approval रोक दिया गया।");
    }
    for (const d of decrements) tx.update(d.ref, { stock: d.stock });
    tx.update(orderRef, { status: "Accepted", approvedAt: Timestamp.now(), approvedBy: ownerUid });
    tx.create(db.collection("orderAudit").doc(randomUUID()), { orderId, actorUid: ownerUid, action: "Accepted", createdAt: Timestamp.now() });
    return { orderId, status: "Accepted" };
  });
});

export const rejectOrder = onCall({ enforceAppCheck: false }, async request => {
  let ownerUid: string;
  try { ownerUid = requireOwner(request); } catch (error) { asHttpsError(error); }
  const orderId = cleanText(request.data?.orderId, "Order ID", 120);
  const reason = cleanText(request.data?.reason, "Rejection reason", 200);
  const ref = db.doc(`orders/${orderId}`);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Order नहीं मिला।");
    if (snap.data()!.status !== "Pending") throw new HttpsError("failed-precondition", "केवल Pending Order reject हो सकता है।");
    tx.update(ref, { status: "Rejected", rejectionReason: reason, rejectedAt: Timestamp.now(), rejectedBy: ownerUid });
    tx.create(db.collection("orderAudit").doc(randomUUID()), { orderId, actorUid: ownerUid, action: "Rejected", reason, createdAt: Timestamp.now() });
    return { orderId, status: "Rejected" };
  });
});

const NEXT_STATUS: Record<string, string[]> = {
  Accepted: ["Preparing"], Preparing: ["Ready"], Ready: ["OutForDelivery"], OutForDelivery: ["Delivered"]
};
export const setOrderStatus = onCall({ enforceAppCheck: false }, async request => {
  let ownerUid: string;
  try { ownerUid = requireOwner(request); } catch (error) { asHttpsError(error); }
  const orderId = cleanText(request.data?.orderId, "Order ID", 120);
  const nextStatus = cleanText(request.data?.status, "Order status", 30);
  const ref = db.doc(`orders/${orderId}`);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Order नहीं मिला।");
    const current = String(snap.data()!.status);
    if (!(NEXT_STATUS[current] || []).includes(nextStatus)) throw new HttpsError("failed-precondition", "यह Order status transition मान्य नहीं है।");
    tx.update(ref, { status: nextStatus, updatedAt: Timestamp.now(), updatedBy: ownerUid });
    tx.create(db.collection("orderAudit").doc(randomUUID()), { orderId, actorUid: ownerUid, action: nextStatus, createdAt: Timestamp.now() });
    return { orderId, status: nextStatus };
  });
});


export const setProductStock = onCall({ enforceAppCheck: false }, async request => {
  let ownerUid: string;
  try { ownerUid = requireOwner(request); } catch (error) { asHttpsError(error); }
  const productId = cleanText(request.data?.productId, "Product ID", 120);
  const stock = request.data?.stock;
  if (!Number.isSafeInteger(stock) || stock < 0 || stock > 1000000) {
    throw new HttpsError("invalid-argument", "Stock 0 से 1,000,000 के बीच पूर्णांक होना चाहिए।");
  }
  const ref = db.doc(`products/${productId}`);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Product नहीं मिला।");
    tx.update(ref, { stock, stockUpdatedAt: Timestamp.now(), stockUpdatedBy: ownerUid });
    tx.create(db.collection("orderAudit").doc(randomUUID()), {
      productId, actorUid: ownerUid, action: "StockUpdated", stock, createdAt: Timestamp.now()
    });
    return { productId, stock };
  });
});

export const verifyOwnerAccess = onCall({ enforceAppCheck: false }, async request => {
  let uid: string;
  try { uid = requireOwner(request); } catch (error) { asHttpsError(error); }
  return { authorized: true, uid };
});

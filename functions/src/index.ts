import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";

initializeApp();
const db = getFirestore();
setGlobalOptions({ region: "asia-south1", maxInstances: 5 });

const OWNER_UID = "oGx22qVkoeOboM1bNAgIdKTqXY12";

type CartLine = { productId: string; quantity: number };

function requireSignedIn(request: { auth?: { uid: string } | null }): string {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "कृपया पहले Customer Login करें।");
  return request.auth.uid;
}

export function requireOwner(request: { auth?: { uid: string; token: Record<string, unknown> } | null }): string {
  const uid = requireSignedIn(request);
  if (uid !== OWNER_UID) throw new HttpsError("permission-denied", "यह कार्य केवल अधिकृत Owner कर सकता है।");
  return uid;
}

export function parseCart(value: unknown): CartLine[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    throw new HttpsError("invalid-argument", "Cart में 1 से 50 items होने चाहिए।");
  }
  const merged = new Map<string, number>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") throw new HttpsError("invalid-argument", "Cart item गलत है।");
    const item = raw as Record<string, unknown>;
    if (typeof item.productId !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(item.productId)) {
      throw new HttpsError("invalid-argument", "Product ID गलत है।");
    }
    if (typeof item.quantity !== "number" || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) {
      throw new HttpsError("invalid-argument", "Quantity 1 से 99 के बीच पूर्ण संख्या होनी चाहिए।");
    }
    merged.set(item.productId, (merged.get(item.productId) ?? 0) + item.quantity);
  }
  return [...merged].map(([productId, quantity]) => ({ productId, quantity }));
}

function productPricePaise(data: FirebaseFirestore.DocumentData): number {
  if (Number.isSafeInteger(data.pricePaise) && data.pricePaise > 0) return data.pricePaise;
  // Temporary legacy compatibility: V13 stores price in rupees. Convert once to integer paise.
  if (typeof data.price === "number" && Number.isFinite(data.price) && data.price > 0) {
    const paise = Math.round(data.price * 100);
    if (Number.isSafeInteger(paise) && paise > 0) return paise;
  }
  throw new HttpsError("failed-precondition", "Product की server-side कीमत उपलब्ध नहीं है।");
}

/**
 * Authenticated quote only. Does not reserve stock or create an order.
 * Fails closed until the Owner has created privateSettings/main with the documented fields.
 */
export const quoteCustomerOrder = onCall({ enforceAppCheck: false }, async (request) => {
  const uid = requireSignedIn(request);
  const cart = parseCart(request.data?.items);
  const pincode = request.data?.pincode;
  if (typeof pincode !== "string" || !/^[0-9]{6}$/.test(pincode)) {
    throw new HttpsError("invalid-argument", "6 अंकों का PIN code जरूरी है।");
  }

  const configSnap = await db.doc("privateSettings/main").get();
  if (!configSnap.exists) {
    throw new HttpsError("failed-precondition", "Backend configuration अभी तैयार नहीं है; order quote उपलब्ध नहीं है।");
  }
  const config = configSnap.data()!;
  if (!Array.isArray(config.serviceablePincodes) || !config.serviceablePincodes.includes(pincode)) {
    throw new HttpsError("failed-precondition", "यह PIN code अभी delivery service में उपलब्ध नहीं है।");
  }
  if (!Number.isSafeInteger(config.deliveryFeePaise) || config.deliveryFeePaise < 0 ||
      !Number.isSafeInteger(config.minimumOrderPaise) || config.minimumOrderPaise < 0) {
    throw new HttpsError("failed-precondition", "Delivery fee / minimum order की सुरक्षित configuration नहीं मिली।");
  }

  let subtotalPaise = 0;
  const items: Array<{ productId: string; name: string; quantity: number; unitPricePaise: number; lineTotalPaise: number }> = [];
  for (const line of cart) {
    const snap = await db.doc(`products/${line.productId}`).get();
    if (!snap.exists) throw new HttpsError("not-found", `Product ${line.productId} उपलब्ध नहीं है।`);
    const product = snap.data()!;
    if (product.active !== true) throw new HttpsError("failed-precondition", "Cart में कोई product अभी उपलब्ध नहीं है।");
    const unitPricePaise = productPricePaise(product);
    const lineTotalPaise = unitPricePaise * line.quantity;
    if (!Number.isSafeInteger(lineTotalPaise)) throw new HttpsError("invalid-argument", "Order amount सीमा से अधिक है।");
    subtotalPaise += lineTotalPaise;
    if (!Number.isSafeInteger(subtotalPaise)) throw new HttpsError("invalid-argument", "Order amount सीमा से अधिक है।");
    items.push({ productId: line.productId, name: String(product.name ?? "Product").slice(0, 120), quantity: line.quantity, unitPricePaise, lineTotalPaise });
  }
  if (subtotalPaise < config.minimumOrderPaise) throw new HttpsError("failed-precondition", "Minimum order amount पूरा नहीं हुआ।");

  const deliveryFeePaise = config.deliveryFeePaise as number;
  return { userId: uid, items, subtotalPaise, deliveryFeePaise, discountPaise: 0, totalPaise: subtotalPaise + deliveryFeePaise, currency: "INR", quotedAt: Timestamp.now() };
});

/** Owner identity smoke-check for emulator/integration tests; it changes no data. */
export const verifyOwnerAccess = onCall({ enforceAppCheck: false }, async (request) => {
  const uid = requireOwner(request);
  return { authorized: true, uid };
});

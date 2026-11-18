import { HttpsError } from "firebase-functions/v2/https";

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

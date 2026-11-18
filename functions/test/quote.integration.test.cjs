process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "apna-basket-emulator";
process.env.FIREBASE_CONFIG = process.env.FIREBASE_CONFIG || JSON.stringify({ projectId: process.env.GCLOUD_PROJECT });
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getFirestore } = require("firebase-admin/firestore");
const { HttpsError } = require("firebase-functions/v2/https");
const { quoteCustomerOrder } = require("../lib/index.js");

const db = getFirestore();
const uid = "emulator-customer-001";
const configRef = db.doc("privateSettings/main");
const productRef = db.doc("products/emulator-milk");

async function reset() {
  await Promise.all([configRef.delete().catch(() => {}), productRef.delete().catch(() => {})]);
}
async function seedConfig(overrides = {}) {
  await configRef.set({
    serviceablePincodes: ["282001"],
    deliveryFeePaise: 2500,
    minimumOrderPaise: 100,
    ...overrides
  });
}
async function callQuote(data, auth = { uid, token: {} }) {
  return quoteCustomerOrder.run({ data, auth });
}
function expectCode(promise, code) {
  return assert.rejects(promise, (error) => error instanceof HttpsError && error.code === code);
}

test("quoteCustomerOrder rejects unauthenticated callers", async () => {
  await reset();
  await expectCode(callQuote({ items: [{ productId: "emulator-milk", quantity: 1 }], pincode: "282001" }, null), "unauthenticated");
});

test("quoteCustomerOrder rejects malformed cart and pincode", async () => {
  await expectCode(callQuote({ items: [], pincode: "282001" }), "invalid-argument");
  await expectCode(callQuote({ items: [{ productId: "emulator-milk", quantity: 1 }], pincode: "123" }), "invalid-argument");
});

test("quoteCustomerOrder fails closed when private settings are absent", async () => {
  await reset();
  await expectCode(callQuote({ items: [{ productId: "emulator-milk", quantity: 1 }], pincode: "282001" }), "failed-precondition");
});

test("quoteCustomerOrder rejects unserviceable pincode", async () => {
  await seedConfig();
  await expectCode(callQuote({ items: [{ productId: "emulator-milk", quantity: 1 }], pincode: "110001" }), "failed-precondition");
});

test("quoteCustomerOrder rejects missing and inactive products", async () => {
  await seedConfig();
  await expectCode(callQuote({ items: [{ productId: "missing-product", quantity: 1 }], pincode: "282001" }), "not-found");
  await productRef.set({ name: "Milk", active: false, pricePaise: 5000 });
  await expectCode(callQuote({ items: [{ productId: "emulator-milk", quantity: 1 }], pincode: "282001" }), "failed-precondition");
});

test("quoteCustomerOrder calculates totals from server-side product price", async () => {
  await seedConfig({ deliveryFeePaise: 2500, minimumOrderPaise: 100 });
  await productRef.set({ name: "Milk", active: true, pricePaise: 12345 });
  const result = await callQuote({
    items: [{ productId: "emulator-milk", quantity: 2, price: 1, unitPricePaise: 1 }],
    pincode: "282001"
  });
  assert.equal(result.userId, uid);
  assert.equal(result.subtotalPaise, 24690);
  assert.equal(result.deliveryFeePaise, 2500);
  assert.equal(result.totalPaise, 27190);
  assert.equal(result.items[0].unitPricePaise, 12345);
});

test.after(async () => {
  await reset();
  await db.terminate();
});

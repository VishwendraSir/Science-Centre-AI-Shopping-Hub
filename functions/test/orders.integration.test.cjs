process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "apna-basket-emulator";
process.env.FIREBASE_CONFIG = process.env.FIREBASE_CONFIG || JSON.stringify({ projectId: process.env.GCLOUD_PROJECT });
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getFirestore } = require("firebase-admin/firestore");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  createCustomerOrder, approveOrder, rejectOrder, setOrderStatus
} = require("../lib/index.js");

const db = getFirestore();
const OWNER_UID = "oGx22qVkoeOboM1bNAgIdKTqXY12";
const CUSTOMER_UID = "orders-emulator-customer";
const productRef = db.doc("products/orders-test-product");
const configRef = db.doc("privateSettings/main");
const owner = { uid: OWNER_UID, token: {} };
const customer = { uid: CUSTOMER_UID, token: {} };
const orderIds = new Set();
const idemIds = new Set();

function expectCode(promise, code) {
  return assert.rejects(promise, error => error instanceof HttpsError && error.code === code);
}
async function seed(stock = 10) {
  await configRef.set({ serviceablePincodes: ["282001"], deliveryFeePaise: 2500, minimumOrderPaise: 100 });
  await productRef.set({ name: "Test Product", active: true, pricePaise: 10000, stock });
}
async function create(key, quantity = 1, auth = customer) {
  const result = await createCustomerOrder.run({ auth, data: {
    name: "Test Customer", phone: "9876543210", address: "Test address",
    payment: "Cash on Delivery", note: "", idempotencyKey: key,
    pincode: "282001", items: [{ productId: "orders-test-product", quantity }]
  }});
  orderIds.add(result.orderId);
  idemIds.add(`orderRequests/${auth.uid}_${key}`);
  return result;
}
async function cleanup() {
  const refs = [
    configRef, productRef,
    ...[...orderIds].map(id => db.doc(`orders/${id}`)),
    ...[...idemIds].map(path => db.doc(path))
  ];
  const audits = await db.collection("orderAudit").where("orderId", "in", [...orderIds].slice(0, 10)).get().catch(() => null);
  if (audits) for (const doc of audits.docs) refs.push(doc.ref);
  await Promise.all(refs.map(ref => ref.delete().catch(() => {})));
}

test("createCustomerOrder enforces auth and creates a server-priced idempotent Pending order", async () => {
  await seed();
  await expectCode(createCustomerOrder.run({ auth: null, data: {} }), "unauthenticated");
  const first = await create("idem-key-0001", 2);
  const second = await create("idem-key-0001", 2);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(first.orderId, second.orderId);
  const order = (await db.doc(`orders/${first.orderId}`).get()).data();
  assert.equal(order.status, "Pending");
  assert.equal(order.userId, CUSTOMER_UID);
  assert.equal(order.subtotalPaise, 20000);
  assert.equal(order.totalPaise, 22500);
  assert.deepEqual(order.items, [{ productId: "orders-test-product", name: "Test Product", quantity: 2, unitPricePaise: 10000, lineTotalPaise: 20000 }]);
});

test("approveOrder is Owner-only, decrements stock once and writes audit", async () => {
  await seed(5);
  const { orderId } = await create("idem-key-0002", 2);
  await expectCode(approveOrder.run({ auth: customer, data: { orderId } }), "permission-denied");
  const result = await approveOrder.run({ auth: owner, data: { orderId } });
  assert.equal(result.status, "Accepted");
  assert.equal((await productRef.get()).data().stock, 3);
  await expectCode(approveOrder.run({ auth: owner, data: { orderId } }), "failed-precondition");
  assert.equal((await productRef.get()).data().stock, 3);
  const audit = await db.collection("orderAudit").where("orderId", "==", orderId).get();
  assert.equal(audit.size, 1);
});

test("approveOrder blocks stale price snapshots without decrementing stock", async () => {
  await seed(5);
  const { orderId } = await create("idem-key-price-01", 2);
  await productRef.update({ pricePaise: 12000 });
  await expectCode(approveOrder.run({ auth: owner, data: { orderId } }), "failed-precondition");
  assert.equal((await productRef.get()).data().stock, 5);
  assert.equal((await db.doc(`orders/${orderId}`).get()).data().status, "Pending");
});

test("concurrent approvals cannot oversell the same stock", async () => {
  await seed(1);
  const a = await create("idem-key-0003", 1);
  const b = await create("idem-key-0004", 1);
  const results = await Promise.allSettled([
    approveOrder.run({ auth: owner, data: { orderId: a.orderId } }),
    approveOrder.run({ auth: owner, data: { orderId: b.orderId } })
  ]);
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
  assert.equal(results.filter(x => x.status === "rejected").length, 1);
  assert.equal((await productRef.get()).data().stock, 0);
  const statuses = await Promise.all([a.orderId, b.orderId].map(async id => (await db.doc(`orders/${id}`).get()).data().status));
  assert.equal(statuses.filter(x => x === "Accepted").length, 1);
});

test("rejectOrder and setOrderStatus enforce Owner and legal transitions", async () => {
  await seed(5);
  const rejected = await create("idem-key-0005", 1);
  await expectCode(rejectOrder.run({ auth: customer, data: { orderId: rejected.orderId, reason: "No" } }), "permission-denied");
  assert.equal((await rejectOrder.run({ auth: owner, data: { orderId: rejected.orderId, reason: "Out of service" } })).status, "Rejected");
  await expectCode(approveOrder.run({ auth: owner, data: { orderId: rejected.orderId } }), "failed-precondition");

  const accepted = await create("idem-key-0006", 1);
  await approveOrder.run({ auth: owner, data: { orderId: accepted.orderId } });
  await expectCode(setOrderStatus.run({ auth: owner, data: { orderId: accepted.orderId, status: "Delivered" } }), "failed-precondition");
  assert.equal((await setOrderStatus.run({ auth: owner, data: { orderId: accepted.orderId, status: "Preparing" } })).status, "Preparing");
  assert.equal((await setOrderStatus.run({ auth: owner, data: { orderId: accepted.orderId, status: "Ready" } })).status, "Ready");
  assert.equal((await setOrderStatus.run({ auth: owner, data: { orderId: accepted.orderId, status: "OutForDelivery" } })).status, "OutForDelivery");
  assert.equal((await setOrderStatus.run({ auth: owner, data: { orderId: accepted.orderId, status: "Delivered" } })).status, "Delivered");
  await expectCode(setOrderStatus.run({ auth: owner, data: { orderId: accepted.orderId, status: "Preparing" } }), "failed-precondition");
});


test("approveOrder rejects malformed legacy quantities without changing stock", async () => {
  await seed(5);
  const ref = db.collection("orders").doc("malformed-legacy-order");
  await ref.set({
    id: ref.id, userId: CUSTOMER_UID, status: "Pending",
    items: [{ productId: "orders-test-product", quantity: -2 }]
  });
  orderIds.add(ref.id);
  await expectCode(approveOrder.run({ auth: owner, data: { orderId: ref.id } }), "failed-precondition");
  assert.equal((await productRef.get()).data().stock, 5);
  assert.equal((await ref.get()).data().status, "Pending");
});

test.after(async () => {
  await cleanup();
  await db.terminate();
});

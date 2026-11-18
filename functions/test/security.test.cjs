const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCart, requireOwner } = require("../lib/security.js");

const OWNER_UID = "oGx22qVkoeOboM1bNAgIdKTqXY12";
const errCode = (fn, code) => assert.throws(fn, (error) => error && error.code === code);

test("parseCart accepts valid items", () => {
  assert.deepEqual(parseCart([{ productId: "milk_1", quantity: 2 }]), [{ productId: "milk_1", quantity: 2 }]);
});
test("parseCart merges duplicate product IDs", () => {
  assert.deepEqual(parseCart([{ productId: "milk", quantity: 2 }, { productId: "milk", quantity: 3 }]), [{ productId: "milk", quantity: 5 }]);
});
test("parseCart rejects empty or oversized carts", () => {
  errCode(() => parseCart([]), "invalid-argument");
  errCode(() => parseCart(Array.from({ length: 51 }, (_, i) => ({ productId: "p" + i, quantity: 1 }))), "invalid-argument");
});
test("parseCart rejects malformed product IDs and non-object items", () => {
  errCode(() => parseCart([null]), "invalid-argument");
  errCode(() => parseCart([{ productId: "../users", quantity: 1 }]), "invalid-argument");
  errCode(() => parseCart([{ productId: 12, quantity: 1 }]), "invalid-argument");
});
test("parseCart rejects duplicate lines whose combined quantity exceeds 99", () => {
  errCode(() => parseCart([{ productId: "p1", quantity: 60 }, { productId: "p1", quantity: 40 }]), "invalid-argument");
});
test("parseCart rejects string, fractional, zero, negative and >99 quantities", () => {
  for (const quantity of ["2", 1.5, 0, -1, 100, NaN, Infinity]) {
    errCode(() => parseCart([{ productId: "p1", quantity }]), "invalid-argument");
  }
});
test("requireOwner denies unauthenticated callers", () => {
  errCode(() => requireOwner({ auth: null }), "unauthenticated");
});
test("requireOwner denies non-owner even with admin-looking claims", () => {
  errCode(() => requireOwner({ auth: { uid: "not-owner", token: { role: "admin", admin: true } } }), "permission-denied");
});
test("requireOwner allows the exact configured Owner UID", () => {
  assert.equal(requireOwner({ auth: { uid: OWNER_UID, token: {} } }), OWNER_UID);
});


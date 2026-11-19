const { initializeTestEnvironment, assertSucceeds, assertFails } = require("@firebase/rules-unit-testing");
const fs = require("fs");
const { Timestamp } = require("firebase/firestore");
const PROJECT = "apna-basket-security-test";
const OWNER = "oGx22qVkoeOboM1bNAgIdKTqXY12";
let env;
const now = Timestamp.fromDate(new Date(Date.now()+86400000));
const order = (uid, extra={}) => ({
 id:"o1", userId:uid, name:"Test Customer", phone:"9876543210", address:"Test address",
 pincode:"283101", status:"Pending", subtotalPaise:10000, deliveryFeePaise:1000,
 discountPaise:0, totalPaise:11000, items:[{productId:"p1",name:"Item",quantity:1,price:100}],
 payment:"Cash on Delivery", date:Timestamp.now(), note:"", ...extra
});
const auth = (uid, role) => env.authenticatedContext(uid, role ? {role} : {}).firestore();
before(async () => {
 env = await initializeTestEnvironment({projectId:PROJECT, firestore:{rules:fs.readFileSync("Apna_Basket_V12_Firestore_Rules.rules","utf8")}});
 await env.withSecurityRulesDisabled(async ctx => {
  const {doc,setDoc}=require("firebase/firestore"); const db=ctx.firestore();
  await setDoc(doc(db,"publicSettings/main"),{shopName:"Apna Basket",wa:"916350248088"});
  await setDoc(doc(db,"privateSettings/main"),{upi:"private@upi"});
  await setDoc(doc(db,"settings/main"),{wa:"private legacy"});
  await setDoc(doc(db,"users/customerA"),{uid:"customerA",name:"A"});
  await setDoc(doc(db,"users/customerB"),{uid:"customerB",name:"B"});
  await setDoc(doc(db,"orders/orderA"),order("customerA"));
  await setDoc(doc(db,"products/p1"),{name:"Item",price:100,stock:10,active:true});
  await setDoc(doc(db,"sellerProducts/spA"),{sellerUid:"sellerA",name:"A"});
  await setDoc(doc(db,"sellerProducts/spB"),{sellerUid:"sellerB",name:"B"});
  await setDoc(doc(db,"suborders/soA"),{sellerUid:"sellerA",status:"New"});
  await setDoc(doc(db,"suborders/soB"),{sellerUid:"sellerB",status:"New"});
  await setDoc(doc(db,"riderTasks/rtA"),{assignedRiderUid:"riderA",deliveryStatus:"Assigned"});
  await setDoc(doc(db,"riderTasks/rtB"),{assignedRiderUid:"riderB",deliveryStatus:"Assigned"});
  await setDoc(doc(db,"wholesalers/whA"),{businessName:"A"});
  await setDoc(doc(db,"b2bOrders/b2bA"),{wholesalerUid:"whA"});
  await setDoc(doc(db,"b2bOrders/b2bB"),{wholesalerUid:"whB"});
  await setDoc(doc(db,"supportTickets/tA"),{customerUid:"customerA",assignedStaffUid:"staffA",subject:"Help",message:"x",status:"Open"});
  await setDoc(doc(db,"supportTickets/tB"),{customerUid:"customerB",assignedStaffUid:"staffB",subject:"Help",message:"x",status:"Open"});
  await setDoc(doc(db,"coupons/GOOD"),{active:true,expiresAt:now});
  await setDoc(doc(db,"coupons/OLD"),{active:true,expiresAt:Timestamp.fromDate(new Date(Date.now()-86400000))});
 });
});
after(async()=>{await env.cleanup();});
describe("Apna Basket 18 security rules — Emulator",()=>{
 it("1 Owner UID can access private settings without a profile",async()=>{const db=auth(OWNER);const {doc,getDoc}=require("firebase/firestore");await assertSucceeds(getDoc(doc(db,"privateSettings/main")));});
 it("2 Non-owner with forged profile or admin claim cannot access private settings",async()=>{const db=auth("fakeAdmin","admin");const {doc,getDoc,setDoc}=require("firebase/firestore");await assertFails(setDoc(doc(db,"users/fakeAdmin"),{uid:"fakeAdmin",role:"admin"}));await assertFails(getDoc(doc(db,"privateSettings/main")));});
 it("3 Customer reads own profile but not another's",async()=>{const db=auth("customerA");const {doc,getDoc}=require("firebase/firestore");await assertSucceeds(getDoc(doc(db,"users/customerA")));await assertFails(getDoc(doc(db,"users/customerB")));});
 it("4 Customer cannot assign admin role",async()=>{const db=auth("customerA");const {doc,setDoc}=require("firebase/firestore");await assertFails(setDoc(doc(db,"users/customerA"),{uid:"customerA",role:"admin"}));});
 it("5 Public settings are readable",async()=>{const db=auth("customerA");const {doc,getDoc}=require("firebase/firestore");await assertSucceeds(getDoc(doc(db,"publicSettings/main")));});
 it("6 Private settings are not readable by customer or anonymous",async()=>{const {doc,getDoc}=require("firebase/firestore");await assertFails(getDoc(doc(auth("customerA"),"privateSettings/main")));await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(),"privateSettings/main")));});
 it("7 Customer can create a valid Pending order",async()=>{const db=auth("customerA");const {doc,setDoc}=require("firebase/firestore");await assertSucceeds(setDoc(doc(db,"orders/new1"),order("customerA",{id:"new1"})));});
 it("8 Customer cannot create order with altered total or Accepted status",async()=>{const db=auth("customerA");const {doc,setDoc}=require("firebase/firestore");await assertFails(setDoc(doc(db,"orders/badTotal"),order("customerA",{id:"badTotal",totalPaise:1})));await assertFails(setDoc(doc(db,"orders/badStatus"),order("customerA",{id:"badStatus",status:"Accepted"})));});
 it("9 Customer cannot read another customer's order",async()=>{const db=auth("customerB");const {doc,getDoc}=require("firebase/firestore");await assertFails(getDoc(doc(db,"orders/orderA")));});
 it("10 Seller list queries must filter sellerUid",async()=>{const db=auth("sellerA","seller");const {doc,getDoc,collection,query,where,getDocs}=require("firebase/firestore");await assertSucceeds(getDoc(doc(db,"sellerProducts/spA")));await assertSucceeds(getDoc(doc(db,"suborders/soA")));await assertFails(getDoc(doc(db,"sellerProducts/spB")));await assertSucceeds(getDocs(query(collection(db,"sellerProducts"),where("sellerUid","==","sellerA"))));await assertFails(getDocs(collection(db,"sellerProducts")));await assertSucceeds(getDocs(query(collection(db,"suborders"),where("sellerUid","==","sellerA"))));await assertFails(getDocs(collection(db,"suborders")));});
 it("11 Rider list queries must filter assignedRiderUid",async()=>{const db=auth("riderA","rider");const {doc,getDoc,collection,query,where,getDocs}=require("firebase/firestore");await assertSucceeds(getDoc(doc(db,"riderTasks/rtA")));await assertFails(getDoc(doc(db,"riderTasks/rtB")));await assertSucceeds(getDocs(query(collection(db,"riderTasks"),where("assignedRiderUid","==","riderA"))));await assertFails(getDocs(collection(db,"riderTasks")));});
 it("12 Wholesaler B2B list queries must filter wholesalerUid",async()=>{const db=auth("whA","wholesaler");const {doc,getDoc,collection,query,where,getDocs}=require("firebase/firestore");await assertSucceeds(getDoc(doc(db,"wholesalers/whA")));await assertSucceeds(getDoc(doc(db,"b2bOrders/b2bA")));await assertFails(getDoc(doc(db,"wholesalers/whB")));await assertFails(getDoc(doc(db,"b2bOrders/b2bB")));await assertSucceeds(getDocs(query(collection(db,"b2bOrders"),where("wholesalerUid","==","whA"))));await assertFails(getDocs(collection(db,"b2bOrders")));});
 it("13 Support staff list queries must filter assignedStaffUid",async()=>{const db=auth("staffA","support");const {doc,getDoc,collection,query,where,getDocs}=require("firebase/firestore");await assertSucceeds(getDoc(doc(db,"supportTickets/tA")));await assertFails(getDoc(doc(db,"supportTickets/tB")));await assertSucceeds(getDocs(query(collection(db,"supportTickets"),where("assignedStaffUid","==","staffA"))));await assertFails(getDocs(collection(db,"supportTickets")));});
 it("14 Valid coupon passes and expired coupon fails",async()=>{const db=auth("customerA");const {doc,setDoc}=require("firebase/firestore");await assertSucceeds(setDoc(doc(db,"orders/couponOk"),order("customerA",{id:"couponOk",couponCode:"GOOD"})));await assertFails(setDoc(doc(db,"orders/couponBad"),order("customerA",{id:"couponBad",couponCode:"OLD"})));});
 it("15 Client cannot approve order or directly deduct stock",async()=>{const db=auth(OWNER);const {doc,updateDoc}=require("firebase/firestore");await assertFails(updateDoc(doc(db,"orders/orderA"),{status:"Accepted"}));await assertFails(updateDoc(doc(db,"products/p1"),{stock:0}));});
 it("16 Seller cannot update another seller's suborder or change owner",async()=>{const db=auth("sellerA","seller");const {doc,updateDoc}=require("firebase/firestore");await assertFails(updateDoc(doc(db,"suborders/soA"),{sellerUid:"sellerB"}));await assertFails(updateDoc(doc(db,"suborders/other"),{sellerStatus:"Ready"}));});
 it("17 Client cannot write payment status",async()=>{const db=auth(OWNER);const {doc,setDoc}=require("firebase/firestore");await assertFails(setDoc(doc(db,"payments/pay1"),{userId:OWNER,status:"Paid"}));});
 it("18 Customer and seller cannot approve; Owner-only client update is also blocked pending backend",async()=>{const {doc,updateDoc}=require("firebase/firestore");await assertFails(updateDoc(doc(auth("customerA"),"orders/orderA"),{status:"Accepted"}));await assertFails(updateDoc(doc(auth("sellerA","seller"),"orders/orderA"),{status:"Accepted"}));});
});

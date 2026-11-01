// Execute real tool entrypoints with isolated policy, audit and an in-memory harness.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, it } from "node:test";
import { UsageDoc } from "@earendil-works/pi-durable";
import { makeStore, readAudit } from "./fakegh.helper.ts";
const root=mkdtempSync(join(tmpdir(),"pd-infra-"));
process.env.PD_DATA_DIR=join(root,"data"); process.env.PD_CONFIG_DIR=join(root,"config");
mkdirSync(process.env.PD_DATA_DIR,{recursive:true}); mkdirSync(process.env.PD_CONFIG_DIR,{recursive:true});
const ext=await import("../src/extensions.ts");
const {Loops,Sessions}=await import("../src/state.ts");
type Loop=import("../src/state.ts").Loop;
const policy=join(process.env.PD_CONFIG_DIR,"policy.json"); const audit=join(process.env.PD_DATA_DIR,"audit.jsonl");
let store:ReturnType<typeof makeStore>; let created:number; let beforeCommit:()=>void;
const loop=(extra:Partial<Loop>={}):Loop=>({id:"L1",session:"infra",kind:"infra",goal:"triage",intervalMinutes:60,maxIterations:5,budgetUsd:5,iteration:0,status:"active",note:"",createdAt:0,nextRunAt:0,costAtStart:0,...extra});
const doc=()=>store.peek<{byId:Record<string,Loop>;nextId:number;infraDispatches?:number[]}>(Loops);
const resultText=(r:any)=>r.output.map((p:any)=>p.text).join(" ");
const call=(name:string,args:unknown)=> (ext.Loops_.tools!.find(t=>t.name===name)!.execute as any)(args,{conversationId:1,snapshot:store.snapshot.bind(store)},{});
beforeEach(()=>{
 store=makeStore(); created=0; beforeCommit=()=>{};
 writeFileSync(policy,JSON.stringify({loops:{dailyBudgetUsd:10,pace:false}})); writeFileSync(audit,"");
 store.seed(Loops,{byId:{L1:loop()},nextId:2});
 store.seed(Sessions,{byName:{infra:{conversationId:1,cwd:"/infra",purpose:"",createdAt:0},worker:{conversationId:2,cwd:"/worker",remote:"git@github.com:o/r.git",purpose:"",createdAt:0},other:{conversationId:3,cwd:"/other",remote:"https://github.com/o/r.git",purpose:"",createdAt:0}}});
 const snapshot=async(d:any)=>d===UsageDoc?{models:{},tools:{}}:store.snapshot(d);
 ext.setHarness({snapshot,getTask:async()=>({state:{status:"terminal"}}),conversation:async()=>({commit:async(fn:any)=>{
  beforeCommit(); const draft=structuredClone(doc());
  const out=await fn({doc:async(d:any)=>d===Loops?draft:store.peek(d),createTask:async(_t:any,_i:any,options:any)=>{assert.equal(options.ownership.kind,"conversation");created++;return 99;}});
  store.seed(Loops,draft); return out;
 }})} as never);
});
it("restricts both tools to a live infra lead",async()=>{
 doc().byId.L1!.status="paused";
 for(const name of ["pipeline_evidence","ci_dispatch"]) assert.equal((await call(name,{action:"start",session:"worker",reason:"CI is red and needs repair"})).isError,true);
 assert.equal(created,0);
});
it("starts one bounded CI worker and refuses a twin in another session for the same repository",async()=>{
 const args={action:"start",session:"worker",reason:"Base tests fail on latest commit"};
 assert.match(resultText(await call("ci_dispatch",args)),/Started/);
 assert.equal(doc().byId.L2!.kind,"ci-health"); assert.equal(doc().byId.L2!.budgetUsd,5); assert.equal(created,1);
 assert.equal((await call("ci_dispatch",{...args,session:"other"})).isError,true);
 assert.equal(created,1); assert.equal(readAudit(audit).filter(e=>e.event==="infra_dispatch").length,1);
});
it("honors a human pause even when it races with dispatch preparation",async()=>{
 doc().byId.L2=loop({id:"L2",session:"worker",kind:"ci-health",status:"paused",note:"blocked by system"});
 beforeCommit=()=>{doc().byId.L2!.note="paused by user";};
 assert.match(resultText(await call("ci_dispatch",{action:"resume",loopId:"L2",reason:"CI is red and ready to retry"})),/paused by a person/);
 assert.equal(created,0); assert.equal(doc().byId.L2!.status,"paused"); assert.equal(doc().infraDispatches,undefined);
});
it("enforces the persistent quota even when audit rows are absent",async()=>{
 doc().infraDispatches=[Date.now(),Date.now(),Date.now()];
 assert.match(resultText(await call("ci_dispatch",{action:"start",session:"worker",reason:"CI is red and needs repair"})),/quota reached/);
 assert.equal(created,0);
});
it("rechecks caller authority inside the transaction",async()=>{
 beforeCommit=()=>{doc().byId.L1!.status="paused";};
 assert.match(resultText(await call("ci_dispatch",{action:"start",session:"worker",reason:"CI is red and needs repair"})),/no longer active/);
 assert.equal(created,0);
});

it("resumes a system-paused CI worker and refuses a budget-review cut",async()=>{
 doc().byId.L2=loop({id:"L2",session:"worker",kind:"ci-health",status:"paused",note:"system failure"});
 assert.match(resultText(await call("ci_dispatch",{action:"resume",loopId:"L2",reason:"Failed base tests can now be retried"})),/Resumed/);
 assert.equal(doc().byId.L2!.status,"active"); assert.equal(created,1);
 doc().byId.L2!.status="paused";doc().byId.L2!.note="cut by budget-review";
 assert.match(resultText(await call("ci_dispatch",{action:"resume",loopId:"L2",reason:"Failed base tests can now be retried"})),/cut by the budget reviewer/);
 assert.equal(created,1);
});
it("rechecks factory spend when budget fills during dispatch preparation",async()=>{
 beforeCommit=()=>{doc().byId.L1!.spendLog=[{at:Date.now(),usd:11}];};
 assert.match(resultText(await call("ci_dispatch",{action:"start",session:"worker",reason:"CI is red and needs repair"})),/budget\/pacing allowance reached/);
 assert.equal(created,0); assert.equal(doc().infraDispatches,undefined);
});

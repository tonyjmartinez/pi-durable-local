// Execute real tool entrypoints with isolated policy, audit and an in-memory harness.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, it } from "node:test";
import { UsageDoc } from "@earendil-works/pi-durable";
import { makeStore, readAudit, makeFakeGh } from "./fakegh.helper.ts";
const root=mkdtempSync(join(tmpdir(),"pd-infra-"));
process.env.PD_DATA_DIR=join(root,"data"); process.env.PD_CONFIG_DIR=join(root,"config");
mkdirSync(process.env.PD_DATA_DIR,{recursive:true}); mkdirSync(process.env.PD_CONFIG_DIR,{recursive:true});
const gh=makeFakeGh(join(root,"fake"));
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
 gh.script([]); store=makeStore(); created=0; beforeCommit=()=>{};
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
 doc().byId.L2=loop({id:"L2",session:"worker",kind:"ci-health",status:"paused",note:"system failure",spent:1.25});
 assert.match(resultText(await call("ci_dispatch",{action:"resume",loopId:"L2",reason:"Failed base tests can now be retried"})),/Resumed/);
 assert.equal(doc().byId.L2!.status,"active"); assert.equal(doc().byId.L2!.spent,1.25); assert.equal(created,1);
 doc().byId.L2!.status="paused";doc().byId.L2!.note="cut by budget-review";
 assert.match(resultText(await call("ci_dispatch",{action:"resume",loopId:"L2",reason:"Failed base tests can now be retried"})),/cut by the budget reviewer/);
 assert.equal(created,1);
});
it("rechecks factory spend when budget fills during dispatch preparation",async()=>{
 beforeCommit=()=>{doc().byId.L1!.spendLog=[{at:Date.now(),usd:11}];};
 assert.match(resultText(await call("ci_dispatch",{action:"start",session:"worker",reason:"CI is red and needs repair"})),/budget\/pacing allowance reached/);
 assert.equal(created,0); assert.equal(doc().infraDispatches,undefined);
});

it("reads one repo once for shared sessions, separates pending head evidence and shows the persisted quota",async()=>{
 doc().byId.L2=loop({id:"L2",session:"worker",kind:"ci-health",status:"paused",note:"paused by user"});
 doc().byId.L3=loop({id:"L3",session:"other",kind:"ci-health"});
 doc().infraDispatches=[Date.now(),Date.now()];
 const runs=[{headSha:"new1234",workflowName:"test",status:"in_progress",conclusion:null,createdAt:"2026-11-01T12:00:00Z"},{headSha:"old1234",workflowName:"test",status:"completed",conclusion:"failure",createdAt:"2026-11-01T11:00:00Z"}];
 gh.script([{match:"^api user",responses:["owner"]},{match:"^repo view",responses:["main"]},{match:"^run list",responses:[JSON.stringify(runs)]},{match:"^pr list",responses:[JSON.stringify([{number:5,headRefName:"pd/fix",statusCheckRollup:[{conclusion:"SKIPPED"}]}])]}]);
 const out=resultText(await call("pipeline_evidence",{}));
 assert.match(out,/ci_dispatch left today: 1/);assert.match(out,/1 latest-head workflow\(s\) pending/);
 assert.match(out,/recent completed CI failures/);assert.match(out,/1 without checks/);
 assert.match(out,/ci-health L3 active/);assert.match(out,/2 live CI loops \(duplicate coverage/);
 assert.doesNotMatch(out,/CI RED on new1234/);
 assert.equal(gh.callsMatching(/^run list/).length,1);assert.equal(gh.callsMatching(/^pr list/).length,1);
 assert.match(gh.callsMatching(/^pr list/)[0]!,/--limit 100/);
 assert.equal(created,0);
});
it("keeps failed branch and PR reads unknown instead of probing an invented default",async()=>{
 doc().byId.L2=loop({id:"L2",session:"worker",kind:"goal"});
 gh.script([{match:"^api user",responses:["owner"]},{match:"^repo view",responses:[{code:1,stderr:"unavailable"}]},{match:"^pr list",responses:[{code:1,stderr:"unavailable"}]}]);
 const out=resultText(await call("pipeline_evidence",{}));
 assert.match(out,/base unreadable/);assert.match(out,/CI unreadable/);assert.match(out,/agent PR checks unreadable/);
 assert.doesNotMatch(out,/no open agent PRs|CI green|NO RECENT CI RUNS/);
 assert.equal(gh.callsMatching(/^run list/).length,0);
});
it("distinguishes a successful empty runs query from CI that could not be read",async()=>{
 doc().byId.L2=loop({id:"L2",session:"worker",kind:"goal"});
 gh.script([{match:"^api user",responses:["owner"]},{match:"^repo view",responses:["main"]},{match:"^run list",responses:["[]"]},{match:"^pr list",responses:["[]"]}]);
 const out=resultText(await call("pipeline_evidence",{}));
 assert.match(out,/NO RECENT CI RUNS/);assert.doesNotMatch(out,/CI unreadable|CI green/);
});

it("does not renew an exhausted worker allowance or iteration limit",async()=>{
 doc().byId.L2=loop({id:"L2",session:"worker",kind:"ci-health",status:"paused",spent:5,budgetUsd:5,note:"budget reached: $5 of $5"});
 const args={action:"resume",loopId:"L2",reason:"CI is red but worker budget has run out"};
 assert.match(resultText(await call("ci_dispatch",args)),/only a general can renew/);
 assert.equal(doc().byId.L2!.spent,5);assert.equal(created,0);
 doc().byId.L2!.spent=0;doc().byId.L2!.note="system failure";doc().byId.L2!.iteration=5;
 assert.match(resultText(await call("ci_dispatch",args)),/iteration limit/);assert.equal(created,0);
});

it("engineering manager can read evidence but receives no CI dispatch authority",async()=>{
 doc().byId.L1!.kind="manager";
 const evidence=await call("factory_evidence",{});
 assert.notEqual(evidence.isError,true); assert.match(resultText(evidence),/DELIVERY WATCH/);
 assert.equal((await call("ci_dispatch",{action:"start",session:"worker",reason:"repair CI"})).isError,true);
 doc().byId.L1!.status="paused";
 assert.equal((await call("factory_evidence",{})).isError,true);
 assert.equal(created,0);
});

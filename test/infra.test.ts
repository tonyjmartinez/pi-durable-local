import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPipelineDigest, dispatchRefusal, dispatchCount, infraEvents, infraWake, pipelineKey, prChecksOf, recentDispatches, reserveDispatch, rollupState, type PipelineRepo } from "../src/infra.ts";
import { newLoop, resolveLoopSpec } from "../src/ops.ts";
import { priorityOf } from "../src/queue.ts";
import { shouldWake } from "../src/loopgate.ts";
const now = Date.parse("2026-11-01T12:00:00Z");
const hour = 3_600_000;
const repo = (patch: Partial<PipelineRepo> = {}): PipelineRepo => ({ repo: "o/r", base: "main", sessions: ["s"], ci: { headSha: "abc1234", failing: [], flaky: [] }, prChecks: { failing: [], pending: 0, passing: 0 }, ...patch });
const paused = { id: "L1", kind: "ci-health", status: "paused", note: "system failure", taskLive: false };
describe("infra evidence", () => {
 it("classifies mixed GitHub check runs and commit statuses without treating pending as green", () => {
  assert.equal(rollupState([]), "none");
  assert.equal(rollupState([{conclusion:"SKIPPED"}]),"none");
  assert.equal(rollupState([{conclusion:"NEUTRAL"}]),"none");
  assert.equal(rollupState([{conclusion:"UNKNOWN_NEW_STATE"}]),"pending");
  assert.equal(rollupState([{ status: "IN_PROGRESS" }]), "pending");
  assert.equal(rollupState([{ state: "PENDING" }]), "pending");
  assert.equal(rollupState([{ conclusion: "SUCCESS" }, { state: "ERROR" }]), "fail");
  assert.equal(rollupState([{ conclusion: "SUCCESS" }, { conclusion: "NEUTRAL" }]), "pass");
  assert.deepEqual(prChecksOf([{ number: 7, statusCheckRollup: [{ conclusion: "FAILURE" }] }, { number: 3, statusCheckRollup: [{ conclusion: "FAILURE" }] }, { number: 4, statusCheckRollup: [{ state: "PENDING" }] }]), { failing: [3, 7], pending: 1, passing: 0 });
 });
 it("fingerprints gaps, not routine green merges, and ignores input order", () => {
  const a=repo(), b=repo({ repo: "o/b" });
  assert.equal(pipelineKey([a,b],[]), pipelineKey([b,repo({ ci: { headSha: "new", failing: [], flaky: [] } })],[]));
  assert.notEqual(pipelineKey([a],[]), pipelineKey([repo({ ci: { headSha: "new", failing: ["test"], flaky: [] } })],[]));
  assert.notEqual(pipelineKey([a],[]), pipelineKey([repo({ ci: undefined, noCi: true })],[]));
  assert.notEqual(pipelineKey([repo({ci:{headSha:"a",failing:["tests"],flaky:[]}})],[]), pipelineKey([repo({ci:{headSha:"b",failing:["tests"],flaky:[]}})],[]));
 });
 it("filters malformed and old audit rows and counts only rolling-day dispatches", () => {
  const events=[{ event: "parked", at: new Date(now).toISOString() }, { event: "parked", at: "bad" }, { event: "merged", at: new Date(now).toISOString() }];
  assert.equal(infraEvents(events,new Set(),now-hour).length,1);
  const rows=[-25,-2,1].map(h=>({ event: "infra_dispatch", at: new Date(now+h*hour).toISOString() }));
  assert.equal(recentDispatches(rows,now),1);
 });
 it("reports red first, no-run and unreadable states explicitly, bounds and redacts output", () => {
  const out=buildPipelineDigest({ now, repos: [repo({ repo:"o/z", ci: { headSha:"abc", failing:["tests"], flaky:[] } }),repo({ ci:undefined,noCi:true }), repo({ repo:"o/private",ci:undefined })], audit:[{ at:new Date(now).toISOString(),event:"parked",reason:"token ghp_abcdefghijklmnopqrstuvwxyz1234567890AB" }], dispatchesLeft:3 });
  assert.ok(out.indexOf("o/z") < out.indexOf("o/r"));
  assert.match(out,/NO RECENT CI RUNS/); assert.match(out,/CI unreadable/);
  assert.doesNotMatch(out,/ghp_abcdefghijklmnopqrstuvwxyz/);
  assert.ok(buildPipelineDigest({ now,repos:Array.from({length:500},(_,i)=>repo({repo:`o/r${i}`})),audit:[],dispatchesLeft:3 }).length <= 10000);
 });
});
describe("infra cost gate and dispatch authority", () => {
 it("skips unchanged evidence, refreshes after12h and yields near pacing unless red", () => {
  const input={ key:"same",lastKey:"same",lastRunAt:now-hour,now,anyRed:false,holdShare:.7 };
  assert.equal(infraWake(input).wake,false);
  assert.equal(infraWake({...input,lastRunAt:now-12*hour}).wake,true);
  assert.equal(infraWake({...input,key:"changed",spendShare:.8}).wake,false);
  assert.equal(infraWake({...input,key:"changed",spendShare:.8,anyRed:true}).wake,true);
 });
 it("refuses human pauses, budget cuts, active tasks, wrong kinds and exhausted quota", () => {
  assert.equal(dispatchRefusal({action:"resume",loop:paused,recent:0}),undefined);
  for(const loop of [{...paused,note:"paused by user"},{...paused,note:"cut by budget-review: low value"},{...paused,kind:"goal"},{...paused,taskLive:true},{...paused,status:"active"}]) assert.ok(dispatchRefusal({action:"resume",loop,recent:0}));
  assert.ok(dispatchRefusal({action:"resume",loop:paused,recent:3}));
  assert.ok(dispatchRefusal({action:"resume",loop:paused,recent:0,budgetRefusal:"pacing"}));
  assert.ok(dispatchRefusal({action:"start",recent:0,session:{name:"s"}}));
  assert.ok(dispatchRefusal({action:"start",recent:0,session:{name:"s",repo:"o/r"},loop:paused}));
 });
 it("enforces a persistent rolling quota independently of truncated audit logs", () => {
  const doc:{infraDispatches?:number[]}={};
  for(let i=0;i<3;i++) reserveDispatch(doc,now+i);
  assert.throws(()=>reserveDispatch(doc,now+3),/quota/);
  assert.equal(doc.infraDispatches!.length,3);
  assert.equal(dispatchCount(doc,now+3),3);
  reserveDispatch(doc,now+25*hour);
  assert.equal(doc.infraDispatches!.length,1);
  assert.equal(dispatchCount(doc,now+25*hour),1);
 });
 it("wires an hourly high-priority bounded preset with its own cross-repo gate", () => {
  const spec=resolveLoopSpec({preset:"infra-lead"});
  const loop=newLoop({id:"L1",session:"infra",spec,defaults:{defaultBudgetUsd:100,defaultIntervalMinutes:30,defaultMaxIterations:100},costAtStart:0,now});
  assert.equal(loop.kind,"infra"); assert.equal(loop.budgetUsd,5); assert.equal(loop.intervalMinutes,60); assert.equal(priorityOf(loop),2);
  assert.equal(shouldWake({loop:{kind:"infra",iteration:2,lastRunAt:now-hour},repo:{baseHeadSha:"a",baseHeadCommittedAt:0,openAgentPrs:[{number:1,headSha:"h",checksState:"pending"}],openFrictionIssues:0},now}).wake,true);
 });
});

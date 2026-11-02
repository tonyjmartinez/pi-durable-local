import assert from "node:assert/strict";
import { it } from "node:test";
import { deliveryKey, deliveryDigest } from "../src/manager.ts";
import { LOOP_SCHEDULE, shouldWake } from "../src/loopgate.ts";
import { buildBrief } from "../src/brief.ts";
import type { Loop } from "../src/state.ts";
const now=20*3600000;
const worker: Loop={id:"L1",session:"worker",status:"active",kind:"goal",iteration:1,maxIterations:10,goal:"ship",intervalMinutes:30,budgetUsd:1,spent:.85,createdAt:1,nextRunAt:now,costAtStart:0,lastRunAt:now-5*3600000,note:"waiting: pacing"};
const input={now,loops:[worker],directions:{"o/r":{version:2,text:"Ship the agreed feature",by:"general",at:now-3*3600000,acks:{L1:{status:"pending" as const,at:1}},history:[]}}};
it("alerts on missed acknowledgements, checkpoints and budget risk without claiming completion",()=>{
 const s=deliveryDigest(input); for(const re of [/v2 by general/,/OVERDUE/,/overdue checkpoint/,/AT RISK/,/waiting: pacing/,/verify completion independently/]) assert.match(s,re);
});
it("is stable across idle polling, but notices deadlines and actual progress",()=>{
 assert.equal(deliveryKey(input),deliveryKey({...input,now:now+60000}));
 assert.notEqual(deliveryKey(input),deliveryKey({...input,loops:[{...worker,iteration:2}]}));
 assert.notEqual(deliveryKey(input),deliveryKey({...input,now:now-2*3600000}));
 assert.equal(deliveryKey(input),deliveryKey({...input,loops:[worker,{...worker,id:"L9",kind:"manager"}]}));
});
it("preserves pause and missing-progress evidence and reports exhausted budgets",()=>{
 const s=deliveryDigest({...input,loops:[{...worker,status:"paused",lastRunAt:undefined,spent:1,note:"paused by user"}]});
 assert.match(s,/paused by user/); assert.match(s,/unknown/); assert.match(s,/EXHAUSTED/);
});
it("monitors factory delivery even when its own repository has pending PRs",()=>{
 const result=shouldWake({now,loop:{kind:"manager",iteration:0,dormant:{fingerprint:"x",since:1}},repo:{baseHeadSha:"x",baseHeadCommittedAt:1,openFrictionIssues:0,openAgentPrs:[{number:1,headSha:"x",checksState:"pending"}]}});
 assert.equal(result.wake,true); assert.equal(LOOP_SCHEDULE["engineering-manager"].budgetUsd,2);
});
it("shows scorecard age and labels it recorded evidence in the general brief",()=>{
 const s=buildBrief({now,sessions:[],loops:[],audit:[],openPrs:new Set(),decisions:[],delivery:{text:"L1 needs a checkpoint",by:"manager",updatedAt:now-60000}});
 assert.match(s,/DELIVERY SCORECARD.*1m ago; recorded evidence/); assert.match(s,/L1 needs a checkpoint/);
});

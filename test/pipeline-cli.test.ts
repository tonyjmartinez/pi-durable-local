// Exercise the real CLI over an isolated Unix socket: no live daemon, store or model.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { it } from "node:test";
const run = promisify(execFile);
const client = fileURLToPath(new URL("../src/client.ts", import.meta.url));
async function fixture(status: number, body: unknown, check: (env: NodeJS.ProcessEnv, calls: string[]) => Promise<void>) {
 const root = mkdtempSync(join(tmpdir(), "pd-pipeline-"));
 const data = join(root,"data"); mkdirSync(data);
 const calls: string[] = [];
 const server = createServer((req,res)=>{calls.push(`${req.method} ${req.url}`);res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(body));});
 await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(join(data,"pdd.sock"),resolve);});
 try { await check({...process.env,PD_DATA_DIR:data,PD_CONFIG_DIR:join(root,"config")},calls); }
 finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
}
it("prints timestamped evidence and makes only a read-only pipeline request",async()=>{
 await fixture(200,{observedAt:Date.parse("2026-11-02T01:00:00Z"),text:"PIPELINE: 0 red\nNo repair dispatched."},async(env,calls)=>{
  const {stdout}=await run(process.execPath,[client,"pipeline"],{env,timeout:10_000});
  assert.match(stdout,/2026-11-02T01:00:00.000Z/);assert.match(stdout,/read-only, no model call/);assert.match(stdout,/PIPELINE: 0 red/);
  assert.deepEqual(calls,["GET /pipeline"]);
 });
});
it("reports unavailable evidence without mutating or dispatching work",async()=>{
 await fixture(503,{error:"pipeline evidence unavailable"},async(env,calls)=>{
  await assert.rejects(run(process.execPath,[client,"pipeline"],{env,timeout:10_000}),(error: unknown)=>{
   const failure=error as {code:number;stderr:string};assert.equal(failure.code,1);assert.match(failure.stderr,/pipeline evidence unavailable/);return true;
  });
  assert.deepEqual(calls,["GET /pipeline"]);
 });
});

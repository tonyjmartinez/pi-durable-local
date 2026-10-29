// web_fetch runs inside the daemon, outside the sandbox: it must never reach a local or private address.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const root = mkdtempSync(join(tmpdir(), "pd-net-"));
process.env.PD_DATA_DIR = join(root, "data");
process.env.PD_CONFIG_DIR = join(root, "cfg");
mkdirSync(process.env.PD_DATA_DIR, { recursive: true });
mkdirSync(process.env.PD_CONFIG_DIR, { recursive: true });
const { isPrivateAddress, Web_ } = await import("../src/extensions.ts");

describe("isPrivateAddress", () => {
	const PRIVATE = [
		"127.0.0.1", "127.255.255.254", "0.0.0.0", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1",
		"169.254.169.254", "100.64.0.1", "100.127.255.255", "192.0.0.1", "198.18.0.1", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
		"::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "ff02::1", "64:ff9b::7f00:1",
		"::ffff:127.0.0.1", "::ffff:10.1.2.3", "::ffff:169.254.169.254", "::ffff:7f00:1", "::ffff:a00:1", "::FFFF:192.168.0.1",
	];
	const PUBLIC = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "192.169.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "::ffff:808:808"];

	for (const address of PRIVATE) {
		it(`blocks ${address}`, () => assert.equal(isPrivateAddress(address), true));
	}
	for (const address of PUBLIC) {
		it(`allows ${address}`, () => assert.equal(isPrivateAddress(address), false));
	}
});

describe("web_fetch", () => {
	const tool = Web_.tools!.find((entry) => entry.name === "web_fetch")!;
	const fetchTool = (url: string) =>
		(tool.execute as (args: { url: string }, api: unknown, context: unknown) => Promise<{ output: { text: string }[]; isError?: boolean }>)({ url }, {}, {});
	let server: Server;
	let port: number;
	let hits = 0;

	before(async () => {
		server = createServer((_req, res) => {
			hits++;
			res.writeHead(200, { "content-type": "text/plain" }).end("secret local service");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		port = (server.address() as { port: number }).port;
	});
	after(() => server.close());

	it("refuses every spelling of a local address without contacting it", async () => {
		const targets = [
			`http://127.0.0.1:${port}/`,
			`http://localhost:${port}/`,
			`http://LOCALHOST.:${port}/`,
			`http://foo.localhost:${port}/`,
			`http://2130706433:${port}/`,
			`http://0x7f000001:${port}/`,
			`http://0177.0.0.1:${port}/`,
			`http://127.1:${port}/`,
			`http://[::1]:${port}/`,
			`http://[::ffff:127.0.0.1]:${port}/`,
			`http://[::ffff:7f00:1]:${port}/`,
			`http://0.0.0.0:${port}/`,
			`http://user:pass@127.0.0.1:${port}/`,
			"http://169.254.169.254/latest/meta-data/",
			"http://10.0.0.1/",
			"http://192.168.0.1/",
			"http://100.64.0.1/",
			"http://[fd00::1]/",
			"http://[fe80::1]/",
			"http://printer.local/",
			"http://metadata.internal/",
		];
		for (const url of targets) {
			const result = await fetchTool(url);
			assert.equal(result.isError, true, `${url} should be refused`);
			assert.match(result.output[0]!.text, /Blocked/, url);
		}
		assert.equal(hits, 0, "the local server was never contacted");
	});

	it("refuses anything that is not http or https", async () => {
		for (const url of ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com/", "data:text/plain,hi", "javascript:alert(1)"]) {
			const result = await fetchTool(url);
			assert.equal(result.isError, true, url);
			assert.match(result.output[0]!.text, /Only http\(s\) URLs/, url);
		}
	});

	it("rejects a malformed URL", async () => {
		for (const url of ["", "not a url", "http://", "//example.com"]) {
			const result = await fetchTool(url);
			assert.equal(result.isError, true, JSON.stringify(url));
		}
	});
});

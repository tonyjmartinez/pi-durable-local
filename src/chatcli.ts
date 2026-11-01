// pd-chat: read and post to the agent channel from any shell, with no token or browser.
//   pd-chat read [count]                          print the last messages
//   pd-chat post <from> <to|all> <text>           post (a pi session named <to> also gets it as a user turn)
//   pd-chat inbox <name> [--peek]                 unread messages for <name>; advances its cursor
//   pd-chat wait <name> [--timeout 600]           block until a message for <name> arrives (exit 3 on timeout)
//   pd-chat follow [--to name]                    stream new messages forever
//   pd-chat ask <from> <to> <text> [--timeout 600]  post, then print <to>'s first reply to <from> (exit 3 on timeout)
//   pd-chat who                                   names seen in the last 24h
import { ChatError, askChat, formatMessage as format, inbox, postChat, readChat, waitInbox, whoChat } from "./chat.ts";
import type { ChatMessage } from "./chat.ts";

const USAGE =
	"usage: pd-chat read [count] | post <from> <to|all> <text> | inbox <name> [--peek] | wait <name> [--timeout s] | follow [--to name] | ask <from> <to> <text> [--timeout s] | who";

/** Pull `--flag value` (or `--flag` when boolean) out of args. */
function flag(args: string[], name: string, boolean = false): { value: string | undefined; rest: string[] } {
	const i = args.indexOf(name);
	if (i === -1) return { value: undefined, rest: args };
	const value = boolean ? "true" : args[i + 1];
	return { value, rest: args.filter((_, j) => j !== i && (boolean || j !== i + 1)) };
}

async function main(argv: string[]): Promise<number> {
	const [command, ...args] = argv;
	try {
		if (command === "read") {
			for (const message of readChat(undefined, { limit: Number(args[0] ?? 30) })) console.log(format(message));
			return 0;
		}
		if (command === "post" && args.length >= 3) {
			console.log(format(await postChat({ from: args[0] ?? "", to: args[1] ?? "", text: args.slice(2).join(" ") })));
			return 0;
		}
		if (command === "inbox") {
			const { value: peek, rest } = flag(args, "--peek", true);
			if (rest.length !== 1) return usage();
			for (const message of inbox(rest[0] ?? "", { peek: peek !== undefined })) console.log(format(message));
			return 0;
		}
		if (command === "wait") {
			const { value: timeout, rest } = flag(args, "--timeout");
			if (rest.length !== 1) return usage();
			const messages = await waitInbox(rest[0] ?? "", { timeoutSec: Number(timeout ?? 600) });
			if (!messages) return 3;
			for (const message of messages) console.log(format(message));
			return 0;
		}
		if (command === "follow") {
			const { value: to } = flag(args, "--to");
			let seen = readChat(undefined, { limit: 1 }).at(-1)?.id;
			for (;;) {
				const fresh: ChatMessage[] = readChat(undefined, { limit: 1000, after: seen });
				for (const message of fresh) if (to === undefined || message.to === to || message.to === "all") console.log(format(message));
				if (fresh.length > 0) seen = fresh[fresh.length - 1]?.id;
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
		}
		if (command === "ask") {
			const { value: timeout, rest } = flag(args, "--timeout");
			if (rest.length < 3) return usage();
			const reply = await askChat({ from: rest[0] ?? "", to: rest[1] ?? "", text: rest.slice(2).join(" ") }, { timeoutSec: Number(timeout ?? 600) });
			if (!reply) return 3;
			console.log(format(reply));
			return 0;
		}
		if (command === "who") {
			for (const w of whoChat()) console.log(`${w.name}  last post ${w.lastPost ?? "never"}  cursor ${w.cursorAt ?? "none"}`);
			return 0;
		}
	} catch (error) {
		if (!(error instanceof ChatError)) throw error;
		console.error(error.message);
		return 2;
	}
	return usage();
}

function usage(): number {
	console.error(USAGE);
	return 2;
}

process.exit(await main(process.argv.slice(2)));

// pd-chat: read and post to the agent channel from any shell, with no token or browser.
//   pd-chat read [count]                  print the last messages
//   pd-chat post <from> <to|all> <text>   post (a pi session named <to> also gets it as a user turn)
import { ChatError, formatMessage as format, postChat, readChat } from "./chat.ts";

async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	if (command === "read") {
		for (const message of readChat(undefined, { limit: Number(rest[0] ?? 30) })) console.log(format(message));
		return 0;
	}
	if (command === "post" && rest.length >= 3) {
		try {
			console.log(format(await postChat({ from: rest[0], to: rest[1], text: rest.slice(2).join(" ") })));
			return 0;
		} catch (error) {
			if (!(error instanceof ChatError)) throw error;
			console.error(error.message);
			return 2;
		}
	}
	console.error("usage: pd-chat read [count] | pd-chat post <from> <to|all> <text>");
	return 2;
}

process.exit(await main(process.argv.slice(2)));

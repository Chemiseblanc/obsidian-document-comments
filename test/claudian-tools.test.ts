import { TFile } from "obsidian";
import { describe, expect, it } from "vitest";
import { createCommentTools } from "../src/claudian-tools";

const makeApp = (initial: string) => {
	let document = initial;
	const file = Object.assign(new TFile(), { path: "Note.md", extension: "md" });
	const app = {
		workspace: { getLeavesOfType: () => [] },
		vault: {
			getAbstractFileByPath: (path: string) => (path === file.path ? file : null),
			read: async () => document,
			process: async (_file: TFile, transform: (value: string) => string) => {
				document = transform(document);
				return document;
			},
		},
	};
	return {
		app,
		get document() {
			return document;
		},
		set document(value: string) {
			document = value;
		},
	};
};

describe("Claudian comment tools", () => {
	it("rejects a note changed between revision verification and the atomic edit", async () => {
		const vault = makeApp("Hello world\n");
		const tools = createCommentTools(vault.app as never);
		const list = tools.find((tool) => tool.name === "comments_list")!;
		const add = tools.find((tool) => tool.name === "comments_add")!;
		const context = { providerId: "claude", model: "test" };
		const listed = await list.execute({ path: "Note.md" }, context);
		if (!listed.ok) throw new Error(listed.error.message);
		const process = vault.app.vault.process;
		vault.app.vault.process = async (file, transform) => {
			vault.document = "An independent editor changed this note.\n";
			return process(file, transform);
		};

		const result = await add.execute(
			{
				path: "Note.md",
				expectedRevision: (listed.value as { revision: string }).revision,
				from: 6,
				to: 11,
				expected: "world",
				text: "Must not overwrite",
			},
			context,
		);

		expect(result).toMatchObject({ ok: false, error: { code: "conflict" } });
		expect(vault.document).toBe("An independent editor changed this note.\n");
	});

	it("never deletes an existing highlight through the write-only add operation", async () => {
		const original = 'Hello <!--c:a1-->world<!--/c:a1-->\n<!--co:a1 status:open quote:"world"\n-->\n';
		const vault = makeApp(original);
		const tools = createCommentTools(vault.app as never);
		const context = { providerId: "claude", model: "test" };
		const listed = await tools.find((tool) => tool.name === "comments_list")!.execute({ path: "Note.md" }, context);
		if (!listed.ok) throw new Error(listed.error.message);
		const result = await tools
			.find((tool) => tool.name === "comments_add")!
			.execute(
				{
					path: "Note.md",
					expectedRevision: (listed.value as { revision: string }).revision,
					from: original.indexOf("world"),
					to: original.indexOf("world") + 5,
					expected: "world",
					text: "",
				},
				context,
			);
		expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
		expect(vault.document).toBe(original);
	});

	it("creates, replies, resolves, edits, and deletes without losing note text", async () => {
		const vault = makeApp("Hello world\n");
		const tools = createCommentTools(vault.app as never);
		const byName = (name: string) => tools.find((tool) => tool.name === `comments_${name}`)!;
		const context = { providerId: "anthropic", model: "test" };
		const listed = await byName("list").execute({ path: "Note.md" }, context);
		if (!listed.ok) throw new Error(listed.error.message);
		const revision = (listed.value as { revision: string }).revision;

		const added = await byName("add").execute(
			{ path: "Note.md", expectedRevision: revision, from: 6, to: 11, expected: "world", text: "Initial" },
			context,
		);
		if (!added.ok) throw new Error(added.error.message);
		const firstThread = (
			added.value as { thread: { id: string; entries: Array<{ author: string }> }; revision: string }
		).thread;
		expect(firstThread.entries[0]?.author).toBe("claudian_anthropic");
		const id = firstThread.id;

		const replied = await byName("reply").execute(
			{ path: "Note.md", expectedRevision: (added.value as { revision: string }).revision, id, text: "Reply" },
			context,
		);
		if (!replied.ok) throw new Error(replied.error.message);
		expect((replied.value as { thread: { entries: unknown[] } }).thread.entries).toHaveLength(2);

		const resolved = await byName("set_status").execute(
			{
				path: "Note.md",
				expectedRevision: (replied.value as { revision: string }).revision,
				id,
				status: "resolved",
			},
			context,
		);
		if (!resolved.ok) throw new Error(resolved.error.message);
		expect((resolved.value as { thread: { status: string } }).thread.status).toBe("resolved");

		const edited = await byName("edit").execute(
			{
				path: "Note.md",
				expectedRevision: (resolved.value as { revision: string }).revision,
				id,
				index: 1,
				text: "Edited",
			},
			context,
		);
		if (!edited.ok) throw new Error(edited.error.message);
		expect((edited.value as { thread: { entries: Array<{ text: string }> } }).thread.entries[1]?.text).toBe(
			"Edited",
		);

		const deleted = await byName("delete").execute(
			{ path: "Note.md", expectedRevision: (edited.value as { revision: string }).revision, id },
			context,
		);
		if (!deleted.ok) throw new Error(deleted.error.message);
		expect(vault.document).toBe("Hello world\n");
	});

	it("rejects stale writes and unsafe or unknown paths", async () => {
		const vault = makeApp("Hello world\n");
		const tools = createCommentTools(vault.app as never);
		const list = tools.find((tool) => tool.name === "comments_list")!;
		const add = tools.find((tool) => tool.name === "comments_add")!;
		const context = { providerId: "test", model: "test" };
		const stale = await add.execute(
			{ path: "Note.md", expectedRevision: "stale-revision", from: 6, to: 11, expected: "world", text: "Nope" },
			context,
		);
		expect(stale).toMatchObject({ ok: false, error: { code: "conflict" } });
		expect(vault.document).toBe("Hello world\n");
		expect(await list.execute({ path: "../Note.md" }, context)).toMatchObject({
			ok: false,
			error: { code: "invalid_input" },
		});
		expect(await list.execute({ path: "Missing.md" }, context)).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
	});
});

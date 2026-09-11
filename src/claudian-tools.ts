import { type App, TFile } from "obsidian";
import { Result } from "better-result";
import { generateId } from "./format/ids";
import { anchorRange, existingIds, parseComments } from "./format/parse";
import type { Change } from "./editor/edits";
import {
	computeAddComment,
	computeAppendReply,
	computeDeleteComment,
	computeEditEntry,
	computeSetResolved,
	findHighlightAtSelection,
} from "./editor/edits";
import { applyCommentEdit, editorViewForFile } from "./editor/routing";

/** Structural copy of Claudian's optional API. Keep this import-free so the
 * plugin can be installed without Claudian being present. */
export type ClaudianPluginToolApi = {
	readonly version: 1;
	registerTools(
		owner: { readonly manifest: { readonly id: string }; register(callback: () => unknown): void },
		tools: readonly ClaudianPluginTool[],
	): () => void;
};

export type ClaudianPluginTool = {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Readonly<Record<string, unknown>>;
	readonly effect: "read" | "write" | "destructive";
	execute(input: unknown, context: ClaudianToolInvocationContext): Promise<ClaudianToolResult>;
};

export type ClaudianToolInvocationContext = {
	readonly providerId: string;
	readonly model: string;
};

type ClaudianToolErrorCode =
	| "invalid_input"
	| "not_found"
	| "provider_unavailable"
	| "provider_disabled"
	| "model_unavailable"
	| "invalid_schedule"
	| "permission_denied"
	| "conflict"
	| "internal_error";

export type ClaudianToolResult =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly error: { readonly code: ClaudianToolErrorCode; readonly message: string } };
type ToolFailure = Extract<ClaudianToolResult, { readonly ok: false }>;
type Input = Record<string, unknown>;
type ToolCompute = (doc: string) => Result<Change[], string>;

const CONFLICT = "__document_comments_conflict__";
const TOOL_PREFIX = "comments_";

const stringProperty = (description: string) => ({ type: "string", description });
const pathProperty = stringProperty("Vault-relative Markdown path.");
const revisionProperty = stringProperty("SHA-256 revision returned by comments_list.");

const LIST_SCHEMA = Object.freeze({
	type: "object",
	additionalProperties: false,
	properties: { path: pathProperty },
	required: ["path"],
});
const MUTATION_BASE = {
	type: "object",
	additionalProperties: false,
	properties: { path: pathProperty, expectedRevision: revisionProperty },
	required: ["path", "expectedRevision"],
} as const;
const ADD_SCHEMA = Object.freeze({
	...MUTATION_BASE,
	properties: {
		...MUTATION_BASE.properties,
		from: { type: "integer", minimum: 0, description: "UTF-16 source offset (inclusive)." },
		to: { type: "integer", minimum: 0, description: "UTF-16 source offset (exclusive)." },
		expected: stringProperty("Exact selected source text at from/to."),
		text: { ...stringProperty("Non-empty initial comment text."), minLength: 1 },
	},
	required: [...MUTATION_BASE.required, "from", "to", "expected", "text"],
});
const REPLY_SCHEMA = Object.freeze({
	...MUTATION_BASE,
	properties: {
		...MUTATION_BASE.properties,
		id: stringProperty("Comment thread ID."),
		text: stringProperty("Reply text."),
	},
	required: [...MUTATION_BASE.required, "id", "text"],
});
const STATUS_SCHEMA = Object.freeze({
	...MUTATION_BASE,
	properties: {
		...MUTATION_BASE.properties,
		id: stringProperty("Comment thread ID."),
		status: { type: "string", enum: ["open", "resolved"] },
	},
	required: [...MUTATION_BASE.required, "id", "status"],
});
const EDIT_SCHEMA = Object.freeze({
	...MUTATION_BASE,
	properties: {
		...MUTATION_BASE.properties,
		id: stringProperty("Comment thread ID."),
		index: { type: "integer", minimum: 0, description: "Zero-based thread entry index." },
		text: stringProperty("Replacement entry text."),
	},
	required: [...MUTATION_BASE.required, "id", "index", "text"],
});
const DELETE_SCHEMA = Object.freeze({
	...MUTATION_BASE,
	properties: { ...MUTATION_BASE.properties, id: stringProperty("Comment thread ID.") },
	required: [...MUTATION_BASE.required, "id"],
});

/** Register Document Comments' six public operations with one Claudian API. */
export const registerCommentTools = (
	app: App,
	owner: { readonly manifest: { readonly id: string }; register(callback: () => unknown): void },
	api: ClaudianPluginToolApi,
): (() => void) => api.registerTools(owner, createCommentTools(app));

export const createCommentTools = (app: App): readonly ClaudianPluginTool[] =>
	Object.freeze([
		{
			name: `${TOOL_PREFIX}list`,
			description: "List inline Document Comments threads in a Markdown note.",
			inputSchema: LIST_SCHEMA,
			effect: "read" as const,
			execute: async (input: unknown) => executeList(app, input),
		},
		{
			name: `${TOOL_PREFIX}add`,
			description: "Add a Document Comments thread to an exact UTF-16 source selection.",
			inputSchema: ADD_SCHEMA,
			effect: "write" as const,
			execute: async (input: unknown, context: ClaudianToolInvocationContext) => executeAdd(app, input, context),
		},
		{
			name: `${TOOL_PREFIX}reply`,
			description: "Append a reply to a Document Comments thread.",
			inputSchema: REPLY_SCHEMA,
			effect: "write" as const,
			execute: async (input: unknown, context: ClaudianToolInvocationContext) =>
				executeReply(app, input, context),
		},
		{
			name: `${TOOL_PREFIX}set_status`,
			description: "Set a Document Comments thread to open or resolved.",
			inputSchema: STATUS_SCHEMA,
			effect: "write" as const,
			execute: async (input: unknown) => executeStatus(app, input),
		},
		{
			name: `${TOOL_PREFIX}edit`,
			description: "Replace one entry in a Document Comments thread.",
			inputSchema: EDIT_SCHEMA,
			effect: "write" as const,
			execute: async (input: unknown) => executeEdit(app, input),
		},
		{
			name: `${TOOL_PREFIX}delete`,
			description: "Delete a Document Comments thread while preserving its anchored note text.",
			inputSchema: DELETE_SCHEMA,
			effect: "destructive" as const,
			execute: async (input: unknown) => executeDelete(app, input),
		},
	] satisfies readonly ClaudianPluginTool[]);

const executeList = async (app: App, raw: unknown): Promise<ClaudianToolResult> => {
	try {
		const input = objectInput(raw);
		const path = requiredPath(input);
		const file = resolveMarkdownFile(app, path);
		if (!file) return failure("not_found", "Markdown note not found.");
		const data = editorViewForFile(app, file)?.state.doc.toString() ?? (await app.vault.read(file));
		return success({ path, revision: await sha256(data), threads: parseThreads(data) });
	} catch (error) {
		return caught(error);
	}
};

const executeAdd = async (
	app: App,
	raw: unknown,
	context: ClaudianToolInvocationContext,
): Promise<ClaudianToolResult> => {
	try {
		const input = objectInput(raw);
		const { path, expectedRevision, from, to, expected, text } = addInput(input);
		const file = resolveMarkdownFile(app, path);
		if (!file) return failure("not_found", "Markdown note not found.");
		let id = "";
		const result = await checkedEdit(app, file, expectedRevision, (doc) => {
			if (from > doc.length || to > doc.length) return Result.err("Selection offsets are outside the note.");
			id = findHighlightAtSelection(doc, from, to)?.id ?? generateId(existingIds(doc));
			return computeAddComment(doc, from, to, {
				id,
				createdAt: new Date().toISOString(),
				author: agentAuthor(context),
				text,
				expected,
				allowEmpty: false,
			});
		});
		if (!result.ok) return result;
		const thread = parseThreads(result.document).find((candidate) => candidate.id === id);
		return thread
			? success({ path, revision: await sha256(result.document), thread })
			: failure("internal_error", "Comment was not created.");
	} catch (error) {
		return caught(error);
	}
};

const executeReply = async (
	app: App,
	raw: unknown,
	context: ClaudianToolInvocationContext,
): Promise<ClaudianToolResult> => {
	try {
		const input = objectInput(raw);
		const { path, expectedRevision, id, text } = simpleMutationInput(input);
		const file = resolveMarkdownFile(app, path);
		if (!file) return failure("not_found", "Markdown note not found.");
		const result = await checkedEdit(app, file, expectedRevision, (doc) =>
			computeAppendReply(doc, id, {
				createdAt: new Date().toISOString(),
				author: agentAuthor(context),
				text,
			}),
		);
		if (!result.ok) return result;
		return await threadResult(path, result.document, id);
	} catch (error) {
		return caught(error);
	}
};

const executeStatus = async (app: App, raw: unknown): Promise<ClaudianToolResult> => {
	try {
		const input = objectInput(raw);
		const { path, expectedRevision, id, status } = statusInput(input);
		const file = resolveMarkdownFile(app, path);
		if (!file) return failure("not_found", "Markdown note not found.");
		const result = await checkedEdit(app, file, expectedRevision, (doc) =>
			computeSetResolved(doc, id, status === "resolved"),
		);
		if (!result.ok) return result;
		return await threadResult(path, result.document, id);
	} catch (error) {
		return caught(error);
	}
};

const executeEdit = async (app: App, raw: unknown): Promise<ClaudianToolResult> => {
	try {
		const input = objectInput(raw);
		const { path, expectedRevision, id, index, text } = editInput(input);
		const file = resolveMarkdownFile(app, path);
		if (!file) return failure("not_found", "Markdown note not found.");
		const result = await checkedEdit(app, file, expectedRevision, (doc) => computeEditEntry(doc, id, index, text));
		if (!result.ok) return result;
		return await threadResult(path, result.document, id);
	} catch (error) {
		return caught(error);
	}
};

const executeDelete = async (app: App, raw: unknown): Promise<ClaudianToolResult> => {
	try {
		const input = objectInput(raw);
		const { path, expectedRevision, id } = deleteInput(input);
		const file = resolveMarkdownFile(app, path);
		if (!file) return failure("not_found", "Markdown note not found.");
		const result = await checkedEdit(app, file, expectedRevision, (doc) => computeDeleteComment(doc, id));
		if (!result.ok) return result;
		return success({ path, revision: await sha256(result.document), id, deleted: true });
	} catch (error) {
		return caught(error);
	}
};

const checkedEdit = async (
	app: App,
	file: TFile,
	expectedRevision: string,
	compute: ToolCompute,
): Promise<{ readonly ok: true; readonly document: string } | ToolFailure> => {
	const source = editorViewForFile(app, file)?.state.doc.toString() ?? (await app.vault.read(file));
	if ((await sha256(source)) !== expectedRevision)
		return failure("conflict", "The note changed since it was listed.");
	let conflict = false;
	let computeError: string | undefined;
	const result = await applyCommentEdit(app, file, (doc) => {
		if (doc !== source) {
			conflict = true;
			return Result.err(CONFLICT);
		}
		const computed = compute(doc);
		if (computed.isErr()) computeError = computed.error;
		return computed;
	});
	if (result.isErr()) {
		if (conflict || result.error === CONFLICT) return failure("conflict", "The note changed since it was listed.");
		if (computeError !== undefined && computeError === result.error) {
			return failure(mapComputeError(result.error), result.error);
		}
		return failure("internal_error", result.error);
	}
	return { ok: true, document: result.value };
};

const threadResult = async (path: string, document: string, id: string): Promise<ClaudianToolResult> => {
	const thread = parseThreads(document).find((candidate) => candidate.id === id);
	return thread
		? success({ path, revision: await sha256(document), thread })
		: failure("not_found", "Comment thread not found.");
};

const parseThreads = (document: string): readonly Record<string, unknown>[] =>
	parseComments(document)
		.filter((comment) => comment.body !== null)
		.map((comment) => ({
			id: comment.id,
			anchor: anchorRange(comment),
			entries: comment.thread,
			status: comment.status,
			author: comment.author,
			createdAt: comment.createdAt,
			quote: comment.quote,
			reactions: comment.reactions,
		}));

const objectInput = (raw: unknown): Input => {
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		throw new ToolInputError("Tool input must be an object.");
	return raw as Input;
};

const requiredPath = (input: Input): string => {
	const path = requiredString(input, "path");
	if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
		throw new ToolInputError("path must be a vault-relative Markdown path.");
	}
	const segments = path.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		throw new ToolInputError("path must not contain traversal segments.");
	}
	if (!path.toLowerCase().endsWith(".md")) throw new ToolInputError("path must name a Markdown file.");
	return path;
};

const resolveMarkdownFile = (app: App, path: string): TFile | null => {
	const candidate = app.vault.getAbstractFileByPath(path);
	return candidate instanceof TFile && candidate.extension.toLowerCase() === "md" ? candidate : null;
};

const addInput = (input: Input) => {
	const { path, expectedRevision } = mutationBase(input);
	const from = safeOffset(input.from, "from");
	const to = safeOffset(input.to, "to");
	const expected = requiredString(input, "expected");
	const text = requiredString(input, "text");
	if (!text.trim()) throw new ToolInputError("Initial comment text must not be empty.");
	return { path, expectedRevision, from, to, expected, text };
};

const simpleMutationInput = (input: Input) => {
	const { path, expectedRevision } = mutationBase(input);
	return { path, expectedRevision, id: requiredId(input), text: requiredString(input, "text") };
};

const statusInput = (input: Input) => {
	const { path, expectedRevision } = mutationBase(input);
	const status = input.status;
	if (status !== "open" && status !== "resolved") throw new ToolInputError("status must be open or resolved.");
	return { path, expectedRevision, id: requiredId(input), status };
};

const editInput = (input: Input) => {
	const { path, expectedRevision } = mutationBase(input);
	return {
		path,
		expectedRevision,
		id: requiredId(input),
		index: safeOffset(input.index, "index"),
		text: requiredString(input, "text"),
	};
};

const deleteInput = (input: Input) => {
	const { path, expectedRevision } = mutationBase(input);
	return { path, expectedRevision, id: requiredId(input) };
};

const mutationBase = (input: Input) => ({
	path: requiredPath(input),
	expectedRevision: requiredString(input, "expectedRevision"),
});

const requiredId = (input: Input): string => {
	const id = requiredString(input, "id");
	if (!/^[A-Za-z0-9]+$/.test(id)) throw new ToolInputError("id must contain only ASCII letters and digits.");
	return id;
};

const requiredString = (input: Input, key: string): string => {
	const value = input[key];
	if (typeof value !== "string") throw new ToolInputError(`${key} must be a string.`);
	return value;
};

const safeOffset = (value: unknown, key: string): number => {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new ToolInputError(`${key} must be a non-negative integer.`);
	}
	return value;
};

const agentAuthor = (context: ClaudianToolInvocationContext): string => `claudian_${context.providerId}`;

const mapComputeError = (message: string): ClaudianToolErrorCode =>
	/Comment not found|Comment has no body|reply no longer exists|empty comment no longer exists|Nothing to delete/i.test(
		message,
	)
		? "not_found"
		: "invalid_input";

const success = (value: unknown): ClaudianToolResult => ({ ok: true, value });
const failure = (code: ClaudianToolErrorCode, message: string): ToolFailure => ({
	ok: false,
	error: { code, message },
});
const caught = (error: unknown): ClaudianToolResult =>
	error instanceof ToolInputError
		? failure("invalid_input", error.message)
		: failure("internal_error", error instanceof Error ? error.message : "Document Comments operation failed.");

class ToolInputError extends Error {}

/** SHA-256 of UTF-8 note contents using the browser's Web Crypto primitive. */
export const sha256 = async (value: string): Promise<string> => {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

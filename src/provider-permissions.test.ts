import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimePermissionPolicy } from "@get-bb/plugin-sdk/provider-bridge";
import { approvalInteractionOutcomeSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import nanoGptPlugin from "../server.js";
import {
  experimental_createBridgeJsonRpcTestHarness as createHarness,
  type BridgeJsonRpcTestHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "./provider-bridge.js";
import { HISTORY_TOOL_NAME } from "./history-protocol.js";

const FULL: RuntimePermissionPolicy = { permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null };
const RESTRICTED: RuntimePermissionPolicy[] = [
  { permissionMode: "accept-edits", permissionScope: "workspace", approvalReviewer: "user", permissionEscalation: "ask" },
  { permissionMode: "accept-edits", permissionScope: "workspace", approvalReviewer: "user", permissionEscalation: "deny" },
  { permissionMode: "auto", permissionScope: "workspace", approvalReviewer: "automatic", permissionEscalation: "ask" },
  { permissionMode: "auto", permissionScope: "workspace", approvalReviewer: "automatic", permissionEscalation: "deny" },
];
const TOOL = { name: "read_file", description: "Synthetic file tool", inputSchema: { type: "object" } };
const HISTORY = { ...TOOL, name: HISTORY_TOOL_NAME };
let harness: BridgeJsonRpcTestHarness;
let threadId: string;
let providerThreadId: string;
let bodies: Record<string, any>[];
let responses: Response[];
let sequence = 0;

function options(policy: RuntimePermissionPolicy = FULL) {
  return { ...policy, model: "synthetic/model", reasoningLevel: "medium", envVars: { NANOGPT_API_KEY: "synthetic-key" } };
}
function completion(tool?: string, args: Record<string, unknown> = { path: "fixture" }): Response {
  const delta = tool === undefined ? { content: "Done" } : {
    tool_calls: [{ index: 0, id: "call", function: { name: tool, arguments: JSON.stringify(args) } }],
  };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: tool === undefined ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}
async function request(method: string, params: Record<string, any>) {
  const id = `permissions-${++sequence}`;
  harness.sendRequest(id, method, params);
  return await harness.waitForResponse(id) as { result?: any; error?: { code: number; message: string } };
}
async function waitFor(predicate: () => boolean) {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 2000, interval: 5 });
}
function calls() { return harness.messages.filter(m => m.method === "item/tool/call"); }
function approvals() { return harness.messages.filter(m => m.method === "interaction/request"); }
function resolveApproval(index: number, result: unknown, error?: unknown) {
  handleLine(JSON.stringify({ jsonrpc: "2.0", id: approvals()[index]!.id, result, ...(error === undefined ? {} : { error }) }));
}
function controlledTurn(controls: Record<string, unknown>) {
  return request("turn/start", { ...turnParams(), options: { ...options(), providerOptions: controls } });
}
function deltas(): any[] {
  return harness.messages.filter(m => m.method === "thread/delta").flatMap(m => (m.params as any).deltas);
}
function boundaries() { return deltas().filter(d => d.kind === "turn.boundary"); }
function answer(index: number, text = "synthetic result") {
  handleLine(JSON.stringify({ jsonrpc: "2.0", id: calls()[index]!.id, result: { success: true, contentItems: [{ type: "inputText", text }] } }));
}
function construction(policy: RuntimePermissionPolicy = FULL) {
  return { threadId, cwd: "C:/synthetic/workspace", instructionMode: "append", dynamicTools: [TOOL], options: options(policy) };
}
async function start(extra: Record<string, any> = {}) {
  const response = await request("thread/start", { ...construction(), ...extra });
  if (response.result) providerThreadId = response.result.providerThreadId;
  return response;
}
function turnParams(policy: RuntimePermissionPolicy = FULL) {
  return { threadId, providerThreadId, clientRequestId: "creq_aaaaaaaaaa", input: [{ type: "text", text: "Run synthetic tool" }], options: options(policy) };
}
async function turn(policy: RuntimePermissionPolicy = FULL) { return request("turn/start", turnParams(policy)); }

beforeEach(() => {
  harness = createHarness(handleLine);
  threadId = `permission-thread-${++sequence}`;
  providerThreadId = "";
  bodies = [];
  responses = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const response = responses.shift();
    if (!response) throw new Error("Missing scripted completion");
    return response;
  }));
});
afterEach(async () => {
  if (providerThreadId) await request("thread/stop", { threadId, providerThreadId, intent: "release", activeTurnId: null });
  harness.restore();
  vi.unstubAllGlobals();
});

describe("permission admission", () => {
  for (const policy of RESTRICTED) {
    const label = `${policy.permissionMode}/${policy.permissionEscalation}`;
    for (const input of [undefined, [{ type: "text", text: "Rejected input" }]]) {
      it(`rejects ${label} on start ${input ? "with input" : "without input"} before effects`, async () => {
        const response = await start({ options: options(policy), ...(input ? { input } : {}) });
        expect(response.error).toMatchObject({ code: -32602, message: expect.stringContaining(`permission mode "${policy.permissionMode}"`) });
        expect(deltas()).toEqual([]);
        expect(bodies).toEqual([]);
        expect(calls()).toEqual([]);
      });
    }
    it(`rejects ${label} on resume before replacing the session`, async () => {
      await start();
      const response = await request("thread/resume", { ...construction(policy), providerThreadId: "rejected-session" });
      expect(response.error?.code).toBe(-32602);
      responses.push(completion());
      await turn();
      await waitFor(() => boundaries().length === 1);
      expect(boundaries()[0].status).toBe("completed");
      expect(calls()).toHaveLength(0);
    });
    it(`rejects ${label} on turn start without retaining or acknowledging its input`, async () => {
      await start();
      const response = await turn(policy);
      expect(response.error?.code).toBe(-32602);
      expect(bodies).toEqual([]);
      expect(deltas().filter(d => d.kind === "input.accepted")).toEqual([]);
      responses.push(completion());
      await request("turn/start", { ...turnParams(), input: [{ type: "text", text: "Accepted input" }] });
      await waitFor(() => boundaries().length === 1);
      expect(JSON.stringify(bodies[0])).not.toContain("Run synthetic tool");
      expect(JSON.stringify(bodies[0])).toContain("Accepted input");
    });
    it(`rejects ${label} steer without cancelling the running call or queuing input`, async () => {
      responses.push(completion(TOOL.name), completion());
      await start();
      await turn();
      await waitFor(() => calls().length === 1);
      const response = await request("turn/steer", { ...turnParams(policy), expectedTurnId: "running", clientRequestId: "creq_bbbbbbbbbb" });
      expect(response.error?.code).toBe(-32602);
      expect(deltas().some(d => d.kind === "input.accepted" && d.clientRequestId === "creq_bbbbbbbbbb")).toBe(false);
      answer(0);
      await waitFor(() => boundaries().length === 1);
      expect(boundaries()[0].status).toBe("completed");
      expect(bodies).toHaveLength(2);
      expect(calls()).toHaveLength(1);
    });
  }
  it.each([
    {},
    { permissionMode: "auto", permissionScope: "full", approvalReviewer: "user", permissionEscalation: null },
  ])("rejects missing or contradictory policy fields: %j", async (policy) => {
    const response = await start({ options: { model: "synthetic/model", ...policy } });
    expect(response.error?.code).toBe(-32602);
    expect(deltas()).toEqual([]);
    expect(bodies).toEqual([]);
  });
});

describe("tool eligibility", () => {
  it("omits denied tools and returns a failed result if the model requests one anyway", async () => {
    responses.push(completion(TOOL.name), completion());
    await start({ disallowedTools: [TOOL.name] });
    await turn();
    await waitFor(() => boundaries().length === 1);
    expect(bodies[0]!.tools).toBeUndefined();
    expect(calls()).toHaveLength(0);
    expect(bodies[1]!.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", content: expect.stringContaining("is disallowed") }),
    ]));
    expect(deltas()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "item.close", status: "failed", item: expect.objectContaining({ error: expect.stringContaining("is disallowed") }) }),
    ]));
  });
  it("matches denials exactly and leaves permitted definitions and calls working", async () => {
    responses.push(completion(TOOL.name), completion());
    await start({ dynamicTools: [TOOL, { ...TOOL, name: "blocked" }], disallowedTools: ["blocked", "read_*"] });
    await turn();
    await waitFor(() => calls().length === 1);
    expect(bodies[0]!.tools.map((t: any) => t.function.name)).toEqual([TOOL.name]);
    for (const name of ["permissionMode", "permissionScope", "approvalReviewer", "permissionEscalation"]) expect(bodies[0]).not.toHaveProperty(name);
    answer(0);
    await waitFor(() => boundaries().length === 1);
    expect(boundaries()[0].status).toBe("completed");
  });
  it("blocks model attempts to call the internal history tool", async () => {
    responses.push(completion(HISTORY_TOOL_NAME), completion());
    await start({ dynamicTools: [HISTORY, TOOL] });
    await turn();
    await waitFor(() => boundaries().length === 1);
    expect(calls()).toHaveLength(0);
    expect(bodies[0]!.tools.map((t: any) => t.function.name)).toEqual([TOOL.name]);
    expect(bodies[1]!.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", content: expect.stringContaining("reserved for internal history restoration") }),
    ]));
  });
  it.each(["missing", "disallowed"])("fails resume without fetching when history retrieval is %s", async (state) => {
    providerThreadId = "resumed";
    await request("thread/resume", { ...construction(), providerThreadId, dynamicTools: state === "missing" ? [TOOL] : [HISTORY, TOOL], disallowedTools: state === "disallowed" ? [HISTORY_TOOL_NAME] : [] });
    await turn();
    await waitFor(() => boundaries().length === 1);
    expect(boundaries()[0].status).toBe("failed");
    expect(calls()).toHaveLength(0);
    expect(bodies).toHaveLength(0);
    expect(JSON.stringify(deltas())).toContain("history could not be loaded");
  });
  it("retains resume denials after successful internal restoration", async () => {
    responses.push(completion(TOOL.name), completion());
    providerThreadId = "resumed";
    await request("thread/resume", { ...construction(), providerThreadId, dynamicTools: [HISTORY, TOOL], disallowedTools: [TOOL.name] });
    await turn();
    await waitFor(() => calls().length === 1);
    expect((calls()[0]!.params as any).tool).toBe(HISTORY_TOOL_NAME);
    answer(0, JSON.stringify({ version: 1, threadId, throughSeq: 0, nextAfterSeq: null, events: [] }));
    await waitFor(() => boundaries().length === 1);
    expect(bodies[0]!.tools).toBeUndefined();
    expect(calls()).toHaveLength(1);
    expect(JSON.stringify(bodies[1]!.messages)).toContain("is disallowed");
  });
  it.each(["thread/start", "thread/resume"])("rejects duplicate tools on %s before replacing an active session", async (method) => {
    responses.push(completion(TOOL.name), completion());
    await start();
    await turn();
    await waitFor(() => calls().length === 1);
    const response = await request(method, { ...construction(), providerThreadId: "replacement", dynamicTools: [TOOL, TOOL] });
    expect(response.error).toMatchObject({ code: -32602, message: expect.stringContaining("Duplicate dynamic tool") });
    answer(0);
    await waitFor(() => boundaries().length === 1);
    expect(boundaries()[0].status).toBe("completed");
  });
  it("rejects duplicate internal history identities", async () => {
    const response = await start({ dynamicTools: [HISTORY, HISTORY] });
    expect(response.error?.code).toBe(-32602);
    expect(deltas()).toEqual([]);
  });
});

describe("provider tool controls", () => {
  it("carries saved denials through the public provider-options channel without a native denylist", async () => {
    const host = createFakePluginHost({ pluginId: "nanogpt-provider" });
    nanoGptPlugin(host.bb);
    await host.harness.behavior.callRpc("saveToolSettings", { disallowedTools: TOOL.name, confirmToolCalls: true });
    const settings = await host.harness.behavior.callRpc("getToolSettings", null) as { disallowedTools: string; confirmToolCalls: boolean };
    const provider = host.harness.registrations.providerRegistrations.find(p => p.id === "nano-gpt")!;
    const providerOptions = provider.deriveProviderOptions!({ threadId, projectId: "project", model: "synthetic/model", permissionMode: "full", settings });
    responses.push(completion(TOOL.name), completion());
    await start({ options: { ...options(), providerOptions } });
    await controlledTurn(providerOptions);
    await waitFor(() => boundaries().length === 1);
    expect(bodies[0]!.tools).toBeUndefined();
    expect(calls()).toHaveLength(0);
    expect(approvals()).toHaveLength(0);
  });
  it("applies a new settings snapshot on the next turn without weakening native session denials", async () => {
    responses.push(completion(TOOL.name), completion(), completion(TOOL.name), completion());
    await start();
    await controlledTurn({ disallowedTools: [TOOL.name] });
    await waitFor(() => boundaries().length === 1);
    expect(calls()).toHaveLength(0);
    await controlledTurn({ disallowedTools: [] });
    await waitFor(() => calls().length === 1);
    answer(0);
    await waitFor(() => boundaries().length === 2);
    responses.push(completion(TOOL.name), completion());
    await start({ disallowedTools: [TOOL.name] });
    await controlledTurn({ disallowedTools: [] });
    await waitFor(() => boundaries().length === 3);
    expect(calls()).toHaveLength(1);
  });
  it.each(["thread/start", "thread/resume", "turn/start", "turn/steer"])("rejects malformed controls at %s before changing state", async method => {
    await start();
    const before = harness.messages.length;
    const response = await request(method, { ...construction(), ...turnParams(), expectedTurnId: "running", options: { ...options(), providerOptions: { confirmToolCalls: "false" } } });
    expect(response.error?.code).toBe(-32602);
    expect(harness.messages.slice(before).filter(m => m.method)).toHaveLength(0);
    expect(bodies).toHaveLength(0);
  });
  it("does not bypass configured history denial to restore context", async () => {
    providerThreadId = "resumed";
    await request("thread/resume", { ...construction(), providerThreadId, dynamicTools: [HISTORY, TOOL] });
    await controlledTurn({ disallowedTools: [HISTORY_TOOL_NAME], confirmToolCalls: true });
    await waitFor(() => boundaries().length === 1);
    expect(boundaries()[0].status).toBe("failed");
    expect(bodies).toHaveLength(0);
    expect(calls()).toHaveLength(0);
    expect(approvals()).toHaveLength(0);
  });
});

describe("manual tool confirmation", () => {
  it("requires a one-time approval before dispatch and uses the public approval schema", async () => {
    responses.push(completion(TOOL.name), completion());
    await start();
    await controlledTurn({ confirmToolCalls: true });
    await waitFor(() => approvals().length === 1);
    expect(calls()).toHaveLength(0);
    const payload = (approvals()[0]!.params as any).payload;
    expect(payload.availableDecisions).toEqual(["allow_once", "deny"]);
    expect(approvalInteractionOutcomeSchema.safeParse({ payload, resolution: { decision: "allow_once", grantedPermissions: null } }).success).toBe(true);
    expect(payload.subject.presentation.detail).toContain("fixture");
    resolveApproval(0, { decision: "allow_once", grantedPermissions: null });
    await waitFor(() => calls().length === 1);
    resolveApproval(0, { decision: "allow_once", grantedPermissions: null });
    expect(calls()).toHaveLength(1);
    answer(0);
    await waitFor(() => boundaries().length === 1);
    expect(boundaries()[0].status).toBe("completed");
    expect(bodies[0]).not.toHaveProperty("confirmToolCalls");
  });
  it.each([
    { decision: "deny" }, { decision: "allow_for_session" }, { decision: "allow_once" },
    { decision: "allow_once", grantedPermissions: { fileSystem: null, network: { enabled: true } } }, {}, null,
    "allow_once", { success: true, contentItems: [] },
  ])("does not dispatch for a denied or invalid approval: %j", async resolution => {
    responses.push(completion(TOOL.name), completion());
    await start();
    await controlledTurn({ confirmToolCalls: true });
    await waitFor(() => approvals().length === 1);
    resolveApproval(0, resolution);
    await waitFor(() => boundaries().length === 1);
    expect(calls()).toHaveLength(0);
    expect(JSON.stringify(bodies[1]!.messages)).toContain("approval was denied");
  });
  it("fails closed when the approval service returns an error even beside an affirmative result", async () => {
    responses.push(completion(TOOL.name), completion());
    await start();
    await controlledTurn({ confirmToolCalls: true });
    await waitFor(() => approvals().length === 1);
    resolveApproval(0, { decision: "allow_once", grantedPermissions: null }, { code: -32601, message: "No interaction handler" });
    await waitFor(() => boundaries().length === 1);
    expect(calls()).toHaveLength(0);
  });
  it.each(["interrupt", "release", "replace"])("cancels pending approval on %s and ignores a late allow", async action => {
    responses.push(completion(TOOL.name), completion());
    await start();
    await controlledTurn({ confirmToolCalls: true });
    await waitFor(() => approvals().length === 1);
    if (action === "replace") await start();
    else await request("thread/stop", { threadId, providerThreadId, intent: action, activeTurnId: null });
    resolveApproval(0, { decision: "allow_once", grantedPermissions: null });
    if (action === "release") await start();
    await turn();
    await waitFor(() => boundaries().length === (action === "interrupt" ? 2 : 1));
    expect(calls()).toHaveLength(0);
    expect(approvals()).toHaveLength(1);
    if (action === "interrupt") expect(boundaries()[0].status).toBe("interrupted");
  });
  it.each(["undeclared", HISTORY_TOOL_NAME, "read_file"])("does not ask approval for an ineligible tool: %s", async name => {
    responses.push(completion(name), completion());
    await start({ dynamicTools: [TOOL, HISTORY], disallowedTools: name === TOOL.name ? [TOOL.name] : [] });
    await controlledTurn({ confirmToolCalls: true });
    await waitFor(() => boundaries().length === 1);
    expect(approvals()).toHaveLength(0);
    expect(calls()).toHaveLength(0);
  });
  it("redacts secret fields in the review and refuses an oversized review without executing", async () => {
    responses.push(completion(TOOL.name, { path: "fixture", nested: { apiKey: "never-display-this" }, password: "private-value" }), completion());
    await start();
    await controlledTurn({ confirmToolCalls: true });
    await waitFor(() => approvals().length === 1);
    const review = JSON.stringify((approvals()[0]!.params as any).payload.subject.presentation);
    expect(review).not.toContain("never-display-this");
    expect(review).not.toContain("private-value");
    expect(review).toContain("[redacted]");
    resolveApproval(0, { decision: "deny" });
    await waitFor(() => boundaries().length === 1);
    responses.push(completion(TOOL.name, { text: "x".repeat(12_001) }), completion());
    await controlledTurn({ confirmToolCalls: true });
    await waitFor(() => boundaries().length === 2);
    expect(approvals()).toHaveLength(1);
    expect(calls()).toHaveLength(0);
    expect(JSON.stringify(bodies[3]!.messages)).toContain("too large to review");
  });
  it("rejects arguments that fit the transport cap but exceed the SDK's 280-character approval detail limit", async () => {
    responses.push(completion(TOOL.name, { text: "x".repeat(300) }), completion());
    await start();
    await controlledTurn({ confirmToolCalls: true });
    await waitFor(() => boundaries().length === 1);
    expect(approvals()).toHaveLength(0);
    expect(calls()).toHaveLength(0);
    expect(JSON.stringify(bodies[1]!.messages)).toContain("approval presentation limit");
  });
  it("asks again for a second call, binding each approval to its own invocation", async () => {
    responses.push(completion(TOOL.name, { path: "first" }), completion(TOOL.name, { path: "second" }), completion());
    await start();
    await controlledTurn({ confirmToolCalls: true });
    await waitFor(() => approvals().length === 1);
    resolveApproval(0, { decision: "allow_once", grantedPermissions: null });
    await waitFor(() => calls().length === 1);
    answer(0);
    await waitFor(() => approvals().length === 2);
    expect(approvals()[0]!.id).not.toBe(approvals()[1]!.id);
    resolveApproval(0, { decision: "allow_once", grantedPermissions: null });
    expect(calls()).toHaveLength(1);
    expect((approvals()[1]!.params as any).payload.subject.presentation.detail).toContain("second");
    resolveApproval(1, { decision: "deny" });
    await waitFor(() => boundaries().length === 1);
    expect(calls()).toHaveLength(1);
  });
  it("keeps a queued turn's confirmation snapshot when a later turn disables confirmation", async () => {
    responses.push(completion(TOOL.name), completion(), completion(TOOL.name), completion(), completion());
    await start();
    await turn();
    await waitFor(() => calls().length === 1);
    await request("turn/steer", { ...turnParams(), expectedTurnId: "running", clientRequestId: "creq_bbbbbbbbbb", options: { ...options(), providerOptions: { confirmToolCalls: true } } });
    answer(0);
    await waitFor(() => approvals().length === 1);
    await request("turn/steer", { ...turnParams(), expectedTurnId: "running", clientRequestId: "creq_cccccccccc", options: { ...options(), providerOptions: { confirmToolCalls: false } } });
    expect(calls()).toHaveLength(1);
    resolveApproval(0, { decision: "deny" });
    await waitFor(() => boundaries().length === 3);
    expect(calls()).toHaveLength(1);
    expect(approvals()).toHaveLength(1);
  });
  it("restores internal history without prompting, then confirms only ordinary model calls", async () => {
    responses.push(completion(TOOL.name), completion());
    providerThreadId = "resumed";
    await request("thread/resume", { ...construction(), providerThreadId, dynamicTools: [HISTORY, TOOL] });
    await controlledTurn({ confirmToolCalls: true });
    await waitFor(() => calls().length === 1);
    expect(approvals()).toHaveLength(0);
    answer(0, JSON.stringify({ version: 1, threadId, throughSeq: 0, nextAfterSeq: null, events: [] }));
    await waitFor(() => approvals().length === 1);
    expect(calls()).toHaveLength(1);
    resolveApproval(0, { decision: "deny" });
    await waitFor(() => boundaries().length === 1);
    expect(calls()).toHaveLength(1);
  });
});

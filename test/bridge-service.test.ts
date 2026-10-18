import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BridgeService } from "../src/bridge/service.js";
import { CodexThreadUnavailableError } from "../src/codex/app-server-runner.js";
import { buildPrompt } from "../src/bridge/format.js";
import { defaultConfig, MAX_INBOUND_BYTES } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { encryptAesEcb } from "../src/weixin/media.js";
import { normalizeWeixinMessage } from "../src/weixin/messages.js";
import { WeixinApiError } from "../src/weixin/api.js";

test("accepts a bare approval command only from the requesting WeChat sender", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-approval-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const replies: Array<{ senderId: string; text: string }> = [];
  let approvalResult: boolean | undefined;
  const service = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice", "bob"] },
    stateStore: new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state"))),
    weixin: { async sendTyping() {}, async sendText(input: { toUserId: string; text: string }) {
      replies.push({ senderId: input.toUserId, text: input.text });
      return { messageId: "reply" };
    } } as never,
    runner: { async run(input: { onApproval: (request: { method: string; params: Record<string, unknown> }) => Promise<boolean> }) {
      approvalResult = await input.onApproval({ method: "item/commandExecution/requestApproval",
        params: { command: "touch approved", reason: "test" } });
      return { raw: "", text: "done", threadId: "thread" };
    }, async stop() {} } as never
  });
  const incoming = (senderId: string, text: string) => ({ id: crypto.randomUUID(), senderId, text, attachments: [], raw: {} });
  const turn = service.handleMessage(incoming("alice", "work"));
  for (let attempt = 0; attempt < 50 && !replies.length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.match(replies[0]?.text ?? "", /同意：\/approve\n不同意：\/reject/);
  assert.match(replies[0]?.text ?? "", /会一直等待你的回复/);
  assert.equal(replies[0].senderId, "alice");
  await service.handleMessage(incoming("bob", "/approve"));
  assert.equal(approvalResult, undefined);
  await service.handleMessage(incoming("alice", "/approve"));
  await turn;
  assert.equal(approvalResult, true);
});

test("shows one approval at a time and applies bare commands in order", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-approval-queue-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const replies: string[] = [];
  const decisions: boolean[] = [];
  const service = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice"] },
    stateStore: new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state"))),
    weixin: { async sendTyping() {}, async sendText(input: { text: string }) {
      replies.push(input.text);
      return { messageId: "reply" };
    } } as never,
    runner: { async run(input: { onApproval: (request: { method: string; params: Record<string, unknown> }) => Promise<boolean> }) {
      decisions.push(...await Promise.all([
        input.onApproval({ method: "item/commandExecution/requestApproval", params: { command: "first" } }),
        input.onApproval({ method: "item/commandExecution/requestApproval", params: { command: "second" } })
      ]));
      return { raw: "", text: "done", threadId: "thread" };
    }, async stop() {} } as never
  });
  const incoming = (id: string, text: string) => ({ id, senderId: "alice", text, attachments: [], raw: {} });
  const turn = service.handleMessage(incoming("turn", "work"));
  for (let attempt = 0; attempt < 50 && !replies.length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.match(replies[0] ?? "", /first/);
  assert.ok(!replies.some((reply) => reply.includes("second")));
  await service.handleMessage(incoming("approve", "/approve"));
  assert.ok(replies.some((reply) => reply.includes("second")));
  await service.handleMessage(incoming("reject", "/reject"));
  await turn;
  assert.deepEqual(decisions, [true, false]);
});

test("declines immediately when an approval prompt cannot be delivered", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-approval-fail-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  let approved: boolean | undefined;
  const service = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice"] },
    stateStore: new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state"))),
    weixin: { async sendTyping() {}, async sendText() {
      throw new WeixinApiError("stale context", "sendmessage", -2);
    } } as never,
    runner: { async run(input: { onApproval: (request: { method: string; params: Record<string, unknown> }) => Promise<boolean> }) {
      approved = await input.onApproval({ method: "item/fileChange/requestApproval", params: { reason: "write" } });
      return { raw: "", text: "done", threadId: "thread" };
    }, async stop() {} } as never
  });
  await service.handleMessage({ id: "turn", senderId: "alice", contextToken: "expired", text: "work", attachments: [], raw: {} });
  assert.equal(approved, false);
});

test("starts a fresh managed session when the saved Codex rollout cannot be resumed", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-missing-thread-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const original = store.createSession("alice", tmpDir, "Original");
  store.setThread("alice", "thread-missing");
  store.setModelOverride("alice", "test-model");
  const runs: Array<{ threadId?: string; prompt: string }> = [];
  const replies: string[] = [];
  const service = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice"] },
    stateStore: store,
    weixin: { async sendTyping() {}, async sendText(input: { text: string }) {
      replies.push(input.text);
      return { messageId: "reply" };
    } } as never,
    runner: { async run(input: { threadId?: string; prompt: string }) {
      runs.push({ threadId: input.threadId, prompt: input.prompt });
      if (input.threadId) throw new CodexThreadUnavailableError(input.threadId);
      return { raw: "", text: "finished", threadId: "thread-new" };
    }, async stop() {} } as never
  });
  await service.handleMessage({ id: "turn", senderId: "alice", text: "do work", attachments: [], raw: {} });
  assert.deepEqual(runs.map((run) => run.threadId), ["thread-missing", undefined]);
  assert.equal(runs[0].prompt, runs[1].prompt);
  assert.equal(store.listSessions().find((session) => session.id === original.id)?.threadId, "thread-missing");
  assert.equal(store.getActiveSession("alice")?.threadId, "thread-new");
  assert.equal(store.getActiveSession("alice")?.model, "test-model");
  assert.ok(replies.some((reply) => reply.includes("新建上下文")));
  assert.ok(replies.includes("finished"));
});

test("reports WeChat Codex turn status and resolves runtime details for status", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-status-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  const statuses: Array<{ senderId: string; sessionId: string; active: boolean }> = [];
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"],
      codexBackend: "auto"
    },
    stateStore,
    onTurnStatus: (status) => statuses.push(status),
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text-message" };
      }
    } as never,
    runner: {
      async run() {
        return { raw: "", text: "完成", threadId: "thread-status" };
      },
      async getRuntimeInfo() {
        return { model: "gpt-test", effort: "high" };
      },
      async stop() {}
    } as never
  });

  await service.handleMessage({
    id: "turn",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "开始",
    raw: {}
  });
  const sessionId = stateStore.getActiveSession("alice@im.wechat")?.id;
  assert.deepEqual(statuses, [
    { senderId: "alice@im.wechat", sessionId, active: true },
    { senderId: "alice@im.wechat", sessionId, active: false }
  ]);

  await service.handleMessage({
    id: "status",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "/status",
    raw: {}
  });
  assert.match(replies.at(-1) ?? "", /model: gpt-test/);
  assert.match(replies.at(-1) ?? "", /effort: high/);
});

test("sends local markdown images as native WeChat image messages", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-bridge-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const imagePath = path.join(tmpDir, "generated_image_latest.png");
  fs.writeFileSync(imagePath, Buffer.from("png image bytes"));
  const markdownPath = imagePath.replace(/\\/g, "/");

  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const config = {
    ...defaultConfig(tmpDir),
    allowedSenderIds: ["alice@im.wechat"],
    codexBackend: "exec" as const
  };
  const textReplies: string[] = [];
  const imageMessages: Array<Record<string, unknown>> = [];
  const weixin = {
    async sendTyping() {},
    async sendText(input: { text: string }) {
      textReplies.push(input.text);
      return { messageId: "text-message" };
    },
    async getUploadUrl() {
      return { uploadParam: "upload-token" };
    },
    async sendImageMessage(input: Record<string, unknown>) {
      imageMessages.push(input);
      return { messageId: "image-message" };
    },
    async sendFileMessage() {
      throw new Error("expected image message");
    }
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("", {
    status: 200,
    headers: { "x-encrypted-param": "download-param" }
  });
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const service = new BridgeService({
    config,
    stateStore,
    weixin,
    runner: {
      async run() {
        return {
          raw: "",
          text: [
            "找到了这张，来自下载目录：",
            "",
            `![generated_image_latest.png](${markdownPath})`,
            "",
            `如果图片没有直接显示，点这里打开：[generated_image_latest.png](${markdownPath})`
          ].join("\n")
        };
      },
      async stop() {}
    }
  });

  await service.handleMessage({
    id: "message-1",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "从电脑里面找一张图片发给我",
    raw: {}
  });

  assert.equal(imageMessages.length, 1);
  assert.equal(imageMessages[0].toUserId, "alice@im.wechat");
  assert.equal(imageMessages[0].contextToken, "ctx");
  assert.equal(imageMessages[0].encryptQueryParam, "download-param");
  assert.equal(textReplies.some((reply) => reply.includes("[codex-weixin] File send requested")), false);
  assert.equal(textReplies.some((reply) => reply.includes(markdownPath)), false);
  assert.equal(textReplies.join("\n").includes("如果图片没有直接显示"), false);
});

test("sends local markdown videos as native WeChat video messages", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-bridge-video-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const videoPath = path.join(tmpDir, "desktop-demo.mp4");
  fs.writeFileSync(videoPath, Buffer.from("mp4 video bytes"));
  const markdownPath = videoPath.replace(/\\/g, "/");

  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const config = {
    ...defaultConfig(tmpDir),
    allowedSenderIds: ["alice@im.wechat"],
    codexBackend: "exec" as const
  };
  const textReplies: string[] = [];
  const videoMessages: Array<Record<string, unknown>> = [];
  const weixin = {
    async sendTyping() {},
    async sendText(input: { text: string }) {
      textReplies.push(input.text);
      return { messageId: "text-message" };
    },
    async getUploadUrl() {
      return { uploadParam: "upload-token" };
    },
    async sendImageMessage() {
      throw new Error("expected video message");
    },
    async sendFileMessage() {
      throw new Error("expected video message");
    },
    async sendVideoMessage(input: Record<string, unknown>) {
      videoMessages.push(input);
      return { messageId: "video-message" };
    }
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("", {
    status: 200,
    headers: { "x-encrypted-param": "download-param" }
  });
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const service = new BridgeService({
    config,
    stateStore,
    weixin,
    runner: {
      async run() {
        return {
          raw: "",
          text: `Random desktop video: [desktop-demo.mp4](${markdownPath})`
        };
      },
      async stop() {}
    }
  });

  await service.handleMessage({
    id: "message-1",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "send me a random video from desktop",
    raw: {}
  });

  assert.equal(videoMessages.length, 1);
  assert.equal(videoMessages[0].toUserId, "alice@im.wechat");
  assert.equal(videoMessages[0].contextToken, "ctx");
  assert.equal(videoMessages[0].encryptQueryParam, "download-param");
  assert.equal(textReplies.some((reply) => reply.includes(markdownPath)), false);
});

test("buffers inbound image attachments and includes local paths in prompt done", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-buffer-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const key = crypto.randomBytes(16);
  const plaintext = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("inbound image bytes")
  ]);
  const ciphertext = encryptAesEcb(plaintext, key);
  const aesKeyBase64 = Buffer.from(key.toString("hex"), "utf8").toString("base64");

  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const config = {
    ...defaultConfig(tmpDir),
    allowedSenderIds: ["alice@im.wechat"],
    codexBackend: "exec" as const
  };
  const textReplies: string[] = [];
  let prompt = "";
  const service = new BridgeService({
    config,
    stateStore,
    inboundDir: path.join(tmpDir, "inbound"),
    mediaFetch: async () => new Response(new Uint8Array(ciphertext), { status: 200 }),
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        textReplies.push(input.text);
        return { messageId: "text-message" };
      },
      async getUploadUrl() {
        throw new Error("not used");
      },
      async sendImageMessage() {
        throw new Error("not used");
      },
      async sendFileMessage() {
        throw new Error("not used");
      }
    },
    runner: {
      async run(input: { prompt: string }) {
        prompt = input.prompt;
        return { raw: "", text: "done" };
      },
      async stop() {}
    }
  });

  await service.handleMessage({
    id: "start",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "/prompt start",
    raw: {}
  });

  const imageMessage = normalizeWeixinMessage({
    message_id: "img-1",
    from_user_id: "alice@im.wechat",
    context_token: "ctx",
    item_list: [{
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: "download-token",
          aes_key: aesKeyBase64
        }
      }
    }]
  });
  assert.ok(imageMessage);
  await service.handleMessage(imageMessage);

  await service.handleMessage({
    id: "text-1",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "描述这张图片",
    raw: {}
  });

  await service.handleMessage({
    id: "done",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "/prompt done",
    raw: {}
  });

  assert.match(prompt, /WeChat image: image\.png saved to /);
  assert.match(prompt, /描述这张图片/);
  const savedPath = prompt.match(/saved to ([^\]]+)/)?.[1];
  assert.ok(savedPath);
  assert.deepEqual(fs.readFileSync(savedPath), plaintext);
  assert.equal(textReplies.filter((reply) => reply === "Buffered. Send /prompt done when ready.").length, 2);
});

test("replies directly when a WeChat attachment exceeds 100 MiB", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-oversize-notice-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  let runnerCalled = false;
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"]
    },
    stateStore,
    mediaFetch: async () => new Response(null, {
      status: 200,
      headers: { "content-length": String(MAX_INBOUND_BYTES + 1) }
    }),
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text-message" };
      }
    } as never,
    runner: {
      async run() {
        runnerCalled = true;
        return { raw: "", text: "不应执行" };
      },
      async stop() {}
    } as never
  });

  const message = normalizeWeixinMessage({
    message_id: "video-large",
    from_user_id: "alice@im.wechat",
    context_token: "ctx",
    item_list: [{
      type: 5,
      video_item: {
        media: { full_url: "https://example.test/video" },
        video_size: MAX_INBOUND_BYTES + 1
      }
    }]
  });
  assert.ok(message);
  await service.handleMessage(message);

  assert.equal(runnerCalled, false);
  assert.deepEqual(replies, ["附件超过 100 MiB 上限，请压缩或裁剪后重新发送。"]);
});

test("lists resumable sessions with unambiguous R codes and switches by code", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-resume-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const first = stateStore.createSession("alice@im.wechat", "/work/one", "更新修复");
  stateStore.setThread("alice@im.wechat", "thread-one");
  stateStore.setSessionPromptPreview(first.id, "修复 macOS 自动更新");
  const second = stateStore.createSession("alice@im.wechat", "/work/two", "季度报告");
  stateStore.setThread("alice@im.wechat", "thread-two");
  const replies: string[] = [];
  const runs: Array<{ prompt: string; threadId?: string }> = [];
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"]
    },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: `text-${replies.length}` };
      }
    } as never,
    runner: {
      async getHistory(threadId: string) {
        assert.equal(threadId, "thread-two");
        return [{
          id: "history-user",
          role: "user" as const,
          text: buildPrompt("分析季度报告", [{
            kind: "file",
            label: "report.pdf",
            path: "/private/report.pdf"
          }])
        }];
      },
      async run(input: { prompt: string; threadId?: string }) {
        runs.push(input);
        return { raw: "", text: "继续完成", threadId: input.threadId };
      },
      async stop() {}
    } as never
  });
  const send = (id: string, text: string) => service.handleMessage({
    id,
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text,
    raw: {}
  });

  const listedSessions = stateStore.listSessions()
    .filter((session) => session.senderId === "alice@im.wechat");
  const firstNumber = listedSessions.findIndex((session) => session.id === first.id) + 1;
  const secondNumber = listedSessions.findIndex((session) => session.id === second.id) + 1;

  await send("resume-list", "/resume");
  const listReply = replies.at(-1) ?? "";
  assert.match(listReply, new RegExp(`\\[R${secondNumber}\\] 【当前】季度报告`));
  assert.match(listReply, /最近内容：分析季度报告 文件：report\.pdf/);
  assert.match(listReply, new RegExp(`\\[R${firstNumber}\\] 更新修复`));
  assert.match(listReply, /修复 macOS 自动更新/);
  assert.match(listReply, /R1 是切换编号，“会话 6”等是会话名称/);
  assert.doesNotMatch(listReply, /thread-one|thread-two|private\/report/);
  assert.equal(stateStore.getSession(second.id)?.lastPromptPreview, "分析季度报告 文件：report.pdf");

  await send("resume-bare-number", "/resume 2");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.id, second.id);
  assert.match(replies.at(-1) ?? "", /R 开头的切换编号/);

  await send("resume-invalid", "/resume R99");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.id, second.id);
  assert.match(replies.at(-1) ?? "", /没有这个切换编号/);

  await send("resume-first", `/resume r${firstNumber}`);
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.id, first.id);
  assert.match(replies.at(-1) ?? "", new RegExp(`已通过 R${firstNumber} 切换到：更新修复`));
  assert.doesNotMatch(replies.at(-1) ?? "", /thread-one/);

  await send("continued-turn", "继续处理");
  assert.equal(runs.at(-1)?.threadId, "thread-one");
});

test("lists and switches model and reasoning effort for the active WeChat session", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-model-command-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const paths = resolveStatePaths(path.join(tmpDir, "state"));
  const stateStore = new RuntimeStateStore(paths);
  const replies: string[] = [];
  const runs: Array<{ model?: string; effort?: string }> = [];
  const models = [{
    model: "gpt-default",
    displayName: "GPT Default",
    description: "Default model",
    isDefault: true,
    defaultEffort: "medium",
    supportedEfforts: [
      { effort: "low", description: "Low" },
      { effort: "medium", description: "Medium" }
    ]
  }, {
    model: "gpt-fast",
    displayName: "GPT Fast",
    description: "Fast model",
    isDefault: false,
    defaultEffort: "low",
    supportedEfforts: [
      { effort: "low", description: "Low" },
      { effort: "high", description: "High" }
    ]
  }];
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"],
      model: "gpt-default",
      effort: "medium"
    },
    stateStore,
    listCodexModels: async () => models,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text-message" };
      }
    } as never,
    runner: {
      async run(input: { model?: string; effort?: string }) {
        runs.push(input);
        return { raw: "", text: "done", threadId: "thread-model" };
      },
      async getRuntimeInfo() {
        return { model: "runtime-model", effort: "low" };
      },
      async stop() {}
    } as never
  });
  const send = async (id: string, text: string) => service.handleMessage({
    id,
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text,
    raw: {}
  });

  await send("model-list", "/model");
  assert.match(replies.at(-1) ?? "", /2\. GPT Fast（gpt-fast）/);
  await send("model-switch", "/model 2");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.model, "gpt-fast");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.effort, "low");

  await send("effort-list", "/effort");
  assert.match(replies.at(-1) ?? "", /2\. 高（high）/);
  assert.doesNotMatch(replies.at(-1) ?? "", /medium/);
  await send("effort-switch", "/effort 2");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.effort, "high");
  await send("invalid-effort", "/effort ultra");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.effort, "high");

  await send("turn", "使用当前设置");
  assert.equal(runs.at(-1)?.model, "gpt-fast");
  assert.equal(runs.at(-1)?.effort, "high");
  await send("status", "/status");
  assert.match(replies.at(-1) ?? "", /model: gpt-fast/);
  assert.match(replies.at(-1) ?? "", /effort: high/);

  const overriddenSession = stateStore.getActiveSession("alice@im.wechat")?.id;
  await send("new", "/new");
  await send("new-turn", "新会话使用默认值");
  assert.equal(runs.at(-1)?.model, "gpt-default");
  assert.equal(runs.at(-1)?.effort, "medium");

  assert.ok(overriddenSession);
  stateStore.activateSession(overriddenSession);
  await send("model-default", "/model default");
  await send("effort-default", "/effort default");
  await send("default-turn", "恢复默认值");
  assert.equal(runs.at(-1)?.model, "gpt-default");
  assert.equal(runs.at(-1)?.effort, "medium");
  assert.equal(new RuntimeStateStore(paths).getSession(overriddenSession)?.model, undefined);
  assert.equal(new RuntimeStateStore(paths).getSession(overriddenSession)?.effort, undefined);
});

test("streams process progress but sends the final WeChat answer as one message", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-stream-command-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"],
      streamReplies: false
    },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text-message" };
      }
    } as never,
    runner: {
      async run(input: {
        onDelta?: (delta: string) => Promise<void>;
        onProgress?: (message: string) => Promise<void>;
      }) {
        assert.equal(input.onDelta, undefined);
        await input.onProgress?.("正在查询资料。");
        return {
          raw: "",
          threadId: "thread-stream",
          text: [
            "第一段。",
            "",
            "第二段。",
            "",
            "```codex-weixin-actions",
            '{"send":[]}',
            "```"
          ].join("\n")
        };
      },
      async getRuntimeInfo() {
        return {};
      },
      async stop() {}
    } as never
  });
  const send = (id: string, text: string) => service.handleMessage({
    id,
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text,
    raw: {}
  });

  await send("status-default", "/stream");
  assert.match(replies.at(-1) ?? "", /关闭.*继承全局/);
  await send("enable", "/stream on");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.streamReplies, true);
  await send("turn", "开始流式回复");
  assert.equal(replies.filter((reply) => reply === "【进度】正在查询资料。").length, 1);
  assert.equal(replies.filter((reply) => reply === "第一段。\n\n第二段。").length, 1);
  assert.equal(replies.filter((reply) => reply === "第一段。").length, 0);
  assert.equal(replies.some((reply) => reply.includes("codex-weixin-actions")), false);

  await send("inherit", "/stream default");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.streamReplies, undefined);
  await send("disable", "/stream off");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.streamReplies, false);
});

test("preserves the tail of a long final answer with bounded WeChat chunks", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-long-reply-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  const finalText = `${"长回答".repeat(700)}\n\n来源：arXiv 官方作者检索。`;
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"],
      streamReplies: true
    },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: `text-${replies.length}` };
      }
    } as never,
    runner: {
      async run(input: { onProgress?: (message: string) => Promise<void> }) {
        await input.onProgress?.("正在检索论文。");
        return { raw: "", threadId: "thread-long", text: finalText };
      },
      async getRuntimeInfo() {
        return {};
      },
      async stop() {}
    } as never
  });

  await service.handleMessage({
    id: "long",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "查询论文",
    raw: {}
  });

  assert.equal(replies[0], "【进度】正在检索论文。");
  const finalChunks = replies.slice(1);
  assert.equal(finalChunks.length, 2);
  assert.equal(finalChunks.every((chunk) => chunk.length <= 1_800), true);
  assert.equal(finalChunks.join(""), finalText);
  assert.match(finalChunks.at(-1) ?? "", /来源：arXiv 官方作者检索。$/);
});

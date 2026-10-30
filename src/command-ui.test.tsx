// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { overmindSettings } from "../shared/settings.js";
import type { PluginClientContext, PluginScreenContribution } from "@getpaseo/plugin/client";

const api = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  status: vi.fn(),
  sync: vi.fn(),
  testJev: vi.fn(),
  testEmbedding: vi.fn(),
  embeddingModels: vi.fn(),
  history: vi.fn(),
  review: vi.fn(),
  seatLabels: vi.fn(),
  listAvailable: vi.fn(),
  listModels: vi.fn(),
  listModes: vi.fn(),
  list: vi.fn(),
  observeEvents: vi.fn(),
  send: vi.fn(),
  subscribe: vi.fn(),
  ref: vi.fn(),
  refetch: vi.fn(),
  timelineSubscribe: vi.fn(),
  readImage: vi.fn(),
}));
vi.mock("@getpaseo/plugin/client", () => {
  const paseo = {
    providers: {
      listAvailable: api.listAvailable,
      listModels: api.listModels,
      listModes: api.listModes,
    },
    agents: { list: api.list, ref: api.ref },
    observeEvents: api.observeEvents,
  };
  const methods = {
    "control.status": api.status,
    "providers.sync": api.sync,
    "jev.test": api.testJev,
    "embedding.test": api.testEmbedding,
    "embedding.models": api.embeddingModels,
    "project.history": api.history,
    "task.review": api.review,
    "seat.labels": api.seatLabels,
    "chat.image": api.readImage,
  };
  return {
    usePaseo: () => paseo,
    useRpc: (contract) => {
      if (contract.name.endsWith(".read")) return api.read;
      if (contract.name.endsWith(".write")) return api.write;
      if (methods[contract.name]) return methods[contract.name];
      throw new Error(`Unmocked RPC: ${contract.name}`);
    },
  };
});
vi.mock("@getpaseo/plugin/client/ui", async () => {
  const React = await import("react");
  function Container({ children }) {
    return React.createElement("div", null, children);
  }
  function Section({ children, title }) {
    return React.createElement("section", null, React.createElement("h2", null, title), children);
  }
  function SettingsSelect({ label, value, options, onValueChange, disabled }) {
    React.useState(0);
    return React.createElement(
      "select",
      {
        "aria-label": label,
        value,
        disabled,
        onChange: (event) => onValueChange(event.target.value),
      },
      options.map((option) =>
        React.createElement("option", { key: option.value, value: option.value }, option.label),
      ),
    );
  }
  function SettingsInput({
    label,
    initialValue,
    onChangeText,
    secureTextEntry,
    disabled,
    placeholder,
  }) {
    const [text, setText] = React.useState(initialValue);
    return React.createElement("input", {
      "aria-label": label,
      type: secureTextEntry ? "password" : "text",
      value: text,
      disabled,
      placeholder,
      onChange: (event) => {
        setText(event.target.value);
        onChangeText(event.target.value);
      },
    });
  }
  function Modal({ title, open, children }) {
    return open
      ? React.createElement("div", { role: "dialog", "aria-label": title }, children)
      : null;
  }
  Modal.Content = Container;
  return {
    Icon: () => null,
    ScrollView: Container,
    SidebarRow: Container,
    SettingsSection: Section,
    SettingsCard: Container,
    SettingsSelect,
    SettingsInput,
    Modal,
    FlatList: ({ data, renderItem, keyExtractor, ListEmptyComponent }) =>
      React.createElement(
        "div",
        null,
        data.length
          ? data.map((item, index) =>
              React.createElement(
                React.Fragment,
                { key: keyExtractor(item) },
                renderItem({ item, index }),
              ),
            )
          : React.createElement(ListEmptyComponent),
      ),
    TextInput: ({ value, defaultValue, onChangeText, placeholder, accessibilityLabel, editable }) =>
      React.createElement("textarea", {
        "aria-label": accessibilityLabel,
        value,
        defaultValue,
        placeholder,
        disabled: editable === false,
        onChange: (event) => onChangeText(event.target.value),
      }),
    SettingsRow: ({ label, hint }) => React.createElement("div", null, label, hint),
    SettingsSwitch: ({ label, value, disabled, onValueChange }) =>
      React.createElement("input", {
        type: "checkbox",
        role: "switch",
        "aria-label": label,
        checked: value,
        disabled,
        onChange: (event) => onValueChange(event.target.checked),
      }),
    SettingsAction: ({ label, actionLabel, onPress, disabled, hint }) =>
      React.createElement(
        "div",
        null,
        hint,
        React.createElement(
          "button",
          {
            type: "button",
            "aria-label": label,
            disabled,
            onClick: onPress,
          },
          actionLabel,
        ),
      ),
  };
});
import contribute from "../index.client.js";

const theme = { colors: new Proxy({}, { get: () => "#666666" }) };
const props = {
  theme,
  host: { id: "host", label: "Test host" },
  layout: { compact: false, platform: "web" },
  params: {},
};
afterEach(cleanup);

function setup() {
  vi.resetAllMocks();
  api.read.mockResolvedValue({
    status: "ready",
    revision: "r1",
    values: overmindSettings.schema.parse({}),
  });
  api.write.mockImplementation(async (input) => ({
    status: "saved",
    revision: "r2",
    values: input.values,
  }));
  api.status.mockResolvedValue({
    profiles: [],
    mode: "hybrid",
    embeddingModel: "MiniLM int8 CPU",
    builtinModel: { status: "ready", progress: 100, error: null },
    jevEnabled: false,
    lastCheckedAt: null,
    lastError: null,
    alerts: [],
  });
  api.sync.mockResolvedValue({ profiles: [] });
  api.testJev.mockResolvedValue({
    ok: true,
    message: "JEV probe passed",
    model: "jev-1.14.0",
    latencyMs: 20,
    models: ["jev-1.14.0"],
  });
  api.testEmbedding.mockResolvedValue({
    ok: true,
    message: "Embedding probe passed",
    dimensions: 384,
    models: [],
  });
  api.embeddingModels.mockResolvedValue({ models: ["all-minilm:latest", "qwen3-embedding:0.6b"] });
  api.listAvailable.mockResolvedValue({
    providers: [
      { provider: "opencode", available: true },
      { provider: "antigravity", available: true },
      { provider: "overmind-supervisor", available: true },
    ],
  });
  api.listModels.mockResolvedValue({
    models: [
      { id: "test-model", label: "Test model", thinkingOptions: [{ id: "high", label: "High" }] },
    ],
  });
  api.list.mockResolvedValue({ entries: [] });
  api.history.mockResolvedValue({ projects: [], errors: [] });
  api.seatLabels.mockResolvedValue({ seats: {} });
  api.listModes.mockResolvedValue({ modes: [] });
  api.subscribe.mockReturnValue(() => {});
  api.refetch.mockResolvedValue({ entries: [], error: null });
  api.timelineSubscribe.mockReturnValue(() => {});
  api.ref.mockReturnValue({
    send: api.send,
    timeline: { refetch: api.refetch, subscribe: api.timelineSubscribe },
  });
  api.observeEvents.mockReturnValue({ subscribe: api.subscribe, release: async () => {} });
  const screens = new Map<string, PluginScreenContribution>();
  const client = {
    addScreen: vi.fn((entry) => {
      screens.set(entry.id, entry);
      return () => {};
    }),
    addSidebarHeaderItem: vi.fn(() => () => {}),
    addSettingsScreen: vi.fn(() => () => {}),
    addSlashCommand: vi.fn(() => () => {}),
    addTimelineRenderer: vi.fn(() => () => {}),
    openScreen: vi.fn(),
  };
  contribute(client as unknown as PluginClientContext);
  return { client, screens };
}

async function readyOverview(screens: Map<string, PluginScreenContribution>) {
  render(createElement(screens.get("setup")!.Component, props));
  await screen.findByText("Overmind Settings");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Scout · Provider" }).hasAttribute("disabled")).toBe(
      false,
    ),
  );
}
async function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole("button", { name: label }));
  const dialog = await screen.findByRole("dialog", { name: label });
  fireEvent.click(within(dialog).getByRole("button", { name: option }));
}

describe("Overmind Command and settings", () => {
  test("shows Supervisor's scope-change request with evidence for the Human", async () => {
    const { screens } = setup();
    const at = "2026-10-26T04:00:00.000Z";
    api.list.mockResolvedValueOnce({
      entries: [
        {
          agent: {
            id: "lead",
            title: "Project handback",
            provider: "overmind-lead",
            status: "idle",
            lastUserMessageAt: at,
            labels: {
              "overmind.turn.id": "t1",
              "overmind.turn.outcome": "completed",
              "overmind.turn.message_at": at,
              "overmind.review.turn_id": "t1",
              "overmind.review.message_at": at,
              "overmind.review.decision": "needs_human",
              "overmind.review.reviewer_kind": "supervisor",
              "overmind.review.requested_change": "Change the API contract",
              "overmind.review.evidence": "Current contract cannot satisfy the requirement",
            },
          },
        },
      ],
    });
    render(createElement(screens.get("command")!.Component, props));
    expect(await screen.findByText("Người đánh giá: Supervisor")).toBeTruthy();
    expect(
      screen.getByText(/Chờ human quyết định thay đổi ngoài phạm vi đã thống nhất/).textContent,
    ).toContain("Change the API contract");
    expect(screen.getByText(/Lý do:/).textContent).toContain(
      "Current contract cannot satisfy the requirement",
    );
    expect(screen.getByText("WAITING FOR HUMAN")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept task Project handback" })).toBeTruthy();
    expect(api.review).not.toHaveBeenCalled();
  });
  test("reads turn state from the plugin's seat labels", async () => {
    const { screens } = setup();
    api.list.mockResolvedValueOnce({
      entries: [
        {
          agent: {
            id: "validation",
            title: "Validation seat",
            provider: "overmind-peer",
            model: "model",
            status: "idle",
            lastUserMessageAt: null,
            labels: {},
          },
        },
      ],
    });
    api.seatLabels.mockResolvedValue({
      seats: {
        validation: {
          "overmind.task.status": "READY_FOR_REVIEW",
          "overmind.turn.id": "t1",
          "overmind.turn.outcome": "completed",
        },
      },
    });
    render(createElement(screens.get("command")!.Component, props));
    expect(await screen.findByRole("button", { name: "Accept task Validation seat" })).toBeTruthy();
    expect(api.seatLabels).toHaveBeenCalledWith({ agentIds: ["validation"] });
  });

  test("shows the selected seat's live chat and what it is waiting on", async () => {
    const { screens } = setup();
    const entry = (seqStart: number, item: object) => ({ seqStart, item });
    api.list.mockResolvedValueOnce({
      entries: [
        {
          agent: {
            id: "lead",
            title: "Turing - Lead - Cảnh khu vườn",
            provider: "overmind-lead",
            model: "m",
            status: "idle",
            labels: {},
          },
        },
        {
          agent: {
            id: "peer",
            title: "Curie - Peer - Vẽ cây",
            provider: "overmind-peer",
            model: "m",
            status: "running",
            labels: { "paseo.parent-agent-id": "lead" },
          },
        },
      ],
    });
    render(createElement(screens.get("command")!.Component, props));
    // The working Peer is followed until the owner picks a seat.
    await screen.findByText("Việc: Vẽ cây");
    api.readImage.mockResolvedValue({ dataUri: "data:image/png;base64,iVBORw0KGgo=" });
    api.refetch.mockResolvedValueOnce({
      error: null,
      hasOlder: true,
      startCursor: { epoch: "e1", seq: 1 },
      entries: [
        entry(1, {
          type: "user_message",
          text: '<paseo-system version="1" kind="agent-message" source-agent-title="Sup">\nVẽ khu vườn\n</paseo-system>',
        }),
        entry(2, {
          type: "tool_call",
          name: "shell",
          status: "completed",
          error: null,
          detail: { type: "shell", command: "npm test" },
        }),
        entry(3, {
          type: "assistant_message",
          text: "Đã giao cho **Curie**.\n\n![Cây C](file:///C:/Art/C.png)",
        }),
      ],
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Open lead agent Turing - Lead - Cảnh khu vườn" }),
    );
    expect(await screen.findByText("Curie")).toBeTruthy();
    // A host image in the agent's Markdown is read through the plugin and shown inline.
    expect(await screen.findByLabelText("Cây C")).toBeTruthy();
    expect(api.readImage).toHaveBeenCalledWith({ path: "file:///C:/Art/C.png" });
    expect(screen.getByText("npm test")).toBeTruthy();
    expect(screen.getByText("Vẽ khu vườn")).toBeTruthy();
    expect(screen.getByText("Sup")).toBeTruthy();
    expect(screen.getByText("Việc: Cảnh khu vườn")).toBeTruthy();
    expect(screen.getByText("Đang chờ Curie báo cáo.")).toBeTruthy();
    expect(api.ref).toHaveBeenLastCalledWith("lead");
    api.refetch.mockResolvedValueOnce({
      error: null,
      hasOlder: false,
      startCursor: null,
      entries: [entry(0, { type: "assistant_message", text: "Tin cũ nhất." })],
    });
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    expect(await screen.findByText("Tin cũ nhất.")).toBeTruthy();
    expect(api.refetch).toHaveBeenLastCalledWith({
      direction: "before",
      cursor: { epoch: "e1", seq: 1 },
      limit: 80,
    });
    expect(screen.queryByRole("button", { name: "Load older messages" })).toBeNull();
    // A live event refetches the tail once per burst.
    api.refetch.mockResolvedValueOnce({
      error: null,
      entries: [entry(4, { type: "assistant_message", text: "Curie đã xong." })],
    });
    const live = api.timelineSubscribe.mock.lastCall![0];
    act(() => {
      live({ agentId: "lead" });
      live({ agentId: "lead" });
    });
    expect(await screen.findByText("Curie đã xong.")).toBeTruthy();
  });

  test("keeps an idle Supervisor and a Lead waiting on its Peer out of review", async () => {
    const { screens } = setup();
    const done = { "overmind.turn.id": "t1", "overmind.turn.outcome": "completed" };
    const seat = (id: string, provider: string, status: string, labels = {}) => ({
      agent: { id, title: id, provider, model: "m", status, lastUserMessageAt: null, labels },
    });
    api.list.mockResolvedValueOnce({
      entries: [
        seat("Sup", "overmind-supervisor", "idle", done),
        seat("Lead", "overmind-lead", "idle", { ...done, "paseo.parent-agent-id": "Sup" }),
        seat("Peer", "overmind-peer", "running", { "paseo.parent-agent-id": "Lead" }),
        seat("Done Peer", "overmind-peer-scout", "idle", {
          ...done,
          "paseo.parent-agent-id": "Lead",
        }),
      ],
    });
    render(createElement(screens.get("command")!.Component, props));
    expect(await screen.findByRole("button", { name: "Accept task Done Peer" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept task Lead" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Accept task Sup" })).toBeNull();
  });

  test("requires visible review evidence and preserves a failed review until retry succeeds", async () => {
    const { screens } = setup();
    const at = "2026-10-26T04:00:00.000Z";
    api.list.mockResolvedValueOnce({
      entries: [
        {
          agent: {
            id: "validation",
            title: "Validation seat",
            provider: "overmind-peer",
            model: "model",
            status: "idle",
            lastUserMessageAt: at,
            labels: {
              "overmind.task.status": "DONE",
              "overmind.turn.id": "t1",
              "overmind.turn.outcome": "completed",
              "overmind.turn.message_at": at,
            },
          },
        },
      ],
    });
    api.review.mockRejectedValueOnce(new Error("Review save failed; retry")).mockResolvedValueOnce({
      agentId: "validation",
      labels: {
        "overmind.review.turn_id": "t1",
        "overmind.review.message_at": at,
        "overmind.review.decision": "accepted",
        "overmind.review.evidence": "API and regression checks passed",
      },
    });
    render(createElement(screens.get("command")!.Component, props));
    const evidence = await screen.findByRole("textbox", {
      name: "Review evidence for Validation seat",
    });
    fireEvent.click(screen.getByRole("button", { name: "Accept task Validation seat" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Nhập bằng chứng");
    expect(api.review).not.toHaveBeenCalled();
    fireEvent.change(evidence, { target: { value: "API and regression checks passed" } });
    fireEvent.click(screen.getByRole("button", { name: "Accept task Validation seat" }));
    expect(await screen.findByText("Review save failed; retry")).toBeTruthy();
    expect((evidence as HTMLTextAreaElement).value).toBe("API and regression checks passed");
    fireEvent.click(screen.getByRole("button", { name: "Accept task Validation seat" }));
    expect(
      await screen.findByText("Đã nghiệm thu · API and regression checks passed"),
    ).toBeTruthy();
    expect(api.review).toHaveBeenLastCalledWith({
      agentId: "validation",
      turnId: "t1",
      decision: "accepted",
      evidence: "API and regression checks passed",
    });
  });
  test("opens one settings overview from the header", async () => {
    const { client, screens } = setup();
    render(createElement(screens.get("command")!.Component, props));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(client.openScreen).toHaveBeenCalledWith({ screenId: "setup" });
    expect(screen.queryByRole("button", { name: "Tạo S-L-P provider" })).toBeNull();
    await screen.findByText(/Chưa có agent Overmind/);
    cleanup();
    await readyOverview(screens);
    for (const title of [
      "Overmind Supervisor",
      "Overmind Lead",
      "Overmind Peer",
      "Scout",
      "Preview provider",
      "JEV · Typesafe",
    ])
      expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    expect(screen.getByText(/MiniLM int8 CPU/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "← Overmind Command" }));
    expect(client.openScreen).toHaveBeenLastCalledWith({ screenId: "command" });
  });

  test("selects Antigravity for Scout and Preview, then saves and publishes profiles", async () => {
    const { screens } = setup();
    await readyOverview(screens);
    for (const slot of ["Scout", "Preview provider"]) {
      await choose(`${slot} · Provider`, "antigravity");
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: `${slot} · Model` }).hasAttribute("disabled"),
        ).toBe(false),
      );
      await choose(`${slot} · Model`, "Test modeltest-model");
      fireEvent.change(screen.getByRole("combobox", { name: `${slot} · Thinking` }), {
        target: { value: "high" },
      });
    }
    fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình Overmind" }));
    await screen.findByText(/Đã lưu cấu hình\. Xem trạng thái/);
    for (const slot of ["scout", "preview"])
      expect(api.write.mock.lastCall?.[0].values[slot]).toEqual({
        provider: "antigravity",
        model: "test-model",
        thinkingOptionId: "high",
        modeId: "",
      });
    expect(api.sync).toHaveBeenCalledWith({});
    // Re-registering reports its outcome next to the button.
    const profile = { id: "overmind-supervisor", label: "Overmind Supervisor" };
    api.sync.mockResolvedValueOnce({
      profiles: [{ ...profile, role: "supervisor", status: "ready", error: null }],
    });
    fireEvent.click(screen.getByRole("button", { name: /Đăng ký lại/ }));
    await screen.findByText("Đã đăng ký: Overmind Supervisor.");
    api.sync.mockResolvedValueOnce({
      profiles: [{ ...profile, role: "supervisor", status: "error", error: "Model gone" }],
    });
    fireEvent.click(screen.getByRole("button", { name: /Đăng ký lại/ }));
    await screen.findByText("Chưa đăng ký được Overmind Supervisor: Model gone");
  });

  test("searches a long OpenCode catalog and reaches its final model", async () => {
    const { screens } = setup();
    api.listModels.mockResolvedValue({
      models: Array.from({ length: 180 }, (_, index) => ({
        id: `model-${index}`,
        label: `Model ${index}`,
      })),
    });
    await readyOverview(screens);
    fireEvent.click(screen.getByRole("button", { name: "Overmind Lead · Provider" }));
    let dialog = await screen.findByRole("dialog", { name: "Overmind Lead · Provider" });
    expect(within(dialog).queryByRole("button", { name: "overmind-supervisor" })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Tìm kiếm"), { target: { value: "open" } });
    expect(within(dialog).queryByRole("button", { name: "antigravity" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "opencode" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Overmind Lead · Model" }).hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Overmind Lead · Model" }));
    dialog = await screen.findByRole("dialog", { name: "Overmind Lead · Model" });
    fireEvent.change(within(dialog).getByLabelText("Tìm kiếm"), { target: { value: "model-179" } });
    expect(within(dialog).queryByRole("button", { name: "Model 0model-0" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Model 179model-179" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình Overmind" }));
    await waitFor(() => expect(api.write).toHaveBeenCalled());
    expect(api.write.mock.lastCall?.[0].values.lead).toMatchObject({
      provider: "opencode",
      model: "model-179",
    });
  });

  test("masks the JEV key and tests the draft before saving it", async () => {
    const { screens } = setup();
    await readyOverview(screens);
    const key = screen.getByLabelText("JEV API key");
    expect(key.getAttribute("type")).toBe("password");
    fireEvent.change(key, { target: { value: "local-test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Test kết nối JEV" }));
    await screen.findByText(/JEV probe passed/);
    expect(api.testJev).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "local-test-key", enabled: false, model: "jev-latest" }),
    );
    expect(api.write).not.toHaveBeenCalled();
    await choose("JEV model", "jev-1.14.0");
    fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình Overmind" }));
    await waitFor(() => expect(api.write).toHaveBeenCalled());
    expect(api.write.mock.lastCall?.[0].values.jev.model).toBe("jev-1.14.0");
  });

  test("lists installed Ollama models and verifies the selected embedding model", async () => {
    const { screens } = setup();
    await readyOverview(screens);
    fireEvent.change(screen.getByRole("combobox", { name: "Embedding" }), {
      target: { value: "ollama" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Model Ollama có trên host" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Ollama model" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    expect(api.embeddingModels).toHaveBeenCalledWith({ baseUrl: "http://127.0.0.1:11434" });
    await choose("Ollama model", "qwen3-embedding:0.6b");
    fireEvent.click(screen.getByRole("button", { name: "Kiểm tra embedding" }));
    await screen.findByText(/Embedding probe passed/);
    expect(api.testEmbedding).toHaveBeenCalledWith({
      backend: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3-embedding:0.6b",
    });
    expect(api.write).not.toHaveBeenCalled();
  });

  test("filters ordinary agents and attention, accepts provider aliases, and intervenes only on the selected agent", async () => {
    const { screens } = setup();
    api.list.mockResolvedValueOnce({
      entries: [
        {
          agent: {
            id: "overmind",
            title: "My Lead",
            provider: "test",
            model: "model",
            status: "idle",
            labels: { "overmind.role": "lead" },
          },
        },
        {
          agent: {
            id: "alias",
            title: "Alias Supervisor",
            provider: "overmind-supervisor",
            model: "model",
            status: "idle",
            labels: {},
          },
        },
        {
          agent: {
            id: "ordinary",
            title: "Ordinary agent",
            provider: "test",
            model: "model",
            status: "idle",
            labels: {},
          },
        },
      ],
    });
    render(createElement(screens.get("command")!.Component, props));
    await screen.findByRole("button", { name: "Open lead agent My Lead" });
    expect(
      screen.getByRole("button", { name: "Open supervisor agent Alias Supervisor" }),
    ).toBeTruthy();
    expect(screen.queryByText("Ordinary agent")).toBeNull();
    const observer = api.subscribe.mock.lastCall![0];
    act(() =>
      observer.update({
        type: "agent_attention_required",
        payload: {
          agentId: "ordinary",
          timestamp: "2026-10-24T12:00:00Z",
          reason: "ordinary-reason",
        },
      }),
    );
    expect(screen.queryByText(/ordinary-reason/)).toBeNull();
    act(() =>
      observer.update({
        type: "agent_attention_required",
        payload: {
          agentId: "overmind",
          timestamp: "2026-10-24T12:00:00Z",
          reason: "overmind-reason",
        },
      }),
    );
    expect(screen.getByText(/overmind-reason/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open lead agent My Lead" }));
    fireEvent.change(screen.getByPlaceholderText("Gửi chỉ dẫn hoặc yêu cầu kiểm tra trực tiếp…"), {
      target: { value: "Kiểm tra thay đổi" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Send intervention to selected Overmind agent" }),
    );
    await waitFor(() => expect(api.send).toHaveBeenCalledWith("Kiểm tra thay đổi"));
    expect(api.ref).toHaveBeenCalledWith("overmind");
  });

  test("shows live seats, archived project tasks and the project notebook", async () => {
    const { screens } = setup();
    api.list.mockResolvedValueOnce({
      entries: [
        {
          agent: {
            id: "lead-1",
            title: "Lead seat",
            provider: "overmind-lead",
            model: "model",
            status: "running",
            workspaceId: "ws-1",
            labels: { "overmind.task.status": "IN_PROGRESS" },
          },
        },
      ],
    });
    api.history.mockResolvedValue({
      projects: [
        {
          name: "Paseo",
          rootPath: "/repo",
          tasks: [
            {
              agentId: "peer-old",
              title: "Ada - Peer - Vẽ sơ đồ",
              provider: "overmind-peer",
              model: "model",
              status: "closed",
              workspaceId: "ws-old",
              lastUserMessageAt: null,
              labels: { "overmind.task.status": "READY_FOR_REVIEW" },
              updatedAt: "2026-10-24T12:00:00Z",
              archivedAt: "2026-10-24T12:00:00Z",
            },
          ],
          notebook: [
            {
              id: "entry-1",
              timestamp: "2026-10-24T12:00:00Z",
              workspaceId: "ws-1",
              observation: "Repeated waiting without new evidence",
              suspectedMechanism: "Quota exhaustion",
              impact: "Progress blocked",
              recommendation: "Verify provider availability",
              antiPattern: "hold-on",
              protocolCandidate: true,
              evidenceCount: 3,
            },
          ],
        },
      ],
      errors: [],
    });
    render(createElement(screens.get("command")!.Component, props));
    // The task card is derived from the seat itself, not from task labels.
    expect(await screen.findByText("LEAD · model")).toBeTruthy();
    expect(await screen.findByText("Repeated waiting without new evidence")).toBeTruthy();
    expect(screen.getByText("Protocol candidate")).toBeTruthy();
    // The archived Peer's task stays on the board, read back from its project.
    expect(screen.getByText("PEER · model")).toBeTruthy();
    expect(screen.getByText("Đã archive · Paseo")).toBeTruthy();
  });
});

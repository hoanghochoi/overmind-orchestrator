/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop, eslint-plugin-react-perf/jsx-no-new-function-as-prop -- settings controls compose theme styles and model commands. */
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { settingsRpc } from "@getpaseo/plugin";
import {
  FlatList,
  Modal,
  ScrollView,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  TextInput,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import {
  controlStatus,
  embeddingModels,
  syncProviders,
  testEmbedding,
  testJev,
  type ProfileStatus,
} from "../../shared/control.js";
import { DEFAULT_REGEX_RULES } from "../../shared/detection.js";
import { overmindSettings } from "../../shared/settings.js";
import {
  isModeSlot,
  openSetupForm,
  PROVIDER_SLOTS,
  slotValue,
  type ModeSlot,
  type ProviderSlot,
  type SetupModel,
} from "../setup-model.js";

interface SetupProps extends PluginSurfaceProps {
  onBack?: () => void;
}
type Theme = PluginSurfaceProps["theme"];
type ReadyState = Extract<ReturnType<SetupModel["getState"]>, { status: "ready" }>;
const rpc = settingsRpc(overmindSettings.id);
const SLOT_LABELS = {
  supervisor: "Overmind Supervisor",
  lead: "Overmind Lead",
  peer: "Overmind Peer",
  scout: "Scout",
  preview: "Preview provider",
};
const MODE_OPTIONS = [
  { label: "Regex + ngữ nghĩa", value: "hybrid" },
  { label: "Chỉ regex", value: "regex" },
  { label: "Chỉ ngữ nghĩa", value: "semantic" },
  { label: "Tắt", value: "off" },
];
const BACKEND_OPTIONS = [
  { label: "MiniLM tích hợp (CPU)", value: "builtin" },
  { label: "Ollama trên host", value: "ollama" },
];

export function OvermindSettingsView(props: SetupProps) {
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: props.theme.colors.surface0 }}
      contentContainerStyle={{ padding: props.layout.compact ? 16 : 24 }}
    >
      <View style={{ gap: 20, maxWidth: 900, width: "100%", alignSelf: "center" }}>
        {props.onBack ? (
          <Pressable accessibilityRole="button" onPress={props.onBack} style={{ padding: 10 }}>
            <Text style={{ color: props.theme.colors.foreground }}>← Overmind Command</Text>
          </Pressable>
        ) : null}
        <OvermindSettingsForm key={props.host.id} theme={props.theme} />
      </View>
    </ScrollView>
  );
}
function useSetupForm() {
  const paseo = usePaseo();
  const read = useRpc(rpc.read);
  const write = useRpc(rpc.write);
  const sync = useRpc(syncProviders);
  const status = useRpc(controlStatus);
  const jevTest = useRpc(testJev);
  const embeddingTest = useRpc(testEmbedding);
  const models = useRpc(embeddingModels);
  const [model] = useState(() =>
    openSetupForm({
      read: () => read({}),
      write,
      providers: paseo.providers,
      syncProviders: sync,
      status,
      testJev: jevTest,
      testEmbedding: embeddingTest,
      embeddingModels: models,
    }),
  );
  useEffect(() => {
    void model.load();
    const timer = setInterval(() => void model.refreshStatus(), 3000);
    return () => {
      clearInterval(timer);
      model.close();
    };
  }, [model]);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  return { model, state };
}

export function OvermindSettingsForm({ theme }: { theme: Theme }) {
  const { model, state } = useSetupForm();
  if (state.status !== "ready")
    return (
      <SettingsCard>
        <SettingsAction
          label={state.status === "error" ? "Không đọc được cấu hình" : "Đang tải cấu hình…"}
          hint={state.status === "error" ? state.error : undefined}
          actionLabel="Thử lại"
          disabled={state.status === "loading"}
          onPress={() => void model.load()}
        />
      </SettingsCard>
    );
  return (
    <View style={{ gap: 20 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: "600" }}>
        Overmind Settings
      </Text>
      <OverviewSection state={state} theme={theme} />
      <ProvidersSection state={state} model={model} theme={theme} />
      <DetectorSection state={state} model={model} theme={theme} />
      <JevSection state={state} model={model} theme={theme} />
      <SettingsCard>
        <SettingsAction
          label="Lưu cấu hình Overmind"
          actionLabel={state.saving ? "Đang lưu…" : "Lưu cấu hình"}
          disabled={state.saving || !state.dirty || state.syncingProfiles}
          onPress={() => void model.save()}
        />
        {state.error ? <Feedback theme={theme} error text={state.error} /> : null}
        {state.error ? (
          <SettingsAction
            label="Đọc lại bản đã lưu (bỏ thay đổi đang nhập)"
            actionLabel="Đọc lại"
            disabled={state.saving}
            onPress={() => void model.load()}
          />
        ) : null}
        {state.saved ? (
          <Feedback
            theme={theme}
            text="Đã lưu cấu hình. Xem trạng thái đăng ký tại từng provider ở trên."
          />
        ) : null}
      </SettingsCard>
    </View>
  );
}

function SlotEditor({
  slot,
  state,
  model,
  theme,
}: {
  slot: ProviderSlot;
  state: ReadyState;
  model: SetupModel;
  theme: Theme;
}) {
  const value = slotValue(state.values, slot);
  const catalog = state.catalogs[slot];
  const models = catalog?.status === "ready" ? catalog.models : [];
  const selected = models.find((entry) => entry.id === value.model);
  const thinking = selected?.thinkingOptions ?? [];
  const profile = state.profiles.find((entry) => entry.role === slot);
  const label = SLOT_LABELS[slot];
  return (
    <SettingsSection title={label}>
      <SettingsCard>
        <SettingsRow label="Đang chọn" hint={bindingDescription(value)} />
        {profile ? (
          <SettingsRow label="Provider trong Paseo" hint={profileDescription(profile)} />
        ) : null}
        <SearchableSelect
          label={`${label} · Provider`}
          value={value.provider}
          options={[
            { label: "Chưa cấu hình", value: "" },
            ...state.providers.map((provider) => ({ label: provider, value: provider })),
          ]}
          disabled={state.saving || state.providersLoading}
          onValueChange={(provider) => model.selectProvider(slot, provider)}
          theme={theme}
        />
        {value.provider ? (
          <SearchableSelect
            label={`${label} · Model`}
            value={value.model}
            options={models.map((entry) => ({ label: entry.label, value: entry.id }))}
            disabled={state.saving || catalog?.status !== "ready"}
            onValueChange={(modelId) => model.selectModel(slot, modelId)}
            theme={theme}
          />
        ) : null}
        {thinking.length || value.thinkingOptionId ? (
          <SettingsSelect
            label={`${label} · Thinking`}
            value={value.thinkingOptionId}
            options={[
              { label: "Mặc định provider", value: "" },
              ...thinking.map((entry) => ({ label: entry.label, value: entry.id })),
            ]}
            disabled={state.saving}
            onValueChange={(thinkingId) => model.selectThinking(slot, thinkingId)}
          />
        ) : null}
        {isModeSlot(slot) && value.provider ? (
          <PermissionSelect slot={slot} state={state} model={model} theme={theme} />
        ) : null}
        <CatalogFeedback slot={slot} state={state} model={model} theme={theme} />
      </SettingsCard>
    </SettingsSection>
  );
}
/** The provider's permission modes, applied when Overmind creates this seat. */
function PermissionSelect({ slot, state, model, theme }: FormSectionProps & { slot: ModeSlot }) {
  const modes = state.modes[slot];
  const options = modes?.status === "ready" ? modes.modes : [];
  const { modeId } = slotValue(state.values, slot);
  const selected = options.find((mode) => mode.id === modeId);
  return (
    <>
      <SettingsSelect
        label={`${SLOT_LABELS[slot]} · Quyền (permissions)`}
        value={modeId}
        options={[
          { label: "Mặc định provider", value: "" },
          ...options.map((mode) => ({ label: mode.label, value: mode.id })),
        ]}
        disabled={state.saving || modes?.status !== "ready"}
        onValueChange={(id) => model.selectMode(slot, id)}
      />
      {selected?.description ? <Feedback theme={theme} text={selected.description} /> : null}
      {modes?.status === "error" ? (
        <Feedback theme={theme} error text={`Không tải được danh sách quyền: ${modes.error}`} />
      ) : null}
    </>
  );
}
function EmbeddingEditor({
  state,
  model,
  theme,
}: {
  state: ReadyState;
  model: SetupModel;
  theme: Theme;
}) {
  const builtin = state.runtime.status === "ready" ? state.runtime.result.builtinModel : null;
  const embedding = state.values.detection.embedding;
  let actionLabel = embedding.backend === "builtin" ? "Chuẩn bị / kiểm tra lại" : "Test embedding";
  if (state.embeddingTest.status === "pending") actionLabel = "Đang kiểm tra…";
  return (
    <SettingsCard>
      {embedding.backend === "builtin" ? (
        <>
          <SettingsRow
            label="all-MiniLM-L6-v2 · int8"
            hint="Chạy CPU trên host, tự tải khi plugin khởi động. Trọng số khoảng 23 MB; thư viện runtime tải riêng. Cache được giữ khi cập nhật plugin."
          />
          <SettingsRow label="Trạng thái model tích hợp" hint={builtinStatus(builtin)} />
        </>
      ) : (
        <>
          <SettingsInput
            label="Ollama URL"
            initialValue={embedding.baseUrl}
            disabled={state.saving}
            onChangeText={(baseUrl) => model.patchEmbedding({ baseUrl })}
          />
          <SettingsAction
            label="Model Ollama có trên host"
            actionLabel={state.ollamaModels.status === "pending" ? "Đang tìm…" : "Tải danh sách"}
            disabled={state.saving || state.ollamaModels.status === "pending"}
            onPress={() => void model.loadOllamaModels()}
          />
          <SearchableSelect
            label="Ollama model"
            value={embedding.model}
            options={
              state.ollamaModels.status === "ready"
                ? state.ollamaModels.result.map((value) => ({ value, label: value }))
                : []
            }
            disabled={state.saving || state.ollamaModels.status !== "ready"}
            onValueChange={(modelId) => model.patchEmbedding({ model: modelId })}
            theme={theme}
          />
          {state.ollamaModels.status === "ready" && !state.ollamaModels.result.length ? (
            <Feedback
              theme={theme}
              text="Ollama chưa có model nào trên host. Cài model embedding trong Ollama rồi tải lại."
            />
          ) : null}
          {state.ollamaModels.status === "error" ? (
            <Feedback theme={theme} error text={state.ollamaModels.error} />
          ) : null}
        </>
      )}
      <SettingsAction
        label="Kiểm tra embedding"
        actionLabel={actionLabel}
        disabled={state.saving || state.embeddingTest.status === "pending"}
        onPress={() => void model.runEmbeddingTest()}
      />
      {state.embeddingTest.status === "ready" ? (
        <Feedback
          theme={theme}
          error={!state.embeddingTest.result.ok}
          text={`${state.embeddingTest.result.message}${state.embeddingTest.result.dimensions ? ` · ${state.embeddingTest.result.dimensions} chiều` : ""}`}
        />
      ) : null}
      {state.embeddingTest.status === "error" ? (
        <Feedback theme={theme} error text={state.embeddingTest.error} />
      ) : null}
    </SettingsCard>
  );
}
function Feedback({ text, theme, error = false }: { text: string; theme: Theme; error?: boolean }) {
  return (
    <Text
      accessibilityRole={error ? "alert" : "text"}
      style={{
        padding: 12,
        color: error ? theme.colors.statusDanger : theme.colors.foregroundMuted,
      }}
    >
      {text}
    </Text>
  );
}
function Multiline({
  label,
  theme,
  initialValue,
  disabled,
  onChangeText,
  placeholder,
}: {
  label: string;
  theme: Theme;
  initialValue: string;
  disabled: boolean;
  onChangeText(value: string): void;
  placeholder: string;
}) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: theme.colors.foreground }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        defaultValue={initialValue}
        multiline
        editable={!disabled}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.foregroundMuted}
        style={{
          minHeight: 110,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          color: theme.colors.foreground,
          padding: 12,
          textAlignVertical: "top",
        }}
      />
    </View>
  );
}
function SearchableSelect({
  label,
  value,
  options,
  disabled,
  onValueChange,
  theme,
}: {
  label: string;
  value: string;
  options: { label: string; value: string }[];
  disabled: boolean;
  onValueChange(value: string): void;
  theme: Theme;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filtered = options.filter((option) =>
    `${option.label} ${option.value}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );

  return (
    <>
      <SettingsAction
        label={label}
        actionLabel={options.find((option) => option.value === value)?.label ?? (value || "Chọn…")}
        disabled={disabled}
        onPress={() => {
          setQuery("");
          setOpen(true);
        }}
      />
      {open ? (
        <Modal title={label} open onOpenChange={setOpen}>
          <Modal.Content
            scrollable={false}
            style={{ backgroundColor: theme.colors.surface1 }}
            contentContainerStyle={{ padding: 0, gap: 0 }}
          >
            <SettingsInput
              label="Tìm kiếm"
              initialValue=""
              onChangeText={setQuery}
              placeholder="Tên hoặc mã model…"
            />
            <FlatList
              style={{ flex: 1, minHeight: 0 }}
              data={filtered}
              keyboardShouldPersistTaps="handled"
              keyExtractor={(item) => item.value}
              renderItem={({ item }) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: item.value === value }}
                  onPress={() => {
                    onValueChange(item.value);
                    setOpen(false);
                  }}
                  style={{
                    padding: 16,
                    backgroundColor:
                      item.value === value ? theme.colors.surface2 : theme.colors.surface1,
                  }}
                >
                  <Text style={{ color: theme.colors.foreground }}>{item.label}</Text>
                  {item.value !== item.label ? (
                    <Text style={{ color: theme.colors.foregroundMuted }}>{item.value}</Text>
                  ) : null}
                </Pressable>
              )}
              ListEmptyComponent={() => (
                <Text style={{ padding: 16, color: theme.colors.foregroundMuted }}>
                  Không có kết quả.
                </Text>
              )}
            />
          </Modal.Content>
        </Modal>
      ) : null}
    </>
  );
}

interface FormSectionProps {
  state: ReadyState;
  model: SetupModel;
  theme: Theme;
}
function OverviewSection({ state, theme }: Pick<FormSectionProps, "state" | "theme">) {
  const effective = state.runtime.status === "ready" ? state.runtime.result : null;
  return (
    <SettingsSection title="Tổng quan đang chạy">
      <SettingsCard>
        <SettingsRow
          label="Phát hiện bất thường"
          hint={
            effective
              ? `${MODE_OPTIONS.find((option) => option.value === effective.mode)?.label ?? effective.mode} · ${effective.embeddingModel || "chưa có model ngữ nghĩa"}`
              : "Đang đọc trạng thái runtime…"
          }
        />
        <SettingsRow
          label="JEV Typesafe"
          hint={effective?.jevEnabled ? "Đang bật đánh giá cảnh báo" : "Đang tắt đánh giá tự động"}
        />
        <SettingsRow
          label="Lần kiểm tra gần nhất"
          hint={
            effective?.lastCheckedAt
              ? new Date(effective.lastCheckedAt).toLocaleString()
              : "Chưa có lượt Overmind mới được kiểm tra"
          }
        />
        {effective?.lastError ? <Feedback theme={theme} error text={effective.lastError} /> : null}
        {state.runtime.status === "error" ? (
          <Feedback theme={theme} error text={state.runtime.error} />
        ) : null}
      </SettingsCard>
      <Text style={{ color: theme.colors.foregroundMuted }}>
        Kiểm tra đầu ra khi kết thúc lượt của agent Overmind. Cảnh báo để người dùng xem xét; không
        tự dừng agent.
      </Text>
    </SettingsSection>
  );
}
function ProvidersSection({ state, model, theme }: FormSectionProps) {
  return (
    <SettingsSection title="Provider S-L-P, Scout và Preview">
      <Text style={{ color: theme.colors.foregroundMuted }}>
        Lưu để đăng ký ba provider Overmind vào danh sách tạo agent của Paseo. Cấu hình áp dụng cho
        agent tạo mới.
      </Text>
      {state.providersLoading ? (
        <Feedback theme={theme} text="Đang tìm provider trên host…" />
      ) : null}
      {state.providerError ? (
        <SettingsCard>
          <SettingsAction
            label="Không tải được provider"
            hint={state.providerError}
            actionLabel="Thử lại"
            disabled={state.saving}
            onPress={() => void model.loadProviders()}
          />
        </SettingsCard>
      ) : null}
      {PROVIDER_SLOTS.map((slot) => (
        <SlotEditor key={slot} slot={slot} model={model} state={state} theme={theme} />
      ))}
      <Text style={{ color: theme.colors.foregroundMuted }}>
        Antigravity dùng cho Peer qua provider ACP agy-acp (provider plugin antigravity không làm
        profile được trên Paseo 0.13).
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted }}>
        Scout và Preview lưu lựa chọn provider/model; luồng thực thi riêng cho hai vai trò này chưa
        được nối.
      </Text>
      <SettingsCard>
        <SettingsAction
          label="Đăng ký lại provider S-L-P"
          hint={state.dirty ? "Lưu thay đổi trước khi đăng ký lại." : undefined}
          actionLabel={state.syncingProfiles ? "Đang đăng ký…" : "Đăng ký lại"}
          disabled={state.saving || state.syncingProfiles || state.dirty}
          onPress={() => void model.publishProfiles()}
        />
      </SettingsCard>
      <ProfileSyncFeedback state={state} theme={theme} />
    </SettingsSection>
  );
}
function DetectorSection({ state, model, theme }: FormSectionProps) {
  const semantic =
    state.values.detection.mode === "hybrid" || state.values.detection.mode === "semantic";
  return (
    <SettingsSection title="Phát hiện bất thường">
      <SettingsCard>
        <SettingsSelect
          label="Phương pháp"
          value={state.values.detection.mode}
          options={MODE_OPTIONS}
          disabled={state.saving}
          onValueChange={(mode) =>
            model.patchDetection({ mode: mode as ReadyState["values"]["detection"]["mode"] })
          }
        />
        {state.values.detection.mode === "regex" || state.values.detection.mode === "hybrid" ? (
          <SettingsSwitch
            label="Dùng regex mặc định"
            value={state.values.detection.includeDefaults}
            disabled={state.saving}
            onValueChange={(includeDefaults) => model.patchDetection({ includeDefaults })}
          />
        ) : null}
      </SettingsCard>
      {state.values.detection.mode === "regex" || state.values.detection.mode === "hybrid" ? (
        <>
          <Text style={{ color: theme.colors.foregroundMuted }}>
            Regex mặc định: {DEFAULT_REGEX_RULES.map((rule) => rule.name).join(", ")}. Ở chế độ
            Regex + ngữ nghĩa, câu khớp regex chỉ thành cảnh báo khi MiniLM chấm vượt ngưỡng; JEV
            chỉ chạy trên cảnh báo đã xác nhận. Regex bổ sung: mỗi dòng một biểu thức, không thêm
            /…/.
          </Text>
          <Multiline
            label="Regex bổ sung"
            initialValue={state.extraPatternsText}
            disabled={state.saving}
            onChangeText={model.setExtraPatterns}
            theme={theme}
            placeholder="\\bhold\\s+on\\b"
          />
        </>
      ) : null}
      {semantic ? (
        <>
          <SettingsCard>
            <SettingsInput
              label="Ngưỡng tương đồng (0–1)"
              initialValue={state.numbers.threshold}
              disabled={state.saving}
              onChangeText={(value) => model.setNumber("threshold", value)}
            />
            <SettingsSelect
              label="Embedding"
              value={state.values.detection.embedding.backend}
              options={BACKEND_OPTIONS}
              disabled={state.saving}
              onValueChange={(backend) =>
                model.patchEmbedding({ backend: backend as "builtin" | "ollama" })
              }
            />
          </SettingsCard>
          <EmbeddingEditor state={state} model={model} theme={theme} />
          <Multiline
            label="Câu tham chiếu ngữ nghĩa"
            initialValue={state.referencesText}
            disabled={state.saving}
            onChangeText={model.setReferences}
            theme={theme}
            placeholder="Mỗi dòng một dấu hiệu cần xem xét"
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
function JevSection({ state, model, theme }: FormSectionProps) {
  return (
    <SettingsSection title="JEV · Typesafe">
      <Text style={{ color: theme.colors.foregroundMuted }}>
        JEV đánh giá cảnh báo theo ngữ cảnh. Bật tự động sẽ gửi mục tiêu và trích đoạn đầu ra của
        agent đến api.typesafe.ai. Test chỉ gửi một ví dụ mẫu.
      </Text>
      <SettingsCard>
        <SettingsInput
          label="JEV API key"
          initialValue={state.values.jev.apiKey}
          secureTextEntry
          disabled={state.saving}
          onChangeText={(apiKey) => model.patchJev({ apiKey })}
          placeholder="Nhập API key"
        />
        <SearchableSelect
          label="JEV model"
          value={state.values.jev.model}
          options={state.jevModels.map((value) => ({ value, label: value }))}
          disabled={state.saving}
          onValueChange={(modelId) => model.patchJev({ model: modelId })}
          theme={theme}
        />
        <SettingsSwitch
          label="Tự động đánh giá cảnh báo"
          value={state.values.jev.enabled}
          disabled={state.saving}
          onValueChange={(enabled) => model.patchJev({ enabled })}
        />
        <SettingsInput
          label="Confidence tối thiểu (0–1)"
          initialValue={state.numbers.minConfidence}
          disabled={state.saving}
          onChangeText={(value) => model.setNumber("minConfidence", value)}
        />
        <SettingsInput
          label="Probability cho review (0–1)"
          initialValue={state.numbers.probabilityThreshold}
          disabled={state.saving}
          onChangeText={(value) => model.setNumber("probabilityThreshold", value)}
        />
        <SettingsAction
          label="Test kết nối JEV"
          actionLabel={state.jevTest.status === "pending" ? "Đang test…" : "Test JEV"}
          disabled={
            state.saving || state.jevTest.status === "pending" || !state.values.jev.apiKey.trim()
          }
          onPress={() => void model.runJevTest()}
        />
        {state.jevTest.status === "ready" ? (
          <Feedback
            theme={theme}
            error={!state.jevTest.result.ok}
            text={`${state.jevTest.result.message} · ${state.jevTest.result.model} · ${state.jevTest.result.latencyMs} ms`}
          />
        ) : null}
        {state.jevTest.status === "error" ? (
          <Feedback theme={theme} error text={state.jevTest.error} />
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}

function builtinStatus(model: { status: string; progress: number; error: string | null } | null) {
  if (model?.status === "ready") return "Sẵn sàng · đã tạo vector thử thành công";
  if (model?.status === "downloading")
    return `Đang tải / khởi tạo · ${Math.round(model.progress)}%`;
  if (model?.status === "error") return model.error ?? "Khởi tạo thất bại";
  return "Chưa sẵn sàng";
}

function bindingDescription(value: ReturnType<typeof slotValue>) {
  if (!value.provider) return "Chưa cấu hình";
  return [value.provider, value.model || "chưa chọn model", value.thinkingOptionId]
    .filter(Boolean)
    .join(" / ");
}
/** Result of the last registration, next to the button that started it. */
function ProfileSyncFeedback({ state, theme }: { state: ReadyState; theme: Theme }) {
  if (state.syncingProfiles) return null;
  if (state.profileError)
    return <Feedback theme={theme} error text={`Đăng ký thất bại: ${state.profileError}`} />;
  if (!state.profilesSynced) return null;
  const failed = state.profiles.filter((profile) => profile.status === "error");
  if (failed.length)
    return (
      <Feedback
        theme={theme}
        error
        text={`Chưa đăng ký được ${failed.map((profile) => `${profile.label}: ${profile.error}`).join("; ")}`}
      />
    );
  const ready = state.profiles.filter((profile) => profile.status === "ready");
  return (
    <Feedback
      theme={theme}
      text={
        ready.length
          ? `Đã đăng ký: ${ready.map((profile) => profile.label).join(", ")}.`
          : "Không có provider nào được cấu hình để đăng ký."
      }
    />
  );
}
function profileDescription(profile: ProfileStatus) {
  if (profile.status === "ready") return `${profile.label} · sẵn sàng`;
  if (profile.error) return profile.error;
  return profile.status === "unconfigured" ? "Chưa cấu hình" : "Chưa được đăng ký";
}
function CatalogFeedback({ slot, state, model, theme }: FormSectionProps & { slot: ProviderSlot }) {
  if (!slotValue(state.values, slot).provider) return null;
  const catalog = state.catalogs[slot];
  if (catalog?.status === "ready")
    return catalog.models.length ? null : (
      <Feedback theme={theme} text="Provider chưa trả về model khả dụng." />
    );
  return (
    <SettingsAction
      label={catalog?.status === "error" ? "Không tải được model" : "Đang tải model…"}
      hint={catalog?.status === "error" ? catalog.error : undefined}
      actionLabel="Thử lại"
      disabled={state.saving || catalog?.status === "loading"}
      onPress={() => void model.loadModels(slot)}
    />
  );
}
